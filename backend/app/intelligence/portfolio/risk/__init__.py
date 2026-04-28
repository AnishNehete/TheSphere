"""Portfolio macro risk engine (Phase 13B.4).

Re-exports the pure engine + frozen pydantic schemas so the service /
runtime / route layers can import from a single stable surface.
"""

from app.intelligence.portfolio.risk.engine import (
    DEFAULT_COMPONENT_WEIGHTS,
    MIN_BASELINE_SAMPLES,
    BASELINE_WINDOW,
    blend_to_risk_score,
    build_risk_score,
    compute_bucket_severity,
    compute_concentration,
    compute_event_severity,
    compute_fx,
    compute_semantic_density,
    delta_vs_baseline,
    rank_drivers,
)
from app.intelligence.portfolio.risk.schemas import (
    PortfolioMacroRiskScore,
    RiskDriver,
    RiskScoreComponents,
)

__all__ = [
    "BASELINE_WINDOW",
    "DEFAULT_COMPONENT_WEIGHTS",
    "MIN_BASELINE_SAMPLES",
    "PortfolioMacroRiskScore",
    "RiskDriver",
    "RiskScoreComponents",
    "blend_to_risk_score",
    "build_risk_score",
    "compute_bucket_severity",
    "compute_concentration",
    "compute_event_severity",
    "compute_fx",
    "compute_semantic_density",
    "delta_vs_baseline",
    "rank_drivers",
]
