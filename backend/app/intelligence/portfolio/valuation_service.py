"""Pure valuation math — maps Holding + PriceSnapshot -> HoldingValuation.

Lives downstream of :class:`MarketDataProvider` and upstream of the brief
composition. Keeping the math I/O-free makes it trivially unit-testable
and replay-safe (same inputs -> same outputs).
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone

from app.intelligence.portfolio.market_data import (
    HoldingValuation,
    PortfolioValuationSummary,
    PriceSnapshot,
)
from app.intelligence.portfolio.schemas import Holding, PortfolioRecord


logger = logging.getLogger(__name__)


WEIGHT_BASIS_THRESHOLD = 0.5


class ValuationService:
    """Turn holdings + price snapshots into HoldingValuation + summary.

    Pure: no network. The caller fetches snapshots via
    ``MarketDataProvider.get_snapshots()`` and passes the dict in. This
    keeps the computation replay-safe and cheap to test.
    """

    def __init__(
        self, *, weight_basis_threshold: float = WEIGHT_BASIS_THRESHOLD
    ) -> None:
        self._threshold = weight_basis_threshold

    def value_holding(
        self, holding: Holding, snapshot: PriceSnapshot | None
    ) -> HoldingValuation:
        price = snapshot.price if snapshot is not None else None
        price_as_of = snapshot.as_of if snapshot is not None else None
        is_stale = bool(snapshot.is_stale) if snapshot is not None else False
        price_missing = price is None

        quantity = holding.quantity or 0.0

        market_value: float | None
        if price is None:
            market_value = None
        else:
            market_value = round(quantity * price, 6)

        cost_basis: float | None
        if holding.average_cost is None:
            cost_basis = None
        else:
            cost_basis = round(quantity * holding.average_cost, 6)

        unrealized_pnl: float | None
        if market_value is None or cost_basis is None:
            unrealized_pnl = None
        else:
            unrealized_pnl = round(market_value - cost_basis, 6)

        unrealized_pnl_pct: float | None
        if unrealized_pnl is None or cost_basis is None or cost_basis == 0:
            unrealized_pnl_pct = None
        else:
            unrealized_pnl_pct = round(unrealized_pnl / cost_basis, 6)

        return HoldingValuation(
            holding_id=holding.id,
            symbol=holding.symbol,
            last_price=price,
            price_as_of=price_as_of,
            market_value=market_value,
            cost_basis=cost_basis,
            unrealized_pnl=unrealized_pnl,
            unrealized_pnl_pct=unrealized_pnl_pct,
            currency=holding.currency,
            is_stale=is_stale,
            price_missing=price_missing,
        )

    def aggregate_portfolio(
        self,
        record: PortfolioRecord,
        snapshots: dict[str, PriceSnapshot],
        *,
        provider_id: str,
        generated_at: datetime | None = None,
    ) -> tuple[list[HoldingValuation], PortfolioValuationSummary]:
        holdings = list(record.holdings)
        valuations = [
            self.value_holding(h, snapshots.get(h.symbol)) for h in holdings
        ]

        priced = [v for v in valuations if not v.price_missing]
        missing_symbols = [v.symbol for v in valuations if v.price_missing]
        coverage = len(priced) / len(valuations) if valuations else 0.0

        total_market_value: float | None
        if priced:
            total_market_value = round(
                sum(v.market_value or 0.0 for v in priced), 6
            )
        else:
            total_market_value = None

        cost_values = [v.cost_basis for v in valuations if v.cost_basis is not None]
        total_cost_basis: float | None
        if cost_values:
            total_cost_basis = round(sum(cost_values), 6)
        else:
            total_cost_basis = None

        total_unrealized_pnl: float | None
        if total_market_value is not None and total_cost_basis is not None:
            total_unrealized_pnl = round(total_market_value - total_cost_basis, 6)
        else:
            total_unrealized_pnl = None

        total_unrealized_pnl_pct: float | None
        if (
            total_unrealized_pnl is not None
            and total_cost_basis is not None
            and total_cost_basis != 0
        ):
            total_unrealized_pnl_pct = round(
                total_unrealized_pnl / total_cost_basis, 6
            )
        else:
            total_unrealized_pnl_pct = None

        stalest = None
        priced_with_ts = [v.price_as_of for v in priced if v.price_as_of is not None]
        if priced_with_ts:
            stalest = min(priced_with_ts)

        weight_basis = self._choose_weight_basis_label(holdings, valuations)

        summary = PortfolioValuationSummary(
            total_market_value=total_market_value,
            total_cost_basis=total_cost_basis,
            total_unrealized_pnl=total_unrealized_pnl,
            total_unrealized_pnl_pct=total_unrealized_pnl_pct,
            price_coverage=round(coverage, 4),
            stalest_price_as_of=stalest,
            missing_price_symbols=missing_symbols,
            weight_basis=weight_basis,
            provider=provider_id,
            generated_at=generated_at or datetime.now(timezone.utc),
        )
        return valuations, summary

    def apply_to_brief_holdings(
        self,
        holdings: list[Holding],
        valuations: list[HoldingValuation],
    ) -> None:
        """Mutate brief holding copies in-place with valuation-derived fields.

        Callers MUST have deep-copied the holdings first — the service never
        sees the repository's source-of-truth record.
        """

        by_id = {v.holding_id: v for v in valuations}
        coverage = self._coverage(valuations)
        use_market_weight = coverage >= self._threshold

        for holding in holdings:
            valuation = by_id.get(holding.id)
            if valuation is None:
                continue
            holding.last_price = valuation.last_price
            holding.price_as_of = valuation.price_as_of
            holding.cost_basis = valuation.cost_basis
            holding.unrealized_pnl = valuation.unrealized_pnl
            holding.unrealized_pnl_pct = valuation.unrealized_pnl_pct
            holding.price_is_stale = valuation.is_stale
            holding.price_missing = valuation.price_missing
            # Market value drives weight normalization in exposure_service
            # when coverage meets the threshold. When below, clear any stale
            # market_value so exposure_service's cost-basis fallback lights up
            # naturally.
            if use_market_weight:
                holding.market_value = valuation.market_value
            else:
                holding.market_value = None

    def _choose_weight_basis_label(
        self,
        holdings: list[Holding],
        valuations: list[HoldingValuation],
    ) -> str:
        coverage = self._coverage(valuations)
        if coverage >= self._threshold:
            return "market_value"
        if any(
            (h.average_cost is not None and h.quantity) for h in holdings
        ):
            return "cost_basis_fallback"
        return "even_split_fallback"

    @staticmethod
    def _coverage(valuations: list[HoldingValuation]) -> float:
        if not valuations:
            return 0.0
        priced = sum(1 for v in valuations if not v.price_missing)
        return priced / len(valuations)


__all__ = ["ValuationService", "WEIGHT_BASIS_THRESHOLD"]
