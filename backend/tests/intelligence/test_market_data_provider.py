"""Phase 13B.1 — MarketDataProvider contract + implementations tests.

Covers:
* Protocol conformance for all three providers.
* Synthetic determinism + ``as_of`` truncation.
* Polygon snapshot + candle parsing (httpx.MockTransport).
* Polygon graceful degradation on 500 / empty payload.
* AlphaVantage GLOBAL_QUOTE parsing + throttle handling.
* ChainedMarketDataProvider failover behaviour.
* ``build_market_data_provider`` env-driven routing.
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from typing import Any

import httpx
import pytest

from app.intelligence.portfolio.market_data import (
    AlphaVantageMarketDataProvider,
    ChainedMarketDataProvider,
    MarketDataProvider,
    PolygonMarketDataProvider,
    PriceSnapshot,
    SyntheticMarketDataProvider,
    build_market_data_provider,
)


# -----------------------------------------------------------------------------
# Protocol conformance
# -----------------------------------------------------------------------------


def test_protocol_contract_all_providers_conform() -> None:
    synthetic = SyntheticMarketDataProvider()
    assert isinstance(synthetic, MarketDataProvider)

    polygon = PolygonMarketDataProvider(api_key="dummy")
    assert isinstance(polygon, MarketDataProvider)

    av = AlphaVantageMarketDataProvider(api_key="dummy")
    assert isinstance(av, MarketDataProvider)


# -----------------------------------------------------------------------------
# Synthetic provider
# -----------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_synthetic_is_deterministic() -> None:
    fixed = datetime(2026, 4, 1, 12, 0, tzinfo=timezone.utc)
    provider = SyntheticMarketDataProvider(now_fn=lambda: fixed)
    first = await provider.get_price_snapshot("AAPL")
    second = await provider.get_price_snapshot("AAPL")
    assert first.price == second.price
    candles_a = await provider.get_candles("AAPL", range="1y")
    candles_b = await provider.get_candles("AAPL", range="1y")
    assert len(candles_a) == len(candles_b)
    assert all(a.close == b.close for a, b in zip(candles_a, candles_b))


@pytest.mark.asyncio
async def test_synthetic_respects_as_of_truncation() -> None:
    provider = SyntheticMarketDataProvider()
    cutoff = datetime(2026, 1, 15, tzinfo=timezone.utc)
    candles = await provider.get_candles("AAPL", range="1y", as_of=cutoff)
    assert candles, "expected at least one candle"
    assert max(c.timestamp for c in candles) <= cutoff


# -----------------------------------------------------------------------------
# Polygon provider — httpx.MockTransport fakes
# -----------------------------------------------------------------------------


def _mock_polygon_client(handler) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


@pytest.mark.asyncio
async def test_polygon_snapshot_parses_last_trade() -> None:
    now_ns = int(datetime.now(timezone.utc).timestamp() * 1_000_000_000)

    def handler(request: httpx.Request) -> httpx.Response:
        if "/v2/last/trade/" in request.url.path:
            return httpx.Response(
                200, json={"results": {"p": 180.5, "t": now_ns}}
            )
        if "/prev" in request.url.path:
            return httpx.Response(200, json={"results": [{"c": 179.0}]})
        return httpx.Response(404, json={})

    provider = PolygonMarketDataProvider(
        api_key="test", client=_mock_polygon_client(handler)
    )
    snapshot = await provider.get_price_snapshot("AAPL")
    assert snapshot.price == pytest.approx(180.5)
    assert snapshot.previous_close == pytest.approx(179.0)
    assert snapshot.provider == "polygon"
    assert snapshot.is_stale is False


@pytest.mark.asyncio
async def test_polygon_returns_price_none_on_empty_response() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"results": None})

    provider = PolygonMarketDataProvider(
        api_key="test", client=_mock_polygon_client(handler)
    )
    snapshot = await provider.get_price_snapshot("AAPL")
    assert snapshot.price is None
    assert snapshot.provider == "polygon"


@pytest.mark.asyncio
async def test_polygon_returns_price_none_on_500() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, json={"error": "boom"})

    provider = PolygonMarketDataProvider(
        api_key="test", client=_mock_polygon_client(handler)
    )
    snapshot = await provider.get_price_snapshot("AAPL")
    assert snapshot.price is None


@pytest.mark.asyncio
async def test_polygon_candles_parse_aggs() -> None:
    base_ms = int(datetime(2026, 4, 1, tzinfo=timezone.utc).timestamp() * 1000)

    def handler(request: httpx.Request) -> httpx.Response:
        if "/range/" in request.url.path:
            return httpx.Response(
                200,
                json={
                    "results": [
                        {
                            "t": base_ms,
                            "o": 1.0,
                            "h": 2.0,
                            "l": 0.5,
                            "c": 1.5,
                            "v": 1000,
                        },
                        {
                            "t": base_ms + 86_400_000,
                            "o": 1.5,
                            "h": 2.2,
                            "l": 1.1,
                            "c": 2.0,
                            "v": 2000,
                        },
                    ]
                },
            )
        return httpx.Response(404)

    provider = PolygonMarketDataProvider(
        api_key="test", client=_mock_polygon_client(handler)
    )
    candles = await provider.get_candles(
        "AAPL", range="1mo", as_of=datetime(2030, 1, 1, tzinfo=timezone.utc)
    )
    assert len(candles) == 2
    assert candles[0].close == pytest.approx(1.5)
    assert candles[1].volume == pytest.approx(2000.0)


# -----------------------------------------------------------------------------
# AlphaVantage provider
# -----------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_alpha_vantage_snapshot_parses_global_quote() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "Global Quote": {
                    "01. symbol": "AAPL",
                    "05. price": "180.50",
                    "07. latest trading day": "2026-04-20",
                    "08. previous close": "179.00",
                }
            },
        )

    provider = AlphaVantageMarketDataProvider(
        api_key="test", client=_mock_polygon_client(handler)
    )
    snapshot = await provider.get_price_snapshot("AAPL")
    assert snapshot.price == pytest.approx(180.5)
    assert snapshot.previous_close == pytest.approx(179.0)
    assert snapshot.provider == "alphavantage"


@pytest.mark.asyncio
async def test_alpha_vantage_throttle_note_returns_price_none() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={"Note": "Thank you for using Alpha Vantage..."},
        )

    provider = AlphaVantageMarketDataProvider(
        api_key="test", client=_mock_polygon_client(handler)
    )
    snapshot = await provider.get_price_snapshot("AAPL")
    assert snapshot.price is None
    assert snapshot.provider == "alphavantage"


# -----------------------------------------------------------------------------
# Chained provider
# -----------------------------------------------------------------------------


class _StubProvider:
    def __init__(self, *, provider_id: str, price: float | None) -> None:
        self.provider_id = provider_id
        self._price = price
        self.calls = 0

    async def get_price_snapshot(
        self, symbol: str, *, as_of: datetime | None = None
    ) -> PriceSnapshot:
        self.calls += 1
        return PriceSnapshot(
            symbol=symbol,
            price=self._price,
            previous_close=None,
            as_of=datetime.now(timezone.utc),
            currency="USD",
            provider=self.provider_id,
        )

    async def get_previous_close(
        self, symbol: str, *, as_of: datetime | None = None
    ) -> float | None:
        return None

    async def get_snapshots(self, symbols, *, as_of=None):  # type: ignore[no-untyped-def]
        return {s: await self.get_price_snapshot(s, as_of=as_of) for s in symbols}

    async def get_candles(self, symbol, *, range="1y", as_of=None):  # type: ignore[no-untyped-def]
        return []

    async def aclose(self) -> None:
        return None


@pytest.mark.asyncio
async def test_chained_provider_falls_back_when_primary_returns_none() -> None:
    primary = _StubProvider(provider_id="polygon", price=None)
    fallback = _StubProvider(provider_id="alphavantage", price=42.0)
    chained = ChainedMarketDataProvider(primary=primary, fallback=fallback)
    snapshot = await chained.get_price_snapshot("AAPL")
    assert snapshot.price == pytest.approx(42.0)
    assert snapshot.provider == "alphavantage"
    assert primary.calls == 1
    assert fallback.calls == 1


@pytest.mark.asyncio
async def test_chained_provider_uses_primary_when_ok() -> None:
    primary = _StubProvider(provider_id="polygon", price=99.9)
    fallback = _StubProvider(provider_id="alphavantage", price=1.0)
    chained = ChainedMarketDataProvider(primary=primary, fallback=fallback)
    snapshot = await chained.get_price_snapshot("AAPL")
    assert snapshot.price == pytest.approx(99.9)
    assert primary.calls == 1
    assert fallback.calls == 0


# -----------------------------------------------------------------------------
# Factory / env routing
# -----------------------------------------------------------------------------


class _FakeSettings:
    def __init__(self, **fields: Any) -> None:
        self.__dict__.update(fields)


@pytest.mark.parametrize(
    "settings,expected_provider_id",
    [
        # Synthetic stays uncached — useful for tests + offline dev.
        (_FakeSettings(market_data_provider="synthetic"), "synthetic"),
        # Phase 19E.4 — Polygon is a first-class primary again. Without a
        # Polygon key the builder falls through to the AV path; with no
        # AV key either it ends in synthetic (no fabricated data).
        (_FakeSettings(market_data_provider="polygon"), "synthetic"),
        # Polygon key only → Polygon (cached), no fallback chain.
        (
            _FakeSettings(
                market_data_provider="polygon", polygon_api_key="x"
            ),
            "polygon+cache",
        ),
        # Both keys → Polygon primary, Alpha Vantage fallback chain.
        (
            _FakeSettings(
                market_data_provider="polygon",
                polygon_api_key="x",
                alpha_vantage_api_key="y",
            ),
            "polygon+alphavantage+cache",
        ),
        (
            _FakeSettings(
                market_data_provider="alphavantage",
                alpha_vantage_api_key="y",
            ),
            "alphavantage+cache",
        ),
    ],
)
def test_build_market_data_provider_env_routing(
    settings, expected_provider_id
) -> None:
    provider = build_market_data_provider(settings=settings)
    assert provider.provider_id == expected_provider_id


def test_build_market_data_provider_disable_cache() -> None:
    settings = _FakeSettings(
        market_data_provider="alphavantage", alpha_vantage_api_key="y"
    )
    provider = build_market_data_provider(settings=settings, enable_cache=False)
    assert provider.provider_id == "alphavantage"


def test_build_market_data_provider_unknown_choice_defaults_alphavantage() -> None:
    settings = _FakeSettings(
        market_data_provider="bogus", alpha_vantage_api_key="y"
    )
    provider = build_market_data_provider(settings=settings)
    assert provider.provider_id == "alphavantage+cache"
