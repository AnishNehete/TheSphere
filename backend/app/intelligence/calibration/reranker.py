"""Deterministic reranker over scored evidence (Phase 18B, Part 3).

This is a pure scoring function: no ML model, no LLM, no I/O. Inputs are
already-scored search candidates plus a query context; output is the
list reordered by a weighted combination of:

* freshness    — exponential decay over event age, half-life from weights
* severity     — event.severity_score
* geo          — location_match score (1.0 for exact-country / chokepoint
                 names match, scaled down for spatial proximity, 0 if
                 no scope)
* recency      — same as freshness; kept named separately so weights can
                 split "freshness" (timestamp-based) from "trending"
                 dynamics later. Today they coincide.
* diversity    — penalty for adjacent items sharing publisher / type, so
                 the top-N doesn't degenerate into 5 stories from the
                 same wire feed
* semantic     — placeholder slot fed by SearchHit text score; used so
                 the weights config can already control the contribution
                 without a downstream code change

The reranker is total: even with all weights at zero it returns a stable
order (it falls back to the input order). Equal-score ties break by
event id so reranks are reproducible across runs.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Sequence

from app.intelligence.calibration.schemas import RankingBreakdown
from app.intelligence.calibration.weights import RankingWeights, default_weights


@dataclass(frozen=True, slots=True)
class EvidenceCandidate:
    """One pre-scored evidence row passed into :func:`rerank`."""

    event_id: str
    base_score: float
    severity_score: float
    location_match_score: float
    semantic_score: float
    timestamp: datetime | None
    publisher: str | None = None
    event_type: str | None = None
    matched_terms: tuple[str, ...] = ()
    place_match: str | None = None


@dataclass(frozen=True, slots=True)
class QueryContext:
    """Lightweight context the reranker needs from the calling layer."""

    now: datetime
    has_place_scope: bool


@dataclass(frozen=True, slots=True)
class RerankedItem:
    """Single rerank output row carrying its breakdown."""

    candidate: EvidenceCandidate
    breakdown: RankingBreakdown


@dataclass(frozen=True, slots=True)
class RerankResult:
    """Ordered rerank output."""

    items: tuple[RerankedItem, ...] = ()

    def event_ids(self) -> list[str]:
        return [item.candidate.event_id for item in self.items]

    def top_score(self) -> float:
        return self.items[0].breakdown.final_score if self.items else 0.0


def _freshness(
    candidate: EvidenceCandidate, *, now: datetime, half_life_hours: float
) -> float:
    if candidate.timestamp is None:
        return 0.0
    age_hours = max(0.0, (now - candidate.timestamp).total_seconds() / 3600.0)
    if half_life_hours <= 0.0:
        return 0.0
    return math.exp(-age_hours / half_life_hours)


def _diversity_penalty(
    candidate: EvidenceCandidate,
    *,
    seen_publishers: set[str],
    seen_types: set[str],
) -> float:
    """Return a 0..1 penalty: 0 means novel, higher means more redundant."""

    penalty = 0.0
    if candidate.publisher and candidate.publisher.lower() in seen_publishers:
        penalty += 0.6
    if candidate.event_type and candidate.event_type.lower() in seen_types:
        penalty += 0.4
    return min(penalty, 1.0)


def rerank(
    candidates: Sequence[EvidenceCandidate],
    context: QueryContext,
    *,
    weights: RankingWeights | None = None,
) -> RerankResult:
    """Reorder ``candidates`` by a weighted combination of scoring signals.

    The weights from :class:`RankingWeights` act as soft preferences —
    we normalize by their sum so analysts can express them in absolute
    terms (e.g. ``freshness_weight=0.5``) without having to keep them
    summed to 1.

    Determinism: ``sorted`` with a stable key (``-final_score``,
    ``event_id``) — the same input always yields the same order, even
    with ties. The reranker never mutates inputs.
    """

    if not candidates:
        return RerankResult()

    w = weights or default_weights()
    normalizer = w.ranking_weight_sum

    # First pass — compute the scalar component scores per candidate.
    component_rows: list[tuple[EvidenceCandidate, dict[str, float]]] = []
    for candidate in candidates:
        freshness = _freshness(
            candidate,
            now=context.now,
            half_life_hours=w.recency_half_life_hours,
        )
        component_rows.append(
            (
                candidate,
                {
                    "freshness": freshness,
                    "severity": _clamp(candidate.severity_score),
                    "geo": _clamp(candidate.location_match_score),
                    "semantic": _clamp(candidate.semantic_score),
                },
            )
        )

    # Second pass — apply diversity penalty in input order. We accumulate
    # publisher / type sets greedily, which biases the top-1 candidate
    # against later duplicates rather than penalising the first match.
    seen_publishers: set[str] = set()
    seen_types: set[str] = set()
    items: list[RerankedItem] = []
    for candidate, components in component_rows:
        diversity_penalty = _diversity_penalty(
            candidate,
            seen_publishers=seen_publishers,
            seen_types=seen_types,
        )
        if candidate.publisher:
            seen_publishers.add(candidate.publisher.lower())
        if candidate.event_type:
            seen_types.add(candidate.event_type.lower())

        weighted = (
            w.freshness_weight * components["freshness"]
            + w.severity_weight * components["severity"]
            + w.geo_weight * components["geo"]
            + w.semantic_weight * components["semantic"]
        ) / normalizer
        # diversity is a penalty — subtract scaled by its weight.
        final = weighted - (w.diversity_weight / normalizer) * diversity_penalty
        # Keep base_score visible: blend it as a tiny stabiliser so a
        # well-scored candidate from the upstream search never collapses
        # to zero just because all weights are pulled to other components.
        final = 0.85 * final + 0.15 * _clamp(candidate.base_score)
        if not context.has_place_scope:
            # Without a place scope geo cannot meaningfully contribute;
            # rebalance by pushing the geo weight onto freshness so the
            # final score doesn't artificially compress.
            geo_weight_share = w.geo_weight / normalizer
            final = final + geo_weight_share * (
                components["freshness"] - components["geo"]
            )
        final = _clamp_final(final)

        breakdown = RankingBreakdown(
            event_id=candidate.event_id,
            base_score=_clamp(candidate.base_score),
            freshness_score=components["freshness"],
            severity_score=components["severity"],
            location_match_score=components["geo"],
            diversity_penalty=diversity_penalty,
            semantic_score=components["semantic"],
            final_score=final,
            matched_terms=list(candidate.matched_terms),
            place_match=candidate.place_match,
        )
        items.append(RerankedItem(candidate=candidate, breakdown=breakdown))

    items.sort(
        key=lambda row: (-row.breakdown.final_score, row.candidate.event_id)
    )
    return RerankResult(items=tuple(items))


def _clamp(value: float) -> float:
    if value <= 0.0:
        return 0.0
    if value >= 1.0:
        return 1.0
    return value


def _clamp_final(value: float) -> float:
    if value <= 0.0:
        return 0.0
    if value >= 1.5:
        return 1.5
    return value


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


__all__ = [
    "EvidenceCandidate",
    "QueryContext",
    "RerankResult",
    "RerankedItem",
    "now_utc",
    "rerank",
]
