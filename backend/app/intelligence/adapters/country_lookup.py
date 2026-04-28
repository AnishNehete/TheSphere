"""Lightweight country metadata used by adapters for normalization.

Kept deliberately small — just enough for the Phase 11 wedge (weather + news
over the ~60 most demo-relevant countries). Can be replaced by a proper
PostGIS-backed lookup once the adapters graduate past the in-memory stub.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class CountryMeta:
    code: str  # ISO alpha-3
    alpha2: str
    name: str
    latitude: float
    longitude: float
    region: str


_COUNTRIES: tuple[CountryMeta, ...] = (
    CountryMeta("USA", "US", "United States", 39.8283, -98.5795, "north-america"),
    CountryMeta("CAN", "CA", "Canada", 56.1304, -106.3468, "north-america"),
    CountryMeta("MEX", "MX", "Mexico", 23.6345, -102.5528, "north-america"),
    CountryMeta("BRA", "BR", "Brazil", -14.2350, -51.9253, "south-america"),
    CountryMeta("ARG", "AR", "Argentina", -38.4161, -63.6167, "south-america"),
    CountryMeta("CHL", "CL", "Chile", -35.6751, -71.5430, "south-america"),
    CountryMeta("GBR", "GB", "United Kingdom", 55.3781, -3.4360, "europe"),
    CountryMeta("FRA", "FR", "France", 46.6034, 1.8883, "europe"),
    CountryMeta("DEU", "DE", "Germany", 51.1657, 10.4515, "europe"),
    CountryMeta("ESP", "ES", "Spain", 40.4637, -3.7492, "europe"),
    CountryMeta("ITA", "IT", "Italy", 41.8719, 12.5674, "europe"),
    CountryMeta("NLD", "NL", "Netherlands", 52.1326, 5.2913, "europe"),
    CountryMeta("POL", "PL", "Poland", 51.9194, 19.1451, "europe"),
    CountryMeta("SWE", "SE", "Sweden", 60.1282, 18.6435, "europe"),
    CountryMeta("NOR", "NO", "Norway", 60.4720, 8.4689, "europe"),
    CountryMeta("FIN", "FI", "Finland", 61.9241, 25.7482, "europe"),
    CountryMeta("GRC", "GR", "Greece", 39.0742, 21.8243, "europe"),
    CountryMeta("PRT", "PT", "Portugal", 39.3999, -8.2245, "europe"),
    CountryMeta("IRL", "IE", "Ireland", 53.1424, -7.6921, "europe"),
    CountryMeta("TUR", "TR", "Turkey", 38.9637, 35.2433, "europe"),
    CountryMeta("UKR", "UA", "Ukraine", 48.3794, 31.1656, "europe"),
    CountryMeta("RUS", "RU", "Russia", 61.5240, 105.3188, "europe"),
    CountryMeta("MAR", "MA", "Morocco", 31.7917, -7.0926, "africa"),
    CountryMeta("EGY", "EG", "Egypt", 26.8206, 30.8025, "africa"),
    CountryMeta("NGA", "NG", "Nigeria", 9.0820, 8.6753, "africa"),
    CountryMeta("ZAF", "ZA", "South Africa", -30.5595, 22.9375, "africa"),
    CountryMeta("KEN", "KE", "Kenya", -0.0236, 37.9062, "africa"),
    CountryMeta("ETH", "ET", "Ethiopia", 9.1450, 40.4897, "africa"),
    CountryMeta("SDN", "SD", "Sudan", 12.8628, 30.2176, "africa"),
    CountryMeta("SAU", "SA", "Saudi Arabia", 23.8859, 45.0792, "middle-east"),
    CountryMeta("ARE", "AE", "United Arab Emirates", 23.4241, 53.8478, "middle-east"),
    CountryMeta("QAT", "QA", "Qatar", 25.3548, 51.1839, "middle-east"),
    CountryMeta("OMN", "OM", "Oman", 21.4735, 55.9754, "middle-east"),
    CountryMeta("YEM", "YE", "Yemen", 15.5527, 48.5164, "middle-east"),
    CountryMeta("IRQ", "IQ", "Iraq", 33.2232, 43.6793, "middle-east"),
    CountryMeta("IRN", "IR", "Iran", 32.4279, 53.6880, "middle-east"),
    CountryMeta("SYR", "SY", "Syria", 34.8021, 38.9968, "middle-east"),
    CountryMeta("LBN", "LB", "Lebanon", 33.8547, 35.8623, "middle-east"),
    CountryMeta("ISR", "IL", "Israel", 31.0461, 34.8516, "middle-east"),
    CountryMeta("JOR", "JO", "Jordan", 30.5852, 36.2384, "middle-east"),
    CountryMeta("IND", "IN", "India", 20.5937, 78.9629, "asia"),
    CountryMeta("PAK", "PK", "Pakistan", 30.3753, 69.3451, "asia"),
    CountryMeta("CHN", "CN", "China", 35.8617, 104.1954, "asia"),
    CountryMeta("JPN", "JP", "Japan", 36.2048, 138.2529, "asia"),
    CountryMeta("KOR", "KR", "South Korea", 35.9078, 127.7669, "asia"),
    CountryMeta("PRK", "KP", "North Korea", 40.3399, 127.5101, "asia"),
    CountryMeta("TWN", "TW", "Taiwan", 23.6978, 120.9605, "asia"),
    CountryMeta("VNM", "VN", "Vietnam", 14.0583, 108.2772, "asia"),
    CountryMeta("THA", "TH", "Thailand", 15.8700, 100.9925, "asia"),
    CountryMeta("SGP", "SG", "Singapore", 1.3521, 103.8198, "asia"),
    CountryMeta("MYS", "MY", "Malaysia", 4.2105, 101.9758, "asia"),
    CountryMeta("IDN", "ID", "Indonesia", -0.7893, 113.9213, "asia"),
    CountryMeta("PHL", "PH", "Philippines", 12.8797, 121.7740, "asia"),
    CountryMeta("AUS", "AU", "Australia", -25.2744, 133.7751, "asia"),
    CountryMeta("NZL", "NZ", "New Zealand", -40.9006, 174.8860, "asia"),
)

_BY_ALPHA3: dict[str, CountryMeta] = {c.code: c for c in _COUNTRIES}
_BY_ALPHA2: dict[str, CountryMeta] = {c.alpha2: c for c in _COUNTRIES}
_BY_NAME_LOWER: dict[str, CountryMeta] = {c.name.lower(): c for c in _COUNTRIES}


def list_countries() -> tuple[CountryMeta, ...]:
    return _COUNTRIES


def lookup_by_alpha3(code: str | None) -> CountryMeta | None:
    if not code:
        return None
    return _BY_ALPHA3.get(code.upper())


def lookup_by_alpha2(code: str | None) -> CountryMeta | None:
    if not code:
        return None
    return _BY_ALPHA2.get(code.upper())


def lookup_by_name(name: str | None) -> CountryMeta | None:
    """Resolve a free-form country name.

    Phase 19C.6 — the substring fallback used to match any common-English
    fragment to a country (``"is"`` → Israel because ``"is" in "isr"``;
    ``"in"`` → India; ``"at"`` → United States via ``"states"``). That made
    queries like ``"why is TSLA down"`` resolve to Israel and short-circuit
    the ticker / commodity entity resolver.

    The substring path is now gated on a minimum 4-character candidate.
    Two- and three-letter tokens fall through to ``lookup_by_alpha2`` /
    ``lookup_by_alpha3`` which are exact lookups. Stopwords ("the", "and",
    etc.) still hit the dict but only return when an exact name match.
    """

    if not name:
        return None
    candidate = name.strip().lower()
    if candidate in _BY_NAME_LOWER:
        return _BY_NAME_LOWER[candidate]
    if len(candidate) < 4:
        return None
    for key, meta in _BY_NAME_LOWER.items():
        if len(key) < 4:
            continue
        if candidate in key or key in candidate:
            return meta
    return None
