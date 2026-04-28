"""Append-only query log repository (Phase 18B, Part 1).

Two implementations sit behind one Protocol:

* :class:`InMemoryQueryLogRepository` — local dev / tests
* :class:`SqlAlchemyQueryLogRepository` — Postgres-backed durable store

Both expose the same ``append`` / ``mark_user_action`` / ``recent`` /
``count`` surface. Repos never accept a generic update — the only
post-insert mutation is the user-action stamp, and it goes through a
narrow, named call so the append-only invariant is enforced at the API.
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from datetime import datetime, timedelta, timezone
from typing import Iterable, Protocol

from sqlalchemy import desc, func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.intelligence.calibration.feedback import (
    UserAction,
    feedback_score_for_action,
)
from app.intelligence.calibration.models import QueryLogRow
from app.intelligence.calibration.schemas import (
    QueryLogEntry,
    QueryLogEntryCreate,
)


logger = logging.getLogger(__name__)


class QueryLogNotFoundError(LookupError):
    """Raised when an id lookup misses."""


class QueryLogRepository(Protocol):
    async def append(self, entry: QueryLogEntryCreate) -> QueryLogEntry: ...

    async def mark_user_action(
        self, entry_id: str, action: UserAction
    ) -> QueryLogEntry: ...

    async def recent(
        self, *, limit: int = 200, since: datetime | None = None
    ) -> list[QueryLogEntry]: ...

    async def count(self) -> int: ...


def _generate_id() -> str:
    return f"qlog_{uuid.uuid4().hex[:18]}"


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


class InMemoryQueryLogRepository:
    """Process-local append-only log used in dev / tests."""

    def __init__(self, *, capacity: int = 5000) -> None:
        self._capacity = max(100, capacity)
        self._records: dict[str, QueryLogEntry] = {}
        self._order: list[str] = []
        self._lock = asyncio.Lock()

    async def append(self, entry: QueryLogEntryCreate) -> QueryLogEntry:
        async with self._lock:
            row = QueryLogEntry(
                id=_generate_id(),
                timestamp=_utc_now(),
                query_text=entry.query_text,
                intent=entry.intent,
                resolved_entity_ids=list(entry.resolved_entity_ids),
                evidence_ids=list(entry.evidence_ids),
                time_window_kind=entry.time_window_kind,
                compare_requested=entry.compare_requested,
                confidence_score=entry.confidence_score,
                top_evidence_score=entry.top_evidence_score,
                result_count=entry.result_count,
                user_action="none",
                feedback_score=0.0,
                latency_ms=entry.latency_ms,
            )
            self._records[row.id] = row
            self._order.append(row.id)
            self._enforce_capacity()
            return row.model_copy(deep=True)

    async def mark_user_action(
        self, entry_id: str, action: UserAction
    ) -> QueryLogEntry:
        async with self._lock:
            row = self._records.get(entry_id)
            if row is None:
                raise QueryLogNotFoundError(entry_id)
            updated = row.with_action(
                action,
                feedback_score=feedback_score_for_action(action),
            )
            self._records[entry_id] = updated
            return updated.model_copy(deep=True)

    async def recent(
        self, *, limit: int = 200, since: datetime | None = None
    ) -> list[QueryLogEntry]:
        async with self._lock:
            items = [self._records[rid] for rid in reversed(self._order)]
            if since is not None:
                items = [row for row in items if row.timestamp >= since]
            return [row.model_copy(deep=True) for row in items[: max(1, limit)]]

    async def count(self) -> int:
        async with self._lock:
            return len(self._records)

    def _enforce_capacity(self) -> None:
        while len(self._order) > self._capacity:
            oldest = self._order.pop(0)
            self._records.pop(oldest, None)


class SqlAlchemyQueryLogRepository:
    """Postgres-backed implementation."""

    def __init__(self, session_factory: async_sessionmaker[AsyncSession]) -> None:
        self._session_factory = session_factory

    async def append(self, entry: QueryLogEntryCreate) -> QueryLogEntry:
        row = QueryLogRow(
            id=_generate_id(),
            timestamp=_utc_now(),
            query_text=entry.query_text,
            intent=entry.intent,
            resolved_entity_ids=list(entry.resolved_entity_ids),
            evidence_ids=list(entry.evidence_ids),
            time_window_kind=entry.time_window_kind,
            compare_requested=entry.compare_requested,
            confidence_score=entry.confidence_score,
            top_evidence_score=entry.top_evidence_score,
            result_count=entry.result_count,
            user_action="none",
            feedback_score=0.0,
            latency_ms=entry.latency_ms,
        )
        async with self._session_factory() as session:
            session.add(row)
            await session.commit()
            await session.refresh(row)
            return _row_to_entry(row)

    async def mark_user_action(
        self, entry_id: str, action: UserAction
    ) -> QueryLogEntry:
        async with self._session_factory() as session:
            row = await session.get(QueryLogRow, entry_id)
            if row is None:
                raise QueryLogNotFoundError(entry_id)
            row.user_action = action
            row.feedback_score = feedback_score_for_action(action)
            await session.commit()
            await session.refresh(row)
            return _row_to_entry(row)

    async def recent(
        self, *, limit: int = 200, since: datetime | None = None
    ) -> list[QueryLogEntry]:
        async with self._session_factory() as session:
            stmt = select(QueryLogRow).order_by(desc(QueryLogRow.timestamp))
            if since is not None:
                stmt = stmt.where(QueryLogRow.timestamp >= since)
            stmt = stmt.limit(max(1, limit))
            rows = (await session.execute(stmt)).scalars().all()
            return [_row_to_entry(row) for row in rows]

    async def count(self) -> int:
        async with self._session_factory() as session:
            stmt = select(func.count(QueryLogRow.id))
            result = await session.execute(stmt)
            return int(result.scalar_one())


def _row_to_entry(row: QueryLogRow) -> QueryLogEntry:
    timestamp = row.timestamp
    if timestamp.tzinfo is None:
        timestamp = timestamp.replace(tzinfo=timezone.utc)
    return QueryLogEntry(
        id=row.id,
        timestamp=timestamp,
        query_text=row.query_text,
        intent=row.intent,
        resolved_entity_ids=list(row.resolved_entity_ids or []),
        evidence_ids=list(row.evidence_ids or []),
        time_window_kind=row.time_window_kind,  # type: ignore[arg-type]
        compare_requested=bool(row.compare_requested),
        confidence_score=float(row.confidence_score),
        top_evidence_score=float(row.top_evidence_score),
        result_count=int(row.result_count),
        user_action=row.user_action,  # type: ignore[arg-type]
        feedback_score=float(row.feedback_score),
        latency_ms=int(row.latency_ms),
    )


def default_window_lookback() -> timedelta:
    return timedelta(days=30)


__all__ = [
    "InMemoryQueryLogRepository",
    "QueryLogNotFoundError",
    "QueryLogRepository",
    "SqlAlchemyQueryLogRepository",
    "default_window_lookback",
]
