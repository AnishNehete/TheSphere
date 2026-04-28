"""Phase 17A.1 — contract tests for the market posture endpoint.

Verifies GET /api/intelligence/market/{symbol}/posture returns a typed
``MarketPosture`` envelope with bounded posture, signed tilt, drivers,
caveats. Uses ``SyntheticMarketDataProvider`` so it runs offline and is
deterministic.
"""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.intelligence.portfolio import PortfolioService
from app.intelligence.portfolio.market_data.synthetic import SyntheticMarketDataProvider
from app.intelligence.portfolio.posture.service import MarketPostureService
from app.intelligence.portfolio.repository import InMemoryPortfolioRepository
from app.intelligence.repositories.event_repository import InMemoryEventRepository
from app.intelligence.routes import intelligence_router, portfolios_router
from app.intelligence.runtime import IntelligenceRuntime


def _build_app() -> FastAPI:
    event_repo = InMemoryEventRepository()
    portfolio_repo = InMemoryPortfolioRepository()
    provider = SyntheticMarketDataProvider()

    portfolio_service = PortfolioService(
        repository=portfolio_repo,
        events_repository=event_repo,
        market_data_provider=provider,
    )

    runtime = IntelligenceRuntime.build_default(adapters=(), repository=event_repo)
    runtime.portfolio_service = portfolio_service
    runtime.market_data_provider = provider
    runtime.posture_service = MarketPostureService(
        market_data_provider=provider, events=event_repo
    )

    app = FastAPI()
    app.state.intelligence = runtime
    app.include_router(intelligence_router)
    app.include_router(portfolios_router)
    return app


@pytest.fixture
def client() -> TestClient:
    return TestClient(_build_app())


def test_posture_returns_typed_envelope(client: TestClient) -> None:
    resp = client.get("/api/intelligence/market/AAPL/posture")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["symbol"] == "AAPL"
    assert body["posture"] in {
        "strong_sell",
        "sell",
        "neutral",
        "buy",
        "strong_buy",
    }
    # bounded numerics
    assert -1.0 <= body["tilt"] <= 1.0
    assert -1.0 <= body["effective_tilt"] <= 1.0
    assert 0.0 <= body["confidence"] <= 1.0
    # components present
    assert "components" in body
    for key in ("technical", "semantic", "macro", "uncertainty"):
        assert key in body["components"]


def test_posture_normalizes_lowercase_symbol(client: TestClient) -> None:
    resp = client.get("/api/intelligence/market/aapl/posture")
    assert resp.status_code == 200, resp.text
    assert resp.json()["symbol"] == "AAPL"


def test_posture_accepts_asset_class_param(client: TestClient) -> None:
    resp = client.get(
        "/api/intelligence/market/EURUSD/posture",
        params={"asset_class": "fx"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["asset_class"] == "fx"


def test_posture_unknown_symbol_degrades_gracefully(client: TestClient) -> None:
    """Symbol the synthetic provider doesn't know — must not 5xx.

    We expect either an HTTP 200 with a Neutral posture + caveats, or an
    HTTP 200 with whatever the provider's synthetic fallback gives. Never
    a 500.
    """
    resp = client.get("/api/intelligence/market/__NEVER_HEARD_OF__/posture")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["symbol"] == "__NEVER_HEARD_OF__"
    assert body["posture"] in {
        "strong_sell",
        "sell",
        "neutral",
        "buy",
        "strong_buy",
    }


def test_posture_drivers_have_rationale_and_bounded_contribution(
    client: TestClient,
) -> None:
    resp = client.get("/api/intelligence/market/AAPL/posture")
    body = resp.json()
    for driver in body["drivers"]:
        assert driver["rationale"]
        assert -1.0 <= driver["signed_contribution"] <= 1.0
        assert driver["component"] in {"technical", "semantic", "macro"}


def test_posture_low_confidence_pins_neutral_when_pinning_triggers(
    client: TestClient,
) -> None:
    """With no events seeded and a synthetic-only run, confidence may be
    below the floor; if so, the posture must be Neutral with a note."""
    body = client.get("/api/intelligence/market/AAPL/posture").json()
    if body["confidence"] < 0.25:
        assert body["posture"] == "neutral"
        assert any("pinned neutral" in n.lower() for n in body["notes"])
