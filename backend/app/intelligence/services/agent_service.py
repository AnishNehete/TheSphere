"""Agent query service — grounded, place-first analyst reasoning.

Phase 12.3 introduced place-aware retrieval. Phase 18A.1 reorganises the
agent so prose composition consumes a typed
:class:`~app.intelligence.retrieval.evidence_bundle.EvidenceBundle`
produced by :class:`RetrievalOrchestrator`. The agent no longer talks to
the search service or place resolver directly — every fact in the answer
must come from the bundle, which is the single substrate for grounding.

The public surface (``AgentQueryService.ask`` returning
:class:`AgentResponse`) is unchanged. New 18A.1 fields on the response
(``time_context``, ``compare_summary``, ``workers_invoked``, ``caveats``)
expose the richer retrieval contract to the UI without breaking
existing callers.
"""

from __future__ import annotations

import logging
import time
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Iterable, Sequence

if TYPE_CHECKING:
    from app.intelligence.retrieval.orchestrator import RetrievalOrchestrator
    from app.intelligence.calibration import CalibrationService
    from app.intelligence.causal.model import CausalChainSet
    from app.intelligence.portfolio.schemas import PortfolioRecord
from app.intelligence.calibration.confidence import (
    ConfidenceInputs,
    calibrated_confidence,
)
from app.intelligence.calibration.reranker import (
    EvidenceCandidate,
    QueryContext,
    rerank,
)
from app.intelligence.calibration.schemas import QueryLogEntryCreate
from app.intelligence.geo.resolver import (
    PlaceResolver,
    place_resolver as default_place_resolver,
)
from app.intelligence.repositories.event_repository import EventRepository
from app.intelligence.retrieval.compare_planner import CompareTargetSpec
from app.intelligence.retrieval.evidence_bundle import (
    CompareTargetSnapshot,
    EvidenceBundle,
    TimeContext,
)
from app.intelligence.retrieval.query_planner import QueryPlan
from app.intelligence.retrieval.time_window import TimeWindow
from app.intelligence.schemas import (
    AgentCompareSummary,
    AgentCompareTarget,
    AgentFollowUp,
    AgentIntent,
    AgentResponse,
    AgentSegment,
    AgentTimeContext,
    CountrySignalSummary,
    EvidenceRef,
    MacroContext,
    PlaceScope,
    ResolvedEntity,
    SignalEvent,
)
from app.intelligence.services.search_service import SearchService


logger = logging.getLogger(__name__)


_SPECIFIC_PLACE_TYPES = ("city", "port", "chokepoint")


class AgentQueryService:
    """Grounded, deterministic, place-first answer composer."""

    def __init__(
        self,
        *,
        search: SearchService,
        repository: EventRepository,
        evidence_limit: int = 6,
        place_resolver: PlaceResolver | None = None,
        orchestrator: "RetrievalOrchestrator | None" = None,
        calibration_service: "CalibrationService | None" = None,
        anthropic_api_key: str | None = None,
        anthropic_model: str = "claude-haiku-4-5-20251001",
        anthropic_base_url: str = "https://api.anthropic.com",
        anthropic_timeout_seconds: float = 12.0,
    ) -> None:
        self._search = search
        self._repository = repository
        self._evidence_limit = evidence_limit
        self._place_resolver = place_resolver or default_place_resolver
        self._calibration = calibration_service
        self._anthropic_api_key = (anthropic_api_key or "").strip()
        self._anthropic_model = anthropic_model
        self._anthropic_base_url = anthropic_base_url
        self._anthropic_timeout_seconds = anthropic_timeout_seconds
        if orchestrator is None:
            # Lazy import to break the retrieval ↔ services cycle.
            from app.intelligence.retrieval.orchestrator import RetrievalOrchestrator

            orchestrator = RetrievalOrchestrator(
                repository=repository,
                search=search,
                place_resolver=self._place_resolver,
                evidence_limit=evidence_limit,
            )
        self._orchestrator = orchestrator

    async def ask(
        self,
        query: str,
        *,
        portfolio: "PortfolioRecord | None" = None,
    ) -> AgentResponse:
        cleaned = (query or "").strip()
        started = time.perf_counter()
        try:
            bundle = await self._orchestrator.run(cleaned)
            response = self._answer_from_bundle(cleaned, bundle)
        except Exception:
            # Even on failure we want a query-log row so calibration can
            # see the negative signal. Re-raise after logging so callers
            # see the original error.
            elapsed_ms = int((time.perf_counter() - started) * 1000)
            await self._log_failure(cleaned, elapsed_ms)
            raise

        # Phase 19E — optional bounded LLM rewrite of the rule-based
        # answer. Configured via INTELLIGENCE_ANTHROPIC_API_KEY. The
        # rewriter only paraphrases existing typed segments and may only
        # cite evidence_ids the deterministic pipeline already produced;
        # any guardrail violation is silently rejected and the rule-based
        # prose is kept verbatim. This is the ``retrieval_plus_llm`` mode
        # promised by AgentResponse.reasoning_mode.
        if self._anthropic_api_key and response.answer:
            from app.intelligence.services.agent_llm import (
                rewrite_answer_with_anthropic,
            )

            try:
                rewritten = await rewrite_answer_with_anthropic(
                    query=cleaned,
                    intent=response.intent,
                    subject_label=_subject(
                        bundle.primary_scope, bundle.resolved_entities
                    ),
                    rule_based_segments=response.answer,
                    evidence=response.evidence,
                    api_key=self._anthropic_api_key,
                    model=self._anthropic_model,
                    base_url=self._anthropic_base_url,
                    timeout_seconds=self._anthropic_timeout_seconds,
                )
            except Exception as exc:  # pragma: no cover - defensive
                logger.warning("agent_service llm rewrite failed: %s", exc)
                rewritten = None
            if rewritten is not None:
                response.answer = rewritten
                response.reasoning_mode = "retrieval_plus_llm"

        # Phase 19B — optional portfolio impact linkage. The builder is
        # pure and deterministic; it returns ``None`` for missing /
        # empty / no-match cases so the response shape stays stable.
        if portfolio is not None and response.causal_chains is not None:
            from app.intelligence.causal.portfolio_impact import (
                build_portfolio_impact,
            )

            response.portfolio_impact = build_portfolio_impact(
                response.causal_chains,
                portfolio,
                now=response.generated_at,
            )

        elapsed_ms = int((time.perf_counter() - started) * 1000)
        await self._log_success(cleaned, bundle, response, elapsed_ms)
        return response

    async def _log_success(
        self,
        cleaned_query: str,
        bundle: EvidenceBundle,
        response: AgentResponse,
        elapsed_ms: int,
    ) -> None:
        if self._calibration is None:
            return
        top_score = 0.0
        if bundle.primary_events:
            top_score = float(bundle.primary_events[0].severity_score or 0.0)
        try:
            await self._calibration.log(
                QueryLogEntryCreate(
                    query_text=cleaned_query,
                    intent=response.intent or "general_retrieval",
                    resolved_entity_ids=[
                        f"{entity.kind}:{entity.id}"
                        for entity in response.resolved_entities
                        if entity.id
                    ],
                    evidence_ids=list(response.related_events),
                    time_window_kind=bundle.plan.time.kind,
                    compare_requested=bool(bundle.plan.compare.requested),
                    confidence_score=float(response.confidence),
                    top_evidence_score=top_score,
                    result_count=len(bundle.primary_events),
                    latency_ms=elapsed_ms,
                )
            )
        except Exception as exc:  # pragma: no cover - defensive
            logger.warning("agent_service calibration log failed: %s", exc)

    def _apply_reranker(
        self,
        events: Sequence[SignalEvent],
        scope: PlaceScope,
        now: datetime,
    ) -> list[SignalEvent]:
        if not events:
            return []
        weights = (
            self._calibration.weights_loader.current()
            if self._calibration is not None
            else None
        )
        candidates: list[EvidenceCandidate] = []
        scope_country = (scope.country_code or "").upper()
        for event in events:
            event_country = (event.place.country_code or "").upper()
            geo_match = 0.0
            if scope_country and event_country == scope_country:
                geo_match = 1.0
            elif scope.fallback_level != "none" and event_country:
                geo_match = 0.4
            base = (
                max(
                    (s.reliability for s in event.sources),
                    default=event.confidence,
                )
                if event.sources
                else event.confidence
            )
            publisher = (
                event.sources[0].publisher
                if event.sources and event.sources[0].publisher
                else None
            )
            candidates.append(
                EvidenceCandidate(
                    event_id=event.id,
                    base_score=float(base),
                    severity_score=float(event.severity_score),
                    location_match_score=geo_match,
                    semantic_score=float(event.confidence),
                    timestamp=event.source_timestamp or event.ingested_at,
                    publisher=publisher,
                    event_type=event.type,
                )
            )
        result = rerank(
            candidates,
            QueryContext(now=now, has_place_scope=scope.fallback_level != "none"),
            weights=weights,
        )
        ordered_ids = result.event_ids()
        if not ordered_ids:
            return list(events)
        index = {event.id: event for event in events}
        return [index[eid] for eid in ordered_ids if eid in index]

    async def _log_failure(self, cleaned_query: str, elapsed_ms: int) -> None:
        if self._calibration is None:
            return
        try:
            await self._calibration.log(
                QueryLogEntryCreate(
                    query_text=cleaned_query,
                    intent="error",
                    resolved_entity_ids=[],
                    evidence_ids=[],
                    time_window_kind="live",
                    compare_requested=False,
                    confidence_score=0.0,
                    top_evidence_score=0.0,
                    result_count=0,
                    latency_ms=elapsed_ms,
                )
            )
        except Exception as exc:  # pragma: no cover - defensive
            logger.warning("agent_service calibration log (failure) failed: %s", exc)

    # ---- prose composition over the bundle ------------------------------

    def _answer_from_bundle(
        self, cleaned_query: str, bundle: EvidenceBundle
    ) -> AgentResponse:
        plan = bundle.plan
        scope = bundle.primary_scope
        country_summary = bundle.country_summary
        now = bundle.generated_at

        # Phase 18B — apply the deterministic reranker over the bundle's
        # primary events. This is order-only: the reranker never injects
        # facts, only reweights what the orchestrator already grounded.
        events = self._apply_reranker(bundle.primary_events, scope, now)

        interpreted = _interpret(
            cleaned_query, plan.intent, bundle.resolved_entities, scope, plan.time
        )
        subject_label = _subject(scope, bundle.resolved_entities)

        answer_segments = _compose_answer(
            intent=plan.intent,
            subject_label=subject_label,
            scope=scope,
            events=events,
            country_summary=country_summary,
            now=now,
        )

        # Time framing — surface a calm caveat when the window is
        # historical / no-match so the prose never lies about freshness.
        time_segment = _time_caveat_segment(bundle.time_context, subject_label)
        if time_segment is not None:
            answer_segments.insert(0, time_segment)

        # Compare framing — explicit headline, partial-resolution disclosure.
        compare_summary_obj = _build_compare_summary(bundle)
        compare_segment = _compare_segment(compare_summary_obj, bundle)
        if compare_segment is not None:
            answer_segments.append(compare_segment)

        # Phase 18D — deterministic causal chain layer. The builder reads
        # only the bundle; agent prose may surface the top driver but
        # cannot invent links. Emits ``None`` when nothing matches.
        # Lazy import to break the services <-> causal cycle.
        from app.intelligence.causal.builder import build_chain_set

        causal_chain_set = build_chain_set(bundle, now=now)
        causal_segments = _causal_segments(causal_chain_set)
        if causal_segments:
            answer_segments.extend(causal_segments)

        evidence_refs = _to_evidence_refs(events[: self._evidence_limit])
        follow_ups = _compose_follow_ups(
            intent=plan.intent,
            entities=bundle.resolved_entities,
            scope=scope,
            time_window=plan.time,
        )
        related_countries = _related_countries(events, exclude=scope.country_code)
        related_events = [event.id for event in events[: self._evidence_limit]]

        weights = (
            self._calibration.weights_loader.current()
            if self._calibration is not None
            else None
        )
        confidence = _compose_confidence(
            events=events,
            has_country_summary=country_summary is not None,
            answer_segments=answer_segments,
            scope=scope,
            bundle=bundle,
            now=now,
            weights=weights,
        )

        return AgentResponse(
            query=cleaned_query,
            interpreted_query=interpreted,
            intent=plan.intent,
            reasoning_mode="rule_based",
            resolved_entities=list(bundle.resolved_entities),
            answer=answer_segments,
            evidence=evidence_refs,
            follow_ups=follow_ups,
            related_countries=related_countries,
            related_events=related_events,
            confidence=round(confidence, 3),
            generated_at=now,
            resolved_place=scope if scope.fallback_level != "none" else None,
            fallback_notice=bundle.fallback_notice,
            scope_used=_normalize_scope_used(bundle.scope_used, scope),
            scope_confidence=round(scope.confidence, 3),
            place_dependencies=list(bundle.place_dependencies),
            macro_context=bundle.macro_context,
            time_context=_to_agent_time_context(bundle.time_context),
            compare_summary=compare_summary_obj,
            workers_invoked=list(bundle.workers_invoked),
            caveats=list(bundle.caveats),
            causal_chains=causal_chain_set if not causal_chain_set.is_empty() else None,
        )


# ---- prose helpers ---------------------------------------------------------


def _interpret(
    text: str,
    intent: AgentIntent,
    entities: Sequence[ResolvedEntity],
    scope: PlaceScope,
    window: TimeWindow,
) -> str:
    if scope.fallback_level != "none" and scope.name:
        subject = scope.name
    else:
        country = next((e.name for e in entities if e.kind == "country"), None)
        ticker = next((e.name for e in entities if e.kind == "ticker"), None)
        commodity = next(
            (e.name for e in entities if e.kind == "commodity"), None
        )
        fx = next((e.name for e in entities if e.kind == "fx_pair"), None)
        # Phase 19C.6 — commodity added to the subject ladder so queries
        # like "why is oil up" interpret as "Crude Oil" instead of
        # collapsing to "the current intelligence corpus".
        subject = (
            country
            or ticker
            or commodity
            or fx
            or "the current intelligence corpus"
        )

    suffix = "" if window.is_live else f" ({window.label})"
    if intent == "why_elevated":
        return f"Why is {subject} on elevated watch right now?{suffix}"
    if intent == "what_changed":
        return f"What has changed for {subject}{suffix or ' in the last 24 hours'}?"
    if intent == "driving_factor":
        return f"What is driving activity around {subject}?{suffix}"
    if intent == "downstream_impact":
        return f"What are the likely downstream effects of {subject}?{suffix}"
    if intent == "status_check":
        return f"What is the current status of {subject}?{suffix}"
    return text or f"Retrieve live intelligence on {subject}.{suffix}"


def _compose_answer(
    *,
    intent: AgentIntent,
    subject_label: str,
    scope: PlaceScope,
    events: Sequence[SignalEvent],
    country_summary: CountrySignalSummary | None,
    now: datetime,
) -> list[AgentSegment]:
    if not events and not country_summary:
        return [
            AgentSegment(
                text=(
                    f"No grounded evidence is available for {subject_label} "
                    "in the current corpus. Broaden the scope or try a "
                    "specific country, topic, or ticker."
                ),
                evidence_ids=[],
            )
        ]

    if intent == "why_elevated":
        segments = _answer_why_elevated(subject_label, country_summary, events)
    elif intent == "what_changed":
        segments = _answer_what_changed(subject_label, events, country_summary, now)
    elif intent == "driving_factor":
        segments = _answer_driving_factor(subject_label, events, country_summary)
    elif intent == "downstream_impact":
        segments = _answer_downstream_impact(subject_label, events, scope.country_code)
    elif intent == "status_check":
        segments = _answer_status(subject_label, country_summary, events)
    else:
        segments = _answer_general(subject_label, events)

    if not segments:
        segments.append(
            AgentSegment(
                text=f"Retrieved {len(events)} relevant signal(s) for {subject_label}.",
                evidence_ids=[e.id for e in events],
            )
        )
    return segments


def _answer_why_elevated(
    subject: str,
    summary: CountrySignalSummary | None,
    events: Sequence[SignalEvent],
) -> list[AgentSegment]:
    segments: list[AgentSegment] = []
    if summary is not None:
        score_pct = int(round(summary.watch_score * 100))
        segments.append(
            AgentSegment(
                text=(
                    f"{subject} is on {summary.watch_label} watch with a composite score of "
                    f"{score_pct} (delta {summary.watch_delta:+.2f})."
                ),
                evidence_ids=[sig.id for sig in summary.top_signals[:3]],
            )
        )
        if summary.top_signals:
            driver = summary.top_signals[0]
            segments.append(
                AgentSegment(
                    text=(
                        f"The dominant driver is {driver.type} — \"{driver.title}\" "
                        f"({_fmt_relative(driver.source_timestamp)})."
                    ),
                    evidence_ids=[driver.id],
                )
            )
    top = _rank_elevated(events)[:3]
    if top:
        bullet = "; ".join(_short_title(e) for e in top)
        segments.append(
            AgentSegment(
                text=f"Contributing evidence: {bullet}.",
                evidence_ids=[e.id for e in top],
            )
        )
    return segments


def _answer_what_changed(
    subject: str,
    events: Sequence[SignalEvent],
    summary: CountrySignalSummary | None,
    now: datetime,
) -> list[AgentSegment]:
    recent = [e for e in events if _age_hours(e, now) <= 24.0]
    if not recent:
        return [
            AgentSegment(
                text=(
                    f"No new signals have landed for {subject} in the last 24 hours. "
                    "The current posture reflects prior-cycle evidence."
                ),
                evidence_ids=[e.id for e in events[:3]],
            )
        ]
    top = recent[:3]
    titles = "; ".join(_short_title(e) for e in top)
    segments = [
        AgentSegment(
            text=(
                f"In the last 24h {len(recent)} signal(s) landed for {subject}: {titles}."
            ),
            evidence_ids=[e.id for e in top],
        )
    ]
    if summary and summary.watch_delta != 0:
        segments.append(
            AgentSegment(
                text=(
                    f"Watch score moved {summary.watch_delta:+.2f} versus the prior snapshot."
                ),
                evidence_ids=[sig.id for sig in summary.top_signals[:2]],
            )
        )
    return segments


def _answer_driving_factor(
    subject: str,
    events: Sequence[SignalEvent],
    summary: CountrySignalSummary | None,
) -> list[AgentSegment]:
    if not events:
        return []
    by_type: dict[str, list[SignalEvent]] = {}
    for event in events:
        by_type.setdefault(event.type, []).append(event)
    top_type = max(by_type.items(), key=lambda item: len(item[1]))[0]
    cluster = by_type[top_type][:3]
    titles = "; ".join(_short_title(e) for e in cluster)
    segments: list[AgentSegment] = [
        AgentSegment(
            text=(
                f"Activity around {subject} is being driven by {top_type} signals: {titles}."
            ),
            evidence_ids=[e.id for e in cluster],
        )
    ]
    if summary is not None and summary.top_signals:
        headline = summary.top_signals[0]
        segments.append(
            AgentSegment(
                text=(
                    f"The strongest single contributor is \"{headline.title}\" "
                    f"(confidence {headline.confidence:.0%})."
                ),
                evidence_ids=[headline.id],
            )
        )
    return segments


def _answer_downstream_impact(
    subject: str,
    events: Sequence[SignalEvent],
    resolved_country: str | None,
) -> list[AgentSegment]:
    if not events:
        return []
    top = _rank_elevated(events)[:2]
    paths = _rule_based_impact_hints(top, resolved_country)
    citation_ids = [e.id for e in top]
    if paths:
        joined = "; ".join(paths)
        return [
            AgentSegment(
                text=(
                    f"Likely downstream exposure from {subject} (confidence-weighted): {joined}."
                ),
                evidence_ids=citation_ids,
            ),
            AgentSegment(
                text=(
                    "Treat these as ranked exposure paths, not proven causation — "
                    "inspect the dependency view for per-edge rationale."
                ),
                evidence_ids=[],
            ),
        ]
    return [
        AgentSegment(
            text=(
                f"No strong downstream template matched the top evidence for {subject}. "
                "Re-scope the query to a specific domain (weather, conflict, FX, supply)."
            ),
            evidence_ids=citation_ids,
        )
    ]


def _answer_status(
    subject: str,
    summary: CountrySignalSummary | None,
    events: Sequence[SignalEvent],
) -> list[AgentSegment]:
    if summary is not None:
        return [
            AgentSegment(
                text=(
                    f"{subject} sits at {summary.watch_label} watch "
                    f"({int(round(summary.watch_score * 100))}/100, confidence "
                    f"{int(round(summary.confidence * 100))}%)."
                ),
                evidence_ids=[sig.id for sig in summary.top_signals[:3]],
            )
        ]
    if events:
        top = events[0]
        return [
            AgentSegment(
                text=(
                    f"Most recent relevant signal for {subject}: \"{top.title}\" "
                    f"({top.severity}, {_fmt_relative(top.source_timestamp)})."
                ),
                evidence_ids=[top.id],
            )
        ]
    return []


def _answer_general(subject: str, events: Sequence[SignalEvent]) -> list[AgentSegment]:
    if not events:
        return []
    top = events[:3]
    titles = "; ".join(_short_title(e) for e in top)
    return [
        AgentSegment(
            text=f"Top live signals for {subject}: {titles}.",
            evidence_ids=[e.id for e in top],
        )
    ]


# ---- 18A.1 segments --------------------------------------------------------


def _time_caveat_segment(
    time_context: TimeContext | None, subject_label: str
) -> AgentSegment | None:
    if time_context is None or time_context.is_live:
        return None
    if time_context.coverage == "no_match":
        return AgentSegment(
            text=(
                f"No evidence for {subject_label} landed inside the "
                f"{time_context.window.label} window — the answer below "
                "reflects the broader corpus."
            ),
            evidence_ids=[],
        )
    if time_context.coverage == "as_of":
        return AgentSegment(
            text=(
                f"Showing a point-in-time snapshot {time_context.window.label}."
            ),
            evidence_ids=[],
        )
    if time_context.coverage == "delta":
        return AgentSegment(
            text=(
                f"Restricted to {time_context.window.label} — "
                f"{time_context.matched_event_count} signal(s) inside the window."
            ),
            evidence_ids=[],
        )
    return AgentSegment(
        text=(
            f"Showing signals from {time_context.window.label}."
        ),
        evidence_ids=[],
    )


def _build_compare_summary(bundle: EvidenceBundle) -> AgentCompareSummary | None:
    plan = bundle.plan
    if not plan.compare.requested:
        return None
    targets: list[AgentCompareTarget] = []
    for snap in bundle.compare_snapshots:
        targets.append(_to_agent_compare_target(snap))
    collapsed = bundle.compare_collapsed
    headline = _compare_headline(targets) if not collapsed else None

    # Phase 19C.6 — time-window compare ("oil yesterday vs today") routes
    # through ``build_compare_delta`` instead of leg-snapshots. Without
    # this projection the API would return an empty compare card and the
    # frontend would render the "Compare resolution was partial" caveat,
    # which is misleading: both windows DID resolve, just along the time
    # axis. Synthesize two AgentCompareTargets from the delta so the UI
    # has something honest to render.
    if bundle.compare_delta is not None and (not targets or collapsed):
        delta = bundle.compare_delta
        entity = delta.entity
        left_target = AgentCompareTarget(
            raw=f"{entity.label} ({delta.left_window.label})",
            kind=entity.kind,
            canonical_id=entity.canonical_id,
            label=f"{entity.label} · {delta.left_window.label}",
            country_code=entity.country_code,
            confidence=round(entity.confidence, 3),
            resolution=entity.resolution,
            event_ids=[e.id for e in delta.left_events[:6]],
            counts_by_category={},
            severity_distribution={},
            freshness_minutes=None,
            watch_score=None,
            watch_label=None,
        )
        right_target = AgentCompareTarget(
            raw=f"{entity.label} ({delta.right_window.label})",
            kind=entity.kind,
            canonical_id=entity.canonical_id,
            label=f"{entity.label} · {delta.right_window.label}",
            country_code=entity.country_code,
            confidence=round(entity.confidence, 3),
            resolution=entity.resolution,
            event_ids=[e.id for e in delta.right_events[:6]],
            counts_by_category={},
            severity_distribution={},
            freshness_minutes=None,
            watch_score=None,
            watch_label=None,
        )
        targets = [left_target, right_target]
        collapsed = False
        direction = (
            "rose"
            if delta.intensity_change > 0
            else "eased" if delta.intensity_change < 0 else "held flat"
        )
        headline = (
            f"{entity.label}: intensity {direction} {abs(delta.intensity_change):.2f} "
            f"between {delta.left_window.label} and {delta.right_window.label} "
            f"(+{delta.added}, −{delta.removed})."
        )

    return AgentCompareSummary(
        requested=True,
        collapsed=collapsed,
        mode=plan.compare.mode,
        raw_phrase=plan.compare.raw_phrase,
        targets=targets,
        headline=headline,
    )


def _to_agent_compare_target(snap: CompareTargetSnapshot) -> AgentCompareTarget:
    watch_score = None
    watch_label = None
    if snap.summary is not None:
        watch_score = round(float(snap.summary.watch_score), 3)
        watch_label = snap.summary.watch_label
    spec: CompareTargetSpec = snap.spec
    return AgentCompareTarget(
        raw=spec.raw,
        kind=spec.kind,
        canonical_id=spec.canonical_id,
        label=spec.label,
        country_code=spec.country_code,
        confidence=round(spec.confidence, 3),
        resolution=spec.resolution,
        event_ids=[event.id for event in snap.events],
        counts_by_category=dict(snap.counts_by_category),
        severity_distribution=dict(snap.severity_distribution),
        freshness_minutes=snap.freshness_minutes,
        watch_score=watch_score,
        watch_label=watch_label,
    )


def _compare_headline(targets: Sequence[AgentCompareTarget]) -> str | None:
    resolved = [t for t in targets if t.resolution != "none"]
    if len(resolved) < 2:
        return None
    left, right = resolved[0], resolved[1]
    if left.watch_score is not None and right.watch_score is not None:
        delta = right.watch_score - left.watch_score
        direction = "higher" if delta > 0 else "lower" if delta < 0 else "matching"
        return (
            f"{right.label} sits {abs(delta):.2f} points {direction} than "
            f"{left.label} on composite watch score."
        )
    return f"{left.label} vs {right.label}: compare recent evidence and severity mix."


def _compare_segment(
    summary: AgentCompareSummary | None, bundle: EvidenceBundle
) -> AgentSegment | None:
    if summary is None or not summary.requested:
        return None
    if summary.collapsed:
        partial = next(
            (t for t in summary.targets if t.resolution != "none"),
            None,
        )
        partial_label = partial.label if partial else "the primary subject"
        return AgentSegment(
            text=(
                "Compare resolution was partial — only one leg matched. "
                f"Showing {partial_label} alone."
            ),
            evidence_ids=[],
        )
    headline = summary.headline or "Compare across the resolved targets."
    cited: list[str] = []
    for target in summary.targets:
        cited.extend(target.event_ids[:2])
    return AgentSegment(
        text=headline,
        evidence_ids=cited[:6],
    )


# ---- 18D causal chain prose ------------------------------------------------


def _causal_segments(chain_set: "CausalChainSet") -> list[AgentSegment]:
    """Project the deterministic causal chain set into agent prose.

    The chain *facts* are owned by the builder; this helper only
    composes the surface text. We surface up to three lines:

    * Top driver — the highest-scoring chain.
    * Transmission path — the from→to mechanism walk for that chain.
    * Caveat — the first set-level caveat, when present.
    """

    if chain_set.is_empty() or not chain_set.top_drivers:
        return []
    segments: list[AgentSegment] = []
    top = chain_set.top_drivers[0]
    direction_word = {
        "up": "elevated",
        "down": "weighing on",
        "mixed": "moving",
        "stable": "stable across",
        "unknown": "affecting",
    }.get(top.direction, "affecting")
    segments.append(
        AgentSegment(
            text=(
                f"Top driver: {top.title} — {direction_word} the {top.domain} "
                f"channel (confidence {int(round(top.confidence * 100))}%)."
            ),
            evidence_ids=list(top.evidence_ids),
        )
    )
    primary_chain = chain_set.chains[0]
    if primary_chain.nodes and len(primary_chain.nodes) >= 3:
        path = " → ".join(node.label for node in primary_chain.nodes[:3])
        segments.append(
            AgentSegment(
                text=f"Transmission path: {path}.",
                evidence_ids=list(primary_chain.source_evidence_ids),
            )
        )
    if chain_set.caveats:
        segments.append(
            AgentSegment(
                text=f"Caveat: {chain_set.caveats[0]}",
                evidence_ids=[],
            )
        )
    return segments


# ---- follow-ups ------------------------------------------------------------


def _compose_follow_ups(
    *,
    intent: AgentIntent,
    entities: Sequence[ResolvedEntity],
    scope: PlaceScope,
    time_window: TimeWindow,
) -> list[AgentFollowUp]:
    if scope.fallback_level != "none" and scope.name:
        name = scope.name
    else:
        country = next((e for e in entities if e.kind == "country"), None)
        ticker = next((e for e in entities if e.kind == "ticker"), None)
        name = (
            country.name
            if country
            else (ticker.name if ticker else "the current scope")
        )

    follow_ups: list[AgentFollowUp] = []
    if intent != "what_changed":
        follow_ups.append(
            AgentFollowUp(
                label=f"What changed for {name} in the last 24h?",
                query=f"What changed in {name} in the last 24 hours?",
            )
        )
    if intent != "why_elevated":
        follow_ups.append(
            AgentFollowUp(
                label=f"Why is {name} elevated?",
                query=f"Why is {name} on elevated watch?",
            )
        )
    if intent != "downstream_impact":
        follow_ups.append(
            AgentFollowUp(
                label=f"What could {name} affect next?",
                query=f"What downstream effects could {name} trigger?",
            )
        )
    if (
        scope.type in _SPECIFIC_PLACE_TYPES
        and scope.country_name
        and scope.country_name != name
    ):
        follow_ups.append(
            AgentFollowUp(
                label=f"Zoom out to {scope.country_name}",
                query=f"What is happening in {scope.country_name}?",
            )
        )
    return follow_ups[:4]


def _related_countries(
    events: Iterable[SignalEvent], *, exclude: str | None
) -> list[str]:
    codes: list[str] = []
    seen: set[str] = set()
    for event in events:
        code = event.place.country_code
        if not code or code == exclude or code in seen:
            continue
        seen.add(code)
        codes.append(code)
        if len(codes) >= 4:
            break
    return codes


# ---- scope helpers ---------------------------------------------------------


def _normalize_scope_used(raw: str, scope: PlaceScope) -> str:
    if raw in ("exact_place", "country", "region", "global"):
        return raw
    if scope.fallback_level == "none":
        return "global"
    if scope.fallback_level == "parent_region":
        return "region"
    if scope.fallback_level == "parent_country":
        return "country"
    return "exact_place"


def _to_agent_time_context(
    time_context: TimeContext | None,
) -> AgentTimeContext | None:
    if time_context is None:
        return None
    return AgentTimeContext(
        kind=time_context.window.kind,
        coverage=time_context.coverage,
        label=time_context.window.label,
        answer_mode_label=time_context.answer_mode_label,
        since=time_context.window.since,
        until=time_context.window.until,
        matched_event_count=time_context.matched_event_count,
        is_historical=time_context.window.is_historical,
    )


# ---- low-level helpers -----------------------------------------------------


def _subject(scope: PlaceScope, entities: Sequence[ResolvedEntity]) -> str:
    if scope.fallback_level != "none" and scope.name:
        return scope.name
    for entity in entities:
        if entity.kind in ("country", "city", "port", "chokepoint", "region", "place"):
            return entity.name
    for entity in entities:
        if entity.kind in ("ticker", "fx_pair"):
            return entity.name
    return "the current scope"


def _rank_elevated(events: Iterable[SignalEvent]) -> list[SignalEvent]:
    sorted_events = sorted(
        events,
        key=lambda e: (e.severity_score, -_age_hours(e, datetime.now(timezone.utc))),
        reverse=True,
    )
    return sorted_events


def _short_title(event: SignalEvent) -> str:
    title = event.title.strip() or event.type
    if len(title) > 90:
        title = title[:87].rstrip() + "…"
    return f"\"{title}\""


def _fmt_relative(ts: datetime | None) -> str:
    if ts is None:
        return "time unknown"
    age = (datetime.now(timezone.utc) - ts).total_seconds()
    if age < 0:
        age = 0.0
    if age < 60:
        return f"{int(age)}s ago"
    if age < 3600:
        return f"{int(age / 60)}m ago"
    if age < 86400:
        return f"{int(age / 3600)}h ago"
    return f"{int(age / 86400)}d ago"


def _age_hours(event: SignalEvent, now: datetime) -> float:
    reference = event.source_timestamp or event.ingested_at
    if reference is None:
        return 9999.0
    return max(0.0, (now - reference).total_seconds() / 3600.0)


def _rule_based_impact_hints(
    events: Sequence[SignalEvent], country: str | None
) -> list[str]:
    hints: list[str] = []
    for event in events:
        hint = _impact_hint_for(event, country)
        if hint and hint not in hints:
            hints.append(hint)
    return hints


def _impact_hint_for(event: SignalEvent, country: str | None) -> str | None:
    sub = (event.sub_type or "").lower()
    title = event.title.lower()
    if event.type == "weather":
        if sub == "seismic" or "earthquake" in title:
            return "seismic → ports/logistics → supply-chain disruption"
        if any(w in title for w in ("storm", "typhoon", "hurricane")):
            return "severe weather → flight operations → tourism & inbound logistics"
        return "weather → flights & logistics"
    if event.type == "conflict":
        return "conflict → airspace/shipping → oil → FX (safe haven flows)"
    if event.type == "news":
        if any(w in title for w in ("port", "shipping", "strike", "closure")):
            return "shipping disruption → commodities → exporter equities"
        return "news shock → sentiment → equities"
    if event.type == "currency":
        return "FX move → importer/exporter P&L → equities"
    if event.type == "stocks":
        return "equity move → portfolio vol → hedge surface"
    if event.type == "commodities":
        return "commodity move → producer/consumer margins → equities"
    return None


def _to_evidence_refs(events: Sequence[SignalEvent]) -> list[EvidenceRef]:
    refs: list[EvidenceRef] = []
    for event in events:
        source = event.sources[0] if event.sources else None
        refs.append(
            EvidenceRef(
                id=event.id,
                title=event.title,
                type=event.type,
                severity=event.severity,
                severity_score=event.severity_score,
                confidence=event.confidence,
                source_timestamp=event.source_timestamp,
                country_code=event.place.country_code,
                country_name=event.place.country_name,
                publisher=source.publisher if source else None,
                url=source.url if source else None,
            )
        )
    return refs


def _compose_confidence(
    *,
    events: Sequence[SignalEvent],
    has_country_summary: bool,
    answer_segments: Sequence[AgentSegment],
    scope: PlaceScope,
    bundle: EvidenceBundle,
    now: datetime,
    weights=None,
) -> float:
    """Phase 18B — calibrated confidence with explicit drivers.

    The five drivers are computed in :class:`ConfidenceInputs` so the
    confidence number is reproducible from the bundle alone (the
    primary aim of the calibration phase).  Scope-fallback and
    compare-collapse penalties are applied *after* the calibrated score
    so the calibration band remains stable; the penalties act as honest
    floors rather than baked-in heuristics.
    """

    if not events and not has_country_summary:
        return 0.1
    half_life = (
        weights.recency_half_life_hours if weights is not None else 6.0
    )
    inputs = ConfidenceInputs.from_events(
        events,
        now=now,
        scope_confidence=float(scope.confidence),
        recency_half_life_hours=half_life,
    )
    calibration = calibrated_confidence(inputs, weights=weights)
    base = calibration.calibrated_score

    cited = sum(1 for seg in answer_segments if seg.evidence_ids)
    total = max(1, len(answer_segments))
    citation_lift = 0.1 * (cited / total)
    base = min(0.95, base + citation_lift)

    if scope.fallback_level == "parent_region":
        base *= 0.55
    elif scope.fallback_level == "parent_country":
        base *= 0.85
    if bundle.compare_collapsed:
        base *= 0.85
    if bundle.time_context is not None and bundle.time_context.coverage == "no_match":
        base *= 0.7
    return max(0.0, min(base, 0.95))


__all__ = ["AgentQueryService"]
