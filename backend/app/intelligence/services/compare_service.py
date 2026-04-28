"""Compare service.

Phase 12B — build a side-by-side compare payload over 2–3 targets. Each
target is either a country (summary + recent events) or an event (with its
context country's recent activity). Output includes diffs along named
dimensions so the UI can render calm, structured cards instead of a noisy
diff table.
"""

from __future__ import annotations

import logging
from collections import Counter
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Iterable, Sequence

from app.intelligence.adapters.country_lookup import lookup_by_alpha3
from app.intelligence.repositories.event_repository import EventRepository
from app.intelligence.schemas import (
    CompareDiff,
    CompareResponse,
    CompareTarget,
    CountrySignalSummary,
    SignalEvent,
)


logger = logging.getLogger(__name__)


@dataclass(slots=True, frozen=True)
class CompareRequest:
    """One requested compare slot.

    ``kind`` is validated against the literal set by the route layer.
    """

    kind: str  # "country" | "event"
    identifier: str


class CompareService:
    """Build a CompareResponse over 2–3 targets."""

    MAX_TARGETS = 3

    def __init__(self, *, repository: EventRepository) -> None:
        self._repository = repository

    async def compare(self, requests: Sequence[CompareRequest]) -> CompareResponse:
        now = datetime.now(timezone.utc)
        trimmed = list(requests)[: self.MAX_TARGETS]
        targets: list[CompareTarget] = []
        for req in trimmed:
            target = await self._resolve_target(req)
            if target is not None:
                targets.append(target)

        diffs = _compute_diffs(targets)
        headline = _compose_headline(targets, diffs)

        return CompareResponse(
            generated_at=now,
            targets=targets,
            diffs=diffs,
            headline=headline,
        )

    async def _resolve_target(self, req: CompareRequest) -> CompareTarget | None:
        if req.kind == "country":
            code = req.identifier.upper()
            meta = lookup_by_alpha3(code)
            if meta is None:
                return None
            summary = await self._repository.get_country_summary(code)
            events = await self._repository.by_country(code, limit=10)
            return _target_from_country(
                code=code,
                label=meta.name,
                summary=summary,
                events=events,
            )
        if req.kind == "event":
            event = await self._repository.get(req.identifier)
            if event is None:
                return None
            country_events: list[SignalEvent] = []
            if event.place.country_code:
                country_events = await self._repository.by_country(
                    event.place.country_code, limit=8
                )
            return _target_from_event(event=event, sibling_events=country_events)
        return None


def _target_from_country(
    *,
    code: str,
    label: str,
    summary: CountrySignalSummary | None,
    events: Sequence[SignalEvent],
) -> CompareTarget:
    counts = dict(Counter(e.type for e in events))
    severities = dict(Counter(e.severity for e in events))
    freshness = _freshness_minutes(events)
    return CompareTarget(
        kind="country",
        id=f"country:{code}",
        label=label,
        country_code=code,
        summary=(summary.model_dump(mode="json") if summary is not None else None),
        event=None,
        recent_events=[e.model_dump(mode="json") for e in events[:6]],
        counts_by_category=counts,
        severity_distribution=severities,
        freshness_minutes=freshness,
    )


def _target_from_event(
    *, event: SignalEvent, sibling_events: Sequence[SignalEvent]
) -> CompareTarget:
    # sibling_events is the event's own country scope; handy for context cards.
    freshness = _freshness_minutes([event, *sibling_events])
    counts = dict(Counter(e.type for e in [event, *sibling_events]))
    severities = dict(Counter(e.severity for e in [event, *sibling_events]))
    return CompareTarget(
        kind="event",
        id=f"event:{event.id}",
        label=event.title,
        country_code=event.place.country_code,
        summary=None,
        event=event.model_dump(mode="json"),
        recent_events=[e.model_dump(mode="json") for e in sibling_events[:6]],
        counts_by_category=counts,
        severity_distribution=severities,
        freshness_minutes=freshness,
    )


def _compute_diffs(targets: Sequence[CompareTarget]) -> list[CompareDiff]:
    if len(targets) < 2:
        return []
    left, right = targets[0], targets[1]
    diffs: list[CompareDiff] = []

    def watch_score(target: CompareTarget) -> float | None:
        if target.summary is None:
            return None
        return float(target.summary.get("watch_score", 0.0))

    def watch_label(target: CompareTarget) -> str | None:
        if target.summary is None:
            return target.event.get("severity") if target.event else None
        return str(target.summary.get("watch_label"))

    l_score = watch_score(left)
    r_score = watch_score(right)
    if l_score is not None or r_score is not None:
        diffs.append(
            CompareDiff(
                dimension="watch_score",
                left_value=round(l_score, 3) if l_score is not None else None,
                right_value=round(r_score, 3) if r_score is not None else None,
                delta_note=(
                    f"{(r_score or 0) - (l_score or 0):+.2f} between left and right"
                ),
            )
        )

    diffs.append(
        CompareDiff(
            dimension="watch_label",
            left_value=watch_label(left),
            right_value=watch_label(right),
            delta_note=None,
        )
    )
    diffs.append(
        CompareDiff(
            dimension="total_recent_events",
            left_value=len(left.recent_events),
            right_value=len(right.recent_events),
            delta_note=None,
        )
    )
    diffs.append(
        CompareDiff(
            dimension="freshness_minutes",
            left_value=left.freshness_minutes,
            right_value=right.freshness_minutes,
            delta_note=None,
        )
    )
    return diffs


def _compose_headline(
    targets: Sequence[CompareTarget], diffs: Sequence[CompareDiff]
) -> str:
    if len(targets) < 2:
        return "Add a second target to compare."
    left, right = targets[0], targets[1]
    score_diff = next((d for d in diffs if d.dimension == "watch_score"), None)
    if score_diff and isinstance(score_diff.left_value, (int, float)) and isinstance(
        score_diff.right_value, (int, float)
    ):
        delta = score_diff.right_value - score_diff.left_value
        direction = "higher" if delta > 0 else "lower" if delta < 0 else "matching"
        return (
            f"{right.label} sits {abs(delta):.2f} points {direction} than "
            f"{left.label} on composite watch score."
        )
    return f"{left.label} vs {right.label}: compare recent evidence and severity mix."


def _freshness_minutes(events: Iterable[SignalEvent]) -> float | None:
    now = datetime.now(timezone.utc)
    freshest: float | None = None
    for event in events:
        ref = event.source_timestamp or event.ingested_at
        if ref is None:
            continue
        minutes = max(0.0, (now - ref).total_seconds() / 60.0)
        if freshest is None or minutes < freshest:
            freshest = minutes
    if freshest is None:
        return None
    return round(freshest, 1)


__all__ = ["CompareRequest", "CompareService"]
