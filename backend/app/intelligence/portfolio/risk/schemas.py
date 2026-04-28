"""Frozen pydantic shapes for the portfolio Macro Risk Score (Phase 13B.4).

Design rules (see 13b-CONTEXT.md D-25/D-26):

* every response carries drivers + confidence + score_components + notes —
  never a naked number
* ``risk_score`` is bounded 0..100
* Tilt reservation fields (bullish/bearish/uncertainty/alignment) declared
  as ``| None`` defaults — populated in Plan 06
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


RiskComponentName = Literal[
    "concentration",
    "fx",
    "commodity",
    "chokepoint",
    "event_severity",
    "semantic_density",
]


class RiskScoreComponents(BaseModel):
    """The six normalized 0..1 components that blend into the final score."""

    model_config = ConfigDict(frozen=True)

    concentration: float = Field(ge=0.0, le=1.0)
    fx: float = Field(ge=0.0, le=1.0)
    commodity: float = Field(ge=0.0, le=1.0)
    chokepoint: float = Field(ge=0.0, le=1.0)
    event_severity: float = Field(ge=0.0, le=1.0)
    semantic_density: float = Field(ge=0.0, le=1.0)


class RiskDriver(BaseModel):
    """A ranked driver contributing to the final risk score.

    ``weight`` is the contribution to the final score: ``component_value ×
    component_weight`` (rounded). ``evidence_ids`` cite real nodes / events
    where applicable — never fabricated.
    """

    model_config = ConfigDict(frozen=True)

    component: RiskComponentName
    label: str
    weight: float = Field(ge=0.0, le=1.0)
    rationale: str
    evidence_ids: list[str] = Field(default_factory=list)


class PortfolioMacroRiskScore(BaseModel):
    """Portfolio-level macro risk score with drivers, confidence, components."""

    model_config = ConfigDict(frozen=True)

    portfolio_id: str
    risk_score: float = Field(ge=0.0, le=100.0)
    delta_vs_baseline: float  # may be negative
    drivers: list[RiskDriver] = Field(default_factory=list)
    confidence: float = Field(ge=0.0, le=1.0)
    score_components: RiskScoreComponents
    as_of: datetime
    freshness_seconds: int = Field(default=0, ge=0)
    notes: list[str] = Field(default_factory=list)

    # ---- Plan 06 tilt reservation — non-breaking defaults ----
    bullish_tilt_score: float | None = None
    bearish_tilt_score: float | None = None
    uncertainty_score: float | None = None
    signal_alignment: Literal[
        "aligned", "mixed", "conflicting", "insufficient"
    ] | None = None


__all__ = [
    "PortfolioMacroRiskScore",
    "RiskComponentName",
    "RiskDriver",
    "RiskScoreComponents",
]
