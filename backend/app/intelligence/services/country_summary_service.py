"""Country summary service.

Given the current canonical event store, this computes a per-country
:class:`CountrySignalSummary` suitable for the analyst overlay:

* aggregated watch score (0..1) with severity label
* delta versus the prior snapshot
* top contributing signals
* category breakdown
* overall confidence derived from contributing source reliability

The service is intentionally explainable — every score comes from a small,
weighted combination of the events themselves. No hidden ML, no opaque
magic numbers; weights are named constants and tunable.
"""

from __future__ import annotations

import logging
import statistics
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Iterable, Sequence

from app.intelligence.adapters.country_lookup import CountryMeta, list_countries, lookup_by_alpha3
from app.intelligence.schemas import (
    CountrySignalSummary,
    SignalCategory,
    SignalEvent,
    SignalSeverity,
    SourceRef,
)


logger = logging.getLogger(__name__)


_CATEGORY_WEIGHT: dict[SignalCategory, float] = {
    "weather": 1.0,
    "news": 0.75,
    "flights": 0.9,
    "conflict": 1.1,
    "health": 0.95,
    "mood": 0.35,
    "markets": 0.8,
    "other": 0.5,
}

_TOP_SIGNALS_LIMIT = 5


@dataclass(slots=True, frozen=True)
class SummaryInputs:
    """Events grouped and ready to be summarized."""

    country: CountryMeta
    events: list[SignalEvent]


class CountrySummaryService:
    """Build :class:`CountrySignalSummary` objects from canonical events."""

    def __init__(self, *, top_signals_limit: int = _TOP_SIGNALS_LIMIT) -> None:
        self._top_signals_limit = top_signals_limit

    def build_all(
        self,
        events: Iterable[SignalEvent],
        *,
        prior: dict[str, CountrySignalSummary] | None = None,
        now: datetime | None = None,
    ) -> list[CountrySignalSummary]:
        timestamp = now or datetime.now(timezone.utc)
        by_country = self._group_by_country(events)
        summaries: list[CountrySignalSummary] = []
        for country, bucket in by_country.items():
            summary = self._build_one(
                country=country,
                events=bucket,
                prior=(prior or {}).get(country.code),
                now=timestamp,
            )
            summaries.append(summary)
        summaries.sort(key=lambda s: s.watch_score, reverse=True)
        return summaries

    def build_one(
        self,
        country_code: str,
        events: Iterable[SignalEvent],
        *,
        prior: CountrySignalSummary | None = None,
        now: datetime | None = None,
    ) -> CountrySignalSummary | None:
        country = lookup_by_alpha3(country_code)
        if country is None:
            return None
        filtered = [e for e in events if (e.place.country_code or "").upper() == country.code]
        return self._build_one(
            country=country,
            events=filtered,
            prior=prior,
            now=now or datetime.now(timezone.utc),
        )

    # --- internals -----------------------------------------------------

    def _group_by_country(
        self, events: Iterable[SignalEvent]
    ) -> dict[CountryMeta, list[SignalEvent]]:
        buckets: dict[CountryMeta, list[SignalEvent]] = defaultdict(list)
        for event in events:
            code = (event.place.country_code or "").upper()
            if not code:
                continue
            country = lookup_by_alpha3(code)
            if country is None:
                continue
            buckets[country].append(event)
        return buckets

    def _build_one(
        self,
        *,
        country: CountryMeta,
        events: Sequence[SignalEvent],
        prior: CountrySignalSummary | None,
        now: datetime,
    ) -> CountrySignalSummary:
        counts = Counter(e.type for e in events)
        watch_score = self._score(events)
        watch_label = self._label(watch_score)
        watch_delta = watch_score - (prior.watch_score if prior else 0.0)

        confidence = self._confidence(events)
        top_signals = self._pick_top(events)
        sources = self._collect_sources(top_signals)

        summary_sentence = self._summary_text(country, events, watch_label, watch_score)

        return CountrySignalSummary(
            country_code=country.code,
            country_name=country.name,
            updated_at=now,
            watch_score=round(watch_score, 4),
            watch_delta=round(watch_delta, 4),
            watch_label=watch_label,
            counts_by_category={category: int(counts.get(category, 0)) for category in counts},
            top_signals=top_signals,
            headline_signal_id=top_signals[0].id if top_signals else None,
            confidence=round(confidence, 4),
            sources=sources,
            summary=summary_sentence,
        )

    def _score(self, events: Sequence[SignalEvent]) -> float:
        if not events:
            return 0.0
        weighted = 0.0
        weight_total = 0.0
        for event in events:
            weight = _CATEGORY_WEIGHT.get(event.type, 0.5) * (0.5 + 0.5 * event.confidence)
            weighted += event.severity_score * weight
            weight_total += weight
        if weight_total == 0:
            return 0.0
        return max(0.0, min(1.0, weighted / weight_total))

    @staticmethod
    def _label(score: float) -> SignalSeverity:
        if score >= 0.75:
            return "critical"
        if score >= 0.55:
            return "elevated"
        if score >= 0.35:
            return "watch"
        return "info"

    @staticmethod
    def _confidence(events: Sequence[SignalEvent]) -> float:
        if not events:
            return 0.0
        reliabilities: list[float] = []
        for event in events:
            if event.sources:
                reliabilities.append(statistics.fmean(s.reliability for s in event.sources))
            else:
                reliabilities.append(event.confidence)
        base = statistics.fmean(reliabilities) if reliabilities else 0.0
        # More independent sources -> higher confidence, capped.
        source_bonus = min(0.2, 0.02 * sum(len(e.sources) for e in events))
        return max(0.0, min(1.0, base + source_bonus))

    def _pick_top(self, events: Sequence[SignalEvent]) -> list[SignalEvent]:
        ranked = sorted(
            events,
            key=lambda e: (
                e.severity_score,
                e.confidence,
                (e.source_timestamp or e.ingested_at or datetime.now(timezone.utc)).timestamp(),
            ),
            reverse=True,
        )
        return ranked[: self._top_signals_limit]

    @staticmethod
    def _collect_sources(events: Sequence[SignalEvent]) -> list[SourceRef]:
        collected: list[SourceRef] = []
        seen: set[tuple[str, str, str | None]] = set()
        for event in events:
            for src in event.sources:
                key = (src.adapter, src.provider, src.provider_event_id)
                if key in seen:
                    continue
                seen.add(key)
                collected.append(src)
        return collected

    @staticmethod
    def _summary_text(
        country: CountryMeta,
        events: Sequence[SignalEvent],
        label: SignalSeverity,
        score: float,
    ) -> str:
        if not events:
            return f"{country.name}: no active signals observed."
        per_category = Counter(e.type for e in events)
        fragments = [f"{count} {cat}" for cat, count in per_category.most_common(3)]
        return (
            f"{country.name}: {label} posture (score {score:.2f}). "
            f"Active signals — {', '.join(fragments)}."
        )


def country_codes_of_interest() -> tuple[str, ...]:
    """Small helper used by the ingest service to prime summaries for known countries."""

    return tuple(c.code for c in list_countries())


__all__ = ["CountrySummaryService", "SummaryInputs", "country_codes_of_interest"]
