"""Tests for the Compare service (Phase 12B)."""

from __future__ import annotations

from datetime import datetime, timezone

from app.intelligence.repositories.event_repository import InMemoryEventRepository
from app.intelligence.schemas import (
    CountrySignalSummary,
    Place,
    SignalEvent,
    SourceRef,
)
from app.intelligence.services import CompareRequest, CompareService


NOW = datetime(2026, 4, 22, 12, 0, 0, tzinfo=timezone.utc)


def _event(
    event_id: str,
    type_: str,
    severity: str,
    severity_score: float,
    country_code: str,
    country_name: str,
) -> SignalEvent:
    return SignalEvent(
        id=event_id,
        dedupe_key=event_id,
        type=type_,  # type: ignore[arg-type]
        title=f"{country_name} {type_} event",
        summary="",
        severity=severity,  # type: ignore[arg-type]
        severity_score=severity_score,
        confidence=0.7,
        place=Place(country_code=country_code, country_name=country_name),
        source_timestamp=NOW,
        ingested_at=NOW,
        sources=[
            SourceRef(
                adapter="test",
                provider="test",
                retrieved_at=NOW,
                source_timestamp=NOW,
                reliability=0.7,
            )
        ],
        tags=[],
    )


async def test_country_vs_country_returns_diffs_and_headline() -> None:
    repo = InMemoryEventRepository()
    jpn_events = [
        _event("jp-1", "weather", "elevated", 0.7, "JPN", "Japan"),
        _event("jp-2", "news", "watch", 0.5, "JPN", "Japan"),
    ]
    kor_events = [
        _event("kr-1", "weather", "watch", 0.4, "KOR", "South Korea"),
    ]
    await repo.upsert_many([*jpn_events, *kor_events])
    await repo.upsert_country_summary(
        CountrySignalSummary(
            country_code="JPN",
            country_name="Japan",
            updated_at=NOW,
            watch_score=0.72,
            watch_delta=0.1,
            watch_label="elevated",
            counts_by_category={"weather": 1, "news": 1},
            top_signals=jpn_events,
            headline_signal_id="jp-1",
            confidence=0.7,
            sources=[],
            summary=None,
        )
    )
    await repo.upsert_country_summary(
        CountrySignalSummary(
            country_code="KOR",
            country_name="South Korea",
            updated_at=NOW,
            watch_score=0.45,
            watch_delta=-0.05,
            watch_label="watch",
            counts_by_category={"weather": 1},
            top_signals=kor_events,
            headline_signal_id="kr-1",
            confidence=0.6,
            sources=[],
            summary=None,
        )
    )

    service = CompareService(repository=repo)
    response = await service.compare(
        [
            CompareRequest(kind="country", identifier="JPN"),
            CompareRequest(kind="country", identifier="KOR"),
        ]
    )

    assert len(response.targets) == 2
    left, right = response.targets
    assert left.country_code == "JPN"
    assert right.country_code == "KOR"
    assert left.summary is not None and right.summary is not None
    # watch_score diff must exist and carry a delta note
    score_diff = next(d for d in response.diffs if d.dimension == "watch_score")
    assert score_diff.left_value == 0.72
    assert score_diff.right_value == 0.45
    assert score_diff.delta_note and "-0.27" in score_diff.delta_note
    assert "Japan" in response.headline
    assert "South Korea" in response.headline


async def test_event_target_carries_sibling_events() -> None:
    repo = InMemoryEventRepository()
    events = [
        _event("evt-1", "weather", "critical", 0.9, "EGY", "Egypt"),
        _event("evt-2", "news", "elevated", 0.6, "EGY", "Egypt"),
    ]
    await repo.upsert_many(events)
    service = CompareService(repository=repo)
    response = await service.compare(
        [
            CompareRequest(kind="event", identifier="evt-1"),
            CompareRequest(kind="event", identifier="evt-2"),
        ]
    )
    assert len(response.targets) == 2
    for target in response.targets:
        assert target.event is not None
        assert isinstance(target.recent_events, list)


async def test_compare_caps_at_three_targets() -> None:
    repo = InMemoryEventRepository()
    await repo.upsert_many(
        [
            _event(f"evt-{i}", "news", "watch", 0.4, "USA", "United States")
            for i in range(5)
        ]
    )
    service = CompareService(repository=repo)
    requests = [CompareRequest(kind="country", identifier="USA") for _ in range(5)]
    response = await service.compare(requests)
    assert len(response.targets) <= CompareService.MAX_TARGETS


async def test_unknown_country_is_dropped() -> None:
    repo = InMemoryEventRepository()
    service = CompareService(repository=repo)
    response = await service.compare(
        [
            CompareRequest(kind="country", identifier="ZZZ"),
            CompareRequest(kind="country", identifier="JPN"),
        ]
    )
    # one resolved, one dropped
    assert len(response.targets) == 1
    assert response.targets[0].country_code == "JPN"
