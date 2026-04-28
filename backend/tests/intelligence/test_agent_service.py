"""Tests for the rule-based agent query service (Phase 12A)."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from app.intelligence.repositories.event_repository import InMemoryEventRepository
from app.intelligence.schemas import (
    CountrySignalSummary,
    Place,
    SignalEvent,
    SourceRef,
)
from app.intelligence.services import AgentQueryService, SearchService


NOW = datetime(2026, 4, 22, 12, 0, 0, tzinfo=timezone.utc)


def _event(
    *,
    event_id: str,
    title: str,
    type_: str = "news",
    severity: str = "elevated",
    severity_score: float = 0.7,
    country_code: str = "MAR",
    country_name: str = "Morocco",
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
        place=Place(country_code=country_code, country_name=country_name, region="africa"),
        source_timestamp=ts,
        ingested_at=ts,
        sources=[
            SourceRef(
                adapter="news.gdelt",
                provider="gdelt",
                publisher="test-publisher",
                url="https://news.example/" + event_id,
                retrieved_at=ts,
                source_timestamp=ts,
                reliability=0.7,
            )
        ],
        tags=[type_],
    )


@pytest.fixture
async def seeded_agent() -> AgentQueryService:
    repo = InMemoryEventRepository()
    events = [
        _event(event_id="mr-1", title="Drought tariff dispute escalates in Morocco"),
        _event(
            event_id="mr-2",
            title="Severe storm warning issued across northern Morocco",
            type_="weather",
            severity="critical",
            severity_score=0.85,
            age_hours=0.5,
        ),
        _event(
            event_id="jp-1",
            title="Typhoon warning over southern Japan",
            type_="weather",
            severity="elevated",
            severity_score=0.75,
            country_code="JPN",
            country_name="Japan",
            age_hours=2.0,
        ),
    ]
    await repo.upsert_many(events)
    summary = CountrySignalSummary(
        country_code="MAR",
        country_name="Morocco",
        updated_at=NOW,
        watch_score=0.68,
        watch_delta=0.14,
        watch_label="elevated",
        counts_by_category={"news": 1, "weather": 1},
        top_signals=events[:2],
        headline_signal_id="mr-2",
        confidence=0.74,
        sources=[],
        summary="Elevated watch driven by storms and tariff news.",
    )
    await repo.upsert_country_summary(summary)

    search = SearchService(repo)
    return AgentQueryService(search=search, repository=repo)


async def test_agent_detects_why_elevated_and_cites_summary(seeded_agent) -> None:
    response = await seeded_agent.ask("Why is Morocco elevated?")

    assert response.intent == "why_elevated"
    assert response.reasoning_mode == "rule_based"
    assert any(e.kind == "country" and e.country_code == "MAR" for e in response.resolved_entities)
    # watch-score sentence must cite concrete evidence
    assert response.answer
    first = response.answer[0]
    assert first.evidence_ids, "first segment must be grounded"
    # evidence refs exposed to UI are ≤ evidence_limit
    assert 1 <= len(response.evidence) <= 6
    # follow-ups include what-changed + downstream pivots
    labels = [f.label.lower() for f in response.follow_ups]
    assert any("changed" in label for label in labels)
    assert any("affect" in label or "compare" in label for label in labels)


async def test_agent_what_changed_prefers_recent_events(seeded_agent) -> None:
    response = await seeded_agent.ask("What changed in Morocco in the last 24 hours?")
    assert response.intent == "what_changed"
    # at least one segment should cite a fresh (<24h) event
    cited_ids = {eid for segment in response.answer for eid in segment.evidence_ids}
    assert cited_ids, "what-changed answer must cite at least one event"


async def test_agent_downstream_emits_ranked_paths(seeded_agent) -> None:
    response = await seeded_agent.ask("How could Morocco affect European imports?")
    assert response.intent == "downstream_impact"
    text_joined = " ".join(seg.text for seg in response.answer).lower()
    # template emits one of these transmission hints
    assert any(
        marker in text_joined
        for marker in ("supply", "flights", "tourism", "shipping", "oil", "equities")
    )


async def test_agent_returns_confidence_between_zero_and_one(seeded_agent) -> None:
    response = await seeded_agent.ask("Morocco")
    assert 0.0 <= response.confidence <= 1.0


async def test_agent_handles_unknown_query_without_crashing() -> None:
    repo = InMemoryEventRepository()
    agent = AgentQueryService(search=SearchService(repo), repository=repo)
    response = await agent.ask("random unknown thing zzz")
    assert response.intent in {
        "general_retrieval",
        "why_elevated",
        "what_changed",
        "driving_factor",
        "downstream_impact",
        "status_check",
    }
    # no evidence, but we still render a graceful segment
    assert response.answer
    assert response.answer[0].text
