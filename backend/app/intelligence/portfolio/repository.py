"""Portfolio + watchlist persistence (in-memory implementation).

Phase 13A ships the in-memory repository so the API + UI can be exercised
without bringing up Postgres for portfolio rows. The protocol is pinned so
later phases can swap in a Postgres-backed store with no service-layer
changes — this is the same shape used elsewhere in the intelligence module
(see ``app.intelligence.repositories.event_repository``).
"""

from __future__ import annotations

import asyncio
import uuid
from datetime import datetime, timezone
from typing import Iterable, Protocol

from app.intelligence.portfolio.schemas import (
    Holding,
    PortfolioRecord,
    Watchlist,
)


class PortfolioNotFoundError(LookupError):
    """Raised when a requested portfolio / watchlist id is missing."""


class PortfolioRepository(Protocol):
    async def list_portfolios(self) -> list[PortfolioRecord]: ...

    async def get_portfolio(self, portfolio_id: str) -> PortfolioRecord: ...

    async def upsert_portfolio(self, record: PortfolioRecord) -> PortfolioRecord: ...

    async def delete_portfolio(self, portfolio_id: str) -> None: ...

    async def replace_holdings(
        self,
        portfolio_id: str,
        holdings: Iterable[Holding],
    ) -> PortfolioRecord: ...

    async def append_holdings(
        self,
        portfolio_id: str,
        holdings: Iterable[Holding],
    ) -> PortfolioRecord: ...

    async def remove_holding(
        self,
        portfolio_id: str,
        holding_id: str,
    ) -> PortfolioRecord: ...

    async def list_watchlists(self) -> list[Watchlist]: ...

    async def get_watchlist(self, watchlist_id: str) -> Watchlist: ...

    async def upsert_watchlist(self, watchlist: Watchlist) -> Watchlist: ...

    async def delete_watchlist(self, watchlist_id: str) -> None: ...


def generate_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


class InMemoryPortfolioRepository:
    """Thread-safe in-memory implementation of :class:`PortfolioRepository`."""

    def __init__(self) -> None:
        self._portfolios: dict[str, PortfolioRecord] = {}
        self._watchlists: dict[str, Watchlist] = {}
        self._lock = asyncio.Lock()

    # -- portfolios -----------------------------------------------------

    async def list_portfolios(self) -> list[PortfolioRecord]:
        async with self._lock:
            return sorted(
                self._portfolios.values(),
                key=lambda p: p.created_at,
                reverse=True,
            )

    async def get_portfolio(self, portfolio_id: str) -> PortfolioRecord:
        async with self._lock:
            record = self._portfolios.get(portfolio_id)
            if record is None:
                raise PortfolioNotFoundError(portfolio_id)
            return record.model_copy(deep=True)

    async def upsert_portfolio(self, record: PortfolioRecord) -> PortfolioRecord:
        async with self._lock:
            stored = record.model_copy(deep=True)
            stored.updated_at = now_utc()
            self._portfolios[stored.id] = stored
            return stored.model_copy(deep=True)

    async def delete_portfolio(self, portfolio_id: str) -> None:
        async with self._lock:
            if portfolio_id not in self._portfolios:
                raise PortfolioNotFoundError(portfolio_id)
            self._portfolios.pop(portfolio_id, None)

    async def replace_holdings(
        self,
        portfolio_id: str,
        holdings: Iterable[Holding],
    ) -> PortfolioRecord:
        async with self._lock:
            record = self._portfolios.get(portfolio_id)
            if record is None:
                raise PortfolioNotFoundError(portfolio_id)
            record.holdings = [h.model_copy(deep=True) for h in holdings]
            record.updated_at = now_utc()
            self._portfolios[portfolio_id] = record
            return record.model_copy(deep=True)

    async def append_holdings(
        self,
        portfolio_id: str,
        holdings: Iterable[Holding],
    ) -> PortfolioRecord:
        async with self._lock:
            record = self._portfolios.get(portfolio_id)
            if record is None:
                raise PortfolioNotFoundError(portfolio_id)
            existing_by_symbol = {h.symbol: h for h in record.holdings}
            for new_holding in holdings:
                existing = existing_by_symbol.get(new_holding.symbol)
                if existing is None:
                    record.holdings.append(new_holding.model_copy(deep=True))
                    existing_by_symbol[new_holding.symbol] = new_holding
                else:
                    # merge quantities — last-write-wins for fields the user
                    # might have refined (sector / country), but additive
                    # for quantity so CSV imports compose with manual entry.
                    existing.quantity = round(
                        existing.quantity + new_holding.quantity, 6
                    )
                    if new_holding.average_cost is not None:
                        existing.average_cost = new_holding.average_cost
                    for attr in (
                        "currency",
                        "asset_type",
                        "exchange",
                        "sector",
                        "country_code",
                        "region",
                        "name",
                    ):
                        value = getattr(new_holding, attr, None)
                        if value:
                            setattr(existing, attr, value)
                    existing.metadata.update(new_holding.metadata)
                    existing.enrichment_confidence = max(
                        existing.enrichment_confidence,
                        new_holding.enrichment_confidence,
                    )
            record.updated_at = now_utc()
            self._portfolios[portfolio_id] = record
            return record.model_copy(deep=True)

    async def remove_holding(
        self,
        portfolio_id: str,
        holding_id: str,
    ) -> PortfolioRecord:
        async with self._lock:
            record = self._portfolios.get(portfolio_id)
            if record is None:
                raise PortfolioNotFoundError(portfolio_id)
            record.holdings = [h for h in record.holdings if h.id != holding_id]
            record.updated_at = now_utc()
            self._portfolios[portfolio_id] = record
            return record.model_copy(deep=True)

    # -- watchlists -----------------------------------------------------

    async def list_watchlists(self) -> list[Watchlist]:
        async with self._lock:
            return sorted(
                self._watchlists.values(),
                key=lambda w: w.created_at,
                reverse=True,
            )

    async def get_watchlist(self, watchlist_id: str) -> Watchlist:
        async with self._lock:
            wl = self._watchlists.get(watchlist_id)
            if wl is None:
                raise PortfolioNotFoundError(watchlist_id)
            return wl.model_copy(deep=True)

    async def upsert_watchlist(self, watchlist: Watchlist) -> Watchlist:
        async with self._lock:
            stored = watchlist.model_copy(deep=True)
            stored.updated_at = now_utc()
            self._watchlists[stored.id] = stored
            return stored.model_copy(deep=True)

    async def delete_watchlist(self, watchlist_id: str) -> None:
        async with self._lock:
            if watchlist_id not in self._watchlists:
                raise PortfolioNotFoundError(watchlist_id)
            self._watchlists.pop(watchlist_id, None)


__all__ = [
    "InMemoryPortfolioRepository",
    "PortfolioNotFoundError",
    "PortfolioRepository",
    "generate_id",
    "now_utc",
]
