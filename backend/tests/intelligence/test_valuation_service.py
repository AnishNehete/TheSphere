"""Phase 13B.1 — ValuationService pure-math + brief integration tests."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from app.intelligence.portfolio import (
    HoldingValuation,
    InMemoryPortfolioRepository,
    PortfolioBriefService,
    PortfolioCreateRequest,
    PortfolioService,
    PortfolioValuationSummary,
    PriceSnapshot,
    ValuationService,
)
from app.intelligence.portfolio.market_data import (
    MarketDataProvider,
    SyntheticMarketDataProvider,
)
from app.intelligence.portfolio.schemas import Holding, PortfolioRecord
from app.intelligence.repositories.event_repository import InMemoryEventRepository


NOW = datetime(2026, 4, 22, 12, 0, tzinfo=timezone.utc)


def _holding(
    holding_id: str,
    symbol: str,
    quantity: float,
    average_cost: float | None = None,
    currency: str = "USD",
) -> Holding:
    return Holding(
        id=holding_id,
        portfolio_id="port_demo",
        symbol=symbol,
        quantity=quantity,
        average_cost=average_cost,
        currency=currency,
        enrichment_confidence=1.0,
    )


def _snapshot(
    symbol: str,
    price: float | None,
    *,
    as_of: datetime = NOW,
    is_stale: bool = False,
    provider: str = "synthetic",
) -> PriceSnapshot:
    return PriceSnapshot(
        symbol=symbol,
        price=price,
        previous_close=None,
        as_of=as_of,
        currency="USD",
        provider=provider,
        is_stale=is_stale,
    )


# -----------------------------------------------------------------------------
# Pure valuation math
# -----------------------------------------------------------------------------


class TestValueHoldingMath:
    def test_full_data_produces_correct_pnl(self) -> None:
        service = ValuationService()
        holding = _holding("h1", "AAPL", quantity=10, average_cost=180)
        snapshot = _snapshot("AAPL", price=200)
        valuation = service.value_holding(holding, snapshot)
        assert valuation.market_value == pytest.approx(2000.0)
        assert valuation.cost_basis == pytest.approx(1800.0)
        assert valuation.unrealized_pnl == pytest.approx(200.0)
        assert valuation.unrealized_pnl_pct == pytest.approx(200.0 / 1800.0, rel=1e-3)
        assert valuation.price_missing is False

    def test_missing_price_flags_missing_never_fabricates(self) -> None:
        service = ValuationService()
        holding = _holding("h1", "AAPL", quantity=10, average_cost=180)
        snapshot = _snapshot("AAPL", price=None)
        valuation = service.value_holding(holding, snapshot)
        assert valuation.market_value is None
        assert valuation.unrealized_pnl is None
        assert valuation.unrealized_pnl_pct is None
        assert valuation.price_missing is True

    def test_missing_average_cost_leaves_cost_basis_none(self) -> None:
        service = ValuationService()
        holding = _holding("h1", "AAPL", quantity=10, average_cost=None)
        snapshot = _snapshot("AAPL", price=200)
        valuation = service.value_holding(holding, snapshot)
        assert valuation.market_value == pytest.approx(2000.0)
        assert valuation.cost_basis is None
        assert valuation.unrealized_pnl is None
        assert valuation.unrealized_pnl_pct is None

    def test_zero_quantity_is_safe(self) -> None:
        service = ValuationService()
        holding = _holding("h1", "AAPL", quantity=0, average_cost=180)
        snapshot = _snapshot("AAPL", price=200)
        valuation = service.value_holding(holding, snapshot)
        assert valuation.market_value == pytest.approx(0.0)
        assert valuation.cost_basis == pytest.approx(0.0)
        assert valuation.unrealized_pnl == pytest.approx(0.0)
        assert valuation.unrealized_pnl_pct is None  # divide-by-zero guard

    def test_staleness_flag_propagates(self) -> None:
        service = ValuationService()
        holding = _holding("h1", "AAPL", quantity=5, average_cost=100)
        snapshot = _snapshot("AAPL", price=110, is_stale=True)
        valuation = service.value_holding(holding, snapshot)
        assert valuation.is_stale is True


# -----------------------------------------------------------------------------
# Aggregation
# -----------------------------------------------------------------------------


def _record_with(holdings: list[Holding]) -> PortfolioRecord:
    return PortfolioRecord(
        id="port_demo",
        name="Demo",
        base_currency="USD",
        created_at=NOW,
        updated_at=NOW,
        holdings=holdings,
    )


class TestAggregatePortfolio:
    def test_coverage_above_threshold_uses_market_value_weight_basis(self) -> None:
        service = ValuationService()
        holdings = [
            _holding("h1", "AAPL", 10, 180),
            _holding("h2", "MSFT", 5, 300),
            _holding("h3", "NVDA", 2, 500),
        ]
        record = _record_with(holdings)
        snapshots = {
            "AAPL": _snapshot("AAPL", 200),
            "MSFT": _snapshot("MSFT", 320),
            # NVDA missing
        }
        valuations, summary = service.aggregate_portfolio(
            record, snapshots, provider_id="synthetic"
        )
        assert len(valuations) == 3
        assert summary.price_coverage == pytest.approx(2 / 3, abs=1e-3)
        assert summary.weight_basis == "market_value"

    def test_coverage_below_threshold_uses_cost_basis_fallback(self) -> None:
        service = ValuationService()
        holdings = [_holding(f"h{i}", f"SYM{i}", 1, 100) for i in range(10)]
        record = _record_with(holdings)
        snapshots = {f"SYM{i}": _snapshot(f"SYM{i}", 100) for i in range(3)}
        _, summary = service.aggregate_portfolio(
            record, snapshots, provider_id="synthetic"
        )
        assert summary.price_coverage == pytest.approx(0.3)
        assert summary.weight_basis == "cost_basis_fallback"

    def test_missing_price_symbols_listed(self) -> None:
        service = ValuationService()
        holdings = [
            _holding("h1", "AAPL", 10, 180),
            _holding("h2", "MSFT", 5, 300),
        ]
        record = _record_with(holdings)
        snapshots = {"AAPL": _snapshot("AAPL", 200)}
        _, summary = service.aggregate_portfolio(
            record, snapshots, provider_id="synthetic"
        )
        assert summary.missing_price_symbols == ["MSFT"]

    def test_stalest_price_propagates(self) -> None:
        service = ValuationService()
        holdings = [
            _holding("h1", "AAPL", 10, 180),
            _holding("h2", "MSFT", 5, 300),
        ]
        record = _record_with(holdings)
        older = NOW - timedelta(hours=3)
        snapshots = {
            "AAPL": _snapshot("AAPL", 200, as_of=NOW),
            "MSFT": _snapshot("MSFT", 320, as_of=older),
        }
        _, summary = service.aggregate_portfolio(
            record, snapshots, provider_id="synthetic"
        )
        assert summary.stalest_price_as_of == older

    def test_totals_sum_only_priced_holdings(self) -> None:
        service = ValuationService()
        holdings = [
            _holding("h1", "AAPL", 10, 180),
            _holding("h2", "MSFT", 5, 300),
        ]
        record = _record_with(holdings)
        snapshots = {"AAPL": _snapshot("AAPL", 200)}
        _, summary = service.aggregate_portfolio(
            record, snapshots, provider_id="synthetic"
        )
        assert summary.total_market_value == pytest.approx(2000.0)


# -----------------------------------------------------------------------------
# Brief integration
# -----------------------------------------------------------------------------


class _PartialProvider:
    """Returns prices for even-indexed symbols only — forces partial coverage."""

    provider_id = "partial"

    def __init__(self, *, price: float = 100.0) -> None:
        self._price = price

    async def get_price_snapshot(self, symbol, *, as_of=None):  # type: ignore[no-untyped-def]
        has_price = sum(ord(c) for c in symbol) % 2 == 0
        return PriceSnapshot(
            symbol=symbol,
            price=self._price if has_price else None,
            previous_close=None,
            as_of=NOW,
            currency="USD",
            provider=self.provider_id,
        )

    async def get_previous_close(self, symbol, *, as_of=None):  # type: ignore[no-untyped-def]
        return None

    async def get_snapshots(self, symbols, *, as_of=None):  # type: ignore[no-untyped-def]
        return {s: await self.get_price_snapshot(s, as_of=as_of) for s in symbols}

    async def get_candles(self, symbol, *, range="1y", as_of=None):  # type: ignore[no-untyped-def]
        return []

    async def aclose(self) -> None:
        return None


class TestBriefIntegration:
    @pytest.mark.asyncio
    async def test_brief_includes_valuation_summary_when_provider_configured(
        self,
    ) -> None:
        repo = InMemoryPortfolioRepository()
        events = InMemoryEventRepository()
        provider = SyntheticMarketDataProvider()
        service = PortfolioService(
            repository=repo,
            events_repository=events,
            market_data_provider=provider,
        )
        await service.create_portfolio(
            PortfolioCreateRequest(
                name="valuation test",
                holdings=[
                    {"symbol": "AAPL", "quantity": 10, "average_cost": 180},  # type: ignore[list-item]
                    {"symbol": "MSFT", "quantity": 5, "average_cost": 300},  # type: ignore[list-item]
                ],
            )
        )
        portfolios = await service.list_portfolios()
        brief = await service.build_brief(portfolios[0].id)
        assert brief.valuation_summary is not None
        assert brief.valuation_summary.provider == "synthetic"
        assert all(h.last_price is not None for h in brief.holdings)

    @pytest.mark.asyncio
    async def test_brief_gracefully_omits_valuation_when_provider_none(self) -> None:
        repo = InMemoryPortfolioRepository()
        events = InMemoryEventRepository()
        service = PortfolioService(
            repository=repo,
            events_repository=events,
            market_data_provider=None,
        )
        await service.create_portfolio(
            PortfolioCreateRequest(
                name="no-provider",
                holdings=[
                    {"symbol": "AAPL", "quantity": 1, "average_cost": 180},  # type: ignore[list-item]
                ],
            )
        )
        portfolios = await service.list_portfolios()
        brief = await service.build_brief(portfolios[0].id)
        assert brief.valuation_summary is None
        assert brief.holdings[0].last_price is None
        assert any("price provider not configured" in n.lower() for n in brief.notes)

    @pytest.mark.asyncio
    async def test_brief_honest_note_on_partial_coverage(self) -> None:
        repo = InMemoryPortfolioRepository()
        events = InMemoryEventRepository()
        # Symbols picked so partial provider returns at least one None.
        # "AAPL" sum=65+65+80+76=286 (even -> priced), "MSFT" sum=77+83+70+84=314 (even -> priced).
        # We need a symbol whose char-code sum is odd to force missing:
        # "NVDA" = 78+86+68+65=297 (odd -> missing).
        service = PortfolioService(
            repository=repo,
            events_repository=events,
            market_data_provider=_PartialProvider(),
        )
        await service.create_portfolio(
            PortfolioCreateRequest(
                name="partial",
                holdings=[
                    {"symbol": "AAPL", "quantity": 1, "average_cost": 10},  # type: ignore[list-item]
                    {"symbol": "NVDA", "quantity": 1, "average_cost": 10},  # type: ignore[list-item]
                ],
            )
        )
        portfolios = await service.list_portfolios()
        brief = await service.build_brief(portfolios[0].id)
        assert brief.valuation_summary is not None
        assert 0.0 < brief.valuation_summary.price_coverage < 1.0
        assert any("prices:" in n.lower() and "live" in n.lower() for n in brief.notes)
