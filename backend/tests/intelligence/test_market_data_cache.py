"""Phase 17A.2 — TTL cache wrapper for the market-data provider.

Verifies:
* Snapshots and candles are cached per-symbol/per-range.
* Cached payloads are byte-equal to the underlying provider's response.
* TTL expiry triggers a fresh upstream call.
* ``as_of`` requests bypass the cache.
* Empty candle payloads are NOT cached (so a throttle window can heal
  on the very next request rather than persisting for ``candle_ttl``).
"""

from __future__ import annotations

from datetime import datetime, timezone

import pytest

from app.intelligence.portfolio.market_data.base import (
    Candle,
    CandleRange,
    PriceSnapshot,
)
from app.intelligence.portfolio.market_data.cache import CachedMarketDataProvider


class _RecordingProvider:
    provider_id = "fake"

    def __init__(self, *, candles: list[Candle] | None = None) -> None:
        self.snapshot_calls = 0
        self.candle_calls = 0
        self._candles = candles or []
        self._next_price = 100.0

    async def get_price_snapshot(
        self, symbol: str, *, as_of: datetime | None = None
    ) -> PriceSnapshot:
        self.snapshot_calls += 1
        price = self._next_price
        self._next_price += 1.0
        return PriceSnapshot(
            symbol=symbol.upper(),
            price=price,
            previous_close=None,
            as_of=as_of or datetime.now(timezone.utc),
            currency="USD",
            provider=self.provider_id,
            is_stale=False,
            staleness_seconds=0.0,
        )

    async def get_previous_close(
        self, symbol: str, *, as_of: datetime | None = None
    ) -> float | None:
        snap = await self.get_price_snapshot(symbol, as_of=as_of)
        return snap.previous_close

    async def get_snapshots(self, symbols, *, as_of=None):  # type: ignore[override]
        return {s: await self.get_price_snapshot(s, as_of=as_of) for s in symbols}

    async def get_candles(
        self,
        symbol: str,
        *,
        range: CandleRange = "1y",
        as_of: datetime | None = None,
    ) -> list[Candle]:
        self.candle_calls += 1
        return list(self._candles)

    async def aclose(self) -> None:
        return None


def _candle(value: float) -> Candle:
    ts = datetime(2026, 4, 1, tzinfo=timezone.utc)
    return Candle(timestamp=ts, open=value, high=value, low=value, close=value)


@pytest.mark.asyncio
async def test_snapshot_cache_within_ttl_serves_same_payload() -> None:
    inner = _RecordingProvider()
    clock = [0.0]
    cache = CachedMarketDataProvider(
        inner, snapshot_ttl_seconds=30, clock=lambda: clock[0]
    )
    first = await cache.get_price_snapshot("AAPL")
    clock[0] += 5
    second = await cache.get_price_snapshot("AAPL")
    assert inner.snapshot_calls == 1
    assert first.price == second.price


@pytest.mark.asyncio
async def test_snapshot_cache_expires_after_ttl() -> None:
    inner = _RecordingProvider()
    clock = [0.0]
    cache = CachedMarketDataProvider(
        inner, snapshot_ttl_seconds=30, clock=lambda: clock[0]
    )
    await cache.get_price_snapshot("AAPL")
    clock[0] += 31
    await cache.get_price_snapshot("AAPL")
    assert inner.snapshot_calls == 2


@pytest.mark.asyncio
async def test_candle_cache_keyed_by_range() -> None:
    inner = _RecordingProvider(candles=[_candle(1), _candle(2)])
    clock = [0.0]
    cache = CachedMarketDataProvider(
        inner, candle_ttl_seconds=600, clock=lambda: clock[0]
    )
    await cache.get_candles("AAPL", range="1mo")
    await cache.get_candles("AAPL", range="1mo")  # cached
    await cache.get_candles("AAPL", range="1y")   # different key
    assert inner.candle_calls == 2


@pytest.mark.asyncio
async def test_empty_candles_are_not_cached() -> None:
    inner = _RecordingProvider(candles=[])
    clock = [0.0]
    cache = CachedMarketDataProvider(
        inner, candle_ttl_seconds=600, clock=lambda: clock[0]
    )
    first = await cache.get_candles("AAPL", range="1y")
    second = await cache.get_candles("AAPL", range="1y")
    assert first == [] and second == []
    # Honest: empty payload triggers a re-fetch — the previous cycle may
    # have been a throttle window that already healed upstream.
    assert inner.candle_calls == 2


@pytest.mark.asyncio
async def test_as_of_bypasses_cache() -> None:
    inner = _RecordingProvider(candles=[_candle(1)])
    cache = CachedMarketDataProvider(inner)
    historical = datetime(2020, 1, 1, tzinfo=timezone.utc)
    await cache.get_price_snapshot("AAPL", as_of=historical)
    await cache.get_price_snapshot("AAPL", as_of=historical)
    await cache.get_candles("AAPL", as_of=historical)
    await cache.get_candles("AAPL", as_of=historical)
    assert inner.snapshot_calls == 2
    assert inner.candle_calls == 2


@pytest.mark.asyncio
async def test_cache_age_seconds_tracks_last_fetch() -> None:
    inner = _RecordingProvider(candles=[_candle(1)])
    clock = [10.0]
    cache = CachedMarketDataProvider(inner, clock=lambda: clock[0])
    assert cache.cache_age_seconds("AAPL") is None
    await cache.get_candles("AAPL", range="1y")
    clock[0] += 42
    age = cache.cache_age_seconds("AAPL", range="1y")
    assert age is not None
    assert 41 <= age <= 43
