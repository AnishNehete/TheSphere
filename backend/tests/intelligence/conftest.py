"""Shared fixtures for the intelligence backbone tests."""

from __future__ import annotations

import os

# Phase 19E — clear persistence URLs at IMPORT time, before any pydantic
# Settings instance reads them. The intelligence runtime now wires real
# Redis/Postgres in production, but unit tests rely on the in-memory
# fallback to avoid TestClient/async-loop issues. Doing this in a fixture
# is too late because pytest_asyncio fixtures may construct the runtime
# before sync autouse fixtures run.
os.environ.pop("INTELLIGENCE_DATABASE_URL", None)
os.environ.pop("INTELLIGENCE_REDIS_URL", None)

from datetime import datetime, timezone  # noqa: E402
from typing import Any  # noqa: E402

import pytest  # noqa: E402
import pytest_asyncio  # noqa: E402

from app.intelligence.repositories.event_repository import InMemoryEventRepository
from app.intelligence.schemas import (
    Place,
    SignalCategory,
    SignalEvent,
    SignalSeverity,
    SourceRef,
)


FIXED_NOW = datetime(2026, 4, 21, 12, 0, 0, tzinfo=timezone.utc)


def make_event(
    *,
    event_id: str = "evt-1",
    dedupe_key: str | None = None,
    category: SignalCategory = "weather",
    title: str = "Test event",
    summary: str = "Test summary",
    description: str | None = None,
    severity: SignalSeverity = "info",
    severity_score: float = 0.3,
    confidence: float = 0.5,
    country_code: str | None = None,
    country_name: str | None = None,
    latitude: float | None = None,
    longitude: float | None = None,
    source_timestamp: datetime | None = None,
    ingested_at: datetime | None = None,
    sources: list[SourceRef] | None = None,
    tags: list[str] | None = None,
    properties: dict[str, Any] | None = None,
) -> SignalEvent:
    """Factory with sensible defaults for building SignalEvents in tests."""

    ts = source_timestamp or FIXED_NOW
    default_sources = [
        SourceRef(
            adapter="test.adapter",
            provider="test",
            provider_event_id=event_id,
            retrieved_at=ts,
            source_timestamp=ts,
            publisher="unit-test",
            reliability=0.6,
        )
    ]
    return SignalEvent(
        id=event_id,
        dedupe_key=dedupe_key if dedupe_key is not None else f"dk-{event_id}",
        type=category,
        title=title,
        summary=summary,
        description=description,
        severity=severity,
        severity_score=severity_score,
        confidence=confidence,
        place=Place(
            country_code=country_code,
            country_name=country_name,
            latitude=latitude,
            longitude=longitude,
        ),
        source_timestamp=ts,
        ingested_at=ingested_at or ts,
        sources=sources if sources is not None else default_sources,
        tags=tags or [],
        properties=properties or {},
    )


@pytest.fixture
def now() -> datetime:
    return FIXED_NOW


@pytest.fixture
def sample_events() -> list[SignalEvent]:
    """Five representative events across categories and countries."""

    return [
        make_event(
            event_id="wx-usa-1",
            category="weather",
            title="Severe storm over Florida",
            summary="Flooding and wind gusts reported across the southeast.",
            severity="elevated",
            severity_score=0.7,
            confidence=0.65,
            country_code="USA",
            country_name="United States",
            latitude=27.9,
            longitude=-82.5,
            tags=["weather", "storm"],
        ),
        make_event(
            event_id="nw-usa-1",
            category="news",
            title="US airport delays amid weather",
            summary="Storm-driven delays rippling through US hubs.",
            severity="watch",
            severity_score=0.45,
            confidence=0.55,
            country_code="USA",
            country_name="United States",
            tags=["news", "airport"],
        ),
        make_event(
            event_id="fl-jpn-1",
            category="flights",
            title="JAL123 rerouted around typhoon",
            summary="Japan Airlines 123 diverted off its filed route.",
            severity="watch",
            severity_score=0.4,
            confidence=0.5,
            country_code="JPN",
            country_name="Japan",
            tags=["flights", "reroute"],
        ),
        make_event(
            event_id="cf-ukr-1",
            category="conflict",
            title="Air-defense activity near Kharkiv",
            summary="Elevated aerial activity reported in the region.",
            severity="critical",
            severity_score=0.85,
            confidence=0.6,
            country_code="UKR",
            country_name="Ukraine",
            tags=["conflict", "incident"],
        ),
        make_event(
            event_id="mo-sgp-1",
            category="mood",
            title="Country mood index: Singapore",
            summary="Singapore country-level mood index snapshot.",
            severity="info",
            severity_score=0.2,
            confidence=0.5,
            country_code="SGP",
            country_name="Singapore",
            tags=["mood", "scaffold"],
        ),
    ]


@pytest_asyncio.fixture
async def seeded_repo(sample_events: list[SignalEvent]) -> InMemoryEventRepository:
    """In-memory repository preloaded with sample events."""

    repo = InMemoryEventRepository()
    await repo.upsert_many(sample_events)
    return repo


@pytest.fixture
def empty_repo() -> InMemoryEventRepository:
    return InMemoryEventRepository()
