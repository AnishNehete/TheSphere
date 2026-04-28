"""Lifespan / runtime wiring sanity for the intelligence backbone.

Verifies that ``create_app`` installs an ``IntelligenceRuntime`` on
``app.state.intelligence`` and that the router resolves it through the full
FastAPI lifespan — without letting adapters reach the network.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.intelligence.runtime import IntelligenceRuntime
from app.main import create_app
from app.settings import Settings


@pytest.fixture(autouse=True)
def patch_intelligence_lifecycle(monkeypatch: pytest.MonkeyPatch) -> None:
    """Replace background-start/stop with no-ops so tests don't hit the network."""

    async def noop_start(self: IntelligenceRuntime, **kwargs: object) -> None:
        return None

    async def noop_stop(self: IntelligenceRuntime) -> None:
        return None

    monkeypatch.setattr(IntelligenceRuntime, "start", noop_start, raising=True)
    monkeypatch.setattr(IntelligenceRuntime, "stop", noop_stop, raising=True)


def _minimal_settings() -> Settings:
    return Settings(
        redis_url=None,
        postgres_dsn=None,
        enable_simulator=False,
    )


def test_create_app_wires_intelligence_runtime_on_app_state() -> None:
    app = create_app(_minimal_settings())

    with TestClient(app) as client:
        runtime = getattr(client.app.state, "intelligence", None)
        assert runtime is not None
        assert isinstance(runtime, IntelligenceRuntime)
        # runtime builds a full adapter set by default
        assert runtime.adapters, "default runtime should register adapters"


def test_intelligence_health_route_is_reachable_through_lifespan() -> None:
    app = create_app(_minimal_settings())

    with TestClient(app) as client:
        response = client.get("/api/intelligence/health")
        assert response.status_code == 200
        payload = response.json()
        # no cycles run (start was patched), so totalCycles is zero
        assert payload["totalCycles"] == 0
        # default adapters are registered even if they haven't polled yet
        assert len(payload["adapters"]) >= 1


def test_intelligence_search_route_is_reachable_through_lifespan() -> None:
    app = create_app(_minimal_settings())

    with TestClient(app) as client:
        response = client.get("/api/intelligence/search", params={"q": ""})
        assert response.status_code == 200
        payload = response.json()
        assert payload["total"] == 0
        assert payload["hits"] == []
