"""HTTP routes for the Saved Investigations module (Phase 17B).

Mounted alongside the existing intelligence + portfolio routers from
``app.main.create_app``. The route handlers are intentionally thin —
all logic lives in :class:`InvestigationService`.

Surface:

* ``POST   /api/intelligence/investigations``           — save snapshot
* ``GET    /api/intelligence/investigations``           — list saved (light)
* ``GET    /api/intelligence/investigations/{id}``      — full record
* ``DELETE /api/intelligence/investigations/{id}``      — remove
* ``POST   /api/intelligence/investigations/{id}/share``  — issue token
* ``DELETE /api/intelligence/investigations/{id}/share``  — revoke token
* ``GET    /api/intelligence/share/{share_token}``      — read-only share

The share endpoint is intentionally unauthenticated — the unguessable
token *is* the auth boundary. No mutation routes accept a share token.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from pydantic import BaseModel

from app.intelligence.investigations.repository import InvestigationNotFoundError
from app.intelligence.investigations.schemas import (
    SavedInvestigation,
    SavedInvestigationCreate,
    SavedInvestigationListItem,
)
from app.intelligence.investigations.service import (
    InvestigationService,
    SavedInvestigationLimitError,
)
from app.intelligence.runtime import IntelligenceRuntime
from app.security import RateLimiter


router = APIRouter(prefix="/api/intelligence", tags=["investigations"])


def get_runtime(request: Request) -> IntelligenceRuntime:
    runtime = getattr(request.app.state, "intelligence", None)
    if runtime is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Intelligence runtime is not ready yet.",
        )
    return runtime


async def _rate_limit_save(request: Request) -> None:
    limiter: RateLimiter | None = getattr(
        request.app.state, "investigation_save_limiter", None
    )
    if limiter is None:
        return  # tests / unwired apps — no throttle
    if not await limiter.consume(_client_key(request)):
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Save rate limit exceeded.",
        )


async def _rate_limit_share_read(request: Request) -> None:
    limiter: RateLimiter | None = getattr(
        request.app.state, "share_limiter", None
    )
    if limiter is None:
        return
    # Bucket on (client IP, share token) so a leaked link is throttled
    # globally as well as per-client.
    token = request.path_params.get("share_token", "")
    key = f"{_client_key(request)}::{token}"
    if not await limiter.consume(key):
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Share read rate limit exceeded.",
        )


def _client_key(request: Request) -> str:
    fwd = request.headers.get("x-forwarded-for")
    if fwd:
        return fwd.split(",")[0].strip()
    if request.client and request.client.host:
        return request.client.host
    return "unknown"


def get_investigation_service(
    runtime: Annotated[IntelligenceRuntime, Depends(get_runtime)],
) -> InvestigationService:
    service = getattr(runtime, "investigation_service", None)
    if service is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Investigation service is not ready yet.",
        )
    return service


class SavedInvestigationListResponse(BaseModel):
    total: int
    items: list[SavedInvestigationListItem]


@router.get(
    "/investigations",
    response_model=SavedInvestigationListResponse,
)
async def list_investigations(
    service: Annotated[InvestigationService, Depends(get_investigation_service)],
) -> SavedInvestigationListResponse:
    items = await service.list_investigations()
    return SavedInvestigationListResponse(total=len(items), items=items)


@router.post(
    "/investigations",
    response_model=SavedInvestigation,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(_rate_limit_save)],
)
async def save_investigation(
    payload: SavedInvestigationCreate,
    service: Annotated[InvestigationService, Depends(get_investigation_service)],
) -> SavedInvestigation:
    if not payload.name.strip():
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Investigation name is required.",
        )
    try:
        return await service.save_investigation(payload)
    except SavedInvestigationLimitError as exc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=str(exc),
        ) from exc


@router.get(
    "/investigations/{investigation_id}",
    response_model=SavedInvestigation,
)
async def get_investigation(
    investigation_id: str,
    service: Annotated[InvestigationService, Depends(get_investigation_service)],
) -> SavedInvestigation:
    try:
        return await service.get_investigation(investigation_id)
    except InvestigationNotFoundError as exc:
        raise HTTPException(
            status_code=404, detail=f"Investigation {exc} not found"
        ) from exc


@router.delete(
    "/investigations/{investigation_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def delete_investigation(
    investigation_id: str,
    service: Annotated[InvestigationService, Depends(get_investigation_service)],
) -> Response:
    try:
        await service.delete_investigation(investigation_id)
    except InvestigationNotFoundError as exc:
        raise HTTPException(
            status_code=404, detail=f"Investigation {exc} not found"
        ) from exc
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post(
    "/investigations/{investigation_id}/share",
    response_model=SavedInvestigation,
)
async def issue_share_token(
    investigation_id: str,
    service: Annotated[InvestigationService, Depends(get_investigation_service)],
) -> SavedInvestigation:
    try:
        return await service.issue_share_token(investigation_id)
    except InvestigationNotFoundError as exc:
        raise HTTPException(
            status_code=404, detail=f"Investigation {exc} not found"
        ) from exc


@router.delete(
    "/investigations/{investigation_id}/share",
    response_model=SavedInvestigation,
)
async def revoke_share_token(
    investigation_id: str,
    service: Annotated[InvestigationService, Depends(get_investigation_service)],
) -> SavedInvestigation:
    try:
        return await service.revoke_share_token(investigation_id)
    except InvestigationNotFoundError as exc:
        raise HTTPException(
            status_code=404, detail=f"Investigation {exc} not found"
        ) from exc


@router.get(
    "/share/{share_token}",
    response_model=SavedInvestigation,
    dependencies=[Depends(_rate_limit_share_read)],
)
async def get_shared_investigation(
    share_token: str,
    service: Annotated[InvestigationService, Depends(get_investigation_service)],
) -> SavedInvestigation:
    """Read-only fetch of a shared investigation by token.

    Intentionally unauthenticated: the unguessable token *is* the auth
    boundary. No mutation routes accept a share token, so a leaked token
    can be revoked by the owner via the DELETE share endpoint without
    affecting the underlying record.
    """
    try:
        return await service.get_by_share_token(share_token)
    except InvestigationNotFoundError as exc:
        raise HTTPException(
            status_code=404, detail=f"Shared investigation {exc} not found"
        ) from exc


__all__ = ["router"]
