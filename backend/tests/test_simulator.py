from app.db.postgres import PostgresStore
from app.db.redis import RedisStore
from app.services.data_simulator import SphereRuntime
from app.websocket.manager import WebSocketManager


class SpyRedis(RedisStore):
    def __init__(self) -> None:
        super().__init__(url=None)
        self.set_calls: list[tuple[str, dict]] = []
        self.publish_calls: list[tuple[str, dict]] = []
        self.connected = True

    async def connect(self) -> None:
        self.connected = True

    async def set_json(self, key: str, payload: dict) -> None:
        self.set_calls.append((key, payload))

    async def publish_json(self, channel: str, payload: dict) -> None:
        self.publish_calls.append((channel, payload))


class SpyPostgres(PostgresStore):
    def __init__(self) -> None:
        super().__init__(dsn=None)
        self.available = True
        self.persisted_events = []
        self.persisted_metrics = []

    async def init(self) -> None:
        self.available = True

    async def upsert_regions(self, regions) -> None:
        return

    async def persist_events(self, events) -> None:
        self.persisted_events = list(events)

    async def persist_metrics(self, metrics) -> None:
        self.persisted_metrics = list(metrics)


class SpyWebSocketManager(WebSocketManager):
    def __init__(self) -> None:
        super().__init__()
        self.messages: list[dict] = []

    async def broadcast(self, payload: dict) -> None:
        self.messages.append(payload)


async def test_runtime_step_publishes_and_persists() -> None:
    redis = SpyRedis()
    postgres = SpyPostgres()
    websocket = SpyWebSocketManager()
    runtime = SphereRuntime(
        redis_store=redis,
        postgres_store=postgres,
        ws_manager=websocket,
        interval_ms=2500,
        enable_simulator=False,
    )

    await runtime.start()

    assert len(runtime.latest_events) >= 1
    assert any(key == "live_events" for key, _ in redis.set_calls)
    assert any(channel == "sphere:events" for channel, _ in redis.publish_calls)
    assert len(postgres.persisted_events) == len(runtime.latest_events)
    assert [message["type"] for message in websocket.messages] == ["snapshot", "telemetry", "status"]
