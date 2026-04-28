"""Bounded retrieval workers.

Each worker is a thin, deterministic wrapper around an existing service —
``PlaceResolver``, ``SearchService``, ``EventRepository``, place templates.
There is no LLM here, no free-form chain, no new state model. The
orchestrator decides which workers to run from the :class:`QueryPlan` and
composes the bundle in a fixed order.

Workers are async functions taking ``(plan, repository, search_service,
place_resolver, bundle_so_far)`` and returning a tuple of
``(name, partial_bundle_updates)``. Keeping them functions instead of
classes keeps the surface tiny and trivially testable.
"""

from __future__ import annotations

import logging
import re
from typing import Sequence

from app.intelligence.adapters.country_lookup import (
    CountryMeta,
    lookup_by_alpha3,
    lookup_by_name,
)
from app.intelligence.geo.place_scope import place_scope_from_resolved
from app.intelligence.geo.place_templates import build_place_templates
from app.intelligence.geo.resolver import PlaceResolver, ResolvedPlace
from app.intelligence.repositories.event_repository import EventQuery, EventRepository
from app.intelligence.retrieval.compare_planner import CompareTargetSpec
from app.intelligence.retrieval.evidence_bundle import (
    CompareTargetSnapshot,
    summarize_event_distribution,
)
from app.intelligence.retrieval.query_planner import QueryPlan
from app.intelligence.retrieval.time_window import TimeWindow
from app.intelligence.schemas import (
    CountrySignalSummary,
    DependencyPath,
    PlaceScope,
    ResolvedEntity,
    SignalEvent,
)
from app.intelligence.services.search_service import SearchService


logger = logging.getLogger(__name__)


_FX_PAIR_RE = re.compile(r"\b(USD|EUR|JPY|GBP|CNY|CHF|CAD)(USD|EUR|JPY|GBP|CNY|CHF|CAD)\b")
_TICKER_RE = re.compile(r"\b([A-Z]{2,5})\b")
_SPECIFIC_PLACE_TYPES = ("city", "port", "chokepoint")

_KNOWN_TICKERS: dict[str, tuple[str, str]] = {
    "AAPL": ("Apple Inc.", "USA"),
    "MSFT": ("Microsoft Corp.", "USA"),
    "NVDA": ("NVIDIA Corp.", "USA"),
    "TSLA": ("Tesla Inc.", "USA"),
    "SPY":  ("SPDR S&P 500 ETF", "USA"),
    "GOOG": ("Alphabet Inc.", "USA"),
    "AMZN": ("Amazon.com Inc.", "USA"),
    "META": ("Meta Platforms Inc.", "USA"),
}


# ----------------------------------------------------------------------------
# PlaceWorker — primary scope + scoped search + fallback notice
# ----------------------------------------------------------------------------


async def run_place_worker(
    plan: QueryPlan,
    *,
    search: SearchService,
    place_resolver: PlaceResolver,
    evidence_limit: int = 6,
) -> tuple[
    PlaceScope,
    list[ResolvedEntity],
    list[SignalEvent],
    str,
    int,
    str | None,
    ResolvedPlace,
]:
    """Resolve the primary subject and run scoped search.

    Returns ``(scope, entities, events, scope_used, scope_event_count,
    fallback_notice, resolved_place)``.
    """

    primary_text = plan.primary_text or plan.raw_query
    resolved_place = place_resolver.resolve(primary_text)
    scope = place_scope_from_resolved(resolved_place)
    entities = _resolve_entities(plan.raw_query, scope)

    search_response = await search.search(
        query=primary_text,
        place_scope=scope if scope.fallback_level != "none" else None,
        limit=evidence_limit,
    )
    events = [hit.event for hit in search_response.hits]

    fallback_notice = _compose_fallback_notice(
        scope=scope,
        scope_used=search_response.scope_used,
        scope_event_count=search_response.scope_event_count,
    )
    scope_used = _normalize_scope_used(search_response.scope_used, scope)

    return (
        scope,
        entities,
        events,
        scope_used,
        search_response.scope_event_count,
        fallback_notice,
        resolved_place,
    )


# ----------------------------------------------------------------------------
# CountrySummaryWorker — adds the country summary when scope is strong
# ----------------------------------------------------------------------------


async def run_country_summary_worker(
    scope: PlaceScope, *, repository: EventRepository
) -> CountrySignalSummary | None:
    if scope.country_code is None or _is_weak_scope(scope):
        return None
    return await repository.get_country_summary(scope.country_code)


# ----------------------------------------------------------------------------
# TimelineWorker — restricts events to the time window
# ----------------------------------------------------------------------------


async def run_timeline_worker(
    plan: QueryPlan,
    primary_events: Sequence[SignalEvent],
    *,
    repository: EventRepository,
    evidence_limit: int = 6,
) -> tuple[list[SignalEvent], list[str]]:
    """Apply the time window to ``primary_events``.

    When the window has no matches (e.g. ``last 1h`` but the freshest
    primary event is 6h old), this falls back to a windowed repository
    query so the agent can disclose "no recent" rather than silently
    using stale evidence.

    Returns ``(events_in_window, caveats)``.
    """

    window = plan.time
    caveats: list[str] = []
    in_window = [e for e in primary_events if _event_in_window(e, window)]
    if in_window:
        return in_window, caveats

    # Repository fallback — keep the window honest with a direct query.
    query = EventQuery(
        since=window.since,
        until=window.until,
        limit=max(evidence_limit, 10),
    )
    candidates = await repository.query(query)
    if candidates:
        caveats.append(
            f"No primary-scope events fell in the {window.label} window; "
            "showing nearest windowed signals from the broader corpus."
        )
        return list(candidates[:evidence_limit]), caveats

    caveats.append(
        f"No events landed inside the {window.label} window."
    )
    return [], caveats


def _event_in_window(event: SignalEvent, window: TimeWindow) -> bool:
    ts = event.source_timestamp or event.ingested_at
    if ts is None:
        return False
    if window.since is not None and ts < window.since:
        return False
    if window.until is not None and ts > window.until:
        return False
    return True


# ----------------------------------------------------------------------------
# CompareWorker — resolves and snapshots each compare leg
# ----------------------------------------------------------------------------


async def run_compare_worker(
    plan: QueryPlan,
    *,
    repository: EventRepository,
    search: SearchService,
    place_resolver: PlaceResolver,
    evidence_limit: int = 4,
) -> list[CompareTargetSnapshot]:
    """Build a snapshot per resolved compare leg."""

    snapshots: list[CompareTargetSnapshot] = []
    for spec in plan.compare.targets:
        snapshot = await _snapshot_for_leg(
            spec,
            repository=repository,
            search=search,
            place_resolver=place_resolver,
            evidence_limit=evidence_limit,
            window=plan.time,
        )
        snapshots.append(snapshot)
    return snapshots


async def _snapshot_for_leg(
    spec: CompareTargetSpec,
    *,
    repository: EventRepository,
    search: SearchService,
    place_resolver: PlaceResolver,
    evidence_limit: int,
    window: TimeWindow,
) -> CompareTargetSnapshot:
    if spec.resolution == "none":
        return CompareTargetSnapshot(
            spec=spec,
            scope=PlaceScope(query=spec.raw),
            events=[],
            summary=None,
        )

    if spec.kind in ("ticker", "fx_pair"):
        # Markets compare leg — snapshot the country summary if the ticker
        # has a country anchor, otherwise leave events empty (the
        # market-data services own the price-level snapshot, not us).
        events: list[SignalEvent] = []
        summary: CountrySignalSummary | None = None
        if spec.country_code:
            summary = await repository.get_country_summary(spec.country_code)
            events = await repository.by_country(spec.country_code, limit=evidence_limit)
        scope = PlaceScope(
            query=spec.raw,
            place_id=spec.canonical_id,
            name=spec.label,
            type=spec.kind,
            country_code=spec.country_code,
            confidence=spec.confidence,
            fallback_level="exact" if spec.resolution == "exact" else "alias_substring",
        )
        windowed = [e for e in events if _event_in_window(e, window)] if not window.is_live else events
        events_to_use = windowed or events
        counts, severities, freshness = summarize_event_distribution(events_to_use)
        return CompareTargetSnapshot(
            spec=spec,
            scope=scope,
            events=events_to_use[:evidence_limit],
            summary=summary,
            counts_by_category=counts,
            severity_distribution=severities,
            freshness_minutes=freshness,
        )

    # Place / country leg — re-resolve to get the canonical scope so the
    # search service can apply place-aware filtering.
    resolved = place_resolver.resolve(spec.raw)
    scope = place_scope_from_resolved(resolved)
    response = await search.search(
        query=spec.raw,
        place_scope=scope if scope.fallback_level != "none" else None,
        limit=evidence_limit,
    )
    events = [hit.event for hit in response.hits]
    if not window.is_live:
        events = [e for e in events if _event_in_window(e, window)] or events
    summary: CountrySignalSummary | None = None
    if scope.country_code and not _is_weak_scope(scope):
        summary = await repository.get_country_summary(scope.country_code)
    counts, severities, freshness = summarize_event_distribution(events)
    return CompareTargetSnapshot(
        spec=spec,
        scope=scope,
        events=events[:evidence_limit],
        summary=summary,
        counts_by_category=counts,
        severity_distribution=severities,
        freshness_minutes=freshness,
    )


# ----------------------------------------------------------------------------
# PlaceDependencyWorker — adds place-driven dependency snippets
# ----------------------------------------------------------------------------


def run_place_dependency_worker(
    resolved_place: ResolvedPlace,
    events: Sequence[SignalEvent],
) -> list[DependencyPath]:
    if resolved_place.fallback_level not in ("exact", "alias_substring", "nearby_city"):
        return []
    if resolved_place.place is None or resolved_place.macro_profile is None:
        return []
    focal_event_id = events[0].id if events else None
    evidence_ids = [event.id for event in events[:3]]
    templates = build_place_templates(
        resolved_place,
        focal_event_id=focal_event_id,
        evidence_ids=evidence_ids,
    )
    return [
        template.to_path(
            focal_event_id=focal_event_id,
            focal_country_code=resolved_place.country_code,
        )
        for template in templates[:3]
    ]


# ----------------------------------------------------------------------------
# Helpers shared with the agent service
# ----------------------------------------------------------------------------


def _resolve_entities(text: str, scope: PlaceScope) -> list[ResolvedEntity]:
    if not text:
        return []
    found: list[ResolvedEntity] = []
    seen_ids: set[str] = set()

    if scope.fallback_level != "none" and scope.name and scope.place_id:
        if scope.type in ("city", "port", "chokepoint"):
            kind = scope.type
        elif scope.type == "country":
            kind = "country"
        elif scope.type == "region":
            kind = "region"
        else:
            kind = "place"
        seen_ids.add(scope.place_id)
        found.append(
            ResolvedEntity(
                kind=kind,  # type: ignore[arg-type]
                id=scope.place_id,
                name=scope.name,
                country_code=scope.country_code,
            )
        )
        if (
            scope.type in _SPECIFIC_PLACE_TYPES
            and scope.country_code
            and scope.country_name
        ):
            country_id = f"country:{scope.country_code}"
            if country_id not in seen_ids:
                seen_ids.add(country_id)
                found.append(
                    ResolvedEntity(
                        kind="country",
                        id=country_id,
                        name=scope.country_name,
                        country_code=scope.country_code,
                    )
                )

    for match in _FX_PAIR_RE.finditer(text.upper()):
        pair = match.group(0)
        ident = f"fx:{pair}"
        if ident in seen_ids:
            continue
        seen_ids.add(ident)
        found.append(
            ResolvedEntity(
                kind="fx_pair",
                id=ident,
                name=f"{match.group(1)}/{match.group(2)}",
            )
        )

    for match in _TICKER_RE.finditer(text):
        symbol = match.group(1)
        if symbol not in _KNOWN_TICKERS:
            continue
        ident = f"ticker:{symbol}"
        if ident in seen_ids:
            continue
        seen_ids.add(ident)
        name, country = _KNOWN_TICKERS[symbol]
        found.append(
            ResolvedEntity(
                kind="ticker",
                id=ident,
                name=name,
                country_code=country,
            )
        )

    # Phase 19C.6 — commodity entity emission. Without this, queries like
    # "why is oil up" produced no commodity-typed ResolvedEntity, so the
    # agent answer collapsed to "the current intelligence corpus" even
    # though the entity resolver had identified Crude Oil. Reuses the
    # canonical resolver so the alias map (oil → CL, gold → GC, etc.)
    # stays in one place.
    from app.intelligence.retrieval.entity_resolver import resolve_query_entity

    primary_entity = resolve_query_entity(text)
    if primary_entity.kind == "commodity" and primary_entity.canonical_id:
        ident = primary_entity.canonical_id
        if ident not in seen_ids:
            seen_ids.add(ident)
            found.append(
                ResolvedEntity(
                    kind="commodity",
                    id=ident,
                    name=primary_entity.label,
                )
            )

    if scope.country_code is None:
        meta = lookup_by_name(text)
        if meta is not None:
            _push_country(found, seen_ids, meta)
        for token in re.findall(r"[A-Za-z]+", text):
            if len(token) < 3:
                continue
            meta = lookup_by_name(token)
            if meta is not None:
                _push_country(found, seen_ids, meta)
                continue
            if len(token) == 3:
                meta = lookup_by_alpha3(token)
                if meta is not None:
                    _push_country(found, seen_ids, meta)

    return found


def _push_country(
    bucket: list[ResolvedEntity], seen: set[str], meta: CountryMeta
) -> None:
    ident = f"country:{meta.code}"
    if ident in seen:
        return
    seen.add(ident)
    bucket.append(
        ResolvedEntity(
            kind="country",
            id=ident,
            name=meta.name,
            country_code=meta.code,
        )
    )


def _is_weak_scope(scope: PlaceScope) -> bool:
    return scope.fallback_level in ("none", "parent_region")


def _normalize_scope_used(raw: str, scope: PlaceScope) -> str:
    if raw in ("exact_place", "country", "region", "global"):
        return raw
    if scope.fallback_level == "none":
        return "global"
    if scope.fallback_level == "parent_region":
        return "region"
    if scope.fallback_level == "parent_country":
        return "country"
    return "exact_place"


def _compose_fallback_notice(
    *, scope: PlaceScope, scope_used: str, scope_event_count: int
) -> str | None:
    if scope.fallback_level == "none":
        return None
    place_name = scope.name or scope.query
    if (
        scope.fallback_level in ("exact", "alias_substring", "nearby_city")
        and scope.type in _SPECIFIC_PLACE_TYPES
        and scope_event_count == 0
    ):
        if scope.country_name:
            return (
                f"No {place_name}-specific signals are landing right now. "
                f"Showing {scope.country_name}-level signals instead."
            )
        return (
            f"No {place_name}-specific signals are landing right now. "
            "Showing the closest available regional signals."
        )
    if scope.fallback_level == "parent_country":
        return (
            f"Showing country-level signals for {place_name} because more "
            "specific place evidence is currently sparse."
        )
    if scope.fallback_level == "parent_region":
        return (
            f"No direct {place_name} event markers found. Showing "
            "region-linked signals from countries on this corridor."
        )
    if scope.type == "region":
        return (
            f"{place_name} is a multi-country region. Showing region-linked "
            "signals from contributing countries."
        )
    return None


__all__ = [
    "run_compare_worker",
    "run_country_summary_worker",
    "run_place_dependency_worker",
    "run_place_worker",
    "run_timeline_worker",
]
