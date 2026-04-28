"""Search service over the canonical event store.

Phase 11 ships a deliberately simple retriever — text + category + country
filters over the in-memory repository, with a relevance score that weights
text hits, freshness, severity, and per-source reliability.

Phase 12.3 layers place-aware ranking on top: when an investigation has a
:class:`PlaceScope` (city / port / chokepoint / region resolved via the
gazetteer), the search service hard-filters out unrelated countries and
boosts events whose country / locality / coordinates match the scope. This
is the trust-repair fix that stops Tokyo queries from returning Argentine
mood entries.

The contract is the important part: a future phase can swap this for a
hybrid BM25 + embedding retriever without touching the routes or the
country summary/analyst overlay.
"""

from __future__ import annotations

import logging
import math
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Iterable

from app.intelligence.adapters.country_lookup import lookup_by_alpha3, lookup_by_name
from app.intelligence.repositories.event_repository import EventQuery, EventRepository
from app.intelligence.schemas import PlaceScope, SignalCategory, SignalEvent


logger = logging.getLogger(__name__)

_TOKEN_RE = re.compile(r"[A-Za-z0-9]+")


@dataclass(slots=True, frozen=True)
class ScoreBreakdown:
    """Phase 18B.2 — per-component breakdown for ranking instrumentation.

    Each component is normalised to ``[0, 1]`` so downstream tooling
    (debug endpoint, reranker, calibration) can mix them without scale
    surprises. ``final_score`` matches :attr:`SearchHit.score` exactly.
    """

    base_score: float
    freshness_score: float
    severity_score: float
    location_match_score: float
    final_score: float


@dataclass(slots=True, frozen=True)
class SearchHit:
    """Single ranked search result."""

    event: SignalEvent
    score: float
    matched_terms: list[str]
    place_match: str | None = None  # "exact_country" | "spatial" | "alias" | None
    breakdown: ScoreBreakdown | None = None


@dataclass(slots=True, frozen=True)
class SearchResponse:
    """Envelope returned by :meth:`SearchService.search`."""

    query: str
    resolved_country_code: str | None
    total: int
    hits: list[SearchHit]
    scope_used: str = "global"
    scope_event_count: int = 0


# Region → contributing country codes for hierarchical fallback. Keep the
# list minimal; broaden only when a wedge scenario proves it out.
_REGION_COUNTRY_CODES: dict[str, tuple[str, ...]] = {
    "region:red-sea":      ("EGY", "SAU", "YEM", "SDN", "ERI", "DJI"),
    "region:persian-gulf": ("SAU", "ARE", "OMN", "QAT", "BHR", "KWT", "IRN", "IRQ"),
    "region:middle-east":  ("EGY", "SAU", "ARE", "OMN", "YEM", "QAT", "BHR", "KWT",
                            "IRN", "IRQ", "ISR", "JOR", "LBN", "SYR", "TUR"),
    "region:east-asia":    ("JPN", "KOR", "CHN", "TWN", "HKG", "MNG"),
    "region:southeast-asia": ("SGP", "MYS", "IDN", "THA", "VNM", "PHL"),
    "region:europe":       (
        "GBR", "FRA", "DEU", "NLD", "ESP", "ITA", "POL", "PRT", "GRC",
        "IRL", "SWE", "NOR", "FIN", "BEL", "AUT", "DNK", "CHE", "CZE",
    ),
    "region:north-america": ("USA", "CAN", "MEX"),
}


class SearchService:
    """Text + structured retrieval over the event repository."""

    def __init__(self, repository: EventRepository) -> None:
        self._repository = repository

    async def search(
        self,
        *,
        query: str,
        categories: tuple[SignalCategory, ...] | None = None,
        country_code: str | None = None,
        limit: int = 25,
        place_scope: PlaceScope | None = None,
    ) -> SearchResponse:
        cleaned = (query or "").strip()
        tokens = _tokenize(cleaned)

        # Place scope wins over the legacy country hint when both are set.
        # The scope already contains the canonical resolution from
        # ``PlaceResolver``, including hierarchical fallback information.
        resolved_country: str | None
        scope_used = "global"
        allowed_countries: set[str] | None = None
        scope_event_count = 0

        if place_scope is not None:
            resolved_country, scope_used, allowed_countries = _scope_filter(
                place_scope
            )
        else:
            resolved_country = self._resolve_country(cleaned, country_code)
            if resolved_country:
                scope_used = "country"
                allowed_countries = {resolved_country}

        # Pull a wider candidate set so ranking has room to work; the country
        # hard-filter happens in-python below so we can still surface a
        # truthful "no scoped evidence" notice via ``scope_event_count``.
        repo_query = EventQuery(
            categories=categories,
            country_code=None,
            text=None,
            limit=max(limit * 8, 80),
        )
        candidates = await self._repository.query(repo_query)

        # In-python country / region filter — preserves ranking visibility into
        # how many scoped events exist before broadening to a fallback set.
        # Only broaden when the resolver itself climbed the hierarchy. A
        # strong direct hit (exact / alias_substring / nearby_city) with no
        # scoped events should yield an honest empty set — the agent then
        # turns that into a fallback notice for the UI.
        broaden_on_empty = (
            place_scope is not None
            and place_scope.fallback_level in ("parent_country", "parent_region")
        )
        if allowed_countries is not None:
            scoped = [
                event
                for event in candidates
                if (event.place.country_code or "").upper() in allowed_countries
            ]
            scope_event_count = len(scoped)
            if scope_event_count > 0:
                candidates = scoped
            elif broaden_on_empty:
                # Hierarchical fallbacks may legitimately need a broader
                # candidate pool so the place-aware scorer can still surface
                # spatially adjacent rows. Keep ``candidates`` wide.
                pass
            else:
                # Hard filter (legacy country hint or strong exact place
                # without macro-level fallback): return an honest empty set.
                candidates = []

        if not tokens and place_scope is None and not resolved_country and not categories:
            ranked = [
                _recency_only_hit(event)
                for event in candidates
            ]
        else:
            ranked = [
                self._score(event, tokens, place_scope=place_scope)
                for event in candidates
            ]
            # When scope is exact, drop zero-score noise even if tokens are
            # empty so the answer panel doesn't get diluted.
            require_signal = bool(tokens) or place_scope is not None
            if require_signal:
                ranked = [hit for hit in ranked if hit.score > 0.0]

        ranked.sort(key=lambda hit: hit.score, reverse=True)
        top = ranked[: max(1, limit)]

        return SearchResponse(
            query=cleaned,
            resolved_country_code=resolved_country,
            total=len(ranked),
            hits=top,
            scope_used=scope_used,
            scope_event_count=scope_event_count,
        )

    # --- internals -----------------------------------------------------

    def _resolve_country(self, text: str, hint: str | None) -> str | None:
        if hint:
            meta = lookup_by_alpha3(hint)
            if meta:
                return meta.code
        if not text:
            return None
        # try full string first, then each token
        meta = lookup_by_name(text)
        if meta:
            return meta.code
        for token in _tokenize(text):
            meta = lookup_by_name(token)
            if meta:
                return meta.code
        return None

    def _score(
        self,
        event: SignalEvent,
        tokens: Iterable[str],
        *,
        place_scope: PlaceScope | None = None,
    ) -> SearchHit:
        token_list = list(tokens)
        haystack = _haystack(event)
        matched: list[str] = []
        text_score = 0.0
        for term in token_list:
            if term in haystack:
                matched.append(term)
                text_score += 1.0 + haystack.count(term) * 0.15

        recency = _recency_score(event)
        severity = event.severity_score
        reliability = (
            max((s.reliability for s in event.sources), default=event.confidence)
            if event.sources
            else event.confidence
        )

        place_boost, place_match = _place_boost(event, place_scope)

        if not token_list and place_scope is None:
            combined = 0.55 * recency + 0.35 * severity + 0.10 * reliability
        elif place_scope is not None and not token_list:
            # Scope-driven retrieval: rely on place match + freshness.
            # Without place_boost the row is irrelevant — drop to zero so
            # the require_signal gate filters it.
            if place_boost <= 0.0:
                combined = 0.0
            else:
                combined = (
                    0.55 * place_boost
                    + 0.20 * recency
                    + 0.15 * severity
                    + 0.10 * reliability
                )
        else:
            combined = (
                0.40 * _normalize(text_score)
                + 0.25 * place_boost
                + 0.18 * recency
                + 0.10 * severity
                + 0.07 * reliability
            )

        final_score = round(combined, 4)
        breakdown = ScoreBreakdown(
            base_score=round(_normalize(text_score), 4),
            freshness_score=round(recency, 4),
            severity_score=round(severity, 4),
            location_match_score=round(place_boost, 4),
            final_score=final_score,
        )
        return SearchHit(
            event=event,
            score=final_score,
            matched_terms=matched,
            place_match=place_match,
            breakdown=breakdown,
        )


def _recency_only_hit(event: SignalEvent) -> SearchHit:
    score = _recency_score(event)
    rounded = round(score, 4)
    return SearchHit(
        event=event,
        score=rounded,
        matched_terms=[],
        breakdown=ScoreBreakdown(
            base_score=0.0,
            freshness_score=rounded,
            severity_score=round(event.severity_score, 4),
            location_match_score=0.0,
            final_score=rounded,
        ),
    )


def _tokenize(value: str) -> list[str]:
    if not value:
        return []
    return [m.group(0).lower() for m in _TOKEN_RE.finditer(value) if len(m.group(0)) > 1]


def _haystack(event: SignalEvent) -> str:
    parts = [
        event.title or "",
        event.summary or "",
        event.description or "",
        event.place.country_name or "",
        event.place.locality or "",
        " ".join(event.tags),
        " ".join(entity.name for entity in event.entities),
    ]
    return " ".join(parts).lower()


def _recency_score(event: SignalEvent, *, now: datetime | None = None) -> float:
    reference = event.source_timestamp or event.ingested_at
    if reference is None:
        return 0.0
    current = now or datetime.now(timezone.utc)
    age_hours = max(0.0, (current - reference).total_seconds() / 3600.0)
    # smooth decay — full credit for <1h old, ~0.5 after 6h, ~0.1 after 24h
    return math.exp(-age_hours / 6.0)


def _normalize(value: float) -> float:
    return 1.0 - math.exp(-value)


# ---- place-aware helpers ----------------------------------------------------


def _scope_filter(
    scope: PlaceScope,
) -> tuple[str | None, str, set[str] | None]:
    """Decide which countries are admissible for a given :class:`PlaceScope`.

    Returns ``(resolved_country, scope_used, allowed_countries)``:

    * ``resolved_country`` — country code surfaced on the response (if any)
    * ``scope_used``       — UI tag (``exact_place`` / ``country`` / ``region``
                              / ``global``)
    * ``allowed_countries``— hard filter; ``None`` means no country restriction
    """

    if scope.fallback_level == "none":
        return None, "global", None

    if scope.fallback_level in ("exact", "alias_substring", "nearby_city"):
        # Strong place hit — restrict to its country (if known) so we don't
        # drag in unrelated countries' mood entries.
        if scope.country_code:
            return scope.country_code.upper(), "exact_place", {
                scope.country_code.upper()
            }
        # Multi-country chokepoint / region anchor — fall back to region set.
        codes = _region_country_codes(scope.parent_id) or _region_country_codes(
            scope.place_id
        )
        if codes:
            return None, "region", set(codes)
        return None, "exact_place", None

    if scope.fallback_level == "parent_country":
        if scope.country_code:
            return scope.country_code.upper(), "country", {
                scope.country_code.upper()
            }
        return None, "country", None

    if scope.fallback_level == "parent_region":
        codes = _region_country_codes(scope.place_id)
        if codes:
            return None, "region", set(codes)
        return None, "region", None

    return None, "global", None


def _region_country_codes(place_id: str | None) -> tuple[str, ...]:
    if not place_id:
        return ()
    return _REGION_COUNTRY_CODES.get(place_id, ())


def _place_boost(
    event: SignalEvent, scope: PlaceScope | None
) -> tuple[float, str | None]:
    """Compute a 0..1 relevance boost for ``event`` against ``scope``.

    Returns ``(boost, label)`` where ``label`` describes the dominant match
    reason so the UI / debug tools can explain why the row ranked.
    """

    if scope is None or scope.fallback_level == "none":
        return 0.0, None

    event_country = (event.place.country_code or "").upper()
    scope_country = (scope.country_code or "").upper()

    boost = 0.0
    label: str | None = None

    if scope_country and event_country == scope_country:
        boost = max(boost, 0.6)
        label = "exact_country"

    if scope.name:
        scope_name_lc = scope.name.lower()
        haystack = _haystack(event)
        if scope_name_lc in haystack:
            boost = max(boost, 0.85)
            label = "name_match"
        else:
            for alias in scope.aliases:
                alias_lc = alias.lower()
                if len(alias_lc) >= 3 and alias_lc in haystack:
                    boost = max(boost, 0.75)
                    label = label or "alias_match"
                    break

    if (
        scope.latitude is not None
        and scope.longitude is not None
        and event.place.latitude is not None
        and event.place.longitude is not None
    ):
        distance_km = _haversine_km(
            scope.latitude,
            scope.longitude,
            event.place.latitude,
            event.place.longitude,
        )
        # Linearly decay over ~1500km so cities, ports, and regional events
        # stay above background noise without dragging in distant countries.
        spatial = max(0.0, 1.0 - distance_km / 1500.0)
        if spatial > 0.0:
            spatial_boost = 0.65 * spatial
            if spatial_boost > boost:
                boost = spatial_boost
                label = label or "spatial"

    if (
        boost == 0.0
        and scope.fallback_level == "parent_region"
        and event_country
        and event_country in (_region_country_codes(scope.place_id) or ())
    ):
        boost = 0.45
        label = "region_member"

    return round(min(boost, 1.0), 4), label


def _haversine_km(
    lat1: float, lon1: float, lat2: float, lon2: float
) -> float:
    radius = 6371.0
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    d_phi = math.radians(lat2 - lat1)
    d_lam = math.radians(lon2 - lon1)
    a = (
        math.sin(d_phi / 2) ** 2
        + math.cos(phi1) * math.cos(phi2) * math.sin(d_lam / 2) ** 2
    )
    return 2 * radius * math.asin(min(1.0, math.sqrt(a)))


__all__ = ["ScoreBreakdown", "SearchHit", "SearchResponse", "SearchService"]
