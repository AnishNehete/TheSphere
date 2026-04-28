"""Typed causal-chain model — Phase 18D.

A :class:`CausalChain` is a tiny, evidence-anchored DAG that walks from
a triggering signal through one or two transmission mechanisms to a
downstream impact node. Chains are immutable Pydantic models so the
builder must produce them via constructors (no in-place mutation), the
agent service can serialize them straight to the wire, and tests can
assert on stable shapes.

Design rules:

* Every chain references at least one ``source_evidence_id``. Chains
  with no evidence cannot be constructed (the builder asserts this).
* ``unknown`` is the preferred direction when evidence does not justify
  a sign. Fake certainty is worse than honest ambiguity.
* The builder emits chains in deterministic order — callers can rely
  on ``chain_id`` collisions never occurring within a single set.
* The ``CausalChainSet`` envelope carries provider/health metadata so
  the UI can distinguish "no evidence" from "engine offline".
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


# ---------------------------------------------------------------------------
# Atomic unions
# ---------------------------------------------------------------------------


CausalNodeKind = Literal[
    "event",
    "country",
    "region",
    "commodity",
    "currency",
    "equity",
    "sector",
    "logistics_route",
    "weather_system",
    "conflict",
    "health",
    "macro_factor",
    "portfolio",
]


CausalMechanism = Literal[
    "disrupts",
    "delays",
    "tightens_supply",
    "weakens_demand",
    "increases_risk_premium",
    "pressures_currency",
    "raises_input_cost",
    "affects_exports",
    "affects_imports",
    "increases_volatility",
    "lowers_confidence",
    "improves_sentiment",
    "unknown",
]


ImpactDirection = Literal["up", "down", "mixed", "stable", "unknown"]
ImpactStrength = Literal["weak", "moderate", "strong"]


ImpactDomain = Literal[
    "oil",
    "shipping",
    "weather",
    "fx",
    "commodities",
    "equities",
    "country_risk",
    "sector",
    "portfolio",
    "logistics",
    "supply_chain",
    "macro",
    "unknown",
]


# ---------------------------------------------------------------------------
# Nodes & edges
# ---------------------------------------------------------------------------


class CausalNode(BaseModel):
    """A single point on a causal chain.

    ``id`` is unique within the parent chain only (``"n0"``, ``"n1"`` …).
    ``label`` is short and analyst-readable; ``ref_id`` carries the
    canonical id of the underlying entity (event id, ticker, country
    code) when one exists, so the frontend can wire click-throughs.
    """

    model_config = ConfigDict(frozen=True)

    id: str
    kind: CausalNodeKind
    label: str
    ref_id: str | None = None
    country_code: str | None = None
    domain: ImpactDomain = "unknown"


class CausalEdge(BaseModel):
    """A typed transition between two nodes.

    ``rationale`` is a human-readable sentence explaining *why* the
    edge exists (taken from the rule that produced it). ``confidence``
    is the edge-local prior — chain-level confidence is a weighted
    aggregate computed by the builder.
    """

    model_config = ConfigDict(frozen=True)

    from_id: str
    to_id: str
    mechanism: CausalMechanism
    rationale: str
    confidence: float = Field(ge=0.0, le=1.0)
    evidence_ids: list[str] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# Chains
# ---------------------------------------------------------------------------


class CausalChain(BaseModel):
    """One evidence-backed causal narrative."""

    model_config = ConfigDict(frozen=False)

    chain_id: str
    title: str
    summary: str
    nodes: list[CausalNode]
    edges: list[CausalEdge]
    source_evidence_ids: list[str] = Field(default_factory=list)

    affected_entities: list[str] = Field(default_factory=list)
    affected_symbols: list[str] = Field(default_factory=list)
    affected_domains: list[ImpactDomain] = Field(default_factory=list)

    direction: ImpactDirection = "unknown"
    strength: ImpactStrength = "weak"
    confidence: float = Field(default=0.0, ge=0.0, le=1.0)
    score: float = Field(default=0.0, ge=0.0)

    rule_id: str
    rule_prior: float = Field(default=0.0, ge=0.0, le=1.0)
    caveats: list[str] = Field(default_factory=list)

    def has_evidence(self) -> bool:
        return bool(self.source_evidence_ids)


class CausalDriver(BaseModel):
    """Compact driver projection for ranked top-N display."""

    model_config = ConfigDict(frozen=True)

    chain_id: str
    title: str
    mechanism: CausalMechanism
    domain: ImpactDomain
    direction: ImpactDirection
    strength: ImpactStrength
    confidence: float = Field(ge=0.0, le=1.0)
    rationale: str
    evidence_ids: list[str] = Field(default_factory=list)
    caveats: list[str] = Field(default_factory=list)


class CausalChainSet(BaseModel):
    """Envelope returned to the agent layer & wire."""

    model_config = ConfigDict(frozen=False)

    generated_at: datetime
    query: str
    entity_id: str | None = None
    chains: list[CausalChain] = Field(default_factory=list)

    top_drivers: list[CausalDriver] = Field(default_factory=list)
    secondary_drivers: list[CausalDriver] = Field(default_factory=list)
    suppressed_drivers: list[CausalDriver] = Field(default_factory=list)

    caveats: list[str] = Field(default_factory=list)
    provider_health: Literal["live", "degraded", "empty"] = "live"

    def is_empty(self) -> bool:
        return not self.chains


__all__ = [
    "CausalChain",
    "CausalChainSet",
    "CausalDriver",
    "CausalEdge",
    "CausalMechanism",
    "CausalNode",
    "CausalNodeKind",
    "ImpactDirection",
    "ImpactDomain",
    "ImpactStrength",
]
