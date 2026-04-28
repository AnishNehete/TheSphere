"""Alert MVP module (Phase 17C).

Lets an analyst register a small number of explicit "wake me up when X
happens" rules against the deterministic posture engine. Two rule kinds
only:

* ``posture_band_change`` — fires when the bounded posture literal moves
  (e.g. ``neutral`` → ``buy``).
* ``confidence_drop`` — fires when ``confidence`` falls more than the
  rule's ``threshold`` from the baseline.

Hard rules from the phase brief:

* Every fired alert carries a ``triggering_posture`` envelope and a
  typed ``delta`` block — same "no naked numbers" contract as 17A/17B.
* Cooldown is mandatory and enforced inside the pure evaluator, not at
  the route. A single jittery posture cannot spam alerts.
* No LLM, no external delivery, no auth — bell + dropdown is the entire
  delivery surface in this MVP.
"""

from app.intelligence.alerts.evaluator import evaluate_rule
from app.intelligence.alerts.redis_repository import RedisAlertRepository
from app.intelligence.alerts.repository import (
    AlertNotFoundError,
    AlertRepository,
    InMemoryAlertRepository,
)
from app.intelligence.alerts.schemas import (
    AlertDelta,
    AlertEvent,
    AlertRule,
    AlertRuleCreate,
    AlertRuleKind,
    DEFAULT_COOLDOWN_SECONDS,
    DEFAULT_CONFIDENCE_THRESHOLD,
)
from app.intelligence.alerts.service import AlertService

__all__ = [
    "AlertDelta",
    "AlertEvent",
    "AlertNotFoundError",
    "AlertRepository",
    "AlertRule",
    "AlertRuleCreate",
    "AlertRuleKind",
    "AlertService",
    "DEFAULT_COOLDOWN_SECONDS",
    "DEFAULT_CONFIDENCE_THRESHOLD",
    "InMemoryAlertRepository",
    "RedisAlertRepository",
    "evaluate_rule",
]
