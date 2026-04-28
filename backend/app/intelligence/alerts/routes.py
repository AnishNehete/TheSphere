"""HTTP routes for the Alert MVP (Phase 17C).

Surface:

* ``POST   /api/intelligence/alerts/rules``         — create rule
* ``GET    /api/intelligence/alerts/rules``         — list rules
* ``DELETE /api/intelligence/alerts/rules/{id}``    — delete rule
* ``GET    /api/intelligence/alerts/events``        — recent events
                                                       (?since=ISO, ?limit=)

The frontend polls ``/alerts/events?since=<lastSeen>`` every 30s. There
is intentionally no WebSocket in this MVP — keeps the wire shape simple
and matches the existing intelligence polling pattern.
"""

from __future__ import annotations

from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from pydantic import BaseModel

from app.intelligence.alerts.repository import AlertNotFoundError
from app.intelligence.alerts.schemas import (
    AlertEvent,
    AlertRule,
    AlertRuleCreate,
)
from app.intelligence.alerts.service import (
    AlertRuleLimitError,
    AlertService,
)
from app.intelligence.runtime import IntelligenceRuntime
from app.security import RateLimiter


router = APIRouter(prefix="/api/intelligence/alerts", tags=["alerts"])


def get_runtime(request: Request) -> IntelligenceRuntime:
    runtime = getattr(request.app.state, "intelligence", None)
    if runtime is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Intelligence runtime is not ready yet.",
        )
    return runtime


async def _rate_limit_create(request: Request) -> None:
    limiter: RateLimiter | None = getattr(
        request.app.state, "alert_create_limiter", None
    )
    if limiter is None:
        return
    fwd = request.headers.get("x-forwarded-for")
    key = (
        fwd.split(",")[0].strip()
        if fwd
        else (request.client.host if request.client else "unknown")
    )
    if not await limiter.consume(key):
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Rule creation rate limit exceeded.",
        )


def get_alert_service(
    runtime: Annotated[IntelligenceRuntime, Depends(get_runtime)],
) -> AlertService:
    service = getattr(runtime, "alert_service", None)
    if service is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Alert service is not ready yet.",
        )
    return service


class AlertRuleListResponse(BaseModel):
    total: int
    items: list[AlertRule]


class AlertEventListResponse(BaseModel):
    total: int
    items: list[AlertEvent]


@router.get("/rules", response_model=AlertRuleListResponse)
async def list_rules(
    service: Annotated[AlertService, Depends(get_alert_service)],
) -> AlertRuleListResponse:
    items = await service.list_rules()
    return AlertRuleListResponse(total=len(items), items=items)


@router.post(
    "/rules",
    response_model=AlertRule,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(_rate_limit_create)],
)
async def create_rule(
    payload: AlertRuleCreate,
    service: Annotated[AlertService, Depends(get_alert_service)],
) -> AlertRule:
    if payload.kind == "confidence_drop" and payload.threshold is None:
        # Allowed — service substitutes DEFAULT_CONFIDENCE_THRESHOLD.
        pass
    try:
        return await service.add_rule(payload)
    except AlertRuleLimitError as exc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail=str(exc)
        ) from exc
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)
        ) from exc


@router.delete(
    "/rules/{rule_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def delete_rule(
    rule_id: str,
    service: Annotated[AlertService, Depends(get_alert_service)],
) -> Response:
    try:
        await service.delete_rule(rule_id)
    except AlertNotFoundError as exc:
        raise HTTPException(
            status_code=404, detail=f"Alert rule {exc} not found"
        ) from exc
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/events", response_model=AlertEventListResponse)
async def list_events(
    service: Annotated[AlertService, Depends(get_alert_service)],
    since: datetime | None = None,
    limit: int = Query(default=50, ge=1, le=200),
) -> AlertEventListResponse:
    items = await service.list_recent_events(since=since, limit=limit)
    return AlertEventListResponse(total=len(items), items=items)


__all__ = ["router"]
