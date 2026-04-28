"""Vendor-agnostic market data provider package.

Import everything downstream needs from here. Provider implementations
(Polygon, Alpha Vantage, Synthetic) only exist to satisfy this Protocol.
"""

from app.intelligence.portfolio.market_data.alpha_vantage import (
    AlphaVantageMarketDataProvider,
)
from app.intelligence.portfolio.market_data.base import (
    Candle,
    CandleRange,
    ChainedMarketDataProvider,
    HoldingValuation,
    MarketDataProvider,
    PortfolioValuationSummary,
    PriceSnapshot,
    build_market_data_provider,
)
from app.intelligence.portfolio.market_data.cache import (
    CachedMarketDataProvider,
)
from app.intelligence.portfolio.market_data.polygon import (
    PolygonMarketDataProvider,
)
from app.intelligence.portfolio.market_data.synthetic import (
    SyntheticMarketDataProvider,
)


__all__ = [
    "AlphaVantageMarketDataProvider",
    "CachedMarketDataProvider",
    "Candle",
    "CandleRange",
    "ChainedMarketDataProvider",
    "HoldingValuation",
    "MarketDataProvider",
    "PolygonMarketDataProvider",
    "PortfolioValuationSummary",
    "PriceSnapshot",
    "SyntheticMarketDataProvider",
    "build_market_data_provider",
]
