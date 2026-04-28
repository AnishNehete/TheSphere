"""Phase 18B — calibration / reranker / query log tests.

These tests exercise the deterministic core of 18B:

* ranking determinism — same input ⇒ same output, every time
* confidence monotonicity — more / better evidence never decreases the
  calibrated score, all else equal
* calibration correctness — feedback shifts the bucket multiplier in the
  expected direction
* query log append + feedback round-trip — across in-memory **and**
  sqlite-backed Postgres-equivalent paths

The Postgres contract test runs only when ``TEST_DATABASE_URL`` is set,
matching the existing investigations test policy.
"""

from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone
from typing import AsyncIterator

import pytest

from app.db import Base, build_engine, build_session_factory
from app.intelligence.calibration import (
    CalibrationService,
    EvidenceCandidate,
    InMemoryQueryLogRepository,
    QueryContext,
    QueryLogEntryCreate,
    QueryLogRepository,
    RankingWeights,
    SqlAlchemyQueryLogRepository,
    bucketize,
    calibrated_confidence,
    rerank,
)
from app.intelligence.calibration.confidence import ConfidenceInputs
from app.intelligence.calibration.feedback import feedback_score_for_action
from app.intelligence.calibration.weights import (
    WeightsLoader,
    default_weights,
)
from app.intelligence.calibration.schemas import QueryLogEntry


NOW = datetime(2026, 4, 27, 12, 0, 0, tzinfo=timezone.utc)


# ---------------------------------------------------------------------------
# parametrized repository fixture
# ---------------------------------------------------------------------------


_REPO_KINDS: tuple[str, ...] = ("in_memory", "sql_aiosqlite", "sql_postgres")


@pytest.fixture(params=_REPO_KINDS)
async def query_log_repo(
    request: pytest.FixtureRequest,
) -> AsyncIterator[QueryLogRepository]:
    kind = request.param
    if kind == "in_memory":
        yield InMemoryQueryLogRepository()
        return
    if kind == "sql_aiosqlite":
        engine = build_engine("sqlite+aiosqlite:///:memory:")
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
            await conn.run_sync(Base.metadata.create_all)
        factory = build_session_factory(engine)
        try:
            yield SqlAlchemyQueryLogRepository(session_factory=factory)
        finally:
            await engine.dispose()
        return
    if kind == "sql_postgres":
        dsn = os.environ.get("TEST_DATABASE_URL")
        if not dsn:
            pytest.skip("TEST_DATABASE_URL unset; Postgres contract test skipped")
        engine = build_engine(dsn)
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
            await conn.run_sync(Base.metadata.create_all)
        factory = build_session_factory(engine)
        try:
            yield SqlAlchemyQueryLogRepository(session_factory=factory)
        finally:
            async with engine.begin() as conn:
                await conn.run_sync(Base.metadata.drop_all)
            await engine.dispose()
        return
    raise AssertionError(f"unknown repo kind: {kind}")


# ---------------------------------------------------------------------------
# reranker — determinism + ordering
# ---------------------------------------------------------------------------


def _candidate(
    *,
    event_id: str,
    publisher: str | None = "wire",
    event_type: str | None = "weather",
    severity: float = 0.5,
    base: float = 0.5,
    geo: float = 0.0,
    age_hours: float = 0.0,
) -> EvidenceCandidate:
    return EvidenceCandidate(
        event_id=event_id,
        base_score=base,
        severity_score=severity,
        location_match_score=geo,
        semantic_score=base,
        timestamp=NOW - timedelta(hours=age_hours),
        publisher=publisher,
        event_type=event_type,
    )


def test_rerank_is_deterministic_under_identical_input() -> None:
    candidates = [
        _candidate(event_id="a", severity=0.7, age_hours=1),
        _candidate(event_id="b", severity=0.5, age_hours=2),
        _candidate(event_id="c", severity=0.6, age_hours=0.5),
    ]
    ctx = QueryContext(now=NOW, has_place_scope=False)
    a = rerank(candidates, ctx)
    b = rerank(candidates, ctx)
    assert a.event_ids() == b.event_ids()
    assert [
        round(item.breakdown.final_score, 6) for item in a.items
    ] == [round(item.breakdown.final_score, 6) for item in b.items]


def test_rerank_orders_higher_severity_above_lower_when_else_equal() -> None:
    candidates = [
        _candidate(event_id="low", severity=0.2, age_hours=1),
        _candidate(event_id="high", severity=0.9, age_hours=1),
    ]
    ctx = QueryContext(now=NOW, has_place_scope=False)
    result = rerank(candidates, ctx)
    assert result.event_ids()[0] == "high"


def test_rerank_diversity_penalty_demotes_duplicate_publisher() -> None:
    candidates = [
        _candidate(
            event_id="first", severity=0.6, publisher="wire", event_type="news"
        ),
        # Identical publisher + type — should pick up a diversity penalty
        # versus the equivalent novel one below.
        _candidate(
            event_id="dup", severity=0.6, publisher="wire", event_type="news"
        ),
        _candidate(
            event_id="novel", severity=0.6, publisher="other", event_type="news"
        ),
    ]
    ctx = QueryContext(now=NOW, has_place_scope=False)
    weights = RankingWeights(
        freshness_weight=0.2,
        severity_weight=0.2,
        geo_weight=0.0,
        diversity_weight=0.6,
        semantic_weight=0.0,
    )
    result = rerank(candidates, ctx, weights=weights)
    final_for = {item.candidate.event_id: item.breakdown.final_score for item in result.items}
    assert final_for["first"] > final_for["dup"]


def test_rerank_handles_zero_weights_without_error() -> None:
    weights = RankingWeights(
        freshness_weight=0.0,
        severity_weight=0.0,
        geo_weight=0.0,
        diversity_weight=0.0,
        semantic_weight=0.0,
    )
    ctx = QueryContext(now=NOW, has_place_scope=False)
    result = rerank([_candidate(event_id="a")], ctx, weights=weights)
    assert result.event_ids() == ["a"]


# ---------------------------------------------------------------------------
# confidence — monotonicity
# ---------------------------------------------------------------------------


def test_confidence_monotonic_in_evidence_count() -> None:
    base = ConfidenceInputs(
        evidence_count=1,
        evidence_agreement=0.8,
        recency=0.8,
        source_diversity=0.5,
        entity_resolution_confidence=0.7,
    )
    more = ConfidenceInputs(
        evidence_count=6,
        evidence_agreement=0.8,
        recency=0.8,
        source_diversity=0.5,
        entity_resolution_confidence=0.7,
    )
    assert (
        calibrated_confidence(more).raw_score
        >= calibrated_confidence(base).raw_score
    )


def test_confidence_monotonic_in_recency() -> None:
    stale = ConfidenceInputs(
        evidence_count=3,
        evidence_agreement=0.5,
        recency=0.1,
        source_diversity=0.5,
        entity_resolution_confidence=0.5,
    )
    fresh = ConfidenceInputs(
        evidence_count=3,
        evidence_agreement=0.5,
        recency=0.9,
        source_diversity=0.5,
        entity_resolution_confidence=0.5,
    )
    assert calibrated_confidence(fresh).raw_score > calibrated_confidence(stale).raw_score


def test_confidence_zero_when_no_evidence() -> None:
    inputs = ConfidenceInputs(
        evidence_count=0,
        evidence_agreement=0.0,
        recency=0.0,
        source_diversity=0.0,
        entity_resolution_confidence=0.0,
    )
    assert calibrated_confidence(inputs).raw_score == 0.0


# ---------------------------------------------------------------------------
# calibration — bucket math
# ---------------------------------------------------------------------------


def _entry(
    *, score: float, action: str, idx: int, ts: datetime | None = None
) -> QueryLogEntry:
    return QueryLogEntry(
        id=f"qlog_{idx}",
        timestamp=ts or NOW,
        query_text=f"q{idx}",
        intent="status_check",
        resolved_entity_ids=[],
        evidence_ids=[f"evt-{idx}"],
        time_window_kind="live",
        compare_requested=False,
        confidence_score=score,
        top_evidence_score=score,
        result_count=1,
        user_action=action,  # type: ignore[arg-type]
        feedback_score=feedback_score_for_action(action),  # type: ignore[arg-type]
        latency_ms=10,
    )


def test_bucketize_groups_entries_by_confidence_band() -> None:
    entries = [
        _entry(score=0.05, action="click", idx=1),
        _entry(score=0.15, action="share", idx=2),
        _entry(score=0.25, action="refine", idx=3),
        _entry(score=0.85, action="share", idx=4),
        _entry(score=0.95, action="none", idx=5),
    ]
    rows = bucketize(entries)
    by_label = {b.label: b for b in rows}
    assert by_label["0-20"].sample_count == 2
    assert by_label["20-40"].sample_count == 1
    assert by_label["80-100"].sample_count == 2
    # 80-100 has share + none → average should be 0.5
    assert by_label["80-100"].average_feedback == pytest.approx(0.5)


def test_calibration_multiplier_reduces_confidence_after_negative_feedback() -> None:
    entries = [
        _entry(score=0.5, action="refine", idx=1),
        _entry(score=0.55, action="refine", idx=2),
        _entry(score=0.58, action="refine", idx=3),
    ]
    buckets = bucketize(entries)
    inputs = ConfidenceInputs(
        evidence_count=3,
        evidence_agreement=0.6,
        recency=0.6,
        source_diversity=0.5,
        entity_resolution_confidence=0.6,
    )
    raw = calibrated_confidence(inputs).raw_score
    calibrated = calibrated_confidence(inputs, buckets=buckets).calibrated_score
    assert calibrated < raw


def test_calibration_multiplier_lifts_confidence_after_positive_feedback() -> None:
    entries = [
        _entry(score=0.5, action="share", idx=1),
        _entry(score=0.55, action="share", idx=2),
        _entry(score=0.58, action="share", idx=3),
    ]
    buckets = bucketize(entries)
    inputs = ConfidenceInputs(
        evidence_count=3,
        evidence_agreement=0.6,
        recency=0.6,
        source_diversity=0.5,
        entity_resolution_confidence=0.6,
    )
    raw = calibrated_confidence(inputs).raw_score
    calibrated = calibrated_confidence(inputs, buckets=buckets).calibrated_score
    assert calibrated >= raw


# ---------------------------------------------------------------------------
# query log repo contract — append + feedback + listing
# ---------------------------------------------------------------------------


def _payload(*, query: str = "what changed in tokyo?") -> QueryLogEntryCreate:
    return QueryLogEntryCreate(
        query_text=query,
        intent="what_changed",
        resolved_entity_ids=["place:tokyo"],
        evidence_ids=["evt-a", "evt-b"],
        time_window_kind="delta",
        compare_requested=False,
        confidence_score=0.42,
        top_evidence_score=0.55,
        result_count=2,
        latency_ms=120,
    )


async def test_append_then_recent_round_trip(
    query_log_repo: QueryLogRepository,
) -> None:
    entry = await query_log_repo.append(_payload())
    assert entry.id.startswith("qlog_")
    assert entry.user_action == "none"
    rows = await query_log_repo.recent(limit=10)
    assert len(rows) == 1
    assert rows[0].id == entry.id


async def test_mark_user_action_updates_feedback_score(
    query_log_repo: QueryLogRepository,
) -> None:
    entry = await query_log_repo.append(_payload())
    updated = await query_log_repo.mark_user_action(entry.id, "share")
    assert updated.user_action == "share"
    assert updated.feedback_score == pytest.approx(1.0)
    rows = await query_log_repo.recent(limit=10)
    assert rows[0].user_action == "share"


async def test_count_reflects_appended_rows(
    query_log_repo: QueryLogRepository,
) -> None:
    assert await query_log_repo.count() == 0
    await query_log_repo.append(_payload(query="q1"))
    await query_log_repo.append(_payload(query="q2"))
    assert await query_log_repo.count() == 2


# ---------------------------------------------------------------------------
# CalibrationService — log + bucketize + tune simulation
# ---------------------------------------------------------------------------


async def test_calibration_service_simulate_tuning_returns_zero_on_empty_log() -> None:
    service = CalibrationService(repository=InMemoryQueryLogRepository())
    result = await service.simulate_tuning(default_weights())
    assert result.sample_count == 0
    assert result.average_top_score_baseline == 0.0
    assert result.average_top_score_candidate == 0.0


async def test_calibration_service_simulate_tuning_picks_up_logged_rows() -> None:
    service = CalibrationService(repository=InMemoryQueryLogRepository())
    await service.log(_payload())
    candidate = RankingWeights(
        freshness_weight=0.5,
        severity_weight=0.3,
        geo_weight=0.1,
        diversity_weight=0.05,
        semantic_weight=0.05,
    )
    result = await service.simulate_tuning(candidate)
    assert result.sample_count == 1
    assert result.weights_candidate == candidate


# ---------------------------------------------------------------------------
# WeightsLoader — defaults + override
# ---------------------------------------------------------------------------


def test_weights_loader_returns_defaults_when_path_missing(tmp_path) -> None:
    loader = WeightsLoader(path=tmp_path / "nope.yaml")
    assert loader.current() == default_weights()


def test_weights_loader_override_takes_effect_immediately() -> None:
    loader = WeightsLoader()
    custom = RankingWeights(freshness_weight=0.9)
    loader.override(custom)
    assert loader.current() == custom


def test_weights_loader_reads_yaml_file(tmp_path) -> None:
    path = tmp_path / "ranking_weights.yaml"
    path.write_text(
        "freshness_weight: 0.5\n"
        "severity_weight: 0.2\n"
        "geo_weight: 0.1\n"
        "diversity_weight: 0.1\n"
        "semantic_weight: 0.1\n"
    )
    loader = WeightsLoader(path=path)
    weights = loader.current()
    assert weights.freshness_weight == pytest.approx(0.5)
    assert weights.severity_weight == pytest.approx(0.2)
