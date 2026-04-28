"""Pure interpretable portfolio macro risk engine (Phase 13B.4).

Six components, documented constant weights (D-25), ranked drivers with
evidence_ids, delta-vs-baseline helper, and explanatory notes — never a
naked score.

This module imports only schemas + stdlib. No httpx / asyncio / I/O so
replay (Plan 13B.6) can reuse it unchanged against any historical state.
"""

from __future__ import annotations

import statistics
from datetime import datetime, timezone
from typing import Mapping, Sequence

from app.intelligence.portfolio.risk.schemas import (
    PortfolioMacroRiskScore,
    RiskDriver,
    RiskScoreComponents,
)
from app.intelligence.portfolio.schemas import (
    ExposureBucket,
    Holding,
    PortfolioExposureSummary,
    PortfolioLinkedEvent,
)
from app.intelligence.portfolio.semantic.schemas import PortfolioSemanticRollup
from app.intelligence.portfolio.technical.schemas import TechnicalSnapshot


# ---------------------------------------------------------------------------
# Documented constant weights (D-25). Sum MUST equal 1.0. Assertion at
# import time so any future edit is caught before production.
# ---------------------------------------------------------------------------

DEFAULT_COMPONENT_WEIGHTS: dict[str, float] = {
    "concentration": 0.15,
    "fx": 0.10,
    "commodity": 0.15,
    "chokepoint": 0.15,
    "event_severity": 0.25,
    "semantic_density": 0.20,
}
assert abs(sum(DEFAULT_COMPONENT_WEIGHTS.values()) - 1.0) < 1e-9, (
    "DEFAULT_COMPONENT_WEIGHTS must sum to 1.0"
)

# Delta-vs-baseline tuning.
MIN_BASELINE_SAMPLES = 3
BASELINE_WINDOW = 7

# Event-severity coverage: 12 linked events = full coverage weight.
EVENT_COVERAGE_SATURATION = 12


# ---------------------------------------------------------------------------
# Pure component functions. Each returns a value in [0..1].
# ---------------------------------------------------------------------------


def compute_concentration(holdings: Sequence[Holding]) -> float:
    """Herfindahl index on holding weights.

    A single-holding portfolio (weight = 1.0) returns 1.0. An evenly split
    N-holding portfolio returns ``1/N``. Zero holdings -> 0.0.

    Weights are re-normalized defensively so callers can pass market-value
    weights, cost-basis weights, or any positive vector — the engine never
    trusts that the input sums to 1.0.
    """

    weights = [max(0.0, float(h.weight or 0.0)) for h in holdings]
    total = sum(weights)
    if total <= 0:
        return 0.0
    normalized = [w / total for w in weights]
    return sum(w * w for w in normalized)


def compute_fx(exposure_summary: PortfolioExposureSummary) -> float:
    """FX dispersion = ``1 - sum(w_i^2)`` across currency buckets.

    All-USD portfolio -> 0.0. Evenly split USD/EUR -> 0.5. Evenly split
    four currencies -> 0.75. Empty -> 0.0.
    """

    if not exposure_summary.currencies:
        return 0.0
    weights = [float(b.weight) for b in exposure_summary.currencies if b.weight > 0]
    total = sum(weights)
    if total <= 0:
        return 0.0
    normalized = [w / total for w in weights]
    herfindahl = sum(w * w for w in normalized)
    return max(0.0, min(1.0, 1.0 - herfindahl))


def compute_bucket_severity(
    buckets: Sequence[ExposureBucket],
    severity_by_label: Mapping[str, float],
) -> tuple[float, list[str]]:
    """Return ``(value, matched_node_ids)`` for a commodity/chokepoint column.

    Formula: ``min(1.0, sum(bucket.weight × severity_by_label[label]))`` across
    buckets where the label has a severity entry. Only matched buckets
    contribute — no fabricated severity.
    """

    total = 0.0
    matched: list[str] = []
    for bucket in buckets:
        sev = float(severity_by_label.get(bucket.node.label, 0.0))
        if sev <= 0:
            continue
        total += float(bucket.weight) * sev
        matched.append(bucket.node.id)
    return min(1.0, max(0.0, total)), matched


def compute_event_severity(
    linked_events: Sequence[PortfolioLinkedEvent],
    *,
    weight_coverage: float,
) -> float:
    """``mean(severity_score) × coverage``, clamped to [0..1].

    Coverage is a caller-supplied saturation factor (typically
    ``min(1.0, len(linked_events) / 12)``) so a few tiny events never
    drive the score.
    """

    if not linked_events:
        return 0.0
    scores = [
        float(e.severity_score) for e in linked_events if e.severity_score is not None
    ]
    if not scores:
        return 0.0
    mean_sev = statistics.mean(scores)
    coverage = max(0.0, min(1.0, float(weight_coverage)))
    return max(0.0, min(1.0, mean_sev * coverage))


def compute_semantic_density(rollup: PortfolioSemanticRollup | None) -> float:
    """Pass-through of the 13B.3 rollup's semantic_score, clamped to [0..1]."""

    if rollup is None:
        return 0.0
    return max(0.0, min(1.0, float(rollup.semantic_score)))


def blend_to_risk_score(
    components: RiskScoreComponents,
    *,
    weights: Mapping[str, float] = DEFAULT_COMPONENT_WEIGHTS,
) -> float:
    """Weighted sum blended to [0..100]."""

    total = (
        components.concentration * weights["concentration"]
        + components.fx * weights["fx"]
        + components.commodity * weights["commodity"]
        + components.chokepoint * weights["chokepoint"]
        + components.event_severity * weights["event_severity"]
        + components.semantic_density * weights["semantic_density"]
    )
    return max(0.0, min(100.0, total * 100.0))


def rank_drivers(
    components: RiskScoreComponents,
    *,
    weights: Mapping[str, float],
    rationales: Mapping[str, str],
    evidence: Mapping[str, list[str]],
) -> list[RiskDriver]:
    """Return drivers sorted by ``component_value × weight`` descending.

    Components with value == 0 are omitted — they aren't driving risk and
    surfacing them as drivers would noise up the UI.
    """

    rows: list[tuple[str, float, float, str, list[str]]] = []
    for comp, weight in weights.items():
        value = float(getattr(components, comp))
        rows.append(
            (comp, value, weight, rationales[comp], list(evidence.get(comp, [])))
        )
    rows.sort(key=lambda r: r[1] * r[2], reverse=True)

    out: list[RiskDriver] = []
    for comp, value, weight, rationale, evs in rows:
        if value <= 0:
            continue
        out.append(
            RiskDriver(
                component=comp,  # type: ignore[arg-type]
                label=comp.replace("_", " ").title(),
                weight=round(value * weight, 4),
                rationale=rationale,
                evidence_ids=evs[:8],
            )
        )
    return out


def delta_vs_baseline(
    current_score: float, baseline_scores: Sequence[float]
) -> tuple[float, str | None]:
    """Return ``(delta, baseline_note)``.

    * ``< MIN_BASELINE_SAMPLES`` samples -> ``(0.0, note)``
    * otherwise median of the most-recent ``BASELINE_WINDOW`` samples
    """

    samples = list(baseline_scores)
    if len(samples) < MIN_BASELINE_SAMPLES:
        return 0.0, "Baseline not yet established (<3 historical scores)."
    window = samples[-BASELINE_WINDOW:]
    return round(current_score - statistics.median(window), 2), None


# ---------------------------------------------------------------------------
# Orchestrator — pulls components together into a PortfolioMacroRiskScore.
# ---------------------------------------------------------------------------


def build_risk_score(
    portfolio_id: str,
    *,
    holdings: Sequence[Holding],
    exposure_summary: PortfolioExposureSummary,
    linked_events: Sequence[PortfolioLinkedEvent],
    semantic_rollup: PortfolioSemanticRollup | None,
    severity_by_commodity: Mapping[str, float] | None = None,
    severity_by_chokepoint: Mapping[str, float] | None = None,
    baseline_scores: Sequence[float] = (),
    confidence_hint: float = 0.5,
    freshness_seconds: int = 0,
    as_of: datetime | None = None,
    technical_snapshots: Sequence[TechnicalSnapshot] | None = None,
) -> PortfolioMacroRiskScore:
    """Compose a :class:`PortfolioMacroRiskScore` from the caller's inputs."""

    as_of_ts = as_of or datetime.now(timezone.utc)
    severity_commodity = dict(severity_by_commodity or {})
    severity_chokepoint = dict(severity_by_chokepoint or {})

    concentration_val = compute_concentration(holdings)
    fx_val = compute_fx(exposure_summary)
    commodity_val, commodity_nodes = compute_bucket_severity(
        exposure_summary.commodities, severity_commodity
    )
    chokepoint_val, chokepoint_nodes = compute_bucket_severity(
        exposure_summary.chokepoints, severity_chokepoint
    )
    coverage = (
        min(1.0, len(linked_events) / EVENT_COVERAGE_SATURATION)
        if linked_events
        else 0.0
    )
    event_sev_val = compute_event_severity(linked_events, weight_coverage=coverage)
    semantic_val = compute_semantic_density(semantic_rollup)

    components = RiskScoreComponents(
        concentration=round(concentration_val, 4),
        fx=round(fx_val, 4),
        commodity=round(commodity_val, 4),
        chokepoint=round(chokepoint_val, 4),
        event_severity=round(event_sev_val, 4),
        semantic_density=round(semantic_val, 4),
    )
    risk_score = blend_to_risk_score(components)
    delta, baseline_note = delta_vs_baseline(risk_score, baseline_scores)

    rationales = {
        "concentration": (
            f"Herfindahl index {concentration_val:.2f} across "
            f"{len(holdings)} holdings."
        ),
        "fx": (
            f"Currency dispersion {fx_val:.2f} — "
            f"{len(exposure_summary.currencies)} currency buckets."
        ),
        "commodity": (
            "Weighted commodity exposure × event severity across "
            f"{len(commodity_nodes)} matched buckets."
        ),
        "chokepoint": (
            "Weighted chokepoint exposure × event severity across "
            f"{len(chokepoint_nodes)} matched routes."
        ),
        "event_severity": (
            f"{len(linked_events)} live events linked to portfolio exposure; "
            f"mean severity {event_sev_val:.2f}."
        ),
        "semantic_density": (
            f"Semantic rollup score {semantic_val:.2f} from "
            f"{(semantic_rollup.contributing_event_count if semantic_rollup else 0)} events."
        ),
    }

    semantic_evidence: list[str] = []
    if semantic_rollup is not None:
        for driver in semantic_rollup.top_drivers:
            for eid in driver.evidence_ids:
                if eid not in semantic_evidence:
                    semantic_evidence.append(eid)
                    if len(semantic_evidence) >= 10:
                        break
            if len(semantic_evidence) >= 10:
                break

    evidence: dict[str, list[str]] = {
        "commodity": commodity_nodes,
        "chokepoint": chokepoint_nodes,
        "event_severity": [e.event_id for e in linked_events][:10],
        "semantic_density": semantic_evidence,
        "concentration": [],
        "fx": [],
    }
    drivers = rank_drivers(
        components,
        weights=DEFAULT_COMPONENT_WEIGHTS,
        rationales=rationales,
        evidence=evidence,
    )

    notes: list[str] = []
    if baseline_note:
        notes.append(baseline_note)
    for name, value in components.model_dump().items():
        if value == 0:
            notes.append(
                f"Component '{name}' = 0 (no data or no matched exposure)."
            )
    if not drivers:
        notes.append("All components = 0 — nothing is driving risk right now.")

    confidence = min(1.0, max(0.0, float(confidence_hint)))
    raw = PortfolioMacroRiskScore(
        portfolio_id=portfolio_id,
        risk_score=round(risk_score, 2),
        delta_vs_baseline=delta,
        drivers=drivers,
        confidence=round(confidence, 3),
        score_components=components,
        as_of=as_of_ts,
        freshness_seconds=max(0, int(freshness_seconds)),
        notes=notes,
    )
    return populate_tilt_for_risk(
        raw,
        technical_snapshots=list(technical_snapshots or []),
        semantic_rollup=semantic_rollup,
    )


# Tilt discipline: we report bullish_tilt / bearish_tilt / uncertainty ONLY.
# We NEVER emit buy / sell / recommendation / target price language — see D-39.


def populate_tilt_for_risk(
    score: PortfolioMacroRiskScore,
    *,
    technical_snapshots: Sequence[TechnicalSnapshot] | None = None,
    semantic_rollup: PortfolioSemanticRollup | None = None,
) -> PortfolioMacroRiskScore:
    """Populate tilt fields by aggregating technical + semantic tilt evidence.

    If no technical snapshots and no semantic rollup are provided, the
    alignment is "insufficient" and all tilt scores are None.

    Aggregation:
    - bull_agg = mean of bullish_tilt_score across snapshots that have one
    - bear_agg = mean of bearish_tilt_score across snapshots that have one
    - semantic bearish_tilt_score (when present) is blended in with weight 0.4
    - When bull and bear are both > 0.3 AND their difference < 0.15:
      signal_alignment = "conflicting", uncertainty_score >= 0.7
    - Else alignment follows the same rules as technical tilt.

    Returns a new frozen model — never mutates the input.
    """
    snaps = list(technical_snapshots or [])

    bull_values = [
        s.bullish_tilt_score
        for s in snaps
        if s.bullish_tilt_score is not None
    ]
    bear_values = [
        s.bearish_tilt_score
        for s in snaps
        if s.bearish_tilt_score is not None
    ]

    has_technical = bool(bull_values or bear_values)
    has_semantic = (
        semantic_rollup is not None
        and semantic_rollup.bearish_tilt_score is not None
    )

    if not has_technical and not has_semantic:
        return score.model_copy(
            update={
                "bullish_tilt_score": None,
                "bearish_tilt_score": None,
                "uncertainty_score": None,
                "signal_alignment": "insufficient",
            }
        )

    bull_agg = statistics.mean(bull_values) if bull_values else 0.0
    bear_agg = statistics.mean(bear_values) if bear_values else 0.0

    # Blend in semantic bearish weight 0.4.
    if has_semantic:
        sem_bear = float(semantic_rollup.bearish_tilt_score)  # type: ignore[union-attr]
        bear_agg = min(1.0, bear_agg * 0.6 + sem_bear * 0.4)

    bull_agg = min(1.0, max(0.0, bull_agg))
    bear_agg = min(1.0, max(0.0, bear_agg))

    uncertainty = round(1.0 - abs(bull_agg - bear_agg), 3)
    diff = abs(bull_agg - bear_agg)

    # Conflicting: both sides meaningful but close together — uncertainty wins.
    if bull_agg > 0.3 and bear_agg > 0.3 and diff < 0.15:
        alignment = "conflicting"
        uncertainty = max(uncertainty, 0.7)
    elif diff > 0.4:
        alignment = "aligned"
    elif diff > 0.2:
        alignment = "mixed"
    elif max(bull_agg, bear_agg) > 0.3:
        alignment = "conflicting"
    else:
        alignment = "insufficient"

    return score.model_copy(
        update={
            "bullish_tilt_score": round(bull_agg, 3),
            "bearish_tilt_score": round(bear_agg, 3),
            "uncertainty_score": uncertainty,
            "signal_alignment": alignment,
        }
    )


__all__ = [
    "BASELINE_WINDOW",
    "DEFAULT_COMPONENT_WEIGHTS",
    "EVENT_COVERAGE_SATURATION",
    "MIN_BASELINE_SAMPLES",
    "blend_to_risk_score",
    "build_risk_score",
    "compute_bucket_severity",
    "compute_concentration",
    "compute_event_severity",
    "compute_fx",
    "compute_semantic_density",
    "delta_vs_baseline",
    "populate_tilt_for_risk",
    "rank_drivers",
]
