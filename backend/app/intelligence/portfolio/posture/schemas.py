"""Frozen pydantic shapes for the market-symbol posture engine.

Honest-language rules (MEMORY.md / D-39):

* posture is a *bounded* literal — no free-form recommendation strings
* every emitted ``MarketPosture`` includes drivers, confidence, and
  caveats; a posture without grounded explanation is not allowed
* every numeric is bounded; the LLM in 17A.2/17A.3 may synthesize prose
  around these numbers but must not invent the numbers themselves
"""

from __future__ import annotations

from datetime import datetime
from typing import TYPE_CHECKING, Literal

from pydantic import BaseModel, ConfigDict, Field


PostureLabel = Literal["strong_sell", "sell", "neutral", "buy", "strong_buy"]
AssetClass = Literal["equities", "fx", "commodities", "futures", "unknown"]
ProviderHealth = Literal["live", "degraded", "unsupported", "unconfigured"]

if TYPE_CHECKING:  # pragma: no cover
    from app.intelligence.portfolio.posture.symbol_semantic import (
        SymbolSemanticPressure,
    )


class PostureComponents(BaseModel):
    """Sub-score breakdown for a posture call.

    Each numeric sub-score lives in ``[-1, 1]`` (signed: positive bullish,
    negative bearish, ``None`` when insufficient data). ``uncertainty``
    sits in ``[0, 1]`` where 1.0 means "no idea" — confidence is
    ``1.0 - uncertainty``.
    """

    model_config = ConfigDict(frozen=True)

    technical: float | None = Field(default=None, ge=-1.0, le=1.0)
    semantic: float | None = Field(default=None, ge=-1.0, le=1.0)
    macro: float | None = Field(default=None, ge=-1.0, le=1.0)
    uncertainty: float = Field(default=1.0, ge=0.0, le=1.0)


class PostureDriver(BaseModel):
    """One ranked driver behind the final posture.

    ``signed_contribution`` is the (sub-score × weight) contribution to
    the final tilt — positive = bullish push, negative = bearish push,
    zero = neutral / no-op. Drivers with zero contribution are dropped
    so the UI never shows pointless rows.
    """

    model_config = ConfigDict(frozen=True)

    component: Literal["technical", "semantic", "macro"]
    label: str
    signed_contribution: float = Field(ge=-1.0, le=1.0)
    rationale: str
    evidence_ids: list[str] = Field(default_factory=list)


class MarketPosture(BaseModel):
    """Final symbol-level posture record — the typed contract for 17A.2/3.

    ``tilt`` is the raw weighted sum in ``[-1, 1]`` *before* the
    confidence damping. ``effective_tilt`` is ``tilt × confidence`` and
    is the value used to pick the posture band. Both are surfaced so the
    agent layer can reason about "raw signal vs damped call".

    Phase 17A.2 additions:
    * ``provider`` and ``provider_health`` — which provider produced the
      market data, and whether it was live / degraded / unsupported /
      unconfigured. Honest degradation is in the typed contract.
    * ``semantic_pressure`` — symbol-level semantic event pressure with
      direction, confidence, top drivers, and its own caveats. Loaded
      lazily as a forward-ref so the schemas module itself stays
      side-effect-free.
    """

    model_config = ConfigDict(frozen=True)

    symbol: str
    asset_class: AssetClass = "unknown"

    posture: PostureLabel
    posture_label: str  # human-readable: "Strong Buy", etc.

    tilt: float = Field(ge=-1.0, le=1.0)
    effective_tilt: float = Field(ge=-1.0, le=1.0)
    confidence: float = Field(ge=0.0, le=1.0)

    components: PostureComponents
    drivers: list[PostureDriver] = Field(default_factory=list)
    caveats: list[str] = Field(default_factory=list)

    freshness_seconds: int | None = None
    as_of: datetime
    notes: list[str] = Field(default_factory=list)

    # Phase 17A.2 grounding metadata
    provider: str = "unconfigured"
    provider_health: ProviderHealth = "unconfigured"
    semantic_pressure: "SymbolSemanticPressure | None" = None


__all__ = [
    "AssetClass",
    "MarketPosture",
    "PostureComponents",
    "PostureDriver",
    "PostureLabel",
    "ProviderHealth",
]
