"""HTTP coverage for the Phase 17C.1 alerts routes."""

from __future__ import annotations

import pytest
import pytest_asyncio
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.intelligence.repositories.event_repository import InMemoryEventRepository
from app.intelligence.routes import alerts_router
from app.intelligence.runtime import IntelligenceRuntime
from app.intelligence.schemas import SignalEvent


@pytest_asyncio.fixture
async def app(sample_events: list[SignalEvent]) -> FastAPI:
    repo = InMemoryEventRepository()
    await repo.upsert_many(sample_events)
    runtime = IntelligenceRuntime.build_default(adapters=(), repository=repo)
    instance = FastAPI()
    instance.state.intelligence = runtime
    instance.include_router(alerts_router)
    return instance


@pytest.fixture
def client(app: FastAPI) -> TestClient:
    return TestClient(app)


def test_create_list_delete_rule(client: TestClient) -> None:
    create = client.post(
        "/api/intelligence/alerts/rules",
        json={
            "name": "AAPL band change",
            "kind": "posture_band_change",
            "symbol": "AAPL",
            "asset_class": "equities",
        },
    )
    assert create.status_code == 201, create.text
    rule = create.json()
    assert rule["symbol"] == "AAPL"
    assert rule["cooldown_seconds"] == 30 * 60

    listing = client.get("/api/intelligence/alerts/rules").json()
    assert listing["total"] == 1
    assert listing["items"][0]["id"] == rule["id"]

    delete = client.delete(f"/api/intelligence/alerts/rules/{rule['id']}")
    assert delete.status_code == 204
    assert client.get("/api/intelligence/alerts/rules").json()["total"] == 0


def test_confidence_drop_threshold_defaulted_at_create(client: TestClient) -> None:
    create = client.post(
        "/api/intelligence/alerts/rules",
        json={
            "name": "AAPL conf",
            "kind": "confidence_drop",
            "symbol": "AAPL",
        },
    ).json()
    assert create["threshold"] == 0.30


def test_create_rejects_blank_name(client: TestClient) -> None:
    response = client.post(
        "/api/intelligence/alerts/rules",
        json={
            "name": "",
            "kind": "posture_band_change",
            "symbol": "AAPL",
        },
    )
    assert response.status_code == 422


def test_delete_unknown_rule_returns_404(client: TestClient) -> None:
    assert (
        client.delete("/api/intelligence/alerts/rules/missing").status_code == 404
    )


def test_events_since_cursor_returns_empty_when_no_events(client: TestClient) -> None:
    response = client.get(
        "/api/intelligence/alerts/events",
        params={"since": "2026-04-26T12:00:00Z"},
    )
    assert response.status_code == 200
    assert response.json()["total"] == 0


def test_events_limit_param_validation(client: TestClient) -> None:
    bad = client.get("/api/intelligence/alerts/events", params={"limit": 0})
    assert bad.status_code == 422
    too_big = client.get("/api/intelligence/alerts/events", params={"limit": 999})
    assert too_big.status_code == 422
