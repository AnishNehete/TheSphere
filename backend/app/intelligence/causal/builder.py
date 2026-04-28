"""Deterministic causal chain builder — Phase 18D.

Inputs:

* :class:`EvidenceBundle` — the source of truth.
* (optional) ``now`` — pinned for tests.

Output: a single :class:`CausalChainSet` ready for the agent layer.

Algorithm (kept intentionally small):

  1. Collect candidate events from the bundle (primary + compare + delta).
  2. For each candidate event × each rule applicable to the bundle entity:
     evaluate the rule's pure trigger.
  3. Build a :class:`CausalChain` from the matched (event, rule) pair.
  4. Deduplicate near-identical chains (same rule + same event).
  5. Score each chain (rule prior × severity × recency × source-quality
     × entity-resolution confidence).
  6. Sort chains by ``(score desc, chain_id asc)`` for determinism.
  7. Project the top-N into ranked drivers (top / secondary / suppressed).
  8. Attach honest caveats — sparse evidence, single source, low entity
     confidence, time-window mismatch.

Nothing here mutates the bundle; nothing fabricates an evidence id; no
LLM is consulted; no provider is called.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Iterable, Sequence

from app.intelligence.causal.model import (
    CausalChain,
    CausalChainSet,
    CausalDriver,
    CausalEdge,
    CausalNode,
    ImpactDirection,
    ImpactDomain,
    ImpactStrength,
)
from app.intelligence.causal.rules import (
    CAUSAL_RULES,
    CausalRule,
    rules_for_entity,
)
from app.intelligence.retrieval.entity_resolver import QueryEntity
from app.intelligence.retrieval.evidence_bundle import EvidenceBundle
from app.intelligence.schemas import SignalEvent


# Driver buckets — keep small; UI only renders top 1–3 by default.
_TOP_LIMIT = 3
_SECONDARY_LIMIT = 4

# Recency half-life in hours used by the scorer. Tuned so a 6h-old
# event scores ~0.7 vs a fresh one — matches the 18B reranker default
# but stays in this module so the chain builder is self-contained.
_RECENCY_HALF_LIFE_HOURS = 12.0


@dataclass(frozen=True, slots=True)
class _Candidate:
    rule: CausalRule
    event: SignalEvent


# ---------------------------------------------------------------------------
# Public entry points
# ---------------------------------------------------------------------------


def build_chain_set(
    bundle: EvidenceBundle,
    *,
    now: datetime | None = None,
) -> CausalChainSet:
    """Pure functional convenience over :class:`CausalChainBuilder`."""

    return CausalChainBuilder().build(bundle, now=now)


class CausalChainBuilder:
    """Stateless builder; safe to share across requests."""

    def build(
        self,
        bundle: EvidenceBundle,
        *,
        now: datetime | None = None,
    ) -> CausalChainSet:
        clock = now or datetime.now(timezone.utc)
        entity = bundle.entity
        events = _collect_candidate_events(bundle)

        if entity is None or not entity.is_resolved or not events:
            return _empty_set(bundle, clock, _empty_caveats(bundle, entity, events))

        rules = rules_for_entity(entity)
        if not rules:
            return _empty_set(
                bundle,
                clock,
                ["No causal rules apply to this entity kind in the current registry."],
            )

        candidates = _match_candidates(rules, events, entity)
        if not candidates:
            return _empty_set(
                bundle,
                clock,
                ["Evidence is present but did not match any deterministic causal rule."],
            )

        chains = [
            _build_chain(c, bundle=bundle, entity=entity, now=clock)
            for c in candidates
        ]
        chains = _dedupe_chains(chains)
        chains = _sorted_chains(chains)

        caveats = _set_level_caveats(bundle, chains)
        top, secondary, suppressed = _split_drivers(chains)

        provider_health: str = "live"
        if bundle.time_context is not None and bundle.time_context.coverage == "no_match":
            provider_health = "degraded"

        return CausalChainSet(
            generated_at=clock,
            query=bundle.plan.raw_query,
            entity_id=entity.canonical_id,
            chains=chains,
            top_drivers=top,
            secondary_drivers=secondary,
            suppressed_drivers=suppressed,
            caveats=caveats,
            provider_health=provider_health,  # type: ignore[arg-type]
        )


# ---------------------------------------------------------------------------
# Candidate collection + rule matching
# ---------------------------------------------------------------------------


def _collect_candidate_events(bundle: EvidenceBundle) -> list[SignalEvent]:
    """Union of primary + compare-snapshot + compare-delta events.

    Order is deterministic (primary first, then snapshots in declared
    order, then delta right→left). Duplicate ids are deduped while
    preserving first-seen order so chain ids stay stable.
    """

    seen: set[str] = set()
    out: list[SignalEvent] = []
    sources: list[Iterable[SignalEvent]] = [bundle.primary_events]
    for snap in bundle.compare_snapshots:
        sources.append(snap.events)
    if bundle.compare_delta is not None:
        sources.append(bundle.compare_delta.right_events)
        sources.append(bundle.compare_delta.left_events)
    for source in sources:
        for event in source:
            if event.id in seen:
                continue
            seen.add(event.id)
            out.append(event)
    return out


def _match_candidates(
    rules: Sequence[CausalRule],
    events: Sequence[SignalEvent],
    entity: QueryEntity,
) -> list[_Candidate]:
    out: list[_Candidate] = []
    for event in events:
        for rule in rules:
            try:
                if rule.trigger(event, entity):
                    out.append(_Candidate(rule=rule, event=event))
            except Exception:  # pragma: no cover - rule must never raise
                continue
    return out


# ---------------------------------------------------------------------------
# Chain construction
# ---------------------------------------------------------------------------


def _build_chain(
    candidate: _Candidate,
    *,
    bundle: EvidenceBundle,
    entity: QueryEntity,
    now: datetime,
) -> CausalChain:
    rule = candidate.rule
    event = candidate.event

    chain_id = f"{rule.id}:{event.id}"

    source_node = CausalNode(
        id="n0",
        kind="event",
        label=_short_label(event.title),
        ref_id=event.id,
        country_code=event.place.country_code,
        domain=_event_domain(event),
    )

    mechanism_node = CausalNode(
        id="n1",
        kind=_mechanism_node_kind(rule.domain),
        label=_mechanism_label(rule),
        domain=rule.domain,
    )

    impact_node = CausalNode(
        id="n2",
        kind=_impact_node_kind(entity, rule.domain),
        label=_impact_label(entity, rule),
        ref_id=entity.canonical_id,
        country_code=entity.country_code,
        domain=rule.domain,
    )

    edge_a = CausalEdge(
        from_id="n0",
        to_id="n1",
        mechanism=rule.mechanism,
        rationale=rule.rationale,
        confidence=round(rule.prior, 3),
        evidence_ids=[event.id],
    )
    edge_b = CausalEdge(
        from_id="n1",
        to_id="n2",
        mechanism=rule.mechanism,
        rationale=(
            f"{mechanism_node.label} feeds the {rule.domain} channel for "
            f"{entity.label}."
        ),
        confidence=round(rule.prior * 0.85, 3),
        evidence_ids=[event.id],
    )

    score = _score_chain(rule=rule, event=event, entity=entity, now=now)
    confidence = _confidence_from_score(score, rule=rule, entity=entity)
    strength = _strength_from(rule=rule, event=event, score=score)
    direction = _direction_from(rule=rule, event=event)

    summary = _summary_for(
        rule=rule, event=event, entity=entity, direction=direction
    )

    affected_domains = list(dict.fromkeys((rule.domain, *rule.affected_domains)))

    return CausalChain(
        chain_id=chain_id,
        title=rule.title,
        summary=summary,
        nodes=[source_node, mechanism_node, impact_node],
        edges=[edge_a, edge_b],
        source_evidence_ids=[event.id],
        affected_entities=([entity.label] if entity.label else []),
        affected_symbols=list(rule.affected_symbols),
        affected_domains=affected_domains,
        direction=direction,
        strength=strength,
        confidence=round(confidence, 3),
        score=round(score, 4),
        rule_id=rule.id,
        rule_prior=round(rule.prior, 3),
        caveats=list(rule.caveats),
    )


# ---------------------------------------------------------------------------
# Scoring
# ---------------------------------------------------------------------------


def _score_chain(
    *,
    rule: CausalRule,
    event: SignalEvent,
    entity: QueryEntity,
    now: datetime,
) -> float:
    severity = float(event.severity_score or 0.0)
    recency = _recency_factor(event, now)
    source_quality = _source_quality(event)
    entity_quality = max(0.3, float(entity.confidence or 0.0))
    return (
        rule.prior
        * (0.4 + 0.6 * severity)
        * (0.4 + 0.6 * recency)
        * (0.5 + 0.5 * source_quality)
        * entity_quality
    )


def _recency_factor(event: SignalEvent, now: datetime) -> float:
    ref = event.source_timestamp or event.ingested_at
    if ref is None:
        return 0.3
    age_hours = max(0.0, (now - ref).total_seconds() / 3600.0)
    decay = 0.5 ** (age_hours / _RECENCY_HALF_LIFE_HOURS)
    return max(0.05, min(1.0, decay))


def _source_quality(event: SignalEvent) -> float:
    if not event.sources:
        return float(event.confidence or 0.4)
    best = max((s.reliability for s in event.sources), default=0.5)
    diversity = min(1.0, 0.6 + 0.1 * len(event.sources))
    return min(1.0, best * diversity)


def _confidence_from_score(
    score: float, *, rule: CausalRule, entity: QueryEntity
) -> float:
    base = min(0.95, score)
    # If the entity is a fallback (parent country / region), discount.
    if entity.resolution == "fallback":
        base *= 0.8
    return max(0.0, min(0.95, base))


def _strength_from(
    *, rule: CausalRule, event: SignalEvent, score: float
) -> ImpactStrength:
    if score >= 0.5 or event.severity_score >= 0.75:
        return "strong"
    if score >= 0.25 or event.severity_score >= 0.4:
        return rule.base_strength
    return "weak"


# ---------------------------------------------------------------------------
# Direction inference
# ---------------------------------------------------------------------------


_NEGATIVE_KEYWORDS = (
    "fall",
    "drop",
    "slide",
    "decline",
    "weaken",
    "tumble",
    "miss",
    "downgrade",
    "loss",
    "selloff",
    "plunge",
)
_POSITIVE_KEYWORDS = (
    "rally",
    "surge",
    "jump",
    "rise",
    "climb",
    "beat",
    "upgrade",
    "strengthen",
    "gain",
)


def _direction_from(*, rule: CausalRule, event: SignalEvent) -> ImpactDirection:
    if rule.direction != "mixed":
        return rule.direction
    text = (event.title or "").lower() + " " + (event.summary or "").lower()
    has_neg = any(word in text for word in _NEGATIVE_KEYWORDS)
    has_pos = any(word in text for word in _POSITIVE_KEYWORDS)
    if has_pos and not has_neg:
        return "up"
    if has_neg and not has_pos:
        return "down"
    return "mixed"


# ---------------------------------------------------------------------------
# Dedupe + sort
# ---------------------------------------------------------------------------


def _dedupe_chains(chains: Sequence[CausalChain]) -> list[CausalChain]:
    seen: dict[str, CausalChain] = {}
    for chain in chains:
        key = chain.chain_id
        prior = seen.get(key)
        if prior is None or chain.score > prior.score:
            seen[key] = chain
    return list(seen.values())


def _sorted_chains(chains: Sequence[CausalChain]) -> list[CausalChain]:
    return sorted(chains, key=lambda c: (-c.score, c.chain_id))


# ---------------------------------------------------------------------------
# Driver projection
# ---------------------------------------------------------------------------


def _split_drivers(
    chains: Sequence[CausalChain],
) -> tuple[list[CausalDriver], list[CausalDriver], list[CausalDriver]]:
    top: list[CausalDriver] = []
    secondary: list[CausalDriver] = []
    suppressed: list[CausalDriver] = []
    for chain in chains:
        driver = _to_driver(chain)
        if chain.confidence < 0.25 or chain.strength == "weak" and chain.confidence < 0.4:
            suppressed.append(driver)
            continue
        if len(top) < _TOP_LIMIT:
            top.append(driver)
            continue
        if len(secondary) < _SECONDARY_LIMIT:
            secondary.append(driver)
            continue
        suppressed.append(driver)
    return top, secondary, suppressed


def _to_driver(chain: CausalChain) -> CausalDriver:
    edge = chain.edges[0]
    return CausalDriver(
        chain_id=chain.chain_id,
        title=chain.title,
        mechanism=edge.mechanism,
        domain=chain.affected_domains[0] if chain.affected_domains else "unknown",
        direction=chain.direction,
        strength=chain.strength,
        confidence=chain.confidence,
        rationale=edge.rationale,
        evidence_ids=list(chain.source_evidence_ids),
        caveats=list(chain.caveats),
    )


# ---------------------------------------------------------------------------
# Caveats + empty handling
# ---------------------------------------------------------------------------


def _empty_caveats(
    bundle: EvidenceBundle,
    entity: QueryEntity | None,
    events: Sequence[SignalEvent],
) -> list[str]:
    caveats: list[str] = []
    if entity is None or not entity.is_resolved:
        caveats.append("No entity resolved — causal engine cannot ground a claim.")
    elif not events:
        caveats.append(
            f"No evidence available for {entity.label} in the current scope."
        )
    if bundle.time_context is not None and bundle.time_context.coverage == "no_match":
        caveats.append(
            "No evidence inside the requested time window — causal chains "
            "would be speculative."
        )
    return caveats


def _set_level_caveats(
    bundle: EvidenceBundle, chains: Sequence[CausalChain]
) -> list[str]:
    caveats: list[str] = []
    if not chains:
        return caveats
    top = chains[0]
    if top.confidence < 0.4:
        caveats.append(
            "Top causal driver has low confidence — treat as a hypothesis, "
            "not a forecast."
        )
    if len(top.source_evidence_ids) < 2:
        caveats.append(
            "Top driver is supported by a single evidence item — coverage "
            "is thin."
        )
    if bundle.compare_delta is not None and not bundle.compare_delta.has_movement:
        caveats.append(
            "Compare windows show no material delta — drivers may be "
            "carrying over rather than newly emerging."
        )
    return caveats


def _empty_set(
    bundle: EvidenceBundle,
    clock: datetime,
    caveats: list[str],
) -> CausalChainSet:
    entity_id = bundle.entity.canonical_id if bundle.entity else None
    return CausalChainSet(
        generated_at=clock,
        query=bundle.plan.raw_query,
        entity_id=entity_id,
        chains=[],
        top_drivers=[],
        secondary_drivers=[],
        suppressed_drivers=[],
        caveats=caveats,
        provider_health="empty",
    )


# ---------------------------------------------------------------------------
# Labeling helpers
# ---------------------------------------------------------------------------


def _short_label(text: str | None, *, limit: int = 80) -> str:
    if not text:
        return "Signal"
    cleaned = text.strip()
    if len(cleaned) <= limit:
        return cleaned
    return cleaned[: limit - 1].rstrip() + "…"


def _event_domain(event: SignalEvent) -> ImpactDomain:
    mapping: dict[str, ImpactDomain] = {
        "weather": "weather",
        "conflict": "country_risk",
        "currency": "fx",
        "commodities": "commodities",
        "stocks": "equities",
        "markets": "equities",
        "news": "macro",
    }
    return mapping.get(event.type, "unknown")


def _mechanism_label(rule: CausalRule) -> str:
    mapping = {
        "tightens_supply": "Supply tightens",
        "delays": "Operational delay",
        "disrupts": "Operational disruption",
        "weakens_demand": "Demand softens",
        "increases_risk_premium": "Risk premium rises",
        "pressures_currency": "Currency pressure",
        "raises_input_cost": "Input-cost pressure",
        "affects_exports": "Export competitiveness shifts",
        "affects_imports": "Import-cost shifts",
        "increases_volatility": "Volatility rises",
        "lowers_confidence": "Confidence weakens",
        "improves_sentiment": "Sentiment improves",
        "unknown": "Mechanism (unspecified)",
    }
    return mapping.get(rule.mechanism, rule.title)


def _mechanism_node_kind(domain: ImpactDomain) -> str:
    if domain in ("logistics", "shipping", "supply_chain"):
        return "logistics_route"
    if domain == "weather":
        return "weather_system"
    if domain == "country_risk":
        return "macro_factor"
    return "macro_factor"


def _impact_node_kind(entity: QueryEntity, domain: ImpactDomain) -> str:
    if entity.kind == "commodity":
        return "commodity"
    if entity.kind == "ticker":
        return "equity"
    if entity.kind == "fx_pair":
        return "currency"
    if entity.kind in ("country", "place"):
        return "country"
    return "macro_factor"


def _impact_label(entity: QueryEntity, rule: CausalRule) -> str:
    domain_label = {
        "oil": "Crude exposure",
        "shipping": "Shipping channel",
        "weather": "Weather impact",
        "fx": "FX channel",
        "commodities": "Commodity channel",
        "equities": "Equity exposure",
        "country_risk": "Country-risk premium",
        "sector": "Sector exposure",
        "portfolio": "Portfolio exposure",
        "logistics": "Logistics impact",
        "supply_chain": "Supply-chain impact",
        "macro": "Macro impact",
        "unknown": "Impact",
    }.get(rule.domain, "Impact")
    return f"{domain_label} on {entity.label}"


def _summary_for(
    *,
    rule: CausalRule,
    event: SignalEvent,
    entity: QueryEntity,
    direction: ImpactDirection,
) -> str:
    if rule.summary_template:
        return rule.summary_template.format(
            entity=entity.label or "the subject",
            focus=_short_label(event.title, limit=60),
        )
    direction_word = {
        "up": "raise",
        "down": "weigh on",
        "mixed": "move",
        "stable": "stabilise",
        "unknown": "affect",
    }.get(direction, "affect")
    return (
        f"{rule.title} — likely to {direction_word} {entity.label} "
        f"based on {_short_label(event.title, limit=60)}."
    )


__all__ = ["CausalChainBuilder", "build_chain_set"]
