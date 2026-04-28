"""Portfolio + watchlist HTTP routes (Phase 13A).

These endpoints sit beside the existing intelligence routes; they read/
write the in-memory :class:`PortfolioRepository` attached to the runtime.
The brief endpoint joins persisted portfolio state with live world events
through :class:`PortfolioBriefService`.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Annotated, Literal

from fastapi import APIRouter, Body, Depends, HTTPException, Request, Response, status
from pydantic import BaseModel, Field

from app.intelligence.portfolio import (
    CsvImportError,
    HoldingInput,
    HoldingNotInPortfolioError,
    PortfolioBrief,
    PortfolioCreateRequest,
    PortfolioMacroRiskScore,
    PortfolioNotFoundError,
    PortfolioRecord,
    PortfolioSemanticRollup,
    PortfolioService,
    PortfolioUpdateRequest,
    PortfolioValuationSummary,
    SemanticSnapshot,
    TechnicalSnapshot,
    Watchlist,
    WatchlistInput,
)
from app.intelligence.portfolio.market_data import Candle
from app.intelligence.portfolio.posture import (
    AssetClass,
    MarketPosture,
    NarrativeResponse,
)
from app.intelligence.portfolio.posture.narrative_service import (
    MarketNarrativeService,
)
from app.intelligence.portfolio.posture.service import MarketPostureService
from app.intelligence.portfolio.replay import parse_as_of
from app.intelligence.runtime import IntelligenceRuntime


router = APIRouter(prefix="/api/intelligence", tags=["portfolios"])


def get_runtime(request: Request) -> IntelligenceRuntime:
    runtime = getattr(request.app.state, "intelligence", None)
    if runtime is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Intelligence runtime is not ready yet.",
        )
    return runtime


def get_portfolio_service(
    runtime: Annotated[IntelligenceRuntime, Depends(get_runtime)],
) -> PortfolioService:
    service = getattr(runtime, "portfolio_service", None)
    if service is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Portfolio service is not ready yet.",
        )
    return service


def get_posture_service(
    runtime: Annotated[IntelligenceRuntime, Depends(get_runtime)],
) -> MarketPostureService:
    service = getattr(runtime, "posture_service", None)
    if service is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Posture service is not ready yet.",
        )
    return service


def get_narrative_service(
    runtime: Annotated[IntelligenceRuntime, Depends(get_runtime)],
) -> MarketNarrativeService:
    service = getattr(runtime, "narrative_service", None)
    if service is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Narrative service is not ready yet.",
        )
    return service


def _parse_as_of_qp(as_of: str | None) -> datetime | None:
    """Parse an ISO-8601 as_of query param, raising 422 on invalid input."""
    try:
        return parse_as_of(as_of)
    except ValueError as exc:
        raise HTTPException(
            status_code=422,
            detail=f"Invalid as_of: {exc}",
        ) from exc


# ---- response envelopes ----------------------------------------------------


class PortfolioListResponse(BaseModel):
    total: int
    items: list[PortfolioRecord]


class WatchlistListResponse(BaseModel):
    total: int
    items: list[Watchlist]


class CsvImportRequest(BaseModel):
    csv: str = Field(..., min_length=1, description="Raw CSV body, header required")


class CsvImportResponse(BaseModel):
    portfolio: PortfolioRecord
    skipped_rows: list[dict]


class WatchlistToPortfolioRequest(BaseModel):
    name: str | None = None
    base_currency: str = "USD"


# ---- portfolios ------------------------------------------------------------


@router.get("/portfolios", response_model=PortfolioListResponse)
async def list_portfolios(
    service: Annotated[PortfolioService, Depends(get_portfolio_service)],
) -> PortfolioListResponse:
    items = await service.list_portfolios()
    return PortfolioListResponse(total=len(items), items=items)


@router.post(
    "/portfolios",
    response_model=PortfolioRecord,
    status_code=status.HTTP_201_CREATED,
)
async def create_portfolio(
    payload: PortfolioCreateRequest,
    service: Annotated[PortfolioService, Depends(get_portfolio_service)],
) -> PortfolioRecord:
    if not payload.name or not payload.name.strip():
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Portfolio name is required.",
        )
    return await service.create_portfolio(payload)


@router.get("/portfolios/{portfolio_id}", response_model=PortfolioRecord)
async def get_portfolio(
    portfolio_id: str,
    service: Annotated[PortfolioService, Depends(get_portfolio_service)],
) -> PortfolioRecord:
    try:
        return await service.get_portfolio(portfolio_id)
    except PortfolioNotFoundError as exc:
        raise HTTPException(status_code=404, detail=f"Portfolio {exc} not found")


@router.patch("/portfolios/{portfolio_id}", response_model=PortfolioRecord)
async def update_portfolio(
    portfolio_id: str,
    payload: PortfolioUpdateRequest,
    service: Annotated[PortfolioService, Depends(get_portfolio_service)],
) -> PortfolioRecord:
    try:
        return await service.update_portfolio(portfolio_id, payload)
    except PortfolioNotFoundError as exc:
        raise HTTPException(status_code=404, detail=f"Portfolio {exc} not found")


@router.delete("/portfolios/{portfolio_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_portfolio(
    portfolio_id: str,
    service: Annotated[PortfolioService, Depends(get_portfolio_service)],
) -> Response:
    try:
        await service.delete_portfolio(portfolio_id)
    except PortfolioNotFoundError as exc:
        raise HTTPException(status_code=404, detail=f"Portfolio {exc} not found")
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post(
    "/portfolios/{portfolio_id}/holdings",
    response_model=PortfolioRecord,
)
async def add_holdings(
    portfolio_id: str,
    payload: list[HoldingInput],
    service: Annotated[PortfolioService, Depends(get_portfolio_service)],
) -> PortfolioRecord:
    if not payload:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="At least one holding is required.",
        )
    try:
        return await service.add_holdings(portfolio_id, payload)
    except PortfolioNotFoundError as exc:
        raise HTTPException(status_code=404, detail=f"Portfolio {exc} not found")


@router.delete(
    "/portfolios/{portfolio_id}/holdings/{holding_id}",
    response_model=PortfolioRecord,
)
async def remove_holding(
    portfolio_id: str,
    holding_id: str,
    service: Annotated[PortfolioService, Depends(get_portfolio_service)],
) -> PortfolioRecord:
    try:
        return await service.remove_holding(portfolio_id, holding_id)
    except PortfolioNotFoundError as exc:
        raise HTTPException(status_code=404, detail=f"Portfolio {exc} not found")


@router.post(
    "/portfolios/{portfolio_id}/holdings/csv",
    response_model=CsvImportResponse,
)
async def import_csv(
    portfolio_id: str,
    payload: CsvImportRequest,
    service: Annotated[PortfolioService, Depends(get_portfolio_service)],
) -> CsvImportResponse:
    try:
        record, skipped = await service.import_csv(portfolio_id, payload.csv)
    except PortfolioNotFoundError as exc:
        raise HTTPException(status_code=404, detail=f"Portfolio {exc} not found")
    except CsvImportError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return CsvImportResponse(
        portfolio=record,
        skipped_rows=[{"row": row, "reason": reason} for row, reason in skipped],
    )


@router.get("/portfolios/{portfolio_id}/brief", response_model=PortfolioBrief)
async def portfolio_brief(
    portfolio_id: str,
    service: Annotated[PortfolioService, Depends(get_portfolio_service)],
    as_of: str | None = None,
) -> PortfolioBrief:
    as_of_dt = _parse_as_of_qp(as_of)
    try:
        return await service.build_brief(portfolio_id, as_of=as_of_dt)
    except PortfolioNotFoundError as exc:
        raise HTTPException(status_code=404, detail=f"Portfolio {exc} not found")


@router.get(
    "/portfolios/{portfolio_id}/valuation",
    response_model=PortfolioValuationSummary | None,
)
async def portfolio_valuation(
    portfolio_id: str,
    service: Annotated[PortfolioService, Depends(get_portfolio_service)],
    as_of: str | None = None,
) -> PortfolioValuationSummary | None:
    _parse_as_of_qp(as_of)  # validate and raise 422 on bad input
    try:
        return await service.build_valuation(portfolio_id)
    except PortfolioNotFoundError as exc:
        raise HTTPException(status_code=404, detail=f"Portfolio {exc} not found")


class TechnicalSnapshotsResponse(BaseModel):
    portfolio_id: str
    generated_at: datetime
    snapshots: list[TechnicalSnapshot]


@router.get(
    "/portfolios/{portfolio_id}/technical",
    response_model=TechnicalSnapshotsResponse,
)
async def portfolio_technical(
    portfolio_id: str,
    service: Annotated[PortfolioService, Depends(get_portfolio_service)],
    as_of: str | None = None,
) -> TechnicalSnapshotsResponse:
    """Per-holding TechnicalSnapshot JSON (Phase 13B.2).

    Returns an empty snapshot list when no market data provider is
    wired — tests instantiating the runtime with ``adapters=()`` fall
    into that branch, keeping 13A behaviour intact.
    """

    as_of_dt = _parse_as_of_qp(as_of)
    try:
        snapshots = await service.build_technical_snapshots(portfolio_id, as_of=as_of_dt)
    except PortfolioNotFoundError as exc:
        raise HTTPException(status_code=404, detail=f"Portfolio {exc} not found")
    return TechnicalSnapshotsResponse(
        portfolio_id=portfolio_id,
        generated_at=datetime.now(timezone.utc),
        snapshots=snapshots,
    )


class PortfolioSemanticResponse(BaseModel):
    portfolio_id: str
    generated_at: datetime
    rollup: PortfolioSemanticRollup
    snapshots: list[SemanticSnapshot]


@router.get(
    "/portfolios/{portfolio_id}/semantic",
    response_model=PortfolioSemanticResponse,
)
async def portfolio_semantic(
    portfolio_id: str,
    service: Annotated[PortfolioService, Depends(get_portfolio_service)],
    as_of: str | None = None,
) -> PortfolioSemanticResponse:
    """Per-holding SemanticSnapshot JSON + portfolio rollup (Phase 13B.3).

    Every driver cites real event IDs; no score lands without drivers.
    """

    as_of_dt = _parse_as_of_qp(as_of)
    try:
        result = await service.build_semantic_snapshots(portfolio_id, as_of=as_of_dt)
    except PortfolioNotFoundError as exc:
        raise HTTPException(status_code=404, detail=f"Portfolio {exc} not found")
    if result is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Semantic pressure service is not configured.",
        )
    snapshots, rollup = result
    return PortfolioSemanticResponse(
        portfolio_id=portfolio_id,
        generated_at=datetime.now(timezone.utc),
        rollup=rollup,
        snapshots=snapshots,
    )


@router.get(
    "/portfolios/{portfolio_id}/risk-score",
    response_model=PortfolioMacroRiskScore,
)
async def portfolio_risk_score(
    portfolio_id: str,
    service: Annotated[PortfolioService, Depends(get_portfolio_service)],
    as_of: str | None = None,
) -> PortfolioMacroRiskScore:
    """Portfolio Macro Risk Score (Phase 13B.4).

    Every response carries drivers + confidence + score_components +
    notes — never a naked number. Returns 404 for missing portfolios, 503
    when the risk service is not configured.
    """

    as_of_dt = _parse_as_of_qp(as_of)
    try:
        score = await service.build_risk_score(portfolio_id, as_of=as_of_dt)
    except PortfolioNotFoundError as exc:
        raise HTTPException(status_code=404, detail=f"Portfolio {exc} not found")
    if score is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Portfolio risk service is not configured.",
        )
    return score


# ---- candles --------------------------------------------------------------

CandleRangeLiteral = Literal["1d", "5d", "1mo", "3mo", "6mo", "1y", "2y", "5y"]


class HoldingCandlesResponse(BaseModel):
    portfolio_id: str
    symbol: str
    range: CandleRangeLiteral
    as_of: datetime | None = None
    provider: str
    candles: list[Candle]


@router.get(
    "/portfolios/{portfolio_id}/holdings/{symbol}/candles",
    response_model=HoldingCandlesResponse,
)
async def portfolio_holding_candles(
    portfolio_id: str,
    symbol: str,
    service: Annotated[PortfolioService, Depends(get_portfolio_service)],
    range: CandleRangeLiteral = "1y",  # noqa: A002
    as_of: datetime | None = None,
) -> HoldingCandlesResponse:
    """OHLCV candle series for a single holding (Phase 13B.5).

    Validates portfolio ownership of the symbol before fetching. Returns
    an empty candle list when no market data provider is configured.
    """
    try:
        candles = await service.get_holding_candles(
            portfolio_id, symbol, range=range, as_of=as_of
        )
    except PortfolioNotFoundError as exc:
        raise HTTPException(status_code=404, detail=f"Portfolio {exc} not found")
    except HoldingNotInPortfolioError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    provider_id = (
        service.market_data_provider.provider_id
        if service.market_data_provider is not None
        else "unconfigured"
    )
    return HoldingCandlesResponse(
        portfolio_id=portfolio_id,
        symbol=symbol.upper(),
        range=range,
        as_of=as_of,
        provider=provider_id,
        candles=candles,
    )


# ---- Phase 16.7 — universal market candles (no portfolio scope) -----------

# Market analysis must stand on its own. The portfolio-scoped variant above
# stays for portfolio-specific marker overlays, but any supported symbol can
# be charted directly via this endpoint without belonging to a portfolio.
# Honest-data rule: if the provider returns no series, the response carries
# an empty candles list (the UI surfaces an "unavailable" state) — we never
# fabricate bars.

class MarketCandlesResponse(BaseModel):
    symbol: str
    range: CandleRangeLiteral
    as_of: datetime | None = None
    provider: str
    candles: list[Candle]


@router.get(
    "/market/{symbol}/candles",
    response_model=MarketCandlesResponse,
)
async def market_symbol_candles(
    symbol: str,
    service: Annotated[PortfolioService, Depends(get_portfolio_service)],
    range: CandleRangeLiteral = "1y",  # noqa: A002
    as_of: datetime | None = None,
) -> MarketCandlesResponse:
    """OHLCV candles for any supported market symbol.

    No portfolio scoping — this powers the universal chart dock so an
    analyst can chart any equity / FX / commodity / future the provider
    supports. Returns an empty candles list when no provider is configured
    or the symbol is unknown to the provider.
    """
    normalized = symbol.upper().strip()
    if not normalized:
        raise HTTPException(status_code=422, detail="Symbol is required")

    provider = service.market_data_provider
    if provider is None:
        return MarketCandlesResponse(
            symbol=normalized,
            range=range,
            as_of=as_of,
            provider="unconfigured",
            candles=[],
        )

    try:
        candles = await provider.get_candles(
            normalized, range=range, as_of=as_of,
        )
    except Exception as exc:  # pragma: no cover - defensive
        # Honest-data rule: degrade to empty rather than 500. The frontend
        # renders an "unavailable" state from an empty series.
        candles = []
        _ = exc

    return MarketCandlesResponse(
        symbol=normalized,
        range=range,
        as_of=as_of,
        provider=provider.provider_id,
        candles=candles,
    )


# ---- Phase 17A.1 — deterministic market posture ---------------------------

# The agent layer (17A.2) will call this route rather than reasoning over
# raw candles. The response is the typed contract — bounded posture label,
# signed tilt, confidence, ranked drivers, caveats. No fabricated calls.


@router.get(
    "/market/{symbol}/posture",
    response_model=MarketPosture,
)
async def market_symbol_posture(
    symbol: str,
    service: Annotated[MarketPostureService, Depends(get_posture_service)],
    asset_class: AssetClass = "unknown",
    as_of: datetime | None = None,
) -> MarketPosture:
    """Deterministic posture for any supported market symbol.

    Composes the technical engine + live event corpus into one of
    {strong_sell, sell, neutral, buy, strong_buy} with confidence,
    drivers, and caveats. The engine is pure — same inputs always
    yield the same posture, which is what the 17A.2 agent layer will
    rely on.
    """

    try:
        return await service.build_for_symbol(
            symbol, asset_class=asset_class, as_of=as_of,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


# ---- Phase 17A.3 — bounded agentic narrative ------------------------------

# Lazy endpoint sitting on top of /market/{symbol}/posture. Returns the
# posture envelope unchanged plus a 2-3 sentence narrative — when Anthropic
# is configured the prose comes from Claude under guardrails, otherwise
# from a deterministic builder. The deterministic posture remains the
# source of record either way.


@router.get(
    "/market/{symbol}/narrative",
    response_model=NarrativeResponse,
)
async def market_symbol_narrative(
    symbol: str,
    service: Annotated[MarketNarrativeService, Depends(get_narrative_service)],
    asset_class: AssetClass = "unknown",
    as_of: datetime | None = None,
) -> NarrativeResponse:
    """Posture envelope + bounded explanatory narrative.

    The narrative is paraphrastic only: it never invents prices, scores,
    posture labels, or confidence. Citations are restricted to driver
    event_ids that already appear in the posture's semantic_pressure
    block; numeric restatement (percentages, prices) is forbidden in the
    prose. Any guardrail violation falls back to a deterministic
    narrative built from the typed posture fields.
    """

    try:
        return await service.build_for_symbol(
            symbol, asset_class=asset_class, as_of=as_of,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


# ---- watchlists ------------------------------------------------------------


@router.get("/watchlists", response_model=WatchlistListResponse)
async def list_watchlists(
    service: Annotated[PortfolioService, Depends(get_portfolio_service)],
) -> WatchlistListResponse:
    items = await service.list_watchlists()
    return WatchlistListResponse(total=len(items), items=items)


@router.post(
    "/watchlists",
    response_model=Watchlist,
    status_code=status.HTTP_201_CREATED,
)
async def create_watchlist(
    payload: WatchlistInput,
    service: Annotated[PortfolioService, Depends(get_portfolio_service)],
) -> Watchlist:
    return await service.create_watchlist(payload)


@router.get("/watchlists/{watchlist_id}", response_model=Watchlist)
async def get_watchlist(
    watchlist_id: str,
    service: Annotated[PortfolioService, Depends(get_portfolio_service)],
) -> Watchlist:
    try:
        return await service.get_watchlist(watchlist_id)
    except PortfolioNotFoundError as exc:
        raise HTTPException(status_code=404, detail=f"Watchlist {exc} not found")


@router.patch("/watchlists/{watchlist_id}", response_model=Watchlist)
async def update_watchlist(
    watchlist_id: str,
    payload: WatchlistInput,
    service: Annotated[PortfolioService, Depends(get_portfolio_service)],
) -> Watchlist:
    try:
        return await service.update_watchlist(watchlist_id, payload)
    except PortfolioNotFoundError as exc:
        raise HTTPException(status_code=404, detail=f"Watchlist {exc} not found")


@router.delete("/watchlists/{watchlist_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_watchlist(
    watchlist_id: str,
    service: Annotated[PortfolioService, Depends(get_portfolio_service)],
) -> Response:
    try:
        await service.delete_watchlist(watchlist_id)
    except PortfolioNotFoundError as exc:
        raise HTTPException(status_code=404, detail=f"Watchlist {exc} not found")
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post(
    "/watchlists/{watchlist_id}/convert-to-portfolio",
    response_model=PortfolioRecord,
    status_code=status.HTTP_201_CREATED,
)
async def watchlist_to_portfolio(
    watchlist_id: str,
    payload: WatchlistToPortfolioRequest,
    service: Annotated[PortfolioService, Depends(get_portfolio_service)],
) -> PortfolioRecord:
    try:
        return await service.watchlist_to_portfolio(
            watchlist_id,
            name=payload.name,
            base_currency=payload.base_currency,
        )
    except PortfolioNotFoundError as exc:
        raise HTTPException(status_code=404, detail=f"Watchlist {exc} not found")


__all__ = ["router"]
