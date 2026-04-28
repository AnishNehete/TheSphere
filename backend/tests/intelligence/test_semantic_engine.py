"""Phase 13B.3 — pure semantic engine fixture tests.

Covers:
    * ``match_events_to_holding`` — country / sector / chokepoint / commodity /
      macro-theme linkage and the disjoint-edge no-match case
    * ``score_holding`` — severity, recency decay, max-weight overlap rule,
      capping, level boundaries, evidence-citation invariant
    * ``rollup_portfolio`` — weighted average, driver merge, event dedup
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from app.intelligence.portfolio.schemas import ExposureEdge, Holding
from app.intelligence.portfolio.semantic.engine import (
    MAX_EVENTS_PER_HOLDING,
    RECENCY_HALF_LIFE_HOURS,
    match_events_to_holding,
    rollup_portfolio,
    score_holding,
)
from app.intelligence.portfolio.semantic.schemas import (
    PortfolioSemanticRollup,
    SemanticDriver,
    SemanticSnapshot,
)
from app.intelligence.schemas import (
    EventEntity,
    Place,
    SignalEvent,
    SourceRef,
)


NOW = datetime(2026, 4, 23, 12, 0, 0, tzinfo=timezone.utc)


# -----------------------------------------------------------------------------
# fixture helpers
# -----------------------------------------------------------------------------


def _evt(
    *,
    event_id: str,
    title: str = "Some event",
    country_code: str | None = None,
    severity_score: float = 0.7,
    confidence: float = 0.7,
    reliability: float = 0.8,
    ingested_age_hours: float = 1.0,
    type_: str = "news",
    tags: list[str] | None = None,
    entities: list[EventEntity] | None = None,
) -> SignalEvent:
    ts = NOW - timedelta(hours=ingested_age_hours)
    return SignalEvent(
        id=event_id,
        dedupe_key=event_id,
        type=type_,  # type: ignore[arg-type]
        title=title,
        summary=title,
        severity_score=severity_score,
        confidence=confidence,
        place=Place(country_code=country_code, country_name=country_code),
        source_timestamp=ts,
        ingested_at=ts,
        sources=[
            SourceRef(
                adapter="unit",
                provider="unit",
                publisher="unit-test",
                retrieved_at=ts,
                source_timestamp=ts,
                reliability=reliability,
            )
        ],
        tags=list(tags or []),
        entities=list(entities or []),
    )


def _holding(hid: str = "hld_1", symbol: str = "AAPL") -> Holding:
    return Holding(
        id=hid,
        portfolio_id="port_demo",
        symbol=symbol,
        enrichment_confidence=0.9,
    )


def _edge(
    holding_id: str,
    node_id: str,
    *,
    weight: float = 0.5,
    confidence: float = 0.8,
    rationale: str = "test",
) -> ExposureEdge:
    return ExposureEdge(
        holding_id=holding_id,
        node_id=node_id,
        weight=weight,
        confidence=confidence,
        rationale=rationale,
    )


# -----------------------------------------------------------------------------
# Match tests
# -----------------------------------------------------------------------------


class TestMatchEventsToHolding:
    def test_country_match_links_event(self) -> None:
        holding = _holding()
        edges = [_edge(holding.id, "country:USA")]
        events = [_evt(event_id="evt-us", country_code="USA")]
        per_event = match_events_to_holding(holding, edges, events)
        assert list(per_event.keys()) == ["evt-us"]
        assert len(per_event["evt-us"]) == 1
        assert per_event["evt-us"][0][0].node_id == "country:USA"

    def test_sector_tag_match_links_event(self) -> None:
        holding = _holding()
        edges = [_edge(holding.id, "sector:technology")]
        events = [_evt(event_id="evt-tech", tags=["technology"])]
        per_event = match_events_to_holding(holding, edges, events)
        assert "evt-tech" in per_event

    def test_chokepoint_title_match_links_event(self) -> None:
        holding = _holding()
        edges = [_edge(holding.id, "chokepoint:suez")]
        events = [
            _evt(event_id="evt-suez", title="Suez transit delay"),
            _evt(event_id="evt-other", title="Unrelated news"),
        ]
        per_event = match_events_to_holding(holding, edges, events)
        assert "evt-suez" in per_event
        assert "evt-other" not in per_event

    def test_macro_theme_tag_match(self) -> None:
        holding = _holding()
        edges = [_edge(holding.id, "macro_theme:ai")]
        events = [
            _evt(event_id="evt-ai", tags=["ai-demand"]),
            _evt(event_id="evt-energy", tags=["oil"]),
        ]
        per_event = match_events_to_holding(holding, edges, events)
        assert "evt-ai" in per_event
        assert "evt-energy" not in per_event

    def test_commodity_tag_match(self) -> None:
        holding = _holding()
        edges = [_edge(holding.id, "commodity:oil")]
        events = [_evt(event_id="evt-oil", tags=["oil"])]
        per_event = match_events_to_holding(holding, edges, events)
        assert "evt-oil" in per_event

    def test_no_match_returns_empty_dict(self) -> None:
        holding = _holding()
        edges = [_edge(holding.id, "country:JPN")]
        events = [_evt(event_id="evt-us", country_code="USA")]
        assert match_events_to_holding(holding, edges, events) == {}

    def test_duplicate_edges_collapse_to_single_event_entry(self) -> None:
        # Two edges both matching the same USA+technology event.
        holding = _holding()
        edges = [
            _edge(holding.id, "country:USA", weight=0.4),
            _edge(holding.id, "sector:technology", weight=0.6),
        ]
        events = [
            _evt(
                event_id="evt-both",
                country_code="USA",
                tags=["technology"],
            )
        ]
        per_event = match_events_to_holding(holding, edges, events)
        # One event id, two matches (one per edge).
        assert list(per_event.keys()) == ["evt-both"]
        assert len(per_event["evt-both"]) == 2

    def test_unknown_domain_fails_closed(self) -> None:
        holding = _holding()
        edges = [_edge(holding.id, "mystery:xyz")]
        events = [_evt(event_id="evt", country_code="USA", tags=["xyz"])]
        assert match_events_to_holding(holding, edges, events) == {}

    def test_no_edges_returns_empty(self) -> None:
        holding = _holding()
        events = [_evt(event_id="evt", country_code="USA")]
        assert match_events_to_holding(holding, [], events) == {}


# -----------------------------------------------------------------------------
# Score tests
# -----------------------------------------------------------------------------


class TestScoreHolding:
    def test_empty_events_returns_calm_zero_score(self) -> None:
        holding = _holding()
        edges = [_edge(holding.id, "country:USA")]
        snap = score_holding(holding, edges, [], as_of=NOW)
        assert isinstance(snap, SemanticSnapshot)
        assert snap.semantic_score == 0.0
        assert snap.event_pressure_level == "calm"
        assert snap.semantic_drivers == []
        assert snap.linked_event_ids == []
        assert snap.confidence == 0.0

    def test_disjoint_edges_returns_calm(self) -> None:
        holding = _holding()
        edges = [_edge(holding.id, "country:JPN")]
        events = [_evt(event_id="evt-us", country_code="USA")]
        snap = score_holding(holding, edges, events, as_of=NOW)
        assert snap.semantic_score == 0.0
        assert snap.event_pressure_level == "calm"

    def test_severity_contributes_proportionally(self) -> None:
        holding = _holding()
        edges = [_edge(holding.id, "country:USA", weight=1.0)]
        big = _evt(
            event_id="evt-big",
            country_code="USA",
            severity_score=0.8,
            ingested_age_hours=0.1,
        )
        small = _evt(
            event_id="evt-small",
            country_code="USA",
            severity_score=0.4,
            ingested_age_hours=0.1,
        )
        snap_big = score_holding(holding, edges, [big], as_of=NOW)
        snap_small = score_holding(holding, edges, [small], as_of=NOW)
        assert snap_big.semantic_score > snap_small.semantic_score

    def test_recency_decay_reduces_old_events(self) -> None:
        holding = _holding()
        edges = [_edge(holding.id, "country:USA", weight=1.0)]
        fresh = _evt(
            event_id="evt-fresh",
            country_code="USA",
            severity_score=0.8,
            ingested_age_hours=0.1,
        )
        # 14 days old = ~2 half-lives (168h each) -> ~0.0625 recency factor.
        ancient = _evt(
            event_id="evt-old",
            country_code="USA",
            severity_score=0.8,
            ingested_age_hours=14 * 24,
        )
        fresh_snap = score_holding(holding, edges, [fresh], as_of=NOW)
        old_snap = score_holding(holding, edges, [ancient], as_of=NOW)
        assert fresh_snap.semantic_score > 0
        assert old_snap.semantic_score >= 0
        # 14d = 2 half-lives (168h each) => ~exp(-2) ≈ 7.4× suppression.
        # Assert at least 5× so the check holds under rounding.
        assert fresh_snap.semantic_score >= old_snap.semantic_score * 5

    def test_max_weight_edge_wins_for_overlapping_edges(self) -> None:
        """If two edges both match the same event, pick the max-weight edge.

        The test compares the snapshot built from two overlapping edges to
        the snapshot built from only the low-weight edge: the overlapping
        snapshot must equal the score using the *higher*-weight edge (not
        the sum of both).
        """

        holding = _holding()
        strong_edge = _edge(holding.id, "sector:technology", weight=0.9)
        weak_edge = _edge(holding.id, "country:USA", weight=0.2)
        events = [
            _evt(
                event_id="evt-both",
                country_code="USA",
                tags=["technology"],
                severity_score=0.7,
                ingested_age_hours=0.1,
            )
        ]
        overlap_snap = score_holding(
            holding, [weak_edge, strong_edge], events, as_of=NOW
        )
        strong_only_snap = score_holding(holding, [strong_edge], events, as_of=NOW)
        assert overlap_snap.semantic_score == pytest.approx(
            strong_only_snap.semantic_score, abs=1e-6
        )

    def test_score_capped_at_1_0(self) -> None:
        holding = _holding()
        edges = [_edge(holding.id, "country:USA", weight=1.0)]
        events = [
            _evt(
                event_id=f"evt-{i}",
                country_code="USA",
                severity_score=1.0,
                confidence=1.0,
                reliability=1.0,
                ingested_age_hours=0.1,
            )
            for i in range(50)
        ]
        snap = score_holding(holding, edges, events, as_of=NOW)
        assert snap.semantic_score == 1.0
        assert snap.event_pressure_level == "critical"

    def test_level_boundaries_watch(self) -> None:
        # Score slightly above 0.25 -> watch.
        snap = _score_with_target(0.3)
        assert snap.event_pressure_level == "watch"

    def test_level_boundaries_elevated(self) -> None:
        snap = _score_with_target(0.6)
        assert snap.event_pressure_level == "elevated"

    def test_level_boundaries_critical(self) -> None:
        snap = _score_with_target(0.9)
        assert snap.event_pressure_level == "critical"

    def test_drivers_cite_real_event_ids(self) -> None:
        holding = _holding()
        edges = [_edge(holding.id, "country:USA", weight=1.0)]
        events = [
            _evt(
                event_id=f"evt-real-{i}",
                country_code="USA",
                severity_score=0.5,
                ingested_age_hours=0.1,
            )
            for i in range(3)
        ]
        input_ids = {e.id for e in events}
        snap = score_holding(holding, edges, events, as_of=NOW)
        assert snap.semantic_drivers, "expected at least one driver"
        for driver in snap.semantic_drivers:
            assert driver.evidence_ids
            for eid in driver.evidence_ids:
                assert eid in input_ids, (
                    f"driver cited unknown event id {eid}; inputs={input_ids}"
                )

    def test_no_fabricated_driver_text(self) -> None:
        holding = _holding()
        edges = [_edge(holding.id, "country:USA", weight=1.0)]
        events = [
            _evt(
                event_id="evt-a",
                country_code="USA",
                title="Event A",
                severity_score=0.6,
            ),
            _evt(
                event_id="evt-b",
                country_code="USA",
                title="Event B",
                severity_score=0.5,
            ),
        ]
        snap = score_holding(holding, edges, events, as_of=NOW)
        assert snap.semantic_drivers
        rationale = snap.semantic_drivers[0].rationale
        # Rationale must reference one of the real titles, not invented copy.
        assert ("Event A" in rationale) or ("Event B" in rationale)

    def test_events_cap_respected(self) -> None:
        holding = _holding()
        edges = [_edge(holding.id, "country:USA", weight=0.05)]
        events = [
            _evt(
                event_id=f"evt-{i}",
                country_code="USA",
                severity_score=0.1,
                ingested_age_hours=0.1,
            )
            for i in range(MAX_EVENTS_PER_HOLDING + 10)
        ]
        snap = score_holding(holding, edges, events, as_of=NOW)
        assert len(snap.linked_event_ids) <= MAX_EVENTS_PER_HOLDING


def _score_with_target(target: float) -> SemanticSnapshot:
    """Helper: build a single event whose contribution lands at ~target.

    Uses age=0 (recency=1), reliability=1, confidence=1, so
    contrib ≈ severity_score × edge_weight. We set edge.weight=1.0 and pick
    severity_score = target.
    """

    holding = _holding()
    edges = [_edge(holding.id, "country:USA", weight=1.0)]
    events = [
        _evt(
            event_id="evt-target",
            country_code="USA",
            severity_score=target,
            confidence=1.0,
            reliability=1.0,
            ingested_age_hours=0.0,
        )
    ]
    return score_holding(holding, edges, events, as_of=NOW)


# -----------------------------------------------------------------------------
# Rollup tests
# -----------------------------------------------------------------------------


class TestRollupPortfolio:
    def test_empty_snapshots_returns_calm_zero(self) -> None:
        rollup = rollup_portfolio("port_x", {}, [], as_of=NOW)
        assert isinstance(rollup, PortfolioSemanticRollup)
        assert rollup.semantic_score == 0.0
        assert rollup.event_pressure_level == "calm"
        assert rollup.top_drivers == []
        assert rollup.contributing_event_count == 0

    def test_weighted_average_by_holding_weight(self) -> None:
        as_of = NOW
        snap_a = SemanticSnapshot(
            holding_id="h_a",
            symbol="A",
            semantic_score=0.8,
            event_pressure_level="critical",
            semantic_drivers=[],
            linked_event_ids=["evt-1"],
            confidence=0.7,
            as_of=as_of,
        )
        snap_b = SemanticSnapshot(
            holding_id="h_b",
            symbol="B",
            semantic_score=0.1,
            event_pressure_level="calm",
            semantic_drivers=[],
            linked_event_ids=["evt-2"],
            confidence=0.6,
            as_of=as_of,
        )
        rollup = rollup_portfolio(
            "port_x",
            {"h_a": 0.7, "h_b": 0.3},
            [snap_a, snap_b],
            as_of=as_of,
        )
        # 0.8 * 0.7 + 0.1 * 0.3 = 0.59
        assert rollup.semantic_score == pytest.approx(0.59, abs=0.01)
        assert rollup.contributing_event_count == 2

    def test_top_drivers_merged_across_holdings(self) -> None:
        as_of = NOW
        driver_a = SemanticDriver(
            node_id="country:USA",
            label="USA",
            contribution=0.4,
            rationale="A rationale",
            evidence_ids=["evt-1"],
        )
        driver_b = SemanticDriver(
            node_id="country:USA",
            label="USA",
            contribution=0.3,
            rationale="B rationale",
            evidence_ids=["evt-2"],
        )
        snap_a = SemanticSnapshot(
            holding_id="h_a",
            symbol="A",
            semantic_score=0.4,
            event_pressure_level="watch",
            semantic_drivers=[driver_a],
            linked_event_ids=["evt-1"],
            confidence=0.7,
            as_of=as_of,
        )
        snap_b = SemanticSnapshot(
            holding_id="h_b",
            symbol="B",
            semantic_score=0.3,
            event_pressure_level="watch",
            semantic_drivers=[driver_b],
            linked_event_ids=["evt-2"],
            confidence=0.7,
            as_of=as_of,
        )
        rollup = rollup_portfolio(
            "port_x",
            {"h_a": 0.5, "h_b": 0.5},
            [snap_a, snap_b],
            as_of=as_of,
        )
        usa_drivers = [d for d in rollup.top_drivers if d.node_id == "country:USA"]
        assert len(usa_drivers) == 1
        merged = usa_drivers[0]
        assert merged.contribution == pytest.approx(0.7, abs=1e-3)
        assert "evt-1" in merged.evidence_ids
        assert "evt-2" in merged.evidence_ids

    def test_contributing_event_count_deduplicates(self) -> None:
        as_of = NOW
        snap_a = SemanticSnapshot(
            holding_id="h_a",
            symbol="A",
            semantic_score=0.4,
            event_pressure_level="watch",
            semantic_drivers=[],
            linked_event_ids=["evt-shared", "evt-a-only"],
            confidence=0.7,
            as_of=as_of,
        )
        snap_b = SemanticSnapshot(
            holding_id="h_b",
            symbol="B",
            semantic_score=0.4,
            event_pressure_level="watch",
            semantic_drivers=[],
            linked_event_ids=["evt-shared", "evt-b-only"],
            confidence=0.7,
            as_of=as_of,
        )
        rollup = rollup_portfolio(
            "port_x",
            {"h_a": 0.5, "h_b": 0.5},
            [snap_a, snap_b],
            as_of=as_of,
        )
        # Three distinct ids overall (evt-shared, evt-a-only, evt-b-only).
        assert rollup.contributing_event_count == 3

    def test_zero_weights_falls_back_to_even_split(self) -> None:
        as_of = NOW
        snap_a = SemanticSnapshot(
            holding_id="h_a",
            symbol="A",
            semantic_score=0.8,
            as_of=as_of,
        )
        snap_b = SemanticSnapshot(
            holding_id="h_b",
            symbol="B",
            semantic_score=0.2,
            as_of=as_of,
        )
        rollup = rollup_portfolio(
            "port_x",
            {"h_a": 0.0, "h_b": 0.0},
            [snap_a, snap_b],
            as_of=as_of,
        )
        assert rollup.semantic_score == pytest.approx(0.5, abs=1e-3)


def test_recency_half_life_is_one_week() -> None:
    assert RECENCY_HALF_LIFE_HOURS == 168.0
