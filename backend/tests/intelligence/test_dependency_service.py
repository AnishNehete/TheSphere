"""Tests for rule-based dependency reasoning (Phase 12C)."""

from __future__ import annotations

from datetime import datetime, timezone

import pytest

from app.intelligence.repositories.event_repository import InMemoryEventRepository
from app.intelligence.schemas import Place, SignalEvent, SourceRef
from app.intelligence.services import DependencyService


NOW = datetime(2026, 4, 22, 12, 0, 0, tzinfo=timezone.utc)


def _event(
    *,
    event_id: str,
    type_: str,
    sub_type: str | None,
    title: str,
    country_code: str | None,
    severity_score: float = 0.7,
    properties: dict | None = None,
) -> SignalEvent:
    return SignalEvent(
        id=event_id,
        dedupe_key=event_id,
        type=type_,  # type: ignore[arg-type]
        sub_type=sub_type,
        title=title,
        summary=title,
        severity="elevated",
        severity_score=severity_score,
        confidence=0.7,
        place=Place(country_code=country_code, country_name="Japan" if country_code == "JPN" else "Egypt"),
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
        properties=properties or {},
    )


async def test_weather_seismic_event_produces_logistics_chain() -> None:
    repo = InMemoryEventRepository()
    await repo.upsert_many(
        [
            _event(
                event_id="wx-jpn-1",
                type_="weather",
                sub_type="seismic",
                title="M 6.1 earthquake near Tokyo",
                country_code="JPN",
                severity_score=0.85,
            )
        ]
    )
    service = DependencyService(repository=repo)

    response = await service.for_event("wx-jpn-1")
    assert len(response.paths) == 1
    path = response.paths[0]
    # chain: weather → logistics → supply_chain → equities
    assert [n.domain for n in path.nodes] == ["weather", "logistics", "supply_chain", "equities"]
    # each edge must carry rationale + confidence
    assert all(edge.rationale and 0.0 <= edge.confidence <= 1.0 for edge in path.edges)
    # only the first edge claims to be grounded on the focal event
    assert path.edges[0].evidence_ids == ["wx-jpn-1"]
    assert all(not edge.evidence_ids for edge in path.edges[1:])


async def test_country_endpoint_returns_ranked_paths() -> None:
    repo = InMemoryEventRepository()
    await repo.upsert_many(
        [
            _event(
                event_id="nw-egy-1",
                type_="news",
                sub_type="article",
                title="Red Sea port congestion widens container backlog",
                country_code="EGY",
                severity_score=0.72,
            ),
            _event(
                event_id="cf-egy-1",
                type_="conflict",
                sub_type=None,
                title="Conflict activity reported in Sinai",
                country_code="EGY",
                severity_score=0.8,
            ),
        ]
    )
    service = DependencyService(repository=repo)
    response = await service.for_country("EGY")
    assert response.focal_country_code == "EGY"
    assert len(response.paths) >= 2
    titles = [p.title for p in response.paths]
    assert any("shipping" in t.lower() or "logistics" in t.lower() for t in titles)
    assert any("conflict" in t.lower() for t in titles)


async def test_unknown_event_yields_empty_paths() -> None:
    repo = InMemoryEventRepository()
    service = DependencyService(repository=repo)
    response = await service.for_event("does-not-exist")
    assert response.paths == []
    assert response.focal_event_id == "does-not-exist"


async def test_event_without_template_is_skipped() -> None:
    repo = InMemoryEventRepository()
    await repo.upsert_many(
        [
            _event(
                event_id="mood-jpn",
                type_="mood",
                sub_type=None,
                title="Mood index snapshot",
                country_code="JPN",
                severity_score=0.5,
            )
        ]
    )
    service = DependencyService(repository=repo)
    response = await service.for_event("mood-jpn")
    assert response.paths == []
