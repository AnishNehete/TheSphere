"""Tests for the deterministic time-window parser (Phase 18A.1)."""

from __future__ import annotations

from datetime import datetime, timezone

import pytest

from app.intelligence.retrieval.time_window import parse_time_window


NOW = datetime(2026, 4, 26, 12, 0, 0, tzinfo=timezone.utc)


def test_empty_query_yields_live_window() -> None:
    window = parse_time_window("", now=NOW)
    assert window.kind == "live"
    assert window.is_live
    assert window.since is None
    assert window.until is None


def test_unrecognised_query_falls_back_to_live() -> None:
    window = parse_time_window("Why is Morocco elevated?", now=NOW)
    assert window.kind == "live"


def test_last_24h_resolves_to_24h_since_window() -> None:
    # Named relative ("last 24h") is more specific than the bare delta token,
    # so it wins. The since boundary still covers the same 24h range.
    window = parse_time_window("What changed in the last 24h?", now=NOW)
    assert window.kind == "since"
    assert "24" in window.label
    assert window.since is not None
    delta_seconds = (NOW - window.since).total_seconds()
    assert 23 * 3600 <= delta_seconds <= 25 * 3600


def test_explicit_last_n_hours() -> None:
    window = parse_time_window("show events from the last 6 hours", now=NOW)
    assert window.kind == "since"
    assert window.label == "last 6 hours"
    assert window.since is not None
    assert (NOW - window.since).total_seconds() == pytest.approx(6 * 3600)


def test_last_7d_via_short_form() -> None:
    window = parse_time_window("AAPL last 7d", now=NOW)
    assert window.kind == "since"
    assert (NOW - window.since).total_seconds() == pytest.approx(7 * 86400)


def test_since_yesterday() -> None:
    window = parse_time_window("Tokyo since yesterday", now=NOW)
    assert window.kind == "since"
    assert (NOW - window.since).total_seconds() == pytest.approx(86400)


def test_today_is_calendar_window() -> None:
    window = parse_time_window("today's signals", now=NOW)
    assert window.kind == "between"
    assert window.since is not None and window.until is not None
    assert window.since.date() == NOW.date()
    assert window.until == NOW


def test_yesterday_is_full_day_in_past() -> None:
    window = parse_time_window("anything yesterday", now=NOW)
    assert window.kind == "between"
    assert window.is_historical
    assert window.since is not None and window.until is not None
    assert window.since.date() < NOW.date()


def test_as_of_specific_date() -> None:
    window = parse_time_window("status as of 2026-04-19", now=NOW)
    assert window.kind == "as_of"
    assert window.is_historical
    assert window.until is not None
    assert window.until.date().isoformat() == "2026-04-19"


def test_as_of_with_time_component() -> None:
    window = parse_time_window("japan as of 2026-04-25 18:30", now=NOW)
    assert window.kind == "as_of"
    assert window.until is not None
    assert window.until.hour == 18
    assert window.until.minute == 30


def test_at_this_time_last_week_is_historical_anchor() -> None:
    window = parse_time_window("Compare at this time last week", now=NOW)
    assert window.kind == "as_of"
    assert window.is_historical
    assert window.until is not None
    # Roughly 7 days ago.
    delta_seconds = (NOW - window.until).total_seconds()
    assert 6 * 86400 < delta_seconds < 8 * 86400


def test_what_changed_is_delta() -> None:
    window = parse_time_window("what changed in Iran", now=NOW)
    assert window.kind == "delta"
    assert window.is_delta


def test_recent_is_delta() -> None:
    window = parse_time_window("recent oil moves", now=NOW)
    assert window.kind == "delta"


def test_invalid_as_of_date_falls_back_to_live() -> None:
    window = parse_time_window("as of 9999-13-99", now=NOW)
    assert window.kind == "live"
