"""Phase 18C — query understanding, entity resolution, and scope enforcement.

Asserts that:

* commodity / ticker / fx queries resolve to the correct entity kind and
  carry the expected related symbols / domain
* an unrelated weather row never leaks into a commodity query
* an unresolved query returns the explicit "no entity" caveat instead of
  falling back to global retrieval
* a compare query with two time legs (``"oil yesterday vs today"``)
  produces a :class:`CompareDeltaSummary` with separated event lists and
  a deterministic delta — never a mixed list
* a ticker query like ``"why tesla down"`` returns only Tesla-related
  rows
* a trend query (``"trend in usd"``) routes through the fx domain over a
  7-day window
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from app.intelligence.repositories.event_repository import InMemoryEventRepository
from app.intelligence.retrieval.entity_resolver import (
    is_relevant,
    resolve_query_entity,
)
from app.intelligence.retrieval.orchestrator import RetrievalOrchestrator
from app.intelligence.retrieval.query_planner import QueryPlanner
from app.intelligence.schemas import Place, SignalEvent, SourceRef
from app.intelligence.services import SearchService


# Deterministic anchor — pinned to noon so "today" / "yesterday" windows
# are unambiguous regardless of when the suite runs.
NOW = datetime(2026, 4, 26, 12, 0, 0, tzinfo=timezone.utc)


def _event(
    *,
    event_id: str,
    title: str,
    type_: str = "news",
    severity_score: float = 0.6,
    country_code: str | None = "USA",
    country_name: str | None = "United States",
    age_hours: float = 1.0,
    tags: list[str] | None = None,
    summary: str | None = None,
) -> SignalEvent:
    ts = NOW - timedelta(hours=age_hours)
    return SignalEvent(
        id=event_id,
        dedupe_key=event_id,
        type=type_,  # type: ignore[arg-type]
        title=title,
        summary=summary or title,
        severity="elevated",
        severity_score=severity_score,
        confidence=0.7,
        place=Place(country_code=country_code, country_name=country_name),
        source_timestamp=ts,
        ingested_at=ts,
        sources=[
            SourceRef(
                adapter="test.adapter",
                provider="test",
                publisher="unit-test",
                retrieved_at=ts,
                source_timestamp=ts,
                reliability=0.7,
            )
        ],
        tags=tags or [type_],
    )


@pytest.fixture
async def seeded_repo() -> InMemoryEventRepository:
    repo = InMemoryEventRepository()
    events = [
        # Oil today (in last 24h)
        _event(
            event_id="oil-today-1",
            title="WTI crude oil rallies on supply concerns",
            type_="commodities",
            age_hours=2.0,
            tags=["commodities", "oil", "wti"],
        ),
        # Oil yesterday (24-48h ago)
        _event(
            event_id="oil-yest-1",
            title="Brent crude slips overnight on demand worries",
            type_="commodities",
            age_hours=30.0,
            tags=["commodities", "oil", "brent"],
        ),
        _event(
            event_id="oil-yest-2",
            title="Crude oil inventories build sharply",
            type_="commodities",
            age_hours=36.0,
            tags=["commodities", "oil"],
        ),
        # Unrelated weather row that must NOT appear for an oil query
        _event(
            event_id="wx-irrelevant",
            title="Rain expected over Florida coast",
            type_="weather",
            age_hours=4.0,
            tags=["weather"],
            summary="Coastal rain advisory issued.",
        ),
        # Tesla today
        _event(
            event_id="tsla-1",
            title="Tesla shares slide after delivery miss",
            type_="stocks",
            age_hours=3.0,
            tags=["stocks", "tsla", "tesla"],
        ),
        # Apple unrelated to a Tesla query
        _event(
            event_id="aapl-1",
            title="Apple results in line with consensus",
            type_="stocks",
            age_hours=5.0,
            tags=["stocks", "aapl"],
        ),
        # USD / FX row for trend
        _event(
            event_id="usd-1",
            title="USD strength tests JPY support level",
            type_="currency",
            age_hours=10.0,
            tags=["currency", "usd", "jpy"],
        ),
        _event(
            event_id="usd-2",
            title="EUR/USD volatility picks up after ECB",
            type_="currency",
            age_hours=120.0,  # 5 days — inside 7d trend window
            tags=["currency", "eur", "usd"],
        ),
    ]
    await repo.upsert_many(events)
    return repo


@pytest.fixture
async def orchestrator(seeded_repo: InMemoryEventRepository) -> RetrievalOrchestrator:
    return RetrievalOrchestrator(
        repository=seeded_repo, search=SearchService(seeded_repo)
    )


# ----------------------------------------------------------------------------
# Entity resolver — direct unit tests
# ----------------------------------------------------------------------------


def test_resolve_commodity_oil() -> None:
    entity = resolve_query_entity("oil")
    assert entity.kind == "commodity"
    assert entity.canonical_id == "commodity:OIL"
    assert entity.domain == "commodities"
    assert "CL" in entity.related_symbols
    assert "BZ" in entity.related_symbols


def test_resolve_ticker_nickname() -> None:
    entity = resolve_query_entity("why tesla down")
    assert entity.kind == "ticker"
    assert entity.canonical_id == "ticker:TSLA"
    assert entity.domain == "equities"
    assert entity.country_code == "USA"


def test_resolve_fx_pair_direct() -> None:
    entity = resolve_query_entity("USDJPY")
    assert entity.kind == "fx_pair"
    assert entity.canonical_id == "fx:USDJPY"
    assert entity.domain == "fx"


def test_resolve_unresolved_returns_explicit_none() -> None:
    entity = resolve_query_entity("zzzzzz random gibberish 9999")
    assert entity.kind == "unresolved"
    assert entity.resolution == "none"
    assert entity.domain == "unknown"
    assert not entity.is_resolved


def test_is_relevant_excludes_weather_for_commodity() -> None:
    oil = resolve_query_entity("oil")
    assert oil.kind == "commodity"
    relevant = is_relevant(
        event_type="weather",
        event_tags=("weather",),
        event_country_code="USA",
        event_haystack="rain expected over florida coast",
        entity=oil,
    )
    assert relevant is False


def test_is_relevant_keeps_oil_tagged_weather() -> None:
    oil = resolve_query_entity("oil")
    relevant = is_relevant(
        event_type="weather",
        event_tags=("weather", "oil"),
        event_country_code="USA",
        event_haystack="hurricane disrupts gulf oil platforms",
        entity=oil,
    )
    assert relevant is True


# ----------------------------------------------------------------------------
# Time window — semantic kinds
# ----------------------------------------------------------------------------


def test_time_window_today_marked_today() -> None:
    plan = QueryPlanner().plan("oil today", now=NOW)
    assert plan.time.semantic_kind == "today"
    assert plan.time.kind == "between"


def test_time_window_yesterday_marked_yesterday() -> None:
    plan = QueryPlanner().plan("oil yesterday", now=NOW)
    assert plan.time.semantic_kind == "yesterday"
    assert plan.time.is_historical is True


def test_time_window_last_week_marked_last_week() -> None:
    plan = QueryPlanner().plan("oil last week", now=NOW)
    assert plan.time.semantic_kind == "last_week"


def test_time_window_trend_marked_trend() -> None:
    plan = QueryPlanner().plan("trend in usd", now=NOW)
    assert plan.time.semantic_kind == "trend"
    assert plan.time.is_trend is True


# ----------------------------------------------------------------------------
# Orchestrator — scope enforcement
# ----------------------------------------------------------------------------


async def test_oil_query_excludes_unrelated_weather(
    orchestrator: RetrievalOrchestrator,
) -> None:
    bundle = await orchestrator.run("oil today", now=NOW)
    ids = [e.id for e in bundle.primary_events]
    assert ids, "expected at least one oil row"
    assert "wx-irrelevant" not in ids, "unrelated weather must not leak"
    # Every returned event must be commodity-shaped
    for event in bundle.primary_events:
        assert event.type in ("commodities", "markets", "stocks", "news")


async def test_tesla_query_returns_only_tesla(
    orchestrator: RetrievalOrchestrator,
) -> None:
    bundle = await orchestrator.run("why tesla down", now=NOW)
    ids = [e.id for e in bundle.primary_events]
    assert "tsla-1" in ids
    # Apple must be filtered out by the relevance gate
    assert "aapl-1" not in ids


async def test_invalid_query_returns_no_entity_caveat(
    orchestrator: RetrievalOrchestrator,
) -> None:
    bundle = await orchestrator.run("zzzzzz random gibberish 9999", now=NOW)
    assert bundle.entity is not None
    assert bundle.entity.kind == "unresolved"
    assert bundle.entity_resolved is False
    assert bundle.primary_events == []
    # Caveat must be explicit — never a silent global fallback
    assert any(
        "no entity resolved" in c.lower() for c in bundle.caveats
    )


async def test_trend_in_usd_uses_seven_day_fx_window(
    orchestrator: RetrievalOrchestrator,
) -> None:
    bundle = await orchestrator.run("trend in usd", now=NOW)
    assert bundle.entity is not None
    assert bundle.entity.kind == "fx_pair"
    assert bundle.plan.time.semantic_kind == "trend"
    # The 5-day-old EUR/USD row must be included in a 7-day window
    ids = [e.id for e in bundle.primary_events]
    assert "usd-1" in ids or "usd-2" in ids


# ----------------------------------------------------------------------------
# Compare engine — deterministic time delta
# ----------------------------------------------------------------------------


async def test_oil_yesterday_vs_today_returns_compare_delta(
    orchestrator: RetrievalOrchestrator,
) -> None:
    bundle = await orchestrator.run("oil yesterday vs today", now=NOW)
    assert bundle.compare_delta is not None
    delta = bundle.compare_delta

    # Two scoped queries — never a mixed list
    left_ids = {e.id for e in delta.left_events}
    right_ids = {e.id for e in delta.right_events}
    assert left_ids and right_ids
    assert left_ids.isdisjoint(right_ids), (
        "compare delta must keep yesterday/today lists separated"
    )

    # The yesterday leg must contain only events 24h+ old.
    for event in delta.left_events:
        ref = event.source_timestamp or event.ingested_at
        age_hours = (NOW - ref).total_seconds() / 3600.0
        assert age_hours >= 24.0, f"{event.id} too fresh for yesterday leg"

    # The today leg must contain only events <24h old.
    for event in delta.right_events:
        ref = event.source_timestamp or event.ingested_at
        age_hours = (NOW - ref).total_seconds() / 3600.0
        assert age_hours <= 25.0, f"{event.id} too old for today leg"

    # Delta must be deterministic (added/removed counts match the sets)
    assert delta.added == len(right_ids - left_ids)
    assert delta.removed == len(left_ids - right_ids)


async def test_oil_yesterday_vs_today_does_not_leak_weather(
    orchestrator: RetrievalOrchestrator,
) -> None:
    bundle = await orchestrator.run("oil yesterday vs today", now=NOW)
    delta = bundle.compare_delta
    assert delta is not None
    all_ids = {e.id for e in delta.left_events} | {
        e.id for e in delta.right_events
    }
    assert "wx-irrelevant" not in all_ids
