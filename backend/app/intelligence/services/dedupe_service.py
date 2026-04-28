"""Dedupe service: collapse near-duplicate :class:`SignalEvent`s into canonical events.

Adapter output is intentionally lossy-by-design — providers can emit the same
underlying real-world event multiple ways (GDELT vs. USGS for a seismic story,
two different Open-Meteo samples for the same country). The dedupe service
normalizes those into one canonical event while preserving provenance via
``sources`` and ``merged_from``.

Merge strategy (in order):
1. Group candidates by ``dedupe_key`` when present.
2. Fall back to a secondary key built from ``(type, country_code, rounded_coords)``.
3. Inside each group, pick the "canonical" event using a simple priority:
   highest ``severity_score`` > highest ``confidence`` > latest timestamp > shortest id.
4. Merge non-canonical events into the canonical one: union ``sources``,
   extend ``merged_from``, union ``tags``, prefer the richer ``description``.

The service is side-effect free — it takes events in and returns events out.
"""

from __future__ import annotations

import logging
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Iterable, Sequence

from app.intelligence.schemas import SignalEvent, SourceRef


logger = logging.getLogger(__name__)


@dataclass(slots=True, frozen=True)
class DedupeStats:
    """Observability counters returned from a dedupe pass."""

    input_count: int
    output_count: int
    merged_count: int

    @property
    def reduction_ratio(self) -> float:
        if self.input_count == 0:
            return 0.0
        return 1.0 - (self.output_count / self.input_count)


class DedupeService:
    """Stateless dedupe + merge over a batch of canonical events."""

    def __init__(self, *, coord_rounding: int = 1) -> None:
        self._coord_rounding = coord_rounding

    def dedupe(
        self, events: Iterable[SignalEvent]
    ) -> tuple[list[SignalEvent], DedupeStats]:
        incoming = list(events)
        if not incoming:
            return [], DedupeStats(0, 0, 0)

        grouped: dict[str, list[SignalEvent]] = defaultdict(list)
        for event in incoming:
            grouped[self._group_key(event)].append(event)

        merged: list[SignalEvent] = []
        total_merged = 0
        for bucket in grouped.values():
            canonical = self._merge_bucket(bucket)
            merged.append(canonical)
            if len(bucket) > 1:
                total_merged += len(bucket) - 1

        merged.sort(
            key=lambda e: (e.source_timestamp or e.ingested_at),
            reverse=True,
        )
        stats = DedupeStats(
            input_count=len(incoming),
            output_count=len(merged),
            merged_count=total_merged,
        )
        logger.debug(
            "dedupe: %s -> %s (merged %s, ratio %.2f)",
            stats.input_count,
            stats.output_count,
            stats.merged_count,
            stats.reduction_ratio,
        )
        return merged, stats

    def _group_key(self, event: SignalEvent) -> str:
        if event.dedupe_key:
            return f"key::{event.dedupe_key}"
        country = (event.place.country_code or "").upper() or "-"
        lat = (
            round(event.place.latitude, self._coord_rounding)
            if event.place.latitude is not None
            else "-"
        )
        lon = (
            round(event.place.longitude, self._coord_rounding)
            if event.place.longitude is not None
            else "-"
        )
        return f"fallback::{event.type}::{country}::{lat}::{lon}::{event.title.lower()[:48]}"

    def _merge_bucket(self, bucket: Sequence[SignalEvent]) -> SignalEvent:
        if len(bucket) == 1:
            return bucket[0]

        ranked = sorted(
            bucket,
            key=lambda e: (
                e.severity_score,
                e.confidence,
                (e.source_timestamp or e.ingested_at or datetime.now(timezone.utc)).timestamp(),
                -len(e.id),
            ),
            reverse=True,
        )
        canonical = ranked[0]
        others = ranked[1:]

        sources: list[SourceRef] = list(canonical.sources)
        seen_provider_ids = {
            (s.adapter, s.provider, s.provider_event_id) for s in canonical.sources
        }
        merged_from: list[str] = list(canonical.merged_from)
        tags: list[str] = list(canonical.tags)
        description = canonical.description

        for other in others:
            for src in other.sources:
                sig = (src.adapter, src.provider, src.provider_event_id)
                if sig not in seen_provider_ids:
                    sources.append(src)
                    seen_provider_ids.add(sig)
            if other.id and other.id != canonical.id and other.id not in merged_from:
                merged_from.append(other.id)
            for tag in other.tags:
                if tag not in tags:
                    tags.append(tag)
            if (not description) and other.description:
                description = other.description

        merged = canonical.model_copy(
            update={
                "sources": sources,
                "merged_from": merged_from,
                "tags": tags,
                "description": description,
                "confidence": min(0.95, canonical.confidence + 0.05 * len(others)),
            }
        )
        return merged


__all__ = ["DedupeService", "DedupeStats"]
