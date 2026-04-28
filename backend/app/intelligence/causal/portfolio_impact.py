"""Phase 19B — causal chain → portfolio holding linkage.

A small, deterministic mapper that walks a :class:`CausalChainSet` and
projects its ``affected_symbols`` / ``affected_domains`` onto an analyst
portfolio. The output is a tight, evidence-anchored explanation of
*which holdings the driver touches* — never a P&L estimate, never a
trade recommendation.

Design rules:

* The builder is a pure function. It does not fetch quotes, mutate the
  causal chain, or run any LLM logic.
* Exposure type is one of ``direct`` / ``indirect`` / ``weak``:

  - ``direct``   — chain symbol matches a holding ticker
  - ``indirect`` — chain domain matches a holding sector / asset class
                    (e.g. ``oil`` ↔ ``energy`` sector, ``fx`` ↔ ``cash`` /
                    foreign-currency holdings)
  - ``weak``     — chain domain matches a holding's country exposure or
                    a soft macro tag (currency / region) but no symbol or
                    sector tag was provided

* Honest caveats are appended whenever metadata is missing — the user
  must never be tricked into thinking we mapped exposure we did not see.
* The card hides itself when the portfolio has zero impacted holdings.
* Demo / paper portfolios are flagged via ``is_demo`` so the UI can
  label the surface honestly.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import TYPE_CHECKING, Iterable, Literal

from pydantic import BaseModel, ConfigDict, Field

from app.intelligence.causal.model import (
    CausalChain,
    CausalChainSet,
    ImpactDirection,
    ImpactDomain,
)

if TYPE_CHECKING:  # pragma: no cover - typing only
    # Import the portfolio shapes only for static type checkers. Pulling
    # the portfolio package at module load triggers a circular import
    # via the schemas package; the builder uses these types as inputs
    # at call time so importing them lazily is sufficient.
    from app.intelligence.portfolio.schemas import Holding, PortfolioRecord


ExposureType = Literal["direct", "indirect", "weak"]


# ---------------------------------------------------------------------------
# Domain ↔ sector / asset-class mapping
# ---------------------------------------------------------------------------
#
# Conservative, hand-curated map. Anything not in this table falls
# through to "no indirect match", which keeps the surface honest.

_DOMAIN_SECTOR_KEYWORDS: dict[ImpactDomain, tuple[str, ...]] = {
    "oil": ("energy", "oil", "petroleum", "refining", "exploration"),
    "shipping": ("transport", "shipping", "logistics", "marine", "freight"),
    "logistics": ("transport", "logistics", "industrials", "rail"),
    "supply_chain": ("industrials", "consumer", "manufacturing"),
    "weather": ("agriculture", "utilities", "insurance"),
    "fx": ("financials", "banks", "fx"),
    "commodities": ("materials", "metals", "mining", "energy", "agriculture"),
    # `equities` and `sector` are intentionally empty: the chain's
    # affected_symbols list is the only honest way to claim equity-level
    # exposure. Broadcasting "equities → every equity holding" would be
    # noise dressed as signal.
    "equities": (),
    "country_risk": ("financials",),
    "sector": (),
    "macro": ("financials",),
    "portfolio": (),
    "unknown": (),
}


_DOMAIN_ASSET_TYPES: dict[ImpactDomain, tuple[str, ...]] = {
    "oil": ("commodity",),
    "commodities": ("commodity",),
    "fx": ("fx", "cash"),
    # See note above — `equities` does not bind by asset type.
}


# ---------------------------------------------------------------------------
# Wire shapes
# ---------------------------------------------------------------------------


class ImpactedHolding(BaseModel):
    """One holding the causal chain set touches."""

    model_config = ConfigDict(frozen=True)

    holding_id: str
    symbol: str
    name: str | None = None
    asset_type: str | None = None
    sector: str | None = None
    country_code: str | None = None
    weight: float = Field(default=0.0, ge=0.0, le=1.0)

    exposure_type: ExposureType
    matched_chain_id: str
    matched_driver_id: str | None = None
    matched_symbol: str | None = None
    matched_domain: ImpactDomain | None = None

    impact_direction: ImpactDirection = "unknown"
    confidence: float = Field(default=0.0, ge=0.0, le=1.0)
    rationale: str
    caveats: list[str] = Field(default_factory=list)


class PortfolioImpact(BaseModel):
    """Envelope returned alongside the agent response."""

    model_config = ConfigDict(frozen=False)

    generated_at: datetime
    portfolio_id: str
    portfolio_name: str
    is_demo: bool = False
    holdings_count: int = 0
    impacted_holdings: list[ImpactedHolding] = Field(default_factory=list)
    matched_chain_ids: list[str] = Field(default_factory=list)
    summary: str
    caveats: list[str] = Field(default_factory=list)

    def is_empty(self) -> bool:
        return not self.impacted_holdings


__all__ = [
    "ExposureType",
    "ImpactedHolding",
    "PortfolioImpact",
    "build_portfolio_impact",
    "is_demo_portfolio",
]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


_DEMO_KEYWORDS: tuple[str, ...] = (
    "demo",
    "paper",
    "sample",
    "example",
    "sandbox",
    "trial",
    "test",
)


def is_demo_portfolio(portfolio: PortfolioRecord) -> bool:
    """Heuristic — a portfolio is demo when its name/tags say so.

    The frontend uses this to label the impact card honestly. We never
    imply real capital from a portfolio whose name or tags clearly
    advertise demo / paper status.
    """

    name = (portfolio.name or "").lower()
    if any(keyword in name for keyword in _DEMO_KEYWORDS):
        return True
    for tag in portfolio.tags:
        if tag.lower() in _DEMO_KEYWORDS:
            return True
    return False


def _normalize_symbol(value: str | None) -> str:
    return (value or "").strip().upper()


def _holding_text_haystack(holding: Holding) -> str:
    parts: list[str] = []
    if holding.sector:
        parts.append(holding.sector)
    if holding.asset_type:
        parts.append(holding.asset_type)
    if holding.region:
        parts.append(holding.region)
    metadata = holding.metadata or {}
    for key in ("industry", "theme", "sub_sector", "asset_class"):
        value = metadata.get(key)
        if isinstance(value, str):
            parts.append(value)
    return " ".join(parts).lower()


def _direction_for(chain: CausalChain) -> ImpactDirection:
    return chain.direction


def _confidence_for(
    chain: CausalChain,
    *,
    base: float,
    penalty: float,
) -> float:
    raw = max(0.0, min(1.0, chain.confidence * base - penalty))
    return round(raw, 3)


def _match_direct(
    chain: CausalChain,
    holding: Holding,
) -> ImpactedHolding | None:
    holding_symbol = _normalize_symbol(holding.symbol)
    if not holding_symbol:
        return None
    for symbol in chain.affected_symbols:
        if _normalize_symbol(symbol) == holding_symbol:
            return ImpactedHolding(
                holding_id=holding.id,
                symbol=holding.symbol,
                name=holding.name,
                asset_type=holding.asset_type,
                sector=holding.sector,
                country_code=holding.country_code,
                weight=holding.weight,
                exposure_type="direct",
                matched_chain_id=chain.chain_id,
                matched_driver_id=None,
                matched_symbol=symbol,
                matched_domain=None,
                impact_direction=_direction_for(chain),
                confidence=_confidence_for(chain, base=1.0, penalty=0.0),
                rationale=(
                    f"{symbol} appears directly on the causal chain "
                    f"'{chain.title}'."
                ),
                caveats=list(chain.caveats),
            )
    return None


def _match_indirect(
    chain: CausalChain,
    holding: Holding,
) -> ImpactedHolding | None:
    haystack = _holding_text_haystack(holding)
    if not haystack and not holding.asset_type:
        return None
    holding_asset = (holding.asset_type or "").lower()
    for domain in chain.affected_domains:
        sector_keywords = _DOMAIN_SECTOR_KEYWORDS.get(domain, ())
        asset_types = _DOMAIN_ASSET_TYPES.get(domain, ())
        sector_hit = any(keyword in haystack for keyword in sector_keywords)
        asset_hit = bool(holding_asset) and holding_asset in asset_types
        if not (sector_hit or asset_hit):
            continue
        caveats = list(chain.caveats)
        if not holding.sector and sector_hit is False:
            caveats.append(
                f"{holding.symbol} has no sector tag; matched on asset type only."
            )
        return ImpactedHolding(
            holding_id=holding.id,
            symbol=holding.symbol,
            name=holding.name,
            asset_type=holding.asset_type,
            sector=holding.sector,
            country_code=holding.country_code,
            weight=holding.weight,
            exposure_type="indirect",
            matched_chain_id=chain.chain_id,
            matched_driver_id=None,
            matched_symbol=None,
            matched_domain=domain,
            impact_direction=_direction_for(chain),
            confidence=_confidence_for(chain, base=0.7, penalty=0.05),
            rationale=(
                f"{holding.symbol} sits in the {domain} channel via "
                f"{holding.sector or holding.asset_type or 'asset class'}."
            ),
            caveats=caveats,
        )
    return None


def _match_weak(
    chain: CausalChain,
    holding: Holding,
) -> ImpactedHolding | None:
    if not holding.country_code:
        return None
    weak_domains: tuple[ImpactDomain, ...] = (
        "country_risk",
        "macro",
        "fx",
        "shipping",
        "logistics",
        "supply_chain",
    )
    if not any(domain in weak_domains for domain in chain.affected_domains):
        return None
    matched = next(
        (d for d in chain.affected_domains if d in weak_domains),
        None,
    )
    if matched is None:
        return None
    caveat = (
        f"{holding.symbol} is mapped via country exposure ({holding.country_code}); "
        f"sector / industry metadata is not provided."
    )
    return ImpactedHolding(
        holding_id=holding.id,
        symbol=holding.symbol,
        name=holding.name,
        asset_type=holding.asset_type,
        sector=holding.sector,
        country_code=holding.country_code,
        weight=holding.weight,
        exposure_type="weak",
        matched_chain_id=chain.chain_id,
        matched_driver_id=None,
        matched_symbol=None,
        matched_domain=matched,
        impact_direction=_direction_for(chain),
        confidence=_confidence_for(chain, base=0.45, penalty=0.05),
        rationale=(
            f"{holding.symbol} carries country exposure to "
            f"{holding.country_code} which sits in the {matched} channel."
        ),
        caveats=[caveat, *chain.caveats],
    )


def _match_holding(
    chain: CausalChain,
    holding: Holding,
) -> ImpactedHolding | None:
    direct = _match_direct(chain, holding)
    if direct is not None:
        return direct
    indirect = _match_indirect(chain, holding)
    if indirect is not None:
        return indirect
    return _match_weak(chain, holding)


def _summary_line(
    portfolio: PortfolioRecord,
    impacted: list[ImpactedHolding],
    *,
    is_demo: bool,
) -> str:
    if not impacted:
        return (
            f"No holdings in {portfolio.name} matched the active causal drivers."
        )
    direct = sum(1 for h in impacted if h.exposure_type == "direct")
    indirect = sum(1 for h in impacted if h.exposure_type == "indirect")
    weak = sum(1 for h in impacted if h.exposure_type == "weak")
    parts: list[str] = []
    if direct:
        parts.append(f"{direct} direct")
    if indirect:
        parts.append(f"{indirect} indirect")
    if weak:
        parts.append(f"{weak} weak")
    label = portfolio.name
    if is_demo:
        label = f"{label} (demo book)"
    return f"{label}: {', '.join(parts)} exposure to active drivers."


def build_portfolio_impact(
    chain_set: CausalChainSet | None,
    portfolio: PortfolioRecord | None,
    *,
    now: datetime | None = None,
) -> PortfolioImpact | None:
    """Project causal chains onto portfolio holdings.

    Returns ``None`` when:

    * the portfolio is missing
    * the portfolio has zero holdings
    * the chain set is missing or empty
    * the chain set has chains but none touch any holding

    The card surface uses ``None`` to hide itself entirely so legacy
    response shapes remain unchanged.
    """

    if portfolio is None:
        return None
    holdings = list(portfolio.holdings)
    if not holdings:
        return None
    if chain_set is None or chain_set.is_empty():
        return None

    generated_at = now or datetime.now(timezone.utc)
    is_demo = is_demo_portfolio(portfolio)
    impacted: list[ImpactedHolding] = []
    matched_chain_ids: set[str] = set()
    seen: set[str] = set()

    # Iterate chains in the order the builder emitted them so the top
    # driver claims any holding before secondary drivers do.
    for chain in chain_set.chains:
        for holding in holdings:
            if holding.id in seen:
                continue
            match = _match_holding(chain, holding)
            if match is None:
                continue
            impacted.append(match)
            matched_chain_ids.add(chain.chain_id)
            seen.add(holding.id)

    if not impacted:
        return None

    # Stable ranking: direct > indirect > weak, then by holding weight desc.
    rank = {"direct": 0, "indirect": 1, "weak": 2}
    impacted.sort(key=lambda h: (rank[h.exposure_type], -h.weight, h.symbol))

    caveats: list[str] = []
    if is_demo:
        caveats.append(
            "Mapped against a demo / paper book — no real capital is implied."
        )
    if any(not h.sector for h in impacted):
        caveats.append(
            "Some holdings lack sector metadata; indirect matches use asset "
            "type or country exposure as a fallback."
        )

    summary = _summary_line(portfolio, impacted, is_demo=is_demo)

    return PortfolioImpact(
        generated_at=generated_at,
        portfolio_id=portfolio.id,
        portfolio_name=portfolio.name,
        is_demo=is_demo,
        holdings_count=len(holdings),
        impacted_holdings=impacted,
        matched_chain_ids=sorted(matched_chain_ids),
        summary=summary,
        caveats=caveats,
    )
