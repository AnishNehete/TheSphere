"""Orchestration for the portfolio Macro Risk Score (Phase 13B.4).

Pulls:

* holdings + exposure summary + linked events via :class:`PortfolioBriefService`
  (reuses existing composition so the score aligns with what the analyst sees
  in the brief surface)
* semantic rollup via :class:`SemanticPressureService`
* per-commodity / per-chokepoint event severity aggregates derived from the
  brief's ``linked_events.matched_exposure_node_ids``

Assembles these into the pure engine's inputs. Maintains a per-portfolio
in-memory rolling history of the last 30 computed live scores so
:func:`delta_vs_baseline` has something to compare against; Plan 13B.6 will
replace the deque with a deterministic replay window.

History discipline (see 13b-04-PLAN.md D-25 notes):

* Live calls (``as_of is None``) append their score to the history.
* Replay / as-of calls DO NOT mutate history so the engine stays deterministic.
"""

from __future__ import annotations

import logging
from collections import defaultdict, deque
from datetime import datetime, timezone
from typing import Iterable, Sequence

from app.intelligence.portfolio.brief_service import PortfolioBriefService
from app.intelligence.portfolio.exposure_service import ExposureService
from app.intelligence.portfolio.replay import ReplayCursor
from app.intelligence.portfolio.repository import PortfolioRepository
from app.intelligence.portfolio.risk import (
    PortfolioMacroRiskScore,
    build_risk_score,
)
from app.intelligence.portfolio.schemas import (
    ExposureBucket,
    PortfolioBrief,
    PortfolioLinkedEvent,
    PortfolioRecord,
)
from app.intelligence.portfolio.semantic.schemas import PortfolioSemanticRollup
from app.intelligence.portfolio.semantic_service import SemanticPressureService
from app.intelligence.portfolio.technical.schemas import TechnicalSnapshot


logger = logging.getLogger(__name__)

BASELINE_HISTORY_MAX = 30


class PortfolioRiskScoreService:
    """Compose a :class:`PortfolioMacroRiskScore` for a portfolio."""

    def __init__(
        self,
        *,
        repository: PortfolioRepository,
        brief_service: PortfolioBriefService,
        semantic_service: SemanticPressureService | None,
        exposure_service: ExposureService | None = None,
        baseline_history_max: int = BASELINE_HISTORY_MAX,
        technical_service: object | None = None,
    ) -> None:
        self._repo = repository
        self._brief = brief_service
        self._semantic = semantic_service
        self._exposure = exposure_service or ExposureService()
        self._history_max = baseline_history_max
        self._history: dict[str, deque[float]] = defaultdict(
            lambda: deque(maxlen=baseline_history_max)
        )
        # Optional — when present, technical snapshots feed the tilt aggregator.
        self._technical = technical_service

    async def build_for_portfolio(
        self,
        portfolio_id: str,
        *,
        as_of: datetime | None = None,
    ) -> PortfolioMacroRiskScore:
        record = await self._repo.get_portfolio(portfolio_id)
        cursor = ReplayCursor(as_of=as_of)
        return await self._build_from_record(record, cursor=cursor)

    async def _build_from_record(
        self,
        record: PortfolioRecord,
        *,
        cursor: ReplayCursor,
    ) -> PortfolioMacroRiskScore:
        as_of_ts = cursor.as_of or datetime.now(timezone.utc)

        brief: PortfolioBrief = await self._brief.build(record, cursor=cursor)

        severity_by_commodity = _severity_by_label(
            brief.exposure_summary.commodities, brief.linked_events
        )
        severity_by_chokepoint = _severity_by_label(
            brief.exposure_summary.chokepoints, brief.linked_events
        )

        semantic_rollup: PortfolioSemanticRollup | None = None
        if self._semantic is not None:
            try:
                _snaps, semantic_rollup = await self._semantic.build_for_portfolio(
                    record.id, as_of=as_of_ts
                )
            except Exception as exc:  # pragma: no cover - defensive isolation
                logger.warning("risk: semantic fetch failed: %s", exc)

        technical_snapshots: list[TechnicalSnapshot] = []
        if self._technical is not None:
            try:
                technical_snapshots = await self._technical.build_for_portfolio(
                    record.id, as_of=cursor.as_of
                )
            except Exception as exc:  # pragma: no cover - defensive isolation
                logger.warning("risk: technical fetch failed: %s", exc)

        freshness_seconds = _freshness_seconds(brief.linked_events, as_of_ts)

        confidence_hint = _confidence_hint(brief, semantic_rollup)

        baseline = list(self._history[record.id])
        score = build_risk_score(
            portfolio_id=record.id,
            holdings=brief.holdings,
            exposure_summary=brief.exposure_summary,
            linked_events=brief.linked_events,
            semantic_rollup=semantic_rollup,
            severity_by_commodity=severity_by_commodity,
            severity_by_chokepoint=severity_by_chokepoint,
            baseline_scores=baseline,
            confidence_hint=confidence_hint,
            freshness_seconds=freshness_seconds,
            as_of=as_of_ts,
            technical_snapshots=technical_snapshots,
        )

        # Only persist history for live calls. Replay must not contaminate the
        # rolling baseline — cursor.is_live is the single authoritative gate.
        if cursor.is_live:
            self._history[record.id].append(score.risk_score)

        return score


def _severity_by_label(
    buckets: Iterable[ExposureBucket],
    linked_events: Sequence[PortfolioLinkedEvent],
) -> dict[str, float]:
    """Average severity of events matched to each exposure bucket.

    Keyed by the bucket's ``node.label`` (which is what the pure engine's
    severity maps consume) so the engine can compute
    ``weight × severity`` without re-walking the graph.
    """

    events_by_node: dict[str, list[PortfolioLinkedEvent]] = defaultdict(list)
    for evt in linked_events:
        for node_id in evt.matched_exposure_node_ids:
            events_by_node[node_id].append(evt)

    severity_by_label: dict[str, float] = {}
    for bucket in buckets:
        evts = events_by_node.get(bucket.node.id, [])
        if not evts:
            continue
        severity_by_label[bucket.node.label] = sum(
            e.severity_score for e in evts
        ) / len(evts)
    return severity_by_label


def _freshness_seconds(
    linked_events: Sequence[PortfolioLinkedEvent],
    as_of_ts: datetime,
) -> int:
    """Age (in seconds) of the most recent linked event; 0 when none."""

    if not linked_events:
        return 0
    newest = max(
        (e.source_timestamp for e in linked_events if e.source_timestamp),
        default=None,
    )
    if newest is None:
        return 0
    delta = (as_of_ts - newest).total_seconds()
    return int(max(0, delta))


def _confidence_hint(
    brief: PortfolioBrief, semantic_rollup: PortfolioSemanticRollup | None
) -> float:
    """Blend brief confidence + semantic confidence + live coverage.

    Weights (sum = 1.0):
      * 0.30 brief.confidence
      * 0.20 semantic rollup confidence (0 when no rollup)
      * 0.20 event liveness (saturates at 6 linked events)
      * 0.15 valuation coverage (full when price_coverage >= 0.5, else 0.4)
      * 0.15 floor — ensures a minimum 0.15 floor so tests don't collide with 0
    """

    brief_c = max(0.0, min(1.0, brief.confidence))
    sem_c = (
        max(0.0, min(1.0, semantic_rollup.confidence))
        if semantic_rollup is not None
        else 0.0
    )
    liveness = min(1.0, len(brief.linked_events) / 6)
    val_ok = (
        1.0
        if (
            brief.valuation_summary is not None
            and brief.valuation_summary.price_coverage >= 0.5
        )
        else 0.4
    )
    blended = (
        0.30 * brief_c
        + 0.20 * sem_c
        + 0.20 * liveness
        + 0.15 * val_ok
        + 0.15
    )
    return round(max(0.0, min(1.0, blended)), 3)


__all__ = [
    "BASELINE_HISTORY_MAX",
    "PortfolioRiskScoreService",
]
