from fastapi import APIRouter, Depends, Query, Request

from app.models.schemas import EventsResponse, QueryRequest, QueryResult, RegionsResponse
from app.services.data_simulator import SphereRuntime


router = APIRouter()


def get_runtime(request: Request) -> SphereRuntime:
    return request.app.state.runtime


@router.get("/health")
async def health(runtime: SphereRuntime = Depends(get_runtime)) -> dict[str, str]:
    return {
        "status": "ok",
        "redis": "active" if runtime.redis.connected else "degraded",
        "postgres": "active" if runtime.postgres.available else "degraded",
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
