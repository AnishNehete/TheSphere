"""Compose a grounded :class:`PortfolioBrief`.

The brief is the analyst surface — it joins:

* the portfolio + holdings (from :class:`PortfolioRepository`)
* the exposure graph + per-domain summary (from :class:`ExposureService`)
* live world events filtered to the portfolio's exposed countries
  (via the existing :class:`EventRepository`)
* macro context for the dominant country (via Phase 12.3 macro profiles)
* dependency snippets that pin which holdings own which exposure

Everything carries confidence + rationale. No score lands without drivers.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone

from app.intelligence.geo.macro_profiles import macro_profile_for
from app.intelligence.portfolio.exposure_service import ExposureService
from app.intelligence.portfolio.market_data import (
    MarketDataProvider,
    PortfolioValuationSummary,
)
from app.intelligence.portfolio.replay import ReplayCursor
from app.intelligence.portfolio.schemas import (
    ExposureBucket,
    ExposureGraph,
    PortfolioBrief,
    PortfolioDependencyPath,
    PortfolioEntity,
    PortfolioExposureSummary,
    PortfolioLinkedEvent,
    PortfolioRecord,
    PortfolioRiskItem,
)
from app.intelligence.repositories.event_repository import EventRepository
from app.intelligence.schemas import SignalEvent


logger = logging.getLogger(__name__)


class PortfolioBriefService:
    """Compose a grounded portfolio brief from current portfolio state."""

    EVENTS_PER_COUNTRY = 6
    MAX_LINKED_EVENTS = 12
    MAX_RISKS = 6
    MAX_DEPENDENCY_PATHS = 5

    def __init__(
        self,
        *,
        repository: EventRepository,
        exposure_service: ExposureService | None = None,
        market_data_provider: MarketDataProvider | None = None,
        valuation_service: "object | None" = None,
    ) -> None:
        self._events = repository
        self._exposure_service = exposure_service or ExposureService()
        self._market_data_provider = market_data_provider
        self._valuation_service = valuation_service

    async def build(
        self,
        record: PortfolioRecord,
        *,
        cursor: ReplayCursor = ReplayCursor(),
        _now: datetime | None = None,
    ) -> PortfolioBrief:
        """Compose a grounded PortfolioBrief.

        Args:
            record: The portfolio record to build the brief for.
            cursor: Replay cursor — controls which events are included and
                whether this is a live or historical brief.
            _now: Optional datetime to pin ``generated_at`` for determinism
                tests. Do not use in production — it is a test hook only.
        """
        # Deep-copy holdings first so any valuation mutation stays scoped to
        # the brief and never leaks back into the repository record.
        brief_holdings = [h.model_copy(deep=True) for h in record.holdings]
        brief_record = record.model_copy(update={"holdings": brief_holdings})

        valuation_summary: PortfolioValuationSummary | None = None
        valuation_notes: list[str] = []
        if (
            self._market_data_provider is not None
            and self._valuation_service is not None
        ):
            symbols = [h.symbol for h in brief_holdings]
            snapshots = (
                await self._market_data_provider.get_snapshots(symbols)
                if symbols
                else {}
            )
            per_holding, valuation_summary = (
                self._valuation_service.aggregate_portfolio(
                    brief_record,
                    snapshots,
                    provider_id=self._market_data_provider.provider_id,
                )
            )
            self._valuation_service.apply_to_brief_holdings(
                brief_holdings, per_holding
            )
            # Honest partial-data copy.
            if valuation_summary.price_coverage < 1.0:
                priced = max(
                    0,
                    round(
                        valuation_summary.price_coverage * len(brief_holdings)
                    ),
                )
                missing = valuation_summary.missing_price_symbols[:5]
                missing_bit = f" Missing: {', '.join(missing)}." if missing else ""
                valuation_notes.append(
                    f"Prices: {priced}/{len(brief_holdings)} live.{missing_bit}"
                )
            if valuation_summary.weight_basis == "cost_basis_fallback":
                valuation_notes.append(
                    "Weights derived from cost basis (price coverage below 50%)."
                )
            elif valuation_summary.weight_basis == "even_split_fallback":
                valuation_notes.append(
                    "Weights derived from even split (no price or cost basis)."
                )
        else:
            valuation_notes.append(
                "Price provider not configured — valuation omitted."
            )

        graph = self._exposure_service.build_graph(brief_record)
        summary = self._exposure_service.build_summary(brief_record, graph)

        all_linked_events = await self._linked_events(brief_record, summary, graph)

        # When replaying, filter linked events to those ingested at or before
        # as_of so the brief reflects only evidence available at that moment.
        if not cursor.is_live:
            linked_events = [
                evt
                for evt in all_linked_events
                if not cursor.truncate(
                    evt.source_timestamp
                )
            ]
        else:
            linked_events = all_linked_events

        top_risks = self._top_risks(summary, linked_events)
        dependencies = self._dependency_paths(
            brief_record, summary, linked_events, graph
        )
        entity = self._entity(brief_record, summary)
        confidence = self._confidence(brief_record, summary, linked_events)
        notes = self._compose_notes(brief_record, summary) + valuation_notes

        # Replay marker — never confuse a historical brief with a live one.
        if not cursor.is_live:
            assert cursor.as_of is not None  # narrowing for type checker
            notes = notes + [f"As-of replay: {cursor.as_of.isoformat()}"]

        generated_at = _now or datetime.now(timezone.utc)

        return PortfolioBrief(
            portfolio_id=record.id,
            name=record.name,
            base_currency=record.base_currency,
            generated_at=generated_at,
            holdings_count=len(brief_holdings),
            holdings=brief_holdings,
            exposure_summary=summary,
            exposure_graph=graph,
            dependency_paths=dependencies,
            top_risks=top_risks,
            linked_events=linked_events,
            entity=entity,
            confidence=round(confidence, 3),
            notes=notes,
            valuation_summary=valuation_summary,
        )

    # ---- linked events --------------------------------------------------

    async def _linked_events(
        self,
        record: PortfolioRecord,
        summary: PortfolioExposureSummary,
        graph: ExposureGraph,
    ) -> list[PortfolioLinkedEvent]:
        country_codes = {b.node.country_code for b in summary.countries if b.node.country_code}
        if not country_codes:
            return []

        country_events: dict[str, list[SignalEvent]] = {}
        for code in country_codes:
            events = await self._events.by_country(code, limit=self.EVENTS_PER_COUNTRY)
            country_events[code] = events

        # Map exposure-node hits to events for explainability.
        node_lookup_by_country: dict[str, list[str]] = {}
        for bucket in summary.countries:
            if bucket.node.country_code:
                node_lookup_by_country.setdefault(
                    bucket.node.country_code, []
                ).append(bucket.node.id)

        linked: list[PortfolioLinkedEvent] = []
        for code, events in country_events.items():
            for event in events:
                source = event.sources[0] if event.sources else None
                linked.append(
                    PortfolioLinkedEvent(
                        event_id=event.id,
                        title=event.title,
                        type=event.type,
                        severity=event.severity,
                        severity_score=event.severity_score,
                        country_code=event.place.country_code,
                        country_name=event.place.country_name,
                        source_timestamp=event.source_timestamp,
                        publisher=source.publisher if source else None,
                        url=source.url if source else None,
                        matched_exposure_node_ids=node_lookup_by_country.get(code, []),
                    )
                )

        # rank: severity first, then recency, then country weight
        country_weight = {
            b.node.country_code: b.weight
            for b in summary.countries
            if b.node.country_code
        }
        linked.sort(
            key=lambda evt: (
                evt.severity_score,
                country_weight.get(evt.country_code or "", 0.0),
                (evt.source_timestamp or datetime.min.replace(tzinfo=timezone.utc)),
            ),
            reverse=True,
        )
        return linked[: self.MAX_LINKED_EVENTS]

    # ---- top risks ------------------------------------------------------

    def _top_risks(
        self,
        summary: PortfolioExposureSummary,
        linked_events: list[PortfolioLinkedEvent],
    ) -> list[PortfolioRiskItem]:
        risks: list[PortfolioRiskItem] = []

        # 1. Country concentration risks (top 2)
        for bucket in summary.countries[:2]:
            severity = "elevated" if bucket.weight > 0.5 else "watch"
            risks.append(
                PortfolioRiskItem(
                    title=f"Country concentration: {bucket.node.label}",
                    rationale=(
                        f"{int(bucket.weight * 100)}% of portfolio weight is exposed "
                        f"to {bucket.node.label}. Country-specific shocks have "
                        "outsized portfolio impact."
                    ),
                    severity=severity,  # type: ignore[arg-type]
                    confidence=bucket.confidence,
                    exposure_node_id=bucket.node.id,
                )
            )

        # 2. Currency concentration outside the base currency
        non_base = [b for b in summary.currencies[:3]]
        for bucket in non_base[:1]:
            risks.append(
                PortfolioRiskItem(
                    title=f"FX exposure: {bucket.node.label}",
                    rationale=(
                        f"{int(bucket.weight * 100)}% of weight settles in "
                        f"{bucket.node.label}. FX moves vs. base currency "
                        "translate directly into reported P&L."
                    ),
                    severity="watch",
                    confidence=bucket.confidence,
                    exposure_node_id=bucket.node.id,
                )
            )

        # 3. Commodity / chokepoint exposure (top 2 commodities, top 1 chokepoint)
        for bucket in summary.commodities[:2]:
            risks.append(
                PortfolioRiskItem(
                    title=f"{bucket.node.label} sensitivity",
                    rationale=(
                        f"Holdings are exposed to {bucket.node.label} "
                        f"({int(bucket.weight * 100)}%). Supply / price shocks "
                        "feed straight into producer or consumer margins."
                    ),
                    severity="watch",
                    confidence=bucket.confidence,
                    exposure_node_id=bucket.node.id,
                )
            )
        for bucket in summary.chokepoints[:1]:
            risks.append(
                PortfolioRiskItem(
                    title=f"Chokepoint exposure: {bucket.node.label}",
                    rationale=(
                        f"Portfolio freight / supply lines route through "
                        f"{bucket.node.label}. Closure events lengthen "
                        "transit and inflate freight rates."
                    ),
                    severity="elevated",
                    confidence=bucket.confidence,
                    exposure_node_id=bucket.node.id,
                )
            )

        # 4. Live event-driven risks — fold the highest-severity linked event
        if linked_events:
            top_event = linked_events[0]
            if top_event.severity_score >= 0.6:
                risks.append(
                    PortfolioRiskItem(
                        title=f"Live: {top_event.title[:80]}",
                        rationale=(
                            "Active world-event signal lands inside a country "
                            "your portfolio is exposed to."
                        ),
                        severity=top_event.severity,  # type: ignore[arg-type]
                        confidence=min(1.0, top_event.severity_score),
                        exposure_node_id=(
                            top_event.matched_exposure_node_ids[0]
                            if top_event.matched_exposure_node_ids
                            else None
                        ),
                        related_event_ids=[top_event.event_id],
                    )
                )

        return risks[: self.MAX_RISKS]

    # ---- dependency paths -----------------------------------------------

    def _dependency_paths(
        self,
        record: PortfolioRecord,
        summary: PortfolioExposureSummary,
        linked_events: list[PortfolioLinkedEvent],
        graph: ExposureGraph,
    ) -> list[PortfolioDependencyPath]:
        paths: list[PortfolioDependencyPath] = []

        # 1. Country -> macro -> portfolio chain for the top country
        for bucket in summary.countries[:2]:
            if not bucket.node.country_code:
                continue
            macro = macro_profile_for(bucket.node.country_code)
            if macro is None:
                continue
            path_id = f"port-dep-country-{bucket.node.country_code}"
            paths.append(
                PortfolioDependencyPath(
                    id=path_id,
                    title=(
                        f"{bucket.node.label} macro → {macro.currency_code} "
                        "→ portfolio P&L"
                    ),
                    rationale=(
                        f"{int(bucket.weight * 100)}% of weight in "
                        f"{bucket.node.label}; shocks transmit via "
                        f"{macro.currency_code} and the country's "
                        f"{', '.join(macro.sector_tags[:2]) or 'core sectors'}."
                    ),
                    overall_confidence=round(min(0.85, bucket.confidence + 0.1), 3),
                    contributing_holdings=list(bucket.contributing_holdings),
                    exposure_node_id=bucket.node.id,
                    related_event_ids=[
                        e.event_id
                        for e in linked_events
                        if e.country_code == bucket.node.country_code
                    ][:3],
                )
            )

        # 2. Commodity → margin chain for top commodity
        for bucket in summary.commodities[:1]:
            paths.append(
                PortfolioDependencyPath(
                    id=f"port-dep-commodity-{bucket.node.id.split(':', 1)[-1]}",
                    title=f"{bucket.node.label} → producer / consumer margin → P&L",
                    rationale=(
                        f"{bucket.node.label} price moves reset margin "
                        "outlook for the contributing holdings."
                    ),
                    overall_confidence=round(min(0.7, bucket.confidence), 3),
                    contributing_holdings=list(bucket.contributing_holdings),
                    exposure_node_id=bucket.node.id,
                )
            )

        # 3. Chokepoint → freight → P&L for top chokepoint
        for bucket in summary.chokepoints[:1]:
            paths.append(
                PortfolioDependencyPath(
                    id=f"port-dep-chokepoint-{bucket.node.id.split(':', 1)[-1]}",
                    title=f"{bucket.node.label} → freight rates → exposed equities",
                    rationale=(
                        f"Disruption at {bucket.node.label} forces rerouting; "
                        "freight + insurance costs hit holdings carrying that route."
                    ),
                    overall_confidence=round(min(0.7, bucket.confidence + 0.05), 3),
                    contributing_holdings=list(bucket.contributing_holdings),
                    exposure_node_id=bucket.node.id,
                )
            )

        return paths[: self.MAX_DEPENDENCY_PATHS]

    # ---- entity + confidence + notes ------------------------------------

    def _entity(
        self,
        record: PortfolioRecord,
        summary: PortfolioExposureSummary,
    ) -> PortfolioEntity:
        return PortfolioEntity(
            id=record.id,
            name=record.name,
            primary_country_codes=[
                b.node.country_code for b in summary.countries[:3] if b.node.country_code
            ],
            primary_sectors=[b.node.label for b in summary.sectors[:3]],
            primary_currencies=[b.node.label for b in summary.currencies[:3]],
        )

    def _confidence(
        self,
        record: PortfolioRecord,
        summary: PortfolioExposureSummary,
        linked_events: list[PortfolioLinkedEvent],
    ) -> float:
        if not record.holdings:
            return 0.0
        avg_enrichment = sum(h.enrichment_confidence for h in record.holdings) / len(
            record.holdings
        )
        coverage = min(1.0, len(summary.countries) / 3)
        liveness = min(1.0, len(linked_events) / 6)
        return min(0.95, 0.45 * avg_enrichment + 0.25 * coverage + 0.15 * liveness + 0.1)

    def _compose_notes(
        self,
        record: PortfolioRecord,
        summary: PortfolioExposureSummary,
    ) -> list[str]:
        notes: list[str] = []
        unenriched = [h for h in record.holdings if h.enrichment_confidence < 0.5]
        if unenriched:
            symbols = ", ".join(h.symbol for h in unenriched[:5])
            notes.append(
                f"Low enrichment confidence for: {symbols}. Add country / sector "
                "metadata to sharpen exposure mapping."
            )
        if not summary.countries:
            notes.append(
                "No country exposure resolved. Add country metadata or use "
                "tickers from the recognized catalogue."
            )
        return notes


__all__ = ["PortfolioBriefService"]
