"""Saved Investigations service (Phase 17B).

Thin orchestrator over :class:`InvestigationRepository` that handles id
generation, share-token issuance, the per-tenant cap, and listing
projection. Routes call into this service so the persistence layer can
swap (in-memory → Postgres) without changing the API surface.

Share-token semantics (per phase brief — closed beta):

* Random URL-safe token from :func:`secrets.token_urlsafe` (24 bytes ->
  ~32-char output). Unguessable without auth.
* One token per investigation. Re-issuing rotates the token; the old
  token is purged from the share index immediately.
* No expiry (closed beta).
"""

from __future__ import annotations

import secrets

from app.intelligence.investigations.repository import (
    InvestigationNotFoundError,
    InvestigationRepository,
    generate_id,
    now_utc,
)
from app.intelligence.investigations.schemas import (
    SavedInvestigation,
    SavedInvestigationCreate,
    SavedInvestigationListItem,
)


# Closed-beta cap. Kept as a module constant rather than a settings field
# to keep 17B small — swap to settings when 17D introduces tenancy.
DEFAULT_MAX_SAVED = 100


class SavedInvestigationLimitError(RuntimeError):
    """Raised when the per-tenant saved-investigation cap is reached."""


class InvestigationService:
    def __init__(
        self,
        *,
        repository: InvestigationRepository,
        max_saved: int = DEFAULT_MAX_SAVED,
    ) -> None:
        self._repo = repository
        self._max_saved = max_saved

    async def list_investigations(self) -> list[SavedInvestigationListItem]:
        records = await self._repo.list_investigations()
        return [self._to_list_item(record) for record in records]

    async def get_investigation(self, investigation_id: str) -> SavedInvestigation:
        return await self._repo.get_investigation(investigation_id)

    async def save_investigation(
        self, request: SavedInvestigationCreate
    ) -> SavedInvestigation:
        existing = await self._repo.count()
        if existing >= self._max_saved:
            raise SavedInvestigationLimitError(
                f"Saved investigation limit reached ({self._max_saved})."
            )
        record = SavedInvestigation(
            id=generate_id("inv"),
            name=request.name.strip(),
            created_at=now_utc(),
            snapshot=request.snapshot,
            share_token=None,
        )
        return await self._repo.upsert_investigation(record)

    async def delete_investigation(self, investigation_id: str) -> None:
        await self._repo.delete_investigation(investigation_id)

    async def issue_share_token(self, investigation_id: str) -> SavedInvestigation:
        record = await self._repo.get_investigation(investigation_id)
        record.share_token = secrets.token_urlsafe(24)
        return await self._repo.upsert_investigation(record)

    async def revoke_share_token(self, investigation_id: str) -> SavedInvestigation:
        record = await self._repo.get_investigation(investigation_id)
        record.share_token = None
        return await self._repo.upsert_investigation(record)

    async def get_by_share_token(self, token: str) -> SavedInvestigation:
        return await self._repo.get_by_share_token(token)

    @staticmethod
    def _to_list_item(record: SavedInvestigation) -> SavedInvestigationListItem:
        snapshot = record.snapshot
        primary = (
            snapshot.selection.market_symbol
            or snapshot.selection.country_name
            or snapshot.selection.event_summary
            or "—"
        )
        return SavedInvestigationListItem(
            id=record.id,
            name=record.name,
            created_at=record.created_at,
            captured_at=snapshot.captured_at,
            workspace_mode=snapshot.workspace_mode,
            primary_label=primary,
            has_share=bool(record.share_token),
        )


__all__ = [
    "DEFAULT_MAX_SAVED",
    "InvestigationNotFoundError",
    "InvestigationService",
    "SavedInvestigationLimitError",
]
