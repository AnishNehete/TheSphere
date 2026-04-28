"""Pydantic shapes for the Phase 13B.2 technical engine.

Bounded enums (D-16 / D-17 from 13b-CONTEXT.md):
  - ``technical_signal_level``: stretched_long | balanced | stretched_short
    (never buy / sell — honest-language rule from MEMORY.md)
  - ``trend_regime``: above_200 | below_200 | recovering | breaking_down |
    insufficient_data

Forward-compatible fields for Phase 13C bullish/bearish tilt foundation
(``bullish_tilt_score``, ``bearish_tilt_score``, ``uncertainty_score``,
``signal_alignment``) default to ``None`` so adding a later tilt module
does not break the wire contract.
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


TechnicalSignalLevel = Literal["stretched_long", "balanced", "stretched_short"]
TrendRegime = Literal[
    "above_200",
    "below_200",
    "recovering",
    "breaking_down",
    # Phase 19E.4 — SMA50 fallback regimes. Emitted when the candle
    # history is too short for a 200d SMA (free-tier Alpha Vantage caps
    # daily candles at 100) but long enough for a 50d SMA. Treated as a
    # damped signal by the posture engine so the operator still sees a
    # real read instead of "insufficient data" everywhere.
    "above_50",
    "below_50",
    "insufficient_data",
]


class TechnicalSnapshot(BaseModel):
    """Per-holding technical snapshot — output of ``build_snapshot``.

    Any indicator that lacks sufficient history is ``None`` and the reason
    is recorded in ``technical_notes``. Callers MUST surface ``None`` as
    "unavailable" in UI copy — never fabricate a number.
    """

    model_config = ConfigDict(frozen=True)

    symbol: str
    as_of: datetime
    currency: str = "USD"
    last_close: float | None = None

    sma20: float | None = None
    sma50: float | None = None
    sma200: float | None = None
    price_vs_sma20: float | None = None
    price_vs_sma50: float | None = None
    price_vs_sma200: float | None = None

    rsi14: float | None = None
    realized_vol_30d: float | None = None

    trend_regime: TrendRegime = "insufficient_data"
    technical_signal_level: TechnicalSignalLevel = "balanced"
    technical_score: float | None = Field(default=None, ge=0.0, le=1.0)

    technical_notes: list[str] = Field(default_factory=list)

    # Phase 13C tilt-foundation reservation — None defaults keep 13B wire
    # contract stable; a later slice populates them when signals align.
    bullish_tilt_score: float | None = None
    bearish_tilt_score: float | None = None
    uncertainty_score: float | None = None
    signal_alignment: (
        Literal["aligned", "mixed", "conflicting", "insufficient"] | None
    ) = None


__all__ = [
    "TechnicalSnapshot",
    "TechnicalSignalLevel",
    "TrendRegime",
]
