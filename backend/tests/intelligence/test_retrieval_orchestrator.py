"""Tests for the retrieval orchestrator and end-to-end agent answer.

Phase 18A.1 — verifies that:

* multi-entity compare queries no longer collapse to a single subject
* time-window phrases route through the timeline worker
* the agent response carries the new typed contracts (time_context,
  compare_summary, workers_invoked, caveats)
* existing 17A/B/C behaviour for plain queries is preserved
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from app.intelligence.repositories.event_repository import InMemoryEventRepository
from app.intelligence.retrieval.orchestrator import RetrievalOrchestrator
from app.intelligence.schemas import (
    CountrySignalSummary,
    Place,
    SignalEvent,
    SourceRef,
)
from app.intelligence.services import AgentQueryService, SearchService


NOW = datetime(2026, 4, 26, 12, 0, 0, tzinfo=timezone.utc)


def _event(
    *,
    event_id: str,
    title: str,
    type_: str = "news",
    severity: str = "elevated",
    severity_score: float = 0.7,
    country_code: str = "JPN",
    country_name: str = "Japan",
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
            region="asia",
        ),
        source_timestamp=ts,
        ingested_at=ts,
        sources=[
            SourceRef(
                adapter="news.gdelt",
                provider="gdelt",
                publisher="test-publisher",
                url=f"https://news.example/{event_id}",
                retrieved_at=ts,
                source_timestamp=ts,
                reliability=0.7,
            )
        ],
        tags=[type_],
    )


@pytest.fixture
async def seeded_repo() -> InMemoryEventRepository:
    repo = InMemoryEventRepository()
    events = [
        _event(event_id="jp-1", title="Typhoon warning over southern Japan", type_="weather", age_hours=2.0),
        _event(event_id="jp-2", title="Yen weakens against dollar", type_="currency", age_hours=4.0),
        _event(
            event_id="jp-old",
            title="Japan flood prep advisory archived",
            age_hours=240.0,  # 10 days old → outside last 24h window
        ),
        _event(
            event_id="kr-1",
            title="Korean won drops on chip exports concern",
            country_code="KOR",
            country_name="South Korea",
            age_hours=3.0,
        ),
        _event(
            event_id="kr-2",
            title="Seoul tightens shipping inspections",
            country_code="KOR",
            country_name="South Korea",
            age_hours=5.0,
        ),
    ]
    await repo.upsert_many(events)
    await repo.upsert_country_summary(
        CountrySignalSummary(
            country_code="JPN",
            country_name="Japan",
            updated_at=NOW,
            watch_score=0.62,
            watch_delta=0.08,
            watch_label="elevated",
            counts_by_category={"weather": 1, "currency": 1},
            top_signals=[events[0], events[1]],
            headline_signal_id="jp-1",
            confidence=0.7,
            sources=[],
            summary="Elevated by storm + FX move.",
        )
    )
    await repo.upsert_country_summary(
        CountrySignalSummary(
            country_code="KOR",
            country_name="South Korea",
            updated_at=NOW,
            watch_score=0.48,
            watch_delta=-0.05,
            watch_label="watch",
            counts_by_category={"news": 2},
            top_signals=[events[3], events[4]],
            headline_signal_id="kr-1",
            confidence=0.65,
            sources=[],
            summary="Watch from FX + shipping checks.",
        )
    )
    return repo


@pytest.fixture
async def orchestrator(seeded_repo: InMemoryEventRepository) -> RetrievalOrchestrator:
    return RetrievalOrchestrator(
        repository=seeded_repo, search=SearchService(seeded_repo)
    )


@pytest.fixture
async def agent(seeded_repo: InMemoryEventRepository) -> AgentQueryService:
    return AgentQueryService(
        repository=seeded_repo, search=SearchService(seeded_repo)
    )


# ---- bundle assembly --------------------------------------------------------


async def test_orchestrator_runs_place_worker_only_for_simple_query(
    orchestrator: RetrievalOrchestrator,
) -> None:
    bundle = await orchestrator.run("What is happening in Japan?")
    assert "place" in bundle.workers_invoked
    assert "compare" not in bundle.workers_invoked
    assert "timeline" not in bundle.workers_invoked
    assert bundle.has_evidence


async def test_orchestrator_runs_compare_worker_for_vs_query(
    orchestrator: RetrievalOrchestrator,
) -> None:
    bundle = await orchestrator.run("Compare Japan vs Korea")
    assert "compare" in bundle.workers_invoked
    assert bundle.has_compare
    assert not bundle.compare_collapsed
    # both legs resolve and carry events from their respective country
    snapshots = bundle.compare_snapshots
    countries = {s.scope.country_code for s in snapshots if s.is_resolved}
    assert {"JPN", "KOR"}.issubset(countries)


async def test_orchestrator_runs_timeline_worker_for_windowed_query(
    orchestrator: RetrievalOrchestrator,
) -> None:
    bundle = await orchestrator.run("Japan signals in the last 24h")
    assert "timeline" in bundle.workers_invoked
    # the 10-day-old event must not appear
    assert all(e.id != "jp-old" for e in bundle.primary_events)


async def test_orchestrator_emits_caveat_when_window_has_no_match(
    seeded_repo: InMemoryEventRepository,
) -> None:
    orch = RetrievalOrchestrator(
        repository=seeded_repo, search=SearchService(seeded_repo)
    )
    bundle = await orch.run("Japan signals in the last 30 minutes")
    # All seeded JPN events are at least 2h old, so the window misses.
    # The worker either falls back to broader corpus or emits a caveat.
    assert bundle.caveats, "expected a caveat for no-match window"


# ---- agent response wiring --------------------------------------------------


async def test_agent_response_carries_compare_summary(
    agent: AgentQueryService,
) -> None:
    response = await agent.ask("Compare Japan vs Korea")
    assert response.compare_summary is not None
    assert response.compare_summary.requested is True
    assert response.compare_summary.collapsed is False
    assert len(response.compare_summary.targets) == 2
    assert "compare" in response.workers_invoked
    # answer prose should reference both labels somewhere
    joined = " ".join(seg.text for seg in response.answer)
    assert "Japan" in joined
    assert "Korea" in joined


async def test_agent_response_carries_time_context(
    agent: AgentQueryService,
) -> None:
    response = await agent.ask("Japan in the last 7 days")
    assert response.time_context is not None
    assert response.time_context.kind == "since"
    assert response.time_context.coverage in ("windowed", "no_match")
    # answer_mode_label is always populated
    assert response.time_context.answer_mode_label


async def test_agent_response_live_when_no_time_phrase(
    agent: AgentQueryService,
) -> None:
    response = await agent.ask("Why is Japan elevated?")
    assert response.time_context is not None
    assert response.time_context.kind == "live"
    assert response.time_context.coverage == "live"
    assert response.compare_summary is None


async def test_agent_response_marks_collapsed_compare(
    agent: AgentQueryService,
) -> None:
    # zzz is unresolved — compare should be marked collapsed.
    response = await agent.ask("Compare zzz123 vs Japan")
    assert response.compare_summary is not None
    assert response.compare_summary.requested is True
    assert response.compare_summary.collapsed is True
    # caveats expose the partial resolution
    assert any("partial" in c.lower() for c in response.caveats)


async def test_agent_preserves_existing_intent_classification(
    agent: AgentQueryService,
) -> None:
    response = await agent.ask("Why is Japan elevated?")
    assert response.intent == "why_elevated"
    assert response.answer
    assert response.answer[0].evidence_ids
    assert 0.0 <= response.confidence <= 1.0


async def test_agent_compare_with_time_window_combines_both_workers(
    agent: AgentQueryService,
) -> None:
    response = await agent.ask("Compare Japan vs Korea in the last 24h")
    assert response.compare_summary is not None
    assert response.time_context is not None
    assert "compare" in response.workers_invoked
    assert "timeline" in response.workers_invoked


async def test_agent_workers_invoked_recorded_for_observability(
    agent: AgentQueryService,
) -> None:
    response = await agent.ask("Tokyo storm last 24h")
    assert "place" in response.workers_invoked
    assert "timeline" in response.workers_invoked
