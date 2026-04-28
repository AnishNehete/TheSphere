"""Saved Investigations persistence (Phase 17B — in-memory only).

The :class:`InvestigationRepository` Protocol is the seam a future
Postgres-backed store can land behind without touching the service or
route code. Today only :class:`InMemoryInvestigationRepository` exists.

Indexing notes:

* ``share_token`` is held in a secondary dict so ``get_by_share_token``
  is O(1). Tokens are cleared from the index on delete and on token
  rotation, so a stale token never resolves to a deleted investigation.
* The repo is async-locked with ``asyncio.Lock`` to mirror the existing
  ``InMemoryPortfolioRepository`` pattern (single-process FastAPI).
"""

from __future__ import annotations

import asyncio
import uuid
from datetime import datetime, timezone
from typing import Protocol

from app.intelligence.investigations.schemas import SavedInvestigation


class InvestigationNotFoundError(LookupError):
    """Raised when an investigation id or share token is not found."""


class InvestigationRepository(Protocol):
    async def list_investigations(self) -> list[SavedInvestigation]: ...

    async def get_investigation(
        self, investigation_id: str
    ) -> SavedInvestigation: ...

    async def get_by_share_token(self, token: str) -> SavedInvestigation: ...

    async def upsert_investigation(
        self, record: SavedInvestigation
    ) -> SavedInvestigation: ...

    async def delete_investigation(self, investigation_id: str) -> None: ...

    async def count(self) -> int: ...


def generate_id(prefix: str = "inv") -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


class InMemoryInvestigationRepository:
    """Thread-safe in-memory implementation of :class:`InvestigationRepository`."""

    def __init__(self) -> None:
        self._records: dict[str, SavedInvestigation] = {}
        self._share_index: dict[str, str] = {}
        self._lock = asyncio.Lock()

    async def list_investigations(self) -> list[SavedInvestigation]:
        async with self._lock:
            return sorted(
                (record.model_copy(deep=True) for record in self._records.values()),
                key=lambda r: r.created_at,
                reverse=True,
            )

    async def get_investigation(
        self, investigation_id: str
    ) -> SavedInvestigation:
        async with self._lock:
            record = self._records.get(investigation_id)
            if record is None:
                raise InvestigationNotFoundError(investigation_id)
            return record.model_copy(deep=True)

    async def get_by_share_token(self, token: str) -> SavedInvestigation:
        async with self._lock:
            investigation_id = self._share_index.get(token)
            if investigation_id is None:
                raise InvestigationNotFoundError(f"share:{token}")
            record = self._records.get(investigation_id)
            if record is None:
                # Index drift — clean it up and surface as not-found.
                self._share_index.pop(token, None)
                raise InvestigationNotFoundError(f"share:{token}")
            return record.model_copy(deep=True)

    async def upsert_investigation(
        self, record: SavedInvestigation
    ) -> SavedInvestigation:
        async with self._lock:
            stored = record.model_copy(deep=True)
            previous = self._records.get(stored.id)
            if previous is not None and previous.share_token:
                # If the new record drops or rotates the share token,
                # purge the stale index entry first.
                if previous.share_token != stored.share_token:
                    self._share_index.pop(previous.share_token, None)
            self._records[stored.id] = stored
            if stored.share_token:
                self._share_index[stored.share_token] = stored.id
            return stored.model_copy(deep=True)

    async def delete_investigation(self, investigation_id: str) -> None:
        async with self._lock:
            record = self._records.pop(investigation_id, None)
            if record is None:
                raise InvestigationNotFoundError(investigation_id)
            if record.share_token:
                self._share_index.pop(record.share_token, None)

    async def count(self) -> int:
        async with self._lock:
            return len(self._records)


__all__ = [
    "InMemoryInvestigationRepository",
    "InvestigationNotFoundError",
    "InvestigationRepository",
    "generate_id",
    "now_utc",
]
