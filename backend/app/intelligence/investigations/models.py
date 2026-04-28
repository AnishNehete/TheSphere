"""SQLAlchemy 2.x ORM model for saved investigations (Phase 18A.2).

The :class:`InvestigationRow` is the table behind
:class:`SqlAlchemyInvestigationRepository`. It deliberately keeps the
schema minimal:

* ``id``           — opaque ``inv_<hex>`` identifier (caller-generated)
* ``name``         — display name
* ``created_at``   — UTC timestamptz
* ``share_token``  — nullable, unique-when-set
* ``snapshot``     — JSONB on Postgres / JSON on sqlite, holds the frozen
                     :class:`SavedInvestigationSnapshot` payload

The frozen snapshot contract from 17B is preserved exactly — the row
just holds the model-dumped JSON. On read we re-validate via
``SavedInvestigationSnapshot.model_validate``; that protects us from a
schema drift where a column was changed underneath without a migration.
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import JSON, DateTime, Index, String
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


class InvestigationRow(Base):
    __tablename__ = "investigations"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    name: Mapped[str] = mapped_column(String(160), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
    share_token: Mapped[str | None] = mapped_column(
        String(96), nullable=True, unique=True
    )
    snapshot: Mapped[dict] = mapped_column(
        JSONB().with_variant(JSON(), "sqlite"),
        nullable=False,
    )

    __table_args__ = (
        Index("ix_investigations_created_at", "created_at"),
    )


__all__ = ["InvestigationRow"]
