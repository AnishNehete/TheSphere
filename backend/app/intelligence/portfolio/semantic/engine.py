"""Pure semantic / event pressure engine.

Given a holding's exposure edges + a corpus of events, produce a
``SemanticSnapshot``. No I/O — orchestration happens in
``app.intelligence.portfolio.semantic_service``.

Matching rules (D-21 from 13b-CONTEXT.md):

* ``country:{CODE}`` — ``event.place.country_code`` equals ``CODE``
* ``sector:{label}`` — ``event.tags`` intersect the lowercased label OR an
  entity's name contains the label (case-insensitive)
* ``commodity:{label}`` — ``event.tags`` intersect the label OR
  ``event.type == "commodities"`` with an entity/title mentioning the label
* ``chokepoint:{label}`` — ``event.tags`` OR ``event.title`` contain the label
  (case-insensitive)
* ``macro_theme:{label}`` — ``event.tags`` intersect the label
  (case-insensitive)

Score aggregation per event (D-22):

    event_contrib = severity_score
                  * max(exposure_weight for matched edges)
                  * recency_decay(age_hours)
                  * avg(source.reliability)
                  * event.confidence

Recency decay: ``exp(-age_hours / RECENCY_HALF_LIFE_HOURS)`` with
``RECENCY_HALF_LIFE_HOURS = 168`` (7 days, documented lifespan).

Holding ``semantic_score``: ``min(1.0, sum(event_contrib for top N events))``
— capped so pressure bands stay meaningful.
"""

from __future__ import annotations

import math
import statistics
from datetime import datetime, timezone
from typing import Iterable

from app.intelligence.portfolio.schemas import ExposureEdge, Holding
from app.intelligence.portfolio.semantic.schemas import (
    EventPressureLevel,
    PortfolioSemanticRollup,
    SemanticDriver,
    SemanticSnapshot,
)
from app.intelligence.schemas import SignalEvent


RECENCY_HALF_LIFE_HOURS = 168.0
MAX_EVENTS_PER_HOLDING = 25
MAX_DRIVERS_PER_HOLDING = 5
MAX_TOP_DRIVERS_ROLLUP = 6
MAX_EVIDENCE_IDS_PER_DRIVER = 10


# -----------------------------------------------------------------------------
# Matching
# -----------------------------------------------------------------------------


def match_events_to_holding(
    holding: Holding,
    edges: list[ExposureEdge],
    events: Iterable[SignalEvent],
) -> dict[str, list[tuple[ExposureEdge, SignalEvent]]]:
    """Return ``{event_id: [(edge, event), ...]}`` for events matching ≥1 edge.

    Each event may match multiple edges; ``score_holding`` collapses to a
    single contribution via the max-weight edge rule (D-22) to avoid
    double-counting.
    """

    per_event: dict[str, list[tuple[ExposureEdge, SignalEvent]]] = {}
    if not edges:
        return per_event
    for event in events:
        for edge in edges:
            if _edge_matches_event(edge, event):
                per_event.setdefault(event.id, []).append((edge, event))
    return per_event


def _edge_matches_event(edge: ExposureEdge, event: SignalEvent) -> bool:
    """Edge/event matching by ``node_id`` prefix.

    Unknown domains fail closed — better to under-match than to fabricate a
    link the UI will surface.
    """

    if ":" not in edge.node_id:
        return False
    domain, tail = edge.node_id.split(":", 1)
    tail_lower = tail.lower()
    if domain == "country":
        event_country = (event.place.country_code or "").upper()
        return event_country == tail.upper()
    if domain == "sector":
        if any(tail_lower == tag.lower() for tag in event.tags):
            return True
        if any(tail_lower in (ent.name or "").lower() for ent in event.entities):
            return True
        return False
    if domain == "commodity":
        if any(tail_lower == tag.lower() for tag in event.tags):
            return True
        if event.type == "commodities":
            title = (event.title or "").lower()
            if tail_lower in title:
                return True
            if any(tail_lower in (ent.name or "").lower() for ent in event.entities):
                return True
        return False
    if domain == "chokepoint":
        if any(tail_lower in tag.lower() for tag in event.tags):
            return True
        title = (event.title or "").lower()
        summary = (event.summary or "").lower()
        return tail_lower in title or tail_lower in summary
    if domain == "macro_theme":
        return any(tail_lower in tag.lower() for tag in event.tags)
    return False


# -----------------------------------------------------------------------------
# Scoring (holding)
# -----------------------------------------------------------------------------


def score_holding(
    holding: Holding,
    edges: list[ExposureEdge],
    events: list[SignalEvent],
    *,
    as_of: datetime | None = None,
) -> SemanticSnapshot:
    """Produce a ``SemanticSnapshot`` for a single holding.

    Empty corpus or disjoint edges return a calm / zero-score snapshot —
    never an error and never a fabricated driver.
    """

    as_of_ts = as_of or datetime.now(timezone.utc)
    per_event = match_events_to_holding(holding, edges, events)
    if not per_event:
        return populate_tilt_for_semantic(SemanticSnapshot(
            holding_id=holding.id,
            symbol=holding.symbol,
            semantic_score=0.0,
            event_pressure_level="calm",
            semantic_drivers=[],
            linked_event_ids=[],
            confidence=0.0,
            as_of=as_of_ts,
        ))

    contributions: list[tuple[SignalEvent, ExposureEdge, float]] = []
    for _event_id, pairs in per_event.items():
        # Max-weight exposure edge wins (D-22: de-duplicate overlap).
        best_edge, event = max(pairs, key=lambda p: p[0].weight)
        age_h = _age_hours(event, as_of_ts)
        recency = math.exp(-age_h / RECENCY_HALF_LIFE_HOURS)
        reliability = _avg_reliability(event)
        contrib = (
            event.severity_score
            * best_edge.weight
            * recency
            * reliability
            * event.confidence
        )
        contributions.append((event, best_edge, contrib))

    contributions.sort(key=lambda t: t[2], reverse=True)
    contributions = contributions[:MAX_EVENTS_PER_HOLDING]

    total = sum(c for _, _, c in contributions)
    semantic_score = min(1.0, total)
    level = _classify_level(semantic_score)

    drivers = _build_drivers(contributions)

    linked_event_ids = [e.id for e, _, _ in contributions]

    confidence = _snapshot_confidence(contributions)

    return populate_tilt_for_semantic(SemanticSnapshot(
        holding_id=holding.id,
        symbol=holding.symbol,
        semantic_score=round(semantic_score, 4),
        event_pressure_level=level,
        semantic_drivers=drivers[:MAX_DRIVERS_PER_HOLDING],
        linked_event_ids=linked_event_ids,
        confidence=round(confidence, 3),
        as_of=as_of_ts,
    ))


def _age_hours(event: SignalEvent, as_of: datetime) -> float:
    reference = event.ingested_at or event.source_timestamp or as_of
    delta_seconds = (as_of - reference).total_seconds()
    return max(0.0, delta_seconds / 3600.0)


def _avg_reliability(event: SignalEvent) -> float:
    if not event.sources:
        return 0.5
    return statistics.mean(s.reliability for s in event.sources)


def _snapshot_confidence(
    contributions: list[tuple[SignalEvent, ExposureEdge, float]],
) -> float:
    if not contributions:
        return 0.0
    values = [
        _avg_reliability(event) * event.confidence
        for event, _, _ in contributions
    ]
    return min(1.0, statistics.mean(values))


def _classify_level(score: float) -> EventPressureLevel:
    if score >= 0.75:
        return "critical"
    if score >= 0.5:
        return "elevated"
    if score >= 0.25:
        return "watch"
    return "calm"


def _build_drivers(
    contributions: list[tuple[SignalEvent, ExposureEdge, float]],
) -> list[SemanticDriver]:
    """Group contributions by ``edge.node_id``; one driver per exposure node.

    Rationale strings reference event titles (truncated) directly — never
    invented text. If no events contributed to a node, no driver is emitted.
    """

    groups: dict[str, dict] = {}
    for event, edge, contrib in contributions:
        group = groups.setdefault(
            edge.node_id,
            {
                "contrib": 0.0,
                "events": [],
                "node_label": _label_for(edge.node_id),
            },
        )
        group["contrib"] += contrib
        group["events"].append(event)

    ordered = sorted(groups.items(), key=lambda kv: kv[1]["contrib"], reverse=True)
    out: list[SemanticDriver] = []
    for node_id, group in ordered:
        events: list[SignalEvent] = group["events"]
        top_titles = [_clip_title(e.title) for e in events[:2]]
        rationale = (
            f"{len(events)} event(s) matched via {node_id}: "
            + "; ".join(top_titles)
        )
        out.append(
            SemanticDriver(
                node_id=node_id,
                label=group["node_label"],
                contribution=round(min(1.0, group["contrib"]), 4),
                rationale=rationale,
                evidence_ids=[e.id for e in events][:MAX_EVIDENCE_IDS_PER_DRIVER],
            )
        )
    return out


def _clip_title(title: str | None) -> str:
    text = title or ""
    return text[:80]


def _label_for(node_id: str) -> str:
    """``country:USA`` -> ``USA``; ``sector:technology`` -> ``Technology``."""

    if ":" not in node_id:
        return node_id
    domain, tail = node_id.split(":", 1)
    if domain in {"sector", "commodity", "macro_theme", "chokepoint"}:
        return tail.replace("_", " ").replace("-", " ").title()
    return tail


# -----------------------------------------------------------------------------
# Rollup (portfolio)
# -----------------------------------------------------------------------------


def rollup_portfolio(
    portfolio_id: str,
    holding_weights: dict[str, float],
    snapshots: list[SemanticSnapshot],
    *,
    as_of: datetime | None = None,
) -> PortfolioSemanticRollup:
    """Aggregate per-holding snapshots into a portfolio-level rollup.

    ``semantic_score`` is weight-weighted average across priced holdings;
    ``top_drivers`` merges per-node contributions across snapshots and keeps
    the top ``MAX_TOP_DRIVERS_ROLLUP``.
    """

    as_of_ts = as_of or datetime.now(timezone.utc)
    if not snapshots:
        return populate_tilt_for_rollup(PortfolioSemanticRollup(
            portfolio_id=portfolio_id,
            semantic_score=0.0,
            event_pressure_level="calm",
            top_drivers=[],
            contributing_event_count=0,
            as_of=as_of_ts,
            confidence=0.0,
        ))

    # Equal-weight fallback if no weights or sum <= 0.
    resolved_weights: dict[str, float] = {}
    for snap in snapshots:
        w = holding_weights.get(snap.holding_id, 0.0)
        resolved_weights[snap.holding_id] = w
    total_weight = sum(resolved_weights.values())
    if total_weight <= 0:
        even = 1.0 / len(snapshots)
        resolved_weights = {s.holding_id: even for s in snapshots}
        total_weight = 1.0

    weighted = (
        sum(
            s.semantic_score * resolved_weights.get(s.holding_id, 0.0)
            for s in snapshots
        )
        / total_weight
    )
    confidence = statistics.mean(s.confidence for s in snapshots)

    event_ids = {eid for s in snapshots for eid in s.linked_event_ids}

    merged: dict[str, SemanticDriver] = {}
    for snap in snapshots:
        for driver in snap.semantic_drivers:
            existing = merged.get(driver.node_id)
            if existing is None:
                merged[driver.node_id] = driver
                continue
            combined_contrib = min(
                1.0, existing.contribution + driver.contribution
            )
            combined_ids = list(
                dict.fromkeys(existing.evidence_ids + driver.evidence_ids)
            )[:MAX_EVIDENCE_IDS_PER_DRIVER]
            merged[driver.node_id] = SemanticDriver(
                node_id=driver.node_id,
                label=driver.label,
                contribution=round(combined_contrib, 4),
                rationale=existing.rationale,
                evidence_ids=combined_ids,
            )
    top = sorted(
        merged.values(), key=lambda d: d.contribution, reverse=True
    )[:MAX_TOP_DRIVERS_ROLLUP]

    weighted_clamped = min(1.0, max(0.0, weighted))
    return populate_tilt_for_rollup(PortfolioSemanticRollup(
        portfolio_id=portfolio_id,
        semantic_score=round(weighted_clamped, 4),
        event_pressure_level=_classify_level(weighted_clamped),
        top_drivers=top,
        contributing_event_count=len(event_ids),
        as_of=as_of_ts,
        confidence=round(confidence, 3),
    ))


# Tilt discipline: we report bullish_tilt / bearish_tilt / uncertainty ONLY.
# We NEVER emit buy / sell / recommendation / target price language — see D-39.


def populate_tilt_for_semantic(
    snapshot: SemanticSnapshot,
) -> SemanticSnapshot:
    """Populate tilt fields on a SemanticSnapshot from its semantic_score.

    Semantic pressure in the operational-risk domain is bearish-leaning —
    stress events typically reduce expected P&L. Returns a new frozen snapshot.
    """
    score = snapshot.semantic_score
    if score == 0.0:
        return snapshot.model_copy(
            update={
                "bullish_tilt_score": None,
                "bearish_tilt_score": None,
                "uncertainty_score": None,
                "signal_alignment": "insufficient",
            }
        )
    alignment = "aligned" if score > 0.5 else "mixed"
    return snapshot.model_copy(
        update={
            "bullish_tilt_score": 0.0,
            "bearish_tilt_score": round(score, 3),
            "uncertainty_score": round(1.0 - score, 3),
            "signal_alignment": alignment,
        }
    )


def populate_tilt_for_rollup(
    rollup: PortfolioSemanticRollup,
) -> PortfolioSemanticRollup:
    """Populate tilt fields on a PortfolioSemanticRollup from semantic_score."""
    score = rollup.semantic_score
    if score == 0.0:
        return rollup.model_copy(
            update={
                "bullish_tilt_score": None,
                "bearish_tilt_score": None,
                "uncertainty_score": None,
                "signal_alignment": "insufficient",
            }
        )
    alignment = "aligned" if score > 0.5 else "mixed"
    return rollup.model_copy(
        update={
            "bullish_tilt_score": 0.0,
            "bearish_tilt_score": round(score, 3),
            "uncertainty_score": round(1.0 - score, 3),
            "signal_alignment": alignment,
        }
    )


__all__ = [
    "MAX_DRIVERS_PER_HOLDING",
    "MAX_EVENTS_PER_HOLDING",
    "MAX_TOP_DRIVERS_ROLLUP",
    "RECENCY_HALF_LIFE_HOURS",
    "match_events_to_holding",
    "populate_tilt_for_rollup",
    "populate_tilt_for_semantic",
    "rollup_portfolio",
    "score_holding",
]
