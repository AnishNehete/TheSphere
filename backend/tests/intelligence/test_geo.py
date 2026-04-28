"""Regression tests for the geographic intelligence foundation.

Covers:
* gazetteer integrity (unique IDs, parent chain sanity)
* macro profile linkage to country places
* :class:`PlaceResolver` across the seven canonical wedge queries
* hierarchical fallback levels (exact / nearby_city / parent_country / parent_region)
* place-driven dependency templates stay scoped to the resolved country
  (regression — no cross-country leakage)
"""

from __future__ import annotations

from datetime import datetime, timezone

import pytest

from app.intelligence.geo.gazetteer import gazetteer, list_places
from app.intelligence.geo.macro_profiles import macro_profile_for
from app.intelligence.geo.place_templates import build_place_templates
from app.intelligence.geo.resolver import PlaceResolver, ResolvedPlace
from app.intelligence.repositories.event_repository import InMemoryEventRepository
from app.intelligence.schemas import Place as EventPlace
from app.intelligence.schemas import SignalEvent, SourceRef
from app.intelligence.services import DependencyService


NOW = datetime(2026, 4, 22, 12, 0, 0, tzinfo=timezone.utc)


# -----------------------------------------------------------------------------
# gazetteer sanity
# -----------------------------------------------------------------------------


class TestGazetteerIntegrity:
    def test_every_id_is_unique(self) -> None:
        ids = [p.id for p in list_places()]
        assert len(ids) == len(set(ids))

    def test_parent_ids_resolve(self) -> None:
        for place in list_places():
            if place.parent_id is None:
                continue
            assert gazetteer.by_id(place.parent_id) is not None, (
                f"{place.id} references missing parent {place.parent_id}"
            )

    def test_countries_have_macro_profiles(self) -> None:
        missing: list[str] = []
        for place in list_places():
            if place.type != "country":
                continue
            if macro_profile_for(place.country_code) is None:
                missing.append(place.id)
        assert not missing, f"Country places without macro profile: {missing}"

    def test_every_city_has_a_country_ancestor(self) -> None:
        for place in list_places():
            if place.type != "city":
                continue
            ancestors = gazetteer.ancestors_of(place)
            assert any(a.type == "country" for a in ancestors), (
                f"city {place.id} has no country ancestor"
            )


# -----------------------------------------------------------------------------
# resolver — the seven wedge queries
# -----------------------------------------------------------------------------


@pytest.fixture(scope="module")
def resolver() -> PlaceResolver:
    return PlaceResolver()


class TestPlaceResolverWedgeQueries:
    def test_tokyo_resolves_exact_city(self, resolver: PlaceResolver) -> None:
        resolved = resolver.resolve("Tokyo")
        assert resolved.place is not None
        assert resolved.place.id == "city:tokyo"
        assert resolved.place.type == "city"
        assert resolved.country_code == "JPN"
        assert resolved.fallback_level == "exact"
        assert resolved.confidence >= 0.9
        assert resolved.macro_profile is not None
        assert resolved.macro_profile.currency_code == "JPY"

    def test_osaka_resolves_exact_city(self, resolver: PlaceResolver) -> None:
        resolved = resolver.resolve("Osaka")
        assert resolved.place is not None
        assert resolved.place.id == "city:osaka"
        assert resolved.country_code == "JPN"
        assert resolved.fallback_level == "exact"

    def test_singapore_resolves_country(self, resolver: PlaceResolver) -> None:
        resolved = resolver.resolve("Singapore")
        assert resolved.place is not None
        # "Singapore" is both a city id alias and a country name — the
        # resolver should prefer the city (more specific) but we still
        # want the country linkage intact.
        assert resolved.country_code == "SGP"
        assert resolved.fallback_level == "exact"
        assert resolved.macro_profile is not None
        assert resolved.macro_profile.currency_code == "SGD"
        assert resolved.macro_profile.logistics_hub is True

    def test_red_sea_resolves_as_region(self, resolver: PlaceResolver) -> None:
        resolved = resolver.resolve("Red Sea")
        assert resolved.place is not None
        assert resolved.place.id == "region:red-sea"
        assert resolved.place.type == "region"
        # Multi-country region — no country_code expected.
        assert resolved.country is None or resolved.country.type == "region"

    def test_suez_resolves_chokepoint(self, resolver: PlaceResolver) -> None:
        resolved = resolver.resolve("Suez")
        assert resolved.place is not None
        assert resolved.place.type == "chokepoint"
        assert "suez" in resolved.place.id.lower()
        assert resolved.country_code == "EGY"
        assert resolved.macro_profile is not None
        assert resolved.macro_profile.currency_code == "EGP"

    def test_hong_kong_resolves(self, resolver: PlaceResolver) -> None:
        resolved = resolver.resolve("Hong Kong")
        assert resolved.place is not None
        assert resolved.country_code == "HKG"
        assert resolved.macro_profile is not None
        assert resolved.macro_profile.currency_code == "HKD"

    def test_new_york_resolves_city(self, resolver: PlaceResolver) -> None:
        resolved = resolver.resolve("New York")
        assert resolved.place is not None
        assert resolved.place.id == "city:new-york"
        assert resolved.country_code == "USA"
        assert resolved.fallback_level == "exact"
        assert resolved.macro_profile is not None
        assert resolved.macro_profile.currency_code == "USD"


# -----------------------------------------------------------------------------
# fallback policy
# -----------------------------------------------------------------------------


class TestFallbackPolicy:
    def test_alias_substring_triggers_nearby_city(self, resolver: PlaceResolver) -> None:
        resolved = resolver.resolve("Flights over Tokyo right now")
        assert resolved.place is not None
        assert resolved.place.id == "city:tokyo"
        assert resolved.fallback_level == "nearby_city"
        # Still carries the country linkage.
        assert resolved.country_code == "JPN"

    def test_region_only_query_falls_back_to_parent_region(
        self, resolver: PlaceResolver
    ) -> None:
        resolved = resolver.resolve("tensions in the middle east")
        assert resolved.place is not None
        assert resolved.place.type == "region"
        assert resolved.fallback_level in ("alias_substring", "parent_region")

    def test_unknown_place_returns_none(self, resolver: PlaceResolver) -> None:
        resolved = resolver.resolve("Atlantis underwater city")
        assert resolved.place is None
        assert resolved.fallback_level == "none"
        assert resolved.confidence == 0.0

    def test_iso_code_fallback_routes_to_country(self, resolver: PlaceResolver) -> None:
        # JPN alone shouldn't collide with a city.
        resolved = resolver.resolve("JPN")
        assert resolved.country_code == "JPN"

    def test_alias_boundary_guard_prevents_word_inside_word(
        self, resolver: PlaceResolver
    ) -> None:
        # "us" is a USA alias; it must NOT match "australia" or "austria".
        resolved = resolver.resolve("austria monetary policy")
        # We don't have Austria in the gazetteer, so the fallback should
        # route to the parent country via lookup_by_name (which does have
        # Austria via a legacy substring rule). If no Austria match is
        # possible we just need to assert that we didn't wrongly return USA.
        if resolved.country_code == "USA":
            pytest.fail(
                "'us' leaked from inside 'austria' — word-boundary guard broken"
            )


# -----------------------------------------------------------------------------
# place-driven templates — no cross-country leakage
# -----------------------------------------------------------------------------


class TestPlaceTemplates:
    def test_tokyo_templates_cover_four_axes(self, resolver: PlaceResolver) -> None:
        resolved = resolver.resolve("Tokyo")
        templates = build_place_templates(resolved)
        titles = [t.title for t in templates]
        # should include currency, commodity, logistics, sector axes
        assert any("JPY" in t for t in titles)
        assert any("equities" in t.lower() or "cluster" in t.lower() for t in titles)
        assert any(
            "logistics" in t.lower()
            or "supply" in t.lower()
            or "port" in t.lower()
            for t in titles
        )
        # No template should reference an unrelated country's currency.
        forbidden_currencies = {"USD", "EUR", "GBP", "SGD", "HKD", "KRW"}
        for template in templates:
            for node in template.nodes:
                for currency in forbidden_currencies:
                    assert currency not in node.label, (
                        f"Template for Tokyo leaked {currency}: {node.label}"
                    )

    def test_singapore_templates_mark_logistics_hub(
        self, resolver: PlaceResolver
    ) -> None:
        resolved = resolver.resolve("Singapore")
        templates = build_place_templates(resolved)
        assert templates, "expected at least one template for Singapore"
        # Singapore must surface a logistics template (hub + chokepoint-adjacent).
        assert any("logistics" in t.title.lower() for t in templates)

    def test_red_sea_has_no_place_templates(self, resolver: PlaceResolver) -> None:
        resolved = resolver.resolve("Red Sea")
        templates = build_place_templates(resolved)
        # Red Sea is a multi-country region with no single country anchor —
        # place-driven templates should abstain rather than fabricate one.
        assert templates == []

    def test_suez_templates_stay_inside_egy(self, resolver: PlaceResolver) -> None:
        resolved = resolver.resolve("Suez")
        templates = build_place_templates(resolved)
        assert templates, "Suez chokepoint should produce at least one template"
        scoped_countries = {
            node.country_code
            for template in templates
            for node in template.nodes
            if node.country_code
        }
        # Anything country-scoped must be EGY. Global nodes may omit
        # country_code entirely (None).
        assert scoped_countries.issubset({"EGY"}), (
            f"Suez templates leaked into {scoped_countries - {'EGY'}}"
        )

    def test_new_york_templates_stay_inside_usa(
        self, resolver: PlaceResolver
    ) -> None:
        resolved = resolver.resolve("New York")
        templates = build_place_templates(resolved)
        scoped_countries = {
            node.country_code
            for template in templates
            for node in template.nodes
            if node.country_code
        }
        assert scoped_countries.issubset({"USA"}), (
            f"NY templates leaked into {scoped_countries - {'USA'}}"
        )


# -----------------------------------------------------------------------------
# dependency service integration
# -----------------------------------------------------------------------------


def _event_with_country(event_id: str, country_code: str) -> SignalEvent:
    return SignalEvent(
        id=event_id,
        dedupe_key=event_id,
        type="news",  # type: ignore[arg-type]
        sub_type=None,
        title=f"Test signal {event_id}",
        summary="",
        severity="elevated",
        severity_score=0.7,
        confidence=0.6,
        place=EventPlace(country_code=country_code, country_name=country_code),
        source_timestamp=NOW,
        ingested_at=NOW,
        sources=[
            SourceRef(
                adapter="test",
                provider="test",
                retrieved_at=NOW,
                source_timestamp=NOW,
                reliability=0.7,
            )
        ],
        tags=[],
        properties={},
    )


async def test_dependency_for_place_includes_evidence_when_country_has_events() -> None:
    repo = InMemoryEventRepository()
    await repo.upsert_many(
        [
            _event_with_country("jpn-1", "JPN"),
            # Foreign noise — must not surface on a Tokyo query.
            _event_with_country("gbr-1", "GBR"),
        ]
    )
    service = DependencyService(repository=repo)

    response = await service.for_place("Tokyo")
    assert response.focal_country_code == "JPN"
    assert response.paths, "expected place-driven paths for Tokyo"
    # First edge of the first template should cite JPN evidence, not GBR.
    first_path = response.paths[0]
    assert first_path.edges
    for edge in first_path.edges:
        for evid in edge.evidence_ids:
            assert evid.startswith("jpn-"), (
                f"edge leaked foreign evidence: {evid}"
            )


async def test_dependency_for_red_sea_returns_empty_paths_safely() -> None:
    repo = InMemoryEventRepository()
    service = DependencyService(repository=repo)
    response = await service.for_place("Red Sea")
    # No country anchor, no macro profile — we must not crash and must not
    # fabricate country-scoped paths.
    assert response.paths == []
    assert response.focal_country_code is None


async def test_dependency_for_unknown_query_returns_empty_paths() -> None:
    repo = InMemoryEventRepository()
    service = DependencyService(repository=repo)
    response = await service.for_place("Atlantis")
    assert response.paths == []
    assert response.focal_country_code is None


async def test_for_country_includes_place_templates_layer() -> None:
    repo = InMemoryEventRepository()
    await repo.upsert_many([_event_with_country("sgp-1", "SGP")])
    service = DependencyService(repository=repo)
    response = await service.for_country("SGP")
    # At least one place-driven path should appear alongside the event-driven
    # template; look for the deterministic "place-" id prefix.
    assert any(p.id.startswith("place-") for p in response.paths)
