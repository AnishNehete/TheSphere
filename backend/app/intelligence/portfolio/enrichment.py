"""Symbol → metadata enrichment for portfolio holdings.

Phase 13A ships a deliberately small, hand-curated catalogue (~40 symbols)
covering the wedge demo cases: US mega-caps, Japanese exporters, EU
financials, MENA energy, semiconductors, shipping, and broad ETFs. The
catalogue is the only place that turns "AAPL" into a country / sector /
currency / commodity-exposure record — every other module trusts the
returned :class:`SymbolMeta`.

When a symbol is not in the catalogue the enrichment returns ``None`` and
``enrich_holding`` falls back to whatever metadata the user provided. We
never fabricate a country / sector for an unknown symbol.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from app.intelligence.portfolio.repository import generate_id
from app.intelligence.portfolio.schemas import (
    AssetType,
    Holding,
    HoldingInput,
)


@dataclass(frozen=True, slots=True)
class SymbolMeta:
    """Static metadata for a known ticker / ETF / commodity proxy."""

    symbol: str
    name: str
    asset_type: AssetType
    country_code: str
    currency: str
    exchange: str | None = None
    sector: str | None = None
    region: str | None = None
    # Sector / commodity / chokepoint exposures — values are 0..1 weights.
    # The exposure service merges these onto the portfolio-level graph.
    sector_exposure: dict[str, float] = field(default_factory=dict)
    commodity_exposure: dict[str, float] = field(default_factory=dict)
    macro_themes: tuple[str, ...] = ()
    chokepoints: tuple[str, ...] = ()


# Common alias forms map to canonical tickers.
_ALIASES: dict[str, str] = {
    "BRK.B": "BRK-B",
    "BRKB": "BRK-B",
    "GOOG": "GOOGL",
}


_SEED: tuple[SymbolMeta, ...] = (
    # ---- US large-cap tech ----
    SymbolMeta(
        symbol="AAPL", name="Apple Inc.", asset_type="equity",
        country_code="USA", currency="USD", exchange="NASDAQ",
        sector="Technology", region="north-america",
        sector_exposure={"technology": 1.0, "consumer-electronics": 0.8},
        commodity_exposure={"semiconductors": 0.6, "rare_earths": 0.4},
        macro_themes=("supply-chain-asia", "consumer-discretionary"),
        chokepoints=("malacca",),
    ),
    SymbolMeta(
        symbol="MSFT", name="Microsoft Corp.", asset_type="equity",
        country_code="USA", currency="USD", exchange="NASDAQ",
        sector="Technology",
        sector_exposure={"technology": 1.0, "cloud": 0.9},
        macro_themes=("ai-capex",),
    ),
    SymbolMeta(
        symbol="NVDA", name="NVIDIA Corp.", asset_type="equity",
        country_code="USA", currency="USD", exchange="NASDAQ",
        sector="Technology",
        sector_exposure={"semiconductors": 1.0, "ai-capex": 0.9},
        commodity_exposure={"semiconductors": 1.0},
        macro_themes=("ai-capex", "taiwan-supply-chain"),
        chokepoints=("taiwan-strait",),
    ),
    SymbolMeta(
        symbol="GOOGL", name="Alphabet Inc.", asset_type="equity",
        country_code="USA", currency="USD", exchange="NASDAQ",
        sector="Technology",
        sector_exposure={"technology": 1.0, "advertising": 0.7},
    ),
    SymbolMeta(
        symbol="AMZN", name="Amazon.com Inc.", asset_type="equity",
        country_code="USA", currency="USD", exchange="NASDAQ",
        sector="Consumer Discretionary",
        sector_exposure={"e-commerce": 0.7, "cloud": 0.6, "logistics": 0.5},
        macro_themes=("consumer-discretionary",),
    ),
    SymbolMeta(
        symbol="META", name="Meta Platforms Inc.", asset_type="equity",
        country_code="USA", currency="USD", exchange="NASDAQ",
        sector="Technology",
        sector_exposure={"technology": 1.0, "advertising": 0.9},
    ),
    SymbolMeta(
        symbol="TSLA", name="Tesla Inc.", asset_type="equity",
        country_code="USA", currency="USD", exchange="NASDAQ",
        sector="Consumer Discretionary",
        sector_exposure={"automotive": 1.0, "battery": 0.8},
        commodity_exposure={"lithium": 0.7, "nickel": 0.5, "copper": 0.4},
        macro_themes=("ev-transition",),
    ),
    SymbolMeta(
        symbol="BRK-B", name="Berkshire Hathaway", asset_type="equity",
        country_code="USA", currency="USD", exchange="NYSE",
        sector="Financials",
        sector_exposure={"financials": 0.6, "insurance": 0.5, "industrials": 0.3},
    ),

    # ---- US broad ETFs ----
    SymbolMeta(
        symbol="SPY", name="SPDR S&P 500 ETF", asset_type="etf",
        country_code="USA", currency="USD", exchange="NYSE",
        sector="Broad Equity",
        sector_exposure={"technology": 0.28, "financials": 0.13, "healthcare": 0.13},
        macro_themes=("us-equity-beta",),
    ),
    SymbolMeta(
        symbol="QQQ", name="Invesco QQQ Trust", asset_type="etf",
        country_code="USA", currency="USD", exchange="NASDAQ",
        sector="Technology",
        sector_exposure={"technology": 0.55, "consumer-discretionary": 0.18},
    ),
    SymbolMeta(
        symbol="XLE", name="Energy Select Sector SPDR", asset_type="etf",
        country_code="USA", currency="USD", exchange="NYSE",
        sector="Energy",
        sector_exposure={"oil-and-gas": 1.0},
        commodity_exposure={"crude_oil": 0.95, "natural_gas": 0.5},
        macro_themes=("oil-cycle",),
        chokepoints=("hormuz", "suez"),
    ),
    SymbolMeta(
        symbol="XLF", name="Financial Select Sector SPDR", asset_type="etf",
        country_code="USA", currency="USD", exchange="NYSE",
        sector="Financials",
        sector_exposure={"financials": 1.0, "banks": 0.6, "insurance": 0.3},
    ),
    SymbolMeta(
        symbol="ICLN", name="iShares Global Clean Energy", asset_type="etf",
        country_code="USA", currency="USD", exchange="NASDAQ",
        sector="Renewable Energy",
        sector_exposure={"renewable-energy": 1.0, "utilities": 0.4},
        commodity_exposure={"copper": 0.6, "lithium": 0.5},
    ),
    SymbolMeta(
        symbol="USO", name="United States Oil Fund", asset_type="commodity",
        country_code="USA", currency="USD", exchange="NYSE",
        sector="Commodities",
        commodity_exposure={"crude_oil": 1.0},
        chokepoints=("hormuz", "suez"),
    ),
    SymbolMeta(
        symbol="GLD", name="SPDR Gold Shares", asset_type="commodity",
        country_code="USA", currency="USD", exchange="NYSE",
        sector="Commodities",
        commodity_exposure={"gold": 1.0},
        macro_themes=("safe-haven",),
    ),

    # ---- US airlines + shipping (oil + chokepoint exposed) ----
    SymbolMeta(
        symbol="DAL", name="Delta Air Lines", asset_type="equity",
        country_code="USA", currency="USD", exchange="NYSE",
        sector="Industrials",
        sector_exposure={"airlines": 1.0, "tourism": 0.6},
        commodity_exposure={"jet_fuel": 0.85, "crude_oil": 0.7},
        macro_themes=("oil-cycle", "weather-disruption"),
    ),
    SymbolMeta(
        symbol="UAL", name="United Airlines", asset_type="equity",
        country_code="USA", currency="USD", exchange="NASDAQ",
        sector="Industrials",
        sector_exposure={"airlines": 1.0, "tourism": 0.6},
        commodity_exposure={"jet_fuel": 0.85, "crude_oil": 0.7},
        macro_themes=("oil-cycle", "weather-disruption"),
    ),

    # ---- Japan ----
    SymbolMeta(
        symbol="7203.T", name="Toyota Motor", asset_type="equity",
        country_code="JPN", currency="JPY", exchange="TSE",
        sector="Automotive", region="east-asia",
        sector_exposure={"automotive": 1.0},
        commodity_exposure={"crude_oil": 0.4, "steel": 0.5},
        macro_themes=("yen-weakness", "global-trade"),
        chokepoints=("malacca",),
    ),
    SymbolMeta(
        symbol="6758.T", name="Sony Group", asset_type="equity",
        country_code="JPN", currency="JPY", exchange="TSE",
        sector="Technology",
        sector_exposure={"electronics": 1.0, "entertainment": 0.5},
        commodity_exposure={"semiconductors": 0.6},
    ),
    SymbolMeta(
        symbol="EWJ", name="iShares MSCI Japan ETF", asset_type="etf",
        country_code="JPN", currency="USD", exchange="NYSE",
        sector="Broad Equity",
        sector_exposure={"automotive": 0.18, "electronics": 0.18, "machinery": 0.15},
        macro_themes=("yen-weakness",),
    ),

    # ---- Korea / Taiwan ----
    SymbolMeta(
        symbol="TSM", name="Taiwan Semiconductor Mfg.", asset_type="adr",
        country_code="TWN", currency="USD", exchange="NYSE",
        sector="Technology",
        sector_exposure={"semiconductors": 1.0},
        commodity_exposure={"semiconductors": 1.0},
        macro_themes=("taiwan-supply-chain", "ai-capex"),
        chokepoints=("taiwan-strait", "malacca"),
    ),
    SymbolMeta(
        symbol="005930.KS", name="Samsung Electronics", asset_type="equity",
        country_code="KOR", currency="KRW", exchange="KRX",
        sector="Technology",
        sector_exposure={"semiconductors": 0.7, "electronics": 0.6},
        commodity_exposure={"semiconductors": 0.7},
    ),

    # ---- Europe ----
    SymbolMeta(
        symbol="ASML", name="ASML Holding", asset_type="equity",
        country_code="NLD", currency="EUR", exchange="AEX",
        sector="Semiconductors",
        sector_exposure={"semiconductors": 1.0, "machinery": 0.4},
        commodity_exposure={"semiconductors": 1.0},
        macro_themes=("ai-capex", "taiwan-supply-chain"),
    ),
    SymbolMeta(
        symbol="SAP", name="SAP SE", asset_type="equity",
        country_code="DEU", currency="EUR", exchange="XETRA",
        sector="Technology",
        sector_exposure={"technology": 1.0, "enterprise-software": 0.9},
    ),
    SymbolMeta(
        symbol="BMW.DE", name="Bayerische Motoren Werke", asset_type="equity",
        country_code="DEU", currency="EUR", exchange="XETRA",
        sector="Automotive",
        sector_exposure={"automotive": 1.0, "luxury": 0.5},
        commodity_exposure={"steel": 0.5, "crude_oil": 0.3},
        macro_themes=("global-trade",),
    ),
    SymbolMeta(
        symbol="MAERSK-B.CO", name="A.P. Moller-Maersk", asset_type="equity",
        country_code="DNK", currency="DKK", exchange="CSE",
        sector="Industrials",
        sector_exposure={"shipping": 1.0, "logistics": 1.0},
        commodity_exposure={"crude_oil": 0.6},
        macro_themes=("global-trade", "freight-rates"),
        chokepoints=("suez", "bab-el-mandeb", "hormuz", "malacca", "panama"),
    ),
    SymbolMeta(
        symbol="HSBA.L", name="HSBC Holdings", asset_type="equity",
        country_code="GBR", currency="GBP", exchange="LSE",
        sector="Financials",
        sector_exposure={"banks": 1.0, "financials": 1.0},
        macro_themes=("asia-banking",),
    ),
    SymbolMeta(
        symbol="EWG", name="iShares MSCI Germany ETF", asset_type="etf",
        country_code="DEU", currency="USD", exchange="NYSE",
        sector="Broad Equity",
        sector_exposure={"automotive": 0.15, "machinery": 0.2, "chemicals": 0.15},
    ),

    # ---- MENA ----
    SymbolMeta(
        symbol="2222.SR", name="Saudi Aramco", asset_type="equity",
        country_code="SAU", currency="SAR", exchange="Tadawul",
        sector="Energy",
        sector_exposure={"oil-and-gas": 1.0},
        commodity_exposure={"crude_oil": 1.0, "natural_gas": 0.5},
        macro_themes=("oil-cycle",),
        chokepoints=("hormuz",),
    ),
    SymbolMeta(
        symbol="EMAAR.AE", name="Emaar Properties", asset_type="equity",
        country_code="ARE", currency="AED", exchange="DFM",
        sector="Real Estate",
        sector_exposure={"real-estate": 1.0, "tourism": 0.4},
    ),

    # ---- FX / cash proxies ----
    SymbolMeta(
        symbol="UUP", name="Invesco DB US Dollar Bullish Fund", asset_type="fx",
        country_code="USA", currency="USD",
        macro_themes=("usd-strength",),
    ),
    SymbolMeta(
        symbol="FXY", name="Invesco CurrencyShares Japanese Yen Trust", asset_type="fx",
        country_code="JPN", currency="USD",
        macro_themes=("yen-weakness",),
    ),

    # ---- Other broad ETFs ----
    SymbolMeta(
        symbol="EEM", name="iShares MSCI Emerging Markets ETF", asset_type="etf",
        country_code="USA", currency="USD", exchange="NYSE",
        sector="Broad Equity",
        sector_exposure={"em-equity": 1.0},
        macro_themes=("emerging-markets",),
    ),
    SymbolMeta(
        symbol="VWO", name="Vanguard FTSE Emerging Markets", asset_type="etf",
        country_code="USA", currency="USD", exchange="NYSE",
        sector="Broad Equity",
        sector_exposure={"em-equity": 1.0},
        macro_themes=("emerging-markets",),
    ),
)


_BY_SYMBOL: dict[str, SymbolMeta] = {meta.symbol: meta for meta in _SEED}


def normalize_symbol(symbol: str) -> str:
    """Canonical form for a ticker.

    * upper-cases
    * trims whitespace
    * applies the alias table (e.g. ``GOOG`` → ``GOOGL``)
    """

    if not symbol:
        return ""
    cleaned = symbol.strip().upper()
    return _ALIASES.get(cleaned, cleaned)


def lookup_symbol(symbol: str) -> SymbolMeta | None:
    """Return the static metadata for ``symbol`` if known, else ``None``."""

    if not symbol:
        return None
    canonical = normalize_symbol(symbol)
    return _BY_SYMBOL.get(canonical)


def known_symbols() -> tuple[str, ...]:
    return tuple(_BY_SYMBOL.keys())


def enrich_holding(
    *,
    portfolio_id: str,
    holding_input: HoldingInput,
    holding_id: str | None = None,
) -> Holding:
    """Translate a :class:`HoldingInput` into a persisted :class:`Holding`.

    Enrichment confidence:
    * ``1.0`` — symbol resolves and the user provided no overrides
    * ``0.8`` — symbol resolves but user provided overrides we kept
    * ``0.3`` — symbol unknown; we keep whatever the user supplied
    """

    canonical = normalize_symbol(holding_input.symbol)
    meta = _BY_SYMBOL.get(canonical)
    new_id = holding_id or generate_id("hld")

    if meta is None:
        return Holding(
            id=new_id,
            portfolio_id=portfolio_id,
            symbol=canonical or holding_input.symbol,
            quantity=holding_input.quantity,
            average_cost=holding_input.average_cost,
            currency=(holding_input.currency or "USD").upper(),
            asset_type=holding_input.asset_type or "equity",
            exchange=holding_input.exchange,
            sector=holding_input.sector,
            country_code=(holding_input.country_code or "").upper() or None,
            notes=holding_input.notes,
            enrichment_confidence=0.3,
            metadata={"source": "user", "enriched": False},
        )

    used_overrides = any(
        getattr(holding_input, attr)
        for attr in ("currency", "asset_type", "exchange", "sector", "country_code")
    )
    enrichment_confidence = 0.8 if used_overrides else 1.0

    return Holding(
        id=new_id,
        portfolio_id=portfolio_id,
        symbol=meta.symbol,
        name=meta.name,
        quantity=holding_input.quantity,
        average_cost=holding_input.average_cost,
        currency=(holding_input.currency or meta.currency).upper(),
        asset_type=holding_input.asset_type or meta.asset_type,
        exchange=holding_input.exchange or meta.exchange,
        region=meta.region,
        sector=holding_input.sector or meta.sector,
        country_code=(holding_input.country_code or meta.country_code).upper(),
        notes=holding_input.notes,
        enrichment_confidence=enrichment_confidence,
        metadata={
            "source": "user",
            "enriched": True,
            "sector_exposure": dict(meta.sector_exposure),
            "commodity_exposure": dict(meta.commodity_exposure),
            "macro_themes": list(meta.macro_themes),
            "chokepoints": list(meta.chokepoints),
        },
    )


__all__ = [
    "SymbolMeta",
    "enrich_holding",
    "known_symbols",
    "lookup_symbol",
    "normalize_symbol",
]
