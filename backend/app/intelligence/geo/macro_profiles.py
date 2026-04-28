"""Country macro profile dataset.

Every resolved place gets attached to one of these profiles via its
``country_code``. The profile is the bridge between a geographic hit and
the operational-risk reasoning layer — dependency templates consume
``currency_code``, ``logistics_hub``, commodity sensitivity, sector tags, and
exposure scores to build place-driven reasoning paths.

Values are calibrated for the wedge scenarios (Japan, Singapore, Hong Kong,
Egypt, Gulf states, New York). Scores are 0.0–1.0 qualitative signals — the
goal is order of magnitude, not spot accuracy. Where a fact would be
misleading if stated too precisely, prefer the sector tags + exposure scores
over numeric confidence theatre.
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True, slots=True)
class MacroProfile:
    """Static macro / operational profile for a country.

    Fields
    ------
    country_code
        ISO-3 alpha-3.
    currency_code
        ISO-4217 currency.
    logistics_hub
        ``True`` if the country acts as a major logistics / transshipment /
        financial hub whose disruption propagates cross-border.
    commodity_import_sensitivity
        ``{commodity: 0..1}`` — how exposed the country is to supply shocks
        in that commodity (e.g. JPN is highly exposed to crude/LNG imports).
    commodity_export_sensitivity
        ``{commodity: 0..1}`` — how exposed global markets are to *their*
        exports (e.g. SAU crude).
    sector_tags
        Dominant sectors that transmit shocks from this country.
    trade_dependence_score
        How much the country's GDP / output depends on cross-border trade.
        0 = closed economy, 1 = trade-dependent city-state.
    shipping_exposure
        Degree of exposure to maritime / shipping disruption.
    """

    country_code: str
    currency_code: str
    logistics_hub: bool
    commodity_import_sensitivity: dict[str, float] = field(default_factory=dict)
    commodity_export_sensitivity: dict[str, float] = field(default_factory=dict)
    sector_tags: tuple[str, ...] = field(default_factory=tuple)
    trade_dependence_score: float = 0.5
    shipping_exposure: float = 0.5


# -----------------------------------------------------------------------------
# Seed profiles
# -----------------------------------------------------------------------------

_SEED_PROFILES: tuple[MacroProfile, ...] = (
    MacroProfile(
        country_code="JPN",
        currency_code="JPY",
        logistics_hub=True,
        commodity_import_sensitivity={"crude_oil": 0.95, "lng": 0.95, "grain": 0.70},
        commodity_export_sensitivity={"semiconductors": 0.55, "autos": 0.75},
        sector_tags=("automotive", "electronics", "semiconductors", "machinery"),
        trade_dependence_score=0.72,
        shipping_exposure=0.88,
    ),
    MacroProfile(
        country_code="KOR",
        currency_code="KRW",
        logistics_hub=True,
        commodity_import_sensitivity={"crude_oil": 0.95, "lng": 0.90, "iron_ore": 0.75},
        commodity_export_sensitivity={"semiconductors": 0.90, "autos": 0.70},
        sector_tags=("semiconductors", "automotive", "chemicals", "shipbuilding"),
        trade_dependence_score=0.85,
        shipping_exposure=0.85,
    ),
    MacroProfile(
        country_code="CHN",
        currency_code="CNY",
        logistics_hub=True,
        commodity_import_sensitivity={
            "crude_oil": 0.85,
            "iron_ore": 0.85,
            "soybeans": 0.80,
            "copper": 0.80,
        },
        commodity_export_sensitivity={"steel": 0.80, "electronics": 0.90, "rare_earths": 0.95},
        sector_tags=("manufacturing", "electronics", "steel", "rare-earths"),
        trade_dependence_score=0.60,
        shipping_exposure=0.82,
    ),
    MacroProfile(
        country_code="HKG",
        currency_code="HKD",
        logistics_hub=True,
        commodity_import_sensitivity={"crude_oil": 0.90, "food": 0.95},
        commodity_export_sensitivity={"electronics": 0.60},
        sector_tags=("financial-services", "logistics", "re-export"),
        trade_dependence_score=0.95,
        shipping_exposure=0.92,
    ),
    MacroProfile(
        country_code="TWN",
        currency_code="TWD",
        logistics_hub=True,
        commodity_import_sensitivity={"crude_oil": 0.95, "lng": 0.95},
        commodity_export_sensitivity={"semiconductors": 0.98, "electronics": 0.80},
        sector_tags=("semiconductors", "electronics"),
        trade_dependence_score=0.85,
        shipping_exposure=0.85,
    ),
    MacroProfile(
        country_code="SGP",
        currency_code="SGD",
        logistics_hub=True,
        commodity_import_sensitivity={"crude_oil": 0.90, "food": 0.98, "water": 0.90},
        commodity_export_sensitivity={"refined_products": 0.80, "electronics": 0.55},
        sector_tags=("financial-services", "logistics", "refining", "electronics"),
        trade_dependence_score=0.98,
        shipping_exposure=0.98,
    ),
    MacroProfile(
        country_code="MYS",
        currency_code="MYR",
        logistics_hub=False,
        commodity_import_sensitivity={"food": 0.55},
        commodity_export_sensitivity={"palm_oil": 0.85, "lng": 0.60, "electronics": 0.55},
        sector_tags=("electronics", "palm-oil", "energy"),
        trade_dependence_score=0.70,
        shipping_exposure=0.78,
    ),
    MacroProfile(
        country_code="IDN",
        currency_code="IDR",
        logistics_hub=False,
        commodity_import_sensitivity={"crude_oil": 0.60},
        commodity_export_sensitivity={"coal": 0.85, "nickel": 0.90, "palm_oil": 0.80},
        sector_tags=("mining", "commodities", "agriculture"),
        trade_dependence_score=0.55,
        shipping_exposure=0.72,
    ),
    MacroProfile(
        country_code="USA",
        currency_code="USD",
        logistics_hub=True,
        commodity_import_sensitivity={"semiconductors": 0.55},
        commodity_export_sensitivity={
            "lng": 0.75,
            "crude_oil": 0.55,
            "grain": 0.70,
            "semiconductors": 0.55,
        },
        sector_tags=("technology", "finance", "aerospace", "energy", "agriculture"),
        trade_dependence_score=0.45,
        shipping_exposure=0.50,
    ),
    MacroProfile(
        country_code="GBR",
        currency_code="GBP",
        logistics_hub=True,
        commodity_import_sensitivity={"food": 0.60, "lng": 0.65},
        commodity_export_sensitivity={"financial_services": 0.75},
        sector_tags=("financial-services", "pharmaceuticals", "aerospace"),
        trade_dependence_score=0.60,
        shipping_exposure=0.55,
    ),
    MacroProfile(
        country_code="FRA",
        currency_code="EUR",
        logistics_hub=True,
        commodity_import_sensitivity={"crude_oil": 0.80, "lng": 0.70},
        commodity_export_sensitivity={"aerospace": 0.70, "luxury_goods": 0.60},
        sector_tags=("aerospace", "luxury", "nuclear", "pharmaceuticals"),
        trade_dependence_score=0.55,
        shipping_exposure=0.55,
    ),
    MacroProfile(
        country_code="DEU",
        currency_code="EUR",
        logistics_hub=True,
        commodity_import_sensitivity={"crude_oil": 0.85, "lng": 0.85},
        commodity_export_sensitivity={"autos": 0.80, "machinery": 0.80, "chemicals": 0.75},
        sector_tags=("automotive", "machinery", "chemicals", "engineering"),
        trade_dependence_score=0.70,
        shipping_exposure=0.60,
    ),
    MacroProfile(
        country_code="NLD",
        currency_code="EUR",
        logistics_hub=True,
        commodity_import_sensitivity={"crude_oil": 0.75},
        commodity_export_sensitivity={"refined_products": 0.80, "flowers": 0.65},
        sector_tags=("logistics", "energy-transit", "agri-trade"),
        trade_dependence_score=0.90,
        shipping_exposure=0.90,
    ),
    MacroProfile(
        country_code="EGY",
        currency_code="EGP",
        logistics_hub=True,
        commodity_import_sensitivity={"grain": 0.90, "crude_oil": 0.55},
        commodity_export_sensitivity={"natural_gas": 0.55, "suez_transit": 0.95},
        sector_tags=("logistics-transit", "agriculture", "energy"),
        trade_dependence_score=0.65,
        shipping_exposure=0.95,
    ),
    MacroProfile(
        country_code="SAU",
        currency_code="SAR",
        logistics_hub=True,
        commodity_import_sensitivity={"food": 0.80},
        commodity_export_sensitivity={"crude_oil": 0.95, "petrochemicals": 0.80},
        sector_tags=("oil", "petrochemicals"),
        trade_dependence_score=0.65,
        shipping_exposure=0.80,
    ),
    MacroProfile(
        country_code="ARE",
        currency_code="AED",
        logistics_hub=True,
        commodity_import_sensitivity={"food": 0.85},
        commodity_export_sensitivity={"crude_oil": 0.85, "re_export_goods": 0.90},
        sector_tags=("oil", "logistics", "finance", "aviation"),
        trade_dependence_score=0.85,
        shipping_exposure=0.90,
    ),
    MacroProfile(
        country_code="OMN",
        currency_code="OMR",
        logistics_hub=False,
        commodity_import_sensitivity={"food": 0.75},
        commodity_export_sensitivity={"crude_oil": 0.85, "lng": 0.75},
        sector_tags=("oil", "shipping"),
        trade_dependence_score=0.70,
        shipping_exposure=0.88,
    ),
    MacroProfile(
        country_code="YEM",
        currency_code="YER",
        logistics_hub=False,
        commodity_import_sensitivity={"food": 0.90, "crude_oil": 0.70},
        commodity_export_sensitivity={},
        sector_tags=("conflict-exposed",),
        trade_dependence_score=0.60,
        shipping_exposure=0.85,
    ),
    MacroProfile(
        country_code="IRN",
        currency_code="IRR",
        logistics_hub=False,
        commodity_import_sensitivity={"food": 0.70},
        commodity_export_sensitivity={"crude_oil": 0.80},
        sector_tags=("oil",),
        trade_dependence_score=0.55,
        shipping_exposure=0.80,
    ),
    MacroProfile(
        country_code="ISR",
        currency_code="ILS",
        logistics_hub=False,
        commodity_import_sensitivity={"crude_oil": 0.75},
        commodity_export_sensitivity={"tech": 0.60, "diamonds": 0.55},
        sector_tags=("technology", "defense", "diamonds"),
        trade_dependence_score=0.65,
        shipping_exposure=0.65,
    ),
)


_BY_CODE: dict[str, MacroProfile] = {p.country_code: p for p in _SEED_PROFILES}


def macro_profile_for(country_code: str | None) -> MacroProfile | None:
    """Look up the macro profile for a country (ISO-3 alpha-3)."""

    if not country_code:
        return None
    return _BY_CODE.get(country_code.upper())


def list_macro_profiles() -> tuple[MacroProfile, ...]:
    return _SEED_PROFILES


__all__ = [
    "MacroProfile",
    "list_macro_profiles",
    "macro_profile_for",
]
