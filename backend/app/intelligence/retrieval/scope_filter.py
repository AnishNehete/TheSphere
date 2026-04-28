"""Phase 18C — entity-aware relevance filter and compare delta builder.

Two responsibilities, both deliberately small:

1. ``apply_relevance_filter`` — given a list of candidate
   :class:`SignalEvent` rows and a :class:`QueryEntity`, drop the rows
   that are not actually about the entity. This is the gate that stops
   ``"why tesla down"`` from returning unrelated weather rows.

2. ``build_compare_delta`` — when the query is a single-entity, two-time
   compare ("oil yesterday vs today"), run two scoped queries and emit a
   :class:`CompareDeltaSummary` so the agent can answer with explicit
   added / removed / intensity_change instead of mixing windows.

Both helpers live outside :mod:`workers` because they orchestrate across
the place + entity + time windows; keeping them here makes the
orchestrator wiring readable.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Sequence

from app.intelligence.repositories.event_repository import EventQuery, EventRepository
from app.intelligence.retrieval.compare_planner import ComparePlan
from app.intelligence.retrieval.entity_resolver import QueryEntity, is_relevant
from app.intelligence.retrieval.evidence_bundle import CompareDeltaSummary
from app.intelligence.retrieval.time_window import TimeWindow
from app.intelligence.schemas import SignalEvent


# ----------------------------------------------------------------------------
# Relevance filter
# ----------------------------------------------------------------------------


def apply_relevance_filter(
    events: Sequence[SignalEvent],
    entity: QueryEntity | None,
) -> tuple[list[SignalEvent], int]:
    """Keep events that pass :func:`is_relevant` for ``entity``.

    Returns ``(kept_events, dropped_count)``. When ``entity`` is ``None``
    (planner failed to attach one — should not happen for 18C wired
    flows) the events are passed through unchanged.

    When the entity is ``unresolved``, every event is dropped — the
    orchestrator must then surface a "no entity resolved" caveat rather
    than silently leaking the global corpus.
    """

    if entity is None:
        return list(events), 0

    if entity.kind == "unresolved":
        return [], len(events)

    # Country / place entities already benefit from the place-aware
    # filter inside :class:`SearchService`. Re-applying ``is_relevant``
    # would only filter on label substring, which is too aggressive when
    # the search service has already proven country code parity. Skip
    # the additional gate for those kinds.
    if entity.kind in ("country", "place"):
        return list(events), 0

    kept: list[SignalEvent] = []
    dropped = 0
    for event in events:
        haystack = _event_haystack(event)
        if is_relevant(
            event_type=event.type,
            event_tags=tuple(event.tags),
            event_country_code=event.place.country_code,
            event_haystack=haystack,
            entity=entity,
        ):
            kept.append(event)
        else:
            dropped += 1
    return kept, dropped


def _event_haystack(event: SignalEvent) -> str:
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


# ----------------------------------------------------------------------------
# Compare delta
# ----------------------------------------------------------------------------


def is_time_compare(plan_time: TimeWindow, compare: ComparePlan) -> bool:
    """Detect a single-entity ``X yesterday vs today`` compare.

    The compare planner currently splits the *legs* of "yesterday vs
    today" as two place-text legs. When neither leg resolves to a known
    entity but the raw query contains both ``yesterday`` and ``today``
    (or a similar pair), we promote the query to a time-delta compare.
    """

    if not compare.requested:
        return False
    raw = (plan_time.raw_phrase or "").lower()
    legs_lc = " ".join(t.raw.lower() for t in compare.targets)
    text = f"{raw} {legs_lc}".lower()
    pair_signals = (
        ("yesterday", "today"),
        ("yesterday", "now"),
        ("last week", "this week"),
        ("last month", "this month"),
    )
    return any(a in text and b in text for a, b in pair_signals)


def build_compare_delta_windows(
    *, anchor: datetime, raw_query: str
) -> tuple[TimeWindow, TimeWindow] | None:
    """Resolve the two windows for a time-compare query.

    Returns ``(left_window, right_window)`` where ``left`` is the older
    leg. ``None`` when the query does not pair two recognised time
    phrases.
    """

    text = (raw_query or "").lower()

    def yesterday_window() -> TimeWindow:
        y = anchor.date() - timedelta(days=1)
        start = datetime.combine(y, datetime.min.time(), tzinfo=timezone.utc)
        end = datetime.combine(
            y, datetime.max.time().replace(microsecond=0), tzinfo=timezone.utc
        )
        return TimeWindow(
            kind="between",
            label="yesterday",
            since=start,
            until=end,
            anchor=anchor,
            is_historical=True,
            raw_phrase="yesterday",
            semantic_kind="yesterday",
        )

    def today_window() -> TimeWindow:
        start = datetime.combine(
            anchor.date(), datetime.min.time(), tzinfo=timezone.utc
        )
        return TimeWindow(
            kind="between",
            label="today",
            since=start,
            until=anchor,
            anchor=anchor,
            is_historical=False,
            raw_phrase="today",
            semantic_kind="today",
        )

    def last_week_window() -> TimeWindow:
        start = anchor - timedelta(days=14)
        end = anchor - timedelta(days=7)
        return TimeWindow(
            kind="between",
            label="last week",
            since=start,
            until=end,
            anchor=anchor,
            is_historical=True,
            raw_phrase="last week",
            semantic_kind="last_week",
        )

    def this_week_window() -> TimeWindow:
        start = anchor - timedelta(days=7)
        return TimeWindow(
            kind="since",
            label="this week",
            since=start,
            until=anchor,
            anchor=anchor,
            is_historical=False,
            raw_phrase="this week",
            semantic_kind="this_week",
        )

    if "yesterday" in text and "today" in text:
        return yesterday_window(), today_window()
    if "last week" in text and "this week" in text:
        return last_week_window(), this_week_window()
    return None


async def build_compare_delta(
    *,
    entity: QueryEntity,
    plan_time: TimeWindow,
    compare: ComparePlan,
    raw_query: str,
    repository: EventRepository,
    evidence_limit: int = 6,
) -> CompareDeltaSummary | None:
    """Run two scoped queries and return a :class:`CompareDeltaSummary`.

    ``None`` when the query does not actually express a time compare or
    when the entity is unresolved (the orchestrator surfaces a caveat in
    that case). The caller is responsible for swapping in the delta
    snapshot in place of the mixed-list compare snapshots.
    """

    if not entity.is_resolved:
        return None
    windows = build_compare_delta_windows(
        anchor=plan_time.anchor, raw_query=raw_query
    )
    if windows is None:
        return None
    left_window, right_window = windows

    left_events = await _scoped_window_query(
        entity=entity,
        window=left_window,
        repository=repository,
        evidence_limit=evidence_limit,
    )
    right_events = await _scoped_window_query(
        entity=entity,
        window=right_window,
        repository=repository,
        evidence_limit=evidence_limit,
    )

    left_ids = {e.id for e in left_events}
    right_ids = {e.id for e in right_events}
    added = len(right_ids - left_ids)
    removed = len(left_ids - right_ids)
    intensity_change = round(
        _avg_severity(right_events) - _avg_severity(left_events), 3
    )

    return CompareDeltaSummary(
        entity=entity,
        left_window=left_window,
        right_window=right_window,
        left_events=list(left_events[:evidence_limit]),
        right_events=list(right_events[:evidence_limit]),
        added=added,
        removed=removed,
        intensity_change=intensity_change,
    )


async def _scoped_window_query(
    *,
    entity: QueryEntity,
    window: TimeWindow,
    repository: EventRepository,
    evidence_limit: int,
) -> list[SignalEvent]:
    query = EventQuery(
        country_code=entity.country_code,
        since=window.since,
        until=window.until,
        limit=max(evidence_limit * 4, 32),
    )
    candidates = await repository.query(query)
    kept, _ = apply_relevance_filter(candidates, entity)
    return kept


def _avg_severity(events: Sequence[SignalEvent]) -> float:
    if not events:
        return 0.0
    total = sum(float(e.severity_score or 0.0) for e in events)
    return total / float(len(events))


__all__ = [
    "apply_relevance_filter",
    "build_compare_delta",
    "build_compare_delta_windows",
    "is_time_compare",
]
