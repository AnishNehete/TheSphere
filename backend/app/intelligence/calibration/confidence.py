"""Confidence calibration (Phase 18B, Part 4).

Today's confidence in :mod:`agent_service` is heuristic — it bakes in a
rough mix of evidence count + reliability + cited-segment ratio + scope
penalty. That formula is *not calibrated* against actual usefulness,
which is why analysts learn to ignore numeric confidence over time.

This module replaces the raw heuristic with a calibrated score driven by
five interpretable inputs:

* ``evidence_count``           — count saturating around 6
* ``evidence_agreement``       — 0..1 share of evidence in the dominant
                                  category (cohesion proxy)
* ``recency``                  — 0..1, freshness of the *median* event
* ``source_diversity``         — 0..1 unique-publishers / total cap
* ``entity_resolution_confidence`` — scope.confidence from the planner

Plus a calibration step that maps the raw weighted score through a curve
fit per-bucket from the query log: a confidence number is only ever
shown after we have applied the calibration multiplier learned from
prior queries with the same raw confidence range.

If the query log is empty, the calibration is a no-op (multiplier=1.0)
so the system degrades gracefully on a fresh deployment.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import datetime
from typing import Iterable, Sequence

from app.intelligence.calibration.feedback import (
    UserAction,
    feedback_score_for_action,
)
from app.intelligence.calibration.schemas import QueryLogEntry
from app.intelligence.calibration.weights import RankingWeights, default_weights


@dataclass(frozen=True, slots=True)
class ConfidenceInputs:
    """Concrete inputs the calibrator consumes."""

    evidence_count: int
    evidence_agreement: float
    recency: float
    source_diversity: float
    entity_resolution_confidence: float

    @classmethod
    def from_events(
        cls,
        events: Sequence,
        *,
        now: datetime,
        scope_confidence: float,
        recency_half_life_hours: float,
    ) -> "ConfidenceInputs":
        if not events:
            return cls(
                evidence_count=0,
                evidence_agreement=0.0,
                recency=0.0,
                source_diversity=0.0,
                entity_resolution_confidence=scope_confidence,
            )
        # category agreement
        type_counts: dict[str, int] = {}
        publishers: set[str] = set()
        ages: list[float] = []
        for event in events:
            type_counts[event.type] = type_counts.get(event.type, 0) + 1
            for source in getattr(event, "sources", []) or []:
                publisher = (source.publisher or "").strip().lower()
                if publisher:
                    publishers.add(publisher)
            ts = getattr(event, "source_timestamp", None) or getattr(
                event, "ingested_at", None
            )
            if ts is not None:
                ages.append(max(0.0, (now - ts).total_seconds() / 3600.0))
        dominant = max(type_counts.values()) if type_counts else 0
        agreement = dominant / len(events) if events else 0.0
        if not ages:
            recency = 0.0
        else:
            ages.sort()
            median = ages[len(ages) // 2]
            half_life = max(0.1, recency_half_life_hours)
            recency = math.exp(-median / half_life)
        diversity = min(1.0, len(publishers) / max(1, min(5, len(events))))
        return cls(
            evidence_count=len(events),
            evidence_agreement=agreement,
            recency=recency,
            source_diversity=diversity,
            entity_resolution_confidence=scope_confidence,
        )


@dataclass(frozen=True, slots=True)
class CalibrationBucket:
    """One row in the calibration distribution."""

    label: str
    lower: float
    upper: float
    sample_count: int
    positive_signal_share: float
    negative_signal_share: float
    average_feedback: float


@dataclass(frozen=True, slots=True)
class ConfidenceCalibration:
    """Output of the confidence calibrator."""

    raw_score: float
    calibrated_score: float
    multiplier: float
    inputs: ConfidenceInputs
    bucket: CalibrationBucket | None = None


_BUCKET_EDGES: tuple[tuple[str, float, float], ...] = (
    ("0-20", 0.0, 0.2),
    ("20-40", 0.2, 0.4),
    ("40-60", 0.4, 0.6),
    ("60-80", 0.6, 0.8),
    ("80-100", 0.8, 1.0001),
)


def _evidence_count_score(count: int) -> float:
    """Saturating function — six pieces of evidence is "enough"."""

    if count <= 0:
        return 0.0
    return 1.0 - math.exp(-count / 3.0)


def _raw_confidence(
    inputs: ConfidenceInputs,
    *,
    weights: RankingWeights,
) -> float:
    normalizer = weights.confidence_weight_sum
    raw = (
        weights.confidence_evidence_weight * _evidence_count_score(
            inputs.evidence_count
        )
        + weights.confidence_agreement_weight * _clamp(inputs.evidence_agreement)
        + weights.confidence_recency_weight * _clamp(inputs.recency)
        + weights.confidence_diversity_weight * _clamp(inputs.source_diversity)
        + weights.confidence_resolution_weight
        * _clamp(inputs.entity_resolution_confidence)
    ) / normalizer
    return _clamp(raw)


def calibrated_confidence(
    inputs: ConfidenceInputs,
    *,
    weights: RankingWeights | None = None,
    buckets: Sequence[CalibrationBucket] | None = None,
) -> ConfidenceCalibration:
    """Return a calibrated confidence score with explicit drivers.

    The bucket multiplier nudges the raw score toward the empirical
    usefulness band: positive feedback (clicks/shares) pulls it up,
    negative feedback (refines) pulls it down. With no buckets supplied
    the multiplier is ``1.0`` and ``calibrated == raw``.
    """

    w = weights or default_weights()
    raw = _raw_confidence(inputs, weights=w)
    bucket = _bucket_for(raw, buckets) if buckets else None
    multiplier = _multiplier_from_bucket(bucket)
    calibrated = _clamp(raw * multiplier)
    return ConfidenceCalibration(
        raw_score=round(raw, 4),
        calibrated_score=round(calibrated, 4),
        multiplier=round(multiplier, 4),
        inputs=inputs,
        bucket=bucket,
    )


def bucketize(entries: Iterable[QueryLogEntry]) -> list[CalibrationBucket]:
    """Group query log entries by confidence band and summarise feedback.

    The output is the per-bucket distribution exposed by
    ``/intelligence/admin/calibration``. Empty buckets still appear so
    the consumer can render a stable table even on a sparse dataset.
    """

    samples: dict[str, list[QueryLogEntry]] = {
        label: [] for label, _, _ in _BUCKET_EDGES
    }
    for entry in entries:
        for label, lower, upper in _BUCKET_EDGES:
            if lower <= entry.confidence_score < upper:
                samples[label].append(entry)
                break

    rows: list[CalibrationBucket] = []
    for label, lower, upper in _BUCKET_EDGES:
        bucket_entries = samples[label]
        count = len(bucket_entries)
        positive = sum(
            1 for e in bucket_entries if feedback_score_for_action(e.user_action) > 0
        )
        negative = sum(
            1 for e in bucket_entries if feedback_score_for_action(e.user_action) < 0
        )
        average = (
            sum(feedback_score_for_action(e.user_action) for e in bucket_entries)
            / count
            if count
            else 0.0
        )
        rows.append(
            CalibrationBucket(
                label=label,
                lower=lower,
                upper=min(upper, 1.0),
                sample_count=count,
                positive_signal_share=(positive / count) if count else 0.0,
                negative_signal_share=(negative / count) if count else 0.0,
                average_feedback=average,
            )
        )
    return rows


def _bucket_for(
    score: float, buckets: Sequence[CalibrationBucket]
) -> CalibrationBucket | None:
    for bucket in buckets:
        if bucket.lower <= score < bucket.upper:
            return bucket
    return None


def _multiplier_from_bucket(bucket: CalibrationBucket | None) -> float:
    """Map a bucket's average feedback into a confidence multiplier.

    * Empty bucket            → 1.0 (no calibration evidence)
    * Average feedback >= 0   → up-weight by ``1 + 0.5 * avg``  (cap 1.25)
    * Average feedback < 0    → down-weight by ``1 + 0.6 * avg`` (floor 0.4)

    The asymmetric floor reflects the asymmetric cost of overconfidence —
    a single ``refine`` is a stronger trust signal than a single
    ``click``.
    """

    if bucket is None or bucket.sample_count == 0:
        return 1.0
    avg = bucket.average_feedback
    if avg >= 0:
        return min(1.25, 1.0 + 0.5 * avg)
    return max(0.4, 1.0 + 0.6 * avg)


def _clamp(value: float) -> float:
    if value <= 0.0:
        return 0.0
    if value >= 1.0:
        return 1.0
    return value


__all__ = [
    "CalibrationBucket",
    "ConfidenceCalibration",
    "ConfidenceInputs",
    "bucketize",
    "calibrated_confidence",
]
