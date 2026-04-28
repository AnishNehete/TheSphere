"""SearchService behavior tests."""

from __future__ import annotations

import pytest

from app.intelligence.repositories.event_repository import InMemoryEventRepository
from app.intelligence.services.search_service import SearchService


async def test_empty_query_on_empty_repo_returns_zero_total(
    empty_repo: InMemoryEventRepository,
) -> None:
    service = SearchService(empty_repo)
    response = await service.search(query="")

    assert response.query == ""
    assert response.resolved_country_code is None
    assert response.total == 0
    assert response.hits == []


async def test_keyword_query_matches_storm_event(
    seeded_repo: InMemoryEventRepository,
) -> None:
    service = SearchService(seeded_repo)
    response = await service.search(query="storm")

    assert response.total >= 1
    top_ids = [hit.event.id for hit in response.hits]
    assert "wx-usa-1" in top_ids

    top_hit = next(hit for hit in response.hits if hit.event.id == "wx-usa-1")
    assert "storm" in top_hit.matched_terms
    assert top_hit.score > 0.0


async def test_country_filter_restricts_to_target_country(
    seeded_repo: InMemoryEventRepository,
) -> None:
    service = SearchService(seeded_repo)
    response = await service.search(query="", country_code="USA")

    assert response.resolved_country_code == "USA"
    assert response.total == 2
    for hit in response.hits:
        assert hit.event.place.country_code == "USA"


async def test_country_inferred_from_free_text(
    seeded_repo: InMemoryEventRepository,
) -> None:
    service = SearchService(seeded_repo)
    response = await service.search(query="Japan")

    assert response.resolved_country_code == "JPN"
    # only JPN events should be returned by the repo query
    for hit in response.hits:
        assert hit.event.place.country_code == "JPN"


async def test_unknown_country_hint_is_not_resolved(
    seeded_repo: InMemoryEventRepository,
) -> None:
    service = SearchService(seeded_repo)
    response = await service.search(query="", country_code="ZZZ")

    # bogus hint → no resolved country; no tokens → returns recency-ranked list
    assert response.resolved_country_code is None


async def test_no_results_when_country_has_no_events(
    seeded_repo: InMemoryEventRepository,
) -> None:
    service = SearchService(seeded_repo)
    response = await service.search(query="", country_code="CAN")

    assert response.resolved_country_code == "CAN"
    assert response.total == 0
    assert response.hits == []


async def test_category_filter_narrows_results(
    seeded_repo: InMemoryEventRepository,
) -> None:
    service = SearchService(seeded_repo)
    response = await service.search(query="", categories=("weather",))

    assert response.total == 1
    assert response.hits[0].event.type == "weather"
    assert response.hits[0].event.id == "wx-usa-1"


async def test_irrelevant_keyword_yields_no_matched_terms(
    seeded_repo: InMemoryEventRepository,
) -> None:
    """The v1 retriever is deliberately simple: when tokens are present but
    none match, it still falls through to a recency-weighted ranking rather
    than returning an empty list. Contract we care about is that no event
    claims a false textual match.
    """

    service = SearchService(seeded_repo)
    response = await service.search(query="quasar supernova interstellar")

    # none of the events carry any of those terms
    for hit in response.hits:
        assert hit.matched_terms == []
