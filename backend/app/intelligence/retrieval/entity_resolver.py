"""Phase 18C — query-level entity resolution and domain inference.

The agent already had two scoped resolvers: :mod:`compare_planner` (per
compare leg) and :mod:`workers._resolve_entities` (post-place hint). What
was missing was a single, deterministic surface that answers the
upstream question every retrieval worker needs:

    "Given this raw query, what *one* canonical entity is the analyst
    asking about, and which domain should we filter retrieval to?"

This module ships that surface as :class:`QueryEntity`. It is rule-based
and side-effect free; no LLM, no network, no fuzzy library — just an
ordered ladder of strict matchers (commodity → fx pair → ticker → place →
country alpha-3) that can be reasoned about line by line.

Design rules:

* Failure is explicit. When the matcher ladder bottoms out, the result is
  ``QueryEntity(kind="unresolved", domain="unknown", resolution="none")``;
  callers must then refuse to fall back to the global corpus.
* Domain inference is conservative. ``"oil"`` ⇒ ``commodities``;
  ``"tesla"`` ⇒ ``equities``; a country alone ⇒ ``multi`` (so the
  retrieval pipeline keeps weather + conflict + currency for it).
* Synonyms are case-insensitive and word-boundary anchored so ``"oil"``
  inside ``"oilseeds"`` does not match a commodity.
* Commodities carry their related ticker symbols (``oil`` → ``CL``,
  ``BZ``) so the relevance gate in :mod:`scope_filter` can hard-include
  signals tagged with those symbols.

Output is consumed by :class:`QueryPlanner` and the orchestrator's
relevance filter.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Literal

from app.intelligence.adapters.country_lookup import (
    lookup_by_alpha3,
    lookup_by_name,
)
from app.intelligence.geo.resolver import (
    PlaceResolver,
    place_resolver as default_place_resolver,
)


EntityKind = Literal[
    "country",
    "place",
    "ticker",
    "fx_pair",
    "commodity",
    "sector",
    "unresolved",
]

EntityDomain = Literal[
    "equities",
    "commodities",
    "fx",
    "weather",
    "conflict",
    "news",
    "multi",
    "unknown",
]

EntityResolution = Literal["exact", "alias", "fallback", "none"]


@dataclass(frozen=True, slots=True)
class QueryEntity:
    """The single canonical entity for a query.

    ``related_symbols`` carries any tickers that the entity maps to so
    that downstream relevance gating can match a commodity query against
    e.g. WTI / Brent ticker tags directly.
    """

    raw: str
    kind: EntityKind
    canonical_id: str | None
    label: str
    domain: EntityDomain
    country_code: str | None = None
    confidence: float = 0.0
    resolution: EntityResolution = "none"
    related_symbols: tuple[str, ...] = field(default_factory=tuple)
    aliases: tuple[str, ...] = field(default_factory=tuple)

    @property
    def is_resolved(self) -> bool:
        return self.kind != "unresolved" and self.resolution != "none"

    @property
    def is_commodity(self) -> bool:
        return self.kind == "commodity"

    @property
    def is_market(self) -> bool:
        return self.kind in ("ticker", "fx_pair", "commodity")


# ----------------------------------------------------------------------------
# Static maps — keep small, additive, and recruiter-legible.
# ----------------------------------------------------------------------------


# Commodity synonyms → (canonical_id, label, domain, related_symbols, aliases)
_COMMODITY_SYNONYMS: dict[str, tuple[str, str, tuple[str, ...], tuple[str, ...]]] = {
    "oil":          ("commodity:OIL",   "Crude Oil",       ("CL", "BZ"),  ("oil", "crude", "crude oil", "petroleum")),
    "crude":        ("commodity:OIL",   "Crude Oil",       ("CL", "BZ"),  ("oil", "crude")),
    "wti":          ("commodity:WTI",   "WTI Crude",       ("CL",),       ("wti", "wti crude", "us crude")),
    "brent":        ("commodity:BRENT", "Brent Crude",     ("BZ",),       ("brent",)),
    "petroleum":    ("commodity:OIL",   "Crude Oil",       ("CL", "BZ"),  ("petroleum", "oil")),
    "gold":         ("commodity:GOLD",  "Gold",            ("GC",),       ("gold", "xau")),
    "silver":       ("commodity:SILVER","Silver",          ("SI",),       ("silver", "xag")),
    "copper":       ("commodity:COPPER","Copper",          ("HG",),       ("copper",)),
    "natgas":       ("commodity:NATGAS","Natural Gas",     ("NG",),       ("natgas", "natural gas", "gas")),
    "wheat":        ("commodity:WHEAT", "Wheat",           ("ZW",),       ("wheat",)),
    "corn":         ("commodity:CORN",  "Corn",            ("ZC",),       ("corn",)),
}

# FX pairs the system knows about. Each entry maps the spoken form (and
# the contracted form ``USDJPY``) to the canonical pair.
_FX_PAIRS: dict[str, tuple[str, str]] = {
    "usdjpy":  ("fx:USDJPY",  "USD/JPY"),
    "eurusd":  ("fx:EURUSD",  "EUR/USD"),
    "gbpusd":  ("fx:GBPUSD",  "GBP/USD"),
    "usdcny":  ("fx:USDCNY",  "USD/CNY"),
    "usdchf":  ("fx:USDCHF",  "USD/CHF"),
    "usdcad":  ("fx:USDCAD",  "USD/CAD"),
}

_FX_NICKNAMES: dict[str, str] = {
    "yen":          "usdjpy",
    "japanese yen": "usdjpy",
    "euro":         "eurusd",
    "sterling":     "gbpusd",
    "pound":        "gbpusd",
    "swiss franc":  "usdchf",
    "loonie":       "usdcad",
    "yuan":         "usdcny",
    "renminbi":     "usdcny",
}

_FX_PAIR_REGEX = re.compile(
    r"\b(usd|eur|jpy|gbp|cny|chf|cad)\s*[/-]?\s*(usd|eur|jpy|gbp|cny|chf|cad)\b",
    re.IGNORECASE,
)

# Equity tickers — same set as :mod:`compare_planner`, with the spoken
# company name added so ``"why tesla down"`` resolves the same as ``TSLA``.
_KNOWN_TICKERS: dict[str, tuple[str, str]] = {
    "AAPL": ("Apple Inc.", "USA"),
    "MSFT": ("Microsoft Corp.", "USA"),
    "NVDA": ("NVIDIA Corp.", "USA"),
    "TSLA": ("Tesla Inc.", "USA"),
    "SPY":  ("SPDR S&P 500 ETF", "USA"),
    "GOOG": ("Alphabet Inc.", "USA"),
    "AMZN": ("Amazon.com Inc.", "USA"),
    "META": ("Meta Platforms Inc.", "USA"),
}

_TICKER_NICKNAMES: dict[str, str] = {
    "apple":      "AAPL",
    "microsoft":  "MSFT",
    "nvidia":     "NVDA",
    "tesla":      "TSLA",
    "alphabet":   "GOOG",
    "google":     "GOOG",
    "amazon":     "AMZN",
    "meta":       "META",
    "facebook":   "META",
}


# ----------------------------------------------------------------------------
# Public API
# ----------------------------------------------------------------------------


def resolve_query_entity(
    query: str,
    *,
    place_resolver: PlaceResolver | None = None,
) -> QueryEntity:
    """Resolve the dominant entity in ``query``.

    Walks an ordered ladder; the first match wins. Returns
    ``unresolved`` rather than guessing when nothing matches — callers
    must surface "No entity resolved" instead of falling back to the
    global corpus.
    """

    text = (query or "").strip()
    if not text:
        return _unresolved(text)

    lowered = text.lower()

    fx = _try_fx(text, lowered)
    if fx is not None:
        return fx

    commodity = _try_commodity(lowered, raw=text)
    if commodity is not None:
        return commodity

    ticker = _try_ticker(text, lowered)
    if ticker is not None:
        return ticker

    resolver = place_resolver or default_place_resolver
    place = _try_place(text, resolver)
    if place is not None:
        return place

    country = _try_country_token(text)
    if country is not None:
        return country

    return _unresolved(text)


def is_relevant(
    *,
    event_type: str,
    event_tags: tuple[str, ...] | list[str],
    event_country_code: str | None,
    event_haystack: str,
    entity: QueryEntity,
) -> bool:
    """Phase 18C scope gate — ``True`` when the signal belongs to the entity.

    Rules (in order, first matching rule wins):

    * ``unresolved`` — never relevant. The orchestrator must show
      ``"No entity resolved for query"`` rather than leak global data.
    * ``commodity``  — must mention the commodity name, an alias, or
      one of its related symbols. Weather is excluded unless the event
      explicitly tags the commodity (e.g. hurricane → oil rigs).
    * ``ticker``     — must mention the ticker symbol or company label
      in title/summary/tags, OR be a markets-class event in the same
      country as the ticker's listing.
    * ``fx_pair``    — currency-class event mentioning either side of
      the pair.
    * ``country`` / ``place`` — country-code match is sufficient
      (multi-domain queries return all categories for that country).
    """

    if entity.kind == "unresolved":
        return False

    haystack = event_haystack.lower()
    tags = tuple(t.lower() for t in event_tags)

    if entity.kind == "commodity":
        if event_type == "weather":
            # Weather only relevant when the event explicitly references
            # the commodity (e.g. "hurricane disrupts Gulf oil platforms").
            return _commodity_keyword_hit(entity, haystack, tags)
        return _commodity_keyword_hit(entity, haystack, tags) or event_type in (
            "commodities",
            "markets",
            "stocks",
        ) and _commodity_keyword_hit(entity, haystack, tags)

    if entity.kind == "ticker":
        symbol = (entity.canonical_id or "").split(":", 1)[-1].lower()
        label_low = entity.label.lower()
        company_token = label_low.split(" ", 1)[0]
        if symbol and symbol in haystack:
            return True
        if company_token and len(company_token) >= 4 and company_token in haystack:
            return True
        if any(symbol in tag or company_token in tag for tag in tags):
            return True
        # Same-country fallback is intentionally rejected — a Tesla
        # query must not leak Apple rows just because both list in the
        # same market. Force an explicit textual match.
        return False

    if entity.kind == "fx_pair":
        if event_type not in ("currency", "markets", "news"):
            return False
        sides = _fx_sides(entity)
        return any(side.lower() in haystack for side in sides)

    if entity.kind in ("country", "place"):
        if entity.country_code and event_country_code == entity.country_code:
            return True
        # place / city queries fall through to whatever the place
        # resolver attached to the event during ingest; we accept a
        # text match against the entity name as a permissive fallback.
        if entity.label and entity.label.lower() in haystack:
            return True
        return False

    return False


# ----------------------------------------------------------------------------
# Matchers — each returns ``None`` when not applicable.
# ----------------------------------------------------------------------------


def _try_fx(raw: str, lowered: str) -> QueryEntity | None:
    # Direct ``USDJPY`` form.
    fx_match = _FX_PAIR_REGEX.search(raw)
    if fx_match:
        key = (fx_match.group(1) + fx_match.group(2)).lower()
        if key in _FX_PAIRS:
            cid, label = _FX_PAIRS[key]
            return QueryEntity(
                raw=raw,
                kind="fx_pair",
                canonical_id=cid,
                label=label,
                domain="fx",
                confidence=0.95,
                resolution="exact",
                aliases=tuple(_FX_PAIRS.keys()),
            )

    # Spoken nicknames — ``yen`` → USDJPY.
    for nick, key in _FX_NICKNAMES.items():
        if _word_boundary_contains(lowered, nick):
            cid, label = _FX_PAIRS[key]
            return QueryEntity(
                raw=raw,
                kind="fx_pair",
                canonical_id=cid,
                label=label,
                domain="fx",
                confidence=0.7,
                resolution="alias",
                aliases=(nick,),
            )

    # Bare ``usd`` / ``eur`` / ``jpy`` etc. — treat as fx domain hint
    # paired against USD when the query reads as a single currency.
    bare = re.fullmatch(
        r"\s*(?:trend\s+in\s+|trend\s+for\s+)?(usd|eur|jpy|gbp|cny|chf|cad)\s*",
        lowered,
    )
    if bare:
        code = bare.group(1).upper()
        if code == "USD":
            cid, label = _FX_PAIRS["eurusd"]
            return QueryEntity(
                raw=raw,
                kind="fx_pair",
                canonical_id=cid,
                label=label,
                domain="fx",
                confidence=0.55,
                resolution="alias",
                aliases=("usd",),
            )
        pair_key = f"usd{code.lower()}"
        if pair_key in _FX_PAIRS:
            cid, label = _FX_PAIRS[pair_key]
            return QueryEntity(
                raw=raw,
                kind="fx_pair",
                canonical_id=cid,
                label=label,
                domain="fx",
                confidence=0.6,
                resolution="alias",
                aliases=(code.lower(),),
            )
    return None


def _try_commodity(lowered: str, *, raw: str) -> QueryEntity | None:
    for synonym, (cid, label, symbols, aliases) in _COMMODITY_SYNONYMS.items():
        if _word_boundary_contains(lowered, synonym):
            confidence = 0.9 if synonym in (label.lower(), aliases[0]) else 0.75
            return QueryEntity(
                raw=raw,
                kind="commodity",
                canonical_id=cid,
                label=label,
                domain="commodities",
                confidence=confidence,
                resolution="exact" if confidence >= 0.85 else "alias",
                related_symbols=symbols,
                aliases=aliases,
            )
    return None


def _try_ticker(raw: str, lowered: str) -> QueryEntity | None:
    # Nicknames first so "tesla" resolves before random uppercase tokens.
    for nick, symbol in _TICKER_NICKNAMES.items():
        if _word_boundary_contains(lowered, nick):
            name, country = _KNOWN_TICKERS[symbol]
            return QueryEntity(
                raw=raw,
                kind="ticker",
                canonical_id=f"ticker:{symbol}",
                label=name,
                domain="equities",
                country_code=country,
                confidence=0.85,
                resolution="alias",
                aliases=(nick, symbol.lower()),
            )

    for token in re.findall(r"\b[A-Z]{2,5}\b", raw):
        if token in _KNOWN_TICKERS:
            name, country = _KNOWN_TICKERS[token]
            return QueryEntity(
                raw=raw,
                kind="ticker",
                canonical_id=f"ticker:{token}",
                label=name,
                domain="equities",
                country_code=country,
                confidence=0.95,
                resolution="exact",
                aliases=(token.lower(),),
            )
    return None


def _try_place(raw: str, resolver: PlaceResolver) -> QueryEntity | None:
    resolved = resolver.resolve(raw)
    if resolved.fallback_level == "none" or resolved.place is None:
        return None
    place = resolved.place
    kind: EntityKind
    if place.type == "country":
        kind = "country"
    else:
        kind = "place"
    confidence = float(resolved.confidence)
    if resolved.fallback_level == "exact":
        resolution: EntityResolution = "exact"
    elif resolved.fallback_level in ("alias_substring", "nearby_city"):
        resolution = "alias"
    else:
        resolution = "fallback"
    return QueryEntity(
        raw=raw,
        kind=kind,
        canonical_id=place.id,
        label=place.name,
        domain="multi",
        country_code=resolved.country_code,
        confidence=confidence,
        resolution=resolution,
        aliases=tuple(place.aliases or ()),
    )


def _try_country_token(raw: str) -> QueryEntity | None:
    upper = raw.strip().upper()
    if len(upper) == 3:
        meta = lookup_by_alpha3(upper)
        if meta is not None:
            return QueryEntity(
                raw=raw,
                kind="country",
                canonical_id=f"country:{meta.code}",
                label=meta.name,
                domain="multi",
                country_code=meta.code,
                confidence=0.7,
                resolution="alias",
            )
    meta = lookup_by_name(raw)
    if meta is not None:
        return QueryEntity(
            raw=raw,
            kind="country",
            canonical_id=f"country:{meta.code}",
            label=meta.name,
            domain="multi",
            country_code=meta.code,
            confidence=0.65,
            resolution="alias",
        )
    return None


# ----------------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------------


def _unresolved(raw: str) -> QueryEntity:
    return QueryEntity(
        raw=raw,
        kind="unresolved",
        canonical_id=None,
        label=raw or "(unresolved)",
        domain="unknown",
        confidence=0.0,
        resolution="none",
    )


def _word_boundary_contains(text: str, needle: str) -> bool:
    pattern = re.compile(rf"\b{re.escape(needle)}\b", re.IGNORECASE)
    return pattern.search(text) is not None


def _commodity_keyword_hit(
    entity: QueryEntity,
    haystack: str,
    tags: tuple[str, ...],
) -> bool:
    needles = set(entity.aliases) | {entity.label.lower()}
    for needle in needles:
        if needle and needle in haystack:
            return True
    symbols = {sym.lower() for sym in entity.related_symbols}
    for sym in symbols:
        if sym in haystack:
            return True
        if any(sym == tag or sym in tag for tag in tags):
            return True
    return False


def _fx_sides(entity: QueryEntity) -> tuple[str, ...]:
    cid = (entity.canonical_id or "").split(":", 1)[-1]
    if len(cid) == 6:
        return (cid[:3], cid[3:])
    return ()


__all__ = [
    "EntityDomain",
    "EntityKind",
    "EntityResolution",
    "QueryEntity",
    "is_relevant",
    "resolve_query_entity",
]
