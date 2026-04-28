"""Alembic environment for TheSphere (Phase 18A.2).

The DSN is sourced from :class:`IntelligenceSettings.database_url` so
``alembic upgrade head`` and the live runtime see the same URL. If the
setting is unset, the migration command refuses to run — silently
upgrading "no database" is exactly the failure mode this phase exists to
prevent.

Currently the only model registered against ``Base.metadata`` is
:class:`InvestigationRow`. Future durable repositories register their
models the same way; new tables come through new revisions, never via
direct DDL.
"""

from __future__ import annotations

import asyncio
from logging.config import fileConfig

from alembic import context
from sqlalchemy.ext.asyncio import AsyncEngine

from app.db import Base, build_engine
from app.intelligence.investigations import models as _investigations_models  # noqa: F401
from app.intelligence.calibration import models as _calibration_models  # noqa: F401
from app.settings import get_intelligence_settings


config = context.config
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = Base.metadata


def _resolve_database_url() -> str:
    settings = get_intelligence_settings()
    if not settings.database_url:
        raise RuntimeError(
            "INTELLIGENCE_DATABASE_URL is unset — alembic refuses to run "
            "against an unconfigured database."
        )
    return settings.database_url


def run_migrations_offline() -> None:
    """Configure context with just a URL — emits SQL to stdout."""

    url = _resolve_database_url()
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )
    with context.begin_transaction():
        context.run_migrations()


def _do_run_migrations(connection) -> None:
    context.configure(connection=connection, target_metadata=target_metadata)
    with context.begin_transaction():
        context.run_migrations()


async def run_migrations_online() -> None:
    url = _resolve_database_url()
    engine: AsyncEngine = build_engine(url)
    async with engine.connect() as connection:
        await connection.run_sync(_do_run_migrations)
    await engine.dispose()


if context.is_offline_mode():
    run_migrations_offline()
else:
    asyncio.run(run_migrations_online())
