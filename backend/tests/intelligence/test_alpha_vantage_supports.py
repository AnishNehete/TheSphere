"""Phase 17A.2 — honest asset-class classification + AV-only routing.

The previous Polygon → AV chain is gone. Every live request now lands
on Alpha Vantage. Alpha Vantage does not cover continuous-curve futures
(``ES``, ``NQ``, etc.) — the provider must say so explicitly rather
than emit an empty 200 that looks like a failed call.

Verifies:
* ``classify_symbol`` recognizes equities / FX / unsupported futures.
* Snapshot/candles for an unsupported root return ``price=None`` /
  ``[]`` *without* hitting the upstream URL.
* FX_DAILY parsing yields a clean candle series.
"""

from __future__ import annotations

import httpx
import pytest

from app.intelligence.portfolio.market_data.alpha_vantage import (
    AlphaVantageMarketDataProvider,
)


def _client(handler) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


def test_classify_equity_fx_and_futures_roots() -> None:
    cls = AlphaVantageMarketDataProvider.classify_symbol
    assert cls("AAPL") == "equity"
    assert cls("EURUSD") == "fx"
    assert cls("GBPUSD") == "fx"
    assert cls("ES") == "futures"
    assert cls("NQ") == "futures"
    assert cls("ZN") == "futures"
    assert cls("") == "unknown"


@pytest.mark.asyncio
async def test_unsupported_futures_returns_price_none_without_upstream_call() -> None:
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(str(request.url))
        return httpx.Response(200, json={})

    provider = AlphaVantageMarketDataProvider(
        api_key="key", client=_client(handler)
    )
    snap = await provider.get_price_snapshot("ES")
    candles = await provider.get_candles("ES", range="1y")
    assert snap.price is None
    assert snap.provider == "alphavantage"
    assert candles == []
    assert calls == [], "AV should not be called for unsupported futures roots"


@pytest.mark.asyncio
async def test_fx_daily_candles_parse() -> None:
    payload = {
        "Time Series FX (Daily)": {
            "2026-04-25": {
                "1. open": "1.10",
                "2. high": "1.12",
                "3. low": "1.09",
                "4. close": "1.11",
                "5. volume": "0",
            },
            "2026-04-24": {
                "1. open": "1.09",
                "2. high": "1.10",
                "3. low": "1.08",
                "4. close": "1.10",
                "5. volume": "0",
            },
        }
    }

    def handler(request: httpx.Request) -> httpx.Response:
        params = dict(request.url.params)
        if params.get("function") == "FX_DAILY":
            return httpx.Response(200, json=payload)
        return httpx.Response(404, json={})

    provider = AlphaVantageMarketDataProvider(
        api_key="key", client=_client(handler)
    )
    candles = await provider.get_candles("EURUSD", range="1mo")
    assert len(candles) == 2
    assert candles[0].close == pytest.approx(1.10)
    assert candles[-1].close == pytest.approx(1.11)


@pytest.mark.asyncio
async def test_fx_throttle_returns_empty_candles() -> None:
    payload = {"Note": "Thank you for using Alpha Vantage."}

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=payload)

    provider = AlphaVantageMarketDataProvider(
        api_key="key", client=_client(handler)
    )
    candles = await provider.get_candles("EURUSD", range="1mo")
    assert candles == []
