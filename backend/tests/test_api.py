from fastapi.testclient import TestClient

from app.main import create_app
from app.settings import Settings


def build_client() -> TestClient:
    app = create_app(
        Settings(
            redis_url=None,
            postgres_dsn=None,
            enable_simulator=False,
        )
    )
    return TestClient(app)


def test_health() -> None:
    with build_client() as client:
        response = client.get("/health")

    assert response.status_code == 200
    assert response.json()["status"] == "ok"


def test_events_returns_seeded_snapshot() -> None:
    with build_client() as client:
        response = client.get("/events", params={"layer": "flights", "limit": 3})

    body = response.json()
    assert response.status_code == 200
    assert len(body["items"]) == 3
    assert all(item["type"] == "flights" for item in body["items"])


def test_regions_returns_curated_regions() -> None:
    with build_client() as client:
        response = client.get("/regions")

    body = response.json()
    assert response.status_code == 200
    assert {item["slug"] for item in body["items"]} >= {"africa", "europe", "asia", "middle-east"}


def test_query_contract() -> None:
    with build_client() as client:
        response = client.post("/query", json={"input": "show africa conflict"})

    assert response.status_code == 200
    assert response.json() == {
        "layer": "conflict",
        "region": "africa",
        "entityId": None,
        "cameraPreset": "regional_focus",
        "action": "focus_region",
        "available": False,
    }
