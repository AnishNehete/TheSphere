"""Multi-entity compare planner.

Phase 18A.1 fix: queries like "Compare Japan and Korea" or "AAPL vs MSFT"
were silently collapsing to a single place via :class:`SearchService`.
This planner detects the compare phrase, splits the query into legs, and
resolves each leg through the gazetteer / ticker / FX tables — preserving
both targets through to the orchestrator.

Output is a typed :class:`ComparePlan`. The planner is deterministic and
side-effect free; the orchestrator decides whether to run a compare worker
based on ``ComparePlan.requested``.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Literal

from app.intelligence.adapters.country_lookup import lookup_by_alpha3, lookup_by_name
from app.intelligence.geo.resolver import (
    PlaceResolver,
    place_resolver as default_place_resolver,
)


CompareTargetKind = Literal["country", "place", "ticker", "fx_pair", "unknown"]
CompareResolutionLevel = Literal["exact", "alias", "fallback", "none"]
CompareMode = Literal["vs", "compare", "between", "compared_to"]


@dataclass(frozen=True, slots=True)
class CompareTargetSpec:
    """One leg of a compare query.

    The ``raw`` field preserves the user's literal substring so the UI can
    show "we read this as <canonical> based on <raw>".
    """

    raw: str
    kind: CompareTargetKind
    canonical_id: str | None
    label: str
    country_code: str | None
    confidence: float
    resolution: CompareResolutionLevel


@dataclass(frozen=True, slots=True)
class ComparePlan:
    """Compare intent for the current query.

    * ``requested`` — true when a compare connector was detected
    * ``targets``   — resolved legs, in the order they appeared in the query
    * ``raw_phrase``— literal connector match, e.g. " vs ", " compared to "
    * ``mode``      — connector class
    * ``primary_text`` — the residual text after stripping the connector,
      so the upstream place resolver still has a clean primary subject when
      the compare resolves to fewer than 2 valid targets
    """

    requested: bool
    targets: list[CompareTargetSpec] = field(default_factory=list)
    raw_phrase: str | None = None
    mode: CompareMode | None = None
    primary_text: str | None = None

    @property
    def has_two_resolved(self) -> bool:
        return sum(1 for t in self.targets if t.resolution != "none") >= 2

    @property
    def is_collapsed(self) -> bool:
        """True when compare was requested but at most one leg resolved."""

        return self.requested and not self.has_two_resolved


# ----------------------------------------------------------------------------
# Public API
# ----------------------------------------------------------------------------


def plan_compare(
    query: str,
    *,
    place_resolver: PlaceResolver | None = None,
) -> ComparePlan:
    """Detect compare intent and resolve legs."""

    text = (query or "").strip()
    if not text:
        return ComparePlan(requested=False)

    detected = _detect_compare(text)
    if detected is None:
        return ComparePlan(requested=False)

    legs, residual = detected
    resolver = place_resolver or default_place_resolver
    targets = [_resolve_leg(leg, resolver) for leg in legs if leg.strip()]
    return ComparePlan(
        requested=True,
        targets=targets,
        raw_phrase=residual.connector,
        mode=residual.mode,
        primary_text=residual.primary_text,
    )


# ----------------------------------------------------------------------------
# Detection
# ----------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class _CompareSplit:
    legs: list[str]
    connector: str
    mode: CompareMode
    primary_text: str


_VS_RE = re.compile(r"\s+(?:vs\.?|v\.|versus|against)\s+", re.IGNORECASE)
_COMPARED_TO_RE = re.compile(r"\s+compared\s+(?:to|with)\s+", re.IGNORECASE)
_COMPARE_PREFIX_RE = re.compile(r"\bcompare\b", re.IGNORECASE)
_BETWEEN_PREFIX_RE = re.compile(r"\bbetween\b", re.IGNORECASE)
_AND_RE = re.compile(r"\s+(?:and|&)\s+", re.IGNORECASE)


def _detect_compare(text: str) -> tuple[list[str], _CompareSplit] | None:
    # 1) "X vs Y" / "X versus Y" / "X against Y"
    match = _VS_RE.search(text)
    if match:
        legs = [text[: match.start()], text[match.end() :]]
        split = _CompareSplit(
            legs=legs,
            connector=match.group(0).strip(),
            mode="vs",
            primary_text=legs[0].strip(),
        )
        return legs, split

    # 2) "X compared to Y" / "X compared with Y"
    match = _COMPARED_TO_RE.search(text)
    if match:
        legs = [text[: match.start()], text[match.end() :]]
        split = _CompareSplit(
            legs=legs,
            connector=match.group(0).strip(),
            mode="compared_to",
            primary_text=legs[0].strip(),
        )
        return legs, split

    # 3) "compare X and Y" — anchored on the word "compare"
    if _COMPARE_PREFIX_RE.search(text):
        residual = _COMPARE_PREFIX_RE.split(text, maxsplit=1)[-1].strip()
        legs = _split_on_and(residual)
        if legs and len(legs) >= 2:
            split = _CompareSplit(
                legs=legs[:3],
                connector="compare … and",
                mode="compare",
                primary_text=legs[0],
            )
            return legs[:3], split

    # 4) "between X and Y"
    if _BETWEEN_PREFIX_RE.search(text):
        residual = _BETWEEN_PREFIX_RE.split(text, maxsplit=1)[-1].strip()
        legs = _split_on_and(residual)
        if legs and len(legs) >= 2:
            split = _CompareSplit(
                legs=legs[:3],
                connector="between … and",
                mode="between",
                primary_text=legs[0],
            )
            return legs[:3], split

    return None


def _split_on_and(text: str) -> list[str]:
    """Split a residual phrase on ``and`` / ``&``.

    Naive but bounded: only the *first* "and" splits the phrase so we do
    not over-split queries like "compare oil and gas exposure for Japan
    and Korea". The orchestrator sees both legs of the *outermost* split.
    """

    parts = _AND_RE.split(text, maxsplit=1)
    return [p.strip() for p in parts if p.strip()]


# ----------------------------------------------------------------------------
# Leg resolution
# ----------------------------------------------------------------------------


_TICKER_RE = re.compile(r"\b([A-Z]{2,5})\b")
_FX_PAIR_RE = re.compile(r"\b(USD|EUR|JPY|GBP|CNY|CHF|CAD)(USD|EUR|JPY|GBP|CNY|CHF|CAD)\b")

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


def _resolve_leg(raw: str, resolver: PlaceResolver) -> CompareTargetSpec:
    cleaned = raw.strip(" ?.,!:;\"'")
    if not cleaned:
        return CompareTargetSpec(
            raw=raw,
            kind="unknown",
            canonical_id=None,
            label=raw.strip() or "(unknown)",
            country_code=None,
            confidence=0.0,
            resolution="none",
        )

    # 1) FX pair (highest priority — would otherwise match ticker regex)
    fx_match = _FX_PAIR_RE.search(cleaned.upper())
    if fx_match:
        pair = fx_match.group(0)
        return CompareTargetSpec(
            raw=raw,
            kind="fx_pair",
            canonical_id=f"fx:{pair}",
            label=f"{fx_match.group(1)}/{fx_match.group(2)}",
            country_code=None,
            confidence=0.95,
            resolution="exact",
        )

    # 2) Ticker — only when the leg is essentially the ticker symbol alone
    upper = cleaned.upper()
    ticker_match = _TICKER_RE.fullmatch(upper)
    if ticker_match and ticker_match.group(1) in _KNOWN_TICKERS:
        symbol = ticker_match.group(1)
        name, country = _KNOWN_TICKERS[symbol]
        return CompareTargetSpec(
            raw=raw,
            kind="ticker",
            canonical_id=f"ticker:{symbol}",
            label=name,
            country_code=country,
            confidence=0.95,
            resolution="exact",
        )
    # ...or it appears alongside a country/place name (e.g. "AAPL")
    if not ticker_match:
        for token in re.findall(r"\b[A-Z]{2,5}\b", cleaned):
            if token in _KNOWN_TICKERS and len(cleaned.split()) <= 2:
                name, country = _KNOWN_TICKERS[token]
                return CompareTargetSpec(
                    raw=raw,
                    kind="ticker",
                    canonical_id=f"ticker:{token}",
                    label=name,
                    country_code=country,
                    confidence=0.85,
                    resolution="exact",
                )

    # 3) Place resolver (cities, ports, chokepoints, regions, countries)
    resolved = resolver.resolve(cleaned)
    if resolved.fallback_level != "none" and resolved.place is not None:
        kind: CompareTargetKind = (
            "country" if resolved.place.type == "country" else "place"
        )
        resolution: CompareResolutionLevel
        if resolved.fallback_level in ("exact", "alias_substring", "nearby_city"):
            resolution = "exact" if resolved.fallback_level == "exact" else "alias"
        else:
            resolution = "fallback"
        return CompareTargetSpec(
            raw=raw,
            kind=kind,
            canonical_id=resolved.place.id,
            label=resolved.place.name,
            country_code=resolved.country_code,
            confidence=resolved.confidence,
            resolution=resolution,
        )

    # 4) Last-ditch country fallback via alpha-3
    upper_token = upper.strip()
    if len(upper_token) == 3:
        meta = lookup_by_alpha3(upper_token)
        if meta is not None:
            return CompareTargetSpec(
                raw=raw,
                kind="country",
                canonical_id=f"country:{meta.code}",
                label=meta.name,
                country_code=meta.code,
                confidence=0.6,
                resolution="alias",
            )

    # 5) Country name lookup against the legacy table
    meta = lookup_by_name(cleaned)
    if meta is not None:
        return CompareTargetSpec(
            raw=raw,
            kind="country",
            canonical_id=f"country:{meta.code}",
            label=meta.name,
            country_code=meta.code,
            confidence=0.55,
            resolution="alias",
        )

    return CompareTargetSpec(
        raw=raw,
        kind="unknown",
        canonical_id=None,
        label=cleaned,
        country_code=None,
        confidence=0.0,
        resolution="none",
    )


__all__ = [
    "CompareMode",
    "ComparePlan",
    "CompareResolutionLevel",
    "CompareTargetKind",
    "CompareTargetSpec",
    "plan_compare",
]
