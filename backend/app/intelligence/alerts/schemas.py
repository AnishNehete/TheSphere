"""Frozen pydantic shapes for the Alert MVP (Phase 17C).

The evaluator + service operate over these typed shapes. The same
"no naked numbers" rule from posture/narrative/investigations applies:
every :class:`AlertEvent` carries a full :class:`MarketPosture` envelope
plus a typed :class:`AlertDelta` describing exactly which field moved
and by how much.
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from app.intelligence.portfolio.posture.schemas import (
    AssetClass,
    MarketPosture,
    PostureLabel,
)


AlertRuleKind = Literal["posture_band_change", "confidence_drop"]
AlertDeltaField = Literal["posture", "confidence"]


# Cooldown window applied uniformly to every rule kind. 30 minutes is
# the smallest window that comfortably absorbs Alpha Vantage's 1-minute
# polling jitter without burying an analyst under repeats.
DEFAULT_COOLDOWN_SECONDS = 30 * 60

# Default absolute drop in ``confidence`` (0..1) for ``confidence_drop``
# rules when the user does not specify one.
DEFAULT_CONFIDENCE_THRESHOLD = 0.30


class AlertRuleCreate(BaseModel):
    """User-supplied rule creation payload."""

    model_config = ConfigDict(frozen=True)

    name: str = Field(..., min_length=1, max_length=120)
    kind: AlertRuleKind
    symbol: str = Field(..., min_length=1, max_length=24)
    asset_class: AssetClass = "unknown"
    threshold: float | None = Field(
        default=None,
        ge=0.0,
        le=1.0,
        description=(
            "Absolute drop in confidence for ``confidence_drop`` rules. "
            "Ignored by ``posture_band_change``."
        ),
    )
    cooldown_seconds: int = Field(
        default=DEFAULT_COOLDOWN_SECONDS, ge=60, le=24 * 60 * 60
    )
    enabled: bool = True


class AlertRule(BaseModel):
    """Persisted rule. Baseline fields are populated when the rule is
    created (from the current posture for that symbol) and re-anchored
    after each fire so the next evaluation tracks moves from the new
    baseline rather than the original one.
    """

    model_config = ConfigDict(frozen=False)

    id: str
    name: str
    kind: AlertRuleKind
    symbol: str
    asset_class: AssetClass
    threshold: float | None
    cooldown_seconds: int
    enabled: bool
    created_at: datetime

    baseline_posture: PostureLabel | None = None
    baseline_confidence: float | None = None
    baseline_at: datetime | None = None
    last_evaluated_at: datetime | None = None
    last_fired_at: datetime | None = None


class AlertDelta(BaseModel):
    """Quantitative description of what changed.

    ``magnitude`` is signed for ``confidence`` (positive = drop) and
    band-distance for ``posture`` (1 step = adjacent band, 2 = e.g.
    sell → buy, 4 = strong_sell → strong_buy). The frontend renders
    ``summary`` directly so the wire payload never needs to invent prose
    around the numbers.
    """

    model_config = ConfigDict(frozen=True)

    kind: AlertRuleKind
    field: AlertDeltaField
    from_value: str
    to_value: str
    magnitude: float
    summary: str


class AlertEvent(BaseModel):
    """Persisted event record. ``triggering_posture`` is the full typed
    envelope at fire time so the bell/dropdown can render the same
    grounding the operator would have seen if they had been watching."""

    model_config = ConfigDict(frozen=False)

    id: str
    rule_id: str
    rule_name: str
    fired_at: datetime
    triggering_posture: MarketPosture
    delta: AlertDelta


__all__ = [
    "AlertDelta",
    "AlertDeltaField",
    "AlertEvent",
    "AlertRule",
    "AlertRuleCreate",
    "AlertRuleKind",
    "DEFAULT_CONFIDENCE_THRESHOLD",
    "DEFAULT_COOLDOWN_SECONDS",
]
