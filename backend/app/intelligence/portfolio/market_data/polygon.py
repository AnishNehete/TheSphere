"""Polygon.io primary MarketDataProvider.

Uses the Polygon REST API:

* Latest trade:       ``GET /v2/last/trade/{symbol}``
* Previous close:     ``GET /v2/aggs/ticker/{symbol}/prev``
* OHLCV aggregates:   ``GET /v2/aggs/ticker/{symbol}/range/{multiplier}/{timespan}/{from}/{to}``

Never fabricates a price. On HTTP errors or empty results, returns a
``PriceSnapshot(price=None, ...)`` / empty candle list.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Sequence

import httpx

from app.intelligence.portfolio.market_data.base import (
    Candle,
    CandleRange,
    PriceSnapshot,
)


logger = logging.getLogger(__name__)


_RANGE_TO_AGGS: dict[CandleRange, tuple[int, str, timedelta]] = {
    "1d": (5, "minute", timedelta(days=1)),
    "5d": (1, "hour", timedelta(days=5)),
    "1mo": (1, "day", timedelta(days=31)),
    "3mo": (1, "day", timedelta(days=93)),
    "6mo": (1, "day", timedelta(days=186)),
    "1y": (1, "day", timedelta(days=365)),
    "2y": (1, "day", timedelta(days=365 * 2)),
    "5y": (1, "day", timedelta(days=365 * 5)),
}


class PolygonMarketDataProvider:
    """Primary Polygon.io-backed MarketDataProvider implementation."""

    provider_id = "polygon"

    def __init__(
        self,
        *,
        api_key: str,
        base_url: str = "https://api.polygon.io",
        client: httpx.AsyncClient | None = None,
        timeout_seconds: float = 10.0,
        cache_ttl_seconds: int = 60,
        candle_cache_ttl_seconds: int = 900,
        stale_threshold_seconds: int = 900,
    ) -> None:
        self._api_key = api_key
        self._base_url = base_url.rstrip("/")
        self._client = client
        self._owns_client = client is None
        self._timeout = timeout_seconds
        self._cache_ttl = max(0, cache_ttl_seconds)
        self._candle_cache_ttl = max(0, candle_cache_ttl_seconds)
        self._stale_threshold = max(0, stale_threshold_seconds)
        self._snapshot_cache: dict[str, tuple[datetime, PriceSnapshot]] = {}
        self._candle_cache: dict[tuple[str, str, str], tuple[datetime, list[Candle]]] = {}

    async def _get_client(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(timeout=self._timeout)
        return self._client

    async def aclose(self) -> None:
        if self._owns_client and self._client is not None:
            await self._client.aclose()
            self._client = None

    # ---- snapshot ------------------------------------------------------

    async def get_price_snapshot(
        self, symbol: str, *, as_of: datetime | None = None
    ) -> PriceSnapshot:
        cached = self._get_cached_snapshot(symbol, as_of)
        if cached is not None:
            return cached

        client = await self._get_client()
        price: float | None = None
        snapshot_as_of: datetime | None = None

        try:
            response = await client.get(
                f"{self._base_url}/v2/last/trade/{symbol}",
                params={"apiKey": self._api_key},
            )
            response.raise_for_status()
            payload = response.json()
            results = payload.get("results") if isinstance(payload, dict) else None
            if isinstance(results, dict):
                raw_price = results.get("p")
                raw_ts = results.get("t")
                if isinstance(raw_price, (int, float)):
                    price = float(raw_price)
                if isinstance(raw_ts, (int, float)):
                    # Polygon last-trade timestamps are nanoseconds.
                    snapshot_as_of = datetime.fromtimestamp(
                        float(raw_ts) / 1_000_000_000, tz=timezone.utc
                    )
        except Exception as exc:
            logger.warning("polygon snapshot failed for %s: %s", symbol, exc)

        previous_close = await self.get_previous_close(symbol, as_of=as_of)
        now = datetime.now(timezone.utc)
        anchor = snapshot_as_of or as_of or now
        staleness = max(0.0, (now - anchor).total_seconds())
        is_stale = staleness > self._stale_threshold and price is not None

        snapshot = PriceSnapshot(
            symbol=symbol,
            price=price,
            previous_close=previous_close,
            as_of=anchor,
            currency="USD",
            provider=self.provider_id,
            is_stale=is_stale,
            staleness_seconds=staleness,
        )
        self._cache_snapshot(symbol, snapshot)
        return snapshot

    async def get_previous_close(
        self, symbol: str, *, as_of: datetime | None = None
    ) -> float | None:
        client = await self._get_client()
        try:
            response = await client.get(
                f"{self._base_url}/v2/aggs/ticker/{symbol}/prev",
                params={"apiKey": self._api_key},
            )
            response.raise_for_status()
            payload = response.json()
        except Exception as exc:
            logger.warning("polygon prev-close failed for %s: %s", symbol, exc)
            return None

        if not isinstance(payload, dict):
            return None
        results = payload.get("results")
        if not isinstance(results, list) or not results:
            return None
        first = results[0]
        if not isinstance(first, dict):
            return None
        close = first.get("c")
        if isinstance(close, (int, float)):
            return float(close)
        return None

    async def get_snapshots(
        self, symbols: Sequence[str], *, as_of: datetime | None = None
    ) -> dict[str, PriceSnapshot]:
        out: dict[str, PriceSnapshot] = {}
        for symbol in symbols:
            out[symbol] = await self.get_price_snapshot(symbol, as_of=as_of)
        return out

    # ---- candles -------------------------------------------------------

    async def get_candles(
        self,
        symbol: str,
        *,
        range: CandleRange = "1y",
        as_of: datetime | None = None,
    ) -> list[Candle]:
        cache_key = (symbol.upper(), range, (as_of or datetime.min).isoformat())
        cached = self._get_cached_candles(cache_key)
        if cached is not None:
            return cached

        multiplier, timespan, window = _RANGE_TO_AGGS.get(
            range, _RANGE_TO_AGGS["1y"]
        )
        end = as_of or datetime.now(timezone.utc)
        start = end - window
        from_date = start.strftime("%Y-%m-%d")
        to_date = end.strftime("%Y-%m-%d")
        client = await self._get_client()
        try:
            response = await client.get(
                f"{self._base_url}/v2/aggs/ticker/{symbol}/range/"
                f"{multiplier}/{timespan}/{from_date}/{to_date}",
                params={"apiKey": self._api_key, "sort": "asc", "limit": 5000},
            )
            response.raise_for_status()
            payload = response.json()
        except Exception as exc:
            logger.warning("polygon candles failed for %s: %s", symbol, exc)
            return []

        if not isinstance(payload, dict):
            return []
        results = payload.get("results")
        if not isinstance(results, list):
            return []

        candles: list[Candle] = []
        for row in results:
            candle = _parse_agg(row)
            if candle is None:
                continue
            if as_of is not None and candle.timestamp > as_of:
                continue
            candles.append(candle)

        self._cache_candles(cache_key, candles)
        return candles

    # ---- cache helpers -------------------------------------------------

    def _get_cached_snapshot(
        self, symbol: str, as_of: datetime | None
    ) -> PriceSnapshot | None:
        if as_of is not None or self._cache_ttl <= 0:
            return None
        cached = self._snapshot_cache.get(symbol)
        if cached is None:
            return None
        stored_at, snapshot = cached
        age = (datetime.now(timezone.utc) - stored_at).total_seconds()
        if age > self._cache_ttl:
            return None
        return snapshot

    def _cache_snapshot(self, symbol: str, snapshot: PriceSnapshot) -> None:
        if self._cache_ttl <= 0:
            return
        if len(self._snapshot_cache) > 200:
            # trivial LRU: drop oldest
            oldest = min(self._snapshot_cache, key=lambda k: self._snapshot_cache[k][0])
            self._snapshot_cache.pop(oldest, None)
        self._snapshot_cache[symbol] = (datetime.now(timezone.utc), snapshot)

    def _get_cached_candles(
        self, key: tuple[str, str, str]
    ) -> list[Candle] | None:
        if self._candle_cache_ttl <= 0:
            return None
        cached = self._candle_cache.get(key)
        if cached is None:
            return None
        stored_at, candles = cached
        age = (datetime.now(timezone.utc) - stored_at).total_seconds()
        if age > self._candle_cache_ttl:
            return None
        return list(candles)

    def _cache_candles(self, key: tuple[str, str, str], candles: list[Candle]) -> None:
        if self._candle_cache_ttl <= 0:
            return
        if len(self._candle_cache) > 50:
            oldest = min(self._candle_cache, key=lambda k: self._candle_cache[k][0])
            self._candle_cache.pop(oldest, None)
        self._candle_cache[key] = (datetime.now(timezone.utc), list(candles))


def _parse_agg(row: Any) -> Candle | None:
    if not isinstance(row, dict):
        return None
    try:
        timestamp_ms = row.get("t")
        if not isinstance(timestamp_ms, (int, float)):
            return None
        ts = datetime.fromtimestamp(float(timestamp_ms) / 1000.0, tz=timezone.utc)
        open_ = float(row.get("o", 0.0))
        high = float(row.get("h", 0.0))
        low = float(row.get("l", 0.0))
        close = float(row.get("c", 0.0))
        volume = float(row.get("v", 0.0))
    except (TypeError, ValueError):
        return None
    return Candle(
        timestamp=ts,
        open=open_,
        high=high,
        low=low,
        close=close,
        volume=volume,
    )


__all__ = ["PolygonMarketDataProvider"]
