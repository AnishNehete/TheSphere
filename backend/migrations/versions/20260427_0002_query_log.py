"""create query_log table

Revision ID: 0002_query_log
Revises: 0001_investigations
Create Date: 2026-04-27

Phase 18B.1 — append-only retrieval log. The only mutable column on this
table is ``user_action`` (and its derived ``feedback_score``); every
other column is set at insert and never updated.
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB


revision: str = "0002_query_log"
down_revision: Union[str, Sequence[str], None] = "0001_investigations"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    is_postgres = bind.dialect.name == "postgresql"
    json_type: sa.types.TypeEngine = JSONB() if is_postgres else sa.JSON()

    op.create_table(
        "query_log",
        sa.Column("id", sa.String(length=64), primary_key=True),
        sa.Column(
            "timestamp",
            sa.DateTime(timezone=True),
            nullable=False,
        ),
        sa.Column("query_text", sa.String(length=1024), nullable=False),
        sa.Column("intent", sa.String(length=64), nullable=False),
        sa.Column(
            "resolved_entity_ids",
            json_type,
            nullable=False,
            server_default=sa.text("'[]'"),
        ),
        sa.Column(
            "evidence_ids",
            json_type,
            nullable=False,
            server_default=sa.text("'[]'"),
        ),
        sa.Column("time_window_kind", sa.String(length=16), nullable=False),
        sa.Column(
            "compare_requested",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
        sa.Column("confidence_score", sa.Float(), nullable=False),
        sa.Column(
            "top_evidence_score",
            sa.Float(),
            nullable=False,
            server_default=sa.text("0"),
        ),
        sa.Column("result_count", sa.Integer(), nullable=False),
        sa.Column(
            "user_action",
            sa.String(length=16),
            nullable=False,
            server_default=sa.text("'none'"),
        ),
        sa.Column(
            "feedback_score",
            sa.Float(),
            nullable=False,
            server_default=sa.text("0"),
        ),
        sa.Column("latency_ms", sa.Integer(), nullable=False),
    )
    op.create_index(
        "ix_query_log_timestamp", "query_log", ["timestamp"]
    )
    op.create_index("ix_query_log_intent", "query_log", ["intent"])


def downgrade() -> None:
    op.drop_index("ix_query_log_intent", table_name="query_log")
    op.drop_index("ix_query_log_timestamp", table_name="query_log")
    op.drop_table("query_log")
