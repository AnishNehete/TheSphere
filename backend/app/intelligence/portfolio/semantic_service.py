"""Orchestration layer for the Phase 13B.3 semantic / event-pressure engine.

The pure engine (``app.intelligence.portfolio.semantic.engine``) never touches
I/O. This service does the fan-out:

1. Resolve the portfolio + build its exposure graph via :class:`ExposureService`
2. Collect events across exposed country codes via
   :meth:`EventRepository.by_country` (reusing existing ranking per D-23)
3. Filter events by ``ingested_at <= as_of`` so replay (13B.6) stays
   deterministic
4. Call :func:`score_holding` once per holding, then :func:`rollup_portfolio`

Per-symbol provider failures are isolated by catching per-country
``by_country`` exceptions — one broken country never poisons the whole
portfolio snapshot list.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone

from app.intelligence.portfolio.exposure_service import ExposureService
from app.intelligence.portfolio.replay import ReplayCursor
from app.intelligence.portfolio.repository import PortfolioRepository
from app.intelligence.portfolio.schemas import (
    ExposureEdge,
    ExposureGraph,
    PortfolioRecord,
)
from app.intelligence.portfolio.semantic import (
    PortfolioSemanticRollup,
    SemanticSnapshot,
    rollup_portfolio,
    score_holding,
)
from app.intelligence.repositories.event_repository import EventRepository
from app.intelligence.schemas import SignalEvent


logger = logging.getLogger(__name__)

EVENTS_PER_COUNTRY = 25
MAX_EVENTS_PER_PORTFOLIO_FETCH = 300


class SemanticPressureService:
    """Compose per-holding SemanticSnapshots + a portfolio rollup."""

    def __init__(
        self,
        *,
        repository: PortfolioRepository,
        events: EventRepository,
        exposure_service: ExposureService | None = None,
    ) -> None:
        self._repo = repository
        self._events = events
        self._exposure = exposure_service or ExposureService()

    async def build_for_portfolio(
        self,
        portfolio_id: str,
        *,
        as_of: datetime | None = None,
    ) -> tuple[list[SemanticSnapshot], PortfolioSemanticRollup]:
        record = await self._repo.get_portfolio(portfolio_id)
        return await self._build_from_record(record, as_of=as_of)

    async def _build_from_record(
        self,
        record: PortfolioRecord,
        *,
        as_of: datetime | None,
    ) -> tuple[list[SemanticSnapshot], PortfolioSemanticRollup]:
        as_of_ts = as_of or datetime.now(timezone.utc)
        if not record.holdings:
            return [], PortfolioSemanticRollup(
                portfolio_id=record.id,
                semantic_score=0.0,
                event_pressure_level="calm",
                top_drivers=[],
                contributing_event_count=0,
                as_of=as_of_ts,
                confidence=0.0,
            )

        graph: ExposureGraph = self._exposure.build_graph(record)
        edges_by_holding: dict[str, list[ExposureEdge]] = {}
        for edge in graph.edges:
            edges_by_holding.setdefault(edge.holding_id, []).append(edge)

        events = await self._collect_events(
            graph,
            limit=MAX_EVENTS_PER_PORTFOLIO_FETCH,
            cursor=ReplayCursor(as_of=as_of),
        )

        snapshots: list[SemanticSnapshot] = []
        for holding in record.holdings:
            edges = edges_by_holding.get(holding.id, [])
            snapshot = score_holding(holding, edges, events, as_of=as_of_ts)
            snapshots.append(snapshot)

        weights = {h.id: (h.weight or 0.0) for h in record.holdings}
        rollup = rollup_portfolio(
            record.id, weights, snapshots, as_of=as_of_ts
        )
        return snapshots, rollup

    async def _collect_events(
        self,
        graph: ExposureGraph,
        *,
        limit: int,
        cursor: ReplayCursor,
    ) -> list[SignalEvent]:
        """Fan out across exposed country nodes, dedupe by event id.

        Reuses :meth:`EventRepository.by_country` (existing ranking per D-23
        — no new ranking machinery here). Events excluded by
        ``cursor.truncate(ingested_at or source_timestamp)`` are dropped to
        preserve replay determinism (13B.6).
        """

        country_codes = {
            node.country_code
            for node in graph.nodes
            if node.domain == "country" and node.country_code
        }
        collected: dict[str, SignalEvent] = {}
        for code in country_codes:
            try:
                chunk = await self._events.by_country(
                    code, limit=EVENTS_PER_COUNTRY
                )
            except Exception as exc:  # pragma: no cover - defensive isolation
                logger.warning(
                    "semantic: by_country(%s) failed: %s", code, exc
                )
                continue
            for evt in chunk:
                # Filter events beyond the replay window.
                ts = evt.ingested_at or evt.source_timestamp
                if cursor.truncate(ts):
                    continue
                collected.setdefault(evt.id, evt)
                if len(collected) >= limit:
                    break
            if len(collected) >= limit:
                break
        return list(collected.values())


__all__ = [
    "EVENTS_PER_COUNTRY",
    "MAX_EVENTS_PER_PORTFOLIO_FETCH",
    "SemanticPressureService",
]
