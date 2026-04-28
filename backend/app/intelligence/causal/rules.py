"""Deterministic causal rule registry — Phase 18D.

Each :class:`CausalRule` is a tiny declarative recipe:

* ``id`` — stable identifier used in chain ids / telemetry / tests.
* ``applies_to_entity`` — entity kinds this rule can fire for. Keeps
  oil rules from firing against an FX query and vice versa.
* ``trigger`` — a pure predicate over a single :class:`SignalEvent`.
  Keep these recipes small and readable; no complex NLP, no LLM.
* ``mechanism``, ``direction``, ``domain`` — the typed claim the rule
  encodes.
* ``rationale`` — the sentence the chain inherits when this rule fires.
  Keep recruiter-legible.
* ``caveats`` — the honest limits ("priced behavior, not a forecast",
  "thin coverage", etc).
* ``prior`` — confidence prior in [0,1]. The chain builder combines
  this with evidence severity, recency, and entity-resolution quality
  to derive the final chain confidence.

The registry is intentionally small; new rules should be added when a
genuine analyst question is being answered, not speculatively.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable, Iterable

from app.intelligence.causal.model import (
    CausalMechanism,
    ImpactDirection,
    ImpactDomain,
    ImpactStrength,
)
from app.intelligence.retrieval.entity_resolver import (
    EntityKind,
    QueryEntity,
)
from app.intelligence.schemas import SignalEvent


# ---------------------------------------------------------------------------
# Rule type
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class CausalRule:
    """A deterministic, evidence-keyed causal recipe."""

    id: str
    title: str
    applies_to_entity: tuple[EntityKind, ...]
    trigger: Callable[[SignalEvent, QueryEntity], bool]
    mechanism: CausalMechanism
    direction: ImpactDirection
    domain: ImpactDomain
    rationale: str
    base_strength: ImpactStrength = "moderate"
    prior: float = 0.6
    caveats: tuple[str, ...] = field(default_factory=tuple)
    affected_symbols: tuple[str, ...] = field(default_factory=tuple)
    affected_domains: tuple[ImpactDomain, ...] = field(default_factory=tuple)
    summary_template: str | None = None


# ---------------------------------------------------------------------------
# Predicates — share textual / tag matching helpers across rules
# ---------------------------------------------------------------------------


_SHIPPING_KEYWORDS = (
    "red sea",
    "suez",
    "panama canal",
    "strait of hormuz",
    "strait of malacca",
    "bab el-mandeb",
    "shipping",
    "tanker",
    "vessel",
    "cargo",
    "port closure",
    "freight",
)

_DISRUPTION_KEYWORDS = (
    "disrupt",
    "delay",
    "blockage",
    "blocked",
    "closure",
    "attack",
    "strike",
    "halt",
    "suspend",
)

_SEVERE_WEATHER_KEYWORDS = (
    "hurricane",
    "typhoon",
    "cyclone",
    "tropical storm",
    "blizzard",
    "tornado",
    "flood",
    "earthquake",
    "wildfire",
)

_OIL_PRODUCTION_KEYWORDS = (
    "opec",
    "production cut",
    "production hike",
    "rig count",
    "inventory build",
    "inventory draw",
    "shale",
    "refinery",
)


def _haystack(event: SignalEvent) -> str:
    parts = [event.title or "", event.summary or "", event.description or ""]
    return " ".join(p.lower() for p in parts if p)


def _has_any(needles: Iterable[str], haystack: str) -> bool:
    return any(needle in haystack for needle in needles)


def _has_tag(event: SignalEvent, *needles: str) -> bool:
    tags = {tag.lower() for tag in event.tags or ()}
    return any(needle in tags for needle in needles)


# ---------------------------------------------------------------------------
# Triggers — one per rule. Pure functions of (event, entity).
# ---------------------------------------------------------------------------


def _trigger_shipping_disruption(event: SignalEvent, entity: QueryEntity) -> bool:
    text = _haystack(event)
    if not _has_any(_SHIPPING_KEYWORDS, text):
        return False
    if event.type in ("conflict", "news") and _has_any(_DISRUPTION_KEYWORDS, text):
        return True
    return _has_tag(event, "shipping", "logistics", "supply_chain")


def _trigger_oil_supply(event: SignalEvent, entity: QueryEntity) -> bool:
    if event.type not in ("commodities", "markets", "news"):
        return False
    text = _haystack(event)
    return _has_any(_OIL_PRODUCTION_KEYWORDS, text) or (
        "oil" in text and _has_any(("supply", "tighten", "shortage"), text)
    )


def _trigger_severe_weather_logistics(
    event: SignalEvent, entity: QueryEntity
) -> bool:
    if event.type != "weather":
        return False
    text = _haystack(event)
    return _has_any(_SEVERE_WEATHER_KEYWORDS, text)


def _trigger_currency_weakness(event: SignalEvent, entity: QueryEntity) -> bool:
    if event.type not in ("currency", "markets", "news"):
        return False
    text = _haystack(event)
    weakness_words = ("weaken", "slump", "fall", "drop", "decline", "depreciate")
    strength_words = ("strengthen", "rally", "surge", "appreciate", "rise")
    has_currency_topic = (
        event.type == "currency"
        or _has_any(("usd", "eur", "jpy", "gbp", "yen", "yuan"), text)
    )
    return has_currency_topic and (
        _has_any(weakness_words, text) or _has_any(strength_words, text)
    )


def _trigger_currency_strength(event: SignalEvent, entity: QueryEntity) -> bool:
    if event.type not in ("currency", "markets", "news"):
        return False
    text = _haystack(event)
    return _has_any(("strengthen", "rally", "surge", "appreciate"), text)


def _trigger_commodity_input_cost(
    event: SignalEvent, entity: QueryEntity
) -> bool:
    if event.type not in ("commodities", "markets"):
        return False
    text = _haystack(event)
    up_words = ("rally", "surge", "spike", "jump", "rise", "climb")
    return _has_any(up_words, text)


def _trigger_country_conflict(event: SignalEvent, entity: QueryEntity) -> bool:
    if event.type != "conflict":
        return False
    return True


def _trigger_equity_volatility(event: SignalEvent, entity: QueryEntity) -> bool:
    if event.type not in ("stocks", "markets"):
        return False
    text = _haystack(event)
    vol_words = ("plunge", "slide", "tumble", "selloff", "drop", "miss", "downgrade")
    pos_words = ("rally", "beat", "upgrade", "surge", "jump")
    return _has_any(vol_words, text) or _has_any(pos_words, text)


# ---------------------------------------------------------------------------
# Registry — keep additive and recruiter-legible.
# ---------------------------------------------------------------------------


CAUSAL_RULES: tuple[CausalRule, ...] = (
    CausalRule(
        id="shipping_disruption_to_oil",
        title="Shipping disruption tightens crude supply",
        applies_to_entity=("commodity",),
        trigger=_trigger_shipping_disruption,
        mechanism="tightens_supply",
        direction="up",
        domain="oil",
        rationale=(
            "Shipping-route disruption raises the crude risk premium "
            "as supply expectations tighten."
        ),
        base_strength="moderate",
        prior=0.7,
        affected_symbols=("CL", "BZ"),
        affected_domains=("oil", "shipping", "supply_chain"),
        caveats=(
            "Routing impact is observed in news, not cleared volumes — "
            "inventory data may lag.",
        ),
        summary_template=(
            "{entity} pressure is elevated because shipping evidence around "
            "{focus} suggests route delays, which may tighten supply expectations."
        ),
    ),
    CausalRule(
        id="shipping_disruption_to_logistics",
        title="Shipping disruption delays logistics flow",
        applies_to_entity=("country", "place"),
        trigger=_trigger_shipping_disruption,
        mechanism="delays",
        direction="down",
        domain="logistics",
        rationale=(
            "Route disruption raises the probability of delivery delays "
            "for downstream importers and exporters."
        ),
        base_strength="moderate",
        prior=0.6,
        affected_domains=("logistics", "supply_chain"),
        caveats=(
            "Delay magnitude depends on route alternatives and cleared "
            "vessel diversions, which lag news reports.",
        ),
    ),
    CausalRule(
        id="oil_supply_to_commodity",
        title="Oil supply news moves the commodity",
        applies_to_entity=("commodity",),
        trigger=_trigger_oil_supply,
        mechanism="tightens_supply",
        direction="up",
        domain="oil",
        rationale=(
            "Production / inventory evidence moves the supply curve and "
            "feeds directly into crude pricing."
        ),
        prior=0.65,
        base_strength="moderate",
        affected_symbols=("CL", "BZ"),
        affected_domains=("oil", "commodities"),
    ),
    CausalRule(
        id="severe_weather_to_logistics",
        title="Severe weather disrupts logistics",
        applies_to_entity=("country", "place", "commodity"),
        trigger=_trigger_severe_weather_logistics,
        mechanism="disrupts",
        direction="mixed",
        domain="logistics",
        rationale=(
            "Severe weather raises the probability of operational "
            "disruption for flights, ports, and ground logistics in the "
            "affected region."
        ),
        prior=0.6,
        base_strength="moderate",
        affected_domains=("logistics", "weather", "supply_chain"),
        caveats=(
            "Direction of price impact depends on the affected sector — "
            "treat as a disruption likelihood, not a directional call.",
        ),
    ),
    CausalRule(
        id="currency_weakness_to_imports",
        title="Currency weakness raises import cost",
        applies_to_entity=("fx_pair", "country"),
        trigger=_trigger_currency_weakness,
        mechanism="raises_input_cost",
        direction="up",
        domain="macro",
        rationale=(
            "A weaker domestic currency raises the cost of imported "
            "inputs, pressuring importer margins and inflation."
        ),
        prior=0.55,
        base_strength="moderate",
        affected_domains=("fx", "macro", "equities"),
        caveats=(
            "Pass-through to corporate margins lags FX moves and "
            "depends on hedging programs.",
        ),
    ),
    CausalRule(
        id="currency_strength_to_exports",
        title="Currency strength pressures exports",
        applies_to_entity=("fx_pair", "country"),
        trigger=_trigger_currency_strength,
        mechanism="affects_exports",
        direction="down",
        domain="macro",
        rationale=(
            "A stronger domestic currency reduces export competitiveness "
            "and can pressure exporter equity earnings."
        ),
        prior=0.5,
        base_strength="weak",
        affected_domains=("fx", "macro", "equities"),
    ),
    CausalRule(
        id="commodity_to_input_cost",
        title="Commodity rally raises sector input cost",
        applies_to_entity=("commodity",),
        trigger=_trigger_commodity_input_cost,
        mechanism="raises_input_cost",
        direction="up",
        domain="sector",
        rationale=(
            "Commodity strength feeds through as input-cost pressure for "
            "downstream consumer industries."
        ),
        prior=0.5,
        base_strength="weak",
        affected_domains=("commodities", "sector", "equities"),
        caveats=(
            "Sector transmission depends on hedging coverage and "
            "pricing power.",
        ),
    ),
    CausalRule(
        id="country_conflict_to_risk_premium",
        title="Conflict raises country-risk premium",
        applies_to_entity=("country", "place"),
        trigger=_trigger_country_conflict,
        mechanism="increases_risk_premium",
        direction="up",
        domain="country_risk",
        rationale=(
            "Active conflict raises the geopolitical risk premium, which "
            "can pressure currency, sovereign spreads, and equities."
        ),
        prior=0.7,
        base_strength="strong",
        affected_domains=("country_risk", "fx", "equities", "commodities"),
        caveats=(
            "Magnitude of premium depends on duration, escalation, and "
            "global energy / supply linkages.",
        ),
    ),
    CausalRule(
        id="equity_news_to_volatility",
        title="Equity news increases name-level volatility",
        applies_to_entity=("ticker",),
        trigger=_trigger_equity_volatility,
        mechanism="increases_volatility",
        direction="mixed",
        domain="equities",
        rationale=(
            "Direct news flow on a single name is the primary driver of "
            "near-term realized volatility for that symbol."
        ),
        prior=0.6,
        base_strength="moderate",
        affected_domains=("equities",),
    ),
)


def rules_for_entity(entity: QueryEntity) -> tuple[CausalRule, ...]:
    """Subset of :data:`CAUSAL_RULES` whose ``applies_to_entity`` matches."""

    if entity is None or not entity.is_resolved:
        return ()
    return tuple(rule for rule in CAUSAL_RULES if entity.kind in rule.applies_to_entity)


__all__ = ["CAUSAL_RULES", "CausalRule", "rules_for_entity"]
