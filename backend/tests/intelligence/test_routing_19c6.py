"""Phase 19C.6 — query routing regression tests.

Locks in the bugs found in the launch screenshot review:

* "why is TSLA down" must NOT route to a country fallback (was Israel).
* "why is oil up"   must NOT route to a country fallback (was Israel).
* "trend in USD"    must NOT route to a country fallback (was India).
* English stopwords ("is", "in", "at") must not name-match a country.
* lookup_by_name(short_token) must not substring-match a country alias.
"""
from __future__ import annotations

import pytest

from app.intelligence.adapters.country_lookup import lookup_by_name
from app.intelligence.retrieval.entity_resolver import (
    default_place_resolver,
    resolve_query_entity,
)


class TestNameLookupGate:
    @pytest.mark.parametrize(
        "token",
        ["is", "in", "at", "to", "of", "by", "vs", "or", "and", "the", "why"],
    )
    def test_short_english_tokens_do_not_substring_match(self, token: str) -> None:
        # Pre-19C.6: lookup_by_name("is") returned Israel, lookup_by_name("in")
        # returned India, etc. New gate requires len >= 4 for substring match,
        # which kills all of the above.
        assert lookup_by_name(token) is None

    def test_exact_country_name_still_resolves(self) -> None:
        meta = lookup_by_name("Israel")
        assert meta is not None
        assert meta.code == "ISR"

    def test_alias_substring_still_resolves_for_real_aliases(self) -> None:
        # 4+ char tokens still substring-match the canonical/alias table —
        # for example "Korea" should hit South Korea via the canonical name.
        meta = lookup_by_name("Korea")
        assert meta is not None


class TestPlaceResolverNoStopwordCollision:
    @pytest.mark.parametrize(
        "query",
        [
            "why is TSLA down",
            "why is oil up",
            "trend in USD",
            "what is going on",
            "is it true",
        ],
    )
    def test_market_query_does_not_resolve_to_country(self, query: str) -> None:
        resolved = default_place_resolver.resolve(query)
        # No more "TSLA → Israel" or "in → India" leaks.
        assert resolved.fallback_level == "none", (
            f"{query!r} should not produce a place fallback; "
            f"got {resolved.fallback_level} → {resolved.country_code}"
        )

    def test_real_country_query_still_resolves(self) -> None:
        resolved = default_place_resolver.resolve("why is Morocco elevated")
        assert resolved.country_code == "MAR"

    def test_real_alpha3_token_still_resolves(self) -> None:
        resolved = default_place_resolver.resolve("USA outlook")
        assert resolved.country_code == "USA"


class TestEntityResolverEndToEnd:
    def test_tsla_resolves_as_ticker(self) -> None:
        entity = resolve_query_entity("why is TSLA down")
        assert entity.kind == "ticker"
        assert entity.canonical_id == "ticker:TSLA"
        assert entity.label == "Tesla Inc."

    def test_oil_resolves_as_commodity(self) -> None:
        entity = resolve_query_entity("why is oil up")
        assert entity.kind == "commodity"

    def test_usd_resolves_as_fx(self) -> None:
        entity = resolve_query_entity("trend in USD")
        assert entity.kind == "fx_pair"
