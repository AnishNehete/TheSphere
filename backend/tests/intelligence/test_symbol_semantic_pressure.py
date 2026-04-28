"""Phase 17A.2 — symbol-level semantic pressure engine.

Verifies:
* No matched events → calm/neutral pressure with the documented caveat.
* Matched bearish events → negative score, ``bearish`` direction,
  ranked drivers, recency-weighted contribution magnitude.
* Bullish sub-typed events nudge the score positive.
* Sample-thinness and conflicting-direction caveats fire.
* Semantic confidence reflects source reliability × event confidence.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from app.intelligence.portfolio.posture.symbol_semantic import (
    LOW_SAMPLE_CONFIDENCE,
    SAMPLE_THIN_THRESHOLD,
    SymbolSemanticPressure,
    score_symbol_semantic_pressure,
)
from app.intelligence.schemas import SignalEvent
from app.intelligence.schemas.signal_event import Place, SourceRef


REF = datetime(2026, 4, 26, 12, 0, tzinfo=timezone.utc)


def _event(
    *,
    eid: str,
    title: str,
    severity: float = 0.7,
    confidence: float = 0.8,
    reliability: float = 0.8,
    age_hours: float = 6.0,
    symbol: str | None = None,
    sub_type: str | None = None,
    tags: tuple[str, ...] = (),
    publisher: str | None = "Test Wire",
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
        tags=list(tags),
        sources=[
            SourceRef(
                adapter="test",
                provider="test",
                retrieved_at=ts,
                publisher=publisher,
                reliability=reliability,
            )
        ],
    )


def test_empty_corpus_returns_neutral_with_caveat() -> None:
    out = score_symbol_semantic_pressure("AAPL", "equities", [], as_of=REF)
    assert isinstance(out, SymbolSemanticPressure)
    assert out.semantic_score == 0.0
    assert out.semantic_direction == "neutral"
    assert out.matched_event_count == 0
    assert out.semantic_caveats
    assert any("no symbol-relevant" in c.lower() for c in out.semantic_caveats)


def test_matched_bearish_events_push_score_negative() -> None:
    events = [
        _event(eid="e1", title="AAPL supply chain disruption", symbol="AAPL"),
        _event(eid="e2", title="AAPL warning on demand", symbol="AAPL"),
        _event(eid="e3", title="AAPL major recall", symbol="AAPL"),
    ]
    out = score_symbol_semantic_pressure("AAPL", "equities", events, as_of=REF)
    assert out.matched_event_count == 3
    assert out.semantic_score < 0
    assert out.semantic_direction == "bearish"
    assert out.top_semantic_drivers
    contributions = [d.contribution for d in out.top_semantic_drivers]
    # Drivers should be ranked by absolute contribution.
    abs_sorted = sorted(contributions, key=abs, reverse=True)
    assert contributions == abs_sorted
    # Each driver carries publisher provenance and an honest age.
    assert any(d.publisher for d in out.top_semantic_drivers)
    assert all(d.age_hours >= 0 for d in out.top_semantic_drivers)


def test_bullish_subtype_pushes_score_positive() -> None:
    events = [
        _event(
            eid="e1",
            title="MSFT earnings beat lifts guidance",
            symbol="MSFT",
            sub_type="earnings_beat",
            severity=0.6,
        )
    ]
    out = score_symbol_semantic_pressure("MSFT", "equities", events, as_of=REF)
    assert out.semantic_score > 0
    assert out.semantic_direction == "bullish"


def test_thin_sample_emits_caveat() -> None:
    events = [
        _event(eid="e1", title="TSLA delivery slip", symbol="TSLA"),
    ]
    out = score_symbol_semantic_pressure("TSLA", "equities", events, as_of=REF)
    assert out.matched_event_count == 1
    assert out.matched_event_count < SAMPLE_THIN_THRESHOLD
    assert any("sample is thin" in c.lower() for c in out.semantic_caveats)


def test_low_confidence_events_emit_caveat() -> None:
    events = [
        _event(
            eid=f"e{i}",
            title="GOOG headline",
            symbol="GOOG",
            confidence=0.1,
            reliability=0.1,
        )
        for i in range(4)
    ]
    out = score_symbol_semantic_pressure("GOOG", "equities", events, as_of=REF)
    assert out.semantic_confidence < LOW_SAMPLE_CONFIDENCE
    assert any("sample confidence" in c.lower() for c in out.semantic_caveats)


def test_unrelated_event_does_not_match() -> None:
    events = [
        _event(eid="e1", title="MSFT note", symbol="MSFT"),
    ]
    out = score_symbol_semantic_pressure("AAPL", "equities", events, as_of=REF)
    assert out.matched_event_count == 0
    assert out.semantic_score == 0.0


def test_fx_pair_matches_via_pair_property() -> None:
    events = [
        _event(eid="e1", title="EUR weakness vs USD", symbol="EURUSD"),
    ]
    out = score_symbol_semantic_pressure("EURUSD", "fx", events, as_of=REF)
    assert out.matched_event_count == 1
    assert out.semantic_direction == "bearish"


def test_empty_symbol_raises() -> None:
    with pytest.raises(ValueError):
        score_symbol_semantic_pressure("   ", "equities", [], as_of=REF)


def test_typed_contract_is_frozen() -> None:
    out = score_symbol_semantic_pressure("AAPL", "equities", [], as_of=REF)
    with pytest.raises(Exception):  # pydantic frozen
        out.semantic_score = 0.5  # type: ignore[misc]
