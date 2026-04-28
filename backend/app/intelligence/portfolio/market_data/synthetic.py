"""Deterministic offline MarketDataProvider.

Used for tests and offline dev so the rest of the system can run without
network access. Generates a repeatable sine-wave price + OHLCV series
seeded by ``hash(symbol)``.
"""

from __future__ import annotations

import builtins
import math
from datetime import datetime, timedelta, timezone
from typing import Callable, Sequence

from app.intelligence.portfolio.market_data.base import (
    Candle,
    CandleRange,
    PriceSnapshot,
)


_SYNTHETIC_SEED = 0xC0FFEE
_CANDLES_PER_RANGE: dict[CandleRange, int] = {
    "1d": 78,  # 78 x 5m candles = ~6.5h
    "5d": 40,
    "1mo": 22,
    "3mo": 66,
    "6mo": 132,
    "1y": 260,
    "2y": 520,
    "5y": 1300,
}


def _symbol_seed(symbol: str) -> int:
    # Python's hash() is randomized by PYTHONHASHSEED; we want stable.
    total = _SYNTHETIC_SEED
    for ch in symbol.upper():
        total = (total * 131 + ord(ch)) & 0xFFFFFFFF
    return total


def _base_price(symbol: str) -> float:
    seed = _symbol_seed(symbol)
    # 50..300 range, deterministic per symbol
    return 50.0 + (seed % 25000) / 100.0


class SyntheticMarketDataProvider:
    """Deterministic, network-free MarketDataProvider implementation."""

    provider_id = "synthetic"

    def __init__(
        self,
        *,
        stale_threshold_seconds: int = 900,
        now_fn: Callable[[], datetime] | None = None,
    ) -> None:
        self._stale_threshold = stale_threshold_seconds
        self._now_fn = now_fn or (lambda: datetime.now(timezone.utc))

    async def get_price_snapshot(
        self, symbol: str, *, as_of: datetime | None = None
    ) -> PriceSnapshot:
        now = as_of or self._now_fn()
        base = _base_price(symbol)
        # Deterministic oscillation keyed to day-of-year + symbol seed.
        phase = (now.timetuple().tm_yday + _symbol_seed(symbol) % 37) * 0.1
        price = round(base * (1.0 + 0.05 * math.sin(phase)), 4)
        previous_close = round(base * (1.0 + 0.05 * math.sin(phase - 0.1)), 4)
        age = (self._now_fn() - now).total_seconds() if as_of else 0.0
        return PriceSnapshot(
            symbol=symbol,
            price=price,
            previous_close=previous_close,
            as_of=now,
            currency="USD",
            provider=self.provider_id,
            is_stale=age > self._stale_threshold,
            staleness_seconds=max(0.0, age),
        )

    async def get_previous_close(
        self, symbol: str, *, as_of: datetime | None = None
    ) -> float | None:
        snapshot = await self.get_price_snapshot(symbol, as_of=as_of)
        return snapshot.previous_close

    async def get_snapshots(
        self, symbols: Sequence[str], *, as_of: datetime | None = None
    ) -> dict[str, PriceSnapshot]:
        return {s: await self.get_price_snapshot(s, as_of=as_of) for s in symbols}

    async def get_candles(
        self,
        symbol: str,
        *,
        range: CandleRange = "1y",  # noqa: A002 - Protocol requires this name
        as_of: datetime | None = None,
    ) -> list[Candle]:
        end = as_of or self._now_fn()
        candle_range: CandleRange = range
        count = _CANDLES_PER_RANGE.get(candle_range, 260)
        base = _base_price(symbol)
        seed = _symbol_seed(symbol)
        step = timedelta(days=1) if candle_range != "1d" else timedelta(minutes=5)

        candles: list[Candle] = []
        for i in builtins.range(count):
            ts = end - step * (count - 1 - i)
            wave = math.sin((i + seed % 17) * 0.15) * 0.03
            close = round(base * (1.0 + wave), 4)
            open_ = round(base * (1.0 + math.sin((i - 1 + seed % 17) * 0.15) * 0.03), 4)
            high = round(max(open_, close) * 1.01, 4)
            low = round(min(open_, close) * 0.99, 4)
            candles.append(
                Candle(
                    timestamp=ts,
                    open=open_,
                    high=high,
                    low=low,
                    close=close,
                    volume=1_000_000.0 + (i * 1000),
                )
            )

        if as_of is not None:
            candles = [c for c in candles if c.timestamp <= as_of]
        return candles

    async def aclose(self) -> None:
        return None


__all__ = ["SyntheticMarketDataProvider"]
