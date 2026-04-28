import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from app.api.routes import router
from app.db.postgres import PostgresStore
from app.db.redis import RedisStore
from app.intelligence.routes import (
    alerts_router,
    calibration_router,
    intelligence_router,
    investigations_router,
    portfolios_router,
)
from app.intelligence.runtime import IntelligenceRuntime
from app.security import InMemoryRateLimiter, RateLimiter, RedisRateLimiter
from app.services.data_simulator import SphereRuntime
from app.settings import Settings, get_intelligence_settings, get_settings
from app.websocket.manager import WebSocketManager


logger = logging.getLogger(__name__)


def _build_limiter(
    intelligence_settings, *, namespace: str, capacity: int
) -> RateLimiter:
    """Build a rate limiter keyed off ``intelligence_settings.redis_url``.

    Production mode (``env="production"``) without a Redis URL refuses
    to construct a limiter — restarts would silently reset the counters
    and a multi-replica deploy would stuff buckets with overlapping keys.
    """

    refill = float(capacity) / 3600.0
    redis_url = (intelligence_settings.redis_url or "").strip()
    is_prod = (intelligence_settings.env or "").lower() in ("production", "prod")
    if not redis_url:
        if is_prod:
            raise RuntimeError(
                "INTELLIGENCE_REDIS_URL is required in production. Rate "
                "limits would not survive a restart or replicate across "
                "replicas without it."
            )
        return InMemoryRateLimiter(
            capacity=capacity, refill_per_second=refill
        )

    from app.cache import build_redis_client

    client = build_redis_client(redis_url)
    return RedisRateLimiter(
        client,
        namespace=namespace,
        capacity=capacity,
        refill_per_second=refill,
    )


def create_app(settings: Settings | None = None) -> FastAPI:
    active_settings = settings or get_settings()
    intelligence_settings = get_intelligence_settings()
    ws_manager = WebSocketManager()
    runtime = SphereRuntime(
        redis_store=RedisStore(active_settings.redis_url),
        postgres_store=PostgresStore(active_settings.postgres_dsn),
        ws_manager=ws_manager,
        interval_ms=active_settings.simulation_interval_ms,
        enable_simulator=active_settings.enable_simulator,
    )
    intelligence = IntelligenceRuntime.build_default(settings=intelligence_settings)
    intelligence_interval = float(intelligence_settings.ingest_poll_seconds)

    # Phase 17C → 18A.3 — token-bucket rate limits, sized from settings.
    # Buckets are per-IP. The runtime selects in-memory vs Redis based on
    # ``intelligence_settings.redis_url``; the ``RateLimiter`` Protocol
    # keeps the routes implementation-agnostic.
    share_limiter = _build_limiter(
        intelligence_settings,
        namespace="share_read",
        capacity=intelligence_settings.share_read_rate_per_hour,
    )
    save_limiter = _build_limiter(
        intelligence_settings,
        namespace="investigation_save",
        capacity=intelligence_settings.investigation_save_rate_per_hour,
    )
    alert_create_limiter = _build_limiter(
        intelligence_settings,
        namespace="alert_create",
        capacity=intelligence_settings.alert_rule_create_rate_per_hour,
    )

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        app.state.runtime = runtime
        app.state.intelligence = intelligence
        await runtime.start()
        try:
            await intelligence.start(interval_seconds=intelligence_interval)
        except Exception as exc:  # pragma: no cover - defensive
            logger.exception("intelligence: failed to start background ingest: %s", exc)
        try:
            yield
        finally:
            try:
                await intelligence.stop()
            except Exception as exc:  # pragma: no cover - defensive
                logger.warning("intelligence: shutdown error: %s", exc)
            await runtime.stop()

    app = FastAPI(title=active_settings.app_name, lifespan=lifespan)
    # Phase 17C beta-hardening — explicit CORS allowlist instead of "*".
    # Settings.cors_origins always returns a concrete list (no wildcards)
    # built from SPHERE_FRONTEND_ORIGIN + SPHERE_FRONTEND_ORIGINS plus
    # localhost defaults; tightening for production is a single env var.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=active_settings.cors_origins,
        allow_origin_regex=active_settings.local_dev_origin_regex,
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    # Stash the rate limiters on app.state so router dependencies can
    # pick them up without re-instantiating per-request.
    app.state.share_limiter = share_limiter
    app.state.investigation_save_limiter = save_limiter
    app.state.alert_create_limiter = alert_create_limiter
    app.include_router(router)
    app.include_router(intelligence_router)
    app.include_router(portfolios_router)
    app.include_router(investigations_router)
    app.include_router(alerts_router)
    app.include_router(calibration_router)

    @app.websocket("/ws/live")
    async def live_socket(websocket: WebSocket):
        manager = app.state.runtime.ws_manager
        await manager.connect(websocket)
        try:
            await websocket.send_json(app.state.runtime.snapshot_envelope().model_dump(mode="json"))
            await websocket.send_json(app.state.runtime.telemetry_envelope().model_dump(mode="json"))
            await websocket.send_json(app.state.runtime.status_envelope().model_dump(mode="json"))
            while True:
                await websocket.receive_text()
        except (WebSocketDisconnect, RuntimeError, asyncio.CancelledError):
            manager.disconnect(websocket)

    return app


app = create_app()
