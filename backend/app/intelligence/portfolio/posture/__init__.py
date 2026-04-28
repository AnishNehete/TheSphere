"""Deterministic market-symbol posture engine (Phase 17A.1 / 17A.2).

Composes the existing technical + semantic engines into a symbol-level
posture in {strong_sell, sell, neutral, buy, strong_buy}, with confidence,
drivers, and caveats. Pure-function — no LLM, no I/O. Designed to feed a
later agentic orchestration layer (Phase 17A.3) where an LLM may
synthesize the *explanation* but never the underlying numbers.

Phase 17A.2 adds the typed :class:`SymbolSemanticPressure` block: a
richer semantic surface (direction, top event drivers, caveats) that
the chart dock and agent layer can consume without re-deriving from raw
events.
"""

from app.intelligence.portfolio.posture.narrative import (
    MarketNarrative,
    NarrativeResponse,
    NarrativeSource,
    PostureAlignmentCheck,
    build_narrative_deterministic,
    build_narrative_with_anthropic,
)
from app.intelligence.portfolio.posture.engine import (
    DEFAULT_POSTURE_WEIGHTS,
    POSTURE_BAND_THRESHOLDS,
    build_posture,
    classify_posture,
    score_macro_proxy,
    score_semantic_pressure,
    score_technical,
    score_uncertainty,
)
from app.intelligence.portfolio.posture.schemas import (
    AssetClass,
    MarketPosture,
    PostureComponents,
    PostureDriver,
    PostureLabel,
    ProviderHealth,
)
from app.intelligence.portfolio.posture.symbol_semantic import (
    SemanticDirection,
    SemanticEventDriver,
    SymbolSemanticPressure,
    score_symbol_semantic_pressure,
)

__all__ = [
    "AssetClass",
    "DEFAULT_POSTURE_WEIGHTS",
    "MarketNarrative",
    "MarketPosture",
    "NarrativeResponse",
    "NarrativeSource",
    "POSTURE_BAND_THRESHOLDS",
    "PostureAlignmentCheck",
    "PostureComponents",
    "PostureDriver",
    "PostureLabel",
    "ProviderHealth",
    "SemanticDirection",
    "SemanticEventDriver",
    "SymbolSemanticPressure",
    "build_narrative_deterministic",
    "build_narrative_with_anthropic",
    "build_posture",
    "classify_posture",
    "score_macro_proxy",
    "score_semantic_pressure",
    "score_symbol_semantic_pressure",
    "score_technical",
    "score_uncertainty",
]
