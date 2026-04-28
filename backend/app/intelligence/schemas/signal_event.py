"""Canonical internal event schema for Sphere intelligence.

Every live source adapter normalizes its raw provider payload into one of these
structures. The frontend and downstream intelligence services consume only
these models — provider-specific shapes never leave the adapter layer.

Design goals:
* extensible: supports today's weather/news and tomorrow's flights, conflict,
  mood, economic, and agent-derived signals
* explainable: every record carries provenance, freshness, and confidence
* dedupe-friendly: carries stable hashes and a ``merged_from`` provenance list
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


SignalCategory = Literal[
    "weather",
    "news",
    "flights",
    "conflict",
    "health",
    "disease",
    "mood",
    "markets",
    "stocks",
    "commodities",
    "currency",
    "other",
]

SignalStatus = Literal["active", "resolved", "forecast", "stale"]

SignalSeverity = Literal["info", "watch", "elevated", "critical"]


class Place(BaseModel):
    """Geospatial + political hierarchy for a signal."""

    model_config = ConfigDict(frozen=True)

    latitude: float | None = None
    longitude: float | None = None
    country_code: str | None = Field(default=None, description="ISO-3166 alpha-3")
    country_name: str | None = None
    region: str | None = None
    admin1: str | None = None
    locality: str | None = None
    bbox: tuple[float, float, float, float] | None = Field(
        default=None,
        description="west, south, east, north",
    )


class SourceRef(BaseModel):
    """Provenance metadata for a single contributing source."""

    model_config = ConfigDict(frozen=True)

    adapter: str
    provider: str
    provider_event_id: str | None = None
    url: str | None = None
    retrieved_at: datetime
    source_timestamp: datetime | None = None
    publisher: str | None = None
    reliability: float = Field(default=0.6, ge=0.0, le=1.0)


class EventEntity(BaseModel):
    """Named entity resolved inside the event (country, city, company...)."""

    model_config = ConfigDict(frozen=True)

    entity_id: str
    entity_type: Literal[
        "country",
        "city",
        "region",
        "route",
        "facility",
        "company",
        "person",
        "topic",
        "other",
    ]
    name: str
    country_code: str | None = None
    score: float = Field(default=0.5, ge=0.0, le=1.0)


class SignalEvent(BaseModel):
    """Canonical normalized intelligence event."""

    model_config = ConfigDict(frozen=False, populate_by_name=True)

    id: str
    dedupe_key: str = Field(
        description="Stable hash-like key used by the dedupe service to merge near-duplicates.",
    )
    type: SignalCategory
    sub_type: str | None = None

    title: str
    summary: str
    description: str | None = None

    severity: SignalSeverity = "info"
    severity_score: float = Field(default=0.3, ge=0.0, le=1.0)
    confidence: float = Field(default=0.5, ge=0.0, le=1.0)
    status: SignalStatus = "active"

    place: Place = Field(default_factory=Place)

    start_time: datetime | None = None
    end_time: datetime | None = None
    source_timestamp: datetime | None = None
    ingested_at: datetime

    sources: list[SourceRef] = Field(default_factory=list)
    merged_from: list[str] = Field(
        default_factory=list,
        description="Other canonical event IDs that collapsed into this one.",
    )
    tags: list[str] = Field(default_factory=list)
    entities: list[EventEntity] = Field(default_factory=list)

    score: float | None = Field(
        default=None,
        ge=0.0,
        le=1.0,
        description="Derived attention score. None until scoring runs.",
    )

    raw_ref: dict[str, Any] | None = Field(
        default=None,
        description="Optional debug-only reference to the raw provider payload. Never surfaced to UI.",
    )
    properties: dict[str, Any] = Field(
        default_factory=dict,
        description="Extensible JSON for adapter-specific normalized extras.",
    )

    def freshness_seconds(self, *, now: datetime | None = None) -> float:
        """Return seconds since the source generated the event, clamped to >=0."""

        reference = self.source_timestamp or self.ingested_at
        if reference is None:
            return 0.0
        current = now or datetime.now(timezone.utc)
        delta = (current - reference).total_seconds()
        return max(delta, 0.0)

    def is_stale(self, *, ttl: timedelta, now: datetime | None = None) -> bool:
        return self.freshness_seconds(now=now) > ttl.total_seconds()


class CountrySignalSummary(BaseModel):
    """Aggregated intelligence snapshot for a single country."""

    model_config = ConfigDict(frozen=False)

    country_code: str
    country_name: str

    updated_at: datetime
    watch_score: float = Field(ge=0.0, le=1.0)
    watch_delta: float
    watch_label: SignalSeverity

    counts_by_category: dict[SignalCategory, int]
    top_signals: list[SignalEvent]
    headline_signal_id: str | None = None

    confidence: float = Field(ge=0.0, le=1.0)
    sources: list[SourceRef] = Field(default_factory=list)
    summary: str | None = None
