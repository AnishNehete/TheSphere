"""Admin / calibration routes (Phase 18B).

Endpoints exposed under ``/api/intelligence/admin``:

* ``GET  /admin/debug-ranking?query=...``   — score breakdown for a query
* ``GET  /admin/calibration``                — confidence-vs-usefulness buckets
* ``POST /admin/tune``                       — simulate ranking lift under
                                                candidate weights
* ``POST /feedback``                         — record an implicit feedback
                                                signal against a logged
                                                query

These are intentionally not authenticated by this module — the closed
beta runs behind the platform-level auth shim. The contract is what
matters: the endpoints never mutate persisted data except for the
narrow ``user_action`` stamp on a query log row.
"""

from __future__ import annotations

from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from pydantic import BaseModel, ConfigDict, Field

from app.intelligence.calibration import (
    CalibrationService,
    QueryLogEntry,
    QueryLogNotFoundError,
    RankingWeights,
    UserAction,
)
from app.intelligence.calibration.confidence import CalibrationBucket
from app.intelligence.calibration.service import (
    CalibrationReport,
    TuningSimulation,
)
from app.intelligence.runtime import IntelligenceRuntime
from app.intelligence.schemas import SignalEvent
from app.intelligence.services.search_service import ScoreBreakdown


router = APIRouter(prefix="/api/intelligence", tags=["intelligence-admin"])


def _runtime(request: Request) -> IntelligenceRuntime:
    runtime = getattr(request.app.state, "intelligence", None)
    if runtime is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Intelligence runtime is not ready yet.",
        )
    return runtime


def _calibration(runtime: IntelligenceRuntime) -> CalibrationService:
    if runtime.calibration_service is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Calibration service is not configured.",
        )
    return runtime.calibration_service


# ---------- debug ranking ----------------------------------------------------


class DebugRankingHit(BaseModel):
    model_config = ConfigDict(frozen=True)
    event: SignalEvent
    score: float
    matched_terms: list[str]
    place_match: str | None
    breakdown: ScoreBreakdown | None


class DebugRankingResponse(BaseModel):
    model_config = ConfigDict(frozen=True)
    query: str
    resolved_country_code: str | None
    total: int
    hits: list[DebugRankingHit]


@router.get("/admin/debug-ranking", response_model=DebugRankingResponse)
async def debug_ranking(
    runtime: Annotated[IntelligenceRuntime, Depends(_runtime)],
    query: str = Query(..., min_length=1, description="Query to inspect"),
    limit: int = Query(default=10, ge=1, le=50),
) -> DebugRankingResponse:
    response = await runtime.search_service.search(query=query, limit=limit)
    return DebugRankingResponse(
        query=response.query,
        resolved_country_code=response.resolved_country_code,
        total=response.total,
        hits=[
            DebugRankingHit(
                event=hit.event,
                score=hit.score,
                matched_terms=list(hit.matched_terms),
                place_match=hit.place_match,
                breakdown=hit.breakdown,
            )
            for hit in response.hits
        ],
    )


# ---------- calibration distribution -----------------------------------------


class CalibrationBucketModel(BaseModel):
    model_config = ConfigDict(frozen=True)
    label: str
    lower: float
    upper: float
    sample_count: int
    positive_signal_share: float
    negative_signal_share: float
    average_feedback: float

    @classmethod
    def from_bucket(cls, bucket: CalibrationBucket) -> "CalibrationBucketModel":
        return cls(
            label=bucket.label,
            lower=bucket.lower,
            upper=bucket.upper,
            sample_count=bucket.sample_count,
            positive_signal_share=bucket.positive_signal_share,
            negative_signal_share=bucket.negative_signal_share,
            average_feedback=bucket.average_feedback,
        )


class CalibrationResponse(BaseModel):
    model_config = ConfigDict(frozen=True)
    sample_count: int
    window_days: int
    buckets: list[CalibrationBucketModel]
    weights: dict[str, float]


@router.get("/admin/calibration", response_model=CalibrationResponse)
async def calibration_distribution(
    runtime: Annotated[IntelligenceRuntime, Depends(_runtime)],
    window_days: int = Query(default=30, ge=1, le=365),
) -> CalibrationResponse:
    service = _calibration(runtime)
    report: CalibrationReport = await service.calibration(window_days=window_days)
    return CalibrationResponse(
        sample_count=report.sample_count,
        window_days=report.window_days,
        buckets=[CalibrationBucketModel.from_bucket(b) for b in report.buckets],
        weights=report.weights.to_dict(),
    )


# ---------- tune simulation --------------------------------------------------


class WeightsPayload(BaseModel):
    """Optional weights override — every field defaults to the current value."""

    model_config = ConfigDict(extra="forbid")

    freshness_weight: float | None = Field(default=None, ge=0.0, le=1.0)
    severity_weight: float | None = Field(default=None, ge=0.0, le=1.0)
    geo_weight: float | None = Field(default=None, ge=0.0, le=1.0)
    diversity_weight: float | None = Field(default=None, ge=0.0, le=1.0)
    semantic_weight: float | None = Field(default=None, ge=0.0, le=1.0)
    recency_half_life_hours: float | None = Field(
        default=None, gt=0.0, le=24.0 * 30
    )
    confidence_evidence_weight: float | None = Field(default=None, ge=0.0, le=1.0)
    confidence_agreement_weight: float | None = Field(default=None, ge=0.0, le=1.0)
    confidence_recency_weight: float | None = Field(default=None, ge=0.0, le=1.0)
    confidence_diversity_weight: float | None = Field(default=None, ge=0.0, le=1.0)
    confidence_resolution_weight: float | None = Field(default=None, ge=0.0, le=1.0)


class TuneRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    weights: WeightsPayload
    window_days: int = Field(default=30, ge=1, le=365)


class TuneResponse(BaseModel):
    model_config = ConfigDict(frozen=True)
    sample_count: int
    average_top_score_baseline: float
    average_top_score_candidate: float
    average_top_score_delta: float
    weights_baseline: dict[str, float]
    weights_candidate: dict[str, float]


@router.post("/admin/tune", response_model=TuneResponse)
async def tune_simulation(
    payload: TuneRequest,
    runtime: Annotated[IntelligenceRuntime, Depends(_runtime)],
) -> TuneResponse:
    service = _calibration(runtime)
    baseline = service.weights_loader.current()
    overrides = payload.weights.model_dump(exclude_none=True)
    candidate = baseline if not overrides else _merge_weights(baseline, overrides)
    simulation: TuningSimulation = await service.simulate_tuning(
        candidate, window_days=payload.window_days
    )
    return TuneResponse(
        sample_count=simulation.sample_count,
        average_top_score_baseline=simulation.average_top_score_baseline,
        average_top_score_candidate=simulation.average_top_score_candidate,
        average_top_score_delta=simulation.average_top_score_delta,
        weights_baseline=simulation.weights_baseline.to_dict(),
        weights_candidate=simulation.weights_candidate.to_dict(),
    )


def _merge_weights(
    baseline: RankingWeights, overrides: dict[str, float]
) -> RankingWeights:
    payload = baseline.to_dict()
    payload.update(overrides)
    return RankingWeights(**payload)


# ---------- implicit feedback ------------------------------------------------


_FEEDBACK_ACTIONS: tuple[str, ...] = ("none", "click", "share", "refine")


class FeedbackRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    query_log_id: str
    action: Literal["none", "click", "share", "refine"]


class FeedbackResponse(BaseModel):
    model_config = ConfigDict(frozen=True)
    query_log_id: str
    action: str
    feedback_score: float
    confidence_score: float


@router.post("/feedback", response_model=FeedbackResponse)
async def record_feedback(
    payload: FeedbackRequest,
    runtime: Annotated[IntelligenceRuntime, Depends(_runtime)],
) -> FeedbackResponse:
    service = _calibration(runtime)
    try:
        entry: QueryLogEntry = await service.record_user_action(
            payload.query_log_id, payload.action  # type: ignore[arg-type]
        )
    except QueryLogNotFoundError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Query log entry not found: {exc}",
        ) from exc
    return FeedbackResponse(
        query_log_id=entry.id,
        action=entry.user_action,
        feedback_score=entry.feedback_score,
        confidence_score=entry.confidence_score,
    )


__all__ = ["router"]
