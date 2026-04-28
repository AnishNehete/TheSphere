"""Phase 13B.4 — Pure risk engine fixture tests.

Covers the six components, documented weight blending, driver ranking
with evidence, delta-vs-baseline helper, and the build_risk_score
orchestrator.
"""

from __future__ import annotations

from datetime import datetime, timezone

import pytest

from app.intelligence.portfolio.risk.engine import (
    BASELINE_WINDOW,
    DEFAULT_COMPONENT_WEIGHTS,
    MIN_BASELINE_SAMPLES,
    blend_to_risk_score,
    build_risk_score,
    compute_bucket_severity,
    compute_concentration,
    compute_event_severity,
    compute_fx,
    compute_semantic_density,
    delta_vs_baseline,
    rank_drivers,
)
from app.intelligence.portfolio.risk.schemas import RiskScoreComponents
from app.intelligence.portfolio.schemas import (
    ExposureBucket,
    ExposureNode,
    Holding,
    PortfolioExposureSummary,
    PortfolioLinkedEvent,
)
from app.intelligence.portfolio.semantic.schemas import (
    PortfolioSemanticRollup,
    SemanticDriver,
)


NOW = datetime(2026, 4, 23, 12, 0, tzinfo=timezone.utc)


# ---------------------------------------------------------------------------
# fixtures
# ---------------------------------------------------------------------------


def _holding(holding_id: str, weight: float, symbol: str = "X") -> Holding:
    return Holding(
        id=holding_id,
        portfolio_id="port_test",
        symbol=symbol,
        weight=weight,
    )


def _currency_bucket(label: str, weight: float) -> ExposureBucket:
    return ExposureBucket(
        node=ExposureNode(
            id=f"currency:{label}",
            domain="currency",
            label=label,
            country_code=None,
        ),
        weight=weight,
        confidence=0.9,
    )


def _commodity_bucket(label: str, weight: float) -> ExposureBucket:
    return ExposureBucket(
        node=ExposureNode(
            id=f"commodity:{label.lower()}",
            domain="commodity",
            label=label,
            country_code=None,
        ),
        weight=weight,
        confidence=0.9,
    )


def _chokepoint_bucket(label: str, weight: float) -> ExposureBucket:
    return ExposureBucket(
        node=ExposureNode(
            id=f"chokepoint:{label.lower()}",
            domain="chokepoint",
            label=label,
            country_code=None,
        ),
        weight=weight,
        confidence=0.9,
    )


def _linked_event(
    event_id: str,
    severity_score: float = 0.7,
    nodes: list[str] | None = None,
) -> PortfolioLinkedEvent:
    return PortfolioLinkedEvent(
        event_id=event_id,
        title=f"Event {event_id}",
        type="news",
        severity="elevated",
        severity_score=severity_score,
        country_code="USA",
        country_name="United States",
        source_timestamp=NOW,
        matched_exposure_node_ids=list(nodes or []),
    )


def _summary(
    *,
    currencies: list[ExposureBucket] | None = None,
    commodities: list[ExposureBucket] | None = None,
    chokepoints: list[ExposureBucket] | None = None,
) -> PortfolioExposureSummary:
    return PortfolioExposureSummary(
        countries=[],
        sectors=[],
        currencies=list(currencies or []),
        commodities=list(commodities or []),
        macro_themes=[],
        chokepoints=list(chokepoints or []),
    )


# ---------------------------------------------------------------------------
# concentration
# ---------------------------------------------------------------------------


class TestComputeConcentration:
    def test_single_holding_full_concentration(self) -> None:
        assert compute_concentration([_holding("h1", 1.0)]) == pytest.approx(
            1.0, abs=1e-9
        )

    def test_even_split_ten_holdings(self) -> None:
        holdings = [_holding(f"h{i}", 0.1) for i in range(10)]
        assert compute_concentration(holdings) == pytest.approx(0.1, abs=1e-6)

    def test_even_split_five_holdings(self) -> None:
        holdings = [_holding(f"h{i}", 0.2) for i in range(5)]
        assert compute_concentration(holdings) == pytest.approx(0.2, abs=1e-6)

    def test_empty_portfolio_returns_zero(self) -> None:
        assert compute_concentration([]) == 0.0

    def test_partial_weights_are_renormalized(self) -> None:
        # Two holdings that don't sum to 1.0 should still normalize cleanly
        # to the two-even case: H = 0.5.
        holdings = [_holding("a", 0.25), _holding("b", 0.25)]
        assert compute_concentration(holdings) == pytest.approx(0.5, abs=1e-6)

    def test_zero_total_weight_returns_zero(self) -> None:
        holdings = [_holding("a", 0.0), _holding("b", 0.0)]
        assert compute_concentration(holdings) == 0.0


# ---------------------------------------------------------------------------
# fx
# ---------------------------------------------------------------------------


class TestComputeFx:
    def test_all_usd_returns_zero(self) -> None:
        summary = _summary(currencies=[_currency_bucket("USD", 1.0)])
        assert compute_fx(summary) == 0.0

    def test_even_two_currencies_returns_half(self) -> None:
        summary = _summary(
            currencies=[
                _currency_bucket("USD", 0.5),
                _currency_bucket("EUR", 0.5),
            ]
        )
        assert compute_fx(summary) == pytest.approx(0.5, abs=1e-6)

    def test_even_four_currencies_returns_three_quarters(self) -> None:
        summary = _summary(
            currencies=[_currency_bucket(c, 0.25) for c in ("USD", "EUR", "JPY", "GBP")]
        )
        assert compute_fx(summary) == pytest.approx(0.75, abs=1e-6)

    def test_empty_currencies_returns_zero(self) -> None:
        summary = _summary(currencies=[])
        assert compute_fx(summary) == 0.0


# ---------------------------------------------------------------------------
# bucket severity
# ---------------------------------------------------------------------------


class TestBucketSeverity:
    def test_matching_label_contributes(self) -> None:
        buckets = [_commodity_bucket("Oil", 0.4)]
        severity_map = {"Oil": 0.5}
        value, matched = compute_bucket_severity(buckets, severity_map)
        assert value == pytest.approx(0.2, abs=1e-6)
        assert matched == ["commodity:oil"]

    def test_unmatched_label_skipped(self) -> None:
        buckets = [_commodity_bucket("Gold", 0.5)]
        value, matched = compute_bucket_severity(buckets, {"Oil": 0.5})
        assert value == 0.0
        assert matched == []

    def test_contribution_capped_at_one(self) -> None:
        buckets = [_commodity_bucket("Oil", 0.8)]
        value, _matched = compute_bucket_severity(buckets, {"Oil": 2.0})
        assert value == 1.0

    def test_multi_bucket_sums_then_caps(self) -> None:
        buckets = [
            _commodity_bucket("Oil", 0.3),
            _commodity_bucket("Gas", 0.4),
        ]
        value, matched = compute_bucket_severity(
            buckets, {"Oil": 0.5, "Gas": 0.5}
        )
        assert value == pytest.approx(0.35, abs=1e-6)
        assert "commodity:oil" in matched
        assert "commodity:gas" in matched


# ---------------------------------------------------------------------------
# event severity
# ---------------------------------------------------------------------------


class TestEventSeverity:
    def test_mean_severity_times_coverage(self) -> None:
        events = [
            _linked_event("e1", severity_score=0.6),
            _linked_event("e2", severity_score=0.4),
            _linked_event("e3", severity_score=0.8),
        ]
        # mean 0.6 × coverage 0.5 = 0.3
        value = compute_event_severity(events, weight_coverage=0.5)
        assert value == pytest.approx(0.3, abs=1e-6)

    def test_empty_events_returns_zero(self) -> None:
        assert compute_event_severity([], weight_coverage=1.0) == 0.0

    def test_coverage_clamped_to_unit(self) -> None:
        events = [_linked_event("e1", severity_score=0.4)]
        assert compute_event_severity(events, weight_coverage=5.0) == pytest.approx(
            0.4, abs=1e-6
        )


# ---------------------------------------------------------------------------
# semantic density
# ---------------------------------------------------------------------------


class TestSemanticDensity:
    def test_none_rollup_returns_zero(self) -> None:
        assert compute_semantic_density(None) == 0.0

    def test_passthrough_rollup_score(self) -> None:
        rollup = PortfolioSemanticRollup(
            portfolio_id="p1",
            semantic_score=0.42,
            event_pressure_level="watch",
            top_drivers=[],
            contributing_event_count=3,
            as_of=NOW,
            confidence=0.5,
        )
        assert compute_semantic_density(rollup) == pytest.approx(0.42, abs=1e-6)


# ---------------------------------------------------------------------------
# blend
# ---------------------------------------------------------------------------


class TestBlendToRiskScore:
    def test_all_zero_components_returns_zero(self) -> None:
        components = RiskScoreComponents(
            concentration=0.0,
            fx=0.0,
            commodity=0.0,
            chokepoint=0.0,
            event_severity=0.0,
            semantic_density=0.0,
        )
        assert blend_to_risk_score(components) == 0.0

    def test_all_one_components_returns_one_hundred(self) -> None:
        components = RiskScoreComponents(
            concentration=1.0,
            fx=1.0,
            commodity=1.0,
            chokepoint=1.0,
            event_severity=1.0,
            semantic_density=1.0,
        )
        assert blend_to_risk_score(components) == pytest.approx(100.0, abs=1e-6)

    def test_weight_sum_matches_documentation(self) -> None:
        assert abs(sum(DEFAULT_COMPONENT_WEIGHTS.values()) - 1.0) < 1e-9

    def test_weighted_sum_matches_hand_computation(self) -> None:
        components = RiskScoreComponents(
            concentration=0.5,
            fx=0.4,
            commodity=0.6,
            chokepoint=0.2,
            event_severity=0.8,
            semantic_density=0.3,
        )
        # 0.5*.15 + 0.4*.10 + 0.6*.15 + 0.2*.15 + 0.8*.25 + 0.3*.20
        # = 0.075 + 0.04 + 0.09 + 0.03 + 0.2 + 0.06 = 0.495
        expected = 49.5
        assert blend_to_risk_score(components) == pytest.approx(expected, abs=1e-6)


# ---------------------------------------------------------------------------
# delta-vs-baseline
# ---------------------------------------------------------------------------


class TestDeltaVsBaseline:
    def test_fewer_than_three_samples_returns_zero_and_note(self) -> None:
        delta, note = delta_vs_baseline(55.0, [45.0, 50.0])
        assert delta == 0.0
        assert note is not None
        assert "baseline" in note.lower()

    def test_three_or_more_samples_uses_median(self) -> None:
        delta, note = delta_vs_baseline(55.0, [40.0, 50.0, 60.0])
        assert delta == pytest.approx(5.0, abs=1e-6)
        assert note is None

    def test_uses_last_seven_samples_only(self) -> None:
        baseline = [100.0, 100.0, 100.0] + [40.0] * 7
        delta, note = delta_vs_baseline(50.0, baseline)
        # Last 7 are all 40 => median 40 => delta 10
        assert delta == pytest.approx(10.0, abs=1e-6)
        assert note is None

    def test_exactly_min_samples(self) -> None:
        assert MIN_BASELINE_SAMPLES == 3
        assert BASELINE_WINDOW == 7
        delta, note = delta_vs_baseline(30.0, [20.0, 30.0, 40.0])
        assert delta == 0.0
        assert note is None


# ---------------------------------------------------------------------------
# rank_drivers + build_risk_score
# ---------------------------------------------------------------------------


class TestRankDriversAndBuild:
    def test_drivers_sorted_by_contribution_desc(self) -> None:
        components = RiskScoreComponents(
            concentration=0.5,
            fx=0.0,
            commodity=0.0,
            chokepoint=0.0,
            event_severity=1.0,
            semantic_density=0.1,
        )
        drivers = rank_drivers(
            components,
            weights=DEFAULT_COMPONENT_WEIGHTS,
            rationales={k: k for k in DEFAULT_COMPONENT_WEIGHTS},
            evidence={},
        )
        # event_severity: 1.0 * 0.25 = 0.25  (highest)
        # concentration: 0.5 * 0.15 = 0.075
        # semantic_density: 0.1 * 0.20 = 0.02
        assert [d.component for d in drivers] == [
            "event_severity",
            "concentration",
            "semantic_density",
        ]

    def test_zero_components_excluded_from_drivers(self) -> None:
        components = RiskScoreComponents(
            concentration=0.5,
            fx=0.0,
            commodity=0.0,
            chokepoint=0.0,
            event_severity=0.0,
            semantic_density=0.0,
        )
        drivers = rank_drivers(
            components,
            weights=DEFAULT_COMPONENT_WEIGHTS,
            rationales={k: k for k in DEFAULT_COMPONENT_WEIGHTS},
            evidence={},
        )
        assert len(drivers) == 1
        assert drivers[0].component == "concentration"

    def test_evidence_ids_capped_to_eight(self) -> None:
        components = RiskScoreComponents(
            concentration=0.0,
            fx=0.0,
            commodity=0.0,
            chokepoint=0.0,
            event_severity=0.8,
            semantic_density=0.0,
        )
        evidence = {"event_severity": [f"e{i}" for i in range(20)]}
        drivers = rank_drivers(
            components,
            weights=DEFAULT_COMPONENT_WEIGHTS,
            rationales={k: k for k in DEFAULT_COMPONENT_WEIGHTS},
            evidence=evidence,
        )
        assert len(drivers) == 1
        assert len(drivers[0].evidence_ids) == 8

    def test_build_risk_score_with_known_inputs_produces_expected_score(self) -> None:
        # Three-holding portfolio, USA-heavy, one linked event, mild semantic.
        holdings = [
            _holding("h1", 0.5, "AAPL"),
            _holding("h2", 0.3, "MSFT"),
            _holding("h3", 0.2, "JPM"),
        ]
        # concentration H = 0.25 + 0.09 + 0.04 = 0.38
        summary = _summary(
            currencies=[
                _currency_bucket("USD", 0.8),
                _currency_bucket("EUR", 0.2),
            ],
            commodities=[_commodity_bucket("Oil", 0.3)],
            chokepoints=[_chokepoint_bucket("Suez", 0.2)],
        )
        # fx = 1 - (0.64 + 0.04) = 0.32
        events = [
            _linked_event("e1", severity_score=0.7, nodes=["country:USA"]),
            _linked_event("e2", severity_score=0.6, nodes=["country:USA"]),
        ]
        # event_severity: mean 0.65 × coverage (2/12 = 0.1667) = 0.1083
        rollup = PortfolioSemanticRollup(
            portfolio_id="p1",
            semantic_score=0.3,
            event_pressure_level="watch",
            top_drivers=[
                SemanticDriver(
                    node_id="country:USA",
                    label="USA",
                    contribution=0.3,
                    rationale="2 event(s) via country:USA",
                    evidence_ids=["e1", "e2"],
                ),
            ],
            contributing_event_count=2,
            as_of=NOW,
            confidence=0.5,
        )
        result = build_risk_score(
            "port_test",
            holdings=holdings,
            exposure_summary=summary,
            linked_events=events,
            semantic_rollup=rollup,
            severity_by_commodity={"Oil": 0.5},      # 0.3 * 0.5 = 0.15
            severity_by_chokepoint={"Suez": 0.4},    # 0.2 * 0.4 = 0.08
            baseline_scores=[],
            confidence_hint=0.6,
            freshness_seconds=300,
            as_of=NOW,
        )
        # Hand-compute:
        # concentration 0.38 * 0.15 = 0.057
        # fx 0.32 * 0.10 = 0.032
        # commodity 0.15 * 0.15 = 0.0225
        # chokepoint 0.08 * 0.15 = 0.012
        # event_severity 0.108333 * 0.25 = 0.027083
        # semantic 0.3 * 0.20 = 0.060
        # sum ≈ 0.2108  → score ≈ 21.08
        assert result.risk_score == pytest.approx(21.08, abs=0.5)
        assert result.portfolio_id == "port_test"
        assert result.as_of == NOW
        assert result.freshness_seconds == 300
        # Drivers must be non-empty and sorted desc.
        assert len(result.drivers) > 0
        weights = [d.weight for d in result.drivers]
        assert weights == sorted(weights, reverse=True)
        # Baseline note present (empty history).
        assert any("Baseline" in n for n in result.notes)
        # delta == 0 under empty baseline.
        assert result.delta_vs_baseline == 0.0
        # Tilt fields: no technical/semantic inputs => insufficient alignment,
        # score fields None (Plan 06 always populates signal_alignment).
        assert result.bullish_tilt_score is None
        assert result.bearish_tilt_score is None
        assert result.signal_alignment == "insufficient"

    def test_event_severity_driver_cites_event_ids(self) -> None:
        holdings = [_holding("h1", 1.0, "AAPL")]
        summary = _summary()
        events = [_linked_event("e1"), _linked_event("e2"), _linked_event("e3")]
        result = build_risk_score(
            "port_test",
            holdings=holdings,
            exposure_summary=summary,
            linked_events=events,
            semantic_rollup=None,
            as_of=NOW,
        )
        event_drivers = [d for d in result.drivers if d.component == "event_severity"]
        assert event_drivers
        cited = set(event_drivers[0].evidence_ids)
        assert {"e1", "e2", "e3"}.issubset(cited)

    def test_empty_inputs_produce_drivers_empty_plus_note(self) -> None:
        result = build_risk_score(
            "port_test",
            holdings=[],
            exposure_summary=_summary(),
            linked_events=[],
            semantic_rollup=None,
            as_of=NOW,
        )
        assert result.risk_score == 0.0
        assert result.drivers == []
        assert any(
            "nothing is driving risk" in n.lower() for n in result.notes
        )

    def test_concentration_only_portfolio_still_emits_driver_and_notes(self) -> None:
        result = build_risk_score(
            "port_test",
            holdings=[_holding("h1", 1.0, "AAPL")],
            exposure_summary=_summary(),
            linked_events=[],
            semantic_rollup=None,
            as_of=NOW,
        )
        # concentration = 1.0 → 1.0 * 0.15 * 100 = 15.0
        assert result.risk_score == pytest.approx(15.0, abs=1e-6)
        assert [d.component for d in result.drivers] == ["concentration"]
        # Zero-component notes should be surfaced for every 0 component.
        zero_notes = [n for n in result.notes if "= 0" in n]
        assert len(zero_notes) == 5  # fx + commodity + chokepoint + event + semantic

    def test_score_bounded_to_100(self) -> None:
        components = RiskScoreComponents(
            concentration=1.0,
            fx=1.0,
            commodity=1.0,
            chokepoint=1.0,
            event_severity=1.0,
            semantic_density=1.0,
        )
        score = blend_to_risk_score(components)
        assert 0.0 <= score <= 100.0

    def test_delta_populated_when_baseline_sufficient(self) -> None:
        holdings = [_holding("h1", 1.0, "AAPL")]
        result = build_risk_score(
            "port_test",
            holdings=holdings,
            exposure_summary=_summary(),
            linked_events=[],
            semantic_rollup=None,
            baseline_scores=[10.0, 12.0, 14.0],
            as_of=NOW,
        )
        # current 15.0, median baseline 12.0 → delta = 3.0
        assert result.delta_vs_baseline == pytest.approx(3.0, abs=0.01)
        # No baseline note this time.
        assert not any("Baseline not yet" in n for n in result.notes)

    def test_confidence_clamped_to_unit(self) -> None:
        holdings = [_holding("h1", 1.0)]
        hi = build_risk_score(
            "p",
            holdings=holdings,
            exposure_summary=_summary(),
            linked_events=[],
            semantic_rollup=None,
            confidence_hint=5.0,
            as_of=NOW,
        )
        lo = build_risk_score(
            "p",
            holdings=holdings,
            exposure_summary=_summary(),
            linked_events=[],
            semantic_rollup=None,
            confidence_hint=-1.0,
            as_of=NOW,
        )
        assert hi.confidence == 1.0
        assert lo.confidence == 0.0
