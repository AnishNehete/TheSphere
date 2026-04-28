"""Rate-limiter contract tests (Phase 17C → 18A.3).

The contract is verified across every concrete implementation:

* ``in_memory`` — :class:`InMemoryRateLimiter` (always run)
* ``fakeredis`` — :class:`RedisRateLimiter` against an async ``fakeredis``
  client; runs in CI without a real broker
* ``real_redis`` — :class:`RedisRateLimiter` against a real Redis at
  ``TEST_REDIS_URL``; skipped when the env var is unset

The Lua script must produce the same allow/deny pattern as the
in-memory token bucket — otherwise behaviour diverges between dev and
production. Parametrizing the same tests across all three variants is
how we keep the contract honest.
"""

from __future__ import annotations

import os
from typing import AsyncIterator

import pytest

from app.security import InMemoryRateLimiter, RateLimiter, RedisRateLimiter


_LIMITER_KINDS: tuple[str, ...] = ("in_memory", "fakeredis", "real_redis")


@pytest.fixture(params=_LIMITER_KINDS)
async def limiter_factory(request: pytest.FixtureRequest):
    """Return a callable building a fresh limiter with the requested impl.

    Yielding a factory (rather than a single limiter) lets each test
    pick its own ``capacity`` / ``refill_per_second`` while still
    exercising every variant.
    """

    kind = request.param
    cleanups: list = []

    if kind == "in_memory":

        def _build(*, capacity: int, refill_per_second: float) -> RateLimiter:
            return InMemoryRateLimiter(
                capacity=capacity, refill_per_second=refill_per_second
            )

        yield _build
        return

    if kind == "fakeredis":
        try:
            import fakeredis.aioredis as fake_async
        except ImportError:
            pytest.skip("fakeredis not installed")
        client = fake_async.FakeRedis()

        def _build(*, capacity: int, refill_per_second: float) -> RateLimiter:
            limiter = RedisRateLimiter(
                client,
                namespace=f"test_{request.node.name}",
                capacity=capacity,
                refill_per_second=refill_per_second,
            )
            return limiter

        try:
            yield _build
        finally:
            await client.flushall()
            await client.aclose()
        return

    if kind == "real_redis":
        dsn = os.environ.get("TEST_REDIS_URL")
        if not dsn:
            pytest.skip("TEST_REDIS_URL unset; real-redis contract tests skipped")
        from app.cache import build_redis_client

        client = build_redis_client(dsn)

        def _build(*, capacity: int, refill_per_second: float) -> RateLimiter:
            return RedisRateLimiter(
                client,
                namespace=f"test_{request.node.name}",
                capacity=capacity,
                refill_per_second=refill_per_second,
            )

        try:
            yield _build
        finally:
            # Wipe just our test namespace so we don't trash a shared dev
            # Redis if someone points TEST_REDIS_URL at one.
            keys = await client.keys(f"rate:test_{request.node.name}:*")
            if keys:
                await client.delete(*keys)
            await client.aclose()
        return

    raise AssertionError(f"unknown limiter kind: {kind}")


# ---------------------------------------------------------------------------
# contract
# ---------------------------------------------------------------------------


async def test_consume_allows_up_to_capacity_then_blocks(limiter_factory) -> None:
    limiter = limiter_factory(capacity=3, refill_per_second=0.0001)
    assert await limiter.consume("k", now_ts=0.0) is True
    assert await limiter.consume("k", now_ts=0.0) is True
    assert await limiter.consume("k", now_ts=0.0) is True
    assert await limiter.consume("k", now_ts=0.0) is False


async def test_refill_restores_tokens_over_time(limiter_factory) -> None:
    # 1 token per second, capacity 2.
    limiter = limiter_factory(capacity=2, refill_per_second=1.0)
    assert await limiter.consume("k", now_ts=0.0) is True
    assert await limiter.consume("k", now_ts=0.0) is True
    assert await limiter.consume("k", now_ts=0.0) is False
    # 1.5s later → 1.5 tokens accrued, 1 consumable.
    assert await limiter.consume("k", now_ts=1.5) is True
    assert await limiter.consume("k", now_ts=1.5) is False


async def test_keys_are_independent(limiter_factory) -> None:
    limiter = limiter_factory(capacity=1, refill_per_second=0.0001)
    assert await limiter.consume("a", now_ts=0.0) is True
    assert await limiter.consume("a", now_ts=0.0) is False
    assert await limiter.consume("b", now_ts=0.0) is True


# ---------------------------------------------------------------------------
# constructor validation — only the in-memory ctor enforces these synchronously
# (Redis variants enforce them on their own constructor, but that's identical
# logic so it's checked here against InMemoryRateLimiter directly).
# ---------------------------------------------------------------------------


def test_capacity_validation() -> None:
    with pytest.raises(ValueError):
        InMemoryRateLimiter(capacity=0, refill_per_second=1.0)
    with pytest.raises(ValueError):
        InMemoryRateLimiter(capacity=1, refill_per_second=0.0)
