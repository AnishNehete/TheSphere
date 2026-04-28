"""CountrySummaryService behavior tests."""

from __future__ import annotations

from app.intelligence.schemas import SignalEvent
from app.intelligence.services.country_summary_service import (
    CountrySummaryService,
    country_codes_of_interest,
)

from tests.intelligence.conftest import make_event


def test_empty_country_returns_zero_score_summary() -> None:
    summary = CountrySummaryService().build_one("USA", [])

    assert summary is not None
    assert summary.country_code == "USA"
    assert summary.country_name == "United States"
    assert summary.watch_score == 0.0
    assert summary.watch_delta == 0.0
    assert summary.watch_label == "info"
    assert summary.counts_by_category == {}
    assert summary.top_signals == []
    assert summary.headline_signal_id is None
    assert summary.confidence == 0.0


def test_populated_country_produces_nonzero_score(
    sample_events: list[SignalEvent],
) -> None:
    summary = CountrySummaryService().build_one("USA", sample_events)

    assert summary is not None
    assert summary.country_code == "USA"
    assert summary.watch_score > 0.0
    assert summary.confidence > 0.0


def test_counts_by_category_reflects_event_distribution(
    sample_events: list[SignalEvent],
) -> None:
    summary = CountrySummaryService().build_one("USA", sample_events)
    assert summary is not None

    # USA sample has 1 weather + 1 news event
    assert summary.counts_by_category.get("weather") == 1
    assert summary.counts_by_category.get("news") == 1
    # categories with no USA events should not appear in the dict
    assert "flights" not in summary.counts_by_category
    assert "conflict" not in summary.counts_by_category


def test_top_signal_picks_highest_severity_event(
    sample_events: list[SignalEvent],
) -> None:
    summary = CountrySummaryService().build_one("USA", sample_events)
    assert summary is not None

    assert summary.top_signals, "USA should have top signals"
    # wx-usa-1 has severity_score 0.7, higher than nw-usa-1 (0.45)
    assert summary.top_signals[0].id == "wx-usa-1"
    assert summary.headline_signal_id == "wx-usa-1"


def test_top_signals_are_capped_to_limit() -> None:
    events = [
        make_event(
            event_id=f"e{i}",
            dedupe_key=f"k{i}",
            country_code="USA",
            severity_score=0.5 + i * 0.01,
        )
        for i in range(12)
    ]

    summary = CountrySummaryService(top_signals_limit=5).build_one("USA", events)

    assert summary is not None
    assert len(summary.top_signals) == 5


def test_build_one_returns_none_for_unknown_country(
    sample_events: list[SignalEvent],
) -> None:
    assert CountrySummaryService().build_one("ZZZ", sample_events) is None


def test_build_one_filters_events_to_target_country(
    sample_events: list[SignalEvent],
) -> None:
    # sample_events includes USA, JPN, UKR, SGP — calling for UKR must ignore others
    summary = CountrySummaryService().build_one("UKR", sample_events)
    assert summary is not None

    assert summary.country_code == "UKR"
    for event in summary.top_signals:
        assert event.place.country_code == "UKR"
    assert summary.counts_by_category.get("conflict") == 1


def test_build_one_is_case_insensitive_on_country_code(
    sample_events: list[SignalEvent],
) -> None:
    upper = CountrySummaryService().build_one("USA", sample_events)
    lower = CountrySummaryService().build_one("usa", sample_events)

    assert upper is not None and lower is not None
    assert upper.watch_score == lower.watch_score
    assert upper.country_code == lower.country_code == "USA"


def test_build_all_returns_a_summary_per_country_seen(
    sample_events: list[SignalEvent],
) -> None:
    summaries = CountrySummaryService().build_all(sample_events)

    codes = {s.country_code for s in summaries}
    # sample_events cover USA, JPN, UKR, SGP
    assert codes == {"USA", "JPN", "UKR", "SGP"}
    # sorted by watch_score descending
    assert summaries == sorted(summaries, key=lambda s: s.watch_score, reverse=True)


def test_watch_delta_compares_to_prior_snapshot(
    sample_events: list[SignalEvent],
) -> None:
    service = CountrySummaryService()
    prior = service.build_one("USA", sample_events)
    assert prior is not None

    later = service.build_one("USA", sample_events, prior=prior)
    assert later is not None
    # score is stable → delta ~= 0
    assert abs(later.watch_delta) < 1e-6


def test_country_codes_of_interest_returns_known_set() -> None:
    codes = country_codes_of_interest()
    assert "USA" in codes
    assert "JPN" in codes
    assert "UKR" in codes
    # every code should be a 3-letter alpha-3
    assert all(len(code) == 3 and code.isupper() for code in codes)
