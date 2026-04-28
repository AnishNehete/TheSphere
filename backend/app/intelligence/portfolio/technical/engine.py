"""Pure technical engine for Phase 13B.

Exactly 5 indicators: SMA20, SMA50, SMA200, Wilder RSI14, 30d annualized
log-return volatility. No I/O, no providers, no async. Given a list of
``Candle``, returns a ``TechnicalSnapshot``.

Thresholds for ``technical_signal_level`` (D-16 in 13b-CONTEXT.md):
    stretched_long  : (price_vs_sma200 > 0.12 AND rsi14 > 70) OR rsi14 > 80
    stretched_short : (price_vs_sma200 < -0.12 AND rsi14 < 30) OR rsi14 < 20
    balanced        : otherwise (including any-indicator-missing case)

Rationale: combining a trend-stretch term (price vs 200d SMA) with an RSI
overbought/oversold band avoids single-indicator whipsaw. This is NOT a
buy/sell call — it is a stretch state, per honest-language rules
(MEMORY.md).

``trend_regime`` uses the 50/200 SMA relationship plus a lookback window
(D-17) — recent crosses produce "recovering" / "breaking_down".

The engine is pure so Phase 13B.6 replay can reuse the same function
against any historical candle slice.
"""

from __future__ import annotations

import math
import statistics
from datetime import datetime
from typing import Sequence

from app.intelligence.portfolio.market_data.base import Candle
from app.intelligence.portfolio.technical.schemas import (
    TechnicalSignalLevel,
    TechnicalSnapshot,
    TrendRegime,
)


TRADING_DAYS_PER_YEAR = 252
STRETCH_THRESHOLD = 0.12
RSI_OVERBOUGHT = 70.0
RSI_EXTREME_OVERBOUGHT = 80.0
RSI_OVERSOLD = 30.0
RSI_EXTREME_OVERSOLD = 20.0
REGIME_CROSS_LOOKBACK = 10


def sma(values: Sequence[float], window: int) -> list[float | None]:
    """Simple moving average.

    Returns a list the same length as ``values``. The first
    ``window - 1`` entries are ``None`` (partial windows are not
    fabricated).
    """

    out: list[float | None] = [None] * len(values)
    if window <= 0 or len(values) < window:
        return out
    running = float(sum(values[:window]))
    out[window - 1] = running / window
    for i in range(window, len(values)):
        running += values[i] - values[i - window]
        out[i] = running / window
    return out


def rsi_wilder(closes: Sequence[float], period: int = 14) -> list[float | None]:
    """Wilder-smoothed RSI (J. Welles Wilder, New Concepts, 1978).

    First ``period`` entries are ``None`` (insufficient history).

    Edge cases:
      * ``avg_gain == 0`` AND ``avg_loss == 0`` (flat prices) -> ``None``
      * ``avg_loss == 0`` AND ``avg_gain > 0`` -> ``100.0``
      * ``avg_gain == 0`` AND ``avg_loss > 0`` -> ``0.0``
    """

    out: list[float | None] = [None] * len(closes)
    if len(closes) <= period:
        return out

    gains: list[float] = []
    losses: list[float] = []
    for i in range(1, period + 1):
        delta = closes[i] - closes[i - 1]
        gains.append(max(delta, 0.0))
        losses.append(max(-delta, 0.0))
    avg_gain = sum(gains) / period
    avg_loss = sum(losses) / period
    out[period] = _rsi_from(avg_gain, avg_loss)

    for i in range(period + 1, len(closes)):
        delta = closes[i] - closes[i - 1]
        gain = max(delta, 0.0)
        loss = max(-delta, 0.0)
        avg_gain = ((avg_gain * (period - 1)) + gain) / period
        avg_loss = ((avg_loss * (period - 1)) + loss) / period
        out[i] = _rsi_from(avg_gain, avg_loss)

    return out


def _rsi_from(avg_gain: float, avg_loss: float) -> float | None:
    if avg_gain == 0 and avg_loss == 0:
        return None
    if avg_loss == 0:
        return 100.0
    if avg_gain == 0:
        return 0.0
    rs = avg_gain / avg_loss
    return 100.0 - (100.0 / (1.0 + rs))


def realized_vol_annualized(
    closes: Sequence[float], window: int = 30
) -> list[float | None]:
    """Annualized rolling log-return stdev (population stdev * sqrt(252)).

    The first ``window`` entries of the output are ``None``. Requires at
    least ``window + 1`` closes to produce any value (need ``window``
    log-returns).

    Negative or zero prices in the series yield a 0.0 log-return for that
    step — the engine does not raise on bad data, it surfaces stability.
    """

    out: list[float | None] = [None] * len(closes)
    if len(closes) < window + 1:
        return out

    log_returns: list[float] = []
    for i in range(1, len(closes)):
        if closes[i - 1] <= 0 or closes[i] <= 0:
            log_returns.append(0.0)
        else:
            log_returns.append(math.log(closes[i] / closes[i - 1]))

    sqrt_year = math.sqrt(TRADING_DAYS_PER_YEAR)
    # Align: vol[i] covers log_returns[i-window : i], so it maps to closes[i].
    for i in range(window, len(log_returns) + 1):
        window_slice = log_returns[i - window : i]
        vol = statistics.pstdev(window_slice) * sqrt_year
        out[i] = vol
    return out


def build_snapshot(
    candles: list[Candle],
    *,
    symbol: str,
    as_of: datetime,
    currency: str = "USD",
) -> TechnicalSnapshot:
    """Compose all 5 indicators into a ``TechnicalSnapshot``.

    When ``candles`` is empty, returns a safe snapshot with every
    indicator ``None`` and an honest note. When an individual indicator
    lacks history, that field is ``None`` and a note records which
    indicator was skipped.
    """

    notes: list[str] = []
    if not candles:
        notes.append("No candle history available.")
        return TechnicalSnapshot(
            symbol=symbol,
            as_of=as_of,
            currency=currency,
            technical_notes=notes,
        )

    closes = [c.close for c in candles]
    sma20_series = sma(closes, 20)
    sma50_series = sma(closes, 50)
    sma200_series = sma(closes, 200)
    rsi_series = rsi_wilder(closes, 14)
    vol_series = realized_vol_annualized(closes, 30)

    last_close = closes[-1]
    sma20_v = sma20_series[-1]
    sma50_v = sma50_series[-1]
    sma200_v = sma200_series[-1]
    rsi_v = rsi_series[-1]
    vol_v = vol_series[-1]

    history_len = len(closes)
    if sma20_v is None:
        notes.append(f"SMA20 unavailable — {history_len}d history")
    if sma50_v is None:
        notes.append(f"SMA50 unavailable — {history_len}d history")
    if sma200_v is None:
        notes.append(f"SMA200 unavailable — {history_len}d history")
    if rsi_v is None and history_len > 14:
        notes.append("RSI14 unavailable — flat price history")
    elif rsi_v is None:
        notes.append(f"RSI14 unavailable — {history_len}d history")
    if vol_v is None:
        notes.append(f"Realized vol 30d unavailable — {history_len}d history")

    price_vs_sma20 = _ratio(last_close, sma20_v)
    price_vs_sma50 = _ratio(last_close, sma50_v)
    price_vs_sma200 = _ratio(last_close, sma200_v)

    level: TechnicalSignalLevel = _classify_level(rsi_v, price_vs_sma200)
    regime: TrendRegime = _classify_regime(closes, sma50_series, sma200_series)

    tech_score: float | None = None
    if price_vs_sma200 is not None:
        sign = 1.0 if price_vs_sma200 >= 0 else -1.0
        tech_score = max(
            0.0,
            min(1.0, 0.5 + 0.5 * sign * min(1.0, abs(price_vs_sma200) * 3)),
        )
    elif price_vs_sma50 is not None:
        # Phase 19E.4 — SMA50 fallback. Free-tier Alpha Vantage returns
        # 100 daily candles, so SMA200 is unavailable for most symbols.
        # Rather than silently emitting None (which dropped Technical
        # AND Macro to "—" on the panel), score from price-vs-SMA50 with
        # 0.7× damping toward neutral (0.5) — honest about lower
        # confidence on a shorter trend signal.
        sign = 1.0 if price_vs_sma50 >= 0 else -1.0
        raw = 0.5 + 0.5 * sign * min(1.0, abs(price_vs_sma50) * 3)
        tech_score = max(0.0, min(1.0, 0.5 + (raw - 0.5) * 0.7))
        notes.append(
            "Technical score derived from SMA50 (200d history insufficient)."
        )

    snap = TechnicalSnapshot(
        symbol=symbol,
        as_of=candles[-1].timestamp,
        currency=currency,
        last_close=last_close,
        sma20=sma20_v,
        sma50=sma50_v,
        sma200=sma200_v,
        price_vs_sma20=price_vs_sma20,
        price_vs_sma50=price_vs_sma50,
        price_vs_sma200=price_vs_sma200,
        rsi14=rsi_v,
        realized_vol_30d=vol_v,
        trend_regime=regime,
        technical_signal_level=level,
        technical_score=tech_score,
        technical_notes=notes,
    )
    return populate_tilt_for_technical(snap)


# Tilt discipline: we report bullish_tilt / bearish_tilt / uncertainty ONLY.
# We NEVER emit buy / sell / recommendation / target price language — see D-39.

def populate_tilt_for_technical(snapshot: TechnicalSnapshot) -> TechnicalSnapshot:
    """Populate tilt fields on a TechnicalSnapshot from existing indicator values.

    Uses price_vs_sma200 and rsi14 to derive bullish/bearish/uncertainty scores.
    Returns a new frozen snapshot — never mutates the input.
    """
    price_vs_200 = snapshot.price_vs_sma200
    rsi = snapshot.rsi14

    # Phase 19E.4 — fall back to SMA50 when SMA200 history is short.
    # The fallback is damped (0.7×) so the tilt amplitudes stay honest
    # about lower-confidence trend signal.
    fallback_active = False
    if snapshot.last_close is None or price_vs_200 is None:
        if snapshot.sma50 is not None and snapshot.price_vs_sma50 is not None:
            price_vs_200 = snapshot.price_vs_sma50
            fallback_active = True
        else:
            return snapshot.model_copy(
                update={
                    "bullish_tilt_score": None,
                    "bearish_tilt_score": None,
                    "uncertainty_score": None,
                    "signal_alignment": "insufficient",
                }
            )

    # Base components from price vs SMA200 (or SMA50 fallback).
    if price_vs_200 >= 0:
        bull_base = min(1.0, max(0.0, (price_vs_200 + 0.2) / 0.4))
        bear_base = 0.0
    else:
        bull_base = 0.0
        bear_base = min(1.0, max(0.0, (-price_vs_200 + 0.2) / 0.4))

    if fallback_active:
        bull_base *= 0.7
        bear_base *= 0.7

    # RSI band boost.
    rsi_bull_boost = 0.0
    rsi_bear_boost = 0.0
    if rsi is not None:
        if rsi > 70:
            rsi_bull_boost = 0.2
        elif rsi < 30:
            rsi_bear_boost = 0.2

    bull = min(1.0, bull_base + rsi_bull_boost)
    bear = min(1.0, bear_base + rsi_bear_boost)

    uncertainty = round(1.0 - abs(bull - bear), 3)
    diff = abs(bull - bear)

    if diff > 0.4:
        alignment: str = "aligned"
    elif diff > 0.2:
        alignment = "mixed"
    elif max(bull, bear) > 0.3:
        alignment = "conflicting"
    else:
        alignment = "insufficient"

    return snapshot.model_copy(
        update={
            "bullish_tilt_score": round(bull, 3),
            "bearish_tilt_score": round(bear, 3),
            "uncertainty_score": uncertainty,
            "signal_alignment": alignment,
        }
    )


def _ratio(last_close: float, value: float | None) -> float | None:
    if value is None or value == 0:
        return None
    return (last_close - value) / value


def _classify_level(
    rsi: float | None, price_vs_sma200: float | None
) -> TechnicalSignalLevel:
    if rsi is None:
        return "balanced"
    if rsi > RSI_EXTREME_OVERBOUGHT:
        return "stretched_long"
    if rsi < RSI_EXTREME_OVERSOLD:
        return "stretched_short"
    if price_vs_sma200 is None:
        return "balanced"
    if price_vs_sma200 > STRETCH_THRESHOLD and rsi > RSI_OVERBOUGHT:
        return "stretched_long"
    if price_vs_sma200 < -STRETCH_THRESHOLD and rsi < RSI_OVERSOLD:
        return "stretched_short"
    return "balanced"


def _classify_regime(
    closes: Sequence[float],
    sma50_series: Sequence[float | None],
    sma200_series: Sequence[float | None],
) -> TrendRegime:
    sma50_v = sma50_series[-1]
    sma200_v = sma200_series[-1]
    last_close = closes[-1]
    if sma200_v is None and sma50_v is not None:
        # Phase 19E.4 — SMA50 fallback regime. Without 200d history we
        # cannot diagnose recovering/breaking_down (those rely on a
        # 50/200 cross), so we report position vs the available 50d
        # trendline instead. Posture/macro engines treat these as
        # damped signals.
        return "above_50" if last_close > sma50_v else "below_50"
    if sma200_v is None or sma50_v is None:
        return "insufficient_data"

    # Look back for a recent 50/200 cross within REGIME_CROSS_LOOKBACK bars.
    max_lag = min(REGIME_CROSS_LOOKBACK, len(sma50_series) - 1)
    for lag in range(1, max_lag + 1):
        prev_50 = sma50_series[-1 - lag]
        prev_200 = sma200_series[-1 - lag]
        if prev_50 is None or prev_200 is None:
            continue
        if prev_50 <= prev_200 and sma50_v > sma200_v:
            return "recovering"
        if prev_50 >= prev_200 and sma50_v < sma200_v:
            return "breaking_down"

    if last_close > sma200_v and sma50_v >= sma200_v:
        return "above_200"
    if last_close < sma200_v and sma50_v <= sma200_v:
        return "below_200"
    return "insufficient_data"


__all__ = [
    "REGIME_CROSS_LOOKBACK",
    "RSI_EXTREME_OVERBOUGHT",
    "RSI_EXTREME_OVERSOLD",
    "RSI_OVERBOUGHT",
    "RSI_OVERSOLD",
    "STRETCH_THRESHOLD",
    "TRADING_DAYS_PER_YEAR",
    "build_snapshot",
    "populate_tilt_for_technical",
    "realized_vol_annualized",
    "rsi_wilder",
    "sma",
]
