"""create investigations table

Revision ID: 0001_investigations
Revises:
Create Date: 2026-04-26

Phase 18A.2 — first durable table. Columns mirror
:class:`SavedInvestigation` exactly: opaque id, name, created_at
(timestamptz), nullable share_token (unique-when-set), JSONB snapshot
payload.
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB


revision: str = "0001_investigations"
down_revision: Union[str, Sequence[str], None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    is_postgres = bind.dialect.name == "postgresql"
    snapshot_type: sa.types.TypeEngine = JSONB() if is_postgres else sa.JSON()

    op.create_table(
        "investigations",
        sa.Column("id", sa.String(length=64), primary_key=True),
        sa.Column("name", sa.String(length=160), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
        ),
        sa.Column("share_token", sa.String(length=96), nullable=True),
        sa.Column("snapshot", snapshot_type, nullable=False),
        sa.UniqueConstraint("share_token", name="uq_investigations_share_token"),
    )
    op.create_index(
        "ix_investigations_created_at",
        "investigations",
        ["created_at"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_investigations_created_at", table_name="investigations"
    )
    op.drop_table("investigations")
