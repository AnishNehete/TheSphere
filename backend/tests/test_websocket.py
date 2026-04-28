from fastapi.testclient import TestClient

from app.main import create_app
from app.settings import Settings


def test_live_websocket_emits_snapshot_and_status() -> None:
    app = create_app(Settings(redis_url=None, postgres_dsn=None, enable_simulator=False))

    with TestClient(app) as client:
        with client.websocket_connect("/ws/live") as websocket:
            snapshot = websocket.receive_json()
            telemetry = websocket.receive_json()
            status = websocket.receive_json()

    assert snapshot["type"] == "snapshot"
    assert snapshot["channel"] == "sphere:events"
    assert len(snapshot["payload"]["items"]) >= 1
    assert telemetry["type"] == "telemetry"
    assert status["type"] == "status"
