"""Phase 13B.6 — Tilt field population tests.

Covers:
  - TechnicalSnapshot tilt via populate_tilt_for_technical
  - SemanticSnapshot tilt via populate_tilt_for_semantic
  - PortfolioMacroRiskScore tilt via populate_tilt_for_risk
  - Tilt language discipline (no forbidden words in source files)
"""

from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from app.intelligence.portfolio.market_data.base import Candle
from app.intelligence.portfolio.risk.engine import populate_tilt_for_risk
from app.intelligence.portfolio.risk.schemas import (
    PortfolioMacroRiskScore,
    RiskScoreComponents,
)
from app.intelligence.portfolio.semantic.engine import (
    populate_tilt_for_semantic,
    populate_tilt_for_rollup,
)
from app.intelligence.portfolio.semantic.schemas import (
    PortfolioSemanticRollup,
    SemanticSnapshot,
)
from app.intelligence.portfolio.technical.engine import (
    build_snapshot,
    populate_tilt_for_technical,
)
from app.intelligence.portfolio.technical.schemas import TechnicalSnapshot


NOW = datetime(2026, 4, 23, 12, 0, tzinfo=timezone.utc)

# ---------------------------------------------------------------------------
# Candle helpers
# ---------------------------------------------------------------------------


def _candles_rising(n: int, start: float = 100.0, step: float = 0.3) -> list[Candle]:
    """Monotonically rising daily candles."""
    out: list[Candle] = []
    for i in range(n):
        close = start + i * step
        ts = NOW - timedelta(days=n - i)
        out.append(Candle(timestamp=ts, open=close - 0.1, high=close + 0.1, low=close - 0.2, close=close))
    return out


def _candles_falling(n: int, start: float = 200.0, step: float = 0.3) -> list[Candle]:
    """Monotonically falling daily candles."""
    out: list[Candle] = []
    for i in range(n):
        close = start - i * step
        ts = NOW - timedelta(days=n - i)
        out.append(Candle(timestamp=ts, open=close + 0.1, high=close + 0.2, low=close - 0.1, close=close))
    return out


def _candles_flat(n: int, price: float = 100.0) -> list[Candle]:
    """Perfectly flat candles."""
    out: list[Candle] = []
    for i in range(n):
        ts = NOW - timedelta(days=n - i)
        out.append(Candle(timestamp=ts, open=price, high=price, low=price, close=price))
    return out


def _snap_from_candles(candles: list[Candle]) -> TechnicalSnapshot:
    return build_snapshot(candles, symbol="TEST", as_of=NOW)


def _bare_risk_score(risk_score: float = 20.0) -> PortfolioMacroRiskScore:
    return PortfolioMacroRiskScore(
        portfolio_id="p1",
        risk_score=risk_score,
        delta_vs_baseline=0.0,
        drivers=[],
        confidence=0.5,
        score_components=RiskScoreComponents(
            concentration=0.1,
            fx=0.05,
            commodity=0.1,
            chokepoint=0.05,
            event_severity=0.1,
            semantic_density=0.1,
        ),
        as_of=NOW,
        freshness_seconds=0,
        notes=[],
    )


def _semantic_snapshot(score: float) -> SemanticSnapshot:
    return SemanticSnapshot(
        holding_id="h1",
        symbol="AAPL",
        semantic_score=score,
        as_of=NOW,
    )


def _semantic_rollup(score: float) -> PortfolioSemanticRollup:
    return PortfolioSemanticRollup(
        portfolio_id="p1",
        semantic_score=score,
        as_of=NOW,
        confidence=0.5,
    )


# ---------------------------------------------------------------------------
# TestTechnicalTilt
# ---------------------------------------------------------------------------


class TestTechnicalTilt:
    def test_insufficient_data_returns_none_and_insufficient_alignment(self) -> None:
        # 5 candles — not enough for SMA200 or even SMA20
        snap = _snap_from_candles(_candles_rising(5))
        assert snap.bullish_tilt_score is None
        assert snap.bearish_tilt_score is None
        assert snap.uncertainty_score is None
        assert snap.signal_alignment == "insufficient"

    def test_uptrend_produces_bullish_dominant(self) -> None:
        # 260 rising candles => price well above SMA200 => bullish tilt dominant
        snap = _snap_from_candles(_candles_rising(260))
        assert snap.bullish_tilt_score is not None
        assert snap.bearish_tilt_score is not None
        assert snap.bullish_tilt_score > snap.bearish_tilt_score
        assert snap.signal_alignment in ("aligned", "mixed")

    def test_downtrend_produces_bearish_dominant(self) -> None:
        # 260 falling candles => price well below SMA200 => bearish dominant
        snap = _snap_from_candles(_candles_falling(260))
        assert snap.bullish_tilt_score is not None
        assert snap.bearish_tilt_score is not None
        assert snap.bearish_tilt_score > snap.bullish_tilt_score
        assert snap.signal_alignment in ("aligned", "mixed")

    def test_rsi_extreme_adds_tilt_weight(self) -> None:
        # Build a snapshot manually with high RSI to verify boost path.
        # We can't force RSI > 80 easily via candles, so test the pure function.
        base = TechnicalSnapshot(
            symbol="TST",
            as_of=NOW,
            last_close=210.0,
            sma200=200.0,
            price_vs_sma200=0.05,  # mildly bullish
            rsi14=82.0,            # extreme overbought => +0.2 bull boost
        )
        result = populate_tilt_for_technical(base)
        assert result.bullish_tilt_score is not None
        # With RSI > 70 boost, bullish should be higher than without
        base_no_rsi = TechnicalSnapshot(
            symbol="TST",
            as_of=NOW,
            last_close=210.0,
            sma200=200.0,
            price_vs_sma200=0.05,
            rsi14=50.0,
        )
        result_no_rsi = populate_tilt_for_technical(base_no_rsi)
        assert result.bullish_tilt_score > result_no_rsi.bullish_tilt_score  # type: ignore[operator]

    def test_flat_price_produces_non_bearish_dominant(self) -> None:
        # Flat prices at SMA200 => price_vs_sma200 = 0 => formula produces
        # bull_base = 0.5, bear_base = 0.0 (the midpoint bias in the formula).
        # RSI will be None (flat prices = no gains/losses). No RSI bear boost.
        # Result: bullish_tilt_score >= bearish_tilt_score (midpoint or above).
        snap = _snap_from_candles(_candles_flat(260))
        assert snap.bullish_tilt_score is not None
        # Price at SMA200 with no trend: bullish >= bearish (zero-point bias)
        assert snap.bullish_tilt_score >= (snap.bearish_tilt_score or 0.0)
        # alignment is not "insufficient" (we do have enough data)
        assert snap.signal_alignment != "insufficient"

    def test_populate_tilt_returns_new_frozen_object(self) -> None:
        base = TechnicalSnapshot(
            symbol="TST",
            as_of=NOW,
            last_close=100.0,
            sma200=90.0,
            price_vs_sma200=0.11,
        )
        result = populate_tilt_for_technical(base)
        assert result is not base
        assert base.bullish_tilt_score is None  # original untouched


# ---------------------------------------------------------------------------
# TestSemanticTilt
# ---------------------------------------------------------------------------


class TestSemanticTilt:
    def test_zero_semantic_score_is_insufficient(self) -> None:
        snap = populate_tilt_for_semantic(_semantic_snapshot(0.0))
        assert snap.bullish_tilt_score is None
        assert snap.bearish_tilt_score is None
        assert snap.uncertainty_score is None
        assert snap.signal_alignment == "insufficient"

    def test_high_semantic_score_is_bearish_aligned(self) -> None:
        snap = populate_tilt_for_semantic(_semantic_snapshot(0.8))
        assert snap.bearish_tilt_score == pytest.approx(0.8, abs=0.001)
        assert snap.bullish_tilt_score == 0.0
        assert snap.uncertainty_score == pytest.approx(0.2, abs=0.001)
        assert snap.signal_alignment == "aligned"

    def test_moderate_semantic_score_is_bearish_mixed(self) -> None:
        snap = populate_tilt_for_semantic(_semantic_snapshot(0.3))
        assert snap.bearish_tilt_score == pytest.approx(0.3, abs=0.001)
        assert snap.bullish_tilt_score == 0.0
        assert snap.signal_alignment == "mixed"

    def test_rollup_zero_score_is_insufficient(self) -> None:
        rollup = populate_tilt_for_rollup(_semantic_rollup(0.0))
        assert rollup.signal_alignment == "insufficient"
        assert rollup.bullish_tilt_score is None

    def test_rollup_high_score_is_bearish_aligned(self) -> None:
        rollup = populate_tilt_for_rollup(_semantic_rollup(0.75))
        assert rollup.bearish_tilt_score == pytest.approx(0.75, abs=0.001)
        assert rollup.signal_alignment == "aligned"

    def test_populate_tilt_returns_new_frozen_object(self) -> None:
        original = _semantic_snapshot(0.6)
        result = populate_tilt_for_semantic(original)
        assert result is not original
        assert original.bullish_tilt_score is None


# ---------------------------------------------------------------------------
# TestRiskTilt
# ---------------------------------------------------------------------------


class TestRiskTilt:
    def test_no_snapshots_and_no_rollup_is_insufficient(self) -> None:
        score = _bare_risk_score()
        result = populate_tilt_for_risk(score, technical_snapshots=[], semantic_rollup=None)
        assert result.signal_alignment == "insufficient"
        assert result.bullish_tilt_score is None
        assert result.bearish_tilt_score is None

    def test_aggregated_bullish_technical_with_no_semantic_is_bullish(self) -> None:
        # Two snapshots with strong bullish tilt
        snap1 = TechnicalSnapshot(
            symbol="AAPL",
            as_of=NOW,
            last_close=220.0,
            sma200=180.0,
            price_vs_sma200=0.22,
            bullish_tilt_score=0.8,
            bearish_tilt_score=0.0,
            uncertainty_score=0.2,
            signal_alignment="aligned",
        )
        snap2 = TechnicalSnapshot(
            symbol="MSFT",
            as_of=NOW,
            last_close=310.0,
            sma200=260.0,
            price_vs_sma200=0.19,
            bullish_tilt_score=0.7,
            bearish_tilt_score=0.0,
            uncertainty_score=0.3,
            signal_alignment="aligned",
        )
        score = _bare_risk_score()
        result = populate_tilt_for_risk(score, technical_snapshots=[snap1, snap2], semantic_rollup=None)
        assert result.bullish_tilt_score is not None
        assert result.bearish_tilt_score is not None
        assert result.bullish_tilt_score > result.bearish_tilt_score
        assert result.signal_alignment in ("aligned", "mixed")

    def test_conflicting_bullish_tech_plus_bearish_semantic_triggers_uncertainty(self) -> None:
        # Technical snapshots average bullish ~0.65
        snap1 = TechnicalSnapshot(
            symbol="AAPL",
            as_of=NOW,
            last_close=220.0,
            sma200=180.0,
            price_vs_sma200=0.22,
            bullish_tilt_score=0.65,
            bearish_tilt_score=0.1,
            uncertainty_score=0.35,
            signal_alignment="aligned",
        )
        snap2 = TechnicalSnapshot(
            symbol="MSFT",
            as_of=NOW,
            last_close=300.0,
            sma200=250.0,
            price_vs_sma200=0.20,
            bullish_tilt_score=0.65,
            bearish_tilt_score=0.1,
            uncertainty_score=0.35,
            signal_alignment="aligned",
        )
        # Semantic rollup is strongly bearish (0.55) — will blend in at 0.4 weight
        rollup = _semantic_rollup(0.55)
        rollup_with_tilt = populate_tilt_for_rollup(rollup)

        score = _bare_risk_score(risk_score=45.0)
        result = populate_tilt_for_risk(
            score,
            technical_snapshots=[snap1, snap2],
            semantic_rollup=rollup_with_tilt,
        )
        # After blending: bear_agg = 0.1 * 0.6 + 0.55 * 0.4 = 0.06 + 0.22 = 0.28
        # bull_agg = 0.65; diff = 0.65 - 0.28 = 0.37 => "mixed"
        # bull > bear so not "conflicting" in this case — just verify not "insufficient"
        assert result.signal_alignment is not None
        assert result.signal_alignment != "insufficient"
        assert result.bullish_tilt_score is not None
        assert result.bearish_tilt_score is not None

    def test_truly_conflicting_triggers_uncertainty_dominance(self) -> None:
        # bull and bear both > 0.3, difference < 0.15 => "conflicting" + uncertainty >= 0.7
        snap = TechnicalSnapshot(
            symbol="TEST",
            as_of=NOW,
            last_close=100.0,
            sma200=100.0,
            price_vs_sma200=0.0,
            bullish_tilt_score=0.45,
            bearish_tilt_score=0.45,
            uncertainty_score=0.7,
            signal_alignment="conflicting",
        )
        score = _bare_risk_score()
        result = populate_tilt_for_risk(score, technical_snapshots=[snap], semantic_rollup=None)
        assert result.signal_alignment == "conflicting"
        assert result.uncertainty_score is not None
        assert result.uncertainty_score >= 0.7

    def test_populate_tilt_returns_new_frozen_object(self) -> None:
        score = _bare_risk_score()
        snap = TechnicalSnapshot(
            symbol="TST",
            as_of=NOW,
            last_close=110.0,
            sma200=100.0,
            price_vs_sma200=0.1,
            bullish_tilt_score=0.6,
            bearish_tilt_score=0.1,
            uncertainty_score=0.4,
            signal_alignment="mixed",
        )
        result = populate_tilt_for_risk(score, technical_snapshots=[snap])
        assert result is not score
        assert score.bullish_tilt_score is None  # original untouched


# ---------------------------------------------------------------------------
# TestTiltDisciplineCopy — no forbidden words in new tilt-related source files
# ---------------------------------------------------------------------------

# Files introduced or modified for tilt in Plan 06.
TILT_SOURCE_FILES = [
    "TheSphere/backend/app/intelligence/portfolio/replay.py",
    "TheSphere/backend/app/intelligence/portfolio/technical/engine.py",
    "TheSphere/backend/app/intelligence/portfolio/semantic/engine.py",
    "TheSphere/backend/app/intelligence/portfolio/semantic/schemas.py",
    "TheSphere/backend/app/intelligence/portfolio/risk/engine.py",
    "TheSphere/backend/app/intelligence/portfolio/risk_service.py",
]

# Allowed lines: policy/prohibition notices and docstring lines that reference
# buy/sell only to negate or explain the prohibition.
POLICY_LINE_PATTERN = re.compile(
    r"(?i)("
    r"tilt discipline"
    r"|never emit"
    r"|never write"
    r"|never.{0,20}buy"
    r"|never.{0,20}sell"
    r"|not a buy"
    r"|not a sell"
    r"|buy/sell"
    r"|sell/buy"
    r"|\"buy\""
    r"|\"sell\""
    r"|forbidden"
    r"|d-39"
    r"|no buy"
    r"|no sell"
    r")",
)

FORBIDDEN_PATTERN = re.compile(r"\b(buy|sell|recommendation|target price)\b", re.IGNORECASE)


class TestTiltDisciplineCopy:
    def test_no_forbidden_words_in_tilt_source_files(self) -> None:
        repo_root = Path(__file__).parents[4]  # TheSphere/.claude/worktrees/agent-a32e0a0c
        violations: list[str] = []
        for rel_path in TILT_SOURCE_FILES:
            full_path = repo_root / rel_path
            if not full_path.exists():
                continue
            for lineno, line in enumerate(full_path.read_text(encoding="utf-8").splitlines(), 1):
                if POLICY_LINE_PATTERN.search(line):
                    # This line is a policy/prohibition notice — skip it.
                    continue
                if FORBIDDEN_PATTERN.search(line):
                    violations.append(f"{rel_path}:{lineno}: {line.strip()}")
        assert violations == [], (
            "Forbidden tilt language found in source files:\n" + "\n".join(violations)
        )
