"""Phase 17C.1 — Alert MVP evaluator + service tests.

Covers:

* pure evaluator: posture-band crossing, confidence drop, cooldown gate,
  symbol mismatch no-op, baseline missing no-op, default threshold
* service round-trip: add → evaluate → fire → list events → cooldown
  blocks duplicate → re-anchored baseline tracks moves from new fire
* per-tenant rule cap
* recent-events ``since`` cursor
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from app.intelligence.alerts import (
    AlertRule,
    AlertRuleCreate,
    AlertService,
    DEFAULT_CONFIDENCE_THRESHOLD,
    DEFAULT_COOLDOWN_SECONDS,
    InMemoryAlertRepository,
    evaluate_rule,
)
from app.intelligence.alerts.service import AlertRuleLimitError
from app.intelligence.portfolio.posture.schemas import (
    MarketPosture,
    PostureComponents,
)


NOW = datetime(2026, 4, 26, 12, 0, 0, tzinfo=timezone.utc)


def _posture(*, posture: str = "buy", confidence: float = 0.74, symbol: str = "AAPL") -> MarketPosture:
    return MarketPosture(
        symbol=symbol,
        asset_class="equities",
        posture=posture,  # type: ignore[arg-type]
        posture_label=posture.title(),
        tilt=0.42,
        effective_tilt=0.31,
        confidence=confidence,
        components=PostureComponents(
            technical=0.5,
            semantic=0.3,
            macro=None,
            uncertainty=round(1.0 - confidence, 4),
        ),
        drivers=[],
        caveats=[],
        freshness_seconds=180,
        as_of=NOW,
        notes=[],
        provider="alphavantage",
        provider_health="live",
        semantic_pressure=None,
    )


def _rule(
    *,
    kind: str = "posture_band_change",
    baseline_posture: str | None = "neutral",
    baseline_confidence: float | None = None,
    threshold: float | None = None,
    cooldown_seconds: int = DEFAULT_COOLDOWN_SECONDS,
    last_fired_at: datetime | None = None,
    enabled: bool = True,
    symbol: str = "AAPL",
) -> AlertRule:
    return AlertRule(
        id="alrt_test",
        name="Test rule",
        kind=kind,  # type: ignore[arg-type]
        symbol=symbol,
        asset_class="equities",
        threshold=threshold,
        cooldown_seconds=cooldown_seconds,
        enabled=enabled,
        created_at=NOW - timedelta(hours=1),
        baseline_posture=baseline_posture,  # type: ignore[arg-type]
        baseline_confidence=baseline_confidence,
        baseline_at=NOW - timedelta(hours=1),
        last_evaluated_at=None,
        last_fired_at=last_fired_at,
    )


# ---------------------------------------------------------------------------
# pure evaluator
# ---------------------------------------------------------------------------


def test_band_change_fires_when_posture_moves() -> None:
    event = evaluate_rule(_rule(baseline_posture="neutral"), _posture(posture="buy"), NOW)
    assert event is not None
    assert event.delta.kind == "posture_band_change"
    assert event.delta.from_value == "neutral"
    assert event.delta.to_value == "buy"
    assert event.delta.magnitude == 1.0
    assert "neutral to buy" in event.delta.summary
    assert event.triggering_posture.posture == "buy"


def test_band_change_no_op_when_posture_unchanged() -> None:
    assert evaluate_rule(_rule(baseline_posture="buy"), _posture(posture="buy"), NOW) is None


def test_band_change_distance_uses_band_index() -> None:
    event = evaluate_rule(
        _rule(baseline_posture="strong_sell"), _posture(posture="strong_buy"), NOW
    )
    assert event is not None
    assert event.delta.magnitude == 4.0


def test_confidence_drop_fires_when_below_threshold() -> None:
    rule = _rule(
        kind="confidence_drop",
        baseline_posture=None,
        baseline_confidence=0.74,
        threshold=0.30,
    )
    event = evaluate_rule(rule, _posture(confidence=0.40), NOW)
    assert event is not None
    assert event.delta.kind == "confidence_drop"
    assert event.delta.from_value == "74%"
    assert event.delta.to_value == "40%"
    assert event.delta.magnitude == pytest.approx(0.34)


def test_confidence_drop_no_op_when_drop_below_threshold() -> None:
    rule = _rule(
        kind="confidence_drop",
        baseline_posture=None,
        baseline_confidence=0.74,
        threshold=0.30,
    )
    assert evaluate_rule(rule, _posture(confidence=0.50), NOW) is None


def test_confidence_drop_uses_default_threshold_when_none() -> None:
    rule = _rule(
        kind="confidence_drop",
        baseline_posture=None,
        baseline_confidence=0.80,
        threshold=None,
    )
    # 0.80 → 0.40 = 0.40 drop, default threshold is 0.30 → fires.
    assert evaluate_rule(rule, _posture(confidence=0.40), NOW) is not None
    # 0.80 → 0.55 = 0.25 drop, below default → no fire.
    assert evaluate_rule(rule, _posture(confidence=0.55), NOW) is None
    # Sanity: confirm constant.
    assert DEFAULT_CONFIDENCE_THRESHOLD == 0.30


def test_cooldown_gate_blocks_within_window() -> None:
    rule = _rule(
        baseline_posture="neutral",
        last_fired_at=NOW - timedelta(seconds=10),
        cooldown_seconds=60,
    )
    assert evaluate_rule(rule, _posture(posture="buy"), NOW) is None


def test_cooldown_gate_passes_after_window() -> None:
    rule = _rule(
        baseline_posture="neutral",
        last_fired_at=NOW - timedelta(seconds=120),
        cooldown_seconds=60,
    )
    assert evaluate_rule(rule, _posture(posture="buy"), NOW) is not None


def test_disabled_rule_never_fires() -> None:
    rule = _rule(baseline_posture="neutral", enabled=False)
    assert evaluate_rule(rule, _posture(posture="buy"), NOW) is None


def test_symbol_mismatch_is_a_no_op() -> None:
    rule = _rule(baseline_posture="neutral", symbol="MSFT")
    assert evaluate_rule(rule, _posture(posture="buy", symbol="AAPL"), NOW) is None


def test_missing_baseline_is_a_no_op() -> None:
    rule = _rule(baseline_posture=None)
    assert evaluate_rule(rule, _posture(posture="buy"), NOW) is None
    rule_conf = _rule(kind="confidence_drop", baseline_posture=None, baseline_confidence=None)
    assert evaluate_rule(rule_conf, _posture(confidence=0.1), NOW) is None


# ---------------------------------------------------------------------------
# service (with a fake posture service)
# ---------------------------------------------------------------------------


class FakePostureService:
    def __init__(self) -> None:
        self.queue: list[MarketPosture] = []
        self.calls: list[str] = []

    def push(self, posture: MarketPosture) -> None:
        self.queue.append(posture)

    async def build_for_symbol(self, symbol, *, asset_class="unknown", as_of=None):
        self.calls.append(symbol)
        if not self.queue:
            return _posture(symbol=symbol)
        return self.queue.pop(0)


def _service(fake: FakePostureService, *, max_rules: int = 50) -> AlertService:
    return AlertService(
        repository=InMemoryAlertRepository(),
        posture_service=fake,  # type: ignore[arg-type]
        max_rules=max_rules,
    )


@pytest.mark.asyncio
async def test_add_rule_seeds_baseline_from_current_posture() -> None:
    fake = FakePostureService()
    fake.push(_posture(posture="neutral", confidence=0.6))
    service = _service(fake)

    rule = await service.add_rule(
        AlertRuleCreate(
            name="AAPL band",
            kind="posture_band_change",
            symbol="aapl",
            asset_class="equities",
        )
    )
    assert rule.symbol == "AAPL"
    assert rule.baseline_posture == "neutral"
    assert rule.baseline_confidence == 0.6


@pytest.mark.asyncio
async def test_evaluate_all_fires_persists_event_and_re_anchors_baseline() -> None:
    fake = FakePostureService()
    fake.push(_posture(posture="neutral", confidence=0.7))  # seed
    service = _service(fake)
    await service.add_rule(
        AlertRuleCreate(
            name="AAPL band",
            kind="posture_band_change",
            symbol="AAPL",
            asset_class="equities",
            cooldown_seconds=60,
        )
    )

    fake.push(_posture(posture="buy", confidence=0.7))
    fired = await service.evaluate_all()
    assert len(fired) == 1
    assert fired[0].delta.from_value == "neutral"
    assert fired[0].delta.to_value == "buy"

    events = await service.list_recent_events()
    assert len(events) == 1
    assert events[0].id == fired[0].id

    # Cooldown immediately blocks even though posture is still buy:
    fake.push(_posture(posture="buy", confidence=0.7))
    assert await service.evaluate_all() == []

    # After cooldown, the *baseline* is now buy (re-anchored), so a
    # repeat buy should not fire again — only a fresh move would.
    rules = await service.list_rules()
    rule = rules[0]
    rule.last_fired_at = NOW - timedelta(seconds=120)
    rule.cooldown_seconds = 60
    await service._repo.upsert_rule(rule)  # type: ignore[attr-defined]

    fake.push(_posture(posture="buy", confidence=0.7))
    assert await service.evaluate_all() == []


@pytest.mark.asyncio
async def test_evaluate_all_lazy_seeds_when_baseline_missing() -> None:
    fake = FakePostureService()
    fake.push(_posture(posture="neutral"))  # seed at create
    service = _service(fake)
    rule = await service.add_rule(
        AlertRuleCreate(
            name="AAPL",
            kind="posture_band_change",
            symbol="AAPL",
            asset_class="equities",
        )
    )
    # Wipe the baseline to simulate a creation-time seed failure.
    rule.baseline_posture = None
    await service._repo.upsert_rule(rule)  # type: ignore[attr-defined]

    fake.push(_posture(posture="neutral"))
    fired = await service.evaluate_all()
    assert fired == []

    rules = await service.list_rules()
    assert rules[0].baseline_posture == "neutral"


@pytest.mark.asyncio
async def test_per_tenant_cap_blocks_further_rules() -> None:
    fake = FakePostureService()
    for _ in range(5):
        fake.push(_posture(posture="neutral"))
    service = _service(fake, max_rules=2)
    await service.add_rule(
        AlertRuleCreate(
            name="r1", kind="posture_band_change", symbol="AAPL"
        )
    )
    await service.add_rule(
        AlertRuleCreate(
            name="r2", kind="posture_band_change", symbol="MSFT"
        )
    )
    with pytest.raises(AlertRuleLimitError):
        await service.add_rule(
            AlertRuleCreate(
                name="r3", kind="posture_band_change", symbol="GOOG"
            )
        )


@pytest.mark.asyncio
async def test_recent_events_since_cursor_filters_strictly_after() -> None:
    fake = FakePostureService()
    fake.push(_posture(posture="neutral"))  # seed
    service = _service(fake)
    await service.add_rule(
        AlertRuleCreate(
            name="r", kind="posture_band_change", symbol="AAPL", cooldown_seconds=60
        )
    )
    fake.push(_posture(posture="buy"))
    fired = await service.evaluate_all()
    assert len(fired) == 1
    cursor = fired[0].fired_at
    after = await service.list_recent_events(since=cursor)
    assert after == []
    before = await service.list_recent_events(
        since=cursor - timedelta(seconds=1)
    )
    assert len(before) == 1
