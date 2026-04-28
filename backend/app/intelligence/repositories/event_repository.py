"""Event repository abstraction.

Phase 11 ships an in-memory implementation that is production-shaped but
safe for local dev without Postgres/Redis. The :class:`EventRepository`
protocol defines the surface so later phases can bolt on:

* Redis-backed hot cache for recent events
* Postgres/PostGIS-backed persistent store with bbox + time queries

Dedupe and country-summary services depend only on the protocol, not on any
concrete backing store.
"""

from __future__ import annotations

import asyncio
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Iterable, Protocol

from app.intelligence.schemas import (
    CountrySignalSummary,
    SignalCategory,
    SignalEvent,
)


@dataclass(slots=True)
class EventQuery:
    categories: tuple[SignalCategory, ...] | None = None
    country_code: str | None = None
    since: datetime | None = None
    until: datetime | None = None
    bbox: tuple[float, float, float, float] | None = None  # west, south, east, north
    text: str | None = None
    limit: int = 50


class EventRepository(Protocol):
    """Protocol satisfied by every concrete repository."""

    async def upsert_many(self, events: Iterable[SignalEvent]) -> int: ...

    async def query(self, query: EventQuery) -> list[SignalEvent]: ...

    async def get(self, event_id: str) -> SignalEvent | None: ...

    async def latest(
        self,
        *,
        limit: int = 50,
        categories: tuple[SignalCategory, ...] | None = None,
    ) -> list[SignalEvent]: ...

    async def by_country(
        self,
        country_code: str,
        *,
        limit: int = 50,
    ) -> list[SignalEvent]: ...

    async def upsert_country_summary(self, summary: CountrySignalSummary) -> None: ...

    async def get_country_summary(self, country_code: str) -> CountrySignalSummary | None: ...

    async def prune_stale(self, ttl: timedelta) -> int: ...


class InMemoryEventRepository:
    """Thread-safe in-memory implementation of :class:`EventRepository`.

    Uses per-category bounded stores so ingestion churn never unboundedly
    grows. Async locks keep concurrent ingest + API reads consistent.
    """

    def __init__(self, *, max_per_category: int = 500) -> None:
        self._events: dict[str, SignalEvent] = {}
        self._by_category: dict[SignalCategory, list[str]] = defaultdict(list)
        self._by_country: dict[str, list[str]] = defaultdict(list)
        self._summaries: dict[str, CountrySignalSummary] = {}
        self._max_per_category = max_per_category
        self._lock = asyncio.Lock()

    async def upsert_many(self, events: Iterable[SignalEvent]) -> int:
        count = 0
        async with self._lock:
            for event in events:
                self._events[event.id] = event
                if event.id not in self._by_category[event.type]:
                    self._by_category[event.type].append(event.id)
                country = (event.place.country_code or "").upper()
                if country and event.id not in self._by_country[country]:
                    self._by_country[country].append(event.id)
                count += 1
            self._enforce_limits_locked()
        return count

    async def query(self, query: EventQuery) -> list[SignalEvent]:
        async with self._lock:
            candidates: list[SignalEvent] = list(self._events.values())

        def matches(event: SignalEvent) -> bool:
            if query.categories and event.type not in query.categories:
                return False
            if query.country_code and (
                (event.place.country_code or "").upper() != query.country_code.upper()
            ):
                return False
            ts = event.source_timestamp or event.ingested_at
            if query.since and ts < query.since:
                return False
            if query.until and ts > query.until:
                return False
            if query.bbox:
                west, south, east, north = query.bbox
                lat = event.place.latitude
                lon = event.place.longitude
                if lat is None or lon is None:
                    return False
                if not (south <= lat <= north and west <= lon <= east):
                    return False
            if query.text:
                needle = query.text.lower()
                haystack = " ".join(
                    [event.title or "", event.summary or "", event.description or ""]
                ).lower()
                if needle not in haystack:
                    return False
            return True

        filtered = [event for event in candidates if matches(event)]
        filtered.sort(
            key=lambda e: (e.source_timestamp or e.ingested_at),
            reverse=True,
        )
        return filtered[: max(1, query.limit)]

    async def get(self, event_id: str) -> SignalEvent | None:
        async with self._lock:
            return self._events.get(event_id)

    async def latest(
        self,
        *,
        limit: int = 50,
        categories: tuple[SignalCategory, ...] | None = None,
    ) -> list[SignalEvent]:
        return await self.query(
            EventQuery(categories=categories, limit=limit)
        )

    async def by_country(
        self,
        country_code: str,
        *,
        limit: int = 50,
    ) -> list[SignalEvent]:
        return await self.query(EventQuery(country_code=country_code, limit=limit))

    async def upsert_country_summary(self, summary: CountrySignalSummary) -> None:
        async with self._lock:
            self._summaries[summary.country_code.upper()] = summary

    async def get_country_summary(self, country_code: str) -> CountrySignalSummary | None:
        async with self._lock:
            return self._summaries.get(country_code.upper())

    async def prune_stale(self, ttl: timedelta) -> int:
        now = datetime.now(timezone.utc)
        removed = 0
        async with self._lock:
            keep: dict[str, SignalEvent] = {}
            for event in self._events.values():
                if event.is_stale(ttl=ttl, now=now):
                    removed += 1
                    continue
                keep[event.id] = event
            if removed:
                self._events = keep
                self._rebuild_indexes_locked()
        return removed

    def _enforce_limits_locked(self) -> None:
        for category, ids in self._by_category.items():
            if len(ids) <= self._max_per_category:
                continue
            excess = len(ids) - self._max_per_category
            # drop oldest by ingested_at
            ordered = sorted(
                ids,
                key=lambda _id: self._events[_id].ingested_at,
            )
            to_drop = set(ordered[:excess])
            self._by_category[category] = [i for i in ids if i not in to_drop]
            for event_id in to_drop:
                self._events.pop(event_id, None)
        self._rebuild_indexes_locked()

    def _rebuild_indexes_locked(self) -> None:
        self._by_category = defaultdict(list)
        self._by_country = defaultdict(list)
        for event in self._events.values():
            self._by_category[event.type].append(event.id)
            country = (event.place.country_code or "").upper()
            if country:
                self._by_country[country].append(event.id)


@dataclass(slots=True)
class RepositorySnapshot:
    """Snapshot model used by the /health endpoint."""

    total_events: int
    per_category: dict[SignalCategory, int] = field(default_factory=dict)
