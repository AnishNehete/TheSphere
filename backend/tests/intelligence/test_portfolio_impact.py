"""Phase 19B — portfolio impact linkage tests.

Verifies the deterministic projection of causal chains onto portfolio
holdings:

* direct symbol match (chain.affected_symbols)
* indirect domain match (chain.affected_domains × holding sector)
* weak country exposure match
* no portfolio / empty portfolio / no chain set returns ``None``
* demo-named portfolio is flagged via ``is_demo`` and labeled honestly
* AgentResponse remains backward compatible when no portfolio is given
"""

from __future__ import annotations

from datetime import datetime, timezone

import pytest

from app.intelligence.causal.model import (
    CausalChain,
    CausalChainSet,
    CausalEdge,
    CausalNode,
)
from app.intelligence.causal.portfolio_impact import (
    build_portfolio_impact,
    is_demo_portfolio,
)
from app.intelligence.portfolio.schemas import Holding, PortfolioRecord


NOW = datetime(2026, 4, 26, 12, 0, 0, tzinfo=timezone.utc)


def _holding(
    *,
    holding_id: str,
    symbol: str,
    sector: str | None = None,
    asset_type: str = "equity",
    country_code: str | None = None,
    weight: float = 0.1,
) -> Holding:
    return Holding(
        id=holding_id,
        portfolio_id="pf-1",
        symbol=symbol,
        name=symbol,
        quantity=10.0,
        weight=weight,
        asset_type=asset_type,  # type: ignore[arg-type]
        sector=sector,
        country_code=country_code,
    )


def _portfolio(
    *,
    portfolio_id: str = "pf-1",
    name: str = "Sample Book",
    holdings: list[Holding] | None = None,
    tags: list[str] | None = None,
) -> PortfolioRecord:
    return PortfolioRecord(
        id=portfolio_id,
        name=name,
        created_at=NOW,
        updated_at=NOW,
        holdings=holdings or [],
        tags=tags or [],
    )


def _chain(
    *,
    chain_id: str = "c1",
    title: str = "Oil → Refining",
    affected_symbols: list[str] | None = None,
    affected_domains: list[str] | None = None,
    direction: str = "up",
    confidence: float = 0.8,
    caveats: list[str] | None = None,
) -> CausalChain:
    return CausalChain(
        chain_id=chain_id,
        title=title,
        summary="Test chain",
        nodes=[
            CausalNode(id="n0", kind="event", label="Trigger"),
            CausalNode(id="n1", kind="commodity", label="Oil"),
        ],
        edges=[
            CausalEdge(
                from_id="n0",
                to_id="n1",
                mechanism="tightens_supply",
                rationale="Test",
                confidence=confidence,
                evidence_ids=["e1"],
            )
        ],
        source_evidence_ids=["e1"],
        affected_symbols=affected_symbols or [],
        affected_domains=affected_domains or [],  # type: ignore[arg-type]
        direction=direction,  # type: ignore[arg-type]
        strength="moderate",
        confidence=confidence,
        score=0.5,
        rule_id="test_rule",
        rule_prior=0.6,
        caveats=caveats or [],
    )


def _chain_set(chains: list[CausalChain]) -> CausalChainSet:
    return CausalChainSet(
        generated_at=NOW,
        query="why is oil up",
        chains=chains,
        provider_health="live" if chains else "empty",
    )


# ---------------------------------------------------------------------------
# Direct match
# ---------------------------------------------------------------------------


def test_direct_symbol_match_produces_direct_exposure() -> None:
    chain = _chain(
        chain_id="c-direct",
        affected_symbols=["TSLA"],
        affected_domains=["equities"],
    )
    portfolio = _portfolio(
        holdings=[
            _holding(holding_id="h-tsla", symbol="TSLA", sector="auto"),
            _holding(holding_id="h-aapl", symbol="AAPL", sector="tech"),
        ]
    )

    impact = build_portfolio_impact(_chain_set([chain]), portfolio, now=NOW)

    assert impact is not None
    assert impact.holdings_count == 2
    assert len(impact.impacted_holdings) == 1
    hit = impact.impacted_holdings[0]
    assert hit.symbol == "TSLA"
    assert hit.exposure_type == "direct"
    assert hit.matched_symbol == "TSLA"
    assert hit.matched_chain_id == "c-direct"
    assert hit.confidence > 0.5
    assert "TSLA" in hit.rationale


def test_direct_match_is_case_insensitive() -> None:
    chain = _chain(affected_symbols=["tsla"])
    portfolio = _portfolio(
        holdings=[_holding(holding_id="h-tsla", symbol="TSLA")]
    )

    impact = build_portfolio_impact(_chain_set([chain]), portfolio, now=NOW)
    assert impact is not None
    assert impact.impacted_holdings[0].exposure_type == "direct"


# ---------------------------------------------------------------------------
# Indirect (domain → sector) match
# ---------------------------------------------------------------------------


def test_indirect_domain_match_via_sector() -> None:
    chain = _chain(
        chain_id="c-oil",
        affected_symbols=[],
        affected_domains=["oil"],
    )
    portfolio = _portfolio(
        holdings=[
            _holding(holding_id="h-xom", symbol="XOM", sector="Energy"),
            _holding(holding_id="h-aapl", symbol="AAPL", sector="Technology"),
        ]
    )

    impact = build_portfolio_impact(_chain_set([chain]), portfolio, now=NOW)

    assert impact is not None
    symbols = {h.symbol for h in impact.impacted_holdings}
    assert symbols == {"XOM"}
    hit = impact.impacted_holdings[0]
    assert hit.exposure_type == "indirect"
    assert hit.matched_domain == "oil"
    assert hit.matched_symbol is None
    # Indirect confidence is dampened relative to direct.
    assert hit.confidence < chain.confidence


def test_indirect_match_via_asset_type_when_sector_missing() -> None:
    chain = _chain(affected_domains=["fx"])
    portfolio = _portfolio(
        holdings=[
            _holding(
                holding_id="h-cash-jpy",
                symbol="JPY-CASH",
                sector=None,
                asset_type="cash",
            )
        ]
    )

    impact = build_portfolio_impact(_chain_set([chain]), portfolio, now=NOW)
    assert impact is not None
    hit = impact.impacted_holdings[0]
    assert hit.exposure_type == "indirect"
    assert hit.matched_domain == "fx"
    # Caveat surfaces when the sector tag was absent.
    assert any("sector" in c.lower() for c in hit.caveats)


# ---------------------------------------------------------------------------
# Weak (country) match
# ---------------------------------------------------------------------------


def test_weak_country_exposure_match() -> None:
    chain = _chain(
        chain_id="c-shipping",
        affected_symbols=[],
        affected_domains=["shipping", "supply_chain"],
    )
    portfolio = _portfolio(
        holdings=[
            _holding(
                holding_id="h-jp-fund",
                symbol="JPY-FUND",
                sector=None,
                asset_type="fund",
                country_code="JPN",
            )
        ]
    )

    impact = build_portfolio_impact(_chain_set([chain]), portfolio, now=NOW)

    assert impact is not None
    hit = impact.impacted_holdings[0]
    assert hit.exposure_type == "weak"
    assert hit.country_code == "JPN"
    assert hit.confidence < 0.5
    assert any("country exposure" in c.lower() for c in hit.caveats)


# ---------------------------------------------------------------------------
# Negative cases
# ---------------------------------------------------------------------------


def test_returns_none_when_portfolio_missing() -> None:
    chain = _chain(affected_symbols=["TSLA"])
    impact = build_portfolio_impact(_chain_set([chain]), None, now=NOW)
    assert impact is None


def test_returns_none_when_portfolio_has_no_holdings() -> None:
    chain = _chain(affected_symbols=["TSLA"])
    portfolio = _portfolio(holdings=[])
    impact = build_portfolio_impact(_chain_set([chain]), portfolio, now=NOW)
    assert impact is None


def test_returns_none_when_chain_set_empty() -> None:
    portfolio = _portfolio(
        holdings=[_holding(holding_id="h", symbol="TSLA")]
    )
    impact = build_portfolio_impact(_chain_set([]), portfolio, now=NOW)
    assert impact is None


def test_returns_none_when_no_holding_matches() -> None:
    chain = _chain(
        affected_symbols=["NVDA"],
        affected_domains=["sector"],
    )
    portfolio = _portfolio(
        holdings=[_holding(holding_id="h-aapl", symbol="AAPL", sector="tech")]
    )
    impact = build_portfolio_impact(_chain_set([chain]), portfolio, now=NOW)
    assert impact is None


# ---------------------------------------------------------------------------
# Demo / paper portfolio labeling
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "name,tags,expected",
    [
        ("Demo Book", [], True),
        ("Paper Portfolio", [], True),
        ("My Sample Holdings", [], True),
        ("Production Book", ["paper"], True),
        ("Live Trading", [], False),
        ("Real Money 2026", ["live"], False),
    ],
)
def test_is_demo_portfolio_heuristic(
    name: str, tags: list[str], expected: bool
) -> None:
    portfolio = _portfolio(name=name, tags=tags)
    assert is_demo_portfolio(portfolio) is expected


def test_demo_portfolio_summary_labels_book_explicitly() -> None:
    chain = _chain(affected_symbols=["TSLA"])
    portfolio = _portfolio(
        name="Demo Sandbox",
        holdings=[_holding(holding_id="h-tsla", symbol="TSLA")],
    )

    impact = build_portfolio_impact(_chain_set([chain]), portfolio, now=NOW)

    assert impact is not None
    assert impact.is_demo is True
    assert "demo book" in impact.summary.lower()
    assert any("demo" in c.lower() for c in impact.caveats)


# ---------------------------------------------------------------------------
# Ordering + idempotency
# ---------------------------------------------------------------------------


def test_holding_is_only_matched_once_across_chains() -> None:
    chain_a = _chain(
        chain_id="c-a",
        affected_symbols=["TSLA"],
        affected_domains=["equities"],
    )
    chain_b = _chain(
        chain_id="c-b",
        affected_symbols=["TSLA"],
        affected_domains=["equities"],
        confidence=0.5,
    )
    portfolio = _portfolio(
        holdings=[_holding(holding_id="h-tsla", symbol="TSLA", sector="auto")]
    )

    impact = build_portfolio_impact(
        _chain_set([chain_a, chain_b]), portfolio, now=NOW
    )

    assert impact is not None
    assert len(impact.impacted_holdings) == 1
    # First chain wins.
    assert impact.impacted_holdings[0].matched_chain_id == "c-a"


def test_direct_match_outranks_indirect_in_sort_order() -> None:
    chain = _chain(
        chain_id="c-multi",
        affected_symbols=["TSLA"],
        affected_domains=["oil"],
    )
    portfolio = _portfolio(
        holdings=[
            _holding(holding_id="h-xom", symbol="XOM", sector="energy"),
            _holding(holding_id="h-tsla", symbol="TSLA", sector="auto"),
        ]
    )

    impact = build_portfolio_impact(_chain_set([chain]), portfolio, now=NOW)
    assert impact is not None
    types = [h.exposure_type for h in impact.impacted_holdings]
    assert types == ["direct", "indirect"]


# ---------------------------------------------------------------------------
# AgentResponse backward compatibility
# ---------------------------------------------------------------------------


def test_agent_response_portfolio_impact_defaults_to_none() -> None:
    from app.intelligence.schemas import AgentResponse

    response = AgentResponse(
        query="x",
        interpreted_query="x",
        intent="general_retrieval",
        generated_at=NOW,
    )
    assert response.portfolio_impact is None
    # Round-tripping the JSON keeps the field but as null.
    payload = response.model_dump(mode="json")
    assert payload["portfolio_impact"] is None
