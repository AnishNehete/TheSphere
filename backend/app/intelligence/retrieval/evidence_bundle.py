"""Typed evidence bundle — the deterministic substrate the agent answers from.

Phase 18A.1 contract: every grounded answer must derive from a single
:class:`EvidenceBundle`. The agent service composes prose; the bundle is
where the *facts* live (resolved entities, evidence ids, time context,
compare snapshots, fallback flags). If a future phase swaps the rule-based
answer composer for an LLM, the bundle is what the LLM consumes — no other
state may inform the prose.

Bundles are frozen — workers build them up through ``replace`` semantics
in :class:`RetrievalOrchestrator`.
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Iterable, Literal, Sequence

from app.intelligence.retrieval.compare_planner import CompareTargetSpec
from app.intelligence.retrieval.entity_resolver import QueryEntity
from app.intelligence.retrieval.query_planner import QueryPlan
from app.intelligence.retrieval.time_window import TimeWindow
from app.intelligence.schemas import (
    CountrySignalSummary,
    DependencyPath,
    MacroContext,
    PlaceScope,
    ResolvedEntity,
    SignalEvent,
)


TimeCoverage = Literal["live", "windowed", "delta", "as_of", "no_match"]


@dataclass(frozen=True, slots=True)
class TimeContext:
    """Resolved time framing the answer should disclose to the user."""

    window: TimeWindow
    coverage: TimeCoverage
    answer_mode_label: str
    matched_event_count: int

    @property
    def is_live(self) -> bool:
        return self.coverage == "live"


@dataclass(frozen=True, slots=True)
class CompareTargetSnapshot:
    """A resolved compare leg with its scope-specific evidence."""

    spec: CompareTargetSpec
    scope: PlaceScope
    events: list[SignalEvent] = field(default_factory=list)
    summary: CountrySignalSummary | None = None
    counts_by_category: dict[str, int] = field(default_factory=dict)
    severity_distribution: dict[str, int] = field(default_factory=dict)
    freshness_minutes: float | None = None

    @property
    def is_resolved(self) -> bool:
        return self.spec.resolution != "none"


@dataclass(frozen=True, slots=True)
class CompareDeltaSummary:
    """Phase 18C — single-entity, two-window compare snapshot.

    Returned for queries like ``"oil yesterday vs today"``: instead of
    mixing both windows into one ranked list, the orchestrator runs
    *two* scoped queries and exposes them side-by-side plus an explicit
    delta. The agent can then answer with a clean change story rather
    than reasoning over conflated rows.
    """

    entity: QueryEntity
    left_window: TimeWindow
    right_window: TimeWindow
    left_events: list[SignalEvent] = field(default_factory=list)
    right_events: list[SignalEvent] = field(default_factory=list)
    added: int = 0
    removed: int = 0
    intensity_change: float = 0.0

    @property
    def has_movement(self) -> bool:
        return self.added != 0 or self.removed != 0 or self.intensity_change != 0.0


@dataclass(frozen=True, slots=True)
class EvidenceBundle:
    """The single source of truth the agent answer composes from."""

    plan: QueryPlan
    primary_scope: PlaceScope
    resolved_entities: list[ResolvedEntity] = field(default_factory=list)
    primary_events: list[SignalEvent] = field(default_factory=list)
    country_summary: CountrySignalSummary | None = None
    fallback_notice: str | None = None
    scope_used: str = "global"
    scope_event_count: int = 0
    compare_snapshots: list[CompareTargetSnapshot] = field(default_factory=list)
    time_context: TimeContext | None = None
    place_dependencies: list[DependencyPath] = field(default_factory=list)
    macro_context: MacroContext | None = None
    workers_invoked: list[str] = field(default_factory=list)
    caveats: list[str] = field(default_factory=list)
    entity: QueryEntity | None = None
    entity_resolved: bool = False
    relevance_filtered_count: int = 0
    compare_delta: CompareDeltaSummary | None = None
    generated_at: datetime = field(
        default_factory=lambda: datetime.now(timezone.utc)
    )

    @property
    def has_evidence(self) -> bool:
        return bool(self.primary_events) or self.country_summary is not None

    @property
    def has_compare_delta(self) -> bool:
        return self.compare_delta is not None

    @property
    def has_compare(self) -> bool:
        return any(s.is_resolved for s in self.compare_snapshots)

    @property
    def compare_collapsed(self) -> bool:
        return self.plan.compare.requested and (
            sum(1 for s in self.compare_snapshots if s.is_resolved) < 2
        )

    def evidence_ids(self) -> set[str]:
        ids = {event.id for event in self.primary_events}
        for snap in self.compare_snapshots:
            ids.update(event.id for event in snap.events)
        return ids


# ----------------------------------------------------------------------------
# Helpers used by workers + orchestrator
# ----------------------------------------------------------------------------


def summarize_event_distribution(
    events: Iterable[SignalEvent],
) -> tuple[dict[str, int], dict[str, int], float | None]:
    """Compute (counts_by_category, severity_distribution, freshness_minutes)."""

    materialised: Sequence[SignalEvent] = list(events)
    counts = dict(Counter(e.type for e in materialised))
    severities = dict(Counter(e.severity for e in materialised))
    freshness = _freshness_minutes(materialised)
    return counts, severities, freshness


def _freshness_minutes(events: Sequence[SignalEvent]) -> float | None:
    if not events:
        return None
    now = datetime.now(timezone.utc)
    freshest: float | None = None
    for event in events:
        ref = event.source_timestamp or event.ingested_at
        if ref is None:
            continue
        minutes = max(0.0, (now - ref).total_seconds() / 60.0)
        if freshest is None or minutes < freshest:
            freshest = minutes
    if freshest is None:
        return None
    return round(freshest, 1)


def derive_time_context(
    window: TimeWindow, *, matched_event_count: int
) -> TimeContext:
    """Derive the user-facing time framing for the bundle."""

    if window.kind == "live":
        return TimeContext(
            window=window,
            coverage="live",
            answer_mode_label="Live",
            matched_event_count=matched_event_count,
        )
    if window.kind == "delta":
        return TimeContext(
            window=window,
            coverage="delta",
            answer_mode_label=f"Delta — {window.label}",
            matched_event_count=matched_event_count,
        )
    if window.kind == "as_of":
        return TimeContext(
            window=window,
            coverage="as_of",
            answer_mode_label=window.label.capitalize(),
            matched_event_count=matched_event_count,
        )
    coverage: TimeCoverage = "windowed" if matched_event_count > 0 else "no_match"
    return TimeContext(
        window=window,
        coverage=coverage,
        answer_mode_label=window.label.capitalize(),
        matched_event_count=matched_event_count,
    )


__all__ = [
    "CompareDeltaSummary",
    "CompareTargetSnapshot",
    "EvidenceBundle",
    "TimeContext",
    "TimeCoverage",
    "derive_time_context",
    "summarize_event_distribution",
]
