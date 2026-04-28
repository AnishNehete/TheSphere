"""Alpha Vantage MarketDataProvider — Phase 17A.2 promoted to primary.

In 13B.1 this module sat behind a Polygon → AV chain. Phase 17A.2 makes
Alpha Vantage the **sole live provider**: candles, posture, and the
market tape now route through this class directly. Honest-degradation
rules survive verbatim:

* ``Note`` / ``Information`` keys stop the call and return ``price=None``
  / empty candles — we never fabricate data under throttle.
* When a symbol shape is not supported by AV (e.g. continuous index
  futures like ``ES``, ``NQ``, ``ZN``) we degrade to empty candles with
  ``provider="alphavantage"`` so callers can render an "unavailable"
  state rather than implying coverage we don't have.

Endpoints used:
* ``GLOBAL_QUOTE``         — equities snapshot + previous close
* ``TIME_SERIES_DAILY``    — equities candle history
* ``CURRENCY_EXCHANGE_RATE`` — FX snapshot
* ``FX_DAILY``             — FX candle history (``EURUSD`` etc.)
* ``DIGITAL_CURRENCY_DAILY`` — left disabled here; crypto is out of
  scope for 17A.2.
"""

from __future__ import annotations

import logging
import re
from datetime import datetime, timezone
from typing import Any, Literal, Sequence

import httpx

from app.intelligence.portfolio.market_data.base import (
    Candle,
    CandleRange,
    PriceSnapshot,
)


logger = logging.getLogger(__name__)


SymbolKind = Literal["equity", "fx", "futures", "unknown"]


_RANGE_TO_CANDLE_COUNT: dict[CandleRange, int] = {
    "1d": 1,
    "5d": 5,
    "1mo": 22,
    "3mo": 66,
    "6mo": 132,
    "1y": 260,
    "2y": 520,
    "5y": 1300,
}

# Continuous-curve futures roots Alpha Vantage does not cover. We list
# them here so callers can degrade *honestly* rather than emit a
# misleading TIME_SERIES_DAILY 404. Add to this set when we discover
# more unsupported instruments — never quietly pretend coverage exists.
_UNSUPPORTED_FUTURES_ROOTS: frozenset[str] = frozenset(
    {
        "ES", "NQ", "YM", "RTY", "VX",       # equity index
        "ZN", "ZF", "ZB", "ZT", "FF", "GE", "SR3",  # rates
        "CL", "BZ", "NG", "GC", "SI", "HG", "PL", "PA",  # commodity futures
        "ZW", "ZC", "ZS", "KC", "SB", "CT",
    }
)

# 6-letter pure FX pairs we route through CURRENCY_EXCHANGE_RATE / FX_DAILY.
_FX_PAIR = re.compile(r"^[A-Z]{6}$")


class AlphaVantageMarketDataProvider:
    """Alpha Vantage-backed MarketDataProvider (primary in Phase 17A.2)."""

    provider_id = "alphavantage"

    def __init__(
        self,
        *,
        api_key: str,
        base_url: str = "https://www.alphavantage.co",
        client: httpx.AsyncClient | None = None,
        timeout_seconds: float = 10.0,
        stale_threshold_seconds: int = 900,
    ) -> None:
        self._api_key = api_key
        self._base_url = base_url.rstrip("/")
        self._client = client
        self._owns_client = client is None
        self._timeout = timeout_seconds
        self._stale_threshold = max(0, stale_threshold_seconds)

    async def _get_client(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(timeout=self._timeout)
        return self._client

    async def aclose(self) -> None:
        if self._owns_client and self._client is not None:
            await self._client.aclose()
            self._client = None

    # ---- Honest classification --------------------------------------------

    @staticmethod
    def classify_symbol(symbol: str) -> SymbolKind:
        """Classify a raw symbol into the AV-supported asset class.

        Returns ``"futures"`` for continuous-curve roots Alpha Vantage
        does *not* cover. The provider never claims to support them — we
        explicitly degrade to empty candles instead.
        """

        normalized = (symbol or "").upper().strip()
        if not normalized:
            return "unknown"
        if _FX_PAIR.match(normalized):
            return "fx"
        if normalized in _UNSUPPORTED_FUTURES_ROOTS:
            return "futures"
        return "equity"

    @staticmethod
    def _split_fx_pair(pair: str) -> tuple[str, str] | None:
        cleaned = pair.upper().strip().replace("/", "")
        if not _FX_PAIR.match(cleaned):
            return None
        return cleaned[:3], cleaned[3:]

    # ---- Snapshots --------------------------------------------------------

    async def get_price_snapshot(
        self, symbol: str, *, as_of: datetime | None = None
    ) -> PriceSnapshot:
        kind = self.classify_symbol(symbol)
        if kind == "fx":
            return await self._fx_snapshot(symbol, as_of=as_of)
        if kind == "futures":
            return self._unsupported_snapshot(symbol, as_of=as_of)
        return await self._equity_snapshot(symbol, as_of=as_of)

    async def _equity_snapshot(
        self, symbol: str, *, as_of: datetime | None
    ) -> PriceSnapshot:
        client = await self._get_client()
        price: float | None = None
        previous_close: float | None = None
        snapshot_as_of = as_of or datetime.now(timezone.utc)

        try:
            response = await client.get(
                f"{self._base_url}/query",
                params={
                    "function": "GLOBAL_QUOTE",
                    "symbol": symbol,
                    "apikey": self._api_key,
                },
            )
            response.raise_for_status()
            payload = response.json()
        except Exception as exc:
            logger.warning("alphavantage snapshot failed for %s: %s", symbol, exc)
            payload = None

        if isinstance(payload, dict):
            if _is_throttle(payload):
                logger.warning(
                    "alphavantage throttled for %s: %s",
                    symbol,
                    payload.get("Note") or payload.get("Information"),
                )
            else:
                quote = payload.get("Global Quote") or payload.get(
                    "Realtime Global Securities Quote"
                )
                if isinstance(quote, dict) and quote:
                    price = _as_float(quote.get("05. price"))
                    previous_close = _as_float(quote.get("08. previous close"))
                    trading_day = quote.get("07. latest trading day")
                    if trading_day:
                        parsed = _parse_day(trading_day)
                        if parsed is not None:
                            snapshot_as_of = parsed

        now = datetime.now(timezone.utc)
        staleness = max(0.0, (now - snapshot_as_of).total_seconds())
        is_stale = staleness > self._stale_threshold and price is not None
        return PriceSnapshot(
            symbol=symbol,
            price=price,
            previous_close=previous_close,
            as_of=snapshot_as_of,
            currency="USD",
            provider=self.provider_id,
            is_stale=is_stale,
            staleness_seconds=staleness,
        )

    async def _fx_snapshot(
        self, symbol: str, *, as_of: datetime | None
    ) -> PriceSnapshot:
        pair = self._split_fx_pair(symbol)
        if pair is None:
            return self._unsupported_snapshot(symbol, as_of=as_of)
        from_ccy, to_ccy = pair
        client = await self._get_client()
        price: float | None = None
        snapshot_as_of = as_of or datetime.now(timezone.utc)

        try:
            response = await client.get(
                f"{self._base_url}/query",
                params={
                    "function": "CURRENCY_EXCHANGE_RATE",
                    "from_currency": from_ccy,
                    "to_currency": to_ccy,
                    "apikey": self._api_key,
                },
            )
            response.raise_for_status()
            payload = response.json()
        except Exception as exc:
            logger.warning("alphavantage FX snapshot failed for %s: %s", symbol, exc)
            payload = None

        if isinstance(payload, dict) and not _is_throttle(payload):
            rate = payload.get("Realtime Currency Exchange Rate")
            if isinstance(rate, dict) and rate:
                price = _as_float(rate.get("5. Exchange Rate"))
                last_refreshed = rate.get("6. Last Refreshed")
                if last_refreshed:
                    parsed = _parse_datetime(last_refreshed)
                    if parsed is not None:
                        snapshot_as_of = parsed

        now = datetime.now(timezone.utc)
        staleness = max(0.0, (now - snapshot_as_of).total_seconds())
        is_stale = staleness > self._stale_threshold and price is not None
        return PriceSnapshot(
            symbol=symbol.upper(),
            price=price,
            previous_close=None,
            as_of=snapshot_as_of,
            currency=to_ccy,
            provider=self.provider_id,
            is_stale=is_stale,
            staleness_seconds=staleness,
        )

    def _unsupported_snapshot(
        self, symbol: str, *, as_of: datetime | None
    ) -> PriceSnapshot:
        """Symbol class Alpha Vantage cannot serve — return ``price=None``.

        We never invent a value. The provider is honest about coverage
        and the caller surfaces an "unavailable" state.
        """

        return PriceSnapshot(
            symbol=symbol.upper(),
            price=None,
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
        snapshot = await self.get_price_snapshot(symbol, as_of=as_of)
        return snapshot.previous_close

    async def get_snapshots(
        self, symbols: Sequence[str], *, as_of: datetime | None = None
    ) -> dict[str, PriceSnapshot]:
        out: dict[str, PriceSnapshot] = {}
        for symbol in symbols:
            out[symbol] = await self.get_price_snapshot(symbol, as_of=as_of)
        return out

    # ---- Candles ---------------------------------------------------------

    async def get_candles(
        self,
        symbol: str,
        *,
        range: CandleRange = "1y",
        as_of: datetime | None = None,
    ) -> list[Candle]:
        kind = self.classify_symbol(symbol)
        if kind == "futures":
            return []
        if kind == "fx":
            return await self._fx_candles(symbol, range=range, as_of=as_of)
        return await self._equity_candles(symbol, range=range, as_of=as_of)

    async def _equity_candles(
        self,
        symbol: str,
        *,
        range: CandleRange,
        as_of: datetime | None,
    ) -> list[Candle]:
        client = await self._get_client()
        # Phase 19E: Alpha Vantage's free tier rejects outputsize=full
        # ("premium feature") on TIME_SERIES_DAILY. Use compact (100 most
        # recent daily candles) so free-tier keys produce real data.
        # Premium deployments still work — _RANGE_TO_CANDLE_COUNT trims
        # to the requested window regardless.
        try:
            response = await client.get(
                f"{self._base_url}/query",
                params={
                    "function": "TIME_SERIES_DAILY",
                    "symbol": symbol,
                    "outputsize": "compact",
                    "apikey": self._api_key,
                },
            )
            response.raise_for_status()
            payload = response.json()
        except Exception as exc:
            logger.warning("alphavantage candles failed for %s: %s", symbol, exc)
            return []

        if not isinstance(payload, dict) or _is_throttle(payload):
            return []

        series = payload.get("Time Series (Daily)")
        if not isinstance(series, dict):
            return []

        candles: list[Candle] = []
        for day_str, row in series.items():
            candle = _parse_daily(day_str, row)
            if candle is None:
                continue
            if as_of is not None and candle.timestamp > as_of:
                continue
            candles.append(candle)

        candles.sort(key=lambda c: c.timestamp)
        limit = _RANGE_TO_CANDLE_COUNT.get(range, 260)
        if limit and len(candles) > limit:
            candles = candles[-limit:]
        return candles

    async def _fx_candles(
        self,
        symbol: str,
        *,
        range: CandleRange,
        as_of: datetime | None,
    ) -> list[Candle]:
        pair = self._split_fx_pair(symbol)
        if pair is None:
            return []
        from_ccy, to_ccy = pair
        client = await self._get_client()
        try:
            response = await client.get(
                f"{self._base_url}/query",
                params={
                    "function": "FX_DAILY",
                    "from_symbol": from_ccy,
                    "to_symbol": to_ccy,
                    "outputsize": "compact",
                    "apikey": self._api_key,
                },
            )
            response.raise_for_status()
            payload = response.json()
        except Exception as exc:
            logger.warning("alphavantage FX candles failed for %s: %s", symbol, exc)
            return []

        if not isinstance(payload, dict) or _is_throttle(payload):
            return []

        series = payload.get("Time Series FX (Daily)")
        if not isinstance(series, dict):
            return []

        candles: list[Candle] = []
        for day_str, row in series.items():
            candle = _parse_daily(day_str, row)
            if candle is None:
                continue
            if as_of is not None and candle.timestamp > as_of:
                continue
            candles.append(candle)

        candles.sort(key=lambda c: c.timestamp)
        limit = _RANGE_TO_CANDLE_COUNT.get(range, 260)
        if limit and len(candles) > limit:
            candles = candles[-limit:]
        return candles


# ---- module helpers ---------------------------------------------------------


def _is_throttle(payload: dict[str, Any]) -> bool:
    return "Note" in payload or "Information" in payload


def _as_float(value: Any) -> float | None:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _parse_day(value: Any) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.strptime(str(value), "%Y-%m-%d").replace(tzinfo=timezone.utc)
    except (TypeError, ValueError):
        return None


def _parse_datetime(value: Any) -> datetime | None:
    if not value:
        return None
    raw = str(value).strip()
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d"):
        try:
            return datetime.strptime(raw, fmt).replace(tzinfo=timezone.utc)
        except ValueError:
            continue
    return None


def _parse_daily(day_str: str, row: Any) -> Candle | None:
    if not isinstance(row, dict):
        return None
    ts = _parse_day(day_str)
    if ts is None:
        return None
    open_ = _as_float(row.get("1. open"))
    high = _as_float(row.get("2. high"))
    low = _as_float(row.get("3. low"))
    close = _as_float(row.get("4. close"))
    volume = _as_float(row.get("5. volume")) or 0.0
    if open_ is None or high is None or low is None or close is None:
        return None
    return Candle(
        timestamp=ts,
        open=open_,
        high=high,
        low=low,
        close=close,
        volume=volume,
    )


__all__ = ["AlphaVantageMarketDataProvider", "SymbolKind"]
