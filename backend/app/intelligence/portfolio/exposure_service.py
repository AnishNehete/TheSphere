"""Exposure-graph builder.

Given a portfolio, compute:

* a normalized weight per holding (uses ``market_value`` when present,
  otherwise an even split — we never invent a price)
* an :class:`ExposureGraph` mapping each holding to country / sector /
  currency / commodity / chokepoint / macro_theme nodes
* a :class:`PortfolioExposureSummary` with the top buckets per domain

Every edge carries a confidence (the symbol's enrichment confidence ×
the per-channel weight) and a one-line rationale so the analyst UI can
explain why "JPY" lit up on a Toyota holding.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

from app.intelligence.geo.macro_profiles import macro_profile_for
from app.intelligence.portfolio.schemas import (
    ExposureBucket,
    ExposureEdge,
    ExposureGraph,
    ExposureNode,
    Holding,
    PortfolioExposureSummary,
    PortfolioRecord,
)


logger = logging.getLogger(__name__)


@dataclass(slots=True)
class _NodeAccumulator:
    node: ExposureNode
    weight: float = 0.0
    confidence_numer: float = 0.0
    confidence_denom: float = 0.0
    contributing_holdings: list[str] = None  # type: ignore[assignment]
    rationale_template: str | None = None

    def __post_init__(self) -> None:
        if self.contributing_holdings is None:
            self.contributing_holdings = []

    def add(self, *, holding_id: str, weight: float, confidence: float) -> None:
        self.weight += weight
        self.confidence_numer += confidence * max(weight, 1e-6)
        self.confidence_denom += max(weight, 1e-6)
        if holding_id not in self.contributing_holdings:
            self.contributing_holdings.append(holding_id)

    def to_bucket(self) -> ExposureBucket:
        confidence = (
            self.confidence_numer / self.confidence_denom
            if self.confidence_denom > 0
            else 0.0
        )
        return ExposureBucket(
            node=self.node,
            weight=round(min(1.0, self.weight), 4),
            confidence=round(min(1.0, confidence), 3),
            contributing_holdings=list(self.contributing_holdings),
            rationale=self.rationale_template,
        )


class ExposureService:
    """Build an exposure graph + summary from a portfolio record."""

    TOP_N_PER_DOMAIN = 6

    def build_graph(self, record: PortfolioRecord) -> ExposureGraph:
        graph = ExposureGraph(portfolio_id=record.id)
        holdings = _normalize_weights(record.holdings)
        accumulators: dict[str, _NodeAccumulator] = {}

        for holding in holdings:
            self._project_country(holding, accumulators, graph)
            self._project_currency(holding, accumulators, graph)
            self._project_sector(holding, accumulators, graph)
            self._project_commodities(holding, accumulators, graph)
            self._project_macro(holding, accumulators, graph)
            self._project_chokepoints(holding, accumulators, graph)
            self._project_asset_class(holding, accumulators, graph)

        # nodes aren't deduped while building edges; collapse here
        seen: dict[str, ExposureNode] = {}
        for node in graph.nodes:
            seen.setdefault(node.id, node)
        graph.nodes = list(seen.values())
        return graph

    def build_summary(
        self, record: PortfolioRecord, graph: ExposureGraph
    ) -> PortfolioExposureSummary:
        accumulators = _accumulate(record, graph)
        return PortfolioExposureSummary(
            countries=_top_buckets(accumulators, "country", self.TOP_N_PER_DOMAIN),
            sectors=_top_buckets(accumulators, "sector", self.TOP_N_PER_DOMAIN),
            currencies=_top_buckets(accumulators, "currency", self.TOP_N_PER_DOMAIN),
            commodities=_top_buckets(accumulators, "commodity", self.TOP_N_PER_DOMAIN),
            macro_themes=_top_buckets(accumulators, "macro_theme", self.TOP_N_PER_DOMAIN),
            chokepoints=_top_buckets(accumulators, "chokepoint", self.TOP_N_PER_DOMAIN),
        )

    # ---- per-domain projections --------------------------------------

    def _project_country(
        self,
        holding: Holding,
        acc: dict[str, _NodeAccumulator],
        graph: ExposureGraph,
    ) -> None:
        if not holding.country_code:
            return
        node_id = f"country:{holding.country_code}"
        node = ExposureNode(
            id=node_id,
            domain="country",
            label=holding.country_code,
            country_code=holding.country_code,
        )
        _ensure(acc, node)
        rationale = (
            f"{holding.symbol} is listed in {holding.country_code} → exposure "
            "to local equity beta and sovereign / regulatory environment."
        )
        acc[node_id].rationale_template = rationale
        acc[node_id].add(
            holding_id=holding.id,
            weight=holding.weight,
            confidence=holding.enrichment_confidence,
        )
        graph.nodes.append(node)
        graph.edges.append(
            ExposureEdge(
                holding_id=holding.id,
                node_id=node_id,
                weight=round(holding.weight, 4),
                confidence=round(holding.enrichment_confidence, 3),
                rationale=rationale,
            )
        )

    def _project_currency(
        self,
        holding: Holding,
        acc: dict[str, _NodeAccumulator],
        graph: ExposureGraph,
    ) -> None:
        if not holding.currency:
            return
        node_id = f"currency:{holding.currency}"
        node = ExposureNode(
            id=node_id,
            domain="currency",
            label=holding.currency,
            country_code=holding.country_code,
        )
        _ensure(acc, node)
        rationale = (
            f"{holding.symbol} settles in {holding.currency} → portfolio "
            "is exposed to FX moves vs. base currency."
        )
        acc[node_id].rationale_template = rationale
        acc[node_id].add(
            holding_id=holding.id,
            weight=holding.weight,
            confidence=holding.enrichment_confidence,
        )
        graph.nodes.append(node)
        graph.edges.append(
            ExposureEdge(
                holding_id=holding.id,
                node_id=node_id,
                weight=round(holding.weight, 4),
                confidence=round(holding.enrichment_confidence * 0.9, 3),
                rationale=rationale,
            )
        )

    def _project_sector(
        self,
        holding: Holding,
        acc: dict[str, _NodeAccumulator],
        graph: ExposureGraph,
    ) -> None:
        sector_exposure = holding.metadata.get("sector_exposure", {}) or {}
        if not sector_exposure and holding.sector:
            sector_exposure = {holding.sector.lower(): 1.0}
        for sector, factor in sector_exposure.items():
            if not sector or factor <= 0:
                continue
            node_id = f"sector:{sector}"
            node = ExposureNode(
                id=node_id,
                domain="sector",
                label=sector.replace("-", " ").title(),
            )
            _ensure(acc, node)
            edge_weight = round(holding.weight * factor, 4)
            rationale = (
                f"{holding.symbol} contributes "
                f"{int(factor * 100)}% sector weight to {node.label}."
            )
            acc[node_id].rationale_template = (
                acc[node_id].rationale_template or rationale
            )
            acc[node_id].add(
                holding_id=holding.id,
                weight=edge_weight,
                confidence=holding.enrichment_confidence,
            )
            graph.nodes.append(node)
            graph.edges.append(
                ExposureEdge(
                    holding_id=holding.id,
                    node_id=node_id,
                    weight=edge_weight,
                    confidence=round(holding.enrichment_confidence * factor, 3),
                    rationale=rationale,
                )
            )

    def _project_commodities(
        self,
        holding: Holding,
        acc: dict[str, _NodeAccumulator],
        graph: ExposureGraph,
    ) -> None:
        commodity_exposure = holding.metadata.get("commodity_exposure", {}) or {}
        # Layer in the country macro profile's export/import sensitivity so
        # ETFs without an explicit commodity tag still pick up "Japan -> oil
        # imports" exposure.
        macro = macro_profile_for(holding.country_code)
        macro_blend: dict[str, float] = {}
        if macro is not None:
            for commodity, weight in macro.commodity_import_sensitivity.items():
                macro_blend[commodity] = max(macro_blend.get(commodity, 0.0), weight * 0.4)
            for commodity, weight in macro.commodity_export_sensitivity.items():
                macro_blend[commodity] = max(macro_blend.get(commodity, 0.0), weight * 0.4)
        merged = dict(macro_blend)
        for commodity, factor in commodity_exposure.items():
            merged[commodity] = max(merged.get(commodity, 0.0), float(factor))

        for commodity, factor in merged.items():
            if not commodity or factor <= 0:
                continue
            node_id = f"commodity:{commodity}"
            label = commodity.replace("_", " ").replace("-", " ").title()
            node = ExposureNode(
                id=node_id,
                domain="commodity",
                label=label,
            )
            _ensure(acc, node)
            edge_weight = round(holding.weight * factor, 4)
            rationale = (
                f"{holding.symbol} carries {label} sensitivity ({int(factor * 100)}%)."
            )
            acc[node_id].rationale_template = (
                acc[node_id].rationale_template or rationale
            )
            acc[node_id].add(
                holding_id=holding.id,
                weight=edge_weight,
                confidence=holding.enrichment_confidence * 0.9,
            )
            graph.nodes.append(node)
            graph.edges.append(
                ExposureEdge(
                    holding_id=holding.id,
                    node_id=node_id,
                    weight=edge_weight,
                    confidence=round(holding.enrichment_confidence * factor, 3),
                    rationale=rationale,
                )
            )

    def _project_macro(
        self,
        holding: Holding,
        acc: dict[str, _NodeAccumulator],
        graph: ExposureGraph,
    ) -> None:
        themes = holding.metadata.get("macro_themes", []) or []
        for theme in themes:
            if not theme:
                continue
            node_id = f"macro_theme:{theme}"
            node = ExposureNode(
                id=node_id,
                domain="macro_theme",
                label=str(theme).replace("-", " ").title(),
            )
            _ensure(acc, node)
            rationale = (
                f"{holding.symbol} is a transmission name for the "
                f"\"{node.label}\" theme."
            )
            acc[node_id].rationale_template = (
                acc[node_id].rationale_template or rationale
            )
            acc[node_id].add(
                holding_id=holding.id,
                weight=holding.weight,
                confidence=holding.enrichment_confidence * 0.8,
            )
            graph.nodes.append(node)
            graph.edges.append(
                ExposureEdge(
                    holding_id=holding.id,
                    node_id=node_id,
                    weight=round(holding.weight, 4),
                    confidence=round(holding.enrichment_confidence * 0.8, 3),
                    rationale=rationale,
                )
            )

    def _project_chokepoints(
        self,
        holding: Holding,
        acc: dict[str, _NodeAccumulator],
        graph: ExposureGraph,
    ) -> None:
        chokepoints = holding.metadata.get("chokepoints", []) or []
        for chokepoint in chokepoints:
            if not chokepoint:
                continue
            node_id = f"chokepoint:{chokepoint}"
            node = ExposureNode(
                id=node_id,
                domain="chokepoint",
                label=str(chokepoint).replace("-", " ").title(),
            )
            _ensure(acc, node)
            rationale = (
                f"{holding.symbol} freight / supply route runs through {node.label}."
            )
            acc[node_id].rationale_template = (
                acc[node_id].rationale_template or rationale
            )
            acc[node_id].add(
                holding_id=holding.id,
                weight=holding.weight * 0.7,
                confidence=holding.enrichment_confidence * 0.85,
            )
            graph.nodes.append(node)
            graph.edges.append(
                ExposureEdge(
                    holding_id=holding.id,
                    node_id=node_id,
                    weight=round(holding.weight * 0.7, 4),
                    confidence=round(holding.enrichment_confidence * 0.85, 3),
                    rationale=rationale,
                )
            )

    def _project_asset_class(
        self,
        holding: Holding,
        acc: dict[str, _NodeAccumulator],
        graph: ExposureGraph,
    ) -> None:
        node_id = f"asset_class:{holding.asset_type}"
        node = ExposureNode(
            id=node_id,
            domain="asset_class",
            label=holding.asset_type.upper(),
        )
        _ensure(acc, node)
        acc[node_id].add(
            holding_id=holding.id,
            weight=holding.weight,
            confidence=holding.enrichment_confidence,
        )
        graph.nodes.append(node)
        graph.edges.append(
            ExposureEdge(
                holding_id=holding.id,
                node_id=node_id,
                weight=round(holding.weight, 4),
                confidence=round(holding.enrichment_confidence, 3),
                rationale=f"{holding.symbol} is held as a {holding.asset_type}.",
            )
        )


# ---- helpers ---------------------------------------------------------------


def _ensure(
    acc: dict[str, _NodeAccumulator], node: ExposureNode
) -> _NodeAccumulator:
    existing = acc.get(node.id)
    if existing is None:
        existing = _NodeAccumulator(node=node)
        acc[node.id] = existing
    return existing


def _normalize_weights(holdings: list[Holding]) -> list[Holding]:
    """Ensure each holding has a sensible ``weight``.

    Priority:
    1. Use ``market_value`` when every holding has one.
    2. Else use ``quantity * average_cost`` when both present.
    3. Else fall back to even-split.
    """

    if not holdings:
        return []
    have_market_value = all(h.market_value is not None for h in holdings)
    if have_market_value:
        total = sum(h.market_value or 0.0 for h in holdings)
        if total > 0:
            for h in holdings:
                h.weight = round((h.market_value or 0.0) / total, 4)
            return holdings
    cost_basis = [
        (h.quantity or 0.0) * (h.average_cost or 0.0) for h in holdings
    ]
    cost_total = sum(cost_basis)
    if cost_total > 0 and any(value > 0 for value in cost_basis):
        for h, value in zip(holdings, cost_basis):
            h.weight = round(value / cost_total, 4) if cost_total else 0.0
        return holdings
    even = round(1.0 / len(holdings), 4)
    for h in holdings:
        h.weight = even
    return holdings


def _accumulate(
    record: PortfolioRecord, graph: ExposureGraph
) -> dict[str, _NodeAccumulator]:
    """Re-fold the edge list into per-node accumulators for top-N selection."""

    nodes_by_id = {node.id: node for node in graph.nodes}
    acc: dict[str, _NodeAccumulator] = {}
    for edge in graph.edges:
        node = nodes_by_id.get(edge.node_id)
        if node is None:
            continue
        bucket = acc.setdefault(edge.node_id, _NodeAccumulator(node=node))
        bucket.add(
            holding_id=edge.holding_id,
            weight=edge.weight,
            confidence=edge.confidence,
        )
        if bucket.rationale_template is None:
            bucket.rationale_template = edge.rationale
    return acc


def _top_buckets(
    acc: dict[str, _NodeAccumulator], domain: str, top_n: int
) -> list[ExposureBucket]:
    candidates = [a for a in acc.values() if a.node.domain == domain]
    candidates.sort(key=lambda a: a.weight, reverse=True)
    return [a.to_bucket() for a in candidates[:top_n]]


__all__ = ["ExposureService"]
