"""Async Redis client factory (Phase 18A.3).

Mirror of :mod:`app.db` but for Redis. The factory is only invoked when
:attr:`IntelligenceSettings.redis_url` is set — without it the in-memory
implementations of the rate limiter and the alert repository continue
to satisfy their Protocol seams.

Honest-data rules:

* This module never silently falls back to a fake. If ``redis_url`` is
  set but the connection fails on first use, the operator hears about
  it via the existing structured logs.
* ``decode_responses=False`` so we keep bytes round-trip clean and
  serialise / deserialise JSON ourselves; the alert repo round-trips
  Pydantic models verbatim.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

if TYPE_CHECKING:  # pragma: no cover - import-only
    from redis.asyncio import Redis


logger = logging.getLogger(__name__)


def build_redis_client(redis_url: str) -> "Redis":
    """Build a configured async Redis client.

    The lazy import keeps :mod:`redis.asyncio` cold-loaded when Redis is
    not configured. Connection params favour predictable closed-beta
    behaviour over throughput tuning — a 2-second connect timeout means
    a misconfigured DSN surfaces at first use rather than hanging the
    request.
    """

    from redis.asyncio import Redis

    return Redis.from_url(
        redis_url,
        decode_responses=False,
        socket_timeout=5.0,
        socket_connect_timeout=2.0,
        health_check_interval=30,
    )


async def ping_redis(client: "Redis") -> bool:
    """Smoke a ``PING`` against ``client``; returns False on any error."""

    try:
        result = await client.ping()
    except Exception as exc:  # pragma: no cover - depends on broker
        logger.warning("cache.redis ping failed: %s", exc)
        return False
    return bool(result)


__all__ = ["build_redis_client", "ping_redis"]
