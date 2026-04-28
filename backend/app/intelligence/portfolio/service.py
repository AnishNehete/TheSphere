"""Portfolio service — thin orchestrator over repository + enrichment.

Routes call into this service so the persistence layer can swap (in-memory
→ Postgres) without touching the API surface. Brief composition is kept
in :class:`PortfolioBriefService` to keep this module focused on CRUD +
ingestion concerns.
"""

from __future__ import annotations

from datetime import datetime
from typing import Iterable


class HoldingNotInPortfolioError(LookupError):
    """Raised when a requested symbol is not part of the requested portfolio."""

from app.intelligence.portfolio.brief_service import PortfolioBriefService
from app.intelligence.portfolio.csv_import import CsvImportError, parse_holdings_csv
from app.intelligence.portfolio.replay import ReplayCursor
from app.intelligence.portfolio.enrichment import enrich_holding
from app.intelligence.portfolio.exposure_service import ExposureService
from app.intelligence.portfolio.market_data import (
    Candle,
    MarketDataProvider,
    PortfolioValuationSummary,
)
from app.intelligence.portfolio.repository import (
    PortfolioRepository,
    generate_id,
    now_utc,
)
from app.intelligence.portfolio.schemas import (
    Holding,
    HoldingInput,
    PortfolioBrief,
    PortfolioCreateRequest,
    PortfolioRecord,
    PortfolioUpdateRequest,
    Watchlist,
    WatchlistInput,
)
from app.intelligence.portfolio.risk import PortfolioMacroRiskScore
from app.intelligence.portfolio.risk_service import PortfolioRiskScoreService
from app.intelligence.portfolio.semantic import (
    PortfolioSemanticRollup,
    SemanticSnapshot,
)
from app.intelligence.portfolio.semantic_service import SemanticPressureService
from app.intelligence.portfolio.technical import TechnicalSnapshot
from app.intelligence.portfolio.technical_service import TechnicalSnapshotService
from app.intelligence.repositories.event_repository import EventRepository


class PortfolioService:
    def __init__(
        self,
        *,
        repository: PortfolioRepository,
        events_repository: EventRepository,
        brief_service: PortfolioBriefService | None = None,
        exposure_service: ExposureService | None = None,
        market_data_provider: MarketDataProvider | None = None,
        technical_service: TechnicalSnapshotService | None = None,
        semantic_service: SemanticPressureService | None = None,
        risk_service: PortfolioRiskScoreService | None = None,
    ) -> None:
        self._repo = repository
        self._exposure_service = exposure_service or ExposureService()
        self._market_data_provider = market_data_provider
        self._technical = technical_service
        self._semantic = semantic_service
        self._risk = risk_service
        if brief_service is not None:
            self._brief = brief_service
        else:
            # Lazy import avoids circular dep with valuation_service.
            from app.intelligence.portfolio.valuation_service import ValuationService

            self._brief = PortfolioBriefService(
                repository=events_repository,
                exposure_service=self._exposure_service,
                market_data_provider=market_data_provider,
                valuation_service=(
                    ValuationService() if market_data_provider is not None else None
                ),
            )

    # ---- portfolios ---------------------------------------------------

    async def list_portfolios(self) -> list[PortfolioRecord]:
        return await self._repo.list_portfolios()

    async def get_portfolio(self, portfolio_id: str) -> PortfolioRecord:
        return await self._repo.get_portfolio(portfolio_id)

    async def create_portfolio(
        self, request: PortfolioCreateRequest
    ) -> PortfolioRecord:
        portfolio_id = generate_id("port")
        timestamp = now_utc()
        holdings = [
            enrich_holding(portfolio_id=portfolio_id, holding_input=h)
            for h in request.holdings
        ]
        # dedupe by symbol within the same create request
        deduped = _dedupe_holdings(holdings)
        record = PortfolioRecord(
            id=portfolio_id,
            name=request.name.strip() or "Untitled portfolio",
            description=request.description,
            base_currency=(request.base_currency or "USD").upper(),
            benchmark_symbol=(
                request.benchmark_symbol.upper() if request.benchmark_symbol else None
            ),
            notes=request.notes,
            tags=list(request.tags or []),
            created_at=timestamp,
            updated_at=timestamp,
            holdings=deduped,
        )
        return await self._repo.upsert_portfolio(record)

    async def update_portfolio(
        self, portfolio_id: str, request: PortfolioUpdateRequest
    ) -> PortfolioRecord:
        existing = await self._repo.get_portfolio(portfolio_id)
        if request.name is not None:
            existing.name = request.name
        if request.description is not None:
            existing.description = request.description
        if request.base_currency is not None:
            existing.base_currency = request.base_currency.upper()
        if request.notes is not None:
            existing.notes = request.notes
        if request.tags is not None:
            existing.tags = list(request.tags)
        if request.benchmark_symbol is not None:
            existing.benchmark_symbol = (
                request.benchmark_symbol.upper() if request.benchmark_symbol else None
            )
        return await self._repo.upsert_portfolio(existing)

    async def delete_portfolio(self, portfolio_id: str) -> None:
        await self._repo.delete_portfolio(portfolio_id)

    # ---- holdings ------------------------------------------------------

    async def add_holdings(
        self,
        portfolio_id: str,
        holdings: Iterable[HoldingInput],
    ) -> PortfolioRecord:
        enriched = [
            enrich_holding(portfolio_id=portfolio_id, holding_input=h)
            for h in holdings
        ]
        return await self._repo.append_holdings(portfolio_id, enriched)

    async def import_csv(
        self,
        portfolio_id: str,
        csv_text: str,
    ) -> tuple[PortfolioRecord, list[tuple[int, str]]]:
        result = parse_holdings_csv(csv_text)
        record = await self.add_holdings(portfolio_id, result.holdings)
        return record, list(result.skipped_rows)

    async def replace_holdings(
        self,
        portfolio_id: str,
        holdings: Iterable[HoldingInput],
    ) -> PortfolioRecord:
        enriched = [
            enrich_holding(portfolio_id=portfolio_id, holding_input=h)
            for h in holdings
        ]
        deduped = _dedupe_holdings(enriched)
        return await self._repo.replace_holdings(portfolio_id, deduped)

    async def remove_holding(
        self, portfolio_id: str, holding_id: str
    ) -> PortfolioRecord:
        return await self._repo.remove_holding(portfolio_id, holding_id)

    # ---- briefs --------------------------------------------------------

    async def build_brief(
        self,
        portfolio_id: str,
        *,
        as_of: datetime | None = None,
    ) -> PortfolioBrief:
        record = await self._repo.get_portfolio(portfolio_id)
        return await self._brief.build(record, cursor=ReplayCursor(as_of=as_of))

    async def build_valuation(
        self, portfolio_id: str
    ) -> PortfolioValuationSummary | None:
        """Return just the valuation summary — cheaper than a full brief.

        Returns ``None`` when no market data provider is configured.
        """

        if self._market_data_provider is None:
            # Confirm portfolio exists so we still 404 on unknown ids.
            await self._repo.get_portfolio(portfolio_id)
            return None

        from app.intelligence.portfolio.valuation_service import ValuationService

        record = await self._repo.get_portfolio(portfolio_id)
        symbols = [h.symbol for h in record.holdings]
        snapshots = (
            await self._market_data_provider.get_snapshots(symbols) if symbols else {}
        )
        valuation = ValuationService()
        _, summary = valuation.aggregate_portfolio(
            record,
            snapshots,
            provider_id=self._market_data_provider.provider_id,
        )
        return summary

    async def build_technical_snapshots(
        self,
        portfolio_id: str,
        *,
        as_of: datetime | None = None,
    ) -> list[TechnicalSnapshot]:
        """Return per-holding TechnicalSnapshot list.

        Empty list when no technical service is wired (e.g., tests that
        boot the runtime without a market data provider). Confirms the
        portfolio exists so callers still 404 on unknown ids.
        """

        if self._technical is None:
            await self._repo.get_portfolio(portfolio_id)
            return []
        return await self._technical.build_for_portfolio(portfolio_id, as_of=as_of)

    async def build_semantic_snapshots(
        self,
        portfolio_id: str,
        *,
        as_of: datetime | None = None,
    ) -> tuple[list[SemanticSnapshot], PortfolioSemanticRollup] | None:
        """Return per-holding SemanticSnapshots + a portfolio rollup.

        Returns ``None`` when no semantic service is wired (e.g., tests
        that boot the runtime without the semantic service). Confirms
        the portfolio exists so callers still 404 on unknown ids.
        """

        if self._semantic is None:
            await self._repo.get_portfolio(portfolio_id)
            return None
        return await self._semantic.build_for_portfolio(portfolio_id, as_of=as_of)

    async def build_risk_score(
        self,
        portfolio_id: str,
        *,
        as_of: datetime | None = None,
    ) -> PortfolioMacroRiskScore | None:
        """Return the portfolio's Macro Risk Score (Phase 13B.4).

        Returns ``None`` when no risk service is wired (e.g., tests that
        boot the runtime without it). Confirms the portfolio exists so
        callers still 404 on unknown ids.
        """

        if self._risk is None:
            await self._repo.get_portfolio(portfolio_id)
            return None
        return await self._risk.build_for_portfolio(portfolio_id, as_of=as_of)

    # ---- market data / candles -----------------------------------------

    @property
    def market_data_provider(self) -> MarketDataProvider | None:
        """Read-only access to the underlying market data provider."""
        return self._market_data_provider

    async def get_holding_candles(
        self,
        portfolio_id: str,
        symbol: str,
        *,
        range: str = "1y",
        as_of: datetime | None = None,
    ) -> list[Candle]:
        """Return OHLCV candles for a symbol owned by the portfolio.

        Validates that the portfolio exists and that the symbol is one of its
        holdings — this prevents enumeration of candles for unrelated tickers
        via the portfolio path. Returns an empty list when no market data
        provider is configured.
        """
        record = await self._repo.get_portfolio(portfolio_id)
        normalized = symbol.upper().strip()
        if not any(h.symbol.upper() == normalized for h in record.holdings):
            raise HoldingNotInPortfolioError(
                f"{normalized} not in portfolio {portfolio_id}"
            )
        if self._market_data_provider is None:
            return []
        return await self._market_data_provider.get_candles(
            normalized, range=range, as_of=as_of,
        )

    # ---- watchlists ----------------------------------------------------

    async def list_watchlists(self) -> list[Watchlist]:
        return await self._repo.list_watchlists()

    async def get_watchlist(self, watchlist_id: str) -> Watchlist:
        return await self._repo.get_watchlist(watchlist_id)

    async def create_watchlist(self, request: WatchlistInput) -> Watchlist:
        timestamp = now_utc()
        watchlist = Watchlist(
            id=generate_id("watch"),
            name=request.name,
            symbols=[s.upper().strip() for s in request.symbols if s and s.strip()],
            countries=[c.upper().strip() for c in request.countries if c and c.strip()],
            topics=[t.strip() for t in request.topics if t and t.strip()],
            notes=request.notes,
            created_at=timestamp,
            updated_at=timestamp,
        )
        return await self._repo.upsert_watchlist(watchlist)

    async def update_watchlist(
        self, watchlist_id: str, request: WatchlistInput
    ) -> Watchlist:
        existing = await self._repo.get_watchlist(watchlist_id)
        existing.name = request.name
        existing.symbols = [s.upper().strip() for s in request.symbols if s and s.strip()]
        existing.countries = [c.upper().strip() for c in request.countries if c and c.strip()]
        existing.topics = [t.strip() for t in request.topics if t and t.strip()]
        existing.notes = request.notes
        return await self._repo.upsert_watchlist(existing)

    async def delete_watchlist(self, watchlist_id: str) -> None:
        await self._repo.delete_watchlist(watchlist_id)

    async def watchlist_to_portfolio(
        self,
        watchlist_id: str,
        *,
        name: str | None = None,
        base_currency: str = "USD",
    ) -> PortfolioRecord:
        watchlist = await self._repo.get_watchlist(watchlist_id)
        request = PortfolioCreateRequest(
            name=name or f"From: {watchlist.name}",
            description=watchlist.notes,
            base_currency=base_currency,
            holdings=[HoldingInput(symbol=symbol) for symbol in watchlist.symbols],
            tags=["from-watchlist"],
        )
        return await self.create_portfolio(request)


def _dedupe_holdings(holdings: list[Holding]) -> list[Holding]:
    """Collapse repeated symbols, summing quantities."""

    by_symbol: dict[str, Holding] = {}
    for holding in holdings:
        key = holding.symbol.upper()
        existing = by_symbol.get(key)
        if existing is None:
            by_symbol[key] = holding
            continue
        existing.quantity = round(existing.quantity + holding.quantity, 6)
        if holding.average_cost is not None:
            existing.average_cost = holding.average_cost
        existing.metadata.update(holding.metadata)
        existing.enrichment_confidence = max(
            existing.enrichment_confidence, holding.enrichment_confidence
        )
    return list(by_symbol.values())


__all__ = ["PortfolioService"]
