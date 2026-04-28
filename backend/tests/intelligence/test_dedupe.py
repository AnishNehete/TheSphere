"""DedupeService behavior tests."""

from __future__ import annotations

from datetime import timedelta

from app.intelligence.schemas import SourceRef
from app.intelligence.services.dedupe_service import DedupeService

from tests.intelligence.conftest import FIXED_NOW, make_event


def _source(adapter: str, provider_id: str, reliability: float = 0.6) -> SourceRef:
    return SourceRef(
        adapter=adapter,
        provider=adapter,
        provider_event_id=provider_id,
        retrieved_at=FIXED_NOW,
        source_timestamp=FIXED_NOW,
        publisher="unit-test",
        reliability=reliability,
    )


def test_empty_input_returns_empty_output_and_zeroed_stats() -> None:
    result, stats = DedupeService().dedupe([])

    assert result == []
    assert stats.input_count == 0
    assert stats.output_count == 0
    assert stats.merged_count == 0
    assert stats.reduction_ratio == 0.0


def test_single_event_passes_through_unchanged() -> None:
    event = make_event(event_id="solo", dedupe_key="dk-solo")

    deduped, stats = DedupeService().dedupe([event])

    assert len(deduped) == 1
    assert deduped[0].id == "solo"
    assert stats.merged_count == 0


def test_exact_duplicate_dedupe_keys_collapse_into_one_canonical() -> None:
    primary = make_event(
        event_id="canon",
        dedupe_key="same-key",
        severity_score=0.8,
        confidence=0.7,
        sources=[_source("adapter.a", "prov-a")],
    )
    secondary = make_event(
        event_id="dup",
        dedupe_key="same-key",
        severity_score=0.4,
        confidence=0.5,
        sources=[_source("adapter.b", "prov-b")],
    )

    merged, stats = DedupeService().dedupe([primary, secondary])

    assert len(merged) == 1
    canonical = merged[0]
    # higher severity_score wins
    assert canonical.id == "canon"
    assert stats.input_count == 2
    assert stats.output_count == 1
    assert stats.merged_count == 1
    # lower-ranked event's id recorded
    assert "dup" in canonical.merged_from


def test_merge_preserves_sources_from_all_duplicates() -> None:
    a = make_event(
        event_id="a", dedupe_key="k", severity_score=0.7,
        sources=[_source("adapter.a", "prov-a")],
    )
    b = make_event(
        event_id="b", dedupe_key="k", severity_score=0.5,
        sources=[_source("adapter.b", "prov-b")],
    )
    c = make_event(
        event_id="c", dedupe_key="k", severity_score=0.4,
        sources=[_source("adapter.c", "prov-c")],
    )

    merged, _ = DedupeService().dedupe([a, b, c])

    assert len(merged) == 1
    canonical = merged[0]
    provider_ids = {src.provider_event_id for src in canonical.sources}
    assert provider_ids == {"prov-a", "prov-b", "prov-c"}


def test_merge_does_not_duplicate_identical_source_refs() -> None:
    shared = _source("adapter.a", "prov-shared")
    a = make_event(event_id="a", dedupe_key="k", severity_score=0.7, sources=[shared])
    b = make_event(event_id="b", dedupe_key="k", severity_score=0.5, sources=[shared])

    merged, _ = DedupeService().dedupe([a, b])

    assert len(merged) == 1
    assert len(merged[0].sources) == 1


def test_merge_unions_tags_and_preserves_description() -> None:
    a = make_event(
        event_id="a",
        dedupe_key="k",
        severity_score=0.7,
        description=None,
        tags=["storm"],
    )
    b = make_event(
        event_id="b",
        dedupe_key="k",
        severity_score=0.5,
        description="Detailed description from b",
        tags=["storm", "flooding"],
    )

    merged, _ = DedupeService().dedupe([a, b])

    canonical = merged[0]
    assert set(canonical.tags) == {"storm", "flooding"}
    # canonical had no description; it should inherit b's
    assert canonical.description == "Detailed description from b"


def test_fallback_group_key_collapses_near_duplicates_without_dedupe_key() -> None:
    # empty dedupe_key forces fallback grouping on (type, country, coords, title prefix)
    a = make_event(
        event_id="near-a",
        dedupe_key="",
        category="weather",
        title="Severe storm over Tampa",
        country_code="USA",
        latitude=27.95,
        longitude=-82.46,
        severity_score=0.7,
    )
    b = make_event(
        event_id="near-b",
        dedupe_key="",
        category="weather",
        title="Severe storm over Tampa",
        country_code="USA",
        latitude=27.92,  # rounds to same coarse bucket
        longitude=-82.52,
        severity_score=0.5,
    )

    merged, stats = DedupeService().dedupe([a, b])

    assert len(merged) == 1
    assert stats.merged_count == 1


def test_confidence_bumps_modestly_when_sources_corroborate() -> None:
    a = make_event(
        event_id="a", dedupe_key="k", severity_score=0.7, confidence=0.6,
        sources=[_source("adapter.a", "prov-a")],
    )
    b = make_event(
        event_id="b", dedupe_key="k", severity_score=0.5, confidence=0.5,
        sources=[_source("adapter.b", "prov-b")],
    )

    merged, _ = DedupeService().dedupe([a, b])

    # canonical confidence should rise by 0.05 per merged-in duplicate, capped at 0.95
    assert merged[0].confidence == min(0.95, 0.6 + 0.05)


def test_reduction_ratio_reports_collapse_rate() -> None:
    a = make_event(event_id="a", dedupe_key="k")
    b = make_event(event_id="b", dedupe_key="k")
    c = make_event(event_id="c", dedupe_key="other")

    _, stats = DedupeService().dedupe([a, b, c])

    assert stats.input_count == 3
    assert stats.output_count == 2
    assert stats.merged_count == 1
    assert 0.0 < stats.reduction_ratio < 1.0
