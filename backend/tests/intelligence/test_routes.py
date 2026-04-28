"""HTTP route tests for the intelligence router.

These tests bypass the real app lifespan by constructing a minimal FastAPI
app with a pre-seeded ``IntelligenceRuntime`` (zero adapters → no background
poller, no network). The router itself is the production router.
"""

from __future__ import annotations

import pytest
import pytest_asyncio
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.intelligence.repositories.event_repository import InMemoryEventRepository
from app.intelligence.routes import intelligence_router
from app.intelligence.runtime import IntelligenceRuntime
from app.intelligence.schemas import SignalEvent


@pytest_asyncio.fixture
async def intelligence_app(sample_events: list[SignalEvent]) -> FastAPI:
    """FastAPI app with intelligence_router mounted over a seeded runtime."""

    repo = InMemoryEventRepository()
    await repo.upsert_many(sample_events)

    runtime = IntelligenceRuntime.build_default(adapters=(), repository=repo)

    app = FastAPI()
    app.state.intelligence = runtime
    app.include_router(intelligence_router)
    return app


@pytest.fixture
def client(intelligence_app: FastAPI) -> TestClient:
    return TestClient(intelligence_app)


def test_health_returns_ok_with_zero_adapters(client: TestClient) -> None:
    response = client.get("/api/intelligence/health")
    assert response.status_code == 200
    payload = response.json()
    # with no adapters there's nothing to be stale → overall ok
    assert payload["status"] == "ok"
    assert payload["adapters"] == []
    assert payload["totalCycles"] == 0


def test_latest_events_returns_seeded_events(client: TestClient) -> None:
    response = client.get("/api/intelligence/events/latest", params={"limit": 10})
    assert response.status_code == 200
    payload = response.json()
    assert payload["total"] == 5
    assert len(payload["items"]) == 5


def test_latest_events_filters_by_category(client: TestClient) -> None:
    response = client.get(
        "/api/intelligence/events/latest",
        params={"category": "weather", "limit": 10},
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["total"] == 1
    assert payload["items"][0]["id"] == "wx-usa-1"


def test_events_by_country_returns_usa_events(client: TestClient) -> None:
    response = client.get(
        "/api/intelligence/events/by-country", params={"code": "USA"}
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["total"] == 2
    ids = {item["id"] for item in payload["items"]}
    assert ids == {"wx-usa-1", "nw-usa-1"}


def test_events_by_country_rejects_unknown_code(client: TestClient) -> None:
    response = client.get(
        "/api/intelligence/events/by-country", params={"code": "ZZZ"}
    )
    assert response.status_code == 404


def test_search_route_resolves_country_and_returns_hits(client: TestClient) -> None:
    response = client.get(
        "/api/intelligence/search", params={"q": "storm", "country": "USA"}
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["resolved_country_code"] == "USA"
    assert payload["total"] >= 1
    assert any(hit["event"]["id"] == "wx-usa-1" for hit in payload["hits"])


def test_search_route_rejects_unknown_country(client: TestClient) -> None:
    response = client.get(
        "/api/intelligence/search", params={"q": "storm", "country": "ZZZ"}
    )
    assert response.status_code == 404


def test_country_detail_returns_summary_and_events(client: TestClient) -> None:
    response = client.get("/api/intelligence/country/USA")
    assert response.status_code == 200
    payload = response.json()
    assert payload["summary"]["country_code"] == "USA"
    assert payload["summary"]["watch_score"] >= 0.0
    ids = {event["id"] for event in payload["events"]}
    assert ids == {"wx-usa-1", "nw-usa-1"}


def test_country_detail_returns_404_for_unknown_country(
    client: TestClient,
) -> None:
    response = client.get("/api/intelligence/country/ZZZ")
    assert response.status_code == 404


def test_country_detail_builds_zero_score_summary_for_empty_repo() -> None:
    # With a known country but no events, build_one yields a zero-score summary
    # rather than None — the route should still 200 with an empty event list.
    empty_runtime = IntelligenceRuntime.build_default(
        adapters=(), repository=InMemoryEventRepository()
    )
    app = FastAPI()
    app.state.intelligence = empty_runtime
    app.include_router(intelligence_router)

    with TestClient(app) as client:
        response = client.get("/api/intelligence/country/USA")
        assert response.status_code == 200
        payload = response.json()
        assert payload["summary"]["country_code"] == "USA"
        assert payload["summary"]["watch_score"] == 0.0
        assert payload["events"] == []


def test_runtime_missing_returns_503() -> None:
    app = FastAPI()
    # deliberately do not set app.state.intelligence
    app.include_router(intelligence_router)

    with TestClient(app) as client:
        response = client.get("/api/intelligence/health")
        assert response.status_code == 503
