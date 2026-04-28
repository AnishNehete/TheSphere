"""Pure deterministic posture engine — Phase 17A.1.

Composes four sub-scores into a final posture call:

  1. ``score_technical``       — derived from a ``TechnicalSnapshot``
  2. ``score_semantic_pressure`` — bearish-leaning event pressure for a symbol
  3. ``score_macro_proxy``     — light macro/fundamental proxy from regime + vol
  4. ``score_uncertainty``     — combined confidence damping factor

Pure-function: no I/O, no LLM, no hidden state. Given the same inputs the
engine produces the same ``MarketPosture`` — that determinism is what the
17A.2 agent layer will rely on. The agent may synthesize *language* around
these numbers, but it must never invent them.

Honest-language rules (D-39):

* posture is bounded; no free-form recommendation strings escape
* every non-zero sub-score becomes a driver with a rationale and at least
  one source (``technical_score``, semantic event ids, regime + vol)
* low confidence damps the call toward Neutral — we never publish a
  Strong Buy from thin data
"""

from __future__ import annotations

import math
import statistics
from datetime import datetime, timezone
from typing import Iterable, Sequence

from app.intelligence.portfolio.posture.schemas import (
    AssetClass,
    MarketPosture,
    PostureComponents,
    PostureDriver,
    PostureLabel,
    ProviderHealth,
)
from app.intelligence.portfolio.posture.symbol_semantic import (
    SymbolSemanticPressure,
    score_symbol_semantic_pressure,
)
from app.intelligence.portfolio.semantic.engine import RECENCY_HALF_LIFE_HOURS
from app.intelligence.portfolio.technical.schemas import TechnicalSnapshot
from app.intelligence.schemas import SignalEvent


# ---------------------------------------------------------------------------
# Documented constants. Weights MUST sum to 1.0 — assertion at import time.
# ---------------------------------------------------------------------------

DEFAULT_POSTURE_WEIGHTS: dict[str, float] = {
    "technical": 0.45,
    "semantic": 0.30,
    "macro": 0.25,
}
assert abs(sum(DEFAULT_POSTURE_WEIGHTS.values()) - 1.0) < 1e-9, (
    "DEFAULT_POSTURE_WEIGHTS must sum to 1.0"
)

# Posture band thresholds against ``effective_tilt`` (already confidence-
# damped). Symmetric by design.
POSTURE_BAND_THRESHOLDS: dict[str, float] = {
    "strong_buy": 0.50,
    "buy": 0.20,
    "neutral_max": 0.20,
    "sell": -0.20,
    "strong_sell": -0.50,
}

# When confidence drops below this floor we force-pin Neutral and add a
# caveat. The agent layer may quote raw ``tilt`` for context, but the
# *call* must reflect the data thinness.
LOW_CONFIDENCE_FLOOR = 0.25

# Realized vol annualized above this counts as "elevated regime" and
# adds a caveat. Same threshold for all asset classes for now (D-25-style
# documented constant); FX-specific tuning is a 17A.2 concern.
ELEVATED_VOL_THRESHOLD = 0.40

# Minimum candle history before the technical sub-score is treated as
# trustworthy. Mirrors the SMA200 reservation in the technical engine.
MIN_CANDLES_FOR_TRUST = 60

# Stale-data caveat threshold (4 hours).
STALE_FRESHNESS_SECONDS = 4 * 3600


_POSTURE_LABEL_TEXT: dict[PostureLabel, str] = {
    "strong_sell": "Strong Sell",
    "sell": "Sell",
    "neutral": "Neutral",
    "buy": "Buy",
    "strong_buy": "Strong Buy",
}


# ---------------------------------------------------------------------------
# Sub-score: technical
# ---------------------------------------------------------------------------


def score_technical(
    snapshot: TechnicalSnapshot | None, *, candle_count: int
) -> tuple[float | None, str, list[str]]:
    """Derive a signed ``[-1, 1]`` technical sub-score.

    Returns ``(value, rationale, caveats)``. ``value`` is ``None`` when
    the snapshot has no usable data — the caller must surface this as
    "insufficient" rather than a fabricated zero.
    """

    caveats: list[str] = []

    if snapshot is None or snapshot.technical_score is None:
        return None, "Technical engine returned no signal (insufficient history).", caveats

    # technical_score lives in [0, 1]; map to signed [-1, 1].
    base = (snapshot.technical_score - 0.5) * 2.0

    # Trend regime adjustment (small, additive).
    regime_delta = 0.0
    if snapshot.trend_regime == "recovering":
        regime_delta = 0.15
    elif snapshot.trend_regime == "breaking_down":
        regime_delta = -0.15
    elif snapshot.trend_regime == "above_200":
        regime_delta = 0.05
    elif snapshot.trend_regime == "below_200":
        regime_delta = -0.05
    elif snapshot.trend_regime == "above_50":
        # Phase 19E.4 — SMA50 fallback: smaller magnitude reflects
        # weaker confidence than a 200d-confirmed regime read.
        regime_delta = 0.025
    elif snapshot.trend_regime == "below_50":
        regime_delta = -0.025

    raw = max(-1.0, min(1.0, base + regime_delta))

    # Stretched bands cap the magnitude so we never call Strong Buy on
    # an obviously overbought tape (or Strong Sell on capitulation).
    if snapshot.technical_signal_level == "stretched_long":
        raw = min(raw, 0.6)
        caveats.append("Stretched long — RSI/price-vs-SMA200 in overbought band.")
    elif snapshot.technical_signal_level == "stretched_short":
        raw = max(raw, -0.6)
        caveats.append("Stretched short — RSI/price-vs-SMA200 in oversold band.")

    # Vol regime caveat (does not move the score directly; surfaces context).
    vol = snapshot.realized_vol_30d
    if vol is not None and vol >= ELEVATED_VOL_THRESHOLD:
        caveats.append(
            f"Realized 30d vol annualized = {vol:.2f} (elevated regime)."
        )

    # Thin-history caveat — sub-score still emitted, but flagged.
    if candle_count < MIN_CANDLES_FOR_TRUST:
        caveats.append(
            f"Thin candle history ({candle_count} bars) — technical signal damped."
        )

    rationale = _technical_rationale(snapshot)
    return round(raw, 3), rationale, caveats


def _technical_rationale(snapshot: TechnicalSnapshot) -> str:
    parts: list[str] = []
    if snapshot.price_vs_sma200 is not None:
        parts.append(f"price-vs-SMA200 = {snapshot.price_vs_sma200:+.2%}")
    if snapshot.rsi14 is not None:
        parts.append(f"RSI14 = {snapshot.rsi14:.1f}")
    parts.append(f"regime = {snapshot.trend_regime}")
    parts.append(f"level = {snapshot.technical_signal_level}")
    return "; ".join(parts)


# ---------------------------------------------------------------------------
# Sub-score: semantic / event pressure (bearish-leaning, like 13B.3)
# ---------------------------------------------------------------------------


def _symbol_matches_event(symbol: str, asset_class: AssetClass, event: SignalEvent) -> bool:
    """Honest matching rules — the engine fails closed.

    A symbol matches an event when at least one of these is true:

    * ``event.properties["symbol"]`` equals ``symbol`` (case-insensitive)
    * ``event.properties["pair"]`` equals ``symbol`` (FX)
    * ``event.title`` mentions the symbol as a whole-word token
    * an entity name equals or contains the symbol token
    """

    upper = symbol.upper().strip()
    if not upper:
        return False
    props = event.properties or {}
    if str(props.get("symbol", "")).upper() == upper:
        return True
    if asset_class == "fx" and str(props.get("pair", "")).upper().replace("/", "") == upper:
        return True
    title = (event.title or "").upper()
    if upper in title.split():  # whole-word
        return True
    for ent in event.entities:
        ent_name = (ent.name or "").upper()
        if ent_name == upper or upper in ent_name.split():
            return True
    return False


def score_semantic_pressure(
    symbol: str,
    asset_class: AssetClass,
    events: Sequence[SignalEvent],
    *,
    as_of: datetime | None = None,
) -> tuple[float | None, str, list[str], float]:
    """Symbol-level event pressure → signed sub-score in ``[-1, 0]``.

    Returns ``(value, rationale, evidence_ids, sample_confidence)``.

    Operational-risk events are bearish-leaning by definition: stress
    erodes expected P&L. We therefore negate the magnitude to return a
    signed sub-score (zero or negative). ``sample_confidence`` is the
    average source-reliability × event-confidence — the caller folds it
    into the uncertainty calculation.
    """

    as_of_ts = as_of or datetime.now(timezone.utc)

    matched: list[tuple[SignalEvent, float]] = []
    for event in events:
        if not _symbol_matches_event(symbol, asset_class, event):
            continue
        age_h = _age_hours(event, as_of_ts)
        recency = math.exp(-age_h / RECENCY_HALF_LIFE_HOURS)
        reliability = _avg_reliability(event)
        contrib = (
            float(event.severity_score)
            * recency
            * reliability
            * float(event.confidence)
        )
        matched.append((event, contrib))

    if not matched:
        return 0.0, "No symbol-relevant events in current corpus.", [], 0.0

    matched.sort(key=lambda p: p[1], reverse=True)
    matched = matched[:25]
    total = sum(c for _, c in matched)
    pressure = min(1.0, total)

    # Bearish-leaning: stress events push negative.
    signed = -pressure

    sample_conf = (
        statistics.mean(_avg_reliability(e) * float(e.confidence) for e, _ in matched)
        if matched
        else 0.0
    )

    evidence_ids = [e.id for e, _ in matched][:10]
    rationale = (
        f"{len(matched)} symbol-relevant event(s); aggregate pressure "
        f"{pressure:.2f} (bearish-leaning)."
    )
    return round(signed, 3), rationale, evidence_ids, round(sample_conf, 3)


def _age_hours(event: SignalEvent, as_of: datetime) -> float:
    reference = event.ingested_at or event.source_timestamp or as_of
    delta = (as_of - reference).total_seconds()
    return max(0.0, delta / 3600.0)


def _avg_reliability(event: SignalEvent) -> float:
    if not event.sources:
        return 0.5
    return statistics.mean(s.reliability for s in event.sources)


# ---------------------------------------------------------------------------
# Sub-score: macro / fundamental proxy
# ---------------------------------------------------------------------------


def score_macro_proxy(
    snapshot: TechnicalSnapshot | None,
    *,
    asset_class: AssetClass,
) -> tuple[float | None, str, list[str]]:
    """Light macro proxy in ``[-1, 1]``.

    True fundamentals (rate-sensitivity, earnings, sector flows) are out
    of scope for 17A.1 — wiring them in is a 17A.2 / later concern. For
    now we surface a *transparent* proxy:

    * regime contribution from the trend bucket
    * elevated-vol penalty (high vol erodes signal magnitude)
    * asset-class adjustment for FX (vol scaled differently)

    The rationale text states explicitly that this is a proxy.
    """

    caveats: list[str] = []

    if snapshot is None:
        return None, "Macro proxy unavailable (no technical snapshot).", caveats

    regime = snapshot.trend_regime
    if regime == "insufficient_data":
        return None, "Macro proxy unavailable (regime undetermined).", caveats

    regime_value = {
        "above_200": 0.30,
        "below_200": -0.30,
        "recovering": 0.50,
        "breaking_down": -0.50,
        # Phase 19E.4 — SMA50 fallback: half the SMA200 magnitude so
        # the macro proxy remains honest about thinner trend evidence.
        "above_50": 0.15,
        "below_50": -0.15,
    }.get(regime, 0.0)

    vol = snapshot.realized_vol_30d
    vol_threshold = ELEVATED_VOL_THRESHOLD
    if asset_class == "fx":
        # FX realized vol is structurally lower than equities — a 0.40
        # FX vol is wild. Scale the threshold down so the regime read
        # is fair across asset classes.
        vol_threshold = 0.20

    raw = regime_value
    if vol is not None and vol >= vol_threshold:
        # High-vol regime: reduce the magnitude of the macro call by half.
        raw *= 0.5
        caveats.append(
            f"Macro proxy damped — realized vol {vol:.2f} ≥ {vol_threshold:.2f}."
        )

    rationale = (
        f"Regime '{regime}' macro proxy {regime_value:+.2f}"
        + (f"; vol {vol:.2f} damping" if vol is not None and vol >= vol_threshold else "")
        + " (proxy only — not full fundamentals)."
    )
    return round(max(-1.0, min(1.0, raw)), 3), rationale, caveats


# ---------------------------------------------------------------------------
# Sub-score: uncertainty / confidence
# ---------------------------------------------------------------------------


def score_uncertainty(
    *,
    technical: float | None,
    semantic: float | None,
    macro: float | None,
    candle_count: int,
    semantic_sample_confidence: float,
    freshness_seconds: int | None,
) -> tuple[float, list[str]]:
    """Compute ``uncertainty ∈ [0, 1]`` and a list of caveat strings.

    Higher = less confident. The combiner converts this to confidence as
    ``1.0 - uncertainty`` and damps the final tilt.
    """

    caveats: list[str] = []
    uncertainty_terms: list[float] = []

    # 1. Missing sub-scores increase uncertainty.
    missing = sum(1 for v in (technical, semantic, macro) if v is None)
    uncertainty_terms.append(min(1.0, missing * 0.3))
    if missing >= 2:
        caveats.append("Two or more sub-engines reported insufficient data.")

    # 2. Thin candle history.
    if candle_count <= 0:
        uncertainty_terms.append(0.6)
    elif candle_count < MIN_CANDLES_FOR_TRUST:
        uncertainty_terms.append(0.3)

    # 3. Stale data.
    if freshness_seconds is not None and freshness_seconds > STALE_FRESHNESS_SECONDS:
        uncertainty_terms.append(0.2)
        caveats.append(
            f"Provider freshness {freshness_seconds}s exceeds {STALE_FRESHNESS_SECONDS}s threshold."
        )

    # 4. Conflicting technical vs semantic.
    if technical is not None and semantic is not None:
        if technical > 0.3 and semantic < -0.3:
            uncertainty_terms.append(0.25)
            caveats.append(
                "Technical bullish but semantic event pressure is bearish — conflicting signals."
            )

    # 5. Low semantic-sample confidence (when we have any matches).
    if semantic is not None and semantic != 0.0:
        if semantic_sample_confidence < 0.4:
            uncertainty_terms.append(0.15)
            caveats.append(
                f"Semantic sample confidence {semantic_sample_confidence:.2f} is low."
            )

    # Combine: uncertainty saturates at 1.0.
    if not uncertainty_terms:
        return 0.1, caveats  # Floor uncertainty: never claim 0%.
    combined = min(1.0, sum(uncertainty_terms))
    return round(max(0.1, combined), 3), caveats


# ---------------------------------------------------------------------------
# Combiner & classifier
# ---------------------------------------------------------------------------


def _safe_weight_sum(
    technical: float | None,
    semantic: float | None,
    macro: float | None,
    weights: dict[str, float],
) -> tuple[float, dict[str, float]]:
    """Renormalize weights across present sub-scores so a missing engine
    does not bias the call toward zero."""

    contributions = {
        "technical": (technical, weights["technical"]),
        "semantic": (semantic, weights["semantic"]),
        "macro": (macro, weights["macro"]),
    }
    present = {k: w for k, (v, w) in contributions.items() if v is not None}
    total_w = sum(present.values())
    if total_w <= 0:
        return 0.0, {}
    renormed = {k: w / total_w for k, w in present.items()}
    tilt = sum(contributions[k][0] * renormed[k] for k in renormed)  # type: ignore[operator]
    return round(max(-1.0, min(1.0, tilt)), 3), renormed


def classify_posture(effective_tilt: float) -> PostureLabel:
    """Map ``effective_tilt`` to a bounded posture label.

    Symmetric thresholds — a +0.6 tilt is Strong Buy, -0.6 is Strong Sell.
    """

    t = max(-1.0, min(1.0, effective_tilt))
    if t >= POSTURE_BAND_THRESHOLDS["strong_buy"]:
        return "strong_buy"
    if t >= POSTURE_BAND_THRESHOLDS["buy"]:
        return "buy"
    if t > POSTURE_BAND_THRESHOLDS["sell"]:
        return "neutral"
    if t > POSTURE_BAND_THRESHOLDS["strong_sell"]:
        return "sell"
    return "strong_sell"


def build_posture(
    *,
    symbol: str,
    asset_class: AssetClass,
    technical_snapshot: TechnicalSnapshot | None,
    candle_count: int,
    events: Iterable[SignalEvent],
    freshness_seconds: int | None = None,
    as_of: datetime | None = None,
    weights: dict[str, float] = DEFAULT_POSTURE_WEIGHTS,
    provider: str = "unconfigured",
    provider_health: ProviderHealth = "unconfigured",
) -> MarketPosture:
    """Compose all four sub-scores into a final ``MarketPosture``.

    The engine never raises on missing inputs — it returns a Neutral
    posture with caveats so the UI/agent layer always has a valid record
    to display.

    Phase 17A.2: blends a richer :class:`SymbolSemanticPressure` so the
    consumer (chart dock, agent layer) can show direction, confidence,
    and event-level drivers behind the single signed semantic scalar.
    """

    as_of_ts = as_of or datetime.now(timezone.utc)
    normalized_symbol = symbol.upper().strip()
    if not normalized_symbol:
        raise ValueError("symbol is required")
    event_list = list(events)

    # 1. Technical sub-score.
    tech_value, tech_rationale, tech_caveats = score_technical(
        technical_snapshot, candle_count=candle_count
    )

    # 2. Semantic — both the legacy signed scalar (for the combiner)
    # AND the richer typed pressure object (for the contract).
    semantic_pressure = score_symbol_semantic_pressure(
        normalized_symbol, asset_class, event_list, as_of=as_of_ts
    )
    sem_value: float | None
    sem_rationale: str
    sem_evidence: list[str]
    sem_sample_conf = semantic_pressure.semantic_confidence
    if semantic_pressure.matched_event_count == 0:
        sem_value = 0.0
        sem_rationale = "No symbol-relevant events in current corpus."
        sem_evidence = []
    else:
        sem_value = semantic_pressure.semantic_score
        direction_word = semantic_pressure.semantic_direction
        sem_rationale = (
            f"{semantic_pressure.matched_event_count} event(s) matched; "
            f"net pressure {sem_value:+.2f} ({direction_word})."
        )
        sem_evidence = [
            d.event_id for d in semantic_pressure.top_semantic_drivers
        ]

    # 3. Macro proxy sub-score.
    macro_value, macro_rationale, macro_caveats = score_macro_proxy(
        technical_snapshot, asset_class=asset_class
    )

    # 4. Uncertainty / confidence.
    uncertainty, unc_caveats = score_uncertainty(
        technical=tech_value,
        semantic=sem_value,
        macro=macro_value,
        candle_count=candle_count,
        semantic_sample_confidence=sem_sample_conf,
        freshness_seconds=freshness_seconds,
    )
    confidence = round(max(0.0, 1.0 - uncertainty), 3)

    # Combiner: renormalize weights to present sub-scores, then damp.
    tilt, _renormed = _safe_weight_sum(tech_value, sem_value, macro_value, weights)
    effective_tilt = round(tilt * confidence, 3)

    # Low-confidence floor: pin Neutral and surface caveat.
    notes: list[str] = []
    posture: PostureLabel
    if confidence < LOW_CONFIDENCE_FLOOR:
        posture = "neutral"
        notes.append(
            f"Confidence {confidence:.2f} below floor {LOW_CONFIDENCE_FLOOR:.2f} — pinned Neutral."
        )
    else:
        posture = classify_posture(effective_tilt)

    # Build drivers (skip None / zero contributions).
    drivers: list[PostureDriver] = []
    if tech_value is not None:
        drivers.append(
            PostureDriver(
                component="technical",
                label="Technical engine",
                signed_contribution=round(tech_value * weights["technical"], 4),
                rationale=tech_rationale,
                evidence_ids=[],
            )
        )
    if sem_value is not None and sem_value != 0.0:
        drivers.append(
            PostureDriver(
                component="semantic",
                label="Event pressure",
                signed_contribution=round(sem_value * weights["semantic"], 4),
                rationale=sem_rationale,
                evidence_ids=sem_evidence,
            )
        )
    if macro_value is not None:
        drivers.append(
            PostureDriver(
                component="macro",
                label="Macro proxy",
                signed_contribution=round(macro_value * weights["macro"], 4),
                rationale=macro_rationale,
                evidence_ids=[],
            )
        )
    drivers.sort(key=lambda d: abs(d.signed_contribution), reverse=True)

    components = PostureComponents(
        technical=tech_value,
        semantic=sem_value,
        macro=macro_value,
        uncertainty=uncertainty,
    )

    caveats = list(tech_caveats) + list(macro_caveats) + list(unc_caveats)
    # Surface the symbol-semantic engine's own caveats so the operator
    # sees thin-sample / balanced-direction notes inside the same envelope.
    for c in semantic_pressure.semantic_caveats:
        if c not in caveats:
            caveats.append(c)
    if not event_list:
        caveats.append("No live event corpus available — semantic side is dark.")
    if provider_health == "unsupported":
        caveats.append(
            f"Provider {provider!r} does not cover this symbol's asset class — "
            f"posture is technical-/macro-blind."
        )
    elif provider_health == "degraded":
        caveats.append(
            f"Provider {provider!r} is degraded — "
            f"market-data freshness may be reduced."
        )

    return MarketPosture(
        symbol=normalized_symbol,
        asset_class=asset_class,
        posture=posture,
        posture_label=_POSTURE_LABEL_TEXT[posture],
        tilt=tilt,
        effective_tilt=effective_tilt,
        confidence=confidence,
        components=components,
        drivers=drivers,
        caveats=caveats,
        freshness_seconds=freshness_seconds,
        as_of=as_of_ts,
        notes=notes,
        provider=provider,
        provider_health=provider_health,
        semantic_pressure=semantic_pressure,
    )


__all__ = [
    "DEFAULT_POSTURE_WEIGHTS",
    "ELEVATED_VOL_THRESHOLD",
    "LOW_CONFIDENCE_FLOOR",
    "MIN_CANDLES_FOR_TRUST",
    "POSTURE_BAND_THRESHOLDS",
    "STALE_FRESHNESS_SECONDS",
    "build_posture",
    "classify_posture",
    "score_macro_proxy",
    "score_semantic_pressure",
    "score_technical",
    "score_uncertainty",
]
