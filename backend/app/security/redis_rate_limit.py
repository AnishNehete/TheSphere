"""Redis-backed token-bucket rate limiter (Phase 18A.3).

Atomic windowed token bucket implemented as a single Lua script. The
script reads the bucket state, applies the time-elapsed refill, decides
whether to consume a token, and writes the new state — all in one
round-trip. This avoids the read-then-write race that a naive client
would hit under concurrent requests.

Why Lua instead of WATCH/MULTI: the bucket update is a single atomic
operation under all conditions, and Lua scripts are cached by SHA so
the wire cost is one ``EVALSHA`` per consume after the first call.

Honest-data caveats:

* Buckets are stored under ``rate:<namespace>:<key>``. Misconfigured
  multi-tenant deploys (overlapping namespaces) would share buckets —
  pick a stable namespace per limiter at construction.
* Each bucket carries an EXPIRE roughly 2× the full-refill window so
  abandoned keys evict naturally without the operator running a
  background sweeper.
"""

from __future__ import annotations

import logging
import math
import time
from typing import TYPE_CHECKING

if TYPE_CHECKING:  # pragma: no cover - import-only
    from redis.asyncio import Redis


logger = logging.getLogger(__name__)


# Single-script atomic windowed token bucket.
#
# KEYS[1]  bucket key
# ARGV[1]  capacity      (float)
# ARGV[2]  refill_per_s  (float)
# ARGV[3]  now_ts        (float seconds, monotonic-ish — must be consistent)
# Returns: 1 if the consume was allowed, 0 otherwise.
_LUA_CONSUME = """
local key      = KEYS[1]
local capacity = tonumber(ARGV[1])
local refill   = tonumber(ARGV[2])
local now      = tonumber(ARGV[3])

local data = redis.call('HMGET', key, 'tokens', 'last_refill_ts')
local tokens      = tonumber(data[1])
local last_refill = tonumber(data[2])

if tokens == nil or last_refill == nil then
    tokens = capacity
    last_refill = now
end

local elapsed = now - last_refill
if elapsed < 0 then elapsed = 0 end
tokens = tokens + elapsed * refill
if tokens > capacity then tokens = capacity end

local allowed = 0
if tokens >= 1.0 then
    tokens = tokens - 1.0
    allowed = 1
end

redis.call('HSET', key, 'tokens', tokens, 'last_refill_ts', now)

-- TTL ~2x the full-refill window so abandoned keys evict naturally.
local ttl = 60
if refill > 0 then
    ttl = math.ceil((capacity / refill) * 2)
    if ttl < 60 then ttl = 60 end
end
redis.call('EXPIRE', key, ttl)

return allowed
"""


class RedisRateLimiter:
    """Token-bucket limiter backed by Redis with atomic Lua semantics."""

    def __init__(
        self,
        client: "Redis",
        *,
        namespace: str,
        capacity: int,
        refill_per_second: float,
    ) -> None:
        if capacity <= 0:
            raise ValueError("capacity must be > 0")
        if refill_per_second <= 0:
            raise ValueError("refill_per_second must be > 0")
        if not namespace:
            raise ValueError("namespace must be a non-empty string")
        self._client = client
        self._namespace = namespace
        self._capacity = float(capacity)
        self._refill = float(refill_per_second)
        self._script = client.register_script(_LUA_CONSUME)

    @property
    def capacity(self) -> int:
        return int(self._capacity)

    @property
    def refill_per_second(self) -> float:
        return self._refill

    async def consume(self, key: str, *, now_ts: float | None = None) -> bool:
        ts = now_ts if now_ts is not None else time.time()
        bucket_key = f"rate:{self._namespace}:{key}"
        result = await self._script(
            keys=[bucket_key],
            args=[self._capacity, self._refill, ts],
        )
        return _to_bool(result)


def _to_bool(value: object) -> bool:
    """Normalise the script's reply to a Python bool.

    redis-py historically returned ``int`` for Lua integer replies; some
    versions / fakes return ``bytes``. Be defensive.
    """

    if isinstance(value, bool):
        return value
    if isinstance(value, int):
        return value == 1
    if isinstance(value, (bytes, bytearray)):
        return value in (b"1",)
    if isinstance(value, str):
        return value == "1"
    return bool(value)


__all__ = ["RedisRateLimiter"]
