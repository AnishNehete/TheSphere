"""Alert persistence (Phase 17C — in-memory only).

Two collections:

* ``rules`` — long-lived configuration the operator built explicitly
* ``events`` — bounded ring buffer of recent fires (default 200)

The ring buffer keeps the bell dropdown cheap to render and prevents
unbounded memory growth in the closed beta. A future Postgres-backed
swap can replace this with a real append-only table without touching
the service or route surface (the Protocol seam stays).
"""

from __future__ import annotations

import asyncio
import uuid
from collections import deque
from datetime import datetime, timezone
from typing import Deque, Iterable, Protocol

from app.intelligence.alerts.schemas import AlertEvent, AlertRule


DEFAULT_EVENT_BUFFER = 200


class AlertNotFoundError(LookupError):
    """Raised when a requested rule id is not present."""


class AlertRepository(Protocol):
    async def list_rules(self) -> list[AlertRule]: ...

    async def get_rule(self, rule_id: str) -> AlertRule: ...

    async def upsert_rule(self, rule: AlertRule) -> AlertRule: ...

    async def delete_rule(self, rule_id: str) -> None: ...

    async def append_event(self, event: AlertEvent) -> AlertEvent: ...

    async def list_events(
        self,
        *,
        since: datetime | None = None,
        limit: int = 50,
    ) -> list[AlertEvent]: ...


def generate_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


class InMemoryAlertRepository:
    """Thread-safe in-memory implementation of :class:`AlertRepository`."""

    def __init__(self, *, event_buffer: int = DEFAULT_EVENT_BUFFER) -> None:
        self._rules: dict[str, AlertRule] = {}
        self._events: Deque[AlertEvent] = deque(maxlen=event_buffer)
        self._lock = asyncio.Lock()

    async def list_rules(self) -> list[AlertRule]:
        async with self._lock:
            return sorted(
                (r.model_copy(deep=True) for r in self._rules.values()),
                key=lambda r: r.created_at,
                reverse=True,
            )

    async def get_rule(self, rule_id: str) -> AlertRule:
        async with self._lock:
            rule = self._rules.get(rule_id)
            if rule is None:
                raise AlertNotFoundError(rule_id)
            return rule.model_copy(deep=True)

    async def upsert_rule(self, rule: AlertRule) -> AlertRule:
        async with self._lock:
            stored = rule.model_copy(deep=True)
            self._rules[stored.id] = stored
            return stored.model_copy(deep=True)

    async def delete_rule(self, rule_id: str) -> None:
        async with self._lock:
            if rule_id not in self._rules:
                raise AlertNotFoundError(rule_id)
            self._rules.pop(rule_id, None)

    async def append_event(self, event: AlertEvent) -> AlertEvent:
        async with self._lock:
            stored = event.model_copy(deep=True)
            self._events.append(stored)
            return stored.model_copy(deep=True)

    async def list_events(
        self,
        *,
        since: datetime | None = None,
        limit: int = 50,
    ) -> list[AlertEvent]:
        async with self._lock:
            # Newest-first.
            iterable: Iterable[AlertEvent] = reversed(self._events)
            out: list[AlertEvent] = []
            for ev in iterable:
                if since is not None and ev.fired_at <= since:
                    continue
                out.append(ev.model_copy(deep=True))
                if len(out) >= limit:
                    break
            return out


__all__ = [
    "AlertNotFoundError",
    "AlertRepository",
    "DEFAULT_EVENT_BUFFER",
    "InMemoryAlertRepository",
    "generate_id",
    "now_utc",
]
