"""Phase 17A.3 — bounded agentic market-narrative tests.

Pins the contract that the narrative layer:
* never invents prices, scores, posture enums, or confidence numbers
* cites only driver ids already present in the posture envelope
* refuses directional language when posture is neutral / low-confidence
* falls back to deterministic prose on any guardrail or upstream failure
"""

from __future__ import annotations

import json
from datetime import datetime, timezone

import httpx
import pytest

from app.intelligence.portfolio.posture.narrative import (
    build_narrative_deterministic,
    build_narrative_with_anthropic,
)
from app.intelligence.portfolio.posture.schemas import (
    MarketPosture,
    PostureComponents,
    PostureDriver,
)
from app.intelligence.portfolio.posture.symbol_semantic import (
    SemanticEventDriver,
    SymbolSemanticPressure,
)


REF = datetime(2026, 4, 26, 12, 0, tzinfo=timezone.utc)


def _semantic(direction: str = "bearish", drivers: int = 2) -> SymbolSemanticPressure:
    pool = [
        SemanticEventDriver(
            event_id=f"evt-{i}",
            title=f"Headline {i}",
            publisher="Reuters" if i % 2 == 0 else "Bloomberg",
            severity_score=0.7,
            age_hours=float(i + 1),
            direction=direction,
            contribution=-0.3 if direction == "bearish" else 0.3,
            reliability=0.8,
        )
        for i in range(drivers)
    ]
    return SymbolSemanticPressure(
        symbol="AAPL",
        asset_class="equities",
        semantic_score=-0.25 if direction == "bearish" else 0.25,
        semantic_direction=direction,
        semantic_confidence=0.6,
        matched_event_count=drivers,
        recency_skew_hours=4.0,
        top_semantic_drivers=pool,
        semantic_caveats=[],
    )


def _posture(
    *,
    posture: str = "buy",
    confidence: float = 0.7,
    semantic: SymbolSemanticPressure | None = None,
    provider_health: str = "live",
) -> MarketPosture:
    return MarketPosture(
        symbol="AAPL",
        asset_class="equities",
        posture=posture,  # type: ignore[arg-type]
        posture_label=posture.replace("_", " ").title(),
        tilt=0.4 if posture != "neutral" else 0.05,
        effective_tilt=0.3 if posture != "neutral" else 0.02,
        confidence=confidence,
        components=PostureComponents(
            technical=0.5 if posture != "neutral" else 0.05,
            semantic=-0.2 if semantic and semantic.semantic_direction == "bearish" else 0.1,
            macro=0.0,
            uncertainty=1 - confidence,
        ),
        drivers=[
            PostureDriver(
                component="technical",
                label="Trend leadership",
                signed_contribution=0.3,
                rationale="Price above SMA50 and SMA200.",
                evidence_ids=[],
            )
        ],
        caveats=["Realized 30d vol annualized = 0.35."],
        freshness_seconds=120,
        as_of=REF,
        notes=[],
        provider="alphavantage+cache",
        provider_health=provider_health,  # type: ignore[arg-type]
        semantic_pressure=semantic,
    )


# ---------- deterministic builder ------------------------------------------


def test_deterministic_builder_returns_aligned_narrative_for_directional_posture() -> None:
    narrative = build_narrative_deterministic(_posture(semantic=_semantic()))
    assert narrative.source == "deterministic"
    assert narrative.posture_alignment_check == "aligned"
    assert narrative.symbol == "AAPL"
    assert "AAPL" in narrative.narrative
    # Cited drivers must come from the semantic envelope.
    for cid in narrative.cited_driver_ids:
        assert cid.startswith("evt-")


def test_deterministic_builder_uses_non_directional_language_when_low_confidence() -> None:
    posture = _posture(posture="buy", confidence=0.25, semantic=_semantic())
    narrative = build_narrative_deterministic(posture)
    text = narrative.narrative.lower()
    # Soft watch language; never a directional command.
    assert "watch" in text or "low" in text
    assert "buy now" not in text
    assert "expect a rally" not in text


def test_deterministic_builder_handles_unsupported_provider() -> None:
    posture = _posture(provider_health="unsupported", semantic=None)
    narrative = build_narrative_deterministic(posture)
    assert "outside" in narrative.narrative.lower() or "coverage" in narrative.narrative.lower()
    assert narrative.cited_driver_ids == []


def test_deterministic_builder_handles_unconfigured_provider() -> None:
    posture = _posture(provider_health="unconfigured", semantic=None)
    narrative = build_narrative_deterministic(posture)
    assert "not configured" in narrative.narrative.lower() or "unavailable" in narrative.narrative.lower()


# ---------- Anthropic builder + guardrails ---------------------------------


def _client(handler) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


def _anthropic_response(json_text: str) -> httpx.Response:
    return httpx.Response(
        200,
        json={
            "id": "msg_test",
            "type": "message",
            "role": "assistant",
            "model": "claude-haiku-4-5",
            "content": [{"type": "text", "text": json_text}],
        },
    )


@pytest.mark.asyncio
async def test_anthropic_path_returns_validated_narrative_when_clean() -> None:
    posture = _posture(semantic=_semantic())
    payload = {
        "narrative": (
            "AAPL is leaning bullish on technical strength, with news pressure "
            "easing recent caution. The drivers panel below explains why."
        ),
        "cited_driver_ids": ["evt-0"],
        "narrative_caveats": ["News context still mixed."],
        "posture_alignment_check": "aligned",
    }

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path.endswith("/v1/messages")
        return _anthropic_response(json.dumps(payload))

    client = _client(handler)
    try:
        narrative = await build_narrative_with_anthropic(
            posture,
            api_key="sk-test",
            model="claude-haiku-4-5-20251001",
            base_url="https://api.anthropic.com",
            timeout_seconds=5.0,
            http_client=client,
        )
    finally:
        await client.aclose()

    assert narrative.source == "anthropic"
    assert narrative.cited_driver_ids == ["evt-0"]
    assert narrative.posture_alignment_check == "aligned"


@pytest.mark.asyncio
async def test_anthropic_path_rejects_hallucinated_driver_id() -> None:
    posture = _posture(semantic=_semantic())
    payload = {
        "narrative": "AAPL is leaning bullish.",
        "cited_driver_ids": ["evt-DOES-NOT-EXIST"],
        "narrative_caveats": [],
        "posture_alignment_check": "aligned",
    }

    def handler(_: httpx.Request) -> httpx.Response:
        return _anthropic_response(json.dumps(payload))

    client = _client(handler)
    try:
        narrative = await build_narrative_with_anthropic(
            posture,
            api_key="sk-test",
            model="x",
            base_url="https://api.anthropic.com",
            timeout_seconds=5.0,
            http_client=client,
        )
    finally:
        await client.aclose()

    # Hallucinated id → reject + fall back to deterministic.
    assert narrative.source == "deterministic"


@pytest.mark.asyncio
async def test_anthropic_path_rejects_numeric_in_prose() -> None:
    posture = _posture(semantic=_semantic())
    payload = {
        # 184.32 is a price-shaped number — the prose layer must not restate
        # numerics from the deterministic envelope.
        "narrative": "AAPL trades at 184.32 and is leaning bullish.",
        "cited_driver_ids": [],
        "narrative_caveats": [],
        "posture_alignment_check": "aligned",
    }

    def handler(_: httpx.Request) -> httpx.Response:
        return _anthropic_response(json.dumps(payload))

    client = _client(handler)
    try:
        narrative = await build_narrative_with_anthropic(
            posture,
            api_key="sk-test",
            model="x",
            base_url="https://api.anthropic.com",
            timeout_seconds=5.0,
            http_client=client,
        )
    finally:
        await client.aclose()

    assert narrative.source == "deterministic"


@pytest.mark.asyncio
async def test_anthropic_path_rejects_directional_language_at_low_confidence() -> None:
    posture = _posture(posture="neutral", confidence=0.2, semantic=_semantic())
    payload = {
        "narrative": "AAPL will rally hard from here — buy now.",
        "cited_driver_ids": [],
        "narrative_caveats": [],
        "posture_alignment_check": "aligned",
    }

    def handler(_: httpx.Request) -> httpx.Response:
        return _anthropic_response(json.dumps(payload))

    client = _client(handler)
    try:
        narrative = await build_narrative_with_anthropic(
            posture,
            api_key="sk-test",
            model="x",
            base_url="https://api.anthropic.com",
            timeout_seconds=5.0,
            http_client=client,
        )
    finally:
        await client.aclose()

    assert narrative.source == "deterministic"


@pytest.mark.asyncio
async def test_anthropic_path_falls_back_on_http_error() -> None:
    posture = _posture(semantic=_semantic())

    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(500, json={"error": "boom"})

    client = _client(handler)
    try:
        narrative = await build_narrative_with_anthropic(
            posture,
            api_key="sk-test",
            model="x",
            base_url="https://api.anthropic.com",
            timeout_seconds=5.0,
            http_client=client,
        )
    finally:
        await client.aclose()

    assert narrative.source == "deterministic"


@pytest.mark.asyncio
async def test_anthropic_path_short_circuits_when_api_key_is_empty() -> None:
    posture = _posture(semantic=_semantic())
    # No client passed; the function must not attempt a network call when
    # the key is empty.
    narrative = await build_narrative_with_anthropic(
        posture,
        api_key="",
        model="x",
        base_url="https://api.anthropic.com",
        timeout_seconds=5.0,
        http_client=None,
    )
    assert narrative.source == "deterministic"
