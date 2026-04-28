from fastapi import APIRouter, Depends, Query, Request

from app.intelligence.runtime import IntelligenceRuntime
from app.models.schemas import EventsResponse, QueryRequest, QueryResult, RegionsResponse
from app.services.data_simulator import SphereRuntime
from app.settings import (
    INTELLIGENCE_DOMAINS,
    IntelligenceSettings,
    get_intelligence_settings,
)


router = APIRouter()


def get_runtime(request: Request) -> SphereRuntime:
    return request.app.state.runtime


def get_intelligence_runtime(request: Request) -> IntelligenceRuntime | None:
    return getattr(request.app.state, "intelligence", None)


@router.get("/health")
async def health(runtime: SphereRuntime = Depends(get_runtime)) -> dict[str, str]:
    return {
        "status": "ok",
        "redis": "active" if runtime.redis.connected else "degraded",
        "postgres": "active" if runtime.postgres.available else "degraded",
    }


@router.get("/api/status")
@router.get("/api/integrations/status")
async def integrations_status(
    runtime: SphereRuntime = Depends(get_runtime),
    intelligence: IntelligenceRuntime | None = Depends(get_intelligence_runtime),
) -> dict[str, object]:
    """Operator-facing snapshot of every external dependency.

    Reports binary connection state for Postgres / Redis and a configured /
    missing flag per provider domain. Never returns API keys or other secrets.
    """

    intelligence_settings: IntelligenceSettings = get_intelligence_settings()

    integrations: dict[str, str] = {
        "database": "connected" if runtime.postgres.available else "not_connected",
        "redis": "connected" if runtime.redis.connected else "not_connected",
    }

    for domain in INTELLIGENCE_DOMAINS:
        config = intelligence_settings.provider_config(domain)
        if not config.enabled:
            integrations[f"{domain}_api"] = "disabled"
        elif config.has_api_key:
            integrations[f"{domain}_api"] = "configured"
        else:
            integrations[f"{domain}_api"] = "missing"

    integrations["market_api"] = (
        "configured"
        if (
            intelligence_settings.alpha_vantage_api_key
            or intelligence_settings.polygon_api_key
        )
        else "missing"
    )
    integrations["anthropic_api"] = (
        "configured" if intelligence_settings.anthropic_api_key else "missing"
    )

    intelligence_ready = intelligence is not None

    return {
        "status": "ok",
        "intelligence_ready": intelligence_ready,
        "offline_fallback_enabled": intelligence_settings.enable_offline_fallback,
        "integrations": integrations,
    }


@router.get("/events", response_model=EventsResponse)
async def get_events(
    layer: str = Query(default="flights"),
    region: str | None = Query(default=None),
    limit: int = Query(default=200, ge=1, le=500),
    runtime: SphereRuntime = Depends(get_runtime),
) -> EventsResponse:
    return EventsResponse(items=runtime.list_events(layer=layer, region=region, limit=limit))


@router.get("/regions", response_model=RegionsResponse)
async def get_regions(runtime: SphereRuntime = Depends(get_runtime)) -> RegionsResponse:
    return RegionsResponse(items=runtime.list_regions())


@router.post("/query", response_model=QueryResult)
async def post_query(payload: QueryRequest, runtime: SphereRuntime = Depends(get_runtime)) -> QueryResult:
    return runtime.parse_query(payload.input)
