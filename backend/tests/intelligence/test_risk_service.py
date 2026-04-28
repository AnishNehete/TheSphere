"""Phase 13B.4 — PortfolioRiskScoreService + route integration tests."""

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
    PortfolioRiskScoreService,
    PortfolioService,
    SemanticPressureService,
)
from app.intelligence.repositories.event_repository import InMemoryEventRepository
from app.intelligence.routes import intelligence_router, portfolios_router
from app.intelligence.runtime import IntelligenceRuntime
from app.intelligence.schemas import Place, SignalEvent, SourceRef


NOW = datetime(2026, 4, 23, 12, 0, tzinfo=timezone.utc)


# ---------------------------------------------------------------------------
# fixtures
# ---------------------------------------------------------------------------


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


async def _seed_usa_events(repo: InMemoryEventRepository) -> list[str]:
    events = [
        _evt(
            event_id="evt-us-1",
            title="US tech supply chain disruption",
            country_code="USA",
            country_name="United States",
            severity_score=0.8,
            age_hours=1.0,
        ),
        _evt(
            event_id="evt-us-2",
            title="Severe storm in US northeast",
            country_code="USA",
            country_name="United States",
            severity_score=0.7,
            age_hours=2.0,
        ),
    ]
    await repo.upsert_many(events)
    return [e.id for e in events]


def _build_services(
    events_repo: InMemoryEventRepository,
) -> tuple[
    InMemoryPortfolioRepository, PortfolioService, PortfolioRiskScoreService
]:
    portfolio_repo = InMemoryPortfolioRepository()
    brief = PortfolioBriefService(repository=events_repo)
    semantic = SemanticPressureService(
        repository=portfolio_repo, events=events_repo
    )
    risk = PortfolioRiskScoreService(
        repository=portfolio_repo,
        brief_service=brief,
        semantic_service=semantic,
    )
    portfolio_service = PortfolioService(
        repository=portfolio_repo,
        events_repository=events_repo,
        brief_service=brief,
        semantic_service=semantic,
        risk_service=risk,
    )
    return portfolio_repo, portfolio_service, risk


# ---------------------------------------------------------------------------
# service tests
# ---------------------------------------------------------------------------


class TestPortfolioRiskScoreService:
    @pytest.mark.asyncio
    async def test_empty_portfolio_returns_zero_score_with_notes(self) -> None:
        events_repo = InMemoryEventRepository()
        _repo, pservice, _risk = _build_services(events_repo)
        record = await pservice.create_portfolio(
            PortfolioCreateRequest(name="Empty", holdings=[])
        )
        score = await pservice.build_risk_score(record.id)
        assert score is not None
        assert score.risk_score == 0.0
        assert any(
            "nothing is driving risk" in n.lower() for n in score.notes
        )
        # Confidence must always be in [0, 1].
        assert 0.0 <= score.confidence <= 1.0
        # Tilt fields: no technical/semantic inputs => insufficient alignment
        # (Plan 06: signal_alignment is always set by populate_tilt_for_risk).
        assert score.bullish_tilt_score is None
        assert score.bearish_tilt_score is None
        assert score.signal_alignment == "insufficient"

    @pytest.mark.asyncio
    async def test_portfolio_with_concentration_and_events_produces_nonzero_score(
        self,
    ) -> None:
        events_repo = InMemoryEventRepository()
        await _seed_usa_events(events_repo)
        _repo, pservice, _risk = _build_services(events_repo)
        record = await pservice.create_portfolio(
            PortfolioCreateRequest(
                name="Single USA",
                holdings=[HoldingInput(symbol="AAPL", quantity=10)],
            )
        )
        score = await pservice.build_risk_score(record.id, as_of=NOW)
        assert score is not None
        assert score.risk_score > 0
        driver_components = {d.component for d in score.drivers}
        # Single-holding portfolio MUST surface concentration; the two
        # seeded matched events MUST surface event_severity.
        assert "concentration" in driver_components
        assert "event_severity" in driver_components
        # Drivers carry evidence ids for event_severity.
        event_drivers = [d for d in score.drivers if d.component == "event_severity"]
        assert event_drivers
        assert set(event_drivers[0].evidence_ids) & {"evt-us-1", "evt-us-2"}

    @pytest.mark.asyncio
    async def test_history_populates_baseline_for_live_calls(self) -> None:
        events_repo = InMemoryEventRepository()
        await _seed_usa_events(events_repo)
        _repo, pservice, risk = _build_services(events_repo)
        record = await pservice.create_portfolio(
            PortfolioCreateRequest(
                name="Baseline",
                holdings=[HoldingInput(symbol="AAPL", quantity=10)],
            )
        )
        # 4 live calls (as_of=None) — by the 4th, history has 3 samples and
        # the baseline note MUST be gone.
        for _ in range(4):
            await pservice.build_risk_score(record.id)
        final = await pservice.build_risk_score(record.id)
        assert final is not None
        assert not any("Baseline not yet" in n for n in final.notes), (
            f"expected baseline note to be cleared; notes = {final.notes}"
        )

    @pytest.mark.asyncio
    async def test_as_of_does_not_contaminate_history(self) -> None:
        events_repo = InMemoryEventRepository()
        await _seed_usa_events(events_repo)
        portfolio_repo, pservice, risk = _build_services(events_repo)
        record = await pservice.create_portfolio(
            PortfolioCreateRequest(
                name="Replay",
                holdings=[HoldingInput(symbol="AAPL", quantity=10)],
            )
        )
        await pservice.build_risk_score(record.id)  # live → appends history
        await pservice.build_risk_score(
            record.id, as_of=NOW - timedelta(hours=1)
        )  # replay → does NOT append
        await pservice.build_risk_score(record.id)  # live → appends

        history = list(risk._history[record.id])  # type: ignore[attr-defined]
        assert len(history) == 2, (
            f"replay must not contaminate history; got {history}"
        )

    @pytest.mark.asyncio
    async def test_freshness_seconds_tracks_linked_event_age(self) -> None:
        events_repo = InMemoryEventRepository()
        # Event 10 minutes old.
        event = _evt(
            event_id="evt-fresh",
            title="Fresh storm",
            country_code="USA",
            country_name="United States",
            age_hours=10.0 / 60.0,
        )
        await events_repo.upsert_many([event])
        _repo, pservice, _risk = _build_services(events_repo)
        record = await pservice.create_portfolio(
            PortfolioCreateRequest(
                name="Fresh",
                holdings=[HoldingInput(symbol="AAPL", quantity=10)],
            )
        )
        score = await pservice.build_risk_score(record.id, as_of=NOW)
        assert score is not None
        # 600s ± tolerance — brief composition can reshape linked_events but
        # the stalest is always ≥ 600s when we pin as_of.
        assert 540 <= score.freshness_seconds <= 660, score.freshness_seconds

    @pytest.mark.asyncio
    async def test_confidence_hint_in_zero_one_range(self) -> None:
        events_repo = InMemoryEventRepository()
        await _seed_usa_events(events_repo)
        _repo, pservice, _risk = _build_services(events_repo)
        record = await pservice.create_portfolio(
            PortfolioCreateRequest(
                name="Confidence",
                holdings=[HoldingInput(symbol="AAPL", quantity=10)],
            )
        )
        score = await pservice.build_risk_score(record.id, as_of=NOW)
        assert score is not None
        assert 0.0 <= score.confidence <= 1.0


# ---------------------------------------------------------------------------
# route integration tests
# ---------------------------------------------------------------------------


def _build_runtime_with_risk(
    events_repo: InMemoryEventRepository,
) -> IntelligenceRuntime:
    portfolio_repo, portfolio_service, risk = _build_services(events_repo)
    base = IntelligenceRuntime.build_default(adapters=(), repository=events_repo)
    base.portfolio_repository = portfolio_repo
    base.portfolio_service = portfolio_service
    base.risk_service = risk
    return base


@pytest_asyncio.fixture
async def app_with_risk() -> FastAPI:
    events_repo = InMemoryEventRepository()
    await _seed_usa_events(events_repo)
    runtime = _build_runtime_with_risk(events_repo)
    instance = FastAPI()
    instance.state.intelligence = runtime
    instance.include_router(intelligence_router)
    instance.include_router(portfolios_router)
    return instance


@pytest.fixture
def client_with_risk(app_with_risk: FastAPI) -> TestClient:
    return TestClient(app_with_risk)


class TestRouteIntegration:
    def test_risk_score_route_returns_200_with_all_fields(
        self, client_with_risk: TestClient
    ) -> None:
        create = client_with_risk.post(
            "/api/intelligence/portfolios",
            json={
                "name": "RouteRisk",
                "holdings": [{"symbol": "AAPL", "quantity": 2}],
            },
        )
        assert create.status_code == 201, create.text
        portfolio_id = create.json()["id"]

        resp = client_with_risk.get(
            f"/api/intelligence/portfolios/{portfolio_id}/risk-score"
        )
        assert resp.status_code == 200, resp.text
        payload = resp.json()
        # Every emission MUST carry all of these — no naked number.
        required_keys = {
            "portfolio_id",
            "risk_score",
            "delta_vs_baseline",
            "drivers",
            "confidence",
            "score_components",
            "as_of",
            "freshness_seconds",
            "notes",
        }
        assert required_keys.issubset(set(payload.keys())), (
            f"missing keys: {required_keys - set(payload.keys())}"
        )
        # score_components carries every documented component.
        components = payload["score_components"]
        assert set(components.keys()) == {
            "concentration",
            "fx",
            "commodity",
            "chokepoint",
            "event_severity",
            "semantic_density",
        }
        # Tilt reservation fields present on the schema.
        for k in (
            "bullish_tilt_score",
            "bearish_tilt_score",
            "uncertainty_score",
            "signal_alignment",
        ):
            assert k in payload
        assert 0.0 <= payload["risk_score"] <= 100.0
        assert 0.0 <= payload["confidence"] <= 1.0

    def test_risk_score_route_404_for_missing_portfolio(
        self, client_with_risk: TestClient
    ) -> None:
        resp = client_with_risk.get(
            "/api/intelligence/portfolios/does_not_exist/risk-score"
        )
        assert resp.status_code == 404
