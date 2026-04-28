"""Canonical place registry for Sphere.

Schema
------

Every entry is a :class:`Place` with:

* ``id``           — stable synthetic ID, e.g. ``"country:JPN"`` / ``"city:tokyo"``
* ``name``         — canonical display name (``"Tokyo"``)
* ``aliases``      — alternate spellings / names (``["東京", "tokio"]``)
* ``type``         — ``country`` | ``city`` | ``region`` | ``chokepoint`` | ``port``
* ``country_code`` — ISO-3 alpha-3 of the containing country, ``None`` for
                      multi-country regions like ``red-sea``
* ``parent_id``    — ID of the immediate parent (city → country, country →
                      region). ``None`` for the top of the hierarchy.
* ``lat`` / ``lon``— anchor point (float degrees). Regions use their centroid.
* ``bbox``         — optional ``(west, south, east, north)``
* ``tags``         — free-form semantic tags (``"financial-hub"``,
                      ``"shipping-route"``, ``"oil-chokepoint"``)

All lookups are case-insensitive and punctuation-tolerant. See
:mod:`app.intelligence.geo.resolver` for the matching algorithm.

Scope
-----

Deliberately small. Covers the wedge scenarios Sphere needs today plus
enough of Europe / Americas / MENA to demo cross-region reasoning. Extend
`_SEED_PLACES` when a new scenario proves its weight — don't preemptively
pull in a full geonames dump.
"""

from __future__ import annotations

from collections.abc import Iterable, Iterator
from dataclasses import dataclass, field
from typing import Literal


PlaceType = Literal["country", "city", "region", "chokepoint", "port"]


@dataclass(frozen=True, slots=True)
class Place:
    """Gazetteer entry. Immutable by design — entries come from static seed."""

    id: str
    name: str
    type: PlaceType
    lat: float
    lon: float
    country_code: str | None = None
    parent_id: str | None = None
    aliases: tuple[str, ...] = field(default_factory=tuple)
    bbox: tuple[float, float, float, float] | None = None
    tags: tuple[str, ...] = field(default_factory=tuple)

    def names(self) -> tuple[str, ...]:
        """All names this place answers to — canonical + aliases."""
        return (self.name, *self.aliases)


# -----------------------------------------------------------------------------
# Seed data
# -----------------------------------------------------------------------------

_REGIONS: tuple[Place, ...] = (
    Place(
        id="region:east-asia",
        name="East Asia",
        type="region",
        lat=35.0,
        lon=125.0,
        aliases=("far east", "east-asia"),
        tags=("region",),
    ),
    Place(
        id="region:southeast-asia",
        name="Southeast Asia",
        type="region",
        lat=5.0,
        lon=115.0,
        aliases=("sea", "asean", "south-east-asia"),
        tags=("region",),
    ),
    Place(
        id="region:middle-east",
        name="Middle East",
        type="region",
        lat=29.0,
        lon=45.0,
        aliases=("mena", "middle-east", "gulf"),
        tags=("region",),
    ),
    Place(
        id="region:north-america",
        name="North America",
        type="region",
        lat=40.0,
        lon=-100.0,
        aliases=("north-america",),
        tags=("region",),
    ),
    Place(
        id="region:europe",
        name="Europe",
        type="region",
        lat=50.0,
        lon=10.0,
        aliases=("eu", "eurozone"),
        tags=("region",),
    ),
    # multi-country water regions used by dependency reasoning
    Place(
        id="region:red-sea",
        name="Red Sea",
        type="region",
        lat=22.0,
        lon=38.0,
        aliases=("red sea corridor",),
        bbox=(32.5, 12.5, 43.5, 30.0),
        tags=("region", "shipping-route", "water"),
    ),
    Place(
        id="region:persian-gulf",
        name="Persian Gulf",
        type="region",
        lat=26.5,
        lon=51.5,
        aliases=("arabian gulf", "persian-gulf"),
        bbox=(48.0, 24.0, 57.0, 30.5),
        tags=("region", "shipping-route", "oil-corridor", "water"),
    ),
)


_COUNTRIES: tuple[Place, ...] = (
    Place(
        id="country:JPN",
        name="Japan",
        type="country",
        lat=36.2048,
        lon=138.2529,
        country_code="JPN",
        parent_id="region:east-asia",
        aliases=("jpn", "日本"),
        tags=("island-economy", "advanced"),
    ),
    Place(
        id="country:KOR",
        name="South Korea",
        type="country",
        lat=35.9078,
        lon=127.7669,
        country_code="KOR",
        parent_id="region:east-asia",
        aliases=("korea", "republic of korea", "kor"),
        tags=("advanced",),
    ),
    Place(
        id="country:CHN",
        name="China",
        type="country",
        lat=35.8617,
        lon=104.1954,
        country_code="CHN",
        parent_id="region:east-asia",
        aliases=("prc", "people's republic of china", "chn", "mainland china"),
        tags=("large-economy",),
    ),
    Place(
        id="country:HKG",
        name="Hong Kong",
        type="country",
        lat=22.3193,
        lon=114.1694,
        country_code="HKG",
        parent_id="region:east-asia",
        aliases=("hk", "hksar", "香港"),
        tags=("city-state", "financial-hub"),
    ),
    Place(
        id="country:TWN",
        name="Taiwan",
        type="country",
        lat=23.6978,
        lon=120.9605,
        country_code="TWN",
        parent_id="region:east-asia",
        aliases=("roc", "chinese taipei", "twn"),
        tags=("island-economy", "semiconductors"),
    ),
    Place(
        id="country:SGP",
        name="Singapore",
        type="country",
        lat=1.3521,
        lon=103.8198,
        country_code="SGP",
        parent_id="region:southeast-asia",
        aliases=("sgp", "republic of singapore"),
        tags=("city-state", "financial-hub", "shipping-hub"),
    ),
    Place(
        id="country:MYS",
        name="Malaysia",
        type="country",
        lat=4.2105,
        lon=101.9758,
        country_code="MYS",
        parent_id="region:southeast-asia",
        aliases=("mys",),
        tags=(),
    ),
    Place(
        id="country:IDN",
        name="Indonesia",
        type="country",
        lat=-0.7893,
        lon=113.9213,
        country_code="IDN",
        parent_id="region:southeast-asia",
        aliases=("idn", "republic of indonesia"),
        tags=(),
    ),
    Place(
        id="country:USA",
        name="United States",
        type="country",
        lat=39.8283,
        lon=-98.5795,
        country_code="USA",
        parent_id="region:north-america",
        aliases=("us", "usa", "united states of america", "america"),
        tags=("large-economy",),
    ),
    Place(
        id="country:GBR",
        name="United Kingdom",
        type="country",
        lat=55.3781,
        lon=-3.4360,
        country_code="GBR",
        parent_id="region:europe",
        aliases=("uk", "britain", "great britain", "gbr"),
        tags=(),
    ),
    Place(
        id="country:FRA",
        name="France",
        type="country",
        lat=46.6034,
        lon=1.8883,
        country_code="FRA",
        parent_id="region:europe",
        aliases=("fra",),
        tags=(),
    ),
    Place(
        id="country:DEU",
        name="Germany",
        type="country",
        lat=51.1657,
        lon=10.4515,
        country_code="DEU",
        parent_id="region:europe",
        aliases=("deu", "deutschland"),
        tags=("large-economy",),
    ),
    Place(
        id="country:NLD",
        name="Netherlands",
        type="country",
        lat=52.1326,
        lon=5.2913,
        country_code="NLD",
        parent_id="region:europe",
        aliases=("holland", "nld"),
        tags=("shipping-hub",),
    ),
    Place(
        id="country:EGY",
        name="Egypt",
        type="country",
        lat=26.8206,
        lon=30.8025,
        country_code="EGY",
        parent_id="region:middle-east",
        aliases=("egy",),
        tags=("logistics-transit",),
    ),
    Place(
        id="country:SAU",
        name="Saudi Arabia",
        type="country",
        lat=23.8859,
        lon=45.0792,
        country_code="SAU",
        parent_id="region:middle-east",
        aliases=("sau", "ksa", "kingdom of saudi arabia"),
        tags=("oil-exporter",),
    ),
    Place(
        id="country:ARE",
        name="United Arab Emirates",
        type="country",
        lat=23.4241,
        lon=53.8478,
        country_code="ARE",
        parent_id="region:middle-east",
        aliases=("uae", "are", "emirates"),
        tags=("oil-exporter", "logistics-hub"),
    ),
    Place(
        id="country:OMN",
        name="Oman",
        type="country",
        lat=21.4735,
        lon=55.9754,
        country_code="OMN",
        parent_id="region:middle-east",
        aliases=("omn", "sultanate of oman"),
        tags=("oil-exporter",),
    ),
    Place(
        id="country:YEM",
        name="Yemen",
        type="country",
        lat=15.5527,
        lon=48.5164,
        country_code="YEM",
        parent_id="region:middle-east",
        aliases=("yem",),
        tags=(),
    ),
    Place(
        id="country:IRN",
        name="Iran",
        type="country",
        lat=32.4279,
        lon=53.6880,
        country_code="IRN",
        parent_id="region:middle-east",
        aliases=("irn", "islamic republic of iran", "persia"),
        tags=("oil-exporter",),
    ),
    Place(
        id="country:ISR",
        name="Israel",
        type="country",
        lat=31.0461,
        lon=34.8516,
        country_code="ISR",
        parent_id="region:middle-east",
        aliases=("isr",),
        tags=(),
    ),
)


_CITIES: tuple[Place, ...] = (
    # Japan
    Place(
        id="city:tokyo",
        name="Tokyo",
        type="city",
        lat=35.6762,
        lon=139.6503,
        country_code="JPN",
        parent_id="country:JPN",
        aliases=("tokyo metropolis", "東京", "tokio"),
        tags=("megacity", "financial-hub"),
    ),
    Place(
        id="city:osaka",
        name="Osaka",
        type="city",
        lat=34.6937,
        lon=135.5023,
        country_code="JPN",
        parent_id="country:JPN",
        aliases=("osaka-fu", "大阪"),
        tags=("megacity",),
    ),
    Place(
        id="city:yokohama",
        name="Yokohama",
        type="city",
        lat=35.4437,
        lon=139.6380,
        country_code="JPN",
        parent_id="country:JPN",
        aliases=("横浜",),
        tags=("port-city",),
    ),
    # Korea / China
    Place(
        id="city:seoul",
        name="Seoul",
        type="city",
        lat=37.5665,
        lon=126.9780,
        country_code="KOR",
        parent_id="country:KOR",
        aliases=("서울",),
        tags=("megacity", "financial-hub"),
    ),
    Place(
        id="city:shanghai",
        name="Shanghai",
        type="city",
        lat=31.2304,
        lon=121.4737,
        country_code="CHN",
        parent_id="country:CHN",
        aliases=("上海",),
        tags=("megacity", "financial-hub", "port-city"),
    ),
    Place(
        id="city:shenzhen",
        name="Shenzhen",
        type="city",
        lat=22.5431,
        lon=114.0579,
        country_code="CHN",
        parent_id="country:CHN",
        aliases=("深圳",),
        tags=("megacity", "manufacturing"),
    ),
    Place(
        id="city:beijing",
        name="Beijing",
        type="city",
        lat=39.9042,
        lon=116.4074,
        country_code="CHN",
        parent_id="country:CHN",
        aliases=("peking", "北京"),
        tags=("megacity", "capital"),
    ),
    # Southeast Asia — Singapore is both a country and its capital city
    Place(
        id="city:singapore",
        name="Singapore City",
        type="city",
        lat=1.2966,
        lon=103.8520,
        country_code="SGP",
        parent_id="country:SGP",
        aliases=("singapore",),
        tags=("megacity", "financial-hub", "port-city"),
    ),
    # Hong Kong island-level city anchor
    Place(
        id="city:hong-kong",
        name="Hong Kong Island",
        type="city",
        lat=22.2793,
        lon=114.1628,
        country_code="HKG",
        parent_id="country:HKG",
        aliases=("hong kong", "central hong kong"),
        tags=("financial-hub", "port-city"),
    ),
    # North America
    Place(
        id="city:new-york",
        name="New York",
        type="city",
        lat=40.7128,
        lon=-74.0060,
        country_code="USA",
        parent_id="country:USA",
        aliases=("nyc", "new york city", "ny"),
        tags=("megacity", "financial-hub", "port-city"),
    ),
    Place(
        id="city:los-angeles",
        name="Los Angeles",
        type="city",
        lat=34.0522,
        lon=-118.2437,
        country_code="USA",
        parent_id="country:USA",
        aliases=("la", "los-angeles"),
        tags=("megacity", "port-city"),
    ),
    # Europe
    Place(
        id="city:london",
        name="London",
        type="city",
        lat=51.5074,
        lon=-0.1278,
        country_code="GBR",
        parent_id="country:GBR",
        aliases=("greater london",),
        tags=("megacity", "financial-hub"),
    ),
    Place(
        id="city:paris",
        name="Paris",
        type="city",
        lat=48.8566,
        lon=2.3522,
        country_code="FRA",
        parent_id="country:FRA",
        aliases=("île-de-france", "ile-de-france"),
        tags=("megacity",),
    ),
    Place(
        id="city:frankfurt",
        name="Frankfurt",
        type="city",
        lat=50.1109,
        lon=8.6821,
        country_code="DEU",
        parent_id="country:DEU",
        aliases=("frankfurt am main",),
        tags=("financial-hub",),
    ),
    Place(
        id="city:rotterdam",
        name="Rotterdam",
        type="city",
        lat=51.9244,
        lon=4.4777,
        country_code="NLD",
        parent_id="country:NLD",
        aliases=("rotterdam-rijnmond",),
        tags=("port-city",),
    ),
    # Middle East
    Place(
        id="city:dubai",
        name="Dubai",
        type="city",
        lat=25.2048,
        lon=55.2708,
        country_code="ARE",
        parent_id="country:ARE",
        aliases=("dxb",),
        tags=("financial-hub", "port-city"),
    ),
    Place(
        id="city:cairo",
        name="Cairo",
        type="city",
        lat=30.0444,
        lon=31.2357,
        country_code="EGY",
        parent_id="country:EGY",
        aliases=("al-qāhirah",),
        tags=("megacity", "capital"),
    ),
    Place(
        id="city:riyadh",
        name="Riyadh",
        type="city",
        lat=24.7136,
        lon=46.6753,
        country_code="SAU",
        parent_id="country:SAU",
        aliases=("al-riyadh",),
        tags=("capital",),
    ),
)


_CHOKEPOINTS: tuple[Place, ...] = (
    Place(
        id="chokepoint:suez",
        name="Suez Canal",
        type="chokepoint",
        lat=30.5852,
        lon=32.2654,
        country_code="EGY",
        parent_id="country:EGY",
        aliases=("suez", "suez passage"),
        bbox=(32.20, 29.90, 32.60, 31.30),
        tags=("shipping-chokepoint", "east-west-trade"),
    ),
    Place(
        id="chokepoint:bab-el-mandeb",
        name="Bab el-Mandeb",
        type="chokepoint",
        lat=12.5833,
        lon=43.3333,
        country_code=None,  # YEM / DJI split
        parent_id="region:red-sea",
        aliases=("bab-el-mandeb", "bab al-mandab", "gate of tears"),
        tags=("shipping-chokepoint", "oil-corridor"),
    ),
    Place(
        id="chokepoint:hormuz",
        name="Strait of Hormuz",
        type="chokepoint",
        lat=26.5667,
        lon=56.2500,
        country_code=None,  # OMN / IRN
        parent_id="region:persian-gulf",
        aliases=("hormuz", "strait-of-hormuz"),
        tags=("shipping-chokepoint", "oil-corridor"),
    ),
    Place(
        id="chokepoint:malacca",
        name="Strait of Malacca",
        type="chokepoint",
        lat=2.5000,
        lon=101.0000,
        country_code=None,  # MYS / SGP / IDN
        parent_id="region:southeast-asia",
        aliases=("malacca", "strait-of-malacca"),
        tags=("shipping-chokepoint",),
    ),
    Place(
        id="chokepoint:panama",
        name="Panama Canal",
        type="chokepoint",
        lat=9.0800,
        lon=-79.6800,
        country_code="PAN",
        parent_id=None,
        aliases=("panama",),
        tags=("shipping-chokepoint",),
    ),
)


_PORTS: tuple[Place, ...] = (
    Place(
        id="port:singapore",
        name="Port of Singapore",
        type="port",
        lat=1.2644,
        lon=103.8400,
        country_code="SGP",
        parent_id="city:singapore",
        aliases=("psa", "singapore port"),
        tags=("container-mega-port", "transshipment"),
    ),
    Place(
        id="port:hong-kong",
        name="Port of Hong Kong",
        type="port",
        lat=22.3089,
        lon=114.2270,
        country_code="HKG",
        parent_id="city:hong-kong",
        aliases=("kwai tsing", "hkg port"),
        tags=("container-mega-port",),
    ),
    Place(
        id="port:shanghai",
        name="Port of Shanghai",
        type="port",
        lat=30.6333,
        lon=122.0833,
        country_code="CHN",
        parent_id="city:shanghai",
        aliases=("yangshan", "shanghai port"),
        tags=("container-mega-port",),
    ),
    Place(
        id="port:rotterdam",
        name="Port of Rotterdam",
        type="port",
        lat=51.9500,
        lon=4.1428,
        country_code="NLD",
        parent_id="city:rotterdam",
        aliases=("rotterdam port",),
        tags=("container-mega-port", "europe-gateway"),
    ),
    Place(
        id="port:new-york",
        name="Port of New York and New Jersey",
        type="port",
        lat=40.6650,
        lon=-74.0460,
        country_code="USA",
        parent_id="city:new-york",
        aliases=("pony-nj", "port of new york", "newark port"),
        tags=("container-mega-port", "east-coast-gateway"),
    ),
    Place(
        id="port:jebel-ali",
        name="Port Jebel Ali",
        type="port",
        lat=24.9857,
        lon=55.0272,
        country_code="ARE",
        parent_id="city:dubai",
        aliases=("jebel ali", "dp world jebel ali"),
        tags=("container-mega-port", "middle-east-gateway"),
    ),
    Place(
        id="port:tokyo",
        name="Port of Tokyo",
        type="port",
        lat=35.6186,
        lon=139.7724,
        country_code="JPN",
        parent_id="city:tokyo",
        aliases=("tokyo port",),
        tags=("container-port",),
    ),
)


_SEED_PLACES: tuple[Place, ...] = (
    *_REGIONS,
    *_COUNTRIES,
    *_CITIES,
    *_CHOKEPOINTS,
    *_PORTS,
)


# -----------------------------------------------------------------------------
# Indexes
# -----------------------------------------------------------------------------


class Gazetteer:
    """In-memory place registry with name / alias / id indexes.

    The registry is built once at import time. Keep instance state read-only —
    callers should never mutate a :class:`Place`. If you need to extend the
    dataset for tests, use :meth:`with_extras` to build a derived gazetteer.
    """

    def __init__(self, places: Iterable[Place]) -> None:
        self._places: tuple[Place, ...] = tuple(places)
        self._by_id: dict[str, Place] = {p.id: p for p in self._places}
        # name/alias index uses normalized keys → list[Place] (to handle
        # collisions like "singapore" resolving to both country + city).
        self._by_name: dict[str, list[Place]] = {}
        for place in self._places:
            for label in place.names():
                key = _normalize(label)
                if not key:
                    continue
                self._by_name.setdefault(key, []).append(place)

    # -- read-only API --------------------------------------------------

    def all(self) -> tuple[Place, ...]:
        return self._places

    def by_id(self, place_id: str) -> Place | None:
        return self._by_id.get(place_id)

    def by_country(self, country_code: str) -> tuple[Place, ...]:
        code = country_code.upper()
        return tuple(p for p in self._places if p.country_code == code)

    def by_parent(self, parent_id: str) -> tuple[Place, ...]:
        return tuple(p for p in self._places if p.parent_id == parent_id)

    def children_of(self, place: Place) -> tuple[Place, ...]:
        return self.by_parent(place.id)

    def ancestors_of(self, place: Place) -> tuple[Place, ...]:
        """Walk parent_id links up to the root. Excludes ``place`` itself."""
        chain: list[Place] = []
        current = place
        seen: set[str] = {current.id}
        while current.parent_id:
            parent = self._by_id.get(current.parent_id)
            if parent is None or parent.id in seen:
                break
            chain.append(parent)
            seen.add(parent.id)
            current = parent
        return tuple(chain)

    def lookup_by_name(self, label: str) -> list[Place]:
        key = _normalize(label)
        if not key:
            return []
        return list(self._by_name.get(key, ()))

    def iter(self) -> Iterator[Place]:
        return iter(self._places)


def _normalize(value: str) -> str:
    """Lowercase + strip punctuation + collapse whitespace. Safe for aliasing."""

    if not value:
        return ""
    out_chars: list[str] = []
    prev_space = False
    for ch in value.lower().strip():
        if ch.isalnum():
            out_chars.append(ch)
            prev_space = False
        elif ch.isspace() or ch in "-_/":
            if not prev_space:
                out_chars.append(" ")
                prev_space = True
    return "".join(out_chars).strip()


# Module-level singleton. Tests can still build isolated gazetteers.
gazetteer = Gazetteer(_SEED_PLACES)


def list_places() -> tuple[Place, ...]:
    """All seeded places, in insertion order."""
    return gazetteer.all()


def list_places_by_country(country_code: str) -> tuple[Place, ...]:
    """All gazetteer entries whose ``country_code`` matches (ISO alpha-3)."""
    return gazetteer.by_country(country_code)


__all__ = [
    "Gazetteer",
    "Place",
    "PlaceType",
    "gazetteer",
    "list_places",
    "list_places_by_country",
]
