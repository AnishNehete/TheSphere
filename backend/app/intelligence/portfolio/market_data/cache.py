"""TTL-cache wrapper for any ``MarketDataProvider``.

Phase 17A.2 — Alpha Vantage is rate-limited (5 req/min, 25/day on the
free tier). The tape, posture engine, and chart dock all want
near-real-time data. We solve this with a discipline pass rather than
fabricating numbers:

* per-(symbol, range) candle cache with a configurable TTL
* per-symbol snapshot cache with a tighter TTL
* honest freshness metadata: every cache hit knows when the upstream
  call happened, so callers can render "as-of" / "delayed" affordances
* cache invalidates on the natural age of the data — there is no
  background refresher; a stale entry simply triggers an upstream call
  on the next request
* cache misses degrade exactly like the underlying provider would —
  empty candles, ``price=None``. The cache *never* returns invented data.

This wrapper is provider-agnostic: it sits on top of any concrete
``MarketDataProvider`` and so works for Alpha Vantage today and any
future drop-in replacement.
"""

from __future__ import annotations

import asyncio
import logging
import time
from datetime import datetime
from typing import Sequence

from app.intelligence.portfolio.market_data.base import (
    Candle,
    CandleRange,
    MarketDataProvider,
    PriceSnapshot,
)


logger = logging.getLogger(__name__)


# Default TTLs tuned for Alpha Vantage free tier. Snapshots refresh fast
# enough that the tape feels alive (and matches the AV update cadence
# for daily series). Candle history is more expensive — give it a longer
# window so a chart-flip between 1mo / 3mo / 1y doesn't burn quota.
DEFAULT_SNAPSHOT_TTL_SECONDS = 30
DEFAULT_CANDLE_TTL_SECONDS = 600


class CachedMarketDataProvider:
    """Wrap a ``MarketDataProvider`` with TTL caches and freshness metadata.

    The cached value is always the *upstream* response — we never patch
    or extrapolate on a cache hit. That keeps the engine deterministic:
    the same upstream payload yields the same posture, with or without
    the cache in front.
    """

    def __init__(
        self,
        inner: MarketDataProvider,
        *,
        snapshot_ttl_seconds: int = DEFAULT_SNAPSHOT_TTL_SECONDS,
        candle_ttl_seconds: int = DEFAULT_CANDLE_TTL_SECONDS,
        clock: "callable | None" = None,
    ) -> None:
        self._inner = inner
        self.provider_id = f"{inner.provider_id}+cache"
        self._snapshot_ttl = max(0, snapshot_ttl_seconds)
        self._candle_ttl = max(0, candle_ttl_seconds)
        self._clock = clock or time.monotonic
        self._snapshot_cache: dict[str, tuple[float, PriceSnapshot]] = {}
        self._candle_cache: dict[tuple[str, CandleRange], tuple[float, list[Candle]]] = {}
        self._snapshot_locks: dict[str, asyncio.Lock] = {}
        self._candle_locks: dict[tuple[str, CandleRange], asyncio.Lock] = {}

    @property
    def inner(self) -> MarketDataProvider:
        return self._inner

    # ---- snapshot ---------------------------------------------------------

    async def get_price_snapshot(
        self, symbol: str, *, as_of: datetime | None = None
    ) -> PriceSnapshot:
        # ``as_of`` requests bypass the cache — replay must hit the
        # underlying provider so we never serve a live snapshot for a
        # historical timestamp.
        if as_of is not None:
            return await self._inner.get_price_snapshot(symbol, as_of=as_of)

        key = symbol.upper().strip()
        cached = self._snapshot_cache.get(key)
        now = self._clock()
        if cached is not None and (now - cached[0]) < self._snapshot_ttl:
            return cached[1]

        lock = self._snapshot_locks.setdefault(key, asyncio.Lock())
        async with lock:
            cached = self._snapshot_cache.get(key)
            now = self._clock()
            if cached is not None and (now - cached[0]) < self._snapshot_ttl:
                return cached[1]
            snapshot = await self._inner.get_price_snapshot(key)
            self._snapshot_cache[key] = (now, snapshot)
            return snapshot

    async def get_previous_close(
        self, symbol: str, *, as_of: datetime | None = None
    ) -> float | None:
        snapshot = await self.get_price_snapshot(symbol, as_of=as_of)
        return snapshot.previous_close

    async def get_snapshots(
        self, symbols: Sequence[str], *, as_of: datetime | None = None
    ) -> dict[str, PriceSnapshot]:
        out: dict[str, PriceSnapshot] = {}
        for symbol in symbols:
            out[symbol] = await self.get_price_snapshot(symbol, as_of=as_of)
        return out

    # ---- candles ---------------------------------------------------------

    async def get_candles(
        self,
        symbol: str,
        *,
        range: CandleRange = "1y",
        as_of: datetime | None = None,
    ) -> list[Candle]:
        if as_of is not None:
            return await self._inner.get_candles(symbol, range=range, as_of=as_of)

        key = (symbol.upper().strip(), range)
        cached = self._candle_cache.get(key)
        now = self._clock()
        if cached is not None and (now - cached[0]) < self._candle_ttl:
            return list(cached[1])

        lock = self._candle_locks.setdefault(key, asyncio.Lock())
        async with lock:
            cached = self._candle_cache.get(key)
            now = self._clock()
            if cached is not None and (now - cached[0]) < self._candle_ttl:
                return list(cached[1])
            candles = await self._inner.get_candles(key[0], range=range)
            # Only cache non-empty payloads. An empty list might mean the
            # provider was throttled — caching that would extend the
            # outage by ``candle_ttl_seconds``. Better to let the next
            # request retry honestly.
            if candles:
                self._candle_cache[key] = (now, list(candles))
            return list(candles)

    # ---- meta ------------------------------------------------------------

    async def aclose(self) -> None:
        await self._inner.aclose()

    def cache_age_seconds(self, symbol: str, *, range: CandleRange = "1y") -> float | None:
        """Age of the cached candle entry, or ``None`` if no entry exists.

        Used by the posture service to surface honest freshness even when
        the upstream call happened minutes ago.
        """

        key = (symbol.upper().strip(), range)
        cached = self._candle_cache.get(key)
        if cached is None:
            return None
        return max(0.0, self._clock() - cached[0])


__all__ = ["CachedMarketDataProvider", "DEFAULT_CANDLE_TTL_SECONDS", "DEFAULT_SNAPSHOT_TTL_SECONDS"]
