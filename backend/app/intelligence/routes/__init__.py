"""HTTP routes exposing the live intelligence backbone."""

from app.intelligence.alerts.routes import router as alerts_router
from app.intelligence.investigations.routes import router as investigations_router
from app.intelligence.routes.calibration import router as calibration_router
from app.intelligence.routes.intelligence import router as intelligence_router
from app.intelligence.routes.portfolios import router as portfolios_router

__all__ = [
    "alerts_router",
    "calibration_router",
    "intelligence_router",
    "investigations_router",
    "portfolios_router",
]
