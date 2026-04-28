"""Symbol-level semantic / news pressure engine — Phase 17A.2.

The 13B.3 ``score_holding`` engine scored a *holding's exposure
edges*. The 17A.1 ``score_semantic_pressure`` shaved that down to a
single signed scalar so the posture engine could blend it with the
technical side. Phase 17A.2 promotes the symbol-level semantic layer to
a first-class object that exposes:

* ``semantic_score``        — signed ``[-1, 1]`` aggregate pressure
* ``semantic_direction``    — bullish / bearish / neutral classification
* ``semantic_confidence``   — average source-reliability × event-confidence
* ``top_semantic_drivers``  — ranked event-level drivers with rationale
* ``semantic_caveats``      — honest qualifiers (sample thinness, stale corpus,
                              conflicting signals, throttle, etc.)
* ``matched_event_count``   — number of corpus events matched to the symbol
* ``recency_skew_hours``    — average age of contributing events

Operational-risk events are still bearish-leaning by definition — a
shipping disruption rarely improves expected P&L for a long position.
But the v2 engine also notices when an event explicitly carries an
upgrade / improvement signal (sub-types ``earnings_beat``,
``upgrade``, ``recovery``) and lets that nudge the score positive.
"""

from __future__ import annotations

import math
import statistics
from datetime import datetime, timezone
from typing import Iterable, Literal, Sequence

from pydantic import BaseModel, ConfigDict, Field

from app.intelligence.portfolio.posture.schemas import AssetClass
from app.intelligence.portfolio.semantic.engine import RECENCY_HALF_LIFE_HOURS
from app.intelligence.schemas import SignalEvent


SemanticDirection = Literal["bullish", "bearish", "neutral"]


# Documented constants. Same recency half-life as the holding-level engine
# so the two layers agree on what "recent" means.
DEFAULT_TOP_DRIVERS = 5
NEUTRAL_BAND = 0.05
SAMPLE_THIN_THRESHOLD = 3
LOW_SAMPLE_CONFIDENCE = 0.4
MAX_EVIDENCE_PER_DRIVER = 4

# Event sub-types we treat as bullish-leaning. Most operational-risk
# events still net negative — these are the documented exceptions.
_BULLISH_SUBTYPES: frozenset[str] = frozenset(
    {
        "earnings_beat",
        "guidance_raise",
        "upgrade",
        "rating_upgrade",
        "recovery",
        "ceasefire",
        "deal_close",
    }
)


class SemanticEventDriver(BaseModel):
    """One ranked event-level driver behind a symbol's semantic score."""

    model_config = ConfigDict(frozen=True)

    event_id: str
    title: str
    publisher: str | None = None
    severity_score: float = Field(ge=0.0, le=1.0)
    age_hours: float = Field(ge=0.0)
    direction: SemanticDirection
    contribution: float = Field(ge=-1.0, le=1.0)
    reliability: float = Field(ge=0.0, le=1.0)


class SymbolSemanticPressure(BaseModel):
    """Symbol-level news/event pressure — typed contract for posture blend."""

    model_config = ConfigDict(frozen=True)

    symbol: str
    asset_class: AssetClass = "unknown"

    semantic_score: float = Field(ge=-1.0, le=1.0)
    semantic_direction: SemanticDirection
    semantic_confidence: float = Field(ge=0.0, le=1.0)

    matched_event_count: int = Field(ge=0)
    recency_skew_hours: float | None = None

    top_semantic_drivers: list[SemanticEventDriver] = Field(default_factory=list)
    semantic_caveats: list[str] = Field(default_factory=list)


def score_symbol_semantic_pressure(
    symbol: str,
    asset_class: AssetClass,
    events: Sequence[SignalEvent],
    *,
    as_of: datetime | None = None,
    top_drivers: int = DEFAULT_TOP_DRIVERS,
) -> SymbolSemanticPressure:
    """Aggregate symbol-relevant events into a typed semantic pressure.

    Pure function: no I/O, no LLM. Same inputs always yield the same
    output, which is what the agent layer relies on. The function never
    raises on missing/empty inputs — it returns a calm/neutral pressure
    record with caveats so the UI always has something to render.
    """

    upper = symbol.upper().strip()
    if not upper:
        raise ValueError("symbol is required")
    as_of_ts = as_of or datetime.now(timezone.utc)

    matched = _match(upper, asset_class, events, as_of_ts)
    if not matched:
        return SymbolSemanticPressure(
            symbol=upper,
            asset_class=asset_class,
            semantic_score=0.0,
            semantic_direction="neutral",
            semantic_confidence=0.0,
            matched_event_count=0,
            recency_skew_hours=None,
            top_semantic_drivers=[],
            semantic_caveats=[
                "No symbol-relevant events in the current corpus."
            ],
        )

    bearish_total = 0.0
    bullish_total = 0.0
    confidences: list[float] = []
    ages: list[float] = []
    drivers: list[SemanticEventDriver] = []

    for event, contrib, age_h, direction, reliability in matched:
        if direction == "bearish":
            bearish_total += contrib
        elif direction == "bullish":
            bullish_total += contrib
        confidences.append(reliability * float(event.confidence))
        ages.append(age_h)
        drivers.append(
            SemanticEventDriver(
                event_id=event.id,
                title=_clip(event.title or event.id, 140),
                publisher=_pick_publisher(event),
                severity_score=round(float(event.severity_score), 3),
                age_hours=round(age_h, 2),
                direction=direction,
                contribution=round(contrib if direction != "bearish" else -contrib, 4),
                reliability=round(reliability, 3),
            )
        )

    bearish = min(1.0, bearish_total)
    bullish = min(1.0, bullish_total)

    # Net signed score in [-1, 1].
    net = round(bullish - bearish, 4)
    direction = _classify_direction(net)

    sample_conf = statistics.mean(confidences) if confidences else 0.0
    semantic_confidence = round(min(1.0, sample_conf), 3)

    drivers.sort(key=lambda d: abs(d.contribution), reverse=True)
    top = drivers[: max(1, top_drivers)]

    caveats = _build_caveats(
        matched_count=len(matched),
        bearish=bearish,
        bullish=bullish,
        confidence=semantic_confidence,
    )

    recency = round(statistics.mean(ages), 2) if ages else None

    return SymbolSemanticPressure(
        symbol=upper,
        asset_class=asset_class,
        semantic_score=net,
        semantic_direction=direction,
        semantic_confidence=semantic_confidence,
        matched_event_count=len(matched),
        recency_skew_hours=recency,
        top_semantic_drivers=top,
        semantic_caveats=caveats,
    )


# ---------------------------------------------------------------------------
# Internals
# ---------------------------------------------------------------------------


def _match(
    symbol: str,
    asset_class: AssetClass,
    events: Iterable[SignalEvent],
    as_of: datetime,
) -> list[tuple[SignalEvent, float, float, SemanticDirection, float]]:
    """Return ``[(event, contrib, age_hours, direction, reliability), ...]``."""

    out: list[tuple[SignalEvent, float, float, SemanticDirection, float]] = []
    for event in events:
        if not _symbol_matches_event(symbol, asset_class, event):
            continue
        age_h = _age_hours(event, as_of)
        recency = math.exp(-age_h / RECENCY_HALF_LIFE_HOURS)
        reliability = _avg_reliability(event)
        magnitude = (
            float(event.severity_score)
            * recency
            * reliability
            * float(event.confidence)
        )
        if magnitude <= 0:
            continue
        direction: SemanticDirection = (
            "bullish" if _is_bullish(event) else "bearish"
        )
        out.append((event, magnitude, age_h, direction, reliability))
    return out


def _symbol_matches_event(
    symbol: str, asset_class: AssetClass, event: SignalEvent
) -> bool:
    """Honest match — fail closed.

    Mirrors the rules from the 17A.1 ``score_semantic_pressure`` so the
    two layers agree on what "this event is about this symbol" means.
    """

    upper = symbol.upper().strip()
    if not upper:
        return False
    props = event.properties or {}
    if str(props.get("symbol", "")).upper() == upper:
        return True
    if asset_class == "fx":
        flat = str(props.get("pair", "")).upper().replace("/", "")
        if flat == upper:
            return True
    title = (event.title or "").upper()
    if upper in title.split():
        return True
    for ent in event.entities:
        ent_name = (ent.name or "").upper()
        if ent_name == upper or upper in ent_name.split():
            return True
    return False


def _is_bullish(event: SignalEvent) -> bool:
    sub = (event.sub_type or "").lower()
    if sub in _BULLISH_SUBTYPES:
        return True
    tags = {t.lower() for t in event.tags}
    if tags & _BULLISH_SUBTYPES:
        return True
    return False


def _classify_direction(net: float) -> SemanticDirection:
    if net > NEUTRAL_BAND:
        return "bullish"
    if net < -NEUTRAL_BAND:
        return "bearish"
    return "neutral"


def _build_caveats(
    *,
    matched_count: int,
    bearish: float,
    bullish: float,
    confidence: float,
) -> list[str]:
    caveats: list[str] = []
    if matched_count < SAMPLE_THIN_THRESHOLD:
        caveats.append(
            f"Only {matched_count} symbol-relevant event(s) — semantic sample is thin."
        )
    if confidence < LOW_SAMPLE_CONFIDENCE:
        caveats.append(
            f"Sample confidence {confidence:.2f} is below the {LOW_SAMPLE_CONFIDENCE:.2f} floor."
        )
    if bearish > 0 and bullish > 0 and abs(bullish - bearish) < 0.15:
        caveats.append(
            "Bearish and bullish event pressure are roughly balanced — no clear direction."
        )
    return caveats


def _age_hours(event: SignalEvent, as_of: datetime) -> float:
    reference = event.ingested_at or event.source_timestamp or as_of
    delta = (as_of - reference).total_seconds()
    return max(0.0, delta / 3600.0)


def _avg_reliability(event: SignalEvent) -> float:
    if not event.sources:
        return 0.5
    return statistics.mean(s.reliability for s in event.sources)


def _pick_publisher(event: SignalEvent) -> str | None:
    for src in event.sources:
        if src.publisher:
            return src.publisher
    return None


def _clip(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    return text[: limit - 1].rstrip() + "…"


# Resolve the forward-ref ``SymbolSemanticPressure`` on ``MarketPosture``
# now that this module is loaded. Doing it at import time keeps the
# typed contract usable without an explicit rebuild call from callers.
from app.intelligence.portfolio.posture.schemas import MarketPosture as _MarketPosture

_MarketPosture.model_rebuild(
    _types_namespace={"SymbolSemanticPressure": SymbolSemanticPressure}
)


__all__ = [
    "DEFAULT_TOP_DRIVERS",
    "LOW_SAMPLE_CONFIDENCE",
    "NEUTRAL_BAND",
    "SAMPLE_THIN_THRESHOLD",
    "SemanticDirection",
    "SemanticEventDriver",
    "SymbolSemanticPressure",
    "score_symbol_semantic_pressure",
]
