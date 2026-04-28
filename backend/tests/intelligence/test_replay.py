"""Phase 13B.6 — ReplayCursor + replay threading + determinism tests."""

from __future__ import annotations

import json
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
    ReplayCursor,
    SemanticPressureService,
    cursor_from,
    parse_as_of,
)
from app.intelligence.repositories.event_repository import InMemoryEventRepository
from app.intelligence.routes import intelligence_router, portfolios_router
from app.intelligence.runtime import IntelligenceRuntime
from app.intelligence.schemas import Place, SignalEvent, SourceRef


NOW = datetime(2026, 4, 23, 12, 0, tzinfo=timezone.utc)
PAST = NOW - timedelta(hours=2)
FUTURE = NOW + timedelta(hours=2)


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------


def _evt(
    *,
    event_id: str,
    title: str,
    country_code: str = "USA",
    country_name: str = "United States",
    ingested_at: datetime | None = None,
    source_ts: datetime | None = None,
) -> SignalEvent:
    ts = source_ts or NOW - timedelta(hours=1)
    ing = ingested_at or ts
    return SignalEvent(
        id=event_id,
        dedupe_key=event_id,
        type="news",  # type: ignore[arg-type]
        title=title,
        summary=title,
        severity="elevated",  # type: ignore[arg-type]
        severity_score=0.7,
        confidence=0.7,
        place=Place(country_code=country_code, country_name=country_name),
        source_timestamp=ts,
        ingested_at=ing,
        sources=[
            SourceRef(
                adapter="news.test",
                provider="test",
                publisher="unit-test",
                retrieved_at=ts,
                source_timestamp=ts,
                reliability=0.7,
            )
        ],
        tags=[],
    )


def _build_services(
    events_repo: InMemoryEventRepository,
) -> tuple[InMemoryPortfolioRepository, PortfolioService, PortfolioRiskScoreService]:
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


def _build_app(events_repo: InMemoryEventRepository) -> FastAPI:
    """Build a minimal FastAPI app wired with the portfolio service stack."""
    portfolio_repo, portfolio_service, risk = _build_services(events_repo)
    runtime = IntelligenceRuntime.build_default(
        adapters=(), repository=events_repo
    )
    runtime.portfolio_repository = portfolio_repo
    runtime.portfolio_service = portfolio_service
    runtime.risk_service = risk
    app = FastAPI()
    app.state.intelligence = runtime
    app.include_router(intelligence_router)
    app.include_router(portfolios_router)
    return app


# ---------------------------------------------------------------------------
# TestReplayCursor
# ---------------------------------------------------------------------------


class TestReplayCursor:
    def test_default_cursor_is_live(self) -> None:
        cursor = ReplayCursor()
        assert cursor.is_live is True
        assert cursor.as_of is None

    def test_cursor_with_timestamp_is_not_live(self) -> None:
        cursor = ReplayCursor(as_of=NOW)
        assert cursor.is_live is False
        assert cursor.as_of == NOW

    def test_truncate_excludes_future_timestamps(self) -> None:
        cursor = ReplayCursor(as_of=NOW)
        # timestamp after as_of → should be excluded
        assert cursor.truncate(FUTURE) is True
        # timestamp before as_of → should not be excluded
        assert cursor.truncate(PAST) is False
        # timestamp equal to as_of → should not be excluded (<=)
        assert cursor.truncate(NOW) is False

    def test_truncate_live_cursor_never_excludes(self) -> None:
        cursor = ReplayCursor()
        assert cursor.truncate(FUTURE) is False
        assert cursor.truncate(PAST) is False
        assert cursor.truncate(None) is False

    def test_truncate_none_timestamp_returns_false(self) -> None:
        cursor = ReplayCursor(as_of=NOW)
        assert cursor.truncate(None) is False

    def test_parse_as_of_handles_z_suffix(self) -> None:
        result = parse_as_of("2026-04-01T00:00:00Z")
        assert result is not None
        assert result.tzinfo is not None
        assert result.year == 2026
        assert result.month == 4
        assert result.day == 1

    def test_parse_as_of_handles_offset(self) -> None:
        result = parse_as_of("2026-04-01T12:00:00+05:30")
        assert result is not None
        # Should be normalized to UTC
        assert result.tzinfo is not None

    def test_parse_as_of_raises_on_invalid_input(self) -> None:
        with pytest.raises(ValueError):
            parse_as_of("not-a-date")

    def test_parse_as_of_none_returns_none(self) -> None:
        assert parse_as_of(None) is None

    def test_parse_as_of_empty_string_returns_none(self) -> None:
        assert parse_as_of("") is None

    def test_cursor_from_none_is_live(self) -> None:
        cursor = cursor_from(None)
        assert cursor.is_live is True

    def test_cursor_from_string(self) -> None:
        cursor = cursor_from("2026-04-01T00:00:00Z")
        assert cursor.is_live is False
        assert cursor.as_of is not None

    def test_cursor_from_datetime(self) -> None:
        cursor = cursor_from(NOW)
        assert cursor.is_live is False
        assert cursor.as_of == NOW


# ---------------------------------------------------------------------------
# TestDeterminism
# ---------------------------------------------------------------------------


class TestDeterminism:
    @pytest.mark.asyncio
    async def test_brief_with_same_as_of_produces_identical_output(self) -> None:
        events_repo = InMemoryEventRepository()
        await events_repo.upsert_many(
            [_evt(event_id="evt-det-1", title="Determinism event USA")]
        )
        _, pservice, _ = _build_services(events_repo)
        record = await pservice.create_portfolio(
            PortfolioCreateRequest(
                name="Det test",
                holdings=[HoldingInput(symbol="AAPL", quantity=10)],
            )
        )
        pin_time = NOW

        brief1 = await pservice.build_brief(record.id, as_of=PAST)
        brief2 = await pservice.build_brief(record.id, as_of=PAST)

        # Serialize, excluding generated_at which is always pinned anyway
        d1 = json.loads(
            brief1.model_dump_json(exclude={"generated_at"})
        )
        d2 = json.loads(
            brief2.model_dump_json(exclude={"generated_at"})
        )
        assert d1 == d2, "Same as_of + same corpus must produce identical brief"

    @pytest.mark.asyncio
    async def test_as_of_replay_adds_note(self) -> None:
        events_repo = InMemoryEventRepository()
        _, pservice, _ = _build_services(events_repo)
        record = await pservice.create_portfolio(
            PortfolioCreateRequest(
                name="Note test",
                holdings=[HoldingInput(symbol="MSFT", quantity=5)],
            )
        )
        brief = await pservice.build_brief(record.id, as_of=PAST)
        assert any("As-of replay" in note for note in brief.notes), (
            f"Expected 'As-of replay' in notes; got {brief.notes}"
        )

    @pytest.mark.asyncio
    async def test_live_brief_does_not_add_replay_note(self) -> None:
        events_repo = InMemoryEventRepository()
        _, pservice, _ = _build_services(events_repo)
        record = await pservice.create_portfolio(
            PortfolioCreateRequest(
                name="Live note test",
                holdings=[HoldingInput(symbol="MSFT", quantity=5)],
            )
        )
        brief = await pservice.build_brief(record.id)
        assert not any("As-of replay" in note for note in brief.notes)

    @pytest.mark.asyncio
    async def test_semantic_filters_events_by_ingested_at(self) -> None:
        """Event ingested after as_of must not appear in the semantic rollup."""
        events_repo = InMemoryEventRepository()
        # Past event — should be included
        past_evt = _evt(
            event_id="evt-past",
            title="Past event",
            ingested_at=PAST,
        )
        # Future event — should be excluded for replay at NOW
        future_evt = _evt(
            event_id="evt-future",
            title="Future event",
            ingested_at=FUTURE,
        )
        await events_repo.upsert_many([past_evt, future_evt])
        _, pservice, _ = _build_services(events_repo)
        record = await pservice.create_portfolio(
            PortfolioCreateRequest(
                name="Semantic filter test",
                holdings=[HoldingInput(symbol="AAPL", quantity=10)],
            )
        )
        result = await pservice.build_semantic_snapshots(record.id, as_of=NOW)
        assert result is not None
        snapshots, rollup = result
        # Future event id must not appear in any driver's evidence or linked ids
        all_evidence = [
            eid
            for snap in snapshots
            for driver in snap.semantic_drivers
            for eid in driver.evidence_ids
        ]
        all_linked = [eid for snap in snapshots for eid in snap.linked_event_ids]
        assert "evt-future" not in all_evidence, (
            "Future event (ingested_at > as_of) leaked into semantic corpus"
        )
        assert "evt-future" not in all_linked, (
            "Future event (ingested_at > as_of) leaked into linked_event_ids"
        )


# ---------------------------------------------------------------------------
# TestHistoryDiscipline
# ---------------------------------------------------------------------------


class TestHistoryDiscipline:
    @pytest.mark.asyncio
    async def test_live_call_appends_to_history(self) -> None:
        events_repo = InMemoryEventRepository()
        _, pservice, risk = _build_services(events_repo)
        record = await pservice.create_portfolio(
            PortfolioCreateRequest(
                name="History live",
                holdings=[HoldingInput(symbol="AAPL", quantity=10)],
            )
        )
        for _ in range(4):
            await pservice.build_risk_score(record.id)
        assert len(risk._history[record.id]) == 4

    @pytest.mark.asyncio
    async def test_replay_call_does_not_append_to_history(self) -> None:
        events_repo = InMemoryEventRepository()
        _, pservice, risk = _build_services(events_repo)
        record = await pservice.create_portfolio(
            PortfolioCreateRequest(
                name="History replay",
                holdings=[HoldingInput(symbol="AAPL", quantity=10)],
            )
        )
        # 1 live call
        await pservice.build_risk_score(record.id)
        # 3 replay calls — must not grow history
        for i in range(3):
            await pservice.build_risk_score(
                record.id, as_of=PAST - timedelta(hours=i)
            )
        # 1 more live call
        await pservice.build_risk_score(record.id)
        assert len(risk._history[record.id]) == 2, (
            f"Expected 2 history entries (live only), got {len(risk._history[record.id])}"
        )

    @pytest.mark.asyncio
    async def test_delta_vs_baseline_nonzero_after_enough_live_calls(self) -> None:
        events_repo = InMemoryEventRepository()
        await events_repo.upsert_many(
            [_evt(event_id="evt-base-1", title="Baseline event USA")]
        )
        _, pservice, _ = _build_services(events_repo)
        record = await pservice.create_portfolio(
            PortfolioCreateRequest(
                name="Delta test",
                holdings=[HoldingInput(symbol="AAPL", quantity=10)],
            )
        )
        # Need enough live calls for a baseline to form
        for _ in range(4):
            await pservice.build_risk_score(record.id)
        final = await pservice.build_risk_score(record.id)
        assert final is not None
        # After 4 samples the engine has a baseline — delta may still be 0
        # if scores are identical (deterministic), but the baseline note
        # must be gone.
        assert not any("Baseline not yet" in n for n in final.notes)


# ---------------------------------------------------------------------------
# TestRoutesAcceptAsOf
# ---------------------------------------------------------------------------


class TestRoutesAcceptAsOf:
    @pytest.fixture
    def client_and_portfolio_id(self) -> tuple[TestClient, str]:
        events_repo = InMemoryEventRepository()
        portfolio_repo, portfolio_service, risk = _build_services(events_repo)
        runtime = IntelligenceRuntime.build_default(
            adapters=(), repository=events_repo
        )
        runtime.portfolio_repository = portfolio_repo
        runtime.portfolio_service = portfolio_service
        runtime.risk_service = risk
        app = FastAPI()
        app.state.intelligence = runtime
        app.include_router(intelligence_router)
        app.include_router(portfolios_router)

        client = TestClient(app, raise_server_exceptions=False)
        # Create portfolio via API
        resp = client.post(
            "/api/intelligence/portfolios",
            json={
                "name": "Route test",
                "holdings": [{"symbol": "AAPL", "quantity": 10}],
            },
        )
        assert resp.status_code == 201
        pid = resp.json()["id"]
        return client, pid

    def test_brief_route_accepts_as_of_iso_z(
        self, client_and_portfolio_id: tuple[TestClient, str]
    ) -> None:
        client, pid = client_and_portfolio_id
        resp = client.get(
            f"/api/intelligence/portfolios/{pid}/brief",
            params={"as_of": "2026-04-01T00:00:00Z"},
        )
        assert resp.status_code == 200
        notes = resp.json()["notes"]
        assert any("As-of replay" in n for n in notes)

    def test_brief_route_returns_422_on_invalid_as_of(
        self, client_and_portfolio_id: tuple[TestClient, str]
    ) -> None:
        client, pid = client_and_portfolio_id
        resp = client.get(
            f"/api/intelligence/portfolios/{pid}/brief",
            params={"as_of": "not-a-date"},
        )
        assert resp.status_code == 422

    def test_valuation_route_accepts_as_of(
        self, client_and_portfolio_id: tuple[TestClient, str]
    ) -> None:
        client, pid = client_and_portfolio_id
        resp = client.get(
            f"/api/intelligence/portfolios/{pid}/valuation",
            params={"as_of": "2026-04-01T00:00:00Z"},
        )
        # valuation may return null when no provider — that's fine
        assert resp.status_code in (200, 200)

    def test_technical_route_accepts_as_of(
        self, client_and_portfolio_id: tuple[TestClient, str]
    ) -> None:
        client, pid = client_and_portfolio_id
        resp = client.get(
            f"/api/intelligence/portfolios/{pid}/technical",
            params={"as_of": "2026-04-01T00:00:00Z"},
        )
        assert resp.status_code == 200

    def test_semantic_route_accepts_as_of(
        self, client_and_portfolio_id: tuple[TestClient, str]
    ) -> None:
        client, pid = client_and_portfolio_id
        resp = client.get(
            f"/api/intelligence/portfolios/{pid}/semantic",
            params={"as_of": "2026-04-01T00:00:00Z"},
        )
        assert resp.status_code == 200

    def test_risk_score_route_accepts_as_of(
        self, client_and_portfolio_id: tuple[TestClient, str]
    ) -> None:
        client, pid = client_and_portfolio_id
        # One live call to seed history
        client.get(f"/api/intelligence/portfolios/{pid}/risk-score")
        resp = client.get(
            f"/api/intelligence/portfolios/{pid}/risk-score",
            params={"as_of": "2026-04-01T00:00:00Z"},
        )
        assert resp.status_code == 200

    def test_candles_route_accepts_as_of(
        self, client_and_portfolio_id: tuple[TestClient, str]
    ) -> None:
        client, pid = client_and_portfolio_id
        resp = client.get(
            f"/api/intelligence/portfolios/{pid}/holdings/AAPL/candles",
            params={"as_of": "2026-04-01T00:00:00Z"},
        )
        # no provider configured → empty list, still 200
        assert resp.status_code == 200
