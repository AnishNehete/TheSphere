"""Saved Investigations service / repository tests.

Phase 17B.1 introduced this suite against the in-memory repository.
Phase 18A.2 parametrizes it across all concrete repositories so the same
contract is enforced everywhere a snapshot can land:

* ``in_memory``      — always run (default Protocol implementation)
* ``sql_aiosqlite``  — exercises the SQLAlchemy code path against an
                       in-memory aiosqlite DB; runs in CI without
                       requiring a Postgres container
* ``sql_postgres``   — runs only when ``TEST_DATABASE_URL`` is set;
                       skipped otherwise so the suite stays green on dev
                       boxes without Postgres

The contract verified across all variants:

* round-trip save → list → get → delete
* share-token issuance, rotation, and revocation
* share-index cleanup on delete + rotation
* per-tenant cap enforcement
* list projection picks the right ``primary_label``
* the snapshot envelope round-trips a full ``MarketPosture`` /
  ``MarketNarrative`` payload byte-equivalent (deterministic posture
  contract preserved verbatim)
"""

from __future__ import annotations

import os
from datetime import datetime, timezone
from typing import AsyncIterator

import pytest

from app.db import Base, build_engine, build_session_factory
from app.intelligence.investigations import (
    CompareTargetSnapshot,
    InMemoryInvestigationRepository,
    InvestigationNotFoundError,
    InvestigationRepository,
    InvestigationService,
    SavedInvestigationCreate,
    SavedInvestigationLimitError,
    SavedInvestigationSnapshot,
    SqlAlchemyInvestigationRepository,
    WorkspaceSelectionSnapshot,
)
from app.intelligence.portfolio.posture.narrative import MarketNarrative
from app.intelligence.portfolio.posture.schemas import (
    MarketPosture,
    PostureComponents,
    PostureDriver,
)


CAPTURED_AT = datetime(2026, 4, 26, 12, 0, 0, tzinfo=timezone.utc)


# ---------------------------------------------------------------------------
# parametrized repository fixture
# ---------------------------------------------------------------------------


_REPO_KINDS: tuple[str, ...] = ("in_memory", "sql_aiosqlite", "sql_postgres")


@pytest.fixture(params=_REPO_KINDS)
async def investigation_repo(
    request: pytest.FixtureRequest,
) -> AsyncIterator[InvestigationRepository]:
    kind = request.param
    if kind == "in_memory":
        yield InMemoryInvestigationRepository()
        return

    if kind == "sql_aiosqlite":
        engine = build_engine("sqlite+aiosqlite:///:memory:")
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
            await conn.run_sync(Base.metadata.create_all)
        factory = build_session_factory(engine)
        try:
            yield SqlAlchemyInvestigationRepository(session_factory=factory)
        finally:
            await engine.dispose()
        return

    if kind == "sql_postgres":
        dsn = os.environ.get("TEST_DATABASE_URL")
        if not dsn:
            pytest.skip("TEST_DATABASE_URL unset; Postgres contract tests skipped")
        engine = build_engine(dsn)
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
            await conn.run_sync(Base.metadata.create_all)
        factory = build_session_factory(engine)
        try:
            yield SqlAlchemyInvestigationRepository(session_factory=factory)
        finally:
            async with engine.begin() as conn:
                await conn.run_sync(Base.metadata.drop_all)
            await engine.dispose()
        return

    raise AssertionError(f"unknown repo kind: {kind}")


def _service(
    repo: InvestigationRepository, *, max_saved: int = 100
) -> InvestigationService:
    return InvestigationService(repository=repo, max_saved=max_saved)


# ---------------------------------------------------------------------------
# fixtures for typed snapshot bodies
# ---------------------------------------------------------------------------


def _posture(symbol: str = "AAPL") -> MarketPosture:
    return MarketPosture(
        symbol=symbol,
        asset_class="equities",
        posture="buy",
        posture_label="Buy",
        tilt=0.42,
        effective_tilt=0.31,
        confidence=0.74,
        components=PostureComponents(
            technical=0.5,
            semantic=0.3,
            macro=None,
            uncertainty=0.26,
        ),
        drivers=[
            PostureDriver(
                component="technical",
                label="50DMA reclaim",
                signed_contribution=0.25,
                rationale="Price reclaimed the 50-day moving average.",
                evidence_ids=["evt-tech-1"],
            ),
        ],
        caveats=["Light volume"],
        freshness_seconds=180,
        as_of=CAPTURED_AT,
        notes=[],
        provider="alphavantage",
        provider_health="live",
        semantic_pressure=None,
    )


def _narrative(symbol: str = "AAPL") -> MarketNarrative:
    return MarketNarrative(
        symbol=symbol,
        narrative="The current posture leans constructive on technical reclaim.",
        cited_driver_ids=["evt-tech-1"],
        narrative_caveats=[],
        posture_alignment_check="aligned",
        source="deterministic",
        generated_at=CAPTURED_AT,
    )


def _snapshot(*, symbol: str = "AAPL") -> SavedInvestigationSnapshot:
    return SavedInvestigationSnapshot(
        workspace_mode="investigate",
        selection=WorkspaceSelectionSnapshot(
            country_code="USA",
            country_name="United States",
            market_symbol=symbol,
            market_asset_class="equities",
        ),
        market_posture=_posture(symbol),
        market_narrative=_narrative(symbol),
        compare_targets=[],
        caveats=["Light volume"],
        provider_health_at_capture="live",
        freshness_seconds_at_capture=180,
        captured_at=CAPTURED_AT,
    )


# ---------------------------------------------------------------------------
# round-trip + listing
# ---------------------------------------------------------------------------


async def test_save_then_get_round_trip_preserves_posture_envelope(
    investigation_repo: InvestigationRepository,
) -> None:
    service = _service(investigation_repo)
    snapshot = _snapshot()

    saved = await service.save_investigation(
        SavedInvestigationCreate(name="AAPL deep dive", snapshot=snapshot)
    )
    assert saved.id.startswith("inv_")
    assert saved.name == "AAPL deep dive"
    assert saved.share_token is None

    fetched = await service.get_investigation(saved.id)
    assert fetched.snapshot.market_posture == snapshot.market_posture
    assert fetched.snapshot.market_narrative == snapshot.market_narrative
    assert fetched.snapshot.captured_at == CAPTURED_AT
    assert fetched.snapshot.provider_health_at_capture == "live"


async def test_list_returns_lightweight_items_in_creation_order(
    investigation_repo: InvestigationRepository,
) -> None:
    import asyncio

    service = _service(investigation_repo)
    first = await service.save_investigation(
        SavedInvestigationCreate(name="First", snapshot=_snapshot(symbol="AAPL"))
    )
    # Tie-break monotonically — Windows clock resolution can collapse two
    # consecutive saves to the same microsecond.
    await asyncio.sleep(0.005)
    second = await service.save_investigation(
        SavedInvestigationCreate(name="Second", snapshot=_snapshot(symbol="MSFT"))
    )

    items = await service.list_investigations()
    assert [item.id for item in items] == [second.id, first.id]
    assert items[0].primary_label == "MSFT"
    assert items[0].workspace_mode == "investigate"
    assert items[0].has_share is False


async def test_primary_label_falls_back_to_country_when_no_symbol(
    investigation_repo: InvestigationRepository,
) -> None:
    service = _service(investigation_repo)
    snap = SavedInvestigationSnapshot(
        workspace_mode="investigate",
        selection=WorkspaceSelectionSnapshot(
            country_code="USA",
            country_name="United States",
        ),
        captured_at=CAPTURED_AT,
        provider_health_at_capture="unconfigured",
    )
    saved = await service.save_investigation(
        SavedInvestigationCreate(name="USA risk", snapshot=snap)
    )
    items = await service.list_investigations()
    assert items[0].id == saved.id
    assert items[0].primary_label == "United States"


# ---------------------------------------------------------------------------
# delete
# ---------------------------------------------------------------------------


async def test_delete_removes_record_and_returns_404_on_get(
    investigation_repo: InvestigationRepository,
) -> None:
    service = _service(investigation_repo)
    saved = await service.save_investigation(
        SavedInvestigationCreate(name="Doomed", snapshot=_snapshot())
    )
    await service.delete_investigation(saved.id)
    with pytest.raises(InvestigationNotFoundError):
        await service.get_investigation(saved.id)


async def test_delete_unknown_id_raises(
    investigation_repo: InvestigationRepository,
) -> None:
    service = _service(investigation_repo)
    with pytest.raises(InvestigationNotFoundError):
        await service.delete_investigation("inv_does_not_exist")


# ---------------------------------------------------------------------------
# share tokens
# ---------------------------------------------------------------------------


async def test_issue_share_token_returns_unguessable_token(
    investigation_repo: InvestigationRepository,
) -> None:
    service = _service(investigation_repo)
    saved = await service.save_investigation(
        SavedInvestigationCreate(name="Shareable", snapshot=_snapshot())
    )
    shared = await service.issue_share_token(saved.id)
    assert shared.share_token
    assert len(shared.share_token) >= 24

    via_token = await service.get_by_share_token(shared.share_token)
    assert via_token.id == saved.id


async def test_rotating_share_token_invalidates_previous_token(
    investigation_repo: InvestigationRepository,
) -> None:
    service = _service(investigation_repo)
    saved = await service.save_investigation(
        SavedInvestigationCreate(name="Rotated", snapshot=_snapshot())
    )
    first = await service.issue_share_token(saved.id)
    second = await service.issue_share_token(saved.id)
    assert first.share_token != second.share_token

    with pytest.raises(InvestigationNotFoundError):
        await service.get_by_share_token(first.share_token)
    via_new = await service.get_by_share_token(second.share_token)
    assert via_new.id == saved.id


async def test_revoke_share_token_removes_token_and_index(
    investigation_repo: InvestigationRepository,
) -> None:
    service = _service(investigation_repo)
    saved = await service.save_investigation(
        SavedInvestigationCreate(name="To revoke", snapshot=_snapshot())
    )
    issued = await service.issue_share_token(saved.id)
    revoked = await service.revoke_share_token(saved.id)
    assert revoked.share_token is None
    with pytest.raises(InvestigationNotFoundError):
        await service.get_by_share_token(issued.share_token)


async def test_delete_purges_share_index_entry(
    investigation_repo: InvestigationRepository,
) -> None:
    service = _service(investigation_repo)
    saved = await service.save_investigation(
        SavedInvestigationCreate(name="Deleted while shared", snapshot=_snapshot())
    )
    issued = await service.issue_share_token(saved.id)
    await service.delete_investigation(saved.id)
    with pytest.raises(InvestigationNotFoundError):
        await service.get_by_share_token(issued.share_token)


# ---------------------------------------------------------------------------
# per-tenant cap
# ---------------------------------------------------------------------------


async def test_per_tenant_cap_blocks_further_saves(
    investigation_repo: InvestigationRepository,
) -> None:
    service = _service(investigation_repo, max_saved=2)
    await service.save_investigation(
        SavedInvestigationCreate(name="One", snapshot=_snapshot(symbol="AAPL"))
    )
    await service.save_investigation(
        SavedInvestigationCreate(name="Two", snapshot=_snapshot(symbol="MSFT"))
    )
    with pytest.raises(SavedInvestigationLimitError):
        await service.save_investigation(
            SavedInvestigationCreate(name="Three", snapshot=_snapshot(symbol="GOOG"))
        )


# ---------------------------------------------------------------------------
# compare set passthrough
# ---------------------------------------------------------------------------


async def test_compare_targets_are_preserved_on_round_trip(
    investigation_repo: InvestigationRepository,
) -> None:
    service = _service(investigation_repo)
    snap = SavedInvestigationSnapshot(
        workspace_mode="compare",
        selection=WorkspaceSelectionSnapshot(),
        compare_targets=[
            CompareTargetSnapshot(
                kind="country", id="USA", label="United States", country_code="USA"
            ),
            CompareTargetSnapshot(
                kind="country", id="JPN", label="Japan", country_code="JPN"
            ),
        ],
        captured_at=CAPTURED_AT,
        provider_health_at_capture="live",
    )
    saved = await service.save_investigation(
        SavedInvestigationCreate(name="USA vs JPN", snapshot=snap)
    )
    fetched = await service.get_investigation(saved.id)
    assert [t.id for t in fetched.snapshot.compare_targets] == ["USA", "JPN"]
