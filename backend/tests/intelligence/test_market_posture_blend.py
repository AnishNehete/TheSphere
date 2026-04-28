"""Phase 17A.2 — posture blend integration tests.

Covers the new fields the engine returns:
* ``semantic_pressure`` — symbol-level pressure object with direction +
  drivers + caveats, present for any successful posture call.
* ``provider`` / ``provider_health`` — surface honest provider posture
  (live / degraded / unsupported / unconfigured) on the typed contract.
* Engine still pins Neutral when ``provider_health="unsupported"`` adds
  an explicit caveat without overpowering low-confidence evidence.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from app.intelligence.portfolio.market_data.base import Candle
from app.intelligence.portfolio.posture.engine import build_posture
from app.intelligence.portfolio.posture.symbol_semantic import (
    SymbolSemanticPressure,
)
from app.intelligence.portfolio.technical.engine import build_snapshot
from app.intelligence.schemas import SignalEvent
from app.intelligence.schemas.signal_event import Place, SourceRef


REF = datetime(2026, 4, 26, 12, 0, tzinfo=timezone.utc)


def _candles_from_closes(closes: list[float]) -> list[Candle]:
    origin = datetime(2025, 1, 1, tzinfo=timezone.utc)
    return [
        Candle(
            timestamp=origin + timedelta(days=i),
            open=close,
            high=close * 1.01,
            low=close * 0.99,
            close=close,
            volume=1_000_000.0,
        )
        for i, close in enumerate(closes)
    ]


def _bullish_snap():
    closes = [100.0 + i * 0.5 for i in range(260)]
    return build_snapshot(_candles_from_closes(closes), symbol="TEST", as_of=REF)


def _event(
    eid: str,
    *,
    title: str,
    symbol: str | None = None,
    sub_type: str | None = None,
    severity: float = 0.8,
    confidence: float = 0.85,
    reliability: float = 0.85,
    age_hours: float = 4.0,
) -> SignalEvent:
    ts = REF - timedelta(hours=age_hours)
    return SignalEvent(
        id=eid,
        dedupe_key=eid,
        type="news",
        sub_type=sub_type,
        title=title,
        summary=title,
        severity_score=severity,
        confidence=confidence,
        ingested_at=ts,
        source_timestamp=ts,
        place=Place(country_code="USA"),
        properties={"symbol": symbol} if symbol else {},
        sources=[
            SourceRef(
                adapter="test",
                provider="test",
                retrieved_at=ts,
                reliability=reliability,
            )
        ],
    )


def test_posture_envelope_carries_symbol_semantic_pressure() -> None:
    snap = _bullish_snap()
    events = [
        _event("e1", title="TEST major recall", symbol="TEST"),
        _event("e2", title="TEST supply chain hit", symbol="TEST"),
        _event("e3", title="TEST guidance cut", symbol="TEST"),
    ]
    posture = build_posture(
        symbol="TEST",
        asset_class="equities",
        technical_snapshot=snap,
        candle_count=260,
        events=events,
        freshness_seconds=60,
        as_of=REF,
        provider="alphavantage",
        provider_health="live",
    )
    assert isinstance(posture.semantic_pressure, SymbolSemanticPressure)
    assert posture.semantic_pressure.matched_event_count == 3
    assert posture.semantic_pressure.semantic_direction == "bearish"
    assert posture.semantic_pressure.top_semantic_drivers
    # The blended driver list still references those event ids.
    sem_driver = next(
        d for d in posture.drivers if d.component == "semantic"
    )
    assert any(eid in sem_driver.evidence_ids for eid in ["e1", "e2", "e3"])


def test_posture_provider_unsupported_adds_caveat_and_skips_technical() -> None:
    posture = build_posture(
        symbol="ES",
        asset_class="futures",
        technical_snapshot=None,
        candle_count=0,
        events=[],
        freshness_seconds=None,
        as_of=REF,
        provider="alphavantage+cache",
        provider_health="unsupported",
    )
    assert posture.provider == "alphavantage+cache"
    assert posture.provider_health == "unsupported"
    assert any(
        "does not cover" in c.lower() for c in posture.caveats
    ), "Expected an explicit unsupported-asset-class caveat"
    # No data at all → engine pins Neutral.
    assert posture.posture == "neutral"


def test_posture_provider_degraded_emits_caveat() -> None:
    posture = build_posture(
        symbol="AAPL",
        asset_class="equities",
        technical_snapshot=None,
        candle_count=0,
        events=[],
        freshness_seconds=None,
        as_of=REF,
        provider="alphavantage+cache",
        provider_health="degraded",
    )
    assert posture.provider_health == "degraded"
    assert any(
        "degraded" in c.lower() for c in posture.caveats
    )


def test_low_confidence_blocks_overpowering_semantic() -> None:
    """Bearish semantic pressure but no technical → low confidence floor pins Neutral.

    Prevents a thin news cluster from overpowering an otherwise dark
    posture. The semantic pressure object is still returned so the agent
    layer can reason about it, but the *call* is honest.
    """

    events = [
        _event("e1", title="ZNGA emerging risk note", symbol="ZNGA"),
    ]
    posture = build_posture(
        symbol="ZNGA",
        asset_class="equities",
        technical_snapshot=None,
        candle_count=0,
        events=events,
        freshness_seconds=None,
        as_of=REF,
        provider="alphavantage+cache",
        provider_health="live",
    )
    assert posture.posture == "neutral"
    assert posture.semantic_pressure is not None
    assert posture.semantic_pressure.matched_event_count == 1
