"""Calibration service — append log + bucketize + simulate (Phase 18B).

Three responsibilities:

1. ``log()`` — append a new query-log entry; called from
   :class:`AgentQueryService` at the end of every response (including
   failed and fallback paths).
2. ``calibration()`` — pull a recent slice of the log and bucketise it
   so the admin endpoint can render a confidence-vs-usefulness table.
3. ``simulate_tuning()`` — replay the log under a candidate weight set
   and quantify the ranking lift versus the live config. The simulation
   is a *deterministic* reranker over previously-logged event ids — it
   does not hit any provider, never modifies persisted rows, and never
   commits the candidate weights.

The service stays thin so adapters (in-memory, SQL) and consumers
(routes, tests) can compose it freely.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Iterable, Sequence

from app.intelligence.calibration.confidence import (
    CalibrationBucket,
    bucketize,
)
from app.intelligence.calibration.feedback import (
    UserAction,
    feedback_score_for_action,
)
from app.intelligence.calibration.repository import (
    QueryLogRepository,
    default_window_lookback,
)
from app.intelligence.calibration.reranker import (
    EvidenceCandidate,
    QueryContext,
    rerank,
)
from app.intelligence.calibration.schemas import (
    QueryLogEntry,
    QueryLogEntryCreate,
)
from app.intelligence.calibration.weights import (
    RankingWeights,
    WeightsLoader,
    default_weights,
)


logger = logging.getLogger(__name__)


@dataclass(frozen=True, slots=True)
class CalibrationReport:
    """Snapshot returned by ``/admin/calibration``."""

    sample_count: int
    window_days: int
    buckets: list[CalibrationBucket]
    weights: RankingWeights


@dataclass(frozen=True, slots=True)
class TuningSimulation:
    """Result of replaying the log under candidate weights."""

    sample_count: int
    average_top_score_baseline: float
    average_top_score_candidate: float
    average_top_score_delta: float
    weights_baseline: RankingWeights
    weights_candidate: RankingWeights


class CalibrationService:
    """Public surface over the query log repository."""

    def __init__(
        self,
        *,
        repository: QueryLogRepository,
        weights_loader: WeightsLoader | None = None,
    ) -> None:
        self._repository = repository
        self._weights_loader = weights_loader or WeightsLoader()

    @property
    def weights_loader(self) -> WeightsLoader:
        return self._weights_loader

    @property
    def repository(self) -> QueryLogRepository:
        return self._repository

    async def log(self, entry: QueryLogEntryCreate) -> QueryLogEntry:
        try:
            return await self._repository.append(entry)
        except Exception as exc:  # pragma: no cover - defensive
            # Logging must never break the request path. Fall back to a
            # synthetic local row so the agent service can still cite an
            # id (otherwise unused) and continue.
            logger.warning(
                "calibration.service log append failed: %s; degrading", exc
            )
            return QueryLogEntry(
                id="qlog_local",
                timestamp=datetime.now(timezone.utc),
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

    async def record_user_action(
        self, entry_id: str, action: UserAction
    ) -> QueryLogEntry:
        return await self._repository.mark_user_action(entry_id, action)

    async def calibration(
        self, *, window_days: int = 30, limit: int = 5000
    ) -> CalibrationReport:
        since = datetime.now(timezone.utc) - timedelta(
            days=max(1, window_days)
        )
        rows = await self._repository.recent(limit=max(1, limit), since=since)
        buckets = bucketize(rows)
        return CalibrationReport(
            sample_count=len(rows),
            window_days=window_days,
            buckets=buckets,
            weights=self._weights_loader.current(),
        )

    async def simulate_tuning(
        self,
        candidate: RankingWeights,
        *,
        window_days: int = 30,
        limit: int = 2000,
    ) -> TuningSimulation:
        """Replay logged queries under ``candidate`` weights.

        The simulation reranks the *evidence id list* recorded for each
        query under both weights and reports the average top-1 final
        score lift. It is a coarse proxy for ranking improvement but it
        is deterministic, fast, and free of side effects — exactly what
        the admin loop needs to evaluate a tentative change.
        """

        since = datetime.now(timezone.utc) - timedelta(
            days=max(1, window_days)
        )
        rows = await self._repository.recent(limit=max(1, limit), since=since)
        baseline_weights = self._weights_loader.current()

        if not rows:
            return TuningSimulation(
                sample_count=0,
                average_top_score_baseline=0.0,
                average_top_score_candidate=0.0,
                average_top_score_delta=0.0,
                weights_baseline=baseline_weights,
                weights_candidate=candidate,
            )

        baseline_total = 0.0
        candidate_total = 0.0
        sample_count = 0
        for row in rows:
            candidates = _synthesise_candidates(row)
            if not candidates:
                continue
            ctx = QueryContext(now=row.timestamp, has_place_scope=True)
            base_top = rerank(candidates, ctx, weights=baseline_weights).top_score()
            cand_top = rerank(candidates, ctx, weights=candidate).top_score()
            # Weight the lift by the row's feedback signal so positive
            # samples count more — a high-feedback query that ranks
            # higher under the candidate is the actual goal.
            feedback = feedback_score_for_action(row.user_action)
            multiplier = 1.0 + 0.5 * max(0.0, feedback)
            baseline_total += base_top * multiplier
            candidate_total += cand_top * multiplier
            sample_count += 1

        if sample_count == 0:
            return TuningSimulation(
                sample_count=0,
                average_top_score_baseline=0.0,
                average_top_score_candidate=0.0,
                average_top_score_delta=0.0,
                weights_baseline=baseline_weights,
                weights_candidate=candidate,
            )

        baseline_avg = baseline_total / sample_count
        candidate_avg = candidate_total / sample_count
        return TuningSimulation(
            sample_count=sample_count,
            average_top_score_baseline=round(baseline_avg, 4),
            average_top_score_candidate=round(candidate_avg, 4),
            average_top_score_delta=round(candidate_avg - baseline_avg, 4),
            weights_baseline=baseline_weights,
            weights_candidate=candidate,
        )


def _synthesise_candidates(row: QueryLogEntry) -> list[EvidenceCandidate]:
    """Build placeholder candidates from a logged row.

    The query log doesn't store full event objects, only ids + scalar
    summaries. For tuning simulation we build synthetic candidates whose
    component scores are anchored on the row's recorded
    ``top_evidence_score`` and ``confidence_score``. This means the
    simulation captures the *relative* lift between weight sets — which
    is the question analysts ask — without needing a full event replay.
    """

    if not row.evidence_ids:
        return []
    candidates: list[EvidenceCandidate] = []
    base = max(0.05, row.top_evidence_score)
    for index, event_id in enumerate(row.evidence_ids[:8]):
        falloff = 0.85**index
        timestamp = row.timestamp
        candidates.append(
            EvidenceCandidate(
                event_id=event_id,
                base_score=base * falloff,
                severity_score=base * 0.9 * falloff,
                location_match_score=base * 0.7 * falloff,
                semantic_score=row.confidence_score * falloff,
                timestamp=timestamp,
                publisher=None,
                event_type=None,
                matched_terms=(),
                place_match=None,
            )
        )
    return candidates


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


__all__ = [
    "CalibrationReport",
    "CalibrationService",
    "TuningSimulation",
    "default_window_lookback",
]
