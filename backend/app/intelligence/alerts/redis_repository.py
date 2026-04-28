"""Redis-backed Alert repository (Phase 18A.3).

Drop-in replacement for :class:`InMemoryAlertRepository` behind the
same Protocol seam. Storage layout:

* ``alerts:rules``            — Hash mapping ``rule_id`` → JSON payload
* ``alerts:rules:by_created`` — Sorted set (score = ``created_at`` epoch
                                seconds, member = ``rule_id``) so list
                                ordering survives across replicas
* ``alerts:events``           — Capped list of recent fires; the buffer
                                is enforced via ``LTRIM`` after every
                                ``LPUSH`` so we never grow unbounded

Concurrency notes:

* Rule writes go through a single pipeline (``HSET`` + ``ZADD``) so a
  reader cannot observe the hash being updated while the sorted-set
  index is stale.
* Event appends use ``LPUSH`` + ``LTRIM`` in a pipeline; under heavy
  burst the bounded buffer can momentarily hold ``event_buffer + N``
  entries between the two operations, but the trim brings it back.
* Reads of the full list use ``LRANGE`` with ``limit * 2`` plus an
  in-process ``since`` filter so the contract matches the in-memory
  implementation exactly.

The deterministic 17C contract — :class:`AlertRule` and
:class:`AlertEvent` Pydantic shapes — is preserved verbatim. Every
read re-validates through Pydantic so a key that drifted from the
schema fails loudly.
"""

from __future__ import annotations

import json
import logging
from datetime import datetime
from typing import TYPE_CHECKING

from app.intelligence.alerts.repository import (
    DEFAULT_EVENT_BUFFER,
    AlertNotFoundError,
)
from app.intelligence.alerts.schemas import AlertEvent, AlertRule

if TYPE_CHECKING:  # pragma: no cover - import-only
    from redis.asyncio import Redis


logger = logging.getLogger(__name__)


_RULES_KEY = "alerts:rules"
_RULES_INDEX_KEY = "alerts:rules:by_created"
_EVENTS_KEY = "alerts:events"


class RedisAlertRepository:
    """Redis-backed implementation of ``AlertRepository``."""

    def __init__(
        self,
        client: "Redis",
        *,
        event_buffer: int = DEFAULT_EVENT_BUFFER,
        namespace: str = "",
    ) -> None:
        if event_buffer <= 0:
            raise ValueError("event_buffer must be > 0")
        self._client = client
        self._event_buffer = event_buffer
        prefix = f"{namespace}:" if namespace else ""
        self._rules_key = f"{prefix}{_RULES_KEY}"
        self._rules_index_key = f"{prefix}{_RULES_INDEX_KEY}"
        self._events_key = f"{prefix}{_EVENTS_KEY}"

    # ---- rules ----------------------------------------------------------

    async def list_rules(self) -> list[AlertRule]:
        rule_ids = await self._client.zrevrange(self._rules_index_key, 0, -1)
        if not rule_ids:
            return []
        payloads = await self._client.hmget(self._rules_key, rule_ids)
        rules: list[AlertRule] = []
        for rule_id, payload in zip(rule_ids, payloads):
            if payload is None:
                # Index drift — purge the orphaned id so the next call
                # is consistent.
                await self._client.zrem(self._rules_index_key, rule_id)
                continue
            rules.append(AlertRule.model_validate_json(payload))
        return rules

    async def get_rule(self, rule_id: str) -> AlertRule:
        payload = await self._client.hget(self._rules_key, rule_id)
        if payload is None:
            raise AlertNotFoundError(rule_id)
        return AlertRule.model_validate_json(payload)

    async def upsert_rule(self, rule: AlertRule) -> AlertRule:
        payload = rule.model_dump_json()
        score = rule.created_at.timestamp()
        async with self._client.pipeline(transaction=True) as pipe:
            pipe.hset(self._rules_key, rule.id, payload)
            pipe.zadd(self._rules_index_key, {rule.id: score})
            await pipe.execute()
        return rule.model_copy(deep=True)

    async def delete_rule(self, rule_id: str) -> None:
        exists = await self._client.hexists(self._rules_key, rule_id)
        if not exists:
            raise AlertNotFoundError(rule_id)
        async with self._client.pipeline(transaction=True) as pipe:
            pipe.hdel(self._rules_key, rule_id)
            pipe.zrem(self._rules_index_key, rule_id)
            await pipe.execute()

    # ---- events ---------------------------------------------------------

    async def append_event(self, event: AlertEvent) -> AlertEvent:
        payload = event.model_dump_json()
        async with self._client.pipeline(transaction=True) as pipe:
            pipe.lpush(self._events_key, payload)
            pipe.ltrim(self._events_key, 0, self._event_buffer - 1)
            await pipe.execute()
        return event.model_copy(deep=True)

    async def list_events(
        self,
        *,
        since: datetime | None = None,
        limit: int = 50,
    ) -> list[AlertEvent]:
        # Over-fetch a bit so the in-process ``since`` filter has room
        # before truncating to ``limit``.
        fetch = max(limit * 2, limit)
        raw = await self._client.lrange(self._events_key, 0, fetch - 1)
        out: list[AlertEvent] = []
        for payload in raw:
            event = AlertEvent.model_validate_json(payload)
            if since is not None and event.fired_at <= since:
                continue
            out.append(event)
            if len(out) >= limit:
                break
        return out


__all__ = ["RedisAlertRepository"]
