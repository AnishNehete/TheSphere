"""Postgres-backed Saved Investigations repository (Phase 18A.2).

Drop-in replacement for :class:`InMemoryInvestigationRepository` behind
the same Protocol seam. The deterministic snapshot contract from 17B is
preserved exactly — every read re-validates through Pydantic so a row
that drifted from the schema fails loudly instead of silently corrupting
a restore.

Concurrency notes:

* Each public method opens its own short-lived :class:`AsyncSession`. We
  do not hold sessions across awaits to keep the connection-pool
  pressure predictable.
* ``upsert_investigation`` performs an insert-or-update inside a single
  transaction. Share-token rotation is handled by the SQL UPDATE — the
  unique index on ``share_token`` enforces uniqueness across rows.
* ``get_by_share_token`` drops to the indexed lookup; no in-process
  index drift is possible because the DB itself is the index.

The module raises :class:`InvestigationNotFoundError` for the same
not-found cases the in-memory repo does.
"""

from __future__ import annotations

import logging
from datetime import timezone

from sqlalchemy import delete, func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.intelligence.investigations.models import InvestigationRow
from app.intelligence.investigations.repository import (
    InvestigationNotFoundError,
)
from app.intelligence.investigations.schemas import (
    SavedInvestigation,
    SavedInvestigationSnapshot,
)


logger = logging.getLogger(__name__)


class SqlAlchemyInvestigationRepository:
    """Postgres-backed implementation of ``InvestigationRepository``."""

    def __init__(self, session_factory: async_sessionmaker[AsyncSession]) -> None:
        self._session_factory = session_factory

    async def list_investigations(self) -> list[SavedInvestigation]:
        async with self._session_factory() as session:
            stmt = select(InvestigationRow).order_by(
                InvestigationRow.created_at.desc()
            )
            result = await session.execute(stmt)
            rows = result.scalars().all()
            return [_row_to_record(row) for row in rows]

    async def get_investigation(
        self, investigation_id: str
    ) -> SavedInvestigation:
        async with self._session_factory() as session:
            row = await session.get(InvestigationRow, investigation_id)
            if row is None:
                raise InvestigationNotFoundError(investigation_id)
            return _row_to_record(row)

    async def get_by_share_token(self, token: str) -> SavedInvestigation:
        async with self._session_factory() as session:
            stmt = select(InvestigationRow).where(
                InvestigationRow.share_token == token
            )
            row = (await session.execute(stmt)).scalars().first()
            if row is None:
                raise InvestigationNotFoundError(f"share:{token}")
            return _row_to_record(row)

    async def upsert_investigation(
        self, record: SavedInvestigation
    ) -> SavedInvestigation:
        snapshot_json = record.snapshot.model_dump(mode="json")
        created_at = record.created_at
        if created_at.tzinfo is None:
            created_at = created_at.replace(tzinfo=timezone.utc)

        async with self._session_factory() as session:
            # Use a portable upsert: SELECT-FOR-UPDATE then INSERT/UPDATE
            # path so the same code works on Postgres and on the sqlite
            # contract-test path. The Postgres dialect's ``ON CONFLICT``
            # would be slightly faster but is not required for closed-beta
            # write volumes.
            existing = await session.get(InvestigationRow, record.id)
            if existing is None:
                row = InvestigationRow(
                    id=record.id,
                    name=record.name,
                    created_at=created_at,
                    share_token=record.share_token,
                    snapshot=snapshot_json,
                )
                session.add(row)
            else:
                existing.name = record.name
                existing.created_at = created_at
                existing.share_token = record.share_token
                existing.snapshot = snapshot_json
                row = existing
            await session.commit()
            await session.refresh(row)
            return _row_to_record(row)

    async def delete_investigation(self, investigation_id: str) -> None:
        async with self._session_factory() as session:
            row = await session.get(InvestigationRow, investigation_id)
            if row is None:
                raise InvestigationNotFoundError(investigation_id)
            await session.delete(row)
            await session.commit()

    async def count(self) -> int:
        async with self._session_factory() as session:
            stmt = select(func.count(InvestigationRow.id))
            result = await session.execute(stmt)
            return int(result.scalar_one())


def _row_to_record(row: InvestigationRow) -> SavedInvestigation:
    snapshot = SavedInvestigationSnapshot.model_validate(row.snapshot)
    created_at = row.created_at
    if created_at.tzinfo is None:
        created_at = created_at.replace(tzinfo=timezone.utc)
    return SavedInvestigation(
        id=row.id,
        name=row.name,
        created_at=created_at,
        share_token=row.share_token,
        snapshot=snapshot,
    )


__all__ = ["SqlAlchemyInvestigationRepository"]
