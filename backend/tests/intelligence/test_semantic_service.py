"""Phase 13B.3 — SemanticPressureService + route integration tests."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
import pytest_asyncio
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.intelligence.portfolio import (
    HoldingInput,
    InMemoryPortfolioRepository,
    PortfolioBriefService,
    PortfolioCreateRequest,
    PortfolioService,
    SemanticPressureService,
)
from app.intelligence.repositories.event_repository import InMemoryEventRepository
from app.intelligence.routes import intelligence_router, portfolios_router
from app.intelligence.runtime import IntelligenceRuntime
from app.intelligence.schemas import (
    Place,
    SignalEvent,
    SourceRef,
)


NOW = datetime(2026, 4, 23, 12, 0, tzinfo=timezone.utc)


# -----------------------------------------------------------------------------
# fixtures
# -----------------------------------------------------------------------------


def _evt(
    *,
    event_id: str,
    title: str,
    country_code: str,
    country_name: str,
    type_: str = "news",
    severity: str = "elevated",
    severity_score: float = 0.7,
    confidence: float = 0.7,
    reliability: float = 0.7,
    age_hours: float = 1.0,
    tags: list[str] | None = None,
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
        confidence=confidence,
        place=Place(country_code=country_code, country_name=country_name),
        source_timestamp=ts,
        ingested_at=ts,
        sources=[
            SourceRef(
                adapter="news.test",
                provider="test",
                publisher="unit-test",
                retrieved_at=ts,
                source_timestamp=ts,
                reliability=reliability,
            )
        ],
        tags=list(tags or []),
    )


async def _seed_events(repo: InMemoryEventRepository) -> list[str]:
    events = [
        _evt(
            event_id="evt-us-tech",
            title="US tech supply chain disruption",
            country_code="USA",
            country_name="United States",
            severity_score=0.75,
            tags=["technology"],
        ),
        _evt(
            event_id="evt-us-weather",
            title="Severe storm warning in the northeast US",
            country_code="USA",
            country_name="United States",
            severity_score=0.6,
            type_="weather",
        ),
        _evt(
            event_id="evt-jp-quake",
            title="Earthquake off eastern Japan coast",
            country_code="JPN",
            country_name="Japan",
            severity_score=0.7,
            type_="news",
        ),
    ]
    await repo.upsert_many(events)
    return [e.id for e in events]


# -----------------------------------------------------------------------------
# service tests
# -----------------------------------------------------------------------------


class TestSemanticPressureService:
    @pytest.mark.asyncio
    async def test_empty_portfolio_returns_calm_rollup(self) -> None:
        events_repo = InMemoryEventRepository()
        await _seed_events(events_repo)
        portfolio_repo = InMemoryPortfolioRepository()
        pservice = PortfolioService(
            repository=portfolio_repo,
            events_repository=events_repo,
        )
        record = await pservice.create_portfolio(
            PortfolioCreateRequest(name="Empty", holdings=[])
        )

        semantic = SemanticPressureService(
            repository=portfolio_repo, events=events_repo
        )
        snapshots, rollup = await semantic.build_for_portfolio(record.id)
        assert snapshots == []
        assert rollup.semantic_score == 0.0
        assert rollup.event_pressure_level == "calm"
        assert rollup.contributing_event_count == 0

    @pytest.mark.asyncio
    async def test_seeded_events_produce_nonzero_score_for_matched_country(
        self,
    ) -> None:
        events_repo = InMemoryEventRepository()
        await _seed_events(events_repo)
        portfolio_repo = InMemoryPortfolioRepository()
        pservice = PortfolioService(
            repository=portfolio_repo,
            events_repository=events_repo,
        )
        record = await pservice.create_portfolio(
            PortfolioCreateRequest(
                name="Single USA",
                holdings=[HoldingInput(symbol="AAPL", quantity=10)],
            )
        )

        semantic = SemanticPressureService(
            repository=portfolio_repo, events=events_repo
        )
        snapshots, rollup = await semantic.build_for_portfolio(
            record.id, as_of=NOW
        )
        assert len(snapshots) == 1
        snap = snapshots[0]
        assert snap.symbol == "AAPL"
        assert snap.semantic_score > 0
        # AAPL is enriched as USA so both USA events should match.
        usa_events = {"evt-us-tech", "evt-us-weather"}
        assert usa_events.issubset(set(snap.linked_event_ids))
        # Drivers cite real evidence ids
        for driver in snap.semantic_drivers:
            for eid in driver.evidence_ids:
                assert eid in snap.linked_event_ids

    @pytest.mark.asyncio
    async def test_rollup_weighted_average_matches_hand_computed(self) -> None:
        events_repo = InMemoryEventRepository()
        await _seed_events(events_repo)
        portfolio_repo = InMemoryPortfolioRepository()
        pservice = PortfolioService(
            repository=portfolio_repo,
            events_repository=events_repo,
        )
        record = await pservice.create_portfolio(
            PortfolioCreateRequest(
                name="US + JP",
                holdings=[
                    HoldingInput(symbol="AAPL", quantity=10, average_cost=100),
                    HoldingInput(symbol="7203.T", quantity=10, average_cost=100),
                ],
            )
        )

        semantic = SemanticPressureService(
            repository=portfolio_repo, events=events_repo
        )
        snapshots, rollup = await semantic.build_for_portfolio(
            record.id, as_of=NOW
        )
        assert len(snapshots) == 2
        # With equal cost basis (10 × 100 each), weights collapse to 0.5/0.5
        # so the rollup should equal the mean of the two per-holding scores.
        expected_mean = sum(s.semantic_score for s in snapshots) / 2.0
        assert rollup.semantic_score == pytest.approx(
            round(expected_mean, 4), abs=1e-3
        )

    @pytest.mark.asyncio
    async def test_events_after_as_of_are_excluded(self) -> None:
        events_repo = InMemoryEventRepository()
        # Past event (1h old) and future event (1h in the future).
        past = _evt(
            event_id="evt-past",
            title="Past storm in USA",
            country_code="USA",
            country_name="United States",
            severity_score=0.8,
            age_hours=1.0,
        )
        future = _evt(
            event_id="evt-future",
            title="Future storm in USA",
            country_code="USA",
            country_name="United States",
            severity_score=0.8,
            age_hours=-1.0,
        )
        await events_repo.upsert_many([past, future])
        portfolio_repo = InMemoryPortfolioRepository()
        pservice = PortfolioService(
            repository=portfolio_repo, events_repository=events_repo
        )
        record = await pservice.create_portfolio(
            PortfolioCreateRequest(
                name="AsOf",
                holdings=[HoldingInput(symbol="AAPL", quantity=1)],
            )
        )

        semantic = SemanticPressureService(
            repository=portfolio_repo, events=events_repo
        )
        snapshots, _rollup = await semantic.build_for_portfolio(
            record.id, as_of=NOW
        )
        assert len(snapshots) == 1
        snap = snapshots[0]
        assert "evt-past" in snap.linked_event_ids
        assert "evt-future" not in snap.linked_event_ids

    @pytest.mark.asyncio
    async def test_top_drivers_cite_real_event_ids(self) -> None:
        events_repo = InMemoryEventRepository()
        seeded_ids = await _seed_events(events_repo)
        portfolio_repo = InMemoryPortfolioRepository()
        pservice = PortfolioService(
            repository=portfolio_repo, events_repository=events_repo
        )
        record = await pservice.create_portfolio(
            PortfolioCreateRequest(
                name="Mixed",
                holdings=[
                    HoldingInput(symbol="AAPL", quantity=5),
                    HoldingInput(symbol="7203.T", quantity=5),
                ],
            )
        )
        semantic = SemanticPressureService(
            repository=portfolio_repo, events=events_repo
        )
        _snapshots, rollup = await semantic.build_for_portfolio(
            record.id, as_of=NOW
        )
        assert rollup.top_drivers, "expected at least one rollup driver"
        seeded_set = set(seeded_ids)
        for driver in rollup.top_drivers:
            assert driver.evidence_ids
            for eid in driver.evidence_ids:
                assert eid in seeded_set, (
                    f"rollup driver cited unknown id {eid}"
                )


# -----------------------------------------------------------------------------
# route integration tests
# -----------------------------------------------------------------------------


def _build_runtime_with_semantic(
    events_repo: InMemoryEventRepository,
) -> IntelligenceRuntime:
    portfolio_repo = InMemoryPortfolioRepository()
    semantic_service = SemanticPressureService(
        repository=portfolio_repo, events=events_repo
    )
    brief = PortfolioBriefService(repository=events_repo)
    portfolio_service = PortfolioService(
        repository=portfolio_repo,
        events_repository=events_repo,
        brief_service=brief,
        semantic_service=semantic_service,
    )
    base = IntelligenceRuntime.build_default(
        adapters=(), repository=events_repo
    )
    base.portfolio_repository = portfolio_repo
    base.portfolio_service = portfolio_service
    base.semantic_service = semantic_service
    return base


@pytest_asyncio.fixture
async def app_with_semantic() -> FastAPI:
    events_repo = InMemoryEventRepository()
    await _seed_events(events_repo)
    runtime = _build_runtime_with_semantic(events_repo)
    instance = FastAPI()
    instance.state.intelligence = runtime
    instance.include_router(intelligence_router)
    instance.include_router(portfolios_router)
    return instance


@pytest.fixture
def client_with_semantic(app_with_semantic: FastAPI) -> TestClient:
    return TestClient(app_with_semantic)


class TestRouteIntegration:
    def test_portfolio_semantic_route_returns_200(
        self, client_with_semantic: TestClient
    ) -> None:
        create = client_with_semantic.post(
            "/api/intelligence/portfolios",
            json={
                "name": "SemRoute",
                "holdings": [
                    {"symbol": "AAPL", "quantity": 2},
                    {"symbol": "7203.T", "quantity": 1},
                ],
            },
        )
        assert create.status_code == 201, create.text
        portfolio_id = create.json()["id"]

        resp = client_with_semantic.get(
            f"/api/intelligence/portfolios/{portfolio_id}/semantic"
        )
        assert resp.status_code == 200, resp.text
        payload = resp.json()
        assert payload["portfolio_id"] == portfolio_id
        assert "generated_at" in payload
        assert "rollup" in payload
        assert "snapshots" in payload
        assert payload["rollup"]["event_pressure_level"] in {
            "calm",
            "watch",
            "elevated",
            "critical",
        }
        assert isinstance(payload["snapshots"], list)
        assert len(payload["snapshots"]) == 2

    def test_portfolio_semantic_route_404_for_missing_portfolio(
        self, client_with_semantic: TestClient
    ) -> None:
        resp = client_with_semantic.get(
            "/api/intelligence/portfolios/does_not_exist/semantic"
        )
        assert resp.status_code == 404
