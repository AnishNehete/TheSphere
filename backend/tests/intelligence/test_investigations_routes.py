"""HTTP coverage for the Phase 17B.1 saved-investigations routes.

Same setup as ``test_portfolio_routes.py``: a minimal FastAPI app with a
seeded :class:`IntelligenceRuntime`, the investigations router mounted,
and the FastAPI TestClient driving the surface end-to-end.
"""

from __future__ import annotations

from datetime import datetime, timezone

import pytest
import pytest_asyncio
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.intelligence.repositories.event_repository import InMemoryEventRepository
from app.intelligence.routes import investigations_router
from app.intelligence.runtime import IntelligenceRuntime
from app.intelligence.schemas import SignalEvent


@pytest_asyncio.fixture
async def app(sample_events: list[SignalEvent]) -> FastAPI:
    repo = InMemoryEventRepository()
    await repo.upsert_many(sample_events)
    runtime = IntelligenceRuntime.build_default(adapters=(), repository=repo)
    instance = FastAPI()
    instance.state.intelligence = runtime
    instance.include_router(investigations_router)
    return instance


@pytest.fixture
def client(app: FastAPI) -> TestClient:
    return TestClient(app)


def _snapshot_payload(symbol: str = "AAPL") -> dict:
    captured_at = datetime(2026, 4, 26, 12, 0, 0, tzinfo=timezone.utc).isoformat()
    return {
        "workspace_mode": "investigate",
        "selection": {
            "country_code": "USA",
            "country_name": "United States",
            "market_symbol": symbol,
            "market_asset_class": "equities",
        },
        "market_posture": None,
        "market_narrative": None,
        "compare_targets": [],
        "caveats": [],
        "provider_health_at_capture": "unconfigured",
        "freshness_seconds_at_capture": None,
        "captured_at": captured_at,
    }


def test_save_list_get_delete_round_trip(client: TestClient) -> None:
    create = client.post(
        "/api/intelligence/investigations",
        json={"name": "AAPL today", "snapshot": _snapshot_payload()},
    )
    assert create.status_code == 201, create.text
    body = create.json()
    investigation_id = body["id"]
    assert body["share_token"] is None
    assert body["snapshot"]["selection"]["market_symbol"] == "AAPL"

    listing = client.get("/api/intelligence/investigations").json()
    assert listing["total"] == 1
    assert listing["items"][0]["primary_label"] == "AAPL"
    assert listing["items"][0]["has_share"] is False

    detail = client.get(f"/api/intelligence/investigations/{investigation_id}")
    assert detail.status_code == 200
    assert detail.json()["id"] == investigation_id

    delete = client.delete(f"/api/intelligence/investigations/{investigation_id}")
    assert delete.status_code == 204
    assert (
        client.get(f"/api/intelligence/investigations/{investigation_id}").status_code
        == 404
    )


def test_share_token_lifecycle(client: TestClient) -> None:
    create = client.post(
        "/api/intelligence/investigations",
        json={"name": "Sharable", "snapshot": _snapshot_payload(symbol="MSFT")},
    ).json()
    investigation_id = create["id"]

    share = client.post(
        f"/api/intelligence/investigations/{investigation_id}/share"
    )
    assert share.status_code == 200, share.text
    token = share.json()["share_token"]
    assert token

    public = client.get(f"/api/intelligence/share/{token}")
    assert public.status_code == 200
    assert public.json()["id"] == investigation_id

    revoke = client.delete(
        f"/api/intelligence/investigations/{investigation_id}/share"
    )
    assert revoke.status_code == 200
    assert revoke.json()["share_token"] is None
    assert client.get(f"/api/intelligence/share/{token}").status_code == 404


def test_save_rejects_blank_name(client: TestClient) -> None:
    response = client.post(
        "/api/intelligence/investigations",
        json={"name": "   ", "snapshot": _snapshot_payload()},
    )
    # Blank name fails pydantic ``min_length=1`` (whitespace-only) at 422.
    # If the trimmed-name service guard fires first the response is also 422.
    assert response.status_code == 422


def test_unknown_share_token_returns_404(client: TestClient) -> None:
    response = client.get("/api/intelligence/share/nonexistent-token")
    assert response.status_code == 404


def test_unknown_investigation_returns_404(client: TestClient) -> None:
    assert client.get("/api/intelligence/investigations/missing").status_code == 404
    assert (
        client.delete("/api/intelligence/investigations/missing").status_code == 404
    )
    assert (
        client.post(
            "/api/intelligence/investigations/missing/share"
        ).status_code
        == 404
    )
