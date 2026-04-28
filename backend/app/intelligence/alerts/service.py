"""Alert orchestrator (Phase 17C).

Drives the loop:

1. ``add_rule`` — fetches the current posture for the rule's symbol via
   :class:`MarketPostureService` and seeds the baseline so the very next
   ``evaluate_all`` cycle has something to compare against.
2. ``evaluate_all`` — iterates enabled rules, fetches each rule's
   current posture, runs the pure :func:`evaluate_rule`, persists fires,
   re-anchors baselines on fire.
3. ``list_recent_events`` — newest-first, ``since`` cursor for cheap
   polling from the frontend.

Per-tenant cap on rules keeps the closed beta bounded.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime
from typing import Sequence

from app.intelligence.alerts.evaluator import evaluate_rule
from app.intelligence.alerts.repository import (
    AlertRepository,
    generate_id,
    now_utc,
)
from app.intelligence.alerts.schemas import (
    AlertEvent,
    AlertRule,
    AlertRuleCreate,
    DEFAULT_CONFIDENCE_THRESHOLD,
)
from app.intelligence.portfolio.posture.service import MarketPostureService


logger = logging.getLogger(__name__)


DEFAULT_MAX_RULES = 50


class AlertRuleLimitError(RuntimeError):
    """Raised when the per-tenant rule cap is reached."""


class AlertService:
    def __init__(
        self,
        *,
        repository: AlertRepository,
        posture_service: MarketPostureService,
        max_rules: int = DEFAULT_MAX_RULES,
    ) -> None:
        self._repo = repository
        self._posture = posture_service
        self._max_rules = max_rules
        # Concurrent ``evaluate_all`` calls are pointless and would race
        # on baseline writes. The lock makes the cycle sequential.
        self._cycle_lock = asyncio.Lock()

    async def list_rules(self) -> list[AlertRule]:
        return await self._repo.list_rules()

    async def get_rule(self, rule_id: str) -> AlertRule:
        return await self._repo.get_rule(rule_id)

    async def add_rule(self, request: AlertRuleCreate) -> AlertRule:
        existing = len(await self._repo.list_rules())
        if existing >= self._max_rules:
            raise AlertRuleLimitError(
                f"Alert rule limit reached ({self._max_rules})."
            )

        symbol = request.symbol.upper().strip()
        if not symbol:
            raise ValueError("symbol is required")

        threshold = request.threshold
        if request.kind == "confidence_drop" and threshold is None:
            threshold = DEFAULT_CONFIDENCE_THRESHOLD

        # Seed the baseline from the current posture so the next eval
        # cycle compares against a real anchor instead of None.
        baseline_posture = None
        baseline_confidence = None
        baseline_at = None
        try:
            seed = await self._posture.build_for_symbol(
                symbol, asset_class=request.asset_class
            )
            baseline_posture = seed.posture
            baseline_confidence = seed.confidence
            baseline_at = seed.as_of
        except Exception as exc:  # pragma: no cover - defensive
            logger.warning(
                "alerts: failed to seed baseline for %s: %s; rule will seed lazily",
                symbol,
                exc,
            )

        rule = AlertRule(
            id=generate_id("alrt"),
            name=request.name.strip(),
            kind=request.kind,
            symbol=symbol,
            asset_class=request.asset_class,
            threshold=threshold,
            cooldown_seconds=request.cooldown_seconds,
            enabled=request.enabled,
            created_at=now_utc(),
            baseline_posture=baseline_posture,
            baseline_confidence=baseline_confidence,
            baseline_at=baseline_at,
            last_evaluated_at=baseline_at,
            last_fired_at=None,
        )
        return await self._repo.upsert_rule(rule)

    async def delete_rule(self, rule_id: str) -> None:
        await self._repo.delete_rule(rule_id)

    async def list_recent_events(
        self,
        *,
        since: datetime | None = None,
        limit: int = 50,
    ) -> list[AlertEvent]:
        return await self._repo.list_events(since=since, limit=limit)

    async def evaluate_all(self) -> list[AlertEvent]:
        """One evaluation cycle. Safe to call concurrently — only one
        cycle runs at a time."""
        async with self._cycle_lock:
            rules = await self._repo.list_rules()
            fired: list[AlertEvent] = []
            now = now_utc()
            for rule in rules:
                if not rule.enabled:
                    continue
                try:
                    current = await self._posture.build_for_symbol(
                        rule.symbol, asset_class=rule.asset_class
                    )
                except Exception as exc:  # pragma: no cover - defensive
                    logger.warning(
                        "alerts: posture fetch failed for %s: %s",
                        rule.symbol,
                        exc,
                    )
                    continue

                # Lazy baseline seeding for rules whose seed failed at
                # creation time (e.g. provider was unavailable then).
                if (
                    rule.kind == "posture_band_change"
                    and rule.baseline_posture is None
                ):
                    rule.baseline_posture = current.posture
                    rule.baseline_at = current.as_of
                if (
                    rule.kind == "confidence_drop"
                    and rule.baseline_confidence is None
                ):
                    rule.baseline_confidence = current.confidence
                    rule.baseline_at = current.as_of

                event = evaluate_rule(rule, current, now)
                rule.last_evaluated_at = now
                if event is not None:
                    rule.last_fired_at = event.fired_at
                    # Re-anchor baseline so the next cycle tracks moves
                    # from this fire forward, not from rule creation.
                    if rule.kind == "posture_band_change":
                        rule.baseline_posture = current.posture
                    if rule.kind == "confidence_drop":
                        rule.baseline_confidence = current.confidence
                    rule.baseline_at = current.as_of
                    persisted = await self._repo.append_event(event)
                    fired.append(persisted)
                await self._repo.upsert_rule(rule)
            return fired


__all__ = [
    "AlertRuleLimitError",
    "AlertService",
    "DEFAULT_MAX_RULES",
]


# Convenience for type-checking the runtime sequence in tests.
def _assert_sequence(seq: Sequence[AlertRule]) -> None:  # pragma: no cover
    return None
