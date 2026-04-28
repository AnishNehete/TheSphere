"""Portfolio + exposure-graph schemas.

Phase 13A — these are the canonical wire shapes the rest of the system
talks in. Every field that downstream phases (signal engines, replay,
portfolio agents) will need has a place to land here, even if it's empty
in this phase. Keep them strict and explainable: confidence + rationale
travel with every exposure linkage so the analyst UI never has to invent
a number.
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from app.intelligence.portfolio.market_data.base import PortfolioValuationSummary


# -----------------------------------------------------------------------------
# Holding + portfolio core
# -----------------------------------------------------------------------------


AssetType = Literal[
    "equity",
    "etf",
    "adr",
    "bond",
    "fund",
    "commodity",
    "fx",
    "crypto",
    "cash",
    "other",
]


class HoldingInput(BaseModel):
    """User-supplied holding row (manual entry / CSV)."""

    model_config = ConfigDict(frozen=True)

    symbol: str
    quantity: float = Field(default=0.0, ge=0.0)
    average_cost: float | None = Field(default=None, ge=0.0)
    currency: str | None = None
    asset_type: AssetType | None = None
    exchange: str | None = None
    sector: str | None = None
    country_code: str | None = None
    notes: str | None = None


class Holding(BaseModel):
    """Persisted, enriched holding."""

    model_config = ConfigDict(frozen=False)

    id: str
    portfolio_id: str
    symbol: str
    name: str | None = None
    quantity: float = 0.0
    average_cost: float | None = None
    market_value: float | None = None
    currency: str = "USD"
    asset_type: AssetType = "equity"
    exchange: str | None = None
    region: str | None = None
    sector: str | None = None
    country_code: str | None = None
    weight: float = Field(default=0.0, ge=0.0, le=1.0)
    notes: str | None = None
    enrichment_confidence: float = Field(default=0.0, ge=0.0, le=1.0)
    metadata: dict = Field(default_factory=dict)
    # ---- Phase 13B additions (all backwards-compatible, default None) ----
    last_price: float | None = None
    price_as_of: datetime | None = None
    cost_basis: float | None = None
    unrealized_pnl: float | None = None
    unrealized_pnl_pct: float | None = None
    price_is_stale: bool = False
    price_missing: bool = False


class PortfolioCreateRequest(BaseModel):
    model_config = ConfigDict(frozen=True)

    name: str
    description: str | None = None
    base_currency: str = "USD"
    notes: str | None = None
    tags: list[str] = Field(default_factory=list)
    benchmark_symbol: str | None = None
    holdings: list[HoldingInput] = Field(default_factory=list)


class PortfolioUpdateRequest(BaseModel):
    model_config = ConfigDict(frozen=True)

    name: str | None = None
    description: str | None = None
    base_currency: str | None = None
    notes: str | None = None
    tags: list[str] | None = None
    benchmark_symbol: str | None = None


class PortfolioRecord(BaseModel):
    """Persisted portfolio shell (holdings hang off this via repository)."""

    model_config = ConfigDict(frozen=False)

    id: str
    name: str
    description: str | None = None
    base_currency: str = "USD"
    benchmark_symbol: str | None = None
    notes: str | None = None
    tags: list[str] = Field(default_factory=list)
    created_at: datetime
    updated_at: datetime
    holdings: list[Holding] = Field(default_factory=list)


# -----------------------------------------------------------------------------
# Watchlist
# -----------------------------------------------------------------------------


class WatchlistInput(BaseModel):
    model_config = ConfigDict(frozen=True)

    name: str
    symbols: list[str] = Field(default_factory=list)
    countries: list[str] = Field(default_factory=list)
    topics: list[str] = Field(default_factory=list)
    notes: str | None = None


class Watchlist(BaseModel):
    model_config = ConfigDict(frozen=False)

    id: str
    name: str
    symbols: list[str] = Field(default_factory=list)
    countries: list[str] = Field(default_factory=list)
    topics: list[str] = Field(default_factory=list)
    notes: str | None = None
    created_at: datetime
    updated_at: datetime


# -----------------------------------------------------------------------------
# Exposure graph
# -----------------------------------------------------------------------------


ExposureDomain = Literal[
    "country",
    "sector",
    "currency",
    "commodity",
    "macro_theme",
    "place",
    "chokepoint",
    "asset_class",
]


class ExposureNode(BaseModel):
    """A node in a portfolio's exposure graph.

    Holdings connect to ExposureNodes via :class:`ExposureEdge`. The same
    node can be referenced by multiple edges (e.g. AAPL + MSFT both pull on
    the ``country:USA`` node).
    """

    model_config = ConfigDict(frozen=True)

    id: str  # e.g. "country:USA", "sector:semiconductors", "currency:JPY"
    domain: ExposureDomain
    label: str
    country_code: str | None = None


class ExposureEdge(BaseModel):
    """Directed edge holding -> exposure with rationale + confidence."""

    model_config = ConfigDict(frozen=True)

    holding_id: str
    node_id: str
    weight: float = Field(ge=0.0, le=1.0)
    confidence: float = Field(ge=0.0, le=1.0)
    rationale: str


class ExposureBucket(BaseModel):
    """Aggregated exposure for one node across the portfolio."""

    model_config = ConfigDict(frozen=False)

    node: ExposureNode
    weight: float = Field(ge=0.0, le=1.0)
    confidence: float = Field(ge=0.0, le=1.0)
    contributing_holdings: list[str] = Field(default_factory=list)
    rationale: str | None = None


class ExposureGraph(BaseModel):
    """Full exposure graph for a portfolio."""

    model_config = ConfigDict(frozen=False)

    portfolio_id: str
    nodes: list[ExposureNode] = Field(default_factory=list)
    edges: list[ExposureEdge] = Field(default_factory=list)


class PortfolioExposureSummary(BaseModel):
    """Top-N rolled-up exposures the brief panel renders directly."""

    model_config = ConfigDict(frozen=False)

    countries: list[ExposureBucket] = Field(default_factory=list)
    sectors: list[ExposureBucket] = Field(default_factory=list)
    currencies: list[ExposureBucket] = Field(default_factory=list)
    commodities: list[ExposureBucket] = Field(default_factory=list)
    macro_themes: list[ExposureBucket] = Field(default_factory=list)
    chokepoints: list[ExposureBucket] = Field(default_factory=list)


# -----------------------------------------------------------------------------
# Brief
# -----------------------------------------------------------------------------


class PortfolioDependencyPath(BaseModel):
    """A dependency reasoning chain attached to a portfolio brief.

    Distinct from the place-driven DependencyPath in
    :mod:`app.intelligence.schemas.agent` — this one carries the holding /
    exposure node pairing so the UI can highlight which positions own the
    exposure.
    """

    model_config = ConfigDict(frozen=False)

    id: str
    title: str
    rationale: str
    overall_confidence: float = Field(ge=0.0, le=1.0)
    contributing_holdings: list[str] = Field(default_factory=list)
    exposure_node_id: str | None = None
    related_event_ids: list[str] = Field(default_factory=list)


class PortfolioEntity(BaseModel):
    """A graph-ready portfolio reference for cross-module linking.

    Phase 13B+ will use this to anchor portfolio nodes inside the existing
    place / exposure graph. Today it is a thin envelope that names the
    portfolio + its top exposures so the agent / globe / chart layers can
    cite a single canonical handle."""

    model_config = ConfigDict(frozen=True)

    id: str
    name: str
    primary_country_codes: list[str] = Field(default_factory=list)
    primary_sectors: list[str] = Field(default_factory=list)
    primary_currencies: list[str] = Field(default_factory=list)


class PortfolioRiskItem(BaseModel):
    """One item in the brief's "top risks" list."""

    model_config = ConfigDict(frozen=True)

    title: str
    rationale: str
    severity: Literal["info", "watch", "elevated", "critical"] = "watch"
    confidence: float = Field(ge=0.0, le=1.0)
    exposure_node_id: str | None = None
    related_event_ids: list[str] = Field(default_factory=list)


class PortfolioLinkedEvent(BaseModel):
    """A world-event reference linked to specific portfolio exposures."""

    model_config = ConfigDict(frozen=True)

    event_id: str
    title: str
    type: str
    severity: str
    severity_score: float
    country_code: str | None = None
    country_name: str | None = None
    source_timestamp: datetime | None = None
    publisher: str | None = None
    url: str | None = None
    matched_exposure_node_ids: list[str] = Field(default_factory=list)


class PortfolioBrief(BaseModel):
    """Grounded brief surfaced by ``GET /portfolios/{id}/brief``."""

    model_config = ConfigDict(frozen=False)

    portfolio_id: str
    name: str
    base_currency: str
    generated_at: datetime
    holdings_count: int
    holdings: list[Holding] = Field(default_factory=list)
    exposure_summary: PortfolioExposureSummary
    exposure_graph: ExposureGraph
    dependency_paths: list[PortfolioDependencyPath] = Field(default_factory=list)
    top_risks: list[PortfolioRiskItem] = Field(default_factory=list)
    linked_events: list[PortfolioLinkedEvent] = Field(default_factory=list)
    entity: PortfolioEntity
    confidence: float = Field(default=0.0, ge=0.0, le=1.0)
    notes: list[str] = Field(default_factory=list)
    # ---- Phase 13B addition ----
    valuation_summary: PortfolioValuationSummary | None = None


__all__ = [
    "AssetType",
    "ExposureBucket",
    "ExposureDomain",
    "ExposureEdge",
    "ExposureGraph",
    "ExposureNode",
    "Holding",
    "HoldingInput",
    "PortfolioBrief",
    "PortfolioCreateRequest",
    "PortfolioDependencyPath",
    "PortfolioEntity",
    "PortfolioExposureSummary",
    "PortfolioLinkedEvent",
    "PortfolioRecord",
    "PortfolioRiskItem",
    "PortfolioUpdateRequest",
    "Watchlist",
    "WatchlistInput",
]
