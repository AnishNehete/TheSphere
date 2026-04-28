"""Fixture tests for the pure technical engine (Phase 13B.2).

Every indicator is exercised against deterministic synthetic candles so
the engine can be reproduced in replay mode without network access. No
``httpx`` / ``asyncio`` is imported — the engine is pure math.
"""

from __future__ import annotations

import math
from datetime import datetime, timedelta, timezone

import pytest

from app.intelligence.portfolio.market_data.base import Candle
from app.intelligence.portfolio.technical.engine import (
    build_snapshot,
    realized_vol_annualized,
    rsi_wilder,
    sma,
)
from app.intelligence.portfolio.technical.schemas import TechnicalSnapshot


# ----------------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------------


def _candles_from_closes(
    closes: list[float], *, start: datetime | None = None
) -> list[Candle]:
    """Wrap a close series into Candle objects with daily timestamps."""

    origin = start or datetime(2026, 1, 1, tzinfo=timezone.utc)
    out: list[Candle] = []
    for i, close in enumerate(closes):
        ts = origin + timedelta(days=i)
        out.append(
            Candle(
                timestamp=ts,
                open=close,
                high=close * 1.01,
                low=close * 0.99,
                close=close,
                volume=1_000_000.0,
            )
        )
    return out


# ----------------------------------------------------------------------------
# SMA
# ----------------------------------------------------------------------------


class TestSMA:
    def test_partial_window_returns_none(self) -> None:
        assert sma([1.0, 2.0], 3) == [None, None]

    def test_full_window_matches_expected(self) -> None:
        result = sma([1.0, 2.0, 3.0, 4.0, 5.0], 3)
        assert result == [None, None, 2.0, 3.0, 4.0]

    def test_monotonic_series_produces_monotonic_sma(self) -> None:
        values = [float(i) for i in range(1, 21)]
        out = sma(values, 5)
        non_null = [v for v in out if v is not None]
        assert non_null == sorted(non_null)
        assert len(non_null) == 16

    def test_zero_window_returns_all_none(self) -> None:
        assert sma([1.0, 2.0, 3.0], 0) == [None, None, None]

    def test_empty_values_returns_empty(self) -> None:
        assert sma([], 3) == []


# ----------------------------------------------------------------------------
# Wilder RSI
# ----------------------------------------------------------------------------


class TestRsiWilder:
    def test_all_gains_returns_100(self) -> None:
        closes = [float(i) for i in range(1, 21)]
        out = rsi_wilder(closes, 14)
        assert out[-1] == 100.0

    def test_all_losses_returns_0(self) -> None:
        closes = [float(i) for i in range(20, 0, -1)]
        out = rsi_wilder(closes, 14)
        assert out[-1] == 0.0

    def test_flat_prices_returns_none_after_period(self) -> None:
        closes = [100.0] * 20
        out = rsi_wilder(closes, 14)
        assert out[-1] is None

    def test_insufficient_history_is_all_none(self) -> None:
        closes = [1.0, 2.0, 3.0, 4.0, 5.0]
        out = rsi_wilder(closes, 14)
        assert all(v is None for v in out)

    def test_first_valid_index_is_at_period(self) -> None:
        # With 20 closes (indices 0..19) and period=14, the seed average
        # consumes indices 0..14 so the first non-None RSI lands at index
        # 14 and indices 0..13 are None.
        closes = [float(i) for i in range(1, 21)]
        out = rsi_wilder(closes, 14)
        assert out[14] is not None
        assert all(v is None for v in out[:14])

    def test_known_fixture_matches_expected_range(self) -> None:
        # Wilder 1978 reference-style fixture: alternating mix of gains/
        # losses. The exact Wilder value over the trailing 14 periods
        # should settle in a credible RSI range — not whipsawed.
        closes = [
            44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42,
            45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28, 46.00,
            46.03, 46.41, 46.22, 45.64, 46.21,
        ]
        out = rsi_wilder(closes, 14)
        last = out[-1]
        assert last is not None
        assert 40.0 <= last <= 90.0


# ----------------------------------------------------------------------------
# Realized vol
# ----------------------------------------------------------------------------


class TestRealizedVol:
    def test_flat_prices_produces_zero_vol(self) -> None:
        out = realized_vol_annualized([100.0] * 60, 30)
        assert out[-1] == pytest.approx(0.0)

    def test_insufficient_history_is_none(self) -> None:
        out = realized_vol_annualized([100.0] * 10, 30)
        assert out[-1] is None

    def test_vol_is_positive_for_noisy_series(self) -> None:
        closes: list[float] = [100.0]
        for i in range(60):
            factor = 1.01 if i % 2 == 0 else 0.99
            closes.append(closes[-1] * factor)
        out = realized_vol_annualized(closes, 30)
        last = out[-1]
        assert last is not None
        assert last > 0.0

    def test_annualization_factor_applied(self) -> None:
        closes: list[float] = [100.0]
        for i in range(60):
            factor = 1.01 if i % 2 == 0 else 0.99
            closes.append(closes[-1] * factor)
        out = realized_vol_annualized(closes, 30)
        last = out[-1]
        # Build the same stdev by hand and verify the sqrt(252) scaling.
        import statistics as _stats

        log_returns: list[float] = []
        for i in range(1, len(closes)):
            log_returns.append(math.log(closes[i] / closes[i - 1]))
        expected = _stats.pstdev(log_returns[-30:]) * math.sqrt(252)
        assert last == pytest.approx(expected, abs=1e-9)


# ----------------------------------------------------------------------------
# build_snapshot — integration with schemas
# ----------------------------------------------------------------------------


class TestBuildSnapshot:
    def test_empty_candles_returns_safe_snapshot(self) -> None:
        now = datetime(2026, 4, 1, tzinfo=timezone.utc)
        snap = build_snapshot([], symbol="X", as_of=now)
        assert isinstance(snap, TechnicalSnapshot)
        assert snap.last_close is None
        assert snap.sma20 is None
        assert snap.sma50 is None
        assert snap.sma200 is None
        assert snap.rsi14 is None
        assert snap.realized_vol_30d is None
        assert snap.trend_regime == "insufficient_data"
        assert snap.technical_signal_level == "balanced"
        assert any("No candle history" in n for n in snap.technical_notes)

    def test_insufficient_history_flags_missing_indicators(self) -> None:
        closes = [100.0 + i * 0.1 for i in range(45)]
        candles = _candles_from_closes(closes)
        snap = build_snapshot(
            candles,
            symbol="SHORT",
            as_of=datetime(2026, 4, 1, tzinfo=timezone.utc),
        )
        assert snap.sma20 is not None
        assert snap.sma50 is None
        assert snap.sma200 is None
        assert any("SMA200 unavailable" in n for n in snap.technical_notes)
        assert any("SMA50 unavailable" in n for n in snap.technical_notes)

    def test_full_history_produces_complete_snapshot(self) -> None:
        # Gently oscillating series with 260 closes -> all indicators ready.
        closes = [
            100.0 + 5.0 * math.sin(i * 0.1) + i * 0.05 for i in range(260)
        ]
        candles = _candles_from_closes(closes)
        snap = build_snapshot(
            candles,
            symbol="LONG",
            as_of=datetime(2026, 4, 1, tzinfo=timezone.utc),
        )
        assert snap.sma20 is not None
        assert snap.sma50 is not None
        assert snap.sma200 is not None
        assert snap.rsi14 is not None
        assert snap.realized_vol_30d is not None
        assert snap.trend_regime != "insufficient_data"
        assert snap.technical_score is not None
        assert 0.0 <= snap.technical_score <= 1.0

    def test_stretched_long_classification(self) -> None:
        # 200 low closes to establish SMA200 well below last close, then 20
        # sharply rising closes to push RSI14 above 80.
        base = [50.0] * 200
        ramp = [50.0 + (i + 1) * 4.0 for i in range(30)]  # steep rise
        candles = _candles_from_closes(base + ramp)
        snap = build_snapshot(
            candles,
            symbol="RIP",
            as_of=datetime(2026, 4, 1, tzinfo=timezone.utc),
        )
        assert snap.sma200 is not None
        assert snap.rsi14 is not None
        # Either RSI > 80 or (price_vs_sma200 > 0.12 and RSI > 70)
        assert snap.technical_signal_level == "stretched_long"

    def test_stretched_short_classification(self) -> None:
        base = [200.0] * 200
        drop = [200.0 - (i + 1) * 4.0 for i in range(30)]
        candles = _candles_from_closes(base + drop)
        snap = build_snapshot(
            candles,
            symbol="DROP",
            as_of=datetime(2026, 4, 1, tzinfo=timezone.utc),
        )
        assert snap.sma200 is not None
        assert snap.rsi14 is not None
        assert snap.technical_signal_level == "stretched_short"

    def test_balanced_when_rsi_inside_band(self) -> None:
        # Gentle oscillation around a stable mean — RSI should land in the
        # balanced zone and price ~ SMA200.
        closes = [100.0 + 0.5 * math.sin(i * 0.3) for i in range(260)]
        candles = _candles_from_closes(closes)
        snap = build_snapshot(
            candles,
            symbol="STABLE",
            as_of=datetime(2026, 4, 1, tzinfo=timezone.utc),
        )
        assert snap.technical_signal_level == "balanced"

    def test_recovering_regime_on_golden_cross(self) -> None:
        # 220 descending closes followed by 40 ascending closes to create a
        # recent SMA50 golden cross through SMA200.
        down = [200.0 - i * 0.4 for i in range(220)]
        up = [down[-1] + (i + 1) * 3.0 for i in range(60)]
        candles = _candles_from_closes(down + up)
        snap = build_snapshot(
            candles,
            symbol="RECOV",
            as_of=datetime(2026, 4, 1, tzinfo=timezone.utc),
        )
        assert snap.sma50 is not None
        assert snap.sma200 is not None
        # Either "recovering" (recent cross) or already "above_200" once cross
        # aged out; for the golden-cross fixture expect recovering.
        assert snap.trend_regime in {"recovering", "above_200"}

    def test_breaking_down_regime_on_death_cross(self) -> None:
        up = [100.0 + i * 0.4 for i in range(220)]
        down = [up[-1] - (i + 1) * 3.0 for i in range(60)]
        candles = _candles_from_closes(up + down)
        snap = build_snapshot(
            candles,
            symbol="DEATH",
            as_of=datetime(2026, 4, 1, tzinfo=timezone.utc),
        )
        assert snap.sma50 is not None
        assert snap.sma200 is not None
        assert snap.trend_regime in {"breaking_down", "below_200"}

    def test_snapshot_as_of_from_last_candle(self) -> None:
        closes = [100.0 + i * 0.1 for i in range(260)]
        start = datetime(2024, 1, 1, tzinfo=timezone.utc)
        candles = _candles_from_closes(closes, start=start)
        snap = build_snapshot(
            candles,
            symbol="ASOF",
            as_of=datetime(2099, 1, 1, tzinfo=timezone.utc),
        )
        assert snap.as_of == candles[-1].timestamp
