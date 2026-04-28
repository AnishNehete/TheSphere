"""Phase 13B.2 — TechnicalSnapshotService + route integration tests."""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from typing import Sequence

import pytest
import pytest_asyncio
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.intelligence.portfolio import (
    HoldingInput,
    InMemoryPortfolioRepository,
    PortfolioCreateRequest,
    PortfolioService,
    TechnicalSnapshot,
    TechnicalSnapshotService,
)
from app.intelligence.portfolio.market_data import (
    Candle,
    CandleRange,
    PriceSnapshot,
    SyntheticMarketDataProvider,
)
from app.intelligence.repositories.event_repository import InMemoryEventRepository
from app.intelligence.routes import intelligence_router, portfolios_router
from app.intelligence.runtime import IntelligenceRuntime


NOW = datetime(2026, 4, 22, 12, 0, tzinfo=timezone.utc)


# ---------------------------------------------------------------------------
# Stub providers for deterministic testing
# ---------------------------------------------------------------------------


class _FailingProvider:
    """Provider that raises for one symbol and delegates for others."""

    provider_id = "failing"

    def __init__(self, *, ok_symbol: str, broken_symbol: str) -> None:
        self._ok = ok_symbol
        self._broken = broken_symbol
        self._synth = SyntheticMarketDataProvider()

    async def get_price_snapshot(
        self, symbol: str, *, as_of: datetime | None = None
    ) -> PriceSnapshot:
        return await self._synth.get_price_snapshot(symbol, as_of=as_of)

    async def get_previous_close(
        self, symbol: str, *, as_of: datetime | None = None
    ) -> float | None:
        return await self._synth.get_previous_close(symbol, as_of=as_of)

    async def get_snapshots(
        self, symbols: Sequence[str], *, as_of: datetime | None = None
    ) -> dict[str, PriceSnapshot]:
        return await self._synth.get_snapshots(symbols, as_of=as_of)

    async def get_candles(
        self,
        symbol: str,
        *,
        range: CandleRange = "1y",  # noqa: A002
        as_of: datetime | None = None,
    ) -> list[Candle]:
        if symbol == self._broken:
            raise RuntimeError("boom")
        return await self._synth.get_candles(symbol, range=range, as_of=as_of)

    async def aclose(self) -> None:
        await self._synth.aclose()


class _ConcurrencyProbeProvider:
    """Counts concurrent get_candles invocations."""

    provider_id = "probe"

    def __init__(self) -> None:
        self._active = 0
        self.max_active = 0
        self._lock = asyncio.Lock()

    async def get_price_snapshot(
        self, symbol: str, *, as_of: datetime | None = None
    ) -> PriceSnapshot:
        return PriceSnapshot(
            symbol=symbol,
            price=None,
            previous_close=None,
            as_of=as_of or NOW,
            currency="USD",
            provider=self.provider_id,
        )

    async def get_previous_close(
        self, symbol: str, *, as_of: datetime | None = None
    ) -> float | None:
        return None

    async def get_snapshots(
        self, symbols: Sequence[str], *, as_of: datetime | None = None
    ) -> dict[str, PriceSnapshot]:
        return {
            s: await self.get_price_snapshot(s, as_of=as_of) for s in symbols
        }

    async def get_candles(
        self,
        symbol: str,
        *,
        range: CandleRange = "1y",  # noqa: A002
        as_of: datetime | None = None,
    ) -> list[Candle]:
        async with self._lock:
            self._active += 1
            if self._active > self.max_active:
                self.max_active = self._active
        try:
            # Yield so other coroutines can run and pile up if semaphore fails.
            await asyncio.sleep(0.01)
            return []
        finally:
            async with self._lock:
                self._active -= 1

    async def aclose(self) -> None:
        return None


# ---------------------------------------------------------------------------
# Service tests
# ---------------------------------------------------------------------------


class TestTechnicalSnapshotService:
    @pytest.mark.asyncio
    async def test_empty_portfolio_returns_empty_list(self) -> None:
        repo = InMemoryPortfolioRepository()
        service = PortfolioService(
            repository=repo,
            events_repository=InMemoryEventRepository(),
        )
        record = await service.create_portfolio(
            PortfolioCreateRequest(name="Empty", holdings=[])
        )

        tech = TechnicalSnapshotService(
            repository=repo, provider=SyntheticMarketDataProvider()
        )
        snaps = await tech.build_for_portfolio(record.id)
        assert snaps == []

    @pytest.mark.asyncio
    async def test_synthetic_provider_produces_snapshot_per_holding(self) -> None:
        repo = InMemoryPortfolioRepository()
        service = PortfolioService(
            repository=repo,
            events_repository=InMemoryEventRepository(),
        )
        record = await service.create_portfolio(
            PortfolioCreateRequest(
                name="Three",
                holdings=[
                    HoldingInput(symbol="AAPL", quantity=5),
                    HoldingInput(symbol="MSFT", quantity=3),
                    HoldingInput(symbol="NVDA", quantity=1),
                ],
            )
        )
        tech = TechnicalSnapshotService(
            repository=repo, provider=SyntheticMarketDataProvider()
        )
        snaps = await tech.build_for_portfolio(record.id)
        assert len(snaps) == 3
        symbols = {s.symbol for s in snaps}
        assert symbols == {"AAPL", "MSFT", "NVDA"}
        for s in snaps:
            assert isinstance(s, TechnicalSnapshot)

    @pytest.mark.asyncio
    async def test_service_isolates_per_symbol_provider_failure(self) -> None:
        repo = InMemoryPortfolioRepository()
        service = PortfolioService(
            repository=repo,
            events_repository=InMemoryEventRepository(),
        )
        record = await service.create_portfolio(
            PortfolioCreateRequest(
                name="Split",
                holdings=[
                    HoldingInput(symbol="OK", quantity=1),
                    HoldingInput(symbol="BROKEN", quantity=1),
                ],
            )
        )
        provider = _FailingProvider(ok_symbol="OK", broken_symbol="BROKEN")
        tech = TechnicalSnapshotService(repository=repo, provider=provider)
        snaps = await tech.build_for_portfolio(record.id)
        assert len(snaps) == 2
        by_sym = {s.symbol: s for s in snaps}
        broken = by_sym["BROKEN"]
        assert broken.last_close is None
        assert any("No candle history" in n for n in broken.technical_notes)
        ok = by_sym["OK"]
        # Synthetic provider always yields candles -> snapshot has a last_close.
        assert ok.last_close is not None

    @pytest.mark.asyncio
    async def test_as_of_truncates_candles(self) -> None:
        repo = InMemoryPortfolioRepository()
        service = PortfolioService(
            repository=repo,
            events_repository=InMemoryEventRepository(),
        )
        record = await service.create_portfolio(
            PortfolioCreateRequest(
                name="AsOf",
                holdings=[HoldingInput(symbol="AAPL", quantity=1)],
            )
        )
        tech = TechnicalSnapshotService(
            repository=repo, provider=SyntheticMarketDataProvider()
        )
        cutoff = datetime(2024, 6, 1, tzinfo=timezone.utc)
        snaps = await tech.build_for_portfolio(record.id, as_of=cutoff)
        assert len(snaps) == 1
        # Synthetic provider truncates candles at ``as_of`` so the snapshot's
        # as_of (taken from last_candle.timestamp) should be <= cutoff.
        assert snaps[0].as_of <= cutoff

    @pytest.mark.asyncio
    async def test_concurrency_bounded(self) -> None:
        repo = InMemoryPortfolioRepository()
        service = PortfolioService(
            repository=repo,
            events_repository=InMemoryEventRepository(),
        )
        symbols = [f"SYM{i}" for i in range(10)]
        record = await service.create_portfolio(
            PortfolioCreateRequest(
                name="ConcTest",
                holdings=[HoldingInput(symbol=s, quantity=1) for s in symbols],
            )
        )
        probe = _ConcurrencyProbeProvider()
        tech = TechnicalSnapshotService(
            repository=repo, provider=probe, concurrency=2
        )
        await tech.build_for_portfolio(record.id)
        assert probe.max_active <= 2


# ---------------------------------------------------------------------------
# Route integration tests
# ---------------------------------------------------------------------------


def _build_runtime_with_synthetic(
    events_repo: InMemoryEventRepository,
) -> IntelligenceRuntime:
    """Build a minimal runtime wired against SyntheticMarketDataProvider."""

    portfolio_repository = InMemoryPortfolioRepository()
    provider = SyntheticMarketDataProvider()
    tech_service = TechnicalSnapshotService(
        repository=portfolio_repository, provider=provider
    )
    from app.intelligence.portfolio import PortfolioBriefService
    from app.intelligence.portfolio.valuation_service import ValuationService

    brief = PortfolioBriefService(
        repository=events_repo,
        market_data_provider=provider,
        valuation_service=ValuationService(),
    )
    portfolio_service = PortfolioService(
        repository=portfolio_repository,
        events_repository=events_repo,
        brief_service=brief,
        market_data_provider=provider,
        technical_service=tech_service,
    )
    base = IntelligenceRuntime.build_default(
        adapters=(), repository=events_repo
    )
    # Replace fields that matter for the portfolio routes.
    base.portfolio_repository = portfolio_repository
    base.portfolio_service = portfolio_service
    base.market_data_provider = provider
    base.technical_service = tech_service
    return base


@pytest_asyncio.fixture
async def app_with_tech() -> FastAPI:
    events = InMemoryEventRepository()
    runtime = _build_runtime_with_synthetic(events)
    instance = FastAPI()
    instance.state.intelligence = runtime
    instance.include_router(intelligence_router)
    instance.include_router(portfolios_router)
    return instance


@pytest.fixture
def client_with_tech(app_with_tech: FastAPI) -> TestClient:
    return TestClient(app_with_tech)


class TestRouteIntegration:
    def test_portfolio_technical_route_returns_snapshots(
        self, client_with_tech: TestClient
    ) -> None:
        create = client_with_tech.post(
            "/api/intelligence/portfolios",
            json={
                "name": "TechRoute",
                "holdings": [
                    {"symbol": "AAPL", "quantity": 2},
                    {"symbol": "MSFT", "quantity": 1},
                ],
            },
        )
        assert create.status_code == 201, create.text
        portfolio_id = create.json()["id"]

        resp = client_with_tech.get(
            f"/api/intelligence/portfolios/{portfolio_id}/technical"
        )
        assert resp.status_code == 200, resp.text
        payload = resp.json()
        assert payload["portfolio_id"] == portfolio_id
        assert "generated_at" in payload
        assert isinstance(payload["snapshots"], list)
        assert len(payload["snapshots"]) == 2
        symbols = {s["symbol"] for s in payload["snapshots"]}
        assert symbols == {"AAPL", "MSFT"}
        for snap in payload["snapshots"]:
            assert snap["technical_signal_level"] in {
                "stretched_long",
                "balanced",
                "stretched_short",
            }
            assert snap["trend_regime"] in {
                "above_200",
                "below_200",
                "recovering",
                "breaking_down",
                "insufficient_data",
            }

    def test_portfolio_technical_route_404_for_missing_portfolio(
        self, client_with_tech: TestClient
    ) -> None:
        resp = client_with_tech.get(
            "/api/intelligence/portfolios/missing/technical"
        )
        assert resp.status_code == 404
