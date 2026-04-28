"""Frozen pydantic shapes for the semantic / event pressure engine.

Design rules (see ``.planning/phases/13b-signal-engines-chart-replay/13b-CONTEXT.md``
decisions D-20 / D-22):

* every semantic driver must carry at least one ``evidence_ids`` entry so the
  UI can cite the real event that contributed
* ``event_pressure_level`` is a bounded Literal — never "buy" / "sell"
* shapes are frozen so callers can't mutate a snapshot after scoring
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


EventPressureLevel = Literal["calm", "watch", "elevated", "critical"]


class SemanticDriver(BaseModel):
    """A single exposure-node driver for a holding's semantic snapshot.

    ``evidence_ids`` must reference actual ``SignalEvent.id`` values — the
    engine never fabricates event IDs or driver rationale text.
    """

    model_config = ConfigDict(frozen=True)

    node_id: str  # e.g. "country:USA", "sector:technology", "chokepoint:suez"
    label: str
    contribution: float = Field(ge=0.0, le=1.0)
    rationale: str
    evidence_ids: list[str] = Field(default_factory=list, min_length=1)


class SemanticSnapshot(BaseModel):
    """Per-holding semantic pressure snapshot.

    ``semantic_score`` is bounded 0..1; the engine caps the raw rollup so band
    thresholds remain meaningful.
    """

    model_config = ConfigDict(frozen=True)

    holding_id: str
    symbol: str
    semantic_score: float = Field(ge=0.0, le=1.0)
    event_pressure_level: EventPressureLevel = "calm"
    semantic_drivers: list[SemanticDriver] = Field(default_factory=list)
    linked_event_ids: list[str] = Field(default_factory=list)
    confidence: float = Field(default=0.0, ge=0.0, le=1.0)
    as_of: datetime
    notes: list[str] = Field(default_factory=list)

    # Plan 06 tilt foundation — None until engine populates them.
    bullish_tilt_score: float | None = None
    bearish_tilt_score: float | None = None
    uncertainty_score: float | None = None
    signal_alignment: (
        Literal["aligned", "mixed", "conflicting", "insufficient"] | None
    ) = None


class PortfolioSemanticRollup(BaseModel):
    """Portfolio-level rollup across the per-holding snapshots.

    ``semantic_score`` is the holding-weight-weighted average of per-holding
    scores, bounded 0..1. ``top_drivers`` merges per-node contributions across
    the portfolio and keeps the top N by combined contribution.
    """

    model_config = ConfigDict(frozen=True)

    portfolio_id: str
    semantic_score: float = Field(ge=0.0, le=1.0)
    event_pressure_level: EventPressureLevel = "calm"
    top_drivers: list[SemanticDriver] = Field(default_factory=list)
    contributing_event_count: int = 0
    as_of: datetime
    confidence: float = Field(default=0.0, ge=0.0, le=1.0)

    # Plan 06 tilt foundation — None until engine populates them.
    bullish_tilt_score: float | None = None
    bearish_tilt_score: float | None = None
    uncertainty_score: float | None = None
    signal_alignment: (
        Literal["aligned", "mixed", "conflicting", "insufficient"] | None
    ) = None


__all__ = [
    "EventPressureLevel",
    "PortfolioSemanticRollup",
    "SemanticDriver",
    "SemanticSnapshot",
]
