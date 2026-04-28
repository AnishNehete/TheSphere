"""Async wrapper over the pure posture engine.

Pulls candles from the configured ``MarketDataProvider``, builds a
``TechnicalSnapshot`` via the existing technical engine, samples the
recent event corpus from the ``EventRepository`` and feeds them into
``build_posture``. All I/O happens here so the engine itself stays
pure and easy to test.

Phase 17A.2: detects which provider is wired (Alpha Vantage primary,
Synthetic for offline, etc.), classifies asset-class support honestly,
and surfaces the provider id + health into the typed posture envelope.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Sequence

from app.intelligence.portfolio.market_data.alpha_vantage import (
    AlphaVantageMarketDataProvider,
)
from app.intelligence.portfolio.market_data.base import Candle, MarketDataProvider
from app.intelligence.portfolio.market_data.cache import CachedMarketDataProvider
from app.intelligence.portfolio.posture.engine import build_posture
from app.intelligence.portfolio.posture.schemas import (
    AssetClass,
    MarketPosture,
    ProviderHealth,
)
from app.intelligence.portfolio.technical.engine import build_snapshot
from app.intelligence.repositories.event_repository import EventRepository
from app.intelligence.schemas import SignalEvent


logger = logging.getLogger(__name__)


# Cap the corpus we feed the engine — we want recency, not breadth.
DEFAULT_EVENT_SAMPLE_LIMIT = 200


def _unwrap(provider: MarketDataProvider) -> MarketDataProvider:
    """Strip the cache wrapper so we can introspect the live provider."""

    if isinstance(provider, CachedMarketDataProvider):
        return provider.inner
    return provider


def _classify_provider_health(
    provider: MarketDataProvider | None, symbol: str
) -> ProviderHealth:
    """Decide whether the provider can credibly serve this symbol.

    The frontend uses this to render an honest "unavailable" affordance
    for asset classes Alpha Vantage doesn't cover (e.g. ES/NQ continuous
    futures), instead of pretending the chart is just empty for some
    other reason.
    """

    if provider is None:
        return "unconfigured"
    inner = _unwrap(provider)
    if isinstance(inner, AlphaVantageMarketDataProvider):
        kind = inner.classify_symbol(symbol)
        if kind == "futures":
            return "unsupported"
        return "live"
    return "live"


class MarketPostureService:
    """Async orchestrator for symbol-level posture calls."""

    def __init__(
        self,
        *,
        market_data_provider: MarketDataProvider | None,
        events: EventRepository,
    ) -> None:
        self._provider = market_data_provider
        self._events = events

    async def build_for_symbol(
        self,
        symbol: str,
        *,
        asset_class: AssetClass = "unknown",
        as_of: datetime | None = None,
        event_limit: int = DEFAULT_EVENT_SAMPLE_LIMIT,
    ) -> MarketPosture:
        """Compose a ``MarketPosture`` for the given symbol.

        Honest-degradation rules:

        * No provider → empty candles, no technical snapshot — engine
          returns a Neutral with caveats.
        * Provider raises → caught + logged; same neutral path.
        * No events → engine returns Neutral with "corpus dark" caveat.
        * Symbol shape unsupported by Alpha Vantage (e.g. continuous
          futures roots) → typed contract carries
          ``provider_health="unsupported"`` and the engine adds an
          explicit caveat.
        """

        normalized = symbol.upper().strip()
        if not normalized:
            raise ValueError("symbol is required")

        as_of_ts = as_of or datetime.now(timezone.utc)
        candles: list[Candle] = []
        provider_id = "unconfigured"
        provider_health: ProviderHealth = _classify_provider_health(
            self._provider, normalized
        )
        freshness_seconds: int | None = None

        if self._provider is not None:
            provider_id = self._provider.provider_id
            if provider_health == "unsupported":
                # Skip the upstream call entirely — we already know AV
                # cannot serve this asset class. This also conserves
                # quota for symbols the provider can actually answer.
                candles = []
            else:
                try:
                    candles = list(
                        await self._provider.get_candles(
                            normalized, range="1y", as_of=as_of,
                        )
                    )
                except Exception as exc:  # pragma: no cover - defensive
                    logger.warning(
                        "posture: provider %s raised on %s: %s",
                        provider_id,
                        normalized,
                        exc,
                    )
                    candles = []
                    provider_health = "degraded"

        snapshot = (
            build_snapshot(candles, symbol=normalized, as_of=as_of_ts)
            if candles
            else None
        )

        if candles:
            last_ts = candles[-1].timestamp
            if last_ts.tzinfo is None:
                last_ts = last_ts.replace(tzinfo=timezone.utc)
            freshness_seconds = max(
                0, int((as_of_ts - last_ts).total_seconds())
            )

        events = await self._sample_events(limit=event_limit, as_of=as_of_ts)

        return build_posture(
            symbol=normalized,
            asset_class=asset_class,
            technical_snapshot=snapshot,
            candle_count=len(candles),
            events=events,
            freshness_seconds=freshness_seconds,
            as_of=as_of_ts,
            provider=provider_id,
            provider_health=provider_health,
        )

    async def _sample_events(
        self, *, limit: int, as_of: datetime
    ) -> Sequence[SignalEvent]:
        """Pull a recency-biased sample of live events from the repository."""

        try:
            return await self._events.latest(limit=limit)
        except Exception as exc:  # pragma: no cover - defensive
            logger.warning("posture: event sampling failed: %s", exc)
            return []


__all__ = [
    "DEFAULT_EVENT_SAMPLE_LIMIT",
    "MarketPostureService",
]
