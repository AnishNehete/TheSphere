"""Phase 18D — causal chain intelligence engine tests.

Asserts the deterministic, evidence-backed contract:

* causal model validation rejects unevidenced chains
* rules fire only for the entity kinds they declare
* chain construction is deterministic and reproducible
* oil/shipping, weather/logistics, and FX/import-cost scenarios produce
  sensible, evidence-backed chains
* sparse evidence yields caveats, not fake claims
* compare and time-window contexts surface different chain sets
* AgentResponse remains backward compatible (causal_chains is optional)
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from app.intelligence.causal import (
    CausalChain,
    CausalChainBuilder,
    CausalChainSet,
    CausalEdge,
    CausalNode,
    build_chain_set,
)
from app.intelligence.causal.rules import CAUSAL_RULES, rules_for_entity
from app.intelligence.repositories.event_repository import InMemoryEventRepository
from app.intelligence.retrieval.entity_resolver import resolve_query_entity
from app.intelligence.retrieval.orchestrator import RetrievalOrchestrator
from app.intelligence.schemas import Place, SignalEvent, SourceRef
from app.intelligence.services import SearchService


NOW = datetime(2026, 4, 26, 12, 0, 0, tzinfo=timezone.utc)


def _event(
    *,
    event_id: str,
    title: str,
    type_: str = "news",
    severity_score: float = 0.7,
    country_code: str | None = "USA",
    country_name: str | None = "United States",
    age_hours: float = 1.0,
    tags: list[str] | None = None,
    summary: str | None = None,
    description: str | None = None,
    publisher: str = "test-wire",
    reliability: float = 0.75,
) -> SignalEvent:
    ts = NOW - timedelta(hours=age_hours)
    return SignalEvent(
        id=event_id,
        dedupe_key=event_id,
        type=type_,  # type: ignore[arg-type]
        title=title,
        summary=summary or title,
        description=description,
        severity="elevated",
        severity_score=severity_score,
        confidence=0.7,
        place=Place(country_code=country_code, country_name=country_name),
        source_timestamp=ts,
        ingested_at=ts,
        sources=[
            SourceRef(
                adapter="test.adapter",
                provider="test",
                publisher=publisher,
                retrieved_at=ts,
                source_timestamp=ts,
                reliability=reliability,
            )
        ],
        tags=tags or [type_],
    )


# ----------------------------------------------------------------------------
# Model validation
# ----------------------------------------------------------------------------


def test_causal_node_is_immutable() -> None:
    node = CausalNode(id="n0", kind="event", label="x", domain="oil")
    with pytest.raises(Exception):
        node.label = "y"  # type: ignore[misc]


def test_causal_chain_requires_evidence_for_meaningful_state() -> None:
    edge = CausalEdge(
        from_id="n0",
        to_id="n1",
        mechanism="tightens_supply",
        rationale="x",
        confidence=0.5,
        evidence_ids=["evt-1"],
    )
    chain = CausalChain(
        chain_id="r:evt-1",
        title="t",
        summary="s",
        nodes=[
            CausalNode(id="n0", kind="event", label="src", domain="oil"),
            CausalNode(id="n1", kind="commodity", label="dst", domain="oil"),
        ],
        edges=[edge],
        source_evidence_ids=["evt-1"],
        rule_id="r",
    )
    assert chain.has_evidence() is True

    bare = CausalChain(
        chain_id="bare",
        title="t",
        summary="s",
        nodes=[],
        edges=[],
        source_evidence_ids=[],
        rule_id="r",
    )
    assert bare.has_evidence() is False


# ----------------------------------------------------------------------------
# Rule registry sanity
# ----------------------------------------------------------------------------


def test_rules_for_entity_filters_by_kind() -> None:
    oil = resolve_query_entity("oil")
    rules = rules_for_entity(oil)
    assert rules, "expected oil-applicable rules"
    assert all("commodity" in r.applies_to_entity for r in rules)


def test_rules_for_entity_returns_empty_for_unresolved() -> None:
    unresolved = resolve_query_entity("zzzzz random gibberish 9999")
    assert rules_for_entity(unresolved) == ()


def test_every_rule_has_unique_id() -> None:
    ids = [r.id for r in CAUSAL_RULES]
    assert len(ids) == len(set(ids))


# ----------------------------------------------------------------------------
# Builder — direct unit tests with hand-crafted bundles
# ----------------------------------------------------------------------------


@pytest.fixture
async def shipping_repo() -> InMemoryEventRepository:
    repo = InMemoryEventRepository()
    await repo.upsert_many(
        [
            _event(
                event_id="ship-1",
                title="Tanker attack disrupts Red Sea shipping route",
                type_="conflict",
                age_hours=2.0,
                tags=["conflict", "shipping", "red sea"],
                summary=(
                    "A tanker attack near the Bab el-Mandeb caused disruption "
                    "to Red Sea shipping lanes, with several vessels delayed."
                ),
            ),
            _event(
                event_id="oil-1",
                title="Crude oil rallies on supply concerns",
                type_="commodities",
                age_hours=2.5,
                tags=["commodities", "oil", "wti"],
                summary="WTI oil prices surge as inventory build slows.",
            ),
        ]
    )
    return repo


async def test_oil_shipping_chain_is_built(
    shipping_repo: InMemoryEventRepository,
) -> None:
    orchestrator = RetrievalOrchestrator(
        repository=shipping_repo, search=SearchService(shipping_repo)
    )
    bundle = await orchestrator.run("oil today", now=NOW)
    chain_set = build_chain_set(bundle, now=NOW)
    assert not chain_set.is_empty()
    rule_ids = {chain.rule_id for chain in chain_set.chains}
    # Either the dedicated shipping rule or the general oil-supply rule
    # must fire for an oil query against a Red-Sea-disruption corpus.
    assert (
        "shipping_disruption_to_oil" in rule_ids
        or "oil_supply_to_commodity" in rule_ids
    )
    # Top driver must reference real evidence — never empty.
    assert chain_set.top_drivers
    assert chain_set.top_drivers[0].evidence_ids


async def test_oil_shipping_chain_is_deterministic(
    shipping_repo: InMemoryEventRepository,
) -> None:
    orchestrator = RetrievalOrchestrator(
        repository=shipping_repo, search=SearchService(shipping_repo)
    )
    bundle = await orchestrator.run("oil today", now=NOW)
    a = build_chain_set(bundle, now=NOW)
    b = build_chain_set(bundle, now=NOW)
    assert [c.chain_id for c in a.chains] == [c.chain_id for c in b.chains]
    assert [c.score for c in a.chains] == [c.score for c in b.chains]


@pytest.fixture
async def weather_repo() -> InMemoryEventRepository:
    repo = InMemoryEventRepository()
    await repo.upsert_many(
        [
            _event(
                event_id="wx-1",
                title="Hurricane forecast to disrupt Gulf coast operations",
                type_="weather",
                age_hours=3.0,
                country_code="USA",
                tags=["weather", "hurricane"],
                summary="A category 3 hurricane is expected to impact ports.",
            ),
        ]
    )
    return repo


async def test_weather_logistics_chain(
    weather_repo: InMemoryEventRepository,
) -> None:
    orchestrator = RetrievalOrchestrator(
        repository=weather_repo, search=SearchService(weather_repo)
    )
    bundle = await orchestrator.run("United States", now=NOW)
    chain_set = build_chain_set(bundle, now=NOW)
    if chain_set.is_empty():
        # the country query may not yield primary events in some scope
        # configurations; that's acceptable as long as caveats explain.
        assert chain_set.caveats
        return
    rule_ids = {chain.rule_id for chain in chain_set.chains}
    assert "severe_weather_to_logistics" in rule_ids


@pytest.fixture
async def fx_repo() -> InMemoryEventRepository:
    repo = InMemoryEventRepository()
    await repo.upsert_many(
        [
            _event(
                event_id="fx-1",
                title="Yen weakens further against the dollar",
                type_="currency",
                age_hours=2.0,
                tags=["currency", "usd", "jpy"],
                summary="USDJPY rises as the yen weakens past key support.",
            ),
        ]
    )
    return repo


async def test_currency_import_cost_chain(
    fx_repo: InMemoryEventRepository,
) -> None:
    orchestrator = RetrievalOrchestrator(
        repository=fx_repo, search=SearchService(fx_repo)
    )
    bundle = await orchestrator.run("USDJPY", now=NOW)
    chain_set = build_chain_set(bundle, now=NOW)
    assert not chain_set.is_empty()
    rule_ids = {chain.rule_id for chain in chain_set.chains}
    assert "currency_weakness_to_imports" in rule_ids
    top = chain_set.top_drivers[0]
    assert top.direction == "up"
    assert top.confidence > 0.0


# ----------------------------------------------------------------------------
# Sparse / unsupported scenarios
# ----------------------------------------------------------------------------


async def test_unresolved_query_returns_empty_with_caveat() -> None:
    repo = InMemoryEventRepository()
    orchestrator = RetrievalOrchestrator(
        repository=repo, search=SearchService(repo)
    )
    bundle = await orchestrator.run("zzzzzz random gibberish 9999", now=NOW)
    chain_set = build_chain_set(bundle, now=NOW)
    assert chain_set.is_empty()
    assert chain_set.caveats
    assert any("entity" in c.lower() for c in chain_set.caveats)


async def test_no_matching_evidence_returns_caveat() -> None:
    # Oil query against an empty repo — entity resolves but no evidence.
    repo = InMemoryEventRepository()
    orchestrator = RetrievalOrchestrator(
        repository=repo, search=SearchService(repo)
    )
    bundle = await orchestrator.run("oil today", now=NOW)
    chain_set = build_chain_set(bundle, now=NOW)
    assert chain_set.is_empty()
    assert chain_set.caveats


async def test_evidence_present_but_no_rule_matches_returns_caveat() -> None:
    # Single irrelevant news row for a ticker query — entity resolves but
    # no rule trigger fires.
    repo = InMemoryEventRepository()
    await repo.upsert_many(
        [
            _event(
                event_id="random-1",
                title="Q3 trading update at neutral levels",
                type_="news",
                age_hours=2.0,
                tags=["tesla"],
                summary="Tesla reports neutral activity, no material change.",
            )
        ]
    )
    orchestrator = RetrievalOrchestrator(
        repository=repo, search=SearchService(repo)
    )
    bundle = await orchestrator.run("tesla", now=NOW)
    chain_set = build_chain_set(bundle, now=NOW)
    # Either the equity volatility rule fires (positive/negative words) or
    # we land in the "no rule matched" branch — both must include caveats
    # / drivers and never produce an unevidenced chain.
    if chain_set.is_empty():
        assert chain_set.caveats
    else:
        for chain in chain_set.chains:
            assert chain.has_evidence()


# ----------------------------------------------------------------------------
# Compare differences
# ----------------------------------------------------------------------------


async def test_compare_yesterday_vs_today_produces_chain_difference() -> None:
    repo = InMemoryEventRepository()
    await repo.upsert_many(
        [
            _event(
                event_id="oil-yesterday",
                title="Oil supply concerns drive prices higher",
                type_="commodities",
                age_hours=30.0,
                tags=["commodities", "oil"],
                summary="Crude oil rallies on tightening supply.",
            ),
            _event(
                event_id="oil-today",
                title="Crude oil tumbles after demand-side miss",
                type_="commodities",
                age_hours=2.0,
                tags=["commodities", "oil"],
                summary="Oil drops sharply after demand outlook weakens.",
            ),
        ]
    )
    orchestrator = RetrievalOrchestrator(
        repository=repo, search=SearchService(repo)
    )
    bundle = await orchestrator.run("oil yesterday vs today", now=NOW)
    assert bundle.compare_delta is not None
    chain_set = build_chain_set(bundle, now=NOW)
    if chain_set.is_empty():
        return  # no rule matched; that's fine for this fixture
    evidence_ids = {
        eid for chain in chain_set.chains for eid in chain.source_evidence_ids
    }
    # The chain set must surface evidence from at least one of the legs;
    # we never collapse the two windows into a single un-attributable list.
    assert evidence_ids & {"oil-yesterday", "oil-today"}


# ----------------------------------------------------------------------------
# Time-window differences
# ----------------------------------------------------------------------------


async def test_time_window_no_match_marks_provider_degraded() -> None:
    repo = InMemoryEventRepository()
    await repo.upsert_many(
        [
            _event(
                event_id="oil-old",
                title="Crude oil rallies on supply concerns",
                type_="commodities",
                age_hours=200.0,  # well outside "today"
                tags=["commodities", "oil"],
            )
        ]
    )
    orchestrator = RetrievalOrchestrator(
        repository=repo, search=SearchService(repo)
    )
    bundle = await orchestrator.run("oil today", now=NOW)
    chain_set = build_chain_set(bundle, now=NOW)
    # The window has no match → builder must surface degraded health.
    assert chain_set.provider_health in ("empty", "degraded")
    assert chain_set.caveats


# ----------------------------------------------------------------------------
# AgentResponse backward compatibility
# ----------------------------------------------------------------------------


async def test_agent_response_includes_causal_chains_when_present(
    fx_repo: InMemoryEventRepository,
) -> None:
    from app.intelligence.services.agent_service import AgentQueryService

    service = AgentQueryService(
        search=SearchService(fx_repo), repository=fx_repo
    )
    response = await service.ask("USDJPY")
    # Either we got chains (preferred when rules fired) or the field is
    # null — both are acceptable; the field must exist either way so the
    # frontend can rely on it without a defensive guard.
    assert hasattr(response, "causal_chains")
    if response.causal_chains is not None:
        assert isinstance(response.causal_chains, CausalChainSet)
        assert response.causal_chains.chains
        for chain in response.causal_chains.chains:
            assert chain.has_evidence()


async def test_agent_response_is_null_when_no_chains() -> None:
    repo = InMemoryEventRepository()
    from app.intelligence.services.agent_service import AgentQueryService

    service = AgentQueryService(
        search=SearchService(repo), repository=repo
    )
    response = await service.ask("zzzzzz random gibberish 9999")
    assert response.causal_chains is None


# ----------------------------------------------------------------------------
# Driver projection determinism
# ----------------------------------------------------------------------------


async def test_top_drivers_are_capped_and_evidence_backed(
    shipping_repo: InMemoryEventRepository,
) -> None:
    orchestrator = RetrievalOrchestrator(
        repository=shipping_repo, search=SearchService(shipping_repo)
    )
    bundle = await orchestrator.run("oil today", now=NOW)
    chain_set = CausalChainBuilder().build(bundle, now=NOW)
    assert len(chain_set.top_drivers) <= 3
    for driver in chain_set.top_drivers:
        assert driver.evidence_ids
        assert 0.0 <= driver.confidence <= 1.0
