"""MarketDataProvider Protocol + pydantic shapes + provider factory.

Phase 13B.1 — this module is the vendor-agnostic contract every downstream
slice (technical engine, chart, replay) talks to. Only provider
implementations import httpx / provider SDKs. Everything else imports
from here.

Shapes are ``ConfigDict(frozen=True)`` pydantic models so FastAPI can
serialize them straight through without a DTO layer.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Literal, Protocol, Sequence, runtime_checkable

from pydantic import BaseModel, ConfigDict, Field


logger = logging.getLogger(__name__)


CandleRange = Literal["1d", "5d", "1mo", "3mo", "6mo", "1y", "2y", "5y"]
# Mapping semantics (Polygon provider uses these as the window source):
#   1d  -> last trading day, minute aggs  (for intraday chart slice)
#   5d  -> last 5 trading days, hourly aggs
#   1mo -> last ~22 trading days, daily aggs
#   3mo, 6mo, 1y, 2y, 5y -> trailing calendar windows, daily aggs


class PriceSnapshot(BaseModel):
    """Latest price view of a symbol + provenance.

    ``price`` is ``None`` when the provider returned nothing. Callers must
    treat that as "no data" and surface it honestly — never fabricate a
    price.
    """

    model_config = ConfigDict(frozen=True)

    symbol: str
    price: float | None
    previous_close: float | None
    as_of: datetime
    currency: str = "USD"
    provider: str
    is_stale: bool = False
    staleness_seconds: float = 0.0


class Candle(BaseModel):
    """One OHLCV candle."""

    model_config = ConfigDict(frozen=True)

    timestamp: datetime
    open: float
    high: float
    low: float
    close: float
    volume: float = 0.0


class HoldingValuation(BaseModel):
    """Per-holding valuation derived from quantity + last price.

    All derived fields are ``| None`` so callers can surface "price missing"
    states without invented zeros.
    """

    model_config = ConfigDict(frozen=True)

    holding_id: str
    symbol: str
    last_price: float | None
    price_as_of: datetime | None
    market_value: float | None
    cost_basis: float | None
    unrealized_pnl: float | None
    unrealized_pnl_pct: float | None
    currency: str = "USD"
    is_stale: bool = False
    price_missing: bool = False


class PortfolioValuationSummary(BaseModel):
    """Rolled-up valuation view for a portfolio.

    ``weight_basis`` tells the analyst UI whether weights came from live
    market value, cost-basis fallback, or even-split fallback. The brief
    treats this as canonical.
    """

    model_config = ConfigDict(frozen=True)

    total_market_value: float | None
    total_cost_basis: float | None
    total_unrealized_pnl: float | None
    total_unrealized_pnl_pct: float | None
    price_coverage: float = Field(ge=0.0, le=1.0)
    stalest_price_as_of: datetime | None
    missing_price_symbols: list[str] = Field(default_factory=list)
    weight_basis: Literal[
        "market_value", "cost_basis_fallback", "even_split_fallback"
    ] = "market_value"
    provider: str = "polygon"
    generated_at: datetime


@runtime_checkable
class MarketDataProvider(Protocol):
    """Vendor-agnostic market data surface.

    Every downstream service (portfolio valuation, technical engine, chart,
    replay) depends only on this Protocol. Provider implementations live
    in ``polygon.py``, ``alpha_vantage.py``, ``synthetic.py``.
    """

    provider_id: str

    async def get_price_snapshot(
        self, symbol: str, *, as_of: datetime | None = None
    ) -> PriceSnapshot: ...

    async def get_previous_close(
        self, symbol: str, *, as_of: datetime | None = None
    ) -> float | None: ...

    async def get_snapshots(
        self, symbols: Sequence[str], *, as_of: datetime | None = None
    ) -> dict[str, PriceSnapshot]: ...

    async def get_candles(
        self,
        symbol: str,
        *,
        range: CandleRange = "1y",
        as_of: datetime | None = None,
    ) -> list[Candle]: ...

    async def aclose(self) -> None: ...


class ChainedMarketDataProvider:
    """Primary provider with a per-symbol fallback.

    For each symbol, tries ``primary`` first; if ``primary`` returns a
    snapshot with ``price=None`` (or raises) the ``fallback`` is called.
    This is the Polygon → AlphaVantage routing the runtime uses in prod.
    """

    def __init__(
        self,
        *,
        primary: MarketDataProvider,
        fallback: MarketDataProvider,
    ) -> None:
        self._primary = primary
        self._fallback = fallback
        self.provider_id = f"{primary.provider_id}+{fallback.provider_id}"

    async def get_price_snapshot(
        self, symbol: str, *, as_of: datetime | None = None
    ) -> PriceSnapshot:
        try:
            snapshot = await self._primary.get_price_snapshot(symbol, as_of=as_of)
            if snapshot.price is not None:
                return snapshot
        except Exception as exc:  # pragma: no cover - defensive
            logger.warning(
                "chained provider: primary %s raised for %s: %s",
                self._primary.provider_id,
                symbol,
                exc,
            )
        return await self._fallback.get_price_snapshot(symbol, as_of=as_of)

    async def get_previous_close(
        self, symbol: str, *, as_of: datetime | None = None
    ) -> float | None:
        try:
            primary_value = await self._primary.get_previous_close(
                symbol, as_of=as_of
            )
            if primary_value is not None:
                return primary_value
        except Exception as exc:  # pragma: no cover
            logger.warning(
                "chained provider: primary prev-close raised for %s: %s",
                symbol,
                exc,
            )
        return await self._fallback.get_previous_close(symbol, as_of=as_of)

    async def get_snapshots(
        self, symbols: Sequence[str], *, as_of: datetime | None = None
    ) -> dict[str, PriceSnapshot]:
        result: dict[str, PriceSnapshot] = {}
        for symbol in symbols:
            result[symbol] = await self.get_price_snapshot(symbol, as_of=as_of)
        return result

    async def get_candles(
        self,
        symbol: str,
        *,
        range: CandleRange = "1y",
        as_of: datetime | None = None,
    ) -> list[Candle]:
        try:
            candles = await self._primary.get_candles(
                symbol, range=range, as_of=as_of
            )
            if candles:
                return candles
        except Exception as exc:  # pragma: no cover
            logger.warning(
                "chained provider: primary candles raised for %s: %s", symbol, exc
            )
        return await self._fallback.get_candles(symbol, range=range, as_of=as_of)

    async def aclose(self) -> None:
        await self._primary.aclose()
        await self._fallback.aclose()


def build_market_data_provider(
    *,
    settings: "object | None" = None,
    primary: MarketDataProvider | None = None,
    fallback: MarketDataProvider | None = None,
    enable_cache: bool = True,
) -> MarketDataProvider:
    """Build the live market-data provider.

    Phase 19E.4 — Polygon re-enabled as a first-class primary. The
    technical engine needs >=200 daily candles for SMA200; Alpha Vantage
    free tier caps daily history at 100 (``outputsize=compact``), which
    forced both Technical and Macro sub-engines into the "insufficient
    data" branch on the posture card. Polygon's free tier serves up to
    2 years of daily aggs, so when its key is set we prefer it.

    Routing:
      * ``synthetic`` => SyntheticMarketDataProvider (uncached)
      * ``polygon`` => PolygonMarketDataProvider when key is set; chained
        with Alpha Vantage as fallback when both keys exist (so FX
        symbols and Polygon throttles still resolve cleanly)
      * ``alphavantage`` (default) => AlphaVantageMarketDataProvider
      * no key for the chosen provider => SyntheticMarketDataProvider
        with a warning

    Each live provider is wrapped by ``CachedMarketDataProvider`` unless
    ``enable_cache`` is False.

    ``primary`` / ``fallback`` kwargs exist for tests — when provided they
    short-circuit the env lookup.
    """

    # Test / DI fast-path. The chained provider is preserved for callers
    # that explicitly inject one; the production builder uses it too when
    # both Polygon and AV keys are configured.
    if primary is not None and fallback is not None:
        return ChainedMarketDataProvider(primary=primary, fallback=fallback)
    if primary is not None:
        return primary

    # Lazy imports to avoid circular refs.
    from app.intelligence.portfolio.market_data.alpha_vantage import (
        AlphaVantageMarketDataProvider,
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
    from app.settings import IntelligenceSettings, get_intelligence_settings

    active: IntelligenceSettings
    if settings is None:
        active = get_intelligence_settings()
    else:
        active = settings  # type: ignore[assignment]

    raw_choice = str(
        getattr(active, "market_data_provider", "alphavantage") or "alphavantage"
    ).lower()
    if raw_choice in {"alphavantage", "synthetic", "polygon"}:
        choice = raw_choice
    else:
        logger.warning(
            "market_data_provider=%s is unknown; defaulting to alphavantage.",
            raw_choice,
        )
        choice = "alphavantage"

    av_key = str(getattr(active, "alpha_vantage_api_key", "") or "") or str(
        getattr(active, "stocks_api_key", "") or ""
    )
    av_base = str(
        getattr(active, "alpha_vantage_base_url", "")
        or getattr(active, "stocks_base_url", "")
        or "https://www.alphavantage.co"
    )
    polygon_key = str(getattr(active, "polygon_api_key", "") or "")
    polygon_base = str(
        getattr(active, "polygon_base_url", "") or "https://api.polygon.io"
    )

    def _wrap(p: MarketDataProvider) -> MarketDataProvider:
        return p if not enable_cache else CachedMarketDataProvider(p)

    if choice == "synthetic":
        return SyntheticMarketDataProvider()

    if choice == "polygon":
        if not polygon_key:
            logger.warning(
                "market_data_provider=polygon but INTELLIGENCE_POLYGON_API_KEY "
                "is empty — falling back to alphavantage."
            )
            choice = "alphavantage"
        else:
            polygon_provider = PolygonMarketDataProvider(
                api_key=polygon_key, base_url=polygon_base
            )
            if av_key:
                # Chain: Polygon primary (deep history, sub-second
                # snapshots), AV fallback (covers FX and absorbs
                # Polygon throttles).
                logger.info(
                    "market_data_provider=polygon with alphavantage fallback chain."
                )
                av_provider = AlphaVantageMarketDataProvider(
                    api_key=av_key, base_url=av_base
                )
                return _wrap(
                    ChainedMarketDataProvider(
                        primary=polygon_provider, fallback=av_provider
                    )
                )
            logger.info("market_data_provider=polygon (no AV fallback configured).")
            return _wrap(polygon_provider)

    # alphavantage (default fall-through).
    if not av_key:
        logger.info(
            "market_data_provider=alphavantage but no API key — using synthetic"
        )
        return SyntheticMarketDataProvider()

    return _wrap(AlphaVantageMarketDataProvider(api_key=av_key, base_url=av_base))


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


__all__ = [
    "Candle",
    "CandleRange",
    "ChainedMarketDataProvider",
    "HoldingValuation",
    "MarketDataProvider",
    "PortfolioValuationSummary",
    "PriceSnapshot",
    "build_market_data_provider",
]
