"""Pure rule evaluator (Phase 17C).

Stateless: takes a rule + the current posture envelope + ``now`` and
returns a fired :class:`AlertEvent` or ``None``. Cooldown is enforced
inside this function so it cannot be bypassed by skipping a layer.

Design choices:

* The baseline is updated only when a rule fires (caller is responsible
  for persisting the re-anchor). This means a rule tracks *moves from
  the last fire*, not deviation from the original creation moment —
  which is what an operator actually wants from a posture-band-change
  alert. Without it the rule would re-fire on every evaluation until
  the posture happened to wander back to baseline.
* No hidden numeric defaults. ``DEFAULT_CONFIDENCE_THRESHOLD`` lives in
  :mod:`schemas` and is only consulted when the rule itself omits one.
"""

from __future__ import annotations

from datetime import datetime
from typing import Final

from app.intelligence.alerts.repository import generate_id
from app.intelligence.alerts.schemas import (
    AlertDelta,
    AlertEvent,
    AlertRule,
    DEFAULT_CONFIDENCE_THRESHOLD,
)
from app.intelligence.portfolio.posture.schemas import (
    MarketPosture,
    PostureLabel,
)


_POSTURE_ORDER: Final[tuple[PostureLabel, ...]] = (
    "strong_sell",
    "sell",
    "neutral",
    "buy",
    "strong_buy",
)


def _band_distance(a: PostureLabel, b: PostureLabel) -> int:
    return abs(_POSTURE_ORDER.index(a) - _POSTURE_ORDER.index(b))


def _format_confidence(value: float) -> str:
    return f"{round(value * 100)}%"


def evaluate_rule(
    rule: AlertRule,
    current: MarketPosture,
    now: datetime,
) -> AlertEvent | None:
    """Decide whether ``rule`` should fire given ``current`` posture.

    Returns ``None`` when the rule is disabled, still inside its cooldown
    window, or when the conditions are not met. Returns a fully-built
    :class:`AlertEvent` otherwise — the caller is responsible for
    persisting it and re-anchoring the rule's baseline.
    """

    if not rule.enabled:
        return None

    # Cooldown gate. Applies to every rule kind uniformly so a single
    # jittery posture cannot spam alerts even if the conditions keep
    # being met.
    if rule.last_fired_at is not None:
        elapsed = (now - rule.last_fired_at).total_seconds()
        if elapsed < rule.cooldown_seconds:
            return None

    # Symbol mismatch is treated as a no-op rather than an error so the
    # service can run a cycle even if the caller passes the wrong
    # posture in (defensive — should not happen in normal flow).
    if current.symbol.upper() != rule.symbol.upper():
        return None

    if rule.kind == "posture_band_change":
        return _evaluate_band_change(rule, current, now)
    if rule.kind == "confidence_drop":
        return _evaluate_confidence_drop(rule, current, now)

    return None  # pragma: no cover - exhaustive Literal


def _evaluate_band_change(
    rule: AlertRule,
    current: MarketPosture,
    now: datetime,
) -> AlertEvent | None:
    baseline = rule.baseline_posture
    if baseline is None:
        # No baseline yet — caller will set one on first evaluation.
        return None
    if current.posture == baseline:
        return None

    distance = _band_distance(baseline, current.posture)
    delta = AlertDelta(
        kind="posture_band_change",
        field="posture",
        from_value=baseline,
        to_value=current.posture,
        magnitude=float(distance),
        summary=(
            f"{rule.symbol} posture moved from {baseline} to {current.posture}"
            f" ({distance} band{'s' if distance != 1 else ''})."
        ),
    )
    return AlertEvent(
        id=generate_id("alev"),
        rule_id=rule.id,
        rule_name=rule.name,
        fired_at=now,
        triggering_posture=current,
        delta=delta,
    )


def _evaluate_confidence_drop(
    rule: AlertRule,
    current: MarketPosture,
    now: datetime,
) -> AlertEvent | None:
    baseline = rule.baseline_confidence
    if baseline is None:
        return None
    threshold = (
        rule.threshold if rule.threshold is not None else DEFAULT_CONFIDENCE_THRESHOLD
    )
    drop = baseline - current.confidence
    if drop < threshold:
        return None

    delta = AlertDelta(
        kind="confidence_drop",
        field="confidence",
        from_value=_format_confidence(baseline),
        to_value=_format_confidence(current.confidence),
        magnitude=round(drop, 4),
        summary=(
            f"{rule.symbol} confidence dropped from {_format_confidence(baseline)}"
            f" to {_format_confidence(current.confidence)}"
            f" (≥ {_format_confidence(threshold)} threshold)."
        ),
    )
    return AlertEvent(
        id=generate_id("alev"),
        rule_id=rule.id,
        rule_name=rule.name,
        fired_at=now,
        triggering_posture=current,
        delta=delta,
    )


__all__ = ["evaluate_rule"]
