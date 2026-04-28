"""Analyst-facing HTTP routes for Sphere's live intelligence backbone.

All endpoints return canonical :class:`SignalEvent` / :class:`CountrySignalSummary`
payloads — provider shapes never leak through.

Endpoints:
* ``GET  /api/intelligence/events/latest``          — latest normalized events
* ``GET  /api/intelligence/events/by-country``      — events for an ISO-3 country
* ``GET  /api/intelligence/search``                 — text + filter search
* ``GET  /api/intelligence/country/{code}``         — aggregated country summary
* ``GET  /api/intelligence/health``                 — adapter + ingest health
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from pydantic import BaseModel

from app.intelligence.adapters.country_lookup import lookup_by_alpha3
from app.intelligence.geo.resolver import place_resolver
from app.intelligence.runtime import IntelligenceRuntime
from app.intelligence.schemas import (
    AgentResponse,
    CompareResponse,
    CountrySignalSummary,
    DependencyResponse,
    SignalCategory,
    SignalEvent,
)
from app.intelligence.services import CompareRequest


router = APIRouter(prefix="/api/intelligence", tags=["intelligence"])


def get_runtime(request: Request) -> IntelligenceRuntime:
    runtime = getattr(request.app.state, "intelligence", None)
    if runtime is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Intelligence runtime is not ready yet.",
        )
    return runtime


class EventsResponse(BaseModel):
    total: int
    items: list[SignalEvent]


class SearchHitModel(BaseModel):
    event: SignalEvent
    score: float
    matched_terms: list[str]


class SearchResponseModel(BaseModel):
    query: str
    resolved_country_code: str | None
    total: int
    hits: list[SearchHitModel]


class CountryDetailResponse(BaseModel):
    summary: CountrySignalSummary
    events: list[SignalEvent]


class AdapterHealthModel(BaseModel):
    adapter: str
    category: SignalCategory
    lastSuccessAt: str | None
    lastFailureAt: str | None
    lastError: str | None
    consecutiveFailures: int
    lastItemCount: int
    stale: bool
    domain: str | None = None
    enabled: bool = True
    provider: str | None = None
    hasApiKey: bool = False
    baseUrl: str | None = None
    configured: bool = True


class PersistenceHealthModel(BaseModel):
    investigations: str
    alerts: str
    queryLog: str
    marketDataProvider: str


class HealthResponse(BaseModel):
    status: str
    totalCycles: int
    totalEventsIngested: int
    lastCycle: dict | None
    adapters: list[AdapterHealthModel]
    persistence: PersistenceHealthModel


@router.get("/events/latest", response_model=EventsResponse)
async def latest_events(
    runtime: Annotated[IntelligenceRuntime, Depends(get_runtime)],
    category: SignalCategory | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=200),
) -> EventsResponse:
    categories = (category,) if category else None
    events = await runtime.repository.latest(limit=limit, categories=categories)
    return EventsResponse(total=len(events), items=events)


@router.get("/events/by-country", response_model=EventsResponse)
async def events_by_country(
    runtime: Annotated[IntelligenceRuntime, Depends(get_runtime)],
    code: str = Query(..., min_length=2, max_length=3, description="ISO-3166 alpha-3"),
    limit: int = Query(default=50, ge=1, le=200),
) -> EventsResponse:
    meta = lookup_by_alpha3(code)
    if meta is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Unknown country code: {code}",
        )
    events = await runtime.repository.by_country(meta.code, limit=limit)
    return EventsResponse(total=len(events), items=events)


@router.get("/search", response_model=SearchResponseModel)
async def search(
    runtime: Annotated[IntelligenceRuntime, Depends(get_runtime)],
    q: str = Query(default="", description="Free-text query"),
    category: SignalCategory | None = Query(default=None),
    country: str | None = Query(default=None, min_length=2, max_length=3),
    limit: int = Query(default=25, ge=1, le=100),
) -> SearchResponseModel:
    resolved_country = None
    if country:
        meta = lookup_by_alpha3(country)
        if meta is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Unknown country code: {country}",
            )
        resolved_country = meta.code

    response = await runtime.search_service.search(
        query=q,
        categories=(category,) if category else None,
        country_code=resolved_country,
        limit=limit,
    )
    return SearchResponseModel(
        query=response.query,
        resolved_country_code=response.resolved_country_code,
        total=response.total,
        hits=[
            SearchHitModel(
                event=hit.event,
                score=hit.score,
                matched_terms=hit.matched_terms,
            )
            for hit in response.hits
        ],
    )


@router.get("/country/{code}", response_model=CountryDetailResponse)
async def country_detail(
    code: str,
    runtime: Annotated[IntelligenceRuntime, Depends(get_runtime)],
    events_limit: int = Query(default=25, ge=1, le=200),
) -> CountryDetailResponse:
    meta = lookup_by_alpha3(code)
    if meta is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Unknown country code: {code}",
        )

    events = await runtime.repository.by_country(meta.code, limit=events_limit)

    summary = await runtime.repository.get_country_summary(meta.code)
    if summary is None:
        summary = runtime.summary_service.build_one(meta.code, events)
    if summary is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"No intelligence data available for {meta.code} yet.",
        )

    return CountryDetailResponse(summary=summary, events=events)


@router.get("/health", response_model=HealthResponse)
async def intelligence_health(
    runtime: Annotated[IntelligenceRuntime, Depends(get_runtime)],
) -> HealthResponse:
    state = runtime.ingest_service.state
    adapter_models: list[AdapterHealthModel] = []
    any_stale = False
    for adapter in runtime.adapters:
        health_payload: dict = adapter.health.to_dict()
        config = adapter.provider_config
        if config is not None:
            health_payload.update(config.to_public_dict())
        else:
            health_payload.update(
                {
                    "domain": getattr(adapter, "domain", "") or None,
                    "enabled": True,
                    "provider": None,
                    "baseUrl": None,
                    "hasApiKey": False,
                    "configured": True,
                }
            )
        if health_payload.get("stale"):
            any_stale = True
        adapter_models.append(AdapterHealthModel(**health_payload))
    persistence = PersistenceHealthModel(
        investigations=type(runtime.investigation_repository).__name__,
        alerts=type(runtime.alert_repository).__name__,
        queryLog=(
            type(runtime.query_log_repository).__name__
            if runtime.query_log_repository is not None
            else "None"
        ),
        marketDataProvider=(
            type(runtime.market_data_provider).__name__
            if runtime.market_data_provider is not None
            else "None"
        ),
    )
    # Health status reflects adapter freshness only. Persistence layer
    # types are surfaced in `persistence` so the frontend can show its
    # own in-memory / synthetic chip without forcing the whole status
    # to "degraded" for what is, in dev mode, a valid configuration.
    return HealthResponse(
        status="ok" if not any_stale else "degraded",
        totalCycles=state.total_cycles,
        totalEventsIngested=state.total_events_ingested,
        lastCycle=state.last_cycle.to_dict() if state.last_cycle else None,
        adapters=adapter_models,
        persistence=persistence,
    )


class AgentQueryRequest(BaseModel):
    query: str
    portfolio_id: str | None = None


@router.post("/query/agent", response_model=AgentResponse)
async def agent_query(
    payload: AgentQueryRequest,
    runtime: Annotated[IntelligenceRuntime, Depends(get_runtime)],
) -> AgentResponse:
    text = (payload.query or "").strip()
    if not text:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="query must be a non-empty string",
        )

    # Phase 19B — optional portfolio context. Resolve the record server-side
    # so the agent service sees a typed PortfolioRecord (or ``None``) and
    # the causal layer can project impact onto holdings without trusting
    # the client to send full holdings data.
    portfolio = None
    pid = (payload.portfolio_id or "").strip()
    if pid:
        try:
            portfolio = await runtime.portfolio_repository.get_portfolio(pid)
        except Exception:  # pragma: no cover - defensive
            portfolio = None

    return await runtime.agent_service.ask(text, portfolio=portfolio)


@router.get("/dependencies/country/{code}", response_model=DependencyResponse)
async def dependencies_for_country(
    code: str,
    runtime: Annotated[IntelligenceRuntime, Depends(get_runtime)],
) -> DependencyResponse:
    meta = lookup_by_alpha3(code)
    if meta is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Unknown country code: {code}",
        )
    return await runtime.dependency_service.for_country(meta.code)


@router.get("/dependencies/event/{event_id}", response_model=DependencyResponse)
async def dependencies_for_event(
    event_id: str,
    runtime: Annotated[IntelligenceRuntime, Depends(get_runtime)],
) -> DependencyResponse:
    response = await runtime.dependency_service.for_event(event_id)
    if response.focal_event_id and not response.paths:
        return response
    return response


class PlaceResolutionResponse(BaseModel):
    query: str
    place_id: str | None
    name: str | None
    type: str | None
    country_code: str | None
    country_name: str | None
    parent_id: str | None
    latitude: float | None
    longitude: float | None
    confidence: float
    fallback_level: str
    is_fallback: bool
    macro_profile: dict | None = None
    considered_ids: list[str]


@router.get("/geo/resolve", response_model=PlaceResolutionResponse)
async def geo_resolve(
    q: str = Query(..., description="Free-text place query"),
) -> PlaceResolutionResponse:
    resolved = place_resolver.resolve(q)
    macro = None
    if resolved.macro_profile is not None:
        macro = {
            "country_code": resolved.macro_profile.country_code,
            "currency_code": resolved.macro_profile.currency_code,
            "logistics_hub": resolved.macro_profile.logistics_hub,
            "commodity_import_sensitivity": dict(
                resolved.macro_profile.commodity_import_sensitivity
            ),
            "commodity_export_sensitivity": dict(
                resolved.macro_profile.commodity_export_sensitivity
            ),
            "sector_tags": list(resolved.macro_profile.sector_tags),
            "trade_dependence_score": resolved.macro_profile.trade_dependence_score,
            "shipping_exposure": resolved.macro_profile.shipping_exposure,
        }
    return PlaceResolutionResponse(
        query=resolved.query,
        place_id=resolved.place.id if resolved.place else None,
        name=resolved.place.name if resolved.place else None,
        type=resolved.place_type,
        country_code=resolved.country_code,
        country_name=resolved.country_name,
        parent_id=resolved.parent.id if resolved.parent else None,
        latitude=resolved.latitude,
        longitude=resolved.longitude,
        confidence=resolved.confidence,
        fallback_level=resolved.fallback_level,
        is_fallback=resolved.is_fallback,
        macro_profile=macro,
        considered_ids=list(resolved.considered_ids),
    )


@router.get("/dependencies/place", response_model=DependencyResponse)
async def dependencies_for_place(
    runtime: Annotated[IntelligenceRuntime, Depends(get_runtime)],
    q: str = Query(..., description="Free-text place query, e.g. 'Tokyo', 'Red Sea'"),
) -> DependencyResponse:
    resolved = place_resolver.resolve(q)
    if resolved.place is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Could not resolve a place for query: {q!r}",
        )
    return await runtime.dependency_service.for_place(resolved)


@router.get("/compare", response_model=CompareResponse)
async def compare(
    runtime: Annotated[IntelligenceRuntime, Depends(get_runtime)],
    targets: str = Query(
        ...,
        description="Comma-separated targets, e.g. country:JPN,country:KOR or event:<id>",
    ),
) -> CompareResponse:
    parsed: list[CompareRequest] = []
    for raw in targets.split(","):
        cleaned = raw.strip()
        if not cleaned or ":" not in cleaned:
            continue
        kind, ident = cleaned.split(":", 1)
        kind = kind.strip().lower()
        ident = ident.strip()
        if kind not in ("country", "event") or not ident:
            continue
        parsed.append(CompareRequest(kind=kind, identifier=ident))
    if len(parsed) < 2:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="compare requires at least two valid targets",
        )
    return await runtime.compare_service.compare(parsed)


__all__ = ["router"]
