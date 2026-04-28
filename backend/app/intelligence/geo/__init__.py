"""Geographic intelligence foundation.

This package provides the structural backbone for search-first investigation:

* :mod:`app.intelligence.geo.gazetteer`     — canonical place registry
  (countries, cities, regions, chokepoints, ports)
* :mod:`app.intelligence.geo.macro_profiles` — country macro economic profile
  (currency, logistics hub, sector tags, shipping exposure)
* :mod:`app.intelligence.geo.resolver`      — exact + alias + token matching
  with hierarchical fallback (place → nearby city → country → region)

The gazetteer is deliberately small but representative — it covers the wedge
scenarios Sphere needs today (Tokyo/Osaka/Singapore/Hong Kong/New York,
Red Sea, Suez, Strait of Hormuz, etc.). A later phase can swap the in-memory
store for a Postgres/PostGIS-backed implementation without touching callers:
everything downstream consumes the :class:`ResolvedPlace` / :class:`Place`
contracts, not the storage.
"""

from app.intelligence.geo.gazetteer import (
    Place,
    PlaceType,
    gazetteer,
    list_places,
    list_places_by_country,
)
from app.intelligence.geo.macro_profiles import (
    MacroProfile,
    macro_profile_for,
)
from app.intelligence.geo.resolver import (
    FallbackLevel,
    PlaceResolver,
    ResolvedPlace,
    place_resolver,
)

__all__ = [
    "FallbackLevel",
    "MacroProfile",
    "Place",
    "PlaceResolver",
    "PlaceType",
    "ResolvedPlace",
    "gazetteer",
    "list_places",
    "list_places_by_country",
    "macro_profile_for",
    "place_resolver",
]
