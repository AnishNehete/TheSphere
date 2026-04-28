"""Place resolver with hierarchical fallback.

Contract
--------

Given a raw query string, :meth:`PlaceResolver.resolve` returns a
:class:`ResolvedPlace` describing:

* the best-matching gazetteer entry (may be ``None`` if nothing hit)
* the resolved country (derived from the place or its ancestors)
* the immediate parent (city → country, country → region)
* anchor ``lat`` / ``lon``
* a confidence score in ``[0, 1]``
* the :class:`FallbackLevel` that actually fired — so UI / dependency
  reasoning can surface "we couldn't find Tokyo, so we answered with Japan"
  honestly, rather than pretending the hit was exact

Fallback policy
---------------

Retrieval order, stopping at the first hit:

1. ``exact``            — canonical name or alias matches the full query
2. ``alias_substring``  — a canonical name / alias appears inside the query
3. ``nearby_city``      — the query names or contains a city; we attach its
                          country as the resolved region for downstream code
                          that needs country-level evidence
4. ``parent_country``   — no place matched, but a country name / ISO code did
5. ``parent_region``    — only a region name matched (``"middle east"``,
                          ``"red sea"``, ...)
6. ``none``             — nothing resolved

Confidence drops as we walk down the ladder — exact hits get ~0.95, region
fallbacks get ~0.35 — so the analyst UI can refuse to render a dependency
path over a ``parent_region`` resolution if it wants.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from typing import Literal

from app.intelligence.adapters.country_lookup import (
    CountryMeta,
    lookup_by_alpha2,
    lookup_by_alpha3,
    lookup_by_name,
)
from app.intelligence.geo.gazetteer import Gazetteer, Place, gazetteer as default_gazetteer
from app.intelligence.geo.macro_profiles import MacroProfile, macro_profile_for


logger = logging.getLogger(__name__)


FallbackLevel = Literal[
    "exact",
    "alias_substring",
    "nearby_city",
    "parent_country",
    "parent_region",
    "none",
]


_FALLBACK_CONFIDENCE: dict[FallbackLevel, float] = {
    "exact": 0.95,
    "alias_substring": 0.80,
    "nearby_city": 0.75,
    "parent_country": 0.55,
    "parent_region": 0.35,
    "none": 0.0,
}


_TOKEN_RE = re.compile(r"[A-Za-z0-9À-ɏ一-鿿]+")

# Phase 19C.6 — short English / question stopwords whose ISO-2 / ISO-3
# alpha collisions used to misroute market queries to country fallback
# (e.g. "is" hits Israel via lookup_by_name, "in" hits India alpha-2,
# "at" hits United States via the "states" substring).
_COUNTRY_STOPWORDS: frozenset[str] = frozenset({
    "a", "an", "and", "as", "at", "be", "by", "do", "for", "from",
    "if", "in", "is", "it", "of", "on", "or", "so", "the", "to",
    "up", "vs", "why", "what", "when", "who", "how", "which",
    "are", "was", "did", "does", "has", "have", "now", "today",
    "yesterday", "tomorrow", "out", "over", "off", "down", "trend",
})


@dataclass(frozen=True, slots=True)
class ResolvedPlace:
    """Structured output of :meth:`PlaceResolver.resolve`."""

    query: str
    place: Place | None
    country: Place | None
    parent: Place | None
    latitude: float | None
    longitude: float | None
    confidence: float
    fallback_level: FallbackLevel
    macro_profile: MacroProfile | None
    # For UI / downstream — the gazetteer IDs we considered from best to worst.
    considered_ids: tuple[str, ...] = ()

    @property
    def country_code(self) -> str | None:
        return self.country.country_code if self.country else None

    @property
    def country_name(self) -> str | None:
        return self.country.name if self.country else None

    @property
    def place_type(self) -> str | None:
        return self.place.type if self.place else None

    @property
    def is_fallback(self) -> bool:
        return self.fallback_level not in ("exact", "none")


class PlaceResolver:
    """Resolve a free-text query to a gazetteer :class:`Place`."""

    def __init__(self, gz: Gazetteer | None = None) -> None:
        self._gazetteer = gz or default_gazetteer

    def resolve(self, query: str) -> ResolvedPlace:
        raw = (query or "").strip()
        if not raw:
            return _empty_result(raw)

        normalized = _normalize(raw)

        # 1. Exact full-string match against the gazetteer (fastest path).
        exact_hits = self._gazetteer.lookup_by_name(raw)
        if exact_hits:
            best = self._pick_best(exact_hits)
            return self._build_result(raw, best, "exact", tuple(p.id for p in exact_hits))

        # 2. Alias / canonical name as substring of the query.
        substring_hits = self._substring_matches(normalized)
        if substring_hits:
            best = self._pick_best(substring_hits)
            # If the best substring hit is a city, we still count it as
            # nearby_city (level 3) rather than exact — the user typed more
            # than just the city name.
            level: FallbackLevel = "alias_substring"
            if best.type in ("city", "port", "chokepoint"):
                level = "nearby_city"
            return self._build_result(
                raw, best, level, tuple(p.id for p in substring_hits)
            )

        # 3. Country / region fallback via the legacy country_lookup tables
        #    (they carry alpha-2 / alpha-3 forms that the gazetteer shouldn't
        #    have to re-enumerate).
        country_meta = self._country_fallback(raw)
        if country_meta is not None:
            country_place = self._gazetteer.by_id(f"country:{country_meta.code}")
            if country_place is not None:
                return self._build_result(
                    raw,
                    country_place,
                    "parent_country",
                    (country_place.id,),
                )
            # Country is known to the alpha tables but not seeded in the
            # gazetteer — synthesize a minimal Place so downstream code still
            # gets a country.
            synthetic = _synthetic_country_place(country_meta)
            return self._build_result(
                raw,
                synthetic,
                "parent_country",
                (synthetic.id,),
            )

        # 4. Region fallback — does any region name appear in the query?
        region_place = self._region_fallback(normalized)
        if region_place is not None:
            return self._build_result(
                raw,
                region_place,
                "parent_region",
                (region_place.id,),
            )

        return _empty_result(raw)

    # -- internals ------------------------------------------------------

    def _substring_matches(self, normalized_query: str) -> list[Place]:
        matches: list[tuple[Place, int]] = []
        seen_ids: set[str] = set()
        for place in self._gazetteer.iter():
            for label in place.names():
                key = _normalize(label)
                if not key or len(key) < 2:
                    continue
                if key in normalized_query and _is_word_boundary(normalized_query, key):
                    if place.id in seen_ids:
                        continue
                    seen_ids.add(place.id)
                    matches.append((place, len(key)))
                    break
        # prefer longer alias matches (to avoid "us" inside "austria")
        matches.sort(key=lambda item: item[1], reverse=True)
        return [p for p, _ in matches]

    def _pick_best(self, hits: list[Place]) -> Place:
        # Rank: city > port > chokepoint > country > region
        rank: dict[str, int] = {
            "city": 0,
            "port": 1,
            "chokepoint": 2,
            "country": 3,
            "region": 4,
        }
        return sorted(hits, key=lambda p: rank.get(p.type, 99))[0]

    def _country_fallback(self, raw: str) -> CountryMeta | None:
        meta = lookup_by_name(raw)
        if meta is not None:
            return meta
        for token in _TOKEN_RE.findall(raw):
            if len(token) < 2:
                continue
            lowered = token.lower()
            # Phase 19C.6 — common English stopwords were falling through
            # the alpha-2 lookup ("IN" → India, "IS" → Iceland) and
            # poisoning queries like "why is TSLA down" or "trend in USD".
            # Skipping them here keeps the alpha-2/alpha-3 fast paths for
            # legitimate ISO codes ("USA", "JPN", "CN") while no longer
            # treating English connectors as countries.
            if lowered in _COUNTRY_STOPWORDS:
                continue
            upper = token.upper()
            if len(upper) == 3:
                hit = lookup_by_alpha3(upper)
                if hit is not None:
                    return hit
            if len(upper) == 2:
                hit = lookup_by_alpha2(upper)
                if hit is not None:
                    return hit
            meta = lookup_by_name(token)
            if meta is not None:
                return meta
        return None

    def _region_fallback(self, normalized_query: str) -> Place | None:
        best: Place | None = None
        best_len = 0
        for place in self._gazetteer.iter():
            if place.type != "region":
                continue
            for label in place.names():
                key = _normalize(label)
                if not key:
                    continue
                if key in normalized_query and len(key) > best_len:
                    best = place
                    best_len = len(key)
                    break
        return best

    def _build_result(
        self,
        query: str,
        place: Place,
        level: FallbackLevel,
        considered: tuple[str, ...],
    ) -> ResolvedPlace:
        ancestors = self._gazetteer.ancestors_of(place)
        country = _find_country(place, ancestors, self._gazetteer)
        parent = (
            self._gazetteer.by_id(place.parent_id) if place.parent_id else None
        )
        macro = (
            macro_profile_for(country.country_code) if country else None
        )
        return ResolvedPlace(
            query=query,
            place=place,
            country=country,
            parent=parent,
            latitude=place.lat,
            longitude=place.lon,
            confidence=_FALLBACK_CONFIDENCE[level],
            fallback_level=level,
            macro_profile=macro,
            considered_ids=considered,
        )


# -----------------------------------------------------------------------------
# helpers
# -----------------------------------------------------------------------------


def _empty_result(query: str) -> ResolvedPlace:
    return ResolvedPlace(
        query=query,
        place=None,
        country=None,
        parent=None,
        latitude=None,
        longitude=None,
        confidence=_FALLBACK_CONFIDENCE["none"],
        fallback_level="none",
        macro_profile=None,
        considered_ids=(),
    )


def _find_country(
    place: Place,
    ancestors: tuple[Place, ...],
    gz: Gazetteer,
) -> Place | None:
    if place.type == "country":
        return place
    for ancestor in ancestors:
        if ancestor.type == "country":
            return ancestor
    if place.country_code:
        return gz.by_id(f"country:{place.country_code}")
    return None


def _normalize(value: str) -> str:
    if not value:
        return ""
    out: list[str] = []
    prev_space = False
    for ch in value.lower().strip():
        if ch.isalnum():
            out.append(ch)
            prev_space = False
        elif ch.isspace() or ch in "-_/.,":
            if not prev_space:
                out.append(" ")
                prev_space = True
    return "".join(out).strip()


def _is_word_boundary(haystack: str, needle: str) -> bool:
    """Guard against ``"us"`` inside ``"austria"`` or ``"sg"`` inside ``"ossiginiu"``.

    Returns ``True`` when ``needle`` occurs at a whitespace boundary in the
    already-normalized ``haystack``.
    """
    if needle not in haystack:
        return False
    padded = f" {haystack} "
    return f" {needle} " in padded or padded.startswith(f" {needle} ") or padded.endswith(f" {needle} ") or _boundary_found(haystack, needle)


def _boundary_found(haystack: str, needle: str) -> bool:
    idx = 0
    while True:
        pos = haystack.find(needle, idx)
        if pos == -1:
            return False
        left_ok = pos == 0 or not haystack[pos - 1].isalnum()
        right = pos + len(needle)
        right_ok = right == len(haystack) or not haystack[right].isalnum()
        if left_ok and right_ok:
            return True
        idx = pos + 1


def _synthetic_country_place(meta: CountryMeta) -> Place:
    return Place(
        id=f"country:{meta.code}",
        name=meta.name,
        type="country",
        lat=meta.latitude,
        lon=meta.longitude,
        country_code=meta.code,
        parent_id=None,
        aliases=(meta.alpha2.lower(), meta.code.lower()),
        bbox=None,
        tags=("synthetic",),
    )


# Module-level singleton. Tests can build their own PlaceResolver(gz=...).
place_resolver = PlaceResolver()


__all__ = [
    "FallbackLevel",
    "PlaceResolver",
    "ResolvedPlace",
    "place_resolver",
]
