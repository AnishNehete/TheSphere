"""Top-level query planner — combines intent, time, and compare detection.

Phase 18A.1 elevates the ad-hoc reasoning currently scattered across
:mod:`agent_service` into one explicit :class:`QueryPlan`. The orchestrator
consumes the plan to decide which workers to run; the agent consumes the
plan (via the bundle) to phrase an answer that matches user intent.

Intent detection here is intentionally still rule-based — the existing
heuristics in :mod:`agent_service` already perform well on the wedge
queries we ship, and there is no LLM in the hot path. Adding bounded LLM
classification later is a 30-line drop-in: only the ``classify_intent``
hook needs to change.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime
from typing import Sequence

from app.intelligence.geo.resolver import PlaceResolver
from app.intelligence.retrieval.compare_planner import ComparePlan, plan_compare
from app.intelligence.retrieval.entity_resolver import (
    QueryEntity,
    resolve_query_entity,
)
from app.intelligence.retrieval.time_window import TimeWindow, parse_time_window
from app.intelligence.schemas import AgentIntent


_WHY_TOKENS = ("why", "reason", "because", "cause", "driver")
_ELEVATED_TOKENS = ("elevated", "critical", "risk", "watch", "threat", "alert")
_CHANGED_TOKENS = ("changed", "new", "update", "recent", "latest", "today", "past")
_IMPACT_TOKENS = (
    "affect",
    "impact",
    "downstream",
    "expose",
    "ripple",
    "drive",
    "drives",
    "driving",
)
_STATUS_TOKENS = ("status", "how is", "what is", "show me", "state of")


@dataclass(frozen=True, slots=True)
class QueryPlan:
    """The deterministic plan the orchestrator runs against.

    * ``raw_query``    — the literal input
    * ``primary_text`` — the residual after stripping compare/time hints
                         (used to anchor the primary place resolution)
    * ``intent``       — coarse analyst intent (existing :class:`AgentIntent`
                         literal — same set the UI already understands)
    * ``time``         — typed :class:`TimeWindow`
    * ``compare``      — typed :class:`ComparePlan`
    """

    raw_query: str
    primary_text: str
    intent: AgentIntent
    time: TimeWindow
    compare: ComparePlan
    anchor: datetime
    entity: QueryEntity | None = None

    @property
    def needs_timeline_worker(self) -> bool:
        return self.time.kind != "live"

    @property
    def needs_compare_worker(self) -> bool:
        return self.compare.requested

    @property
    def has_resolved_entity(self) -> bool:
        return self.entity is not None and self.entity.is_resolved


class QueryPlanner:
    """Build a :class:`QueryPlan` for a free-text query."""

    def __init__(self, *, place_resolver: PlaceResolver | None = None) -> None:
        self._place_resolver = place_resolver

    def plan(self, query: str, *, now: datetime | None = None) -> QueryPlan:
        raw = (query or "").strip()
        time_window = parse_time_window(raw, now=now)
        compare = plan_compare(raw, place_resolver=self._place_resolver)
        intent = classify_intent(raw, time_window=time_window, compare=compare)

        primary_text = _strip_hints(
            raw,
            time_phrase=time_window.raw_phrase,
            compare_primary=compare.primary_text,
            requested=compare.requested,
        )
        # Phase 18C — resolve the dominant entity from the residual primary
        # text so compare/time hints don't pollute commodity / ticker
        # detection (e.g. "oil yesterday" should resolve to ``oil``).
        entity_text = primary_text or raw
        entity = resolve_query_entity(
            entity_text, place_resolver=self._place_resolver
        )
        return QueryPlan(
            raw_query=raw,
            primary_text=primary_text or raw,
            intent=intent,
            time=time_window,
            compare=compare,
            anchor=time_window.anchor,
            entity=entity,
        )


def classify_intent(
    text: str,
    *,
    time_window: TimeWindow,
    compare: ComparePlan,
) -> AgentIntent:
    """Deterministic intent classifier.

    A delta time window biases towards ``what_changed``; a compare plan
    keeps the upstream intent (compare is orthogonal). Unrecognised text
    falls back to ``general_retrieval``.
    """

    lowered = (text or "").lower()
    if time_window.kind == "delta" and not _contains_any(lowered, _WHY_TOKENS):
        return "what_changed"
    if _contains_any(lowered, _WHY_TOKENS) and _contains_any(lowered, _ELEVATED_TOKENS):
        return "why_elevated"
    if _contains_any(lowered, _WHY_TOKENS):
        return "driving_factor"
    if _contains_any(lowered, _CHANGED_TOKENS):
        return "what_changed"
    if _contains_any(lowered, _IMPACT_TOKENS):
        return "downstream_impact"
    if _contains_any(lowered, _STATUS_TOKENS):
        return "status_check"
    if compare.requested:
        return "status_check"
    return "general_retrieval"


def _contains_any(text: str, tokens: Sequence[str]) -> bool:
    return any(tok in text for tok in tokens)


def _strip_hints(
    text: str,
    *,
    time_phrase: str | None,
    compare_primary: str | None,
    requested: bool,
) -> str:
    """Best-effort residual: remove the matched time phrase and, for a
    compare query, prefer the first leg as the primary subject so the
    upstream place resolver doesn't see "Japan vs Korea" as a single
    string.
    """

    residual = compare_primary if (requested and compare_primary) else text
    if time_phrase:
        residual = re.sub(
            re.escape(time_phrase), "", residual, flags=re.IGNORECASE
        )
    return re.sub(r"\s+", " ", residual or "").strip()


__all__ = ["QueryPlan", "QueryPlanner", "classify_intent"]
