"""Phase 13B.5 — Contract tests for the candle endpoint.

Verifies GET /portfolios/{id}/holdings/{symbol}/candles returns correctly
shaped list[Candle] via SyntheticMarketDataProvider, range/as_of params
are respected, and ownership validation returns 404 for invalid cases.
"""

from __future__ import annotations

from datetime import datetime, timezone

import pytest
import pytest_asyncio
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.intelligence.portfolio import (
    PortfolioCreateRequest,
    PortfolioService,
)
from app.intelligence.portfolio.market_data.synthetic import SyntheticMarketDataProvider
from app.intelligence.portfolio.repository import InMemoryPortfolioRepository
from app.intelligence.repositories.event_repository import InMemoryEventRepository
from app.intelligence.routes import intelligence_router, portfolios_router
from app.intelligence.runtime import IntelligenceRuntime


NOW = datetime(2026, 4, 23, 12, 0, tzinfo=timezone.utc)


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------


def _build_synth_app() -> FastAPI:
    """Build a minimal FastAPI app with SyntheticMarketDataProvider wired."""
    event_repo = InMemoryEventRepository()
    portfolio_repo = InMemoryPortfolioRepository()
    provider = SyntheticMarketDataProvider()

    portfolio_service = PortfolioService(
        repository=portfolio_repo,
        events_repository=event_repo,
        market_data_provider=provider,
    )

    # We still need a full runtime so the route dependency works.
    runtime = IntelligenceRuntime.build_default(adapters=(), repository=event_repo)
    # Swap in our synthetic-wired portfolio service.
    runtime.portfolio_service = portfolio_service

    app = FastAPI()
    app.state.intelligence = runtime
    app.include_router(intelligence_router)
    app.include_router(portfolios_router)
    return app


@pytest.fixture
def client_synth() -> TestClient:
    return TestClient(_build_synth_app())


def _create_demo_portfolio(client: TestClient) -> str:
    """Create a portfolio with AAPL + MSFT and return its id."""
    resp = client.post(
        "/api/intelligence/portfolios",
        json={
            "name": "Demo",
            "holdings": [
                {"symbol": "AAPL", "quantity": 10},
                {"symbol": "MSFT", "quantity": 5},
            ],
        },
    )
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


# ---------------------------------------------------------------------------
# tests
# ---------------------------------------------------------------------------


def test_candles_returns_200_for_owned_symbol(client_synth: TestClient) -> None:
    portfolio_id = _create_demo_portfolio(client_synth)
    resp = client_synth.get(
        f"/api/intelligence/portfolios/{portfolio_id}/holdings/AAPL/candles"
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert "candles" in body
    candles = body["candles"]
    assert len(candles) > 0
    first = candles[0]
    for field in ("timestamp", "open", "high", "low", "close", "volume"):
        assert field in first, f"Missing field: {field}"


def test_candles_default_range_is_1y(client_synth: TestClient) -> None:
    portfolio_id = _create_demo_portfolio(client_synth)
    resp = client_synth.get(
        f"/api/intelligence/portfolios/{portfolio_id}/holdings/AAPL/candles"
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["range"] == "1y"


def test_candles_respects_range_query(client_synth: TestClient) -> None:
    portfolio_id = _create_demo_portfolio(client_synth)

    resp_1y = client_synth.get(
        f"/api/intelligence/portfolios/{portfolio_id}/holdings/AAPL/candles",
        params={"range": "1y"},
    )
    resp_3mo = client_synth.get(
        f"/api/intelligence/portfolios/{portfolio_id}/holdings/AAPL/candles",
        params={"range": "3mo"},
    )
    assert resp_1y.status_code == 200, resp_1y.text
    assert resp_3mo.status_code == 200, resp_3mo.text

    candles_1y = resp_1y.json()["candles"]
    candles_3mo = resp_3mo.json()["candles"]
    assert len(candles_3mo) < len(candles_1y), (
        f"3mo should have fewer candles than 1y; got {len(candles_3mo)} vs {len(candles_1y)}"
    )


def test_candles_respects_as_of_query(client_synth: TestClient) -> None:
    portfolio_id = _create_demo_portfolio(client_synth)
    as_of = "2026-04-01T00:00:00Z"
    resp = client_synth.get(
        f"/api/intelligence/portfolios/{portfolio_id}/holdings/AAPL/candles",
        params={"as_of": as_of},
    )
    assert resp.status_code == 200, resp.text
    candles = resp.json()["candles"]
    cutoff = datetime(2026, 4, 1, 0, 0, 0, tzinfo=timezone.utc)
    for candle in candles:
        ts_str = candle["timestamp"]
        # Handle both +00:00 and Z suffixes
        if ts_str.endswith("Z"):
            ts_str = ts_str[:-1] + "+00:00"
        ts = datetime.fromisoformat(ts_str)
        if ts.tzinfo is None:
            ts = ts.replace(tzinfo=timezone.utc)
        assert ts <= cutoff, f"Candle timestamp {ts} is after as_of {cutoff}"


def test_candles_404_for_unknown_portfolio(client_synth: TestClient) -> None:
    resp = client_synth.get(
        "/api/intelligence/portfolios/nonexistent-id/holdings/AAPL/candles"
    )
    assert resp.status_code == 404


def test_candles_404_for_symbol_not_in_portfolio(client_synth: TestClient) -> None:
    portfolio_id = _create_demo_portfolio(client_synth)
    resp = client_synth.get(
        f"/api/intelligence/portfolios/{portfolio_id}/holdings/TSLA/candles"
    )
    assert resp.status_code == 404


def test_candles_response_provider_reflects_runtime(client_synth: TestClient) -> None:
    portfolio_id = _create_demo_portfolio(client_synth)
    resp = client_synth.get(
        f"/api/intelligence/portfolios/{portfolio_id}/holdings/AAPL/candles"
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["provider"] == "synthetic"
