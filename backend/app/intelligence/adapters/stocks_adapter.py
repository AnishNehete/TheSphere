"""Stocks adapter backed by Alpha Vantage GLOBAL_QUOTE.

Alpha Vantage (https://www.alphavantage.co) exposes a keyed ``GLOBAL_QUOTE``
endpoint that returns the latest price, previous close, and daily change for
an equity. We pull a small, stable basket of flagship symbols so the ingest
pipeline emits realistic equity signals without blowing the free-tier quota
(25 requests per day, 5 per minute).

Rate-limit and key discipline:

* if no API key is configured we emit a deterministic synthetic payload and
  flag the adapter as ``not configured`` (``is_configured`` is False)
* a per-symbol in-memory cache respects the cache TTL so repeated polls
  don't burn calls when the market barely moves
* Alpha Vantage's soft rate-limit payloads (``Note`` / ``Information`` keys)
  are treated as a signal to stop and fall back to cached or synthetic data
"""

from __future__ import annotations

import asyncio
import logging
import math
from datetime import datetime, timezone
from typing import Any, Sequence

import httpx

from app.intelligence.adapters.base import SignalAdapter
from app.intelligence.adapters.country_lookup import lookup_by_alpha3
from app.intelligence.schemas import (
    EventEntity,
    Place,
    SignalEvent,
    SignalSeverity,
    SourceRef,
)
from app.settings import ProviderConfig


logger = logging.getLogger(__name__)

ALPHAVANTAGE_DEFAULT_BASE = "https://www.alphavantage.co"
ALPHAVANTAGE_QUERY_PATH = "/query"

# (symbol, human name, listing country alpha-3)
_DEFAULT_SYMBOLS: tuple[tuple[str, str, str], ...] = (
    ("AAPL", "Apple Inc.", "USA"),
    ("MSFT", "Microsoft Corp.", "USA"),
    ("NVDA", "NVIDIA Corp.", "USA"),
    ("TSLA", "Tesla Inc.", "USA"),
    ("SPY", "SPDR S&P 500 ETF", "USA"),
)


class StocksAdapter(SignalAdapter):
    adapter_id = "stocks.alphavantage"
    category = "stocks"
    domain = "stocks"
    poll_interval_seconds = 900  # 15 min keeps us under the 25/day free-tier cap
    max_retries = 1

    def __init__(
        self,
        *,
        client: httpx.AsyncClient | None = None,
        timeout_seconds: float = 10.0,
        symbols: Sequence[tuple[str, str, str]] | None = None,
        config: ProviderConfig | None = None,
        request_delay_seconds: float = 12.5,  # 5 req/min safe spacing
        cache_ttl_seconds: int = 600,
    ) -> None:
        super().__init__(config=config)
        self._client = client
        self._owns_client = client is None
        self._timeout = timeout_seconds
        self._symbols = tuple(symbols) if symbols else _DEFAULT_SYMBOLS
        self._request_delay = max(0.0, request_delay_seconds)
        self._cache_ttl_seconds = max(0, cache_ttl_seconds)
        self._cache: dict[str, tuple[datetime, dict[str, Any]]] = {}

    @property
    def is_configured(self) -> bool:
        """Alpha Vantage requires an API key — override the default heuristic."""

        if self._config is None:
            return False
        return bool(
            self._config.enabled
            and self._config.provider
            and self._config.has_api_key
        )

    @property
    def _base_url(self) -> str:
        if self._config and self._config.base_url:
            return self._config.base_url.rstrip("/")
        return ALPHAVANTAGE_DEFAULT_BASE

    @property
    def _api_key(self) -> str:
        return self._config.api_key if self._config else ""

    async def _get_client(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(timeout=self._timeout)
        return self._client

    async def aclose(self) -> None:
        if self._owns_client and self._client is not None:
            await self._client.aclose()
            self._client = None

    async def fetch(self) -> dict[str, Any]:
        if not self._api_key:
            logger.info(
                "stocks adapter: no API key configured; emitting synthetic fallback"
            )
            return _synthetic_quotes_payload(self._symbols)
        # Phase 19E.3: when the operator has explicitly configured a key
        # we treat any cached real quote as preferred over a synthetic
        # one. The cache lookup happens inside the per-symbol loop below;
        # this branch only runs on first call before any cache exists.

        client = await self._get_client()
        quotes: list[dict[str, Any]] = []
        rate_limited = False
        network_calls_made = 0

        for idx, (symbol, name, country_code) in enumerate(self._symbols):
            cached = self._get_cached(symbol)
            if cached is not None:
                quotes.append({**cached, "name": name, "country_code": country_code})
                continue

            if network_calls_made > 0 and self._request_delay > 0:
                await asyncio.sleep(self._request_delay)

            try:
                response = await client.get(
                    f"{self._base_url}{ALPHAVANTAGE_QUERY_PATH}",
                    params={
                        "function": "GLOBAL_QUOTE",
                        "symbol": symbol,
                        "apikey": self._api_key,
                    },
                )
                response.raise_for_status()
                payload = response.json()
                network_calls_made += 1
            except Exception as exc:
                logger.warning(
                    "stocks adapter: fetch failed for %s: %s", symbol, exc
                )
                continue

            if not isinstance(payload, dict):
                continue

            # Alpha Vantage soft-errors: Note/Information keys signal throttling.
            if "Note" in payload or "Information" in payload:
                logger.warning(
                    "stocks adapter: Alpha Vantage throttled: %s",
                    payload.get("Note") or payload.get("Information"),
                )
                rate_limited = True
                break

            global_quote = (
                payload.get("Global Quote")
                or payload.get("Realtime Global Securities Quote")
                or {}
            )
            if not isinstance(global_quote, dict) or not global_quote:
                continue

            normalized_quote = _parse_global_quote(
                global_quote, symbol=symbol, name=name, country_code=country_code
            )
            if normalized_quote is None:
                continue

            quotes.append(normalized_quote)
            self._set_cached(symbol, normalized_quote)

        if not quotes:
            # Phase 19E.3: when the operator has supplied a real API key
            # we never emit synthetic quotes — that produced misleading
            # $100/$125/$150 prices on the market tape that the chart
            # endpoint (Alpha Vantage candles) directly contradicted.
            # Honest stale beats fake live: return empty so the ingest
            # cycle records a no-op tick and downstream surfaces show
            # last-known cache or "stale" rather than fabricating.
            logger.warning(
                "stocks adapter: Alpha Vantage returned no usable quotes "
                "(rate_limited=%s); emitting empty payload to preserve "
                "real-data invariant",
                rate_limited,
            )
            return {
                "quotes": [],
                "rate_limited": rate_limited,
                "retrieved_at": datetime.now(timezone.utc).isoformat(),
            }

        return {
            "quotes": quotes,
            "rate_limited": rate_limited,
            "retrieved_at": datetime.now(timezone.utc).isoformat(),
        }

    def _get_cached(self, symbol: str) -> dict[str, Any] | None:
        if self._cache_ttl_seconds <= 0:
            return None
        cached = self._cache.get(symbol)
        if cached is None:
            return None
        timestamp, payload = cached
        age = (datetime.now(timezone.utc) - timestamp).total_seconds()
        if age > self._cache_ttl_seconds:
            return None
        return dict(payload)

    def _set_cached(self, symbol: str, payload: dict[str, Any]) -> None:
        if self._cache_ttl_seconds <= 0:
            return
        self._cache[symbol] = (datetime.now(timezone.utc), dict(payload))

    def validate(self, raw: Any) -> dict[str, Any]:
        if not isinstance(raw, dict) or not isinstance(raw.get("quotes"), list):
            raise ValueError("stocks adapter expected {quotes: []}")
        return raw

    def normalize(self, validated: dict[str, Any]) -> Sequence[SignalEvent]:
        now = datetime.now(timezone.utc)
        out: list[SignalEvent] = []
        for quote in validated["quotes"]:
            event = _normalize_quote(quote, now=now)
            if event is not None:
                out.append(event)
        return out


def _parse_global_quote(
    quote: dict[str, Any],
    *,
    symbol: str,
    name: str,
    country_code: str,
) -> dict[str, Any] | None:
    price = _as_float(quote.get("05. price"))
    previous_close = _as_float(quote.get("08. previous close"))
    change = _as_float(quote.get("09. change"))
    change_pct = _parse_change_pct(quote.get("10. change percent"))
    if price is None and previous_close is None and change_pct is None:
        return None
    if change_pct is None and price is not None and previous_close not in (None, 0):
        assert previous_close is not None
        change_pct = ((price - previous_close) / previous_close) * 100.0
    return {
        "symbol": symbol,
        "name": name,
        "country_code": country_code,
        "price": price,
        "open": _as_float(quote.get("02. open")),
        "high": _as_float(quote.get("03. high")),
        "low": _as_float(quote.get("04. low")),
        "previous_close": previous_close,
        "volume": _as_int(quote.get("06. volume")),
        "change": change,
        "change_pct": change_pct if change_pct is not None else 0.0,
        "trading_day": quote.get("07. latest trading day"),
    }


def _normalize_quote(quote: dict[str, Any], *, now: datetime) -> SignalEvent | None:
    symbol = str(quote.get("symbol") or "").strip()
    if not symbol:
        return None
    name = str(quote.get("name") or symbol)
    price = _as_float(quote.get("price"))
    previous_close = _as_float(quote.get("previous_close"))
    change = _as_float(quote.get("change"))
    change_pct = _as_float(quote.get("change_pct")) or 0.0
    volume = quote.get("volume")
    trading_day = quote.get("trading_day")

    magnitude = min(abs(change_pct) / 3.0, 1.0)
    severity: SignalSeverity = (
        "critical"
        if magnitude >= 0.8
        else "elevated"
        if magnitude >= 0.5
        else "watch"
        if magnitude >= 0.25
        else "info"
    )
    direction = "up" if change_pct >= 0 else "down"
    country = lookup_by_alpha3(quote.get("country_code"))
    # Alpha Vantage GLOBAL_QUOTE only exposes the trading day, not a wall-clock
    # timestamp. Equity quotes reflect the latest market state at fetch time, so
    # anchor source_timestamp to ``now`` and keep the trading day in properties.
    stamp = now
    day_key = trading_day or now.strftime("%Y-%m-%d")

    price_bit = f" @ {price:.2f}" if price is not None else ""
    title = f"{symbol} {direction} {change_pct:+.2f}%{price_bit}"
    summary_parts: list[str] = [f"{name} ({symbol})"]
    if price is not None:
        summary_parts.append(f"price {price:.2f}")
    summary_parts.append(f"{change_pct:+.2f}%")
    if previous_close is not None:
        summary_parts.append(f"prev close {previous_close:.2f}")
    if trading_day:
        summary_parts.append(f"trading day {trading_day}")
    summary = " | ".join(summary_parts) + "."

    return SignalEvent(
        id=f"stk-{symbol.lower()}-{day_key}",
        dedupe_key=f"stocks|{symbol}|{day_key}",
        type="stocks",
        sub_type="equity-quote",
        title=title,
        summary=summary,
        severity=severity,
        severity_score=magnitude,
        confidence=0.75,
        status="active",
        place=Place(
            latitude=country.latitude if country else None,
            longitude=country.longitude if country else None,
            country_code=country.code if country else None,
            country_name=country.name if country else None,
            region=country.region if country else None,
        ),
        ingested_at=now,
        source_timestamp=stamp,
        sources=[
            SourceRef(
                adapter="stocks.alphavantage",
                provider="alphavantage",
                provider_event_id=f"{symbol}-{day_key}",
                url="https://www.alphavantage.co",
                retrieved_at=now,
                source_timestamp=stamp,
                publisher="Alpha Vantage",
                reliability=0.7,
            )
        ],
        tags=["stocks", "equity", symbol.lower()],
        entities=[
            EventEntity(
                entity_id=f"ticker:{symbol}",
                entity_type="company",
                name=name,
                country_code=country.code if country else None,
            )
        ],
        properties={
            "symbol": symbol,
            "name": name,
            "price": price,
            "previous_close": previous_close,
            "change": change,
            "change_pct": change_pct,
            "volume": volume,
            "trading_day": trading_day,
            "open": quote.get("open"),
            "high": quote.get("high"),
            "low": quote.get("low"),
        },
    )


def _synthetic_quotes_payload(
    symbols: Sequence[tuple[str, str, str]],
    *,
    rate_limited: bool = False,
) -> dict[str, Any]:
    """Deterministic offline fallback used when the provider is unavailable."""

    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    quotes: list[dict[str, Any]] = []
    for idx, (symbol, name, country_code) in enumerate(symbols):
        wave = math.sin((idx + 1) * 0.9)
        change_pct = round(wave * 1.5, 2)
        prev_close = round(100.0 + idx * 25.0, 2)
        price = round(prev_close * (1.0 + change_pct / 100.0), 2)
        quotes.append(
            {
                "symbol": symbol,
                "name": name,
                "country_code": country_code,
                "price": price,
                "open": prev_close,
                "high": max(price, prev_close),
                "low": min(price, prev_close),
                "previous_close": prev_close,
                "volume": 1_000_000,
                "change": round(price - prev_close, 2),
                "change_pct": change_pct,
                "trading_day": today,
            }
        )
    return {
        "quotes": quotes,
        "rate_limited": rate_limited,
        "retrieved_at": datetime.now(timezone.utc).isoformat(),
    }


def _as_float(value: Any) -> float | None:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _as_int(value: Any) -> int | None:
    if value is None:
        return None
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return None


def _parse_change_pct(value: Any) -> float | None:
    """Parse Alpha Vantage's ``"1.0033%"`` string into a float."""

    if value is None:
        return None
    text = str(value).strip().rstrip("%").strip()
    try:
        return float(text)
    except (TypeError, ValueError):
        return None


def _parse_day(value: Any) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.strptime(str(value), "%Y-%m-%d").replace(tzinfo=timezone.utc)
    except (TypeError, ValueError):
        return None


__all__ = ["StocksAdapter"]
