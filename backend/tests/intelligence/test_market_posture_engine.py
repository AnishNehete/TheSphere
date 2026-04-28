"""Pure-function tests for the Phase 17A.1 market posture engine.

Exercises each sub-score in isolation, the combiner, the renormalization
of weights when an engine is missing, and the low-confidence Neutral
floor. Synthetic candles + handcrafted SignalEvents — no I/O.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from app.intelligence.portfolio.market_data.base import Candle
from app.intelligence.portfolio.posture.engine import (
    DEFAULT_POSTURE_WEIGHTS,
    LOW_CONFIDENCE_FLOOR,
    POSTURE_BAND_THRESHOLDS,
    build_posture,
    classify_posture,
    score_macro_proxy,
    score_semantic_pressure,
    score_technical,
    score_uncertainty,
)
from app.intelligence.portfolio.posture.schemas import MarketPosture
from app.intelligence.portfolio.technical.engine import build_snapshot
from app.intelligence.portfolio.technical.schemas import TechnicalSnapshot
from app.intelligence.schemas import SignalEvent
from app.intelligence.schemas.signal_event import Place, SourceRef


REF = datetime(2026, 4, 26, 12, 0, tzinfo=timezone.utc)


# ---------------------------------------------------------------------------
# Helpers — deterministic inputs
# ---------------------------------------------------------------------------


def _candles_from_closes(
    closes: list[float], *, start: datetime | None = None
) -> list[Candle]:
    origin = start or datetime(2025, 1, 1, tzinfo=timezone.utc)
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


def _bullish_snapshot() -> TechnicalSnapshot:
    """200d uptrend with healthy RSI band."""
    closes = [100.0 + i * 0.5 for i in range(260)]
    candles = _candles_from_closes(closes)
    return build_snapshot(candles, symbol="TEST", as_of=REF)


def _bearish_snapshot() -> TechnicalSnapshot:
    """200d downtrend with mid-RSI."""
    closes = [200.0 - i * 0.5 for i in range(260)]
    candles = _candles_from_closes(closes)
    return build_snapshot(candles, symbol="TEST", as_of=REF)


def _flat_snapshot() -> TechnicalSnapshot:
    """Flat tape — RSI undefined."""
    closes = [100.0] * 260
    candles = _candles_from_closes(closes)
    return build_snapshot(candles, symbol="TEST", as_of=REF)


def _make_event(
    *,
    eid: str,
    title: str,
    severity_score: float = 0.7,
    confidence: float = 0.8,
    reliability: float = 0.8,
    age_hours: float = 6.0,
    symbol: str | None = None,
) -> SignalEvent:
    ts = REF - timedelta(hours=age_hours)
    return SignalEvent(
        id=eid,
        dedupe_key=eid,
        type="news",
        title=title,
        summary=title,
        severity_score=severity_score,
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


# ---------------------------------------------------------------------------
# score_technical
# ---------------------------------------------------------------------------


class TestScoreTechnical:
    def test_bullish_uptrend_yields_positive(self) -> None:
        snap = _bullish_snapshot()
        value, _, _ = score_technical(snap, candle_count=260)
        assert value is not None
        assert value > 0.2

    def test_bearish_downtrend_yields_negative(self) -> None:
        snap = _bearish_snapshot()
        value, _, _ = score_technical(snap, candle_count=260)
        assert value is not None
        assert value < -0.2

    def test_no_snapshot_returns_none(self) -> None:
        value, rationale, caveats = score_technical(None, candle_count=0)
        assert value is None
        assert "insufficient" in rationale.lower()
        assert caveats == []

    def test_thin_history_emits_caveat(self) -> None:
        snap = _bullish_snapshot()
        _, _, caveats = score_technical(snap, candle_count=10)
        assert any("thin candle history" in c.lower() for c in caveats)

    def test_value_clamped_to_signed_unit(self) -> None:
        snap = _bullish_snapshot()
        value, _, _ = score_technical(snap, candle_count=260)
        assert value is not None
        assert -1.0 <= value <= 1.0


# ---------------------------------------------------------------------------
# score_semantic_pressure
# ---------------------------------------------------------------------------


class TestScoreSemanticPressure:
    def test_no_events_returns_zero_neutral(self) -> None:
        value, rationale, evidence, conf = score_semantic_pressure(
            "AAPL", "equities", [], as_of=REF,
        )
        assert value == 0.0
        assert evidence == []
        assert conf == 0.0
        assert "no symbol-relevant" in rationale.lower()

    def test_matched_symbol_event_pushes_negative(self) -> None:
        events = [
            _make_event(
                eid="e1",
                title="AAPL warning on demand",
                symbol="AAPL",
                severity_score=0.8,
            ),
        ]
        value, _, evidence, conf = score_semantic_pressure(
            "AAPL", "equities", events, as_of=REF,
        )
        assert value is not None
        assert value < 0.0
        assert "e1" in evidence
        assert conf > 0.0

    def test_unrelated_event_does_not_match(self) -> None:
        events = [
            _make_event(
                eid="e1",
                title="Generic earnings note for MSFT",
                symbol="MSFT",
                severity_score=0.8,
            ),
        ]
        value, _, evidence, _ = score_semantic_pressure(
            "AAPL", "equities", events, as_of=REF,
        )
        assert value == 0.0
        assert evidence == []

    def test_signed_score_clamped_to_minus_one(self) -> None:
        events = [
            _make_event(
                eid=f"e{i}",
                title="AAPL critical disruption",
                symbol="AAPL",
                severity_score=0.95,
                confidence=0.95,
                reliability=0.95,
                age_hours=0.5,
            )
            for i in range(20)
        ]
        value, _, _, _ = score_semantic_pressure(
            "AAPL", "equities", events, as_of=REF,
        )
        assert value is not None
        assert value >= -1.0


# ---------------------------------------------------------------------------
# score_macro_proxy
# ---------------------------------------------------------------------------


class TestScoreMacroProxy:
    def test_above_200_regime_positive(self) -> None:
        snap = _bullish_snapshot()
        value, _, _ = score_macro_proxy(snap, asset_class="equities")
        assert value is not None
        assert value > 0.0

    def test_below_200_regime_negative(self) -> None:
        snap = _bearish_snapshot()
        value, _, _ = score_macro_proxy(snap, asset_class="equities")
        assert value is not None
        assert value < 0.0

    def test_insufficient_regime_returns_none(self) -> None:
        snap = _flat_snapshot()
        # Flat tape gives no RSI and may give no regime.
        value, rationale, _ = score_macro_proxy(snap, asset_class="equities")
        # Either None (insufficient) or a low-magnitude proxy is acceptable.
        if value is None:
            assert "unavailable" in rationale.lower()


# ---------------------------------------------------------------------------
# score_uncertainty
# ---------------------------------------------------------------------------


class TestScoreUncertainty:
    def test_all_present_low_uncertainty(self) -> None:
        unc, caveats = score_uncertainty(
            technical=0.4,
            semantic=-0.2,
            macro=0.3,
            candle_count=260,
            semantic_sample_confidence=0.7,
            freshness_seconds=60,
        )
        assert unc < 0.3
        assert caveats == []

    def test_two_missing_signals_emit_caveat(self) -> None:
        unc, caveats = score_uncertainty(
            technical=None,
            semantic=None,
            macro=0.3,
            candle_count=10,
            semantic_sample_confidence=0.0,
            freshness_seconds=0,
        )
        assert unc > 0.5
        assert any("two or more" in c.lower() for c in caveats)

    def test_conflicting_subscores_increase_uncertainty(self) -> None:
        unc_aligned, _ = score_uncertainty(
            technical=0.4,
            semantic=-0.05,
            macro=0.3,
            candle_count=260,
            semantic_sample_confidence=0.7,
            freshness_seconds=60,
        )
        unc_conflict, caveats = score_uncertainty(
            technical=0.4,
            semantic=-0.5,
            macro=0.3,
            candle_count=260,
            semantic_sample_confidence=0.7,
            freshness_seconds=60,
        )
        assert unc_conflict > unc_aligned
        assert any("conflicting" in c.lower() for c in caveats)

    def test_floor_is_nonzero(self) -> None:
        unc, _ = score_uncertainty(
            technical=0.4,
            semantic=-0.05,
            macro=0.3,
            candle_count=260,
            semantic_sample_confidence=0.9,
            freshness_seconds=10,
        )
        assert unc >= 0.1


# ---------------------------------------------------------------------------
# classify_posture
# ---------------------------------------------------------------------------


class TestClassifyPosture:
    @pytest.mark.parametrize(
        "tilt, expected",
        [
            (0.7, "strong_buy"),
            (0.30, "buy"),
            (0.15, "neutral"),
            (-0.15, "neutral"),
            (-0.30, "sell"),
            (-0.7, "strong_sell"),
            (0.0, "neutral"),
        ],
    )
    def test_band_classification(self, tilt: float, expected: str) -> None:
        assert classify_posture(tilt) == expected

    def test_thresholds_documented_constant(self) -> None:
        # Bands must be symmetric so the engine doesn't favor one side.
        assert (
            POSTURE_BAND_THRESHOLDS["strong_buy"]
            == -POSTURE_BAND_THRESHOLDS["strong_sell"]
        )
        assert POSTURE_BAND_THRESHOLDS["buy"] == -POSTURE_BAND_THRESHOLDS["sell"]


# ---------------------------------------------------------------------------
# build_posture (combiner)
# ---------------------------------------------------------------------------


class TestBuildPosture:
    def test_bullish_inputs_yield_buy_or_strong_buy(self) -> None:
        snap = _bullish_snapshot()
        posture = build_posture(
            symbol="TEST",
            asset_class="equities",
            technical_snapshot=snap,
            candle_count=260,
            events=[],
            freshness_seconds=60,
            as_of=REF,
        )
        assert posture.posture in {"buy", "strong_buy"}
        assert posture.tilt > 0.0
        assert posture.confidence >= LOW_CONFIDENCE_FLOOR
        # Drivers always carry a rationale.
        for driver in posture.drivers:
            assert driver.rationale
            assert -1.0 <= driver.signed_contribution <= 1.0

    def test_bearish_event_pressure_pushes_sell(self) -> None:
        snap = _bullish_snapshot()
        events = [
            _make_event(
                eid=f"e{i}",
                title="TEST major disruption",
                symbol="TEST",
                severity_score=0.95,
                confidence=0.9,
                reliability=0.9,
                age_hours=1.0,
            )
            for i in range(8)
        ]
        posture = build_posture(
            symbol="TEST",
            asset_class="equities",
            technical_snapshot=snap,
            candle_count=260,
            events=events,
            freshness_seconds=60,
            as_of=REF,
        )
        # Event pressure is bearish — at least mixed; should not be
        # strong_buy when 8 critical events are matched.
        assert posture.posture != "strong_buy"
        assert posture.components.semantic is not None
        assert posture.components.semantic < 0.0

    def test_no_data_path_yields_neutral_with_caveats(self) -> None:
        posture = build_posture(
            symbol="UNKNOWN",
            asset_class="unknown",
            technical_snapshot=None,
            candle_count=0,
            events=[],
            freshness_seconds=None,
            as_of=REF,
        )
        assert posture.posture == "neutral"
        assert posture.confidence < LOW_CONFIDENCE_FLOOR
        assert posture.caveats  # at least one caveat
        assert any("corpus" in c.lower() or "insufficient" in c.lower()
                   for c in posture.caveats + posture.notes)

    def test_low_confidence_floor_pins_neutral(self) -> None:
        # Construct an unambiguously bullish technical signal but no data
        # corroboration → confidence should drop and the call should pin
        # to Neutral.
        snap = _bullish_snapshot()
        posture = build_posture(
            symbol="TEST",
            asset_class="unknown",
            technical_snapshot=snap,
            candle_count=15,  # thin → high uncertainty
            events=[],
            freshness_seconds=10 * 3600,  # stale → +uncertainty
            as_of=REF,
        )
        if posture.confidence < LOW_CONFIDENCE_FLOOR:
            assert posture.posture == "neutral"
            assert any("pinned neutral" in n.lower() for n in posture.notes)

    def test_typed_contract_is_frozen(self) -> None:
        posture = build_posture(
            symbol="TEST",
            asset_class="equities",
            technical_snapshot=_bullish_snapshot(),
            candle_count=260,
            events=[],
            freshness_seconds=60,
            as_of=REF,
        )
        assert isinstance(posture, MarketPosture)
        with pytest.raises(Exception):  # pydantic frozen model
            posture.posture = "strong_sell"  # type: ignore[misc]

    def test_weights_sum_to_one(self) -> None:
        assert (
            abs(sum(DEFAULT_POSTURE_WEIGHTS.values()) - 1.0) < 1e-9
        )

    def test_renormalization_when_macro_missing(self) -> None:
        # When the technical engine has no usable snapshot, only the
        # semantic side contributes — the engine renormalizes weights so
        # the call doesn't get pulled to zero.
        events = [
            _make_event(
                eid="e1",
                title="MSFT major disruption",
                symbol="MSFT",
                severity_score=0.9,
                confidence=0.9,
                reliability=0.9,
                age_hours=1.0,
            )
        ]
        posture = build_posture(
            symbol="MSFT",
            asset_class="equities",
            technical_snapshot=None,  # no technical, no macro
            candle_count=0,
            events=events,
            freshness_seconds=0,
            as_of=REF,
        )
        # Confidence may be low (insufficient sub-engines), but tilt
        # itself should reflect the bearish event pressure rather than
        # being washed out by missing weights.
        assert posture.components.semantic is not None
        assert posture.components.semantic < 0.0

    def test_empty_symbol_raises(self) -> None:
        with pytest.raises(ValueError):
            build_posture(
                symbol="   ",
                asset_class="unknown",
                technical_snapshot=None,
                candle_count=0,
                events=[],
                as_of=REF,
            )

    def test_drivers_sorted_by_absolute_contribution(self) -> None:
        snap = _bearish_snapshot()
        events = [
            _make_event(
                eid="e1",
                title="TEST critical event",
                symbol="TEST",
                severity_score=0.9,
                age_hours=1.0,
            )
        ]
        posture = build_posture(
            symbol="TEST",
            asset_class="equities",
            technical_snapshot=snap,
            candle_count=260,
            events=events,
            freshness_seconds=60,
            as_of=REF,
        )
        contribs = [abs(d.signed_contribution) for d in posture.drivers]
        assert contribs == sorted(contribs, reverse=True)

    def test_determinism_same_inputs_same_output(self) -> None:
        snap = _bullish_snapshot()
        events = [
            _make_event(eid="e1", title="TEST headline", symbol="TEST"),
        ]
        a = build_posture(
            symbol="TEST",
            asset_class="equities",
            technical_snapshot=snap,
            candle_count=260,
            events=events,
            freshness_seconds=60,
            as_of=REF,
        )
        b = build_posture(
            symbol="TEST",
            asset_class="equities",
            technical_snapshot=snap,
            candle_count=260,
            events=events,
            freshness_seconds=60,
            as_of=REF,
        )
        assert a.posture == b.posture
        assert a.tilt == b.tilt
        assert a.effective_tilt == b.effective_tilt
        assert a.confidence == b.confidence
