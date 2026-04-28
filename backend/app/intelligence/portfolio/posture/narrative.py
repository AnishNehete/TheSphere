"""Phase 17A.3 — bounded agentic market-posture narrative.

This module sits **on top of** the deterministic posture engine. It does
not invent posture, confidence, prices, or scores; it only paraphrases
what the typed posture envelope already says, optionally polished by an
LLM (Anthropic Claude) when one is configured.

Design contract:

* The deterministic posture is the source of record. Any LLM output that
  cites a driver id outside the posture envelope, mentions a numeric not
  present in that envelope, or contradicts the posture label is rejected
  and the deterministic narrative is returned instead.
* When ``ANTHROPIC_API_KEY`` is unset, the deterministic narrative is
  returned directly. Behavior is identical except ``source`` is
  ``"deterministic"`` so the frontend can label the surface honestly.
* When confidence is low or posture is ``neutral``, the prompt forces
  non-directional language; a post-hoc lexical guard rejects the output
  if directional verbs slip through.
"""

from __future__ import annotations

import json
import logging
import re
from datetime import datetime, timezone
from typing import Literal

import httpx
from pydantic import BaseModel, ConfigDict, Field

from app.intelligence.portfolio.posture.schemas import MarketPosture


logger = logging.getLogger(__name__)


NarrativeSource = Literal["anthropic", "deterministic"]
PostureAlignmentCheck = Literal["aligned", "diverges", "skipped"]


# Heuristics for the directional-language guard. Kept narrow on purpose:
# false positives just trigger fallback to the deterministic narrative,
# which is itself safe — so we err on the side of catching too much.
_DIRECTIONAL_VERBS = (
    "buy now",
    "sell now",
    "expect a rally",
    "expect a sell-off",
    "will rise",
    "will fall",
    "will rally",
    "will crash",
    "guaranteed",
    "will outperform",
    "will underperform",
)


# We forbid percentages and dollar prices in the narrative entirely.
# The deterministic envelope already exposes these; the agentic layer's
# job is qualitative explanation, not numeric restatement.
_FORBIDDEN_NUMERIC_PATTERNS = (
    re.compile(r"\d+(\.\d+)?\s*%"),
    re.compile(r"\$\s*\d+(\.\d+)?"),
    re.compile(r"\b\d{2,}\.\d{2,}\b"),  # bare price-shaped numbers
)


_MAX_NARRATIVE_CHARS = 480
_MAX_SENTENCES = 4  # generous; prompt asks for 2-3, this is the hard cap


class MarketNarrative(BaseModel):
    """Bounded narrative response over the deterministic posture envelope."""

    model_config = ConfigDict(frozen=True)

    symbol: str
    narrative: str
    cited_driver_ids: list[str] = Field(default_factory=list)
    narrative_caveats: list[str] = Field(default_factory=list)
    posture_alignment_check: PostureAlignmentCheck = "skipped"
    source: NarrativeSource = "deterministic"
    generated_at: datetime


class NarrativeResponse(BaseModel):
    """Combined response shape returned by the narrative endpoint."""

    model_config = ConfigDict(frozen=True)

    posture: MarketPosture
    narrative: MarketNarrative


# ---------- deterministic builder -------------------------------------------


def build_narrative_deterministic(posture: MarketPosture) -> MarketNarrative:
    """Compose narrative prose from typed posture fields only.

    This is what the frontend gets when no LLM is configured, when the
    LLM call fails, or when guardrails reject the LLM output. Every
    sentence below is derivable from a posture field — there is nothing
    here that an integration test cannot reproduce deterministically.
    """

    semantic = posture.semantic_pressure
    conf_pct = round(posture.confidence * 100)
    low_confidence = posture.confidence < 0.4

    cited: list[str] = []
    caveats = list(posture.caveats[:2])

    if posture.provider_health == "unconfigured":
        narrative = (
            "Posture call is unavailable — the market data provider is not "
            "configured. Once a provider is wired, technical and macro "
            "components will come online; news pressure already updates "
            "from the live event corpus."
        )
        if low_confidence:
            caveats.insert(0, "No directional call without a configured provider.")
        return MarketNarrative(
            symbol=posture.symbol,
            narrative=narrative,
            cited_driver_ids=[],
            narrative_caveats=caveats,
            posture_alignment_check="skipped",
            source="deterministic",
            generated_at=datetime.now(timezone.utc),
        )

    if posture.provider_health == "unsupported":
        narrative = (
            f"{posture.symbol} is outside the configured market provider's "
            "coverage, so technical and macro components are blind here. "
            "The posture leans on news pressure only and should be treated "
            "as a watch surface rather than an actionable call."
        )
        caveats.insert(0, "Limited substrate — interpret as news-only.")
        return MarketNarrative(
            symbol=posture.symbol,
            narrative=narrative,
            cited_driver_ids=[],
            narrative_caveats=caveats,
            posture_alignment_check="skipped",
            source="deterministic",
            generated_at=datetime.now(timezone.utc),
        )

    # Pick the lead component by absolute contribution among populated values.
    component_pairs: list[tuple[str, float]] = []
    if posture.components.technical is not None:
        component_pairs.append(("technical signal", posture.components.technical))
    if posture.components.semantic is not None:
        component_pairs.append(("news pressure", posture.components.semantic))
    if posture.components.macro is not None:
        component_pairs.append(("macro context", posture.components.macro))
    component_pairs.sort(key=lambda p: abs(p[1]), reverse=True)
    lead = component_pairs[0] if component_pairs else None

    if posture.posture == "neutral":
        if low_confidence:
            opener = (
                f"{posture.symbol} is reading mixed; conviction is low so "
                f"the call holds at neutral until a clearer signal emerges."
            )
        else:
            opener = (
                f"{posture.symbol} is balanced — no directional pressure "
                f"strong enough to lean on right now."
            )
    else:
        lead_phrase = (
            f"{lead[0]} carrying the call"
            if lead is not None
            else "drivers below"
        )
        opener = (
            f"{posture.symbol} reads {posture.posture_label.lower()}, with "
            f"{lead_phrase} at {conf_pct}% conviction."
        )

    middle: str
    if semantic is None or semantic.matched_event_count == 0:
        middle = (
            "No qualifying news events overlapped this symbol in the recent "
            "corpus, so the call is technical and macro only."
        )
    else:
        top = list(semantic.top_semantic_drivers[:2])
        for driver in top:
            cited.append(driver.event_id)
        if len(top) == 1:
            middle = (
                f"News pressure is {semantic.semantic_direction} on the "
                f"strength of {top[0].publisher or 'a recent report'} "
                f"flagging \"{top[0].title}\"."
            )
        else:
            middle = (
                f"News pressure is {semantic.semantic_direction}, anchored "
                f"by {top[0].publisher or 'a recent report'} and "
                f"{top[1].publisher or 'a corroborating outlet'}."
            )

    if low_confidence:
        tail = (
            "Conviction is low — treat this as a watch, not a directional call."
        )
        caveats.insert(0, "Low conviction — do not act on this alone.")
    elif posture.posture == "neutral":
        tail = (
            "Watch for a definitive driver in the next refresh; a single "
            "strong technical or news event could resolve the balance."
        )
    else:
        tail = (
            "The drivers panel below explains which signals carry the call "
            "and what would invalidate it."
        )

    narrative = f"{opener} {middle} {tail}"
    if len(narrative) > _MAX_NARRATIVE_CHARS:
        narrative = narrative[: _MAX_NARRATIVE_CHARS - 1].rstrip() + "…"

    return MarketNarrative(
        symbol=posture.symbol,
        narrative=narrative,
        cited_driver_ids=cited,
        narrative_caveats=caveats,
        posture_alignment_check="aligned",
        source="deterministic",
        generated_at=datetime.now(timezone.utc),
    )


# ---------- Anthropic builder ----------------------------------------------


_SYSTEM_PROMPT = (
    "You are a bounded explanation layer over a deterministic market-posture "
    "envelope. You never invent prices, percentages, posture labels, or "
    "confidence values. You only paraphrase the typed posture provided to "
    "you.\n\n"
    "Hard rules:\n"
    "* 2-3 sentences, max 4. Plain operator-grade prose.\n"
    "* No numerics in the prose — no percentages, no prices. Use qualitative "
    "language only ('low conviction', 'leans bullish', 'mixed').\n"
    "* If the posture confidence is below 0.4 OR the posture is 'neutral', "
    "do NOT use directional verbs ('will rise', 'expect a rally', 'buy "
    "now', etc). Frame as a watch, not a call.\n"
    "* Cite at most two driver event ids (from semantic_pressure."
    "top_semantic_drivers); do not invent ids.\n"
    "* Output STRICT JSON matching the schema you are given. No prose "
    "around the JSON.\n"
)


def _build_user_prompt(posture: MarketPosture) -> str:
    """Build the user prompt — only deterministic fields, no derived prose."""

    semantic = posture.semantic_pressure
    semantic_block: dict[str, object] | None = None
    if semantic is not None:
        semantic_block = {
            "direction": semantic.semantic_direction,
            "matched_event_count": semantic.matched_event_count,
            "top_drivers": [
                {
                    "event_id": d.event_id,
                    "title": d.title,
                    "publisher": d.publisher,
                    "direction": d.direction,
                    "age_hours": round(d.age_hours, 1),
                }
                for d in semantic.top_semantic_drivers[:3]
            ],
        }

    payload = {
        "symbol": posture.symbol,
        "asset_class": posture.asset_class,
        "posture": posture.posture,
        "posture_label": posture.posture_label,
        "confidence_band": (
            "low" if posture.confidence < 0.4
            else "high" if posture.confidence > 0.7
            else "moderate"
        ),
        "components_qualitative": {
            "technical": _qualitative(posture.components.technical),
            "semantic": _qualitative(posture.components.semantic),
            "macro": _qualitative(posture.components.macro),
        },
        "provider_health": posture.provider_health,
        "semantic_pressure": semantic_block,
        "caveats": list(posture.caveats),
    }

    schema_hint = (
        '{"narrative":"<2-3 sentences>","cited_driver_ids":["<event_id>"],'
        '"narrative_caveats":["<short caveat>"],'
        '"posture_alignment_check":"aligned|diverges"}'
    )

    return (
        "Posture envelope (deterministic — do not contradict):\n"
        f"{json.dumps(payload, separators=(',', ':'))}\n\n"
        f"Output JSON only, matching: {schema_hint}\n"
        "Set posture_alignment_check to 'aligned' if your narrative agrees "
        "with the posture label and confidence band; set 'diverges' only if "
        "you genuinely disagree (which should be rare and must be explained "
        "in narrative_caveats)."
    )


def _qualitative(value: float | None) -> str:
    if value is None:
        return "missing"
    if value > 0.4:
        return "strongly_bullish"
    if value > 0.1:
        return "leans_bullish"
    if value < -0.4:
        return "strongly_bearish"
    if value < -0.1:
        return "leans_bearish"
    return "neutral"


def _violates_numeric_guard(text: str) -> bool:
    return any(p.search(text) for p in _FORBIDDEN_NUMERIC_PATTERNS)


def _violates_directional_guard(text: str, posture: MarketPosture) -> bool:
    if posture.posture != "neutral" and posture.confidence >= 0.4:
        return False
    lower = text.lower()
    return any(verb in lower for verb in _DIRECTIONAL_VERBS)


def _too_long(text: str) -> bool:
    if len(text) > _MAX_NARRATIVE_CHARS:
        return True
    sentence_count = len(re.findall(r"[.!?]\s", text)) + 1
    return sentence_count > _MAX_SENTENCES


def _validate_llm_output(
    *,
    raw: dict[str, object],
    posture: MarketPosture,
) -> MarketNarrative | None:
    """Apply guardrails. Return None if any rule is violated."""

    narrative = raw.get("narrative")
    if not isinstance(narrative, str) or not narrative.strip():
        return None
    narrative = narrative.strip()
    if _too_long(narrative):
        return None
    if _violates_numeric_guard(narrative):
        return None
    if _violates_directional_guard(narrative, posture):
        return None

    cited_raw = raw.get("cited_driver_ids", [])
    if not isinstance(cited_raw, list):
        return None
    semantic = posture.semantic_pressure
    allowed_ids: set[str] = set()
    if semantic is not None:
        allowed_ids = {d.event_id for d in semantic.top_semantic_drivers}
    cited: list[str] = []
    for item in cited_raw:
        if not isinstance(item, str):
            return None
        if item not in allowed_ids:
            # Hallucinated id — refuse the whole output.
            return None
        cited.append(item)

    caveats_raw = raw.get("narrative_caveats", [])
    if not isinstance(caveats_raw, list):
        return None
    caveats: list[str] = []
    for c in caveats_raw[:4]:
        if not isinstance(c, str):
            return None
        caveats.append(c.strip()[:160])

    alignment = raw.get("posture_alignment_check", "aligned")
    if alignment not in ("aligned", "diverges"):
        alignment = "aligned"

    return MarketNarrative(
        symbol=posture.symbol,
        narrative=narrative,
        cited_driver_ids=cited,
        narrative_caveats=caveats,
        posture_alignment_check=alignment,  # type: ignore[arg-type]
        source="anthropic",
        generated_at=datetime.now(timezone.utc),
    )


def _extract_json_payload(content: object) -> dict[str, object] | None:
    """Pull the JSON object out of an Anthropic message-content block list."""

    if not isinstance(content, list):
        return None
    text_parts: list[str] = []
    for block in content:
        if isinstance(block, dict) and block.get("type") == "text":
            text = block.get("text")
            if isinstance(text, str):
                text_parts.append(text)
    if not text_parts:
        return None
    joined = "\n".join(text_parts).strip()
    # Be lenient about leading/trailing prose around the JSON object.
    match = re.search(r"\{.*\}", joined, re.DOTALL)
    if not match:
        return None
    try:
        parsed = json.loads(match.group(0))
    except json.JSONDecodeError:
        return None
    if not isinstance(parsed, dict):
        return None
    return parsed


async def build_narrative_with_anthropic(
    posture: MarketPosture,
    *,
    api_key: str,
    model: str,
    base_url: str,
    timeout_seconds: float,
    http_client: httpx.AsyncClient | None = None,
) -> MarketNarrative:
    """Call Anthropic; on any failure fall back to the deterministic narrative.

    The fallback is the whole point: if the upstream is slow, broken, or
    returns something that fails our guardrails, the operator still gets
    a coherent grounded narrative (just with ``source="deterministic"``).
    """

    if not api_key:
        return build_narrative_deterministic(posture)

    payload = {
        "model": model,
        "max_tokens": 320,
        "system": _SYSTEM_PROMPT,
        "messages": [
            {"role": "user", "content": _build_user_prompt(posture)}
        ],
    }
    headers = {
        "x-api-key": api_key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
    }

    async def _do_call(client: httpx.AsyncClient) -> httpx.Response:
        return await client.post(
            f"{base_url.rstrip('/')}/v1/messages",
            json=payload,
            headers=headers,
            timeout=timeout_seconds,
        )

    try:
        if http_client is not None:
            response = await _do_call(http_client)
        else:
            async with httpx.AsyncClient(timeout=timeout_seconds) as client:
                response = await _do_call(client)
    except (httpx.HTTPError, httpx.TimeoutException) as exc:
        logger.warning("narrative: anthropic call failed: %s", exc)
        return build_narrative_deterministic(posture)

    if response.status_code != 200:
        logger.warning(
            "narrative: anthropic returned %s: %s",
            response.status_code,
            response.text[:200],
        )
        return build_narrative_deterministic(posture)

    try:
        body = response.json()
    except ValueError:
        return build_narrative_deterministic(posture)

    parsed = _extract_json_payload(body.get("content"))
    if parsed is None:
        logger.info("narrative: anthropic output not parseable as JSON")
        return build_narrative_deterministic(posture)

    validated = _validate_llm_output(raw=parsed, posture=posture)
    if validated is None:
        logger.info("narrative: anthropic output rejected by guardrails")
        return build_narrative_deterministic(posture)

    return validated


__all__ = [
    "MarketNarrative",
    "NarrativeResponse",
    "NarrativeSource",
    "PostureAlignmentCheck",
    "build_narrative_deterministic",
    "build_narrative_with_anthropic",
]
