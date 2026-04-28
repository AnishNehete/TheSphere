"""Tests for the unified query planner (Phase 18A.1)."""

from __future__ import annotations

from datetime import datetime, timezone

from app.intelligence.retrieval.query_planner import QueryPlanner


NOW = datetime(2026, 4, 26, 12, 0, 0, tzinfo=timezone.utc)


def test_plain_query_yields_live_window_no_compare() -> None:
    plan = QueryPlanner().plan("Why is Morocco elevated?", now=NOW)
    assert plan.intent == "why_elevated"
    assert plan.time.is_live
    assert plan.compare.requested is False
    assert plan.needs_timeline_worker is False
    assert plan.needs_compare_worker is False


def test_what_changed_marks_delta_intent() -> None:
    plan = QueryPlanner().plan("what changed in Iran", now=NOW)
    assert plan.intent == "what_changed"
    # delta phrase wins for time
    assert plan.time.kind == "delta"
    assert plan.needs_timeline_worker is True


def test_compare_intent_routes_through_compare_worker() -> None:
    plan = QueryPlanner().plan("Compare Japan and Korea", now=NOW)
    assert plan.compare.requested is True
    assert plan.needs_compare_worker is True
    # primary text strips the compare phrase
    assert plan.primary_text.lower().startswith("japan")


def test_time_phrase_strips_from_primary_text() -> None:
    plan = QueryPlanner().plan("Tokyo signals last 24h", now=NOW)
    assert plan.time.kind == "since"
    # primary_text should no longer contain "last 24h"
    assert "last 24h" not in plan.primary_text.lower()


def test_compare_with_time_window() -> None:
    plan = QueryPlanner().plan(
        "Compare Japan vs Korea over the last 7 days", now=NOW
    )
    assert plan.compare.requested is True
    assert plan.time.kind == "since"
    assert plan.needs_timeline_worker is True
    assert plan.needs_compare_worker is True
