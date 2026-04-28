"""Phase 12.3 — end-to-end regression tests for the place-aware agent path.

These tests pin the trust-repair contract: place queries must route through
the new ``PlaceResolver`` -> ``PlaceScope`` flow, scoped evidence must beat
unrelated noise, and fallback notices must fire honestly when the resolver
climbs the hierarchy.

Each test sets up a minimal repository with one or two events that *should*
match plus several decoys (unrelated countries, unrelated topics) to verify
the place-aware ranking actually suppresses leakage.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from app.intelligence.repositories.event_repository import InMemoryEventRepository
from app.intelligence.schemas import (
    Place,
    SignalEvent,
    SourceRef,
)
from app.intelligence.services import AgentQueryService, SearchService


NOW = datetime(2026, 4, 22, 12, 0, 0, tzinfo=timezone.utc)


def _evt(
    *,
    event_id: str,
    title: str,
    type_: str = "news",
    severity: str = "elevated",
    severity_score: float = 0.6,
    country_code: str | None = None,
    country_name: str | None = None,
    latitude: float | None = None,
    longitude: float | None = None,
    locality: str | None = None,
    region: str | None = None,
    age_hours: float = 1.0,
) -> SignalEvent:
    ts = NOW - timedelta(hours=age_hours)
    return SignalEvent(
        id=event_id,
        dedupe_key=event_id,
        type=type_,  # type: ignore[arg-type]
        title=title,
        summary=title,
        severity=severity,  # type: ignore[arg-type]
        severity_score=severity_score,
        confidence=0.7,
        place=Place(
            country_code=country_code,
            country_name=country_name,
            latitude=latitude,
            longitude=longitude,
            locality=locality,
            region=region,
        ),
        source_timestamp=ts,
        ingested_at=ts,
        sources=[
            SourceRef(
                adapter="news.test",
                provider="test",
                publisher="test-publisher",
                url=f"https://test.example/{event_id}",
                retrieved_at=ts,
                source_timestamp=ts,
                reliability=0.7,
            )
        ],
        tags=[type_],
    )


# -----------------------------------------------------------------------------
# Decoys: events from unrelated countries / topics. The trust-repair contract
# requires that none of these surface as top evidence for a place query.
# -----------------------------------------------------------------------------


def _decoy_pool() -> list[SignalEvent]:
    return [
        _evt(
            event_id="decoy-arg-mood",
            title="Country mood index: Argentina",
            type_="mood",
            severity="watch",
            severity_score=0.3,
            country_code="ARG",
            country_name="Argentina",
            latitude=-38.4,
            longitude=-63.6,
        ),
        _evt(
            event_id="decoy-mar-tariff",
            title="Drought tariff dispute escalates between Morocco and EU",
            type_="news",
            severity="watch",
            severity_score=0.45,
            country_code="MAR",
            country_name="Morocco",
            latitude=31.79,
            longitude=-7.09,
        ),
        _evt(
            event_id="decoy-ukr-airspace",
            title="Airspace closure near eastern Ukraine prompts airline reroutes",
            type_="conflict",
            severity="elevated",
            severity_score=0.7,
            country_code="UKR",
            country_name="Ukraine",
            latitude=48.4,
            longitude=31.2,
        ),
        _evt(
            event_id="decoy-aus-news",
            title="Sydney film festival opens to record crowds",
            type_="news",
            severity="info",
            severity_score=0.2,
            country_code="AUS",
            country_name="Australia",
            latitude=-33.86,
            longitude=151.21,
        ),
    ]


@pytest.fixture
async def agent_service() -> AgentQueryService:
    repo = InMemoryEventRepository()
    return await _seed(repo)


async def _seed(repo: InMemoryEventRepository) -> AgentQueryService:
    pool = _decoy_pool() + [
        # Tokyo / Japan
        _evt(
            event_id="jp-storm",
            title="Severe storm warning issued across southern Japan",
            type_="weather",
            severity="elevated",
            severity_score=0.78,
            country_code="JPN",
            country_name="Japan",
            latitude=34.6,
            longitude=135.5,
            locality="Osaka",
        ),
        # Singapore
        _evt(
            event_id="sgp-port",
            title="Port operations disrupted in Singapore after container backlog",
            type_="news",
            severity="watch",
            severity_score=0.55,
            country_code="SGP",
            country_name="Singapore",
            latitude=1.29,
            longitude=103.85,
            locality="Singapore",
        ),
        # Egypt / Suez
        _evt(
            event_id="egy-shipping",
            title="Red Sea shipping delays continue as carriers reroute",
            type_="news",
            severity="elevated",
            severity_score=0.7,
            country_code="EGY",
            country_name="Egypt",
            latitude=30.58,
            longitude=32.26,
            locality="Suez",
            region="middle east",
        ),
        # Saudi Arabia event near the Red Sea (region-fallback proof)
        _evt(
            event_id="sau-port",
            title="Jeddah port congestion eases after weekend backlog",
            type_="news",
            severity="watch",
            severity_score=0.45,
            country_code="SAU",
            country_name="Saudi Arabia",
            latitude=21.5,
            longitude=39.2,
            locality="Jeddah",
        ),
    ]
    await repo.upsert_many(pool)
    return AgentQueryService(search=SearchService(repo), repository=repo)


# ---- Tokyo --------------------------------------------------------------


async def test_tokyo_routes_through_place_resolver(agent_service) -> None:
    response = await agent_service.ask("What happened in Tokyo")

    # Place was resolved at the place-resolver level, not as a country.
    assert response.resolved_place is not None
    assert response.resolved_place.place_id == "city:tokyo"
    assert response.resolved_place.type == "city"
    assert response.resolved_place.country_code == "JPN"
    # The full sentence "What happened in Tokyo" hits the alias-substring /
    # nearby-city ladder rung, not the exact rung — both are strong scopes.
    assert response.resolved_place.fallback_level in ("exact", "alias_substring", "nearby_city")
    assert response.scope_used == "exact_place"


async def test_tokyo_suppresses_unrelated_country_evidence(agent_service) -> None:
    response = await agent_service.ask("What happened in Tokyo")
    countries = {ref.country_code for ref in response.evidence}

    # Trust-repair contract: Argentina / Morocco / Ukraine must not appear
    # as evidence on a Tokyo query just because they have noisy entries.
    assert "ARG" not in countries
    assert "MAR" not in countries
    assert "UKR" not in countries
    assert "AUS" not in countries

    # The Japan event is allowed to be the top evidence (or no scoped event
    # if our seeded pool has none in JPN — but we did seed jp-storm).
    if response.evidence:
        assert all(
            (ref.country_code or "") == "JPN" for ref in response.evidence
        )


async def test_tokyo_falls_back_with_honest_notice_when_no_jpn_events() -> None:
    repo = InMemoryEventRepository()
    # Seed only decoys — no JPN events at all. Resolver should still resolve
    # Tokyo, scope should still be exact_place, but fallback notice must
    # explicitly say there are no Tokyo-specific signals.
    await repo.upsert_many(_decoy_pool())
    agent = AgentQueryService(search=SearchService(repo), repository=repo)
    response = await agent.ask("What happened in Tokyo")

    assert response.resolved_place is not None
    assert response.resolved_place.country_code == "JPN"
    assert response.fallback_notice is not None
    assert "tokyo" in response.fallback_notice.lower()
    # Still no leakage of unrelated country mood entries.
    countries = {ref.country_code for ref in response.evidence}
    assert "ARG" not in countries
    assert "MAR" not in countries


async def test_tokyo_macro_context_surfaces_for_strong_resolution(
    agent_service,
) -> None:
    response = await agent_service.ask("What happened in Tokyo")
    assert response.macro_context is not None
    assert response.macro_context.country_code == "JPN"
    assert response.macro_context.currency_code == "JPY"


async def test_tokyo_emits_place_dependencies(agent_service) -> None:
    response = await agent_service.ask("What happened in Tokyo")
    assert len(response.place_dependencies) > 0
    titles = " ".join(p.title.lower() for p in response.place_dependencies)
    assert "japan" in titles


# ---- Singapore ----------------------------------------------------------


async def test_singapore_resolves_and_scopes_correctly(agent_service) -> None:
    response = await agent_service.ask("What changed in Singapore")
    assert response.resolved_place is not None
    assert response.resolved_place.country_code == "SGP"
    assert response.scope_used == "exact_place"
    # Macro lights up SGD.
    assert response.macro_context is not None
    assert response.macro_context.currency_code == "SGD"
    # No Argentinian mood leakage on a Singapore query.
    assert all(
        (ref.country_code or "") != "ARG" for ref in response.evidence
    )


# ---- Red Sea ------------------------------------------------------------


async def test_red_sea_resolves_as_region_with_fallback_notice(
    agent_service,
) -> None:
    response = await agent_service.ask("What happened in red sea")
    assert response.resolved_place is not None
    assert response.resolved_place.place_id == "region:red-sea"
    assert response.resolved_place.type == "region"
    assert response.scope_used == "region"
    # Region resolution → no macro enrichment (no single anchor country).
    assert response.macro_context is None
    # Region fallback notice required.
    assert response.fallback_notice is not None
    # Region scope still suppresses non-member countries.
    countries = {ref.country_code for ref in response.evidence if ref.country_code}
    for forbidden in ("ARG", "MAR", "UKR", "AUS"):
        assert forbidden not in countries


# ---- Suez --------------------------------------------------------------


async def test_suez_resolves_chokepoint_with_egypt_macro(agent_service) -> None:
    response = await agent_service.ask("What is happening in Suez")
    assert response.resolved_place is not None
    assert response.resolved_place.type == "chokepoint"
    assert response.resolved_place.country_code == "EGY"
    # Strong place hit — macro should surface (EGY currency).
    assert response.macro_context is not None
    assert response.macro_context.country_code == "EGY"
    # No Argentinian / Australian leakage on a Suez query.
    countries = {ref.country_code for ref in response.evidence if ref.country_code}
    assert "ARG" not in countries
    assert "AUS" not in countries


# ---- generic place-routing invariants -----------------------------------


async def test_unknown_place_query_returns_global_scope_no_resolved_place() -> None:
    repo = InMemoryEventRepository()
    await repo.upsert_many(_decoy_pool())
    agent = AgentQueryService(search=SearchService(repo), repository=repo)
    response = await agent.ask("zzz unknown place xyz")
    assert response.resolved_place is None
    assert response.scope_used == "global"
    # No bogus fallback notice for an unresolved query.
    assert response.fallback_notice is None
