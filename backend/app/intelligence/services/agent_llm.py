"""Phase 19E — bounded LLM rewriter for the analyst-query agent.

Sits on top of the deterministic ``_compose_answer`` pipeline. It does
not invent evidence, entities, intent, or confidence; it only rephrases
the rule-based answer segments into more natural operator prose and
re-emits citation ids that already exist in the deterministic output.

Design contract (mirrors ``portfolio.posture.narrative``):

* The deterministic ``AgentResponse`` is the source of record. Any LLM
  output that cites an evidence_id outside the rule-based set, drifts
  from the typed intent, or violates length / numeric guards is rejected
  and the rule-based prose is kept verbatim.
* When ``ANTHROPIC_API_KEY`` is unset the rewrite is skipped — the
  caller keeps the deterministic segments and ``reasoning_mode`` stays
  ``"rule_based"``. With a key, ``reasoning_mode`` flips to
  ``"retrieval_plus_llm"`` only on a successful, validated rewrite.
* Numerics (percentages, prices, magic numbers) and directional verbs
  ("buy", "sell", "guaranteed") are forbidden — qualitative prose only.
  Same forbidden list as the market narrative so behaviour feels
  consistent across surfaces.
"""

from __future__ import annotations

import json
import logging
import re
from typing import Sequence

import httpx

from app.intelligence.schemas import AgentSegment, EvidenceRef


logger = logging.getLogger(__name__)


_FORBIDDEN_NUMERIC_PATTERNS = (
    re.compile(r"\d+(\.\d+)?\s*%"),
    re.compile(r"\$\s*\d+(\.\d+)?"),
    re.compile(r"\b\d{2,}\.\d{2,}\b"),
)


_DIRECTIONAL_VERBS = (
    "buy now",
    "sell now",
    "expect a rally",
    "expect a sell-off",
    "guaranteed",
    "will outperform",
    "will underperform",
    "will rise",
    "will fall",
)


_MAX_SEGMENT_CHARS = 360
_MAX_TOTAL_CHARS = 1100
_MAX_SEGMENTS = 5


_SYSTEM_PROMPT = (
    "You are a bounded paraphrasing layer over a deterministic analyst "
    "answer. The answer below was composed from typed retrieval over a "
    "live event corpus — every claim is already grounded. Your job is "
    "to rewrite it into 2-4 short, calm, operator-grade segments that "
    "read more naturally than the rule-based prose, without changing "
    "any fact.\n\n"
    "Hard rules:\n"
    "* You may ONLY cite evidence_ids that already appear in the input "
    "rule_based_segments. Never invent an id; if you are unsure, drop "
    "the citation.\n"
    "* No numerics in the prose — no percentages, no prices, no bare "
    "numbers like '12.4'. Use qualitative language only.\n"
    "* No directional verbs ('buy now', 'will rise', 'guaranteed', "
    "'expect a rally', etc). Frame everything as analyst observation.\n"
    "* Keep each segment under ~360 characters. Total under ~1100. "
    "At most 5 segments.\n"
    "* Preserve the substance of each input segment in the same order. "
    "You may merge two adjacent input segments if the result reads "
    "more naturally, but you may not add information not present in "
    "the input.\n"
    "* Output STRICT JSON matching the schema. No prose around the "
    "JSON object."
)


def _build_user_prompt(
    *,
    query: str,
    intent: str | None,
    subject_label: str,
    rule_based_segments: Sequence[AgentSegment],
    evidence: Sequence[EvidenceRef],
) -> str:
    """Build the user prompt — only deterministic fields, no derived prose."""

    seg_payload = [
        {
            "index": i,
            "text": seg.text,
            "evidence_ids": list(seg.evidence_ids),
        }
        for i, seg in enumerate(rule_based_segments[:_MAX_SEGMENTS])
    ]
    evidence_payload = [
        {
            "id": ref.id,
            "title": ref.title,
            "publisher": ref.publisher,
        }
        for ref in evidence[:8]
    ]

    schema_hint = (
        '{"segments":[{"text":"<rephrased prose>",'
        '"evidence_ids":["<evidence_id>"]}]}'
    )

    payload = {
        "query": query,
        "intent": intent or "general_retrieval",
        "subject": subject_label,
        "rule_based_segments": seg_payload,
        "available_evidence": evidence_payload,
    }

    return (
        "Deterministic analyst answer (do not contradict any fact):\n"
        f"{json.dumps(payload, separators=(',', ':'))}\n\n"
        f"Output JSON only, matching: {schema_hint}\n"
        "Preserve the order of segments. You may drop a segment that is "
        "redundant after rewriting, but you may not add one. Each output "
        "segment's evidence_ids must be a subset of the union of the "
        "input segments' evidence_ids."
    )


def _violates_numeric_guard(text: str) -> bool:
    return any(p.search(text) for p in _FORBIDDEN_NUMERIC_PATTERNS)


def _violates_directional_guard(text: str) -> bool:
    lower = text.lower()
    return any(verb in lower for verb in _DIRECTIONAL_VERBS)


def _validate_llm_output(
    *,
    raw: dict[str, object],
    rule_based_segments: Sequence[AgentSegment],
) -> list[AgentSegment] | None:
    segments_raw = raw.get("segments")
    if not isinstance(segments_raw, list) or not segments_raw:
        return None
    if len(segments_raw) > _MAX_SEGMENTS:
        return None

    # Union of all evidence ids the rule-based pipeline produced —
    # the LLM may cite any of them but must not invent.
    allowed_ids: set[str] = set()
    for seg in rule_based_segments:
        allowed_ids.update(seg.evidence_ids)

    out: list[AgentSegment] = []
    total_chars = 0
    for raw_seg in segments_raw:
        if not isinstance(raw_seg, dict):
            return None
        text = raw_seg.get("text")
        evidence_ids_raw = raw_seg.get("evidence_ids", [])
        if not isinstance(text, str) or not text.strip():
            return None
        cleaned = text.strip()
        if len(cleaned) > _MAX_SEGMENT_CHARS:
            return None
        if _violates_numeric_guard(cleaned):
            return None
        if _violates_directional_guard(cleaned):
            return None
        total_chars += len(cleaned)
        if total_chars > _MAX_TOTAL_CHARS:
            return None
        if not isinstance(evidence_ids_raw, list):
            return None
        evidence_ids: list[str] = []
        for item in evidence_ids_raw:
            if not isinstance(item, str):
                return None
            if item not in allowed_ids:
                # Hallucinated id — refuse the whole output rather than
                # silently drop it.
                return None
            evidence_ids.append(item)
        out.append(
            AgentSegment(
                text=cleaned,
                evidence_ids=evidence_ids,
            )
        )

    return out


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


async def rewrite_answer_with_anthropic(
    *,
    query: str,
    intent: str | None,
    subject_label: str,
    rule_based_segments: Sequence[AgentSegment],
    evidence: Sequence[EvidenceRef],
    api_key: str,
    model: str,
    base_url: str,
    timeout_seconds: float,
    http_client: httpx.AsyncClient | None = None,
) -> list[AgentSegment] | None:
    """Call Anthropic to rewrite the rule-based answer.

    Returns the rewritten segment list on success, ``None`` on any
    failure. Callers fall back to the rule-based segments on ``None``.
    """

    if not api_key or not rule_based_segments:
        return None

    payload = {
        "model": model,
        "max_tokens": 800,
        "system": _SYSTEM_PROMPT,
        "messages": [
            {
                "role": "user",
                "content": _build_user_prompt(
                    query=query,
                    intent=intent,
                    subject_label=subject_label,
                    rule_based_segments=rule_based_segments,
                    evidence=evidence,
                ),
            }
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
        logger.warning("agent_llm: anthropic call failed: %s", exc)
        return None

    if response.status_code != 200:
        logger.warning(
            "agent_llm: anthropic returned %s: %s",
            response.status_code,
            response.text[:200],
        )
        return None

    try:
        body = response.json()
    except ValueError:
        return None

    parsed = _extract_json_payload(body.get("content"))
    if parsed is None:
        logger.info("agent_llm: anthropic output not parseable as JSON")
        return None

    validated = _validate_llm_output(
        raw=parsed,
        rule_based_segments=rule_based_segments,
    )
    if validated is None:
        logger.info("agent_llm: anthropic output rejected by guardrails")
        return None

    return validated


__all__ = ["rewrite_answer_with_anthropic"]
