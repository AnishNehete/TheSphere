"""Per-key rate limiting (Phase 17C → 18A.3).

Phase 17C shipped a single in-memory token-bucket
:class:`RateLimiter`. Phase 18A.3 promotes :class:`RateLimiter` to a
Protocol so the same routes can be served by either an in-process
bucket or a Redis-backed bucket that survives restarts and replicates
across replicas.

Concrete implementations:

* :class:`InMemoryRateLimiter` — the original in-process token bucket.
  Restarts reset every bucket. Acceptable for local dev / single-process
  closed beta.
* :class:`RedisRateLimiter` — Redis-backed token bucket. Atomic via a
  single Lua script per consume; safe across replicas. Implementation
  lives in :mod:`app.security.redis_rate_limit` to keep the optional
  Redis import cold when not configured.

Both honour the same async ``consume(key)`` contract; routes annotate
the Protocol and are agnostic to the implementation.

Honest-data caveats unchanged from 17C:

* This is a courtesy throttle, not a security boundary against a
  determined attacker.
* X-Forwarded-For is forgeable but acceptable for closed-beta proxy
  setups; tighten to a trusted-proxy allowlist before opening up.
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass
from typing import Protocol, runtime_checkable

from fastapi import HTTPException, Request, status


@runtime_checkable
class RateLimiter(Protocol):
    """Protocol satisfied by every concrete rate limiter."""

    @property
    def capacity(self) -> int: ...

    @property
    def refill_per_second(self) -> float: ...

    async def consume(self, key: str, *, now_ts: float | None = None) -> bool: ...


@dataclass(slots=True)
class TokenBucket:
    """Classical token-bucket state for a single in-memory key."""

    capacity: float
    refill_per_second: float
    tokens: float
    last_refill_ts: float

    def try_consume(self, now_ts: float) -> bool:
        elapsed = max(0.0, now_ts - self.last_refill_ts)
        self.tokens = min(
            self.capacity, self.tokens + elapsed * self.refill_per_second
        )
        self.last_refill_ts = now_ts
        if self.tokens >= 1.0:
            self.tokens -= 1.0
            return True
        return False


class InMemoryRateLimiter:
    """Per-key token-bucket limiter held in process memory.

    ``capacity`` is the max burst; ``refill_per_second`` is the steady
    state. For "60 per hour" pass capacity=60, refill_per_second=60/3600.
    """

    def __init__(self, *, capacity: int, refill_per_second: float) -> None:
        if capacity <= 0:
            raise ValueError("capacity must be > 0")
        if refill_per_second <= 0:
            raise ValueError("refill_per_second must be > 0")
        self._capacity = float(capacity)
        self._refill = refill_per_second
        self._buckets: dict[str, TokenBucket] = {}
        self._lock = asyncio.Lock()

    async def consume(self, key: str, *, now_ts: float | None = None) -> bool:
        ts = now_ts if now_ts is not None else time.monotonic()
        async with self._lock:
            bucket = self._buckets.get(key)
            if bucket is None:
                bucket = TokenBucket(
                    capacity=self._capacity,
                    refill_per_second=self._refill,
                    tokens=self._capacity,
                    last_refill_ts=ts,
                )
                self._buckets[key] = bucket
            return bucket.try_consume(ts)

    @property
    def capacity(self) -> int:
        return int(self._capacity)

    @property
    def refill_per_second(self) -> float:
        return self._refill


def _client_key(request: Request) -> str:
    fwd = request.headers.get("x-forwarded-for")
    if fwd:
        return fwd.split(",")[0].strip()
    if request.client and request.client.host:
        return request.client.host
    return "unknown"


def rate_limit_dependency(limiter: RateLimiter):
    """Build a FastAPI dependency that enforces ``limiter`` per client IP."""

    async def _dep(request: Request) -> None:
        ok = await limiter.consume(_client_key(request))
        if not ok:
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail="Rate limit exceeded.",
            )

    return _dep


__all__ = [
    "InMemoryRateLimiter",
    "RateLimiter",
    "TokenBucket",
    "rate_limit_dependency",
]
