"""Alert repository contract tests (Phase 18A.3).

Covers the storage seam shared by every concrete
:class:`AlertRepository`. The 17C ``test_alerts.py`` already covers the
pure evaluator + the :class:`AlertService` orchestration over the
in-memory repo; this module exists to enforce the repository contract
across implementations as new ones land.

Variants:

* ``in_memory``  — :class:`InMemoryAlertRepository` (always run)
* ``fakeredis``  — :class:`RedisAlertRepository` against an async
                   ``fakeredis`` client; runs in CI without a real broker
* ``real_redis`` — :class:`RedisAlertRepository` against a real Redis at
                   ``TEST_REDIS_URL``; skipped when the env var is unset
"""

from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone
from typing import AsyncIterator

import pytest

from app.intelligence.alerts import (
    AlertEvent,
    AlertNotFoundError,
    AlertRepository,
    AlertRule,
    InMemoryAlertRepository,
    RedisAlertRepository,
)
from app.intelligence.alerts.schemas import AlertDelta
from app.intelligence.portfolio.posture.schemas import (
    MarketPosture,
    PostureComponents,
)


NOW = datetime(2026, 4, 26, 12, 0, 0, tzinfo=timezone.utc)


_REPO_KINDS: tuple[str, ...] = ("in_memory", "fakeredis", "real_redis")


@pytest.fixture(params=_REPO_KINDS)
async def alert_repo(
    request: pytest.FixtureRequest,
) -> AsyncIterator[AlertRepository]:
    kind = request.param
    if kind == "in_memory":
        yield InMemoryAlertRepository(event_buffer=10)
        return

    if kind == "fakeredis":
        try:
            import fakeredis.aioredis as fake_async
        except ImportError:
            pytest.skip("fakeredis not installed")
        client = fake_async.FakeRedis()
        ns = f"test_{uuid.uuid4().hex[:8]}"
        try:
            yield RedisAlertRepository(client, namespace=ns, event_buffer=10)
        finally:
            keys = await client.keys(f"{ns}:*")
            if keys:
                await client.delete(*keys)
            await client.aclose()
        return

    if kind == "real_redis":
        dsn = os.environ.get("TEST_REDIS_URL")
        if not dsn:
            pytest.skip("TEST_REDIS_URL unset; real-redis contract tests skipped")
        from app.cache import build_redis_client

        client = build_redis_client(dsn)
        ns = f"test_{uuid.uuid4().hex[:8]}"
        try:
            yield RedisAlertRepository(client, namespace=ns, event_buffer=10)
        finally:
            keys = await client.keys(f"{ns}:*")
            if keys:
                await client.delete(*keys)
            await client.aclose()
        return

    raise AssertionError(f"unknown repo kind: {kind}")


# ---------------------------------------------------------------------------
# fixtures for typed payloads
# ---------------------------------------------------------------------------


def _rule(rule_id: str, *, symbol: str = "AAPL", offset_seconds: int = 0) -> AlertRule:
    return AlertRule(
        id=rule_id,
        name=f"Rule {rule_id}",
        kind="posture_band_change",
        symbol=symbol,
        asset_class="equities",
        threshold=None,
        cooldown_seconds=600,
        enabled=True,
        created_at=NOW + timedelta(seconds=offset_seconds),
        baseline_posture="neutral",
        baseline_confidence=None,
        baseline_at=NOW,
        last_evaluated_at=None,
        last_fired_at=None,
    )


def _posture() -> MarketPosture:
    return MarketPosture(
        symbol="AAPL",
        asset_class="equities",
        posture="buy",
        posture_label="Buy",
        tilt=0.4,
        effective_tilt=0.3,
        confidence=0.7,
        components=PostureComponents(
            technical=0.4, semantic=0.3, macro=None, uncertainty=0.3
        ),
        drivers=[],
        caveats=[],
        freshness_seconds=120,
        as_of=NOW,
        notes=[],
        provider="alphavantage",
        provider_health="live",
        semantic_pressure=None,
    )


def _event(event_id: str, *, fired_at: datetime | None = None) -> AlertEvent:
    return AlertEvent(
        id=event_id,
        rule_id="alrt_test",
        rule_name="Test rule",
        symbol="AAPL",
        kind="posture_band_change",
        fired_at=fired_at or NOW,
        triggering_posture=_posture(),
        delta=AlertDelta(
            kind="posture_band_change",
            field="posture",
            from_value="neutral",
            to_value="buy",
            magnitude=1.0,
            summary="Posture moved from neutral to buy.",
        ),
    )


# ---------------------------------------------------------------------------
# rule contract
# ---------------------------------------------------------------------------


async def test_upsert_then_get_round_trip(alert_repo: AlertRepository) -> None:
    rule = _rule("alrt_a")
    await alert_repo.upsert_rule(rule)
    fetched = await alert_repo.get_rule("alrt_a")
    assert fetched.id == "alrt_a"
    assert fetched.symbol == "AAPL"
    assert fetched.baseline_posture == "neutral"


async def test_get_unknown_rule_raises(alert_repo: AlertRepository) -> None:
    with pytest.raises(AlertNotFoundError):
        await alert_repo.get_rule("alrt_missing")


async def test_list_rules_orders_by_created_at_desc(
    alert_repo: AlertRepository,
) -> None:
    await alert_repo.upsert_rule(_rule("alrt_first", offset_seconds=0))
    await alert_repo.upsert_rule(_rule("alrt_second", offset_seconds=10))
    await alert_repo.upsert_rule(_rule("alrt_third", offset_seconds=20))
    rules = await alert_repo.list_rules()
    assert [r.id for r in rules] == ["alrt_third", "alrt_second", "alrt_first"]


async def test_upsert_replaces_existing_payload(
    alert_repo: AlertRepository,
) -> None:
    rule = _rule("alrt_a")
    await alert_repo.upsert_rule(rule)
    rule.symbol = "MSFT"
    await alert_repo.upsert_rule(rule)
    fetched = await alert_repo.get_rule("alrt_a")
    assert fetched.symbol == "MSFT"


async def test_delete_removes_rule(alert_repo: AlertRepository) -> None:
    await alert_repo.upsert_rule(_rule("alrt_a"))
    await alert_repo.delete_rule("alrt_a")
    with pytest.raises(AlertNotFoundError):
        await alert_repo.get_rule("alrt_a")
    assert await alert_repo.list_rules() == []


async def test_delete_unknown_rule_raises(
    alert_repo: AlertRepository,
) -> None:
    with pytest.raises(AlertNotFoundError):
        await alert_repo.delete_rule("alrt_missing")


# ---------------------------------------------------------------------------
# event contract
# ---------------------------------------------------------------------------


async def test_append_event_returns_payload(
    alert_repo: AlertRepository,
) -> None:
    appended = await alert_repo.append_event(_event("evt_a"))
    assert appended.id == "evt_a"
    events = await alert_repo.list_events()
    assert [e.id for e in events] == ["evt_a"]


async def test_list_events_returns_newest_first(
    alert_repo: AlertRepository,
) -> None:
    await alert_repo.append_event(_event("evt_a", fired_at=NOW))
    await alert_repo.append_event(
        _event("evt_b", fired_at=NOW + timedelta(seconds=10))
    )
    await alert_repo.append_event(
        _event("evt_c", fired_at=NOW + timedelta(seconds=20))
    )
    events = await alert_repo.list_events()
    assert [e.id for e in events] == ["evt_c", "evt_b", "evt_a"]


async def test_list_events_since_cursor_filters_strictly_after(
    alert_repo: AlertRepository,
) -> None:
    await alert_repo.append_event(_event("evt_a", fired_at=NOW))
    await alert_repo.append_event(
        _event("evt_b", fired_at=NOW + timedelta(seconds=10))
    )
    after = await alert_repo.list_events(since=NOW)
    assert [e.id for e in after] == ["evt_b"]


async def test_event_buffer_caps_at_configured_size(
    alert_repo: AlertRepository,
) -> None:
    # event_buffer=10 in fixtures.
    for i in range(15):
        await alert_repo.append_event(
            _event(f"evt_{i:02d}", fired_at=NOW + timedelta(seconds=i))
        )
    events = await alert_repo.list_events(limit=50)
    assert len(events) == 10
    assert events[0].id == "evt_14"
    assert events[-1].id == "evt_05"
