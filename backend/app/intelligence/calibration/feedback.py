"""Implicit feedback signal mapping (Phase 18B, Part 5).

Maps the four UI-observable user actions to a feedback score in
``[-1, 1]``:

* ``share``  → +1.0  (strong positive — analyst trusted the result enough
                      to broadcast it)
* ``click``  → +0.5  (positive — analyst opened evidence detail)
* ``none``   →  0.0  (neutral — no signal in either direction)
* ``refine`` → -0.5  (negative — analyst restated the query, treating the
                      result as insufficient)

The score is **not** training data for an ML model. It is consumed only
by:

* :func:`app.intelligence.calibration.confidence.calibrated_confidence`
  to nudge the calibration scaling per-bucket
* the admin tuning simulation to estimate ranking lift under proposed
  weights

The mapping is intentionally small and asymmetric: positives are easy to
overcount (clicks happen for many reasons), so we cap ``click`` below
``share``.  ``refine`` is mildly negative — we have no way of telling a
genuine "bad result" refine from a "drill deeper" refine, so we don't
treat it as fully negative.
"""

from __future__ import annotations

from typing import Literal


UserAction = Literal["none", "refine", "click", "share"]


_FEEDBACK_TABLE: dict[UserAction, float] = {
    "share": 1.0,
    "click": 0.5,
    "none": 0.0,
    "refine": -0.5,
}


def feedback_score_for_action(action: UserAction) -> float:
    """Return the feedback score for a user action.

    Unknown actions default to ``0.0``; the type system already prevents
    that path at call sites, but defensive parsing of upstream payloads
    routes through here too.
    """

    return _FEEDBACK_TABLE.get(action, 0.0)


def is_positive_signal(action: UserAction) -> bool:
    return feedback_score_for_action(action) > 0.0


def is_negative_signal(action: UserAction) -> bool:
    return feedback_score_for_action(action) < 0.0


__all__ = [
    "UserAction",
    "feedback_score_for_action",
    "is_negative_signal",
    "is_positive_signal",
]
