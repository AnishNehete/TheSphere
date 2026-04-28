"""Retrieval orchestrator — bounded worker dispatch over the existing services.

This is intentionally *not* a generic agent framework. The orchestrator
runs a small set of deterministic workers in a fixed order and assembles
a typed :class:`EvidenceBundle`. The agent service composes prose on top
of the bundle; nothing else may invent facts.

Order:
  1. PlaceWorker            (always)
  2. TimelineWorker         (when plan.time != live)
  3. CountrySummaryWorker   (when scope is strong enough)
  4. CompareWorker          (when plan.compare.requested)
  5. PlaceDependencyWorker  (when scope is strong + has events)

The orchestrator records the workers it ran on the bundle so the route
layer / observability can see why a particular bundle was assembled.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Sequence

from app.intelligence.geo.resolver import (
    PlaceResolver,
    place_resolver as default_place_resolver,
)
from app.intelligence.repositories.event_repository import EventRepository
from app.intelligence.retrieval.entity_resolver import (
    QueryEntity,
    is_relevant,
)
from app.intelligence.retrieval.evidence_bundle import (
    EvidenceBundle,
    derive_time_context,
)
from app.intelligence.retrieval.query_planner import QueryPlan, QueryPlanner
from app.intelligence.retrieval.scope_filter import (
    apply_relevance_filter,
    build_compare_delta,
    is_time_compare,
)
from app.intelligence.retrieval.workers import (
    run_compare_worker,
    run_country_summary_worker,
    run_place_dependency_worker,
    run_place_worker,
    run_timeline_worker,
)
from app.intelligence.schemas import PlaceScope, SignalEvent
from app.intelligence.services.search_service import SearchService


logger = logging.getLogger(__name__)


class RetrievalOrchestrator:
    """Build an :class:`EvidenceBundle` from a free-text query."""

    def __init__(
        self,
        *,
        repository: EventRepository,
        search: SearchService,
        place_resolver: PlaceResolver | None = None,
        evidence_limit: int = 6,
    ) -> None:
        self._repository = repository
        self._search = search
        self._place_resolver = place_resolver or default_place_resolver
        self._evidence_limit = evidence_limit
        self._planner = QueryPlanner(place_resolver=self._place_resolver)

    async def run(
        self, query: str, *, now: datetime | None = None
    ) -> EvidenceBundle:
        """Plan → workers → bundle.

        ``now`` is exposed so deterministic tests can pin the time
        window without freezing the system clock. Production callers
        leave it as ``None``.
        """

        plan = self._planner.plan(query, now=now)
        return await self.run_plan(plan)

    async def run_plan(self, plan: QueryPlan) -> EvidenceBundle:
        workers_invoked: list[str] = []
        caveats: list[str] = []
        entity = plan.entity

        # Phase 18C — entity unresolved means we refuse to retrieve
        # anything. This is the trust gate the user explicitly asked for:
        # no fallback to global corpus, no silent leaking of unrelated
        # rows. Surface a single, honest caveat and return an empty
        # bundle. Compare queries are exempt because the compare planner
        # may still resolve individual legs even when the primary text
        # alone is gibberish.
        if (
            entity is not None
            and entity.kind == "unresolved"
            and not plan.compare.requested
        ):
            return self._unresolved_bundle(plan, caveats=[
                "No entity resolved for query. Try a country, ticker, or "
                "commodity (e.g. \"oil\", \"tesla\", \"USDJPY\")."
            ])

        # 1. PlaceWorker — primary subject, scoped events, fallback notice.
        (
            scope,
            entities,
            primary_events,
            scope_used,
            scope_event_count,
            fallback_notice,
            resolved_place,
        ) = await run_place_worker(
            plan,
            search=self._search,
            place_resolver=self._place_resolver,
            evidence_limit=self._evidence_limit,
        )
        workers_invoked.append("place")

        # 2. TimelineWorker — restrict to the requested window.
        if plan.needs_timeline_worker:
            primary_events, timeline_caveats = await run_timeline_worker(
                plan,
                primary_events,
                repository=self._repository,
                evidence_limit=self._evidence_limit,
            )
            caveats.extend(timeline_caveats)
            workers_invoked.append("timeline")

        # 3. CountrySummaryWorker — only when the scope is strong enough.
        # Skip for market-class entities (commodity / ticker / fx) so we
        # don't drag a country-mood blob into a focused commodity query.
        country_summary = None
        if entity is None or not entity.is_market:
            country_summary = await run_country_summary_worker(
                scope, repository=self._repository
            )
        if country_summary is not None:
            workers_invoked.append("country_summary")
            primary_events = _merge_summary_signals(primary_events, country_summary)

        # 3b. Phase 18C scope gate — drop rows the entity would not own.
        relevance_filtered_count = 0
        if entity is not None and entity.is_resolved:
            primary_events, relevance_filtered_count = apply_relevance_filter(
                primary_events, entity
            )
            workers_invoked.append("relevance_filter")
            if not primary_events and relevance_filtered_count > 0:
                caveats.append(
                    f"No signals matched the resolved entity ({entity.label}) "
                    "in the current corpus."
                )

        # 4. CompareWorker — when compare intent was detected.
        compare_snapshots: list = []
        compare_delta = None
        time_compare = (
            entity is not None
            and entity.is_resolved
            and is_time_compare(plan.time, plan.compare)
        )
        if plan.needs_compare_worker and time_compare:
            compare_delta = await build_compare_delta(
                entity=entity,
                plan_time=plan.time,
                compare=plan.compare,
                raw_query=plan.raw_query,
                repository=self._repository,
                evidence_limit=self._evidence_limit,
            )
            workers_invoked.append("compare_delta")
            if compare_delta is None:
                caveats.append(
                    "Compare requested two windows but they could not be "
                    "resolved deterministically; falling back to a single "
                    "scoped view."
                )
        elif plan.needs_compare_worker:
            compare_snapshots = await run_compare_worker(
                plan,
                repository=self._repository,
                search=self._search,
                place_resolver=self._place_resolver,
                evidence_limit=max(2, self._evidence_limit // 2),
            )
            workers_invoked.append("compare")
            resolved_count = sum(1 for s in compare_snapshots if s.is_resolved)
            if plan.compare.requested and resolved_count < 2:
                caveats.append(
                    "Compare resolution was partial — fewer than two legs "
                    "matched a known entity. The answer falls back to the "
                    "primary subject."
                )

        # 5. PlaceDependencyWorker — only when scope is strong + has events.
        place_dependencies = run_place_dependency_worker(
            resolved_place, primary_events[: self._evidence_limit]
        )
        if place_dependencies:
            workers_invoked.append("place_dependency")

        # Trim primary events to the configured evidence limit.
        primary_events = primary_events[: self._evidence_limit]

        # Phase 18C — when the time window has no signal AND we have a
        # resolved entity, raise a precise, no-fallback caveat.
        if (
            entity is not None
            and entity.is_resolved
            and plan.needs_timeline_worker
            and not primary_events
        ):
            caveats.append(
                f"No activity for {entity.label} in the selected time window "
                f"({plan.time.label})."
            )

        time_context = derive_time_context(
            plan.time, matched_event_count=len(primary_events)
        )

        macro_context = (
            scope.macro_context
            if scope.fallback_level not in ("none", "parent_region")
            else None
        )

        bundle = EvidenceBundle(
            plan=plan,
            primary_scope=scope,
            resolved_entities=entities,
            primary_events=primary_events,
            country_summary=country_summary,
            fallback_notice=fallback_notice,
            scope_used=scope_used,
            scope_event_count=scope_event_count,
            compare_snapshots=compare_snapshots,
            time_context=time_context,
            place_dependencies=place_dependencies,
            macro_context=macro_context,
            workers_invoked=workers_invoked,
            caveats=caveats,
            entity=entity,
            entity_resolved=bool(entity and entity.is_resolved),
            relevance_filtered_count=relevance_filtered_count,
            compare_delta=compare_delta,
            generated_at=datetime.now(timezone.utc),
        )
        logger.debug(
            "retrieval.orchestrator workers=%s compare_requested=%s "
            "scope_used=%s window=%s evidence=%d",
            workers_invoked,
            plan.compare.requested,
            scope_used,
            plan.time.label,
            len(primary_events),
        )
        return bundle


    def _unresolved_bundle(
        self, plan: QueryPlan, *, caveats: list[str]
    ) -> EvidenceBundle:
        """Phase 18C — refuse retrieval when no entity was identified."""

        empty_scope = PlaceScope(query=plan.raw_query)
        time_context = derive_time_context(plan.time, matched_event_count=0)
        return EvidenceBundle(
            plan=plan,
            primary_scope=empty_scope,
            resolved_entities=[],
            primary_events=[],
            country_summary=None,
            fallback_notice=None,
            scope_used="global",
            scope_event_count=0,
            compare_snapshots=[],
            time_context=time_context,
            place_dependencies=[],
            macro_context=None,
            workers_invoked=["entity_resolver"],
            caveats=caveats,
            entity=plan.entity,
            entity_resolved=False,
            relevance_filtered_count=0,
            compare_delta=None,
            generated_at=datetime.now(timezone.utc),
        )


def _merge_summary_signals(
    primary: Sequence[SignalEvent],
    summary,
) -> list[SignalEvent]:
    merged = list(primary)
    seen = {event.id for event in merged}
    for signal in summary.top_signals:
        if signal.id in seen:
            continue
        seen.add(signal.id)
        merged.append(signal)
    return merged


__all__ = ["RetrievalOrchestrator"]
