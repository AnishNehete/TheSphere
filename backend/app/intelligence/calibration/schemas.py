"""Typed shapes for the calibration / query-log pipeline (Phase 18B).

The query log is append-only. ``user_action`` is the one column that is
ever updated post-insert (when a downstream signal lands), but every
update path must go through :class:`CalibrationService` — repositories
expose ``mark_user_action`` rather than a generic update.

No PII rules:

* ``query_text`` is stored as raw text; analysts already type queries the
  product evaluates client-side. Sphere never mixes user identifiers into
  the log row, and there is no per-user index.
* ``resolved_entity_ids`` and ``evidence_ids`` are opaque internal ids.
* No IP / session / cookie / auth header is ever logged.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


UserActionKind = Literal["none", "refine", "click", "share"]
TimeWindowKind = Literal["live", "since", "between", "as_of", "delta"]


class RankingBreakdown(BaseModel):
    """Per-evidence breakdown of how the final score was assembled.

    Returned by the search service in debug mode and by the admin
    debug-ranking endpoint. The four components are bounded to ``[0, 1]``
    so weight tuning has a stable scale.
    """

    model_config = ConfigDict(frozen=True)

    event_id: str
    base_score: float = Field(ge=0.0, le=1.0)
    freshness_score: float = Field(ge=0.0, le=1.0)
    severity_score: float = Field(ge=0.0, le=1.0)
    location_match_score: float = Field(ge=0.0, le=1.0)
    diversity_penalty: float = Field(default=0.0, ge=0.0, le=1.0)
    semantic_score: float = Field(default=0.0, ge=0.0, le=1.0)
    final_score: float = Field(ge=0.0, le=1.5)
    matched_terms: list[str] = Field(default_factory=list)
    place_match: str | None = None


class QueryLogEntryCreate(BaseModel):
    """Body the agent service hands to :class:`CalibrationService.log`.

    The service stamps ``id`` and ``timestamp`` so callers cannot accidentally
    collide ids or backfill timestamps.
    """

    model_config = ConfigDict(frozen=True)

    query_text: str
    intent: str
    resolved_entity_ids: list[str] = Field(default_factory=list)
    evidence_ids: list[str] = Field(default_factory=list)
    time_window_kind: TimeWindowKind
    compare_requested: bool = False
    confidence_score: float = Field(ge=0.0, le=1.0)
    top_evidence_score: float = Field(default=0.0, ge=0.0, le=1.5)
    result_count: int = Field(ge=0)
    latency_ms: int = Field(ge=0)


class QueryLogEntry(BaseModel):
    """Persisted query-log row.

    Append-only: the only mutable column is ``user_action`` (and the
    derived ``feedback_score``), which lands when downstream UI signals
    fire. ``timestamp`` is the canonical creation time.
    """

    model_config = ConfigDict(frozen=False)

    id: str
    timestamp: datetime
    query_text: str
    intent: str
    resolved_entity_ids: list[str] = Field(default_factory=list)
    evidence_ids: list[str] = Field(default_factory=list)
    time_window_kind: TimeWindowKind
    compare_requested: bool = False
    confidence_score: float = Field(ge=0.0, le=1.0)
    top_evidence_score: float = Field(default=0.0, ge=0.0, le=1.5)
    result_count: int = Field(ge=0)
    user_action: UserActionKind = "none"
    feedback_score: float = Field(default=0.0, ge=-1.0, le=1.0)
    latency_ms: int = Field(ge=0)

    def with_action(
        self, action: UserActionKind, *, feedback_score: float
    ) -> "QueryLogEntry":
        return self.model_copy(
            update={"user_action": action, "feedback_score": feedback_score}
        )


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


__all__ = [
    "QueryLogEntry",
    "QueryLogEntryCreate",
    "RankingBreakdown",
    "TimeWindowKind",
    "UserActionKind",
    "utc_now",
]
