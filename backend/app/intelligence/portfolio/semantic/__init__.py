"""Phase 13B.3 — semantic / event pressure engine package.

Pure engine (``engine.py``) + frozen pydantic shapes (``schemas.py``). The
orchestration layer lives alongside in ``semantic_service.py`` at the
portfolio package root so the engine stays I/O-free.

Every driver cites the event IDs that contributed — no fabricated text.
"""

from app.intelligence.portfolio.semantic.engine import (
    RECENCY_HALF_LIFE_HOURS,
    match_events_to_holding,
    rollup_portfolio,
    score_holding,
)
from app.intelligence.portfolio.semantic.schemas import (
    EventPressureLevel,
    PortfolioSemanticRollup,
    SemanticDriver,
    SemanticSnapshot,
)

__all__ = [
    "EventPressureLevel",
    "PortfolioSemanticRollup",
    "RECENCY_HALF_LIFE_HOURS",
    "SemanticDriver",
    "SemanticSnapshot",
    "match_events_to_holding",
    "rollup_portfolio",
    "score_holding",
]
