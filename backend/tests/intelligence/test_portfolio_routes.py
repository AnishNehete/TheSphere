"""HTTP coverage for the Phase 13A portfolio routes.

Same pattern as ``test_routes.py``: build a minimal FastAPI app with a
seeded :class:`IntelligenceRuntime`, mount both intelligence and portfolio
routers, and drive the API surface with FastAPI's TestClient.
"""

from __future__ import annotations

import pytest
import pytest_asyncio
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.intelligence.repositories.event_repository import InMemoryEventRepository
from app.intelligence.routes import intelligence_router, portfolios_router
from app.intelligence.runtime import IntelligenceRuntime
from app.intelligence.schemas import SignalEvent


@pytest_asyncio.fixture
async def app(sample_events: list[SignalEvent]) -> FastAPI:
    repo = InMemoryEventRepository()
    await repo.upsert_many(sample_events)
    runtime = IntelligenceRuntime.build_default(adapters=(), repository=repo)
    instance = FastAPI()
    instance.state.intelligence = runtime
    instance.include_router(intelligence_router)
    instance.include_router(portfolios_router)
    return instance


@pytest.fixture
def client(app: FastAPI) -> TestClient:
    return TestClient(app)


def test_portfolio_lifecycle(client: TestClient) -> None:
    # create
    response = client.post(
        "/api/intelligence/portfolios",
        json={
            "name": "API portfolio",
            "base_currency": "USD",
            "holdings": [
                {"symbol": "AAPL", "quantity": 5, "average_cost": 180},
                {"symbol": "7203.T", "quantity": 10, "average_cost": 2000},
            ],
        },
    )
    assert response.status_code == 201, response.text
    record = response.json()
    portfolio_id = record["id"]
    assert len(record["holdings"]) == 2

    # list
    listing = client.get("/api/intelligence/portfolios").json()
    assert listing["total"] == 1

    # patch
    patched = client.patch(
        f"/api/intelligence/portfolios/{portfolio_id}",
        json={"name": "Renamed", "tags": ["core"]},
    ).json()
    assert patched["name"] == "Renamed"
    assert patched["tags"] == ["core"]

    # add holdings
    appended = client.post(
        f"/api/intelligence/portfolios/{portfolio_id}/holdings",
        json=[{"symbol": "MSFT", "quantity": 3}],
    ).json()
    assert {h["symbol"] for h in appended["holdings"]} == {"AAPL", "7203.T", "MSFT"}

    # csv import
    csv_resp = client.post(
        f"/api/intelligence/portfolios/{portfolio_id}/holdings/csv",
        json={"csv": "symbol,quantity\nNVDA,2\n,4\n"},
    )
    assert csv_resp.status_code == 200, csv_resp.text
    csv_payload = csv_resp.json()
    assert any(h["symbol"] == "NVDA" for h in csv_payload["portfolio"]["holdings"])
    assert csv_payload["skipped_rows"] and csv_payload["skipped_rows"][0]["reason"] == "missing symbol"

    # brief
    brief = client.get(f"/api/intelligence/portfolios/{portfolio_id}/brief").json()
    assert brief["holdings_count"] == 4
    assert brief["exposure_summary"]["countries"]
    assert brief["entity"]["primary_country_codes"]

    # delete
    delete_resp = client.delete(f"/api/intelligence/portfolios/{portfolio_id}")
    assert delete_resp.status_code == 204
    assert client.get(f"/api/intelligence/portfolios/{portfolio_id}").status_code == 404


def test_create_portfolio_requires_name(client: TestClient) -> None:
    response = client.post(
        "/api/intelligence/portfolios",
        json={"name": "   ", "holdings": []},
    )
    assert response.status_code == 422


def test_csv_bad_header_returns_400(client: TestClient) -> None:
    create = client.post(
        "/api/intelligence/portfolios",
        json={"name": "csvtest", "holdings": []},
    ).json()
    response = client.post(
        f"/api/intelligence/portfolios/{create['id']}/holdings/csv",
        json={"csv": "AAPL,10\nMSFT,5"},
    )
    assert response.status_code == 400


def test_watchlist_lifecycle_and_conversion(client: TestClient) -> None:
    create = client.post(
        "/api/intelligence/watchlists",
        json={
            "name": "Asia tech",
            "symbols": ["aapl", "tsm", "asml"],
            "countries": ["jpn", "twn"],
            "topics": ["semiconductors"],
        },
    ).json()
    assert create["symbols"] == ["AAPL", "TSM", "ASML"]
    listing = client.get("/api/intelligence/watchlists").json()
    assert listing["total"] == 1

    converted = client.post(
        f"/api/intelligence/watchlists/{create['id']}/convert-to-portfolio",
        json={"name": "Asia tech (port)"},
    )
    assert converted.status_code == 201, converted.text
    portfolio = converted.json()
    assert portfolio["name"] == "Asia tech (port)"
    assert {h["symbol"] for h in portfolio["holdings"]} == {"AAPL", "TSM", "ASML"}
    assert "from-watchlist" in portfolio["tags"]


def test_unknown_portfolio_returns_404(client: TestClient) -> None:
    response = client.get("/api/intelligence/portfolios/missing")
    assert response.status_code == 404
    response = client.get("/api/intelligence/portfolios/missing/brief")
    assert response.status_code == 404
