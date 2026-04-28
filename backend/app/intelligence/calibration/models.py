"""SQLAlchemy ORM model for the query_log table (Phase 18B, Part 1).

The table is append-only with one mutable column (``user_action`` plus
its derived ``feedback_score``). Indexes cover the two read paths the
admin endpoints need:

* range scan by ``timestamp`` for calibration windows
* lookup by ``id`` (primary key) for feedback updates
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import (
    JSON,
    Boolean,
    DateTime,
    Float,
    Index,
    Integer,
    String,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


class QueryLogRow(Base):
    __tablename__ = "query_log"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    timestamp: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
    query_text: Mapped[str] = mapped_column(String(1024), nullable=False)
    intent: Mapped[str] = mapped_column(String(64), nullable=False)
    resolved_entity_ids: Mapped[list] = mapped_column(
        JSONB().with_variant(JSON(), "sqlite"),
        nullable=False,
        default=list,
    )
    evidence_ids: Mapped[list] = mapped_column(
        JSONB().with_variant(JSON(), "sqlite"),
        nullable=False,
        default=list,
    )
    time_window_kind: Mapped[str] = mapped_column(String(16), nullable=False)
    compare_requested: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False
    )
    confidence_score: Mapped[float] = mapped_column(Float, nullable=False)
    top_evidence_score: Mapped[float] = mapped_column(
        Float, nullable=False, default=0.0
    )
    result_count: Mapped[int] = mapped_column(Integer, nullable=False)
    user_action: Mapped[str] = mapped_column(
        String(16), nullable=False, default="none"
    )
    feedback_score: Mapped[float] = mapped_column(
        Float, nullable=False, default=0.0
    )
    latency_ms: Mapped[int] = mapped_column(Integer, nullable=False)

    __table_args__ = (
        Index("ix_query_log_timestamp", "timestamp"),
        Index("ix_query_log_intent", "intent"),
    )


__all__ = ["QueryLogRow"]
