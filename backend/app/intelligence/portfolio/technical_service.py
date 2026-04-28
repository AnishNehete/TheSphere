"""Orchestration layer for the Phase 13B.2 technical engine.

Fetches candles via a ``MarketDataProvider`` (the only I/O path) and
calls the pure engine once per holding. Per-symbol failures are isolated:
a single provider error produces a safe "no candle history" snapshot
rather than poisoning the whole portfolio response.

Concurrency is bounded by ``asyncio.Semaphore`` (default 8) so a
20-holding portfolio does not burst Polygon rate limits.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone

from app.intelligence.portfolio.market_data import (
    CandleRange,
    MarketDataProvider,
)
from app.intelligence.portfolio.repository import PortfolioRepository
from app.intelligence.portfolio.schemas import PortfolioRecord
from app.intelligence.portfolio.technical import (
    TechnicalSnapshot,
    build_snapshot,
)


logger = logging.getLogger(__name__)

DEFAULT_TECHNICAL_RANGE: CandleRange = "1y"
DEFAULT_CONCURRENCY = 8


class TechnicalSnapshotService:
    """Per-holding technical snapshot orchestration.

    Depends only on the ``MarketDataProvider`` Protocol — no Polygon /
    Alpha Vantage imports — so replay (13B.6) can swap the provider for
    a deterministic historical source without touching this file.
    """

    def __init__(
        self,
        *,
        repository: PortfolioRepository,
        provider: MarketDataProvider,
        candle_range: CandleRange = DEFAULT_TECHNICAL_RANGE,
        concurrency: int = DEFAULT_CONCURRENCY,
    ) -> None:
        self._repo = repository
        self._provider = provider
        self._range = candle_range
        self._sem = asyncio.Semaphore(max(1, concurrency))

    async def build_for_portfolio(
        self,
        portfolio_id: str,
        *,
        as_of: datetime | None = None,
    ) -> list[TechnicalSnapshot]:
        """Resolve the portfolio and build one snapshot per holding."""

        record = await self._repo.get_portfolio(portfolio_id)
        return await self._build_from_record(record, as_of=as_of)

    async def _build_from_record(
        self,
        record: PortfolioRecord,
        *,
        as_of: datetime | None,
    ) -> list[TechnicalSnapshot]:
        if not record.holdings:
            return []

        fallback_as_of = as_of or datetime.now(timezone.utc)

        async def _snap(symbol: str, currency: str) -> TechnicalSnapshot:
            async with self._sem:
                try:
                    candles = await self._provider.get_candles(
                        symbol, range=self._range, as_of=as_of
                    )
                except Exception as exc:  # pragma: no cover - adapter isolation
                    logger.warning(
                        "technical: get_candles failed for %s: %s", symbol, exc
                    )
                    candles = []
                return build_snapshot(
                    candles,
                    symbol=symbol,
                    as_of=fallback_as_of,
                    currency=currency,
                )

        coros = [_snap(h.symbol, h.currency) for h in record.holdings]
        return await asyncio.gather(*coros)


__all__ = [
    "DEFAULT_CONCURRENCY",
    "DEFAULT_TECHNICAL_RANGE",
    "TechnicalSnapshotService",
]
