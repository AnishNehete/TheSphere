"""Async database engine + session factory (Phase 18A.2).

This module exists only when persistence is configured —
:func:`build_engine` is called from the runtime when
``IntelligenceSettings.database_url`` is set, otherwise the in-memory
repositories continue to satisfy the Protocol seams.

The shared declarative :class:`Base` is the metadata target for Alembic
migrations and any persistence-backed repository (today: investigations
only). Other repositories (events, portfolios, alerts) deliberately
remain in-memory in this slice — durable persistence is rolled out one
seam at a time so each migration can be reviewed independently.
"""

from __future__ import annotations

import logging
from typing import AsyncIterator

from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.orm import DeclarativeBase


logger = logging.getLogger(__name__)


class Base(DeclarativeBase):
    """Shared declarative base — metadata target for Alembic."""


def normalize_database_url(url: str) -> str:
    """Coerce a DSN to the SQLAlchemy async-driver form.

    * ``postgresql://``        → ``postgresql+psycopg://``
    * ``postgres://``          → ``postgresql+psycopg://``
    * ``postgresql+psycopg://``→ unchanged
    * ``sqlite+aiosqlite://``  → unchanged

    Anything else is passed through unchanged so callers can supply an
    explicit driver if they need one we don't normalize.
    """

    if url.startswith("postgresql+psycopg://"):
        return url
    if url.startswith("postgres://"):
        return "postgresql+psycopg://" + url[len("postgres://") :]
    if url.startswith("postgresql://"):
        return "postgresql+psycopg://" + url[len("postgresql://") :]
    return url


def build_engine(database_url: str, *, echo: bool = False) -> AsyncEngine:
    """Build a pooled async engine for ``database_url``.

    The pool defaults are intentionally small — closed-beta workloads do
    not need 50 connections. SQLite uses ``StaticPool`` under the hood
    so ``pool_size`` / ``max_overflow`` don't apply there.
    """

    normalized = normalize_database_url(database_url)
    kwargs: dict[str, object] = {"echo": echo}
    if not normalized.startswith("sqlite"):
        kwargs.update(
            pool_size=5,
            max_overflow=5,
            pool_pre_ping=True,
            pool_recycle=300,
        )
    return create_async_engine(normalized, **kwargs)


def build_session_factory(engine: AsyncEngine) -> async_sessionmaker[AsyncSession]:
    """Build an :class:`AsyncSession` factory bound to ``engine``."""

    return async_sessionmaker(
        engine,
        expire_on_commit=False,
        class_=AsyncSession,
    )


async def session_scope(
    factory: async_sessionmaker[AsyncSession],
) -> AsyncIterator[AsyncSession]:
    """Yield a session inside a transactional context.

    Repositories prefer ``async with factory() as session:`` blocks so
    individual operations stay short-lived; this helper exists for any
    higher-level orchestration that wants an explicit scope.
    """

    async with factory() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise


__all__ = [
    "AsyncEngine",
    "AsyncSession",
    "Base",
    "async_sessionmaker",
    "build_engine",
    "build_session_factory",
    "normalize_database_url",
    "session_scope",
]
