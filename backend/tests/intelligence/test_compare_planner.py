"""Tests for the multi-entity compare planner (Phase 18A.1)."""

from __future__ import annotations

from app.intelligence.retrieval.compare_planner import plan_compare


def test_no_compare_keyword_returns_unrequested() -> None:
    plan = plan_compare("Why is Morocco elevated?")
    assert plan.requested is False
    assert plan.targets == []
    assert plan.has_two_resolved is False
    assert plan.is_collapsed is False


def test_x_vs_y_two_country_compare() -> None:
    plan = plan_compare("Compare risk Japan vs Korea")
    assert plan.requested is True
    assert plan.mode == "vs"
    # at least 2 legs
    assert len(plan.targets) == 2
    labels = [t.label for t in plan.targets]
    # the right leg should resolve to South Korea (or Korea via gazetteer)
    assert any("Japan" in label for label in labels)
    assert any("Korea" in label for label in labels)
    assert plan.has_two_resolved


def test_compare_x_and_y_pattern() -> None:
    plan = plan_compare("compare Japan and India")
    assert plan.requested is True
    assert plan.mode == "compare"
    assert len(plan.targets) >= 2
    assert plan.has_two_resolved


def test_versus_pattern_with_tickers() -> None:
    plan = plan_compare("AAPL versus MSFT")
    assert plan.requested is True
    assert plan.mode == "vs"
    kinds = [t.kind for t in plan.targets]
    assert kinds.count("ticker") == 2


def test_compared_to_pattern() -> None:
    plan = plan_compare("Japan compared to Korea")
    assert plan.requested is True
    assert plan.mode == "compared_to"
    assert plan.has_two_resolved


def test_between_pattern() -> None:
    plan = plan_compare("between Japan and Korea")
    assert plan.requested is True
    assert plan.mode == "between"
    assert plan.has_two_resolved


def test_compare_collapses_when_one_leg_unresolved() -> None:
    plan = plan_compare("compare zzz123 vs Japan")
    assert plan.requested is True
    # Japan should resolve, zzz should not
    resolutions = [t.resolution for t in plan.targets]
    assert "none" in resolutions
    # at most one leg resolved → collapsed
    assert plan.is_collapsed is True


def test_fx_pair_does_not_double_match_as_ticker() -> None:
    plan = plan_compare("USDJPY vs EURUSD")
    assert plan.requested is True
    kinds = [t.kind for t in plan.targets]
    assert kinds == ["fx_pair", "fx_pair"]


def test_country_alias_via_alpha3() -> None:
    plan = plan_compare("USA vs GBR")
    assert plan.requested is True
    # Both should resolve as country
    resolved = [t for t in plan.targets if t.resolution != "none"]
    assert len(resolved) == 2
