"""Agent + dependency reasoning response shapes.

These shapes are the wire contract between the agent/dependency services and
the analyst UI. Everything here is grounded — each string segment carries the
evidence IDs that support it, every dependency edge carries rationale +
confidence + evidence links. The UI is free to highlight citations or refuse
to render a claim whose `evidence_ids` list is empty.
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


AgentIntent = Literal[
    "why_elevated",
    "what_changed",
    "driving_factor",
    "downstream_impact",
    "status_check",
    "general_retrieval",
]

DependencyDomain = Literal[
    "weather",
    "news",
    "flights",
    "conflict",
    "disease",
    "mood",
    "stocks",
    "commodities",
    "currency",
    "logistics",
    "tourism",
    "equities",
    "fx",
    "supply_chain",
    "oil",
    "place",
    "sector",
    "other",
]


ResolvedEntityKind = Literal[
    "country",
    "topic",
    "ticker",
    "fx_pair",
    # Phase 19C.6 — commodity now first-class so queries like "why is oil up"
    # surface a commodity-typed ResolvedEntity that the agent service can
    # use to label the interpreted query and the answer subject.
    "commodity",
    "region",
    "city",
    "port",
    "chokepoint",
    "place",
]


class ResolvedEntity(BaseModel):
    model_config = ConfigDict(frozen=True)

    kind: ResolvedEntityKind
    id: str
    name: str
    country_code: str | None = None


# ---- Phase 12.3 place scope --------------------------------------------------

PlaceScopeSource = Literal["place_resolver", "country_lookup"]


class MacroContext(BaseModel):
    """Country macro context — currency, sector tags, top commodities.

    Surfaced on the agent response only when the resolved place is strong
    enough to justify it (exact / alias / nearby_city / parent_country)."""

    model_config = ConfigDict(frozen=True)

    country_code: str
    currency_code: str
    logistics_hub: bool = False
    sector_tags: list[str] = Field(default_factory=list)
    top_export_commodity: str | None = None
    top_export_sensitivity: float | None = None
    top_import_commodity: str | None = None
    top_import_sensitivity: float | None = None
    trade_dependence_score: float | None = None
    shipping_exposure: float | None = None


class PlaceScope(BaseModel):
    """Resolved geographic scope for an investigation.

    Single, canonical contract shared between the agent service, the live
    query path, the dependency service, and the analyst UI. Designed to be
    extensible enough for Phase 13 portfolio/graph entities — every node in
    a future graph can serialize to this shape."""

    model_config = ConfigDict(frozen=True)

    query: str
    place_id: str | None = None
    name: str | None = None
    type: str | None = None
    country_code: str | None = None
    country_name: str | None = None
    parent_id: str | None = None
    parent_name: str | None = None
    latitude: float | None = None
    longitude: float | None = None
    bbox: tuple[float, float, float, float] | None = None
    aliases: list[str] = Field(default_factory=list)
    tags: list[str] = Field(default_factory=list)
    fallback_level: Literal[
        "exact",
        "alias_substring",
        "nearby_city",
        "parent_country",
        "parent_region",
        "none",
    ] = "none"
    is_fallback: bool = False
    confidence: float = 0.0
    macro_context: MacroContext | None = None
    source: PlaceScopeSource = "place_resolver"


class AgentSegment(BaseModel):
    """One sentence of the grounded answer, with its supporting evidence IDs."""

    model_config = ConfigDict(frozen=True)

    text: str
    evidence_ids: list[str] = Field(default_factory=list)


class AgentFollowUp(BaseModel):
    model_config = ConfigDict(frozen=True)

    label: str
    query: str


class AgentTimeContext(BaseModel):
    """Time framing the agent answer is bounded by (Phase 18A.1).

    ``coverage`` is the high-level mode the UI surfaces:

    * ``live``      — no temporal restriction
    * ``windowed``  — bounded ``[since, until]`` window with matches
    * ``delta``     — "what changed" intent
    * ``as_of``     — point-in-time snapshot
    * ``no_match``  — window was requested but no events landed in it
    """

    model_config = ConfigDict(frozen=True)

    kind: Literal["live", "since", "between", "as_of", "delta"]
    coverage: Literal["live", "windowed", "delta", "as_of", "no_match"]
    label: str
    answer_mode_label: str
    since: datetime | None = None
    until: datetime | None = None
    matched_event_count: int = 0
    is_historical: bool = False


class AgentCompareTarget(BaseModel):
    """One leg of a compare answer (Phase 18A.1)."""

    model_config = ConfigDict(frozen=True)

    raw: str
    # Phase 19C.6 — added "commodity" so time-window compare (e.g.
    # "oil yesterday vs today") can synthesize compare targets without a
    # validation error.
    kind: Literal["country", "place", "ticker", "fx_pair", "commodity", "unknown"]
    canonical_id: str | None = None
    label: str
    country_code: str | None = None
    confidence: float = Field(default=0.0, ge=0.0, le=1.0)
    resolution: Literal["exact", "alias", "fallback", "none"]
    event_ids: list[str] = Field(default_factory=list)
    counts_by_category: dict[str, int] = Field(default_factory=dict)
    severity_distribution: dict[str, int] = Field(default_factory=dict)
    freshness_minutes: float | None = None
    watch_score: float | None = None
    watch_label: str | None = None


class AgentCompareSummary(BaseModel):
    """Compare framing surfaced on the agent response (Phase 18A.1)."""

    model_config = ConfigDict(frozen=True)

    requested: bool
    collapsed: bool = False
    mode: Literal["vs", "compare", "between", "compared_to"] | None = None
    raw_phrase: str | None = None
    targets: list[AgentCompareTarget] = Field(default_factory=list)
    headline: str | None = None


class AgentResponse(BaseModel):
    """Grounded agent answer envelope."""

    model_config = ConfigDict(frozen=False)

    query: str
    interpreted_query: str
    intent: AgentIntent
    reasoning_mode: Literal["rule_based", "retrieval_plus_llm"] = "rule_based"

    resolved_entities: list[ResolvedEntity] = Field(default_factory=list)
    answer: list[AgentSegment] = Field(default_factory=list)
    evidence: list["EvidenceRef"] = Field(default_factory=list)

    follow_ups: list[AgentFollowUp] = Field(default_factory=list)
    related_countries: list[str] = Field(default_factory=list)
    related_events: list[str] = Field(default_factory=list)

    confidence: float = Field(default=0.0, ge=0.0, le=1.0)
    generated_at: datetime

    # ---- Phase 12.3 place intelligence surface --------------------------
    resolved_place: PlaceScope | None = None
    fallback_notice: str | None = None
    scope_used: Literal[
        "exact_place",
        "country",
        "region",
        "global",
    ] = "global"
    scope_confidence: float = Field(default=0.0, ge=0.0, le=1.0)
    place_dependencies: list["DependencyPath"] = Field(default_factory=list)
    macro_context: MacroContext | None = None

    # ---- Phase 18A.1 retrieval orchestrator surface ---------------------
    time_context: AgentTimeContext | None = None
    compare_summary: AgentCompareSummary | None = None
    workers_invoked: list[str] = Field(default_factory=list)
    caveats: list[str] = Field(default_factory=list)

    # ---- Phase 18D causal chain intelligence surface ---------------------
    # Optional + backward compatible. Older clients may ignore the field;
    # newer clients render the CausalChainCard when present and non-empty.
    causal_chains: "CausalChainSet | None" = None

    # ---- Phase 19B portfolio-impact linkage -----------------------------
    # Optional + backward compatible. Hides itself when there is no active
    # portfolio or no chain touches a holding.
    portfolio_impact: "PortfolioImpact | None" = None


class EvidenceRef(BaseModel):
    """Lightweight reference to a canonical SignalEvent.

    We keep this flat (vs. embedding the whole SignalEvent) so the agent
    response stays compact; the UI can cross-reference by ID against the
    events/latest endpoints when it needs the full record.
    """

    model_config = ConfigDict(frozen=True)

    id: str
    title: str
    type: str
    severity: str
    severity_score: float
    confidence: float
    source_timestamp: datetime | None = None
    country_code: str | None = None
    country_name: str | None = None
    publisher: str | None = None
    url: str | None = None


# ---- dependency reasoning ----------------------------------------------------


class DependencyNode(BaseModel):
    model_config = ConfigDict(frozen=True)

    id: str  # locally unique within a path ("n0", "n1", …)
    domain: DependencyDomain
    label: str
    country_code: str | None = None
    event_id: str | None = None


class DependencyEdge(BaseModel):
    model_config = ConfigDict(frozen=True)

    from_id: str
    to_id: str
    relation: str
    rationale: str
    confidence: float = Field(ge=0.0, le=1.0)
    evidence_ids: list[str] = Field(default_factory=list)


class DependencyPath(BaseModel):
    model_config = ConfigDict(frozen=False)

    id: str
    title: str
    nodes: list[DependencyNode]
    edges: list[DependencyEdge]
    focal_event_id: str | None = None
    focal_country_code: str | None = None
    overall_confidence: float = Field(ge=0.0, le=1.0)
    rationale: str


class DependencyResponse(BaseModel):
    model_config = ConfigDict(frozen=False)

    generated_at: datetime
    focal_country_code: str | None = None
    focal_event_id: str | None = None
    paths: list[DependencyPath] = Field(default_factory=list)


# ---- compare -----------------------------------------------------------------


class CompareTarget(BaseModel):
    model_config = ConfigDict(frozen=False)

    kind: Literal["country", "event"]
    id: str
    label: str
    country_code: str | None = None
    summary: dict | None = None  # CountrySignalSummary dict when kind=country
    event: dict | None = None    # SignalEvent dict when kind=event
    recent_events: list[dict] = Field(default_factory=list)
    counts_by_category: dict[str, int] = Field(default_factory=dict)
    severity_distribution: dict[str, int] = Field(default_factory=dict)
    freshness_minutes: float | None = None


class CompareDiff(BaseModel):
    model_config = ConfigDict(frozen=True)

    dimension: str
    left_value: str | float | int | None
    right_value: str | float | int | None
    delta_note: str | None = None


class CompareResponse(BaseModel):
    model_config = ConfigDict(frozen=False)

    generated_at: datetime
    targets: list[CompareTarget]
    diffs: list[CompareDiff] = Field(default_factory=list)
    headline: str


# Phase 18D — bind the optional causal chain set onto AgentResponse. The
# import lives at the bottom because app.intelligence.causal.model has no
# app.intelligence dependencies of its own (datetime + pydantic only), so
# this resolves cleanly without a circular import.
from app.intelligence.causal.model import CausalChainSet  # noqa: E402
from app.intelligence.causal.portfolio_impact import (  # noqa: E402
    PortfolioImpact,
)

AgentResponse.model_rebuild()
