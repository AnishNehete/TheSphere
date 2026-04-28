"""InMemoryEventRepository behavior tests."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from app.intelligence.repositories.event_repository import (
    EventQuery,
    InMemoryEventRepository,
)
from app.intelligence.schemas import SignalEvent

from tests.intelligence.conftest import FIXED_NOW, make_event


async def test_upsert_many_inserts_and_indexes(
    empty_repo: InMemoryEventRepository,
    sample_events: list[SignalEvent],
) -> None:
    count = await empty_repo.upsert_many(sample_events)

    assert count == len(sample_events)
    for event in sample_events:
        stored = await empty_repo.get(event.id)
        assert stored is not None and stored.id == event.id


async def test_upsert_many_on_same_id_overwrites(
    empty_repo: InMemoryEventRepository,
) -> None:
    first = make_event(event_id="evt-x", title="first", country_code="USA")
    second = make_event(event_id="evt-x", title="second", country_code="USA")

    await empty_repo.upsert_many([first])
    await empty_repo.upsert_many([second])

    stored = await empty_repo.get("evt-x")
    assert stored is not None
    assert stored.title == "second"
    # indexes must not carry duplicates
    usa_events = await empty_repo.by_country("USA")
    assert [e.id for e in usa_events].count("evt-x") == 1


async def test_upsert_many_on_empty_iterable_returns_zero(
    empty_repo: InMemoryEventRepository,
) -> None:
    assert await empty_repo.upsert_many([]) == 0


async def test_latest_filters_by_category_and_limit(
    seeded_repo: InMemoryEventRepository,
) -> None:
    weather_only = await seeded_repo.latest(limit=10, categories=("weather",))
    assert [e.id for e in weather_only] == ["wx-usa-1"]

    capped = await seeded_repo.latest(limit=2)
    assert len(capped) == 2


async def test_latest_returns_events_in_descending_timestamp_order(
    empty_repo: InMemoryEventRepository,
) -> None:
    older = make_event(
        event_id="old",
        source_timestamp=FIXED_NOW - timedelta(hours=3),
    )
    newer = make_event(
        event_id="new",
        source_timestamp=FIXED_NOW,
    )
    await empty_repo.upsert_many([older, newer])

    latest = await empty_repo.latest(limit=10)
    assert [e.id for e in latest] == ["new", "old"]


async def test_by_country_matches_regardless_of_case(
    seeded_repo: InMemoryEventRepository,
) -> None:
    upper = await seeded_repo.by_country("USA")
    lower = await seeded_repo.by_country("usa")

    assert {e.id for e in upper} == {"wx-usa-1", "nw-usa-1"}
    assert {e.id for e in lower} == {"wx-usa-1", "nw-usa-1"}


async def test_by_country_returns_empty_list_for_unknown_country(
    seeded_repo: InMemoryEventRepository,
) -> None:
    assert await seeded_repo.by_country("ZZZ") == []


async def test_query_respects_text_and_country_filters(
    seeded_repo: InMemoryEventRepository,
) -> None:
    # "storm" hits wx-usa-1 ("Severe storm over Florida") AND nw-usa-1
    # (summary: "Storm-driven delays…"); JPN/UKR/SGP must be filtered out.
    hits = await seeded_repo.query(
        EventQuery(country_code="USA", text="storm", limit=10)
    )
    ids = {e.id for e in hits}
    assert ids == {"wx-usa-1", "nw-usa-1"}

    # tighter text that only wx-usa-1 carries
    focused = await seeded_repo.query(
        EventQuery(country_code="USA", text="Florida", limit=10)
    )
    assert [e.id for e in focused] == ["wx-usa-1"]


async def test_query_respects_bbox_filter(
    empty_repo: InMemoryEventRepository,
) -> None:
    inside = make_event(
        event_id="in", country_code="USA", latitude=30.0, longitude=-90.0,
    )
    outside = make_event(
        event_id="out", country_code="JPN", latitude=35.0, longitude=139.0,
    )
    await empty_repo.upsert_many([inside, outside])

    result = await empty_repo.query(
        EventQuery(bbox=(-100.0, 25.0, -80.0, 35.0), limit=10)
    )
    assert [e.id for e in result] == ["in"]


async def test_country_summary_upsert_and_get_case_insensitive(
    seeded_repo: InMemoryEventRepository,
) -> None:
    from app.intelligence.services.country_summary_service import (
        CountrySummaryService,
    )

    events = await seeded_repo.by_country("USA")
    summary = CountrySummaryService().build_one("USA", events)
    assert summary is not None

    await seeded_repo.upsert_country_summary(summary)
    round_trip = await seeded_repo.get_country_summary("usa")
    assert round_trip is not None
    assert round_trip.country_code == "USA"


async def test_prune_stale_removes_events_older_than_ttl(
    empty_repo: InMemoryEventRepository,
) -> None:
    now = datetime.now(timezone.utc)
    fresh = make_event(event_id="fresh", source_timestamp=now, ingested_at=now)
    stale = make_event(
        event_id="stale",
        source_timestamp=now - timedelta(hours=24),
        ingested_at=now - timedelta(hours=24),
    )
    await empty_repo.upsert_many([fresh, stale])

    removed = await empty_repo.prune_stale(timedelta(hours=6))

    assert removed == 1
    remaining = await empty_repo.latest(limit=10)
    assert [e.id for e in remaining] == ["fresh"]


async def test_max_per_category_evicts_oldest_when_exceeded() -> None:
    repo = InMemoryEventRepository(max_per_category=2)
    events = [
        make_event(
            event_id=f"e{i}",
            source_timestamp=FIXED_NOW,
            ingested_at=FIXED_NOW - timedelta(minutes=10 * (3 - i)),
        )
        for i in range(3)
    ]
    await repo.upsert_many(events)

    remaining = await repo.latest(limit=10)
    # oldest (e0) evicted; newest two retained
    assert {e.id for e in remaining} == {"e1", "e2"}
