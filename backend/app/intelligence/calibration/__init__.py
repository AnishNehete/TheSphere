"""Retrieval calibration module (Phase 18B).

Converts Sphere from a *correct* retrieval system into a *trusted* decision
system by:

* logging every agent query into an append-only ``query_log`` table
* exposing a per-component ranking score breakdown via the search service
* layering a deterministic reranker on top of search results
* re-deriving confidence from calibrated drivers (evidence count /
  agreement / recency / source diversity / scope confidence)
* mapping implicit feedback (``click`` / ``share`` / ``refine``) into a
  feedback score that nudges ranking + calibration scaling
* hot-reloading ranking weights from a YAML config
* exposing admin endpoints for debug ranking, calibration buckets, and
  weight tuning simulation

No new agents, no new data sources, no LLM ranking. Pure functions over
already-resolved evidence.
"""

from app.intelligence.calibration.feedback import (
    UserAction,
    feedback_score_for_action,
)
from app.intelligence.calibration.confidence import (
    CalibrationBucket,
    ConfidenceCalibration,
    ConfidenceInputs,
    bucketize,
    calibrated_confidence,
)
from app.intelligence.calibration.repository import (
    InMemoryQueryLogRepository,
    QueryLogNotFoundError,
    QueryLogRepository,
    SqlAlchemyQueryLogRepository,
)
from app.intelligence.calibration.reranker import (
    EvidenceCandidate,
    QueryContext,
    RerankResult,
    RerankedItem,
    rerank,
)
from app.intelligence.calibration.schemas import (
    QueryLogEntry,
    QueryLogEntryCreate,
    RankingBreakdown,
)
from app.intelligence.calibration.service import CalibrationService
from app.intelligence.calibration.weights import (
    RankingWeights,
    WeightsLoader,
    default_weights,
)

__all__ = [
    "CalibrationBucket",
    "CalibrationService",
    "ConfidenceCalibration",
    "ConfidenceInputs",
    "EvidenceCandidate",
    "InMemoryQueryLogRepository",
    "QueryContext",
    "QueryLogEntry",
    "QueryLogEntryCreate",
    "QueryLogNotFoundError",
    "QueryLogRepository",
    "RankingBreakdown",
    "RankingWeights",
    "RerankedItem",
    "RerankResult",
    "SqlAlchemyQueryLogRepository",
    "UserAction",
    "WeightsLoader",
    "bucketize",
    "calibrated_confidence",
    "default_weights",
    "feedback_score_for_action",
    "rerank",
]
