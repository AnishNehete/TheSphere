"use client";

import { useEffect, useMemo } from "react";

import { queryAgent } from "@/lib/intelligence/client";
import type {
  AgentResponse,
  DependencyPath,
  EvidenceRef,
  MacroContext,
  PlaceFallbackLevel,
  PlaceScope,
  ResolvedEntity,
  ScopeUsed,
  SignalEvent,
} from "@/lib/intelligence/types";
import { IntelligenceApiError } from "@/lib/intelligence/types";
import { useOverlayStore } from "@/store/useOverlayStore";

import {
  SEVERITY_LABEL,
  categoryLabel,
  formatConfidence,
  formatRelative,
  formatUtc,
} from "./formatters";
import { OverlayPanel } from "./OverlayPanel";
import { PanelReveal } from "./motion/PanelReveal";
import {
  MetadataStrip,
  ReplayBadge,
  type MetadataField,
} from "./grammar/SignalGrammar";
import {
  CausalChainCard,
  CaveatList,
  CompareSummaryCard,
  PortfolioImpactCard,
  ResolvedEntitiesBadges,
  TimeContextChip,
} from "./answer";

// Phase 12A — QueryPanel is the agent surface.
// Phase 12.3 layered place intelligence on top: the panel now surfaces the
// resolved place (city / port / chokepoint / region), an explicit fallback
// notice when the resolver had to climb the hierarchy, and macro / dependency
// context when the resolution is strong enough to justify it.
// It calls /api/intelligence/query/agent, renders the grounded answer with
// inline evidence citations, and offers follow-up pivots. Clicking a citation
// or an evidence row opens the EventPanel; clicking a resolved country opens
// CountryPanel.

const INTENT_LABEL: Record<AgentResponse["intent"], string> = {
  why_elevated: "Why is it elevated?",
  what_changed: "What changed?",
  driving_factor: "What's driving this?",
  downstream_impact: "Downstream impact",
  status_check: "Status",
  general_retrieval: "Retrieval",
};

const SCOPE_LABEL: Record<ScopeUsed, string> = {
  exact_place: "Exact place",
  country: "Country scope",
  region: "Region scope",
  global: "Global scope",
};

const PLACE_TYPE_LABEL: Record<string, string> = {
  city: "City",
  port: "Port",
  chokepoint: "Chokepoint",
  country: "Country",
  region: "Region",
  place: "Place",
};

const FALLBACK_TONE: Record<PlaceFallbackLevel, "ok" | "soft" | "warn"> = {
  exact: "ok",
  alias_substring: "ok",
  nearby_city: "ok",
  parent_country: "soft",
  parent_region: "warn",
  none: "warn",
};

function formatCommodityName(value: string | null | undefined): string {
  if (!value) return "";
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function QueryPanel() {
  const query = useOverlayStore((s) => s.queryText);
  const agentResponse = useOverlayStore((s) => s.agentResponse);
  const isLoading = useOverlayStore((s) => s.isLoading);
  const error = useOverlayStore((s) => s.error);
  const setAgentResponse = useOverlayStore((s) => s.setAgentResponse);
  const setError = useOverlayStore((s) => s.setError);
  const setLoading = useOverlayStore((s) => s.setLoading);
  const openEvent = useOverlayStore((s) => s.openEvent);
  const openCountry = useOverlayStore((s) => s.openCountry);
  const openQuery = useOverlayStore((s) => s.openQuery);
  const selectedPortfolioId = useOverlayStore((s) => s.selectedPortfolioId);

  useEffect(() => {
    if (!query.trim()) return;
    if (agentResponse && agentResponse.query === query) return;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    queryAgent(query, {
      signal: controller.signal,
      portfolioId: selectedPortfolioId,
    })
      .then((response) => setAgentResponse(response))
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        const message =
          err instanceof IntelligenceApiError
            ? "The agent is temporarily unavailable."
            : err instanceof Error
              ? err.message
              : "Agent query failed.";
        setError(message);
      });
    return () => controller.abort();
  }, [
    query,
    agentResponse,
    setAgentResponse,
    setError,
    setLoading,
    selectedPortfolioId,
  ]);

  const evidenceById = useMemo(() => {
    const map = new Map<string, EvidenceRef>();
    if (agentResponse) {
      for (const item of agentResponse.evidence) map.set(item.id, item);
    }
    return map;
  }, [agentResponse]);

  const asOf = useOverlayStore((s) => s.portfolioAsOf);
  const metaFields: MetadataField[] | null = agentResponse
    ? [
        {
          key: "scope",
          label: "Intent",
          value: INTENT_LABEL[agentResponse.intent],
        },
        {
          key: "confidence",
          label: "Confidence",
          value: formatConfidence(agentResponse.confidence),
        },
        {
          key: "freshness",
          label: "Generated",
          value: (
            <span title={formatUtc((agentResponse as { generated_at?: string }).generated_at ?? null)}>
              {formatRelative((agentResponse as { generated_at?: string }).generated_at ?? null)}
            </span>
          ),
        },
        {
          key: "status",
          label: "Evidence",
          value: `${(agentResponse.evidence ?? []).length} items`,
        },
      ]
    : null;

  return (
    <OverlayPanel
      eyebrow="Agent"
      title={query || "Search intelligence"}
      subtitle={
        agentResponse
          ? `${INTENT_LABEL[agentResponse.intent]} · ${formatConfidence(agentResponse.confidence)} confidence`
          : isLoading
            ? "Resolving query…"
            : undefined
      }
    >
      {isLoading && !agentResponse ? <QuerySkeleton /> : null}

      {error && !agentResponse ? (
        <div className="ws-empty">
          <span className="ws-eyebrow">Temporarily unavailable</span>
          <p>{error}</p>
        </div>
      ) : null}

      {agentResponse ? (
        <PanelReveal testId="query-panel-reveal">
          {metaFields ? <MetadataStrip fields={metaFields} testId="query-grammar-meta" /> : null}

          <section
            className="ws-section ws-grammar-trend-row"
            data-testid="query-grammar-replay"
            data-grammar-section="trend"
          >
            <div className="ws-grammar-trend-row__head">
              <ReplayBadge asOf={asOf} testId="query-panel-replay-badge" />
              <span className="ws-muted">
                {asOf
                  ? "Agent answer pinned to this as-of cursor."
                  : "Agent answer reflects live retrieval."}
              </span>
            </div>
          </section>

          {/* 1. Direct answer — interpreted query + grounded answer at the top
               so the analyst gets the headline before any context surface. */}
          <section className="ws-section">
            <p className="ws-eyebrow">Interpreted query</p>
            <p className="ws-section__body">{agentResponse.interpreted_query}</p>
          </section>

          <ResolvedEntitiesBadges response={agentResponse} />

          <section className="ws-section ws-section--answer">
            <h3 className="ws-section__title">Grounded answer</h3>
            {(agentResponse.answer ?? []).length === 0 ? (
              <NoAnswerEmpty
                evidenceCount={(agentResponse.evidence ?? []).length}
                fallbackNotice={agentResponse.fallback_notice}
              />
            ) : (
              <ol className="ws-answer">
                {(agentResponse.answer ?? []).map((segment, idx) => (
                  <li key={idx} className="ws-answer__item">
                    <p className="ws-answer__text">{segment.text}</p>
                    {(segment.evidence_ids ?? []).length > 0 ? (
                      <div className="ws-answer__citations">
                        {(segment.evidence_ids ?? []).map((eid, citeIdx) => {
                          const ref = evidenceById.get(eid);
                          return (
                            <button
                              key={eid}
                              type="button"
                              className="ws-citation"
                              onClick={() => {
                                if (ref) openEAgent(ref, openEvent);
                              }}
                              disabled={!ref}
                              title={ref?.title ?? eid}
                            >
                              [{citeIdx + 1}]
                            </button>
                          );
                        })}
                      </div>
                    ) : (
                      <span className="ws-answer__uncited">uncited</span>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </section>

          {/* 2. Top causal driver + transmission path (the "why"). Card hides
               itself when there are no chains, so legacy responses are
               unaffected. */}
          <CausalChainCard chainSet={agentResponse.causal_chains ?? null} />

          {/* 2b. Portfolio impact — sits directly below the causal driver so
               the analyst sees "this driver touches your book here" before
               diving into the evidence list. Hidden when no portfolio is
               attached or no holding matched. */}
          <PortfolioImpactCard impact={agentResponse.portfolio_impact} />

          {/* 3. Compare result (when applicable). */}
          <CompareSummaryCard summary={agentResponse.compare_summary} />

          {/* 4. Evidence. */}
          <section className="ws-section">
            <h3 className="ws-section__title">
              Evidence <span className="ws-section__count">{(agentResponse.evidence ?? []).length}</span>
            </h3>
            {(agentResponse.evidence ?? []).length === 0 ? (
              <div className="ws-empty">
                <span className="ws-eyebrow">No evidence</span>
                <p>This query did not match any indexed signals.</p>
              </div>
            ) : (
              <ul className="ws-hit-list">
                {(agentResponse.evidence ?? []).map((ref) => (
                  <li key={ref.id} className="ws-hit">
                    <button
                      type="button"
                      className="ws-hit__button"
                      onClick={() => openEAgent(ref, openEvent)}
                    >
                      <span className={`ws-dot ws-dot--${ref.severity}`} aria-hidden />
                      <span className="ws-hit__main">
                        <span className="ws-hit__title">{ref.title}</span>
                        <span className="ws-hit__meta">
                          {categoryLabel(ref.type)}
                          {ref.country_code ? ` · ${ref.country_code}` : ""}
                          {" · "}
                          {SEVERITY_LABEL[ref.severity]}
                          {" · "}
                          {formatRelative(ref.source_timestamp)}
                          {ref.publisher ? ` · ${ref.publisher}` : ""}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* 5. Place / context surfaces — kept but pushed below evidence so
               they support the answer rather than gate it. */}
          {agentResponse.resolved_place ? (
            <ResolvedPlaceCard
              place={agentResponse.resolved_place}
              scopeUsed={agentResponse.scope_used}
              fallbackNotice={agentResponse.fallback_notice}
              onOpenCountry={(code, name) => openCountry(code, name, "search")}
            />
          ) : null}

          {(agentResponse.resolved_entities ?? []).length > 0 ? (
            <section className="ws-section">
              <h3 className="ws-section__title">Resolved entities</h3>
              <div className="ws-chip-wrap">
                {(agentResponse.resolved_entities ?? []).map((entity) => (
                  <ResolvedEntityChip
                    key={entity.id}
                    entity={entity}
                    onOpenCountry={(code, name) =>
                      openCountry(code, name, "search")
                    }
                  />
                ))}
              </div>
            </section>
          ) : null}

          {agentResponse.macro_context ? (
            <MacroContextRow macro={agentResponse.macro_context} />
          ) : null}

          {(agentResponse.place_dependencies ?? []).length > 0 ? (
            <PlaceDependenciesSection
              paths={agentResponse.place_dependencies ?? []}
            />
          ) : null}

          {/* 6. Time framing + caveats — the trust footer. */}
          <TimeContextChip context={agentResponse.time_context} />

          <CaveatList caveats={agentResponse.caveats ?? []} />

          {(agentResponse.follow_ups ?? []).length > 0 ? (
            <section className="ws-section ws-section--pivots">
              <h3 className="ws-section__title">Follow-ups</h3>
              <div className="ws-pivots">
                {(agentResponse.follow_ups ?? []).map((f) => (
                  <button
                    key={f.query}
                    type="button"
                    className="ws-pivot"
                    onClick={() => openQuery(f.query, undefined, "search")}
                  >
                    <span className="ws-pivot__label">{f.label}</span>
                    <span className="ws-pivot__hint">Re-run as grounded query</span>
                  </button>
                ))}
              </div>
            </section>
          ) : null}
        </PanelReveal>
      ) : null}
    </OverlayPanel>
  );
}

interface ResolvedPlaceCardProps {
  place: PlaceScope;
  scopeUsed: ScopeUsed;
  fallbackNotice: string | null;
  onOpenCountry: (code: string, name: string) => void;
}

function ResolvedPlaceCard({
  place,
  scopeUsed,
  fallbackNotice,
  onOpenCountry,
}: ResolvedPlaceCardProps) {
  const tone = FALLBACK_TONE[place.fallback_level];
  const typeLabel = place.type ? PLACE_TYPE_LABEL[place.type] ?? place.type : "Place";
  return (
    <section
      className="ws-section ws-place-card"
      data-testid="resolved-place-card"
      data-tone={tone}
    >
      <div className="ws-place-card__head">
        <p className="ws-eyebrow">Resolved place</p>
        <span className="ws-place-card__scope">{SCOPE_LABEL[scopeUsed]}</span>
      </div>
      <div className="ws-place-card__body">
        <div className="ws-place-card__name">
          <span className="ws-place-card__title">{place.name ?? place.query}</span>
          <span className="ws-place-card__type">{typeLabel}</span>
        </div>
        {place.country_name && place.country_name !== place.name ? (
          <button
            type="button"
            className="ws-place-card__country"
            onClick={() => {
              if (place.country_code && place.country_name) {
                onOpenCountry(place.country_code, place.country_name);
              }
            }}
            disabled={!place.country_code}
          >
            in {place.country_name}
            {place.country_code ? ` · ${place.country_code}` : ""}
          </button>
        ) : null}
      </div>
      <div className="ws-place-card__meta">
        <span>Confidence {Math.round(place.confidence * 100)}%</span>
        {place.is_fallback ? (
          <span className="ws-place-card__fallback-tag">Fallback</span>
        ) : (
          <span className="ws-place-card__fallback-tag ws-place-card__fallback-tag--exact">
            Direct match
          </span>
        )}
      </div>
      {fallbackNotice ? (
        <p className="ws-place-card__notice" role="status">
          {fallbackNotice}
        </p>
      ) : null}
    </section>
  );
}

interface ResolvedEntityChipProps {
  entity: ResolvedEntity;
  onOpenCountry: (code: string, name: string) => void;
}

function ResolvedEntityChip({ entity, onOpenCountry }: ResolvedEntityChipProps) {
  const interactive = Boolean(
    entity.country_code && entity.kind !== "fx_pair" && entity.kind !== "ticker",
  );
  const handleClick = () => {
    if (interactive && entity.country_code) {
      onOpenCountry(entity.country_code, entity.name);
    }
  };
  return (
    <button
      type="button"
      className="ws-chip ws-chip--watch"
      onClick={handleClick}
      disabled={!interactive}
      title={`${entity.kind}${entity.country_code ? ` · ${entity.country_code}` : ""}`}
    >
      {entity.name}
    </button>
  );
}

interface MacroContextRowProps {
  macro: MacroContext;
}

function MacroContextRow({ macro }: MacroContextRowProps) {
  const exportCommodity = formatCommodityName(macro.top_export_commodity);
  const importCommodity = formatCommodityName(macro.top_import_commodity);
  const sectorTags = macro.sector_tags.slice(0, 3);
  return (
    <section className="ws-section ws-macro" data-testid="macro-context">
      <h3 className="ws-section__title">Macro context</h3>
      <div className="ws-macro__row">
        <span className="ws-macro__chip ws-macro__chip--currency">
          {macro.currency_code}
        </span>
        {macro.logistics_hub ? (
          <span className="ws-macro__chip">Logistics hub</span>
        ) : null}
        {sectorTags.map((tag) => (
          <span key={tag} className="ws-macro__chip">
            {formatCommodityName(tag)}
          </span>
        ))}
      </div>
      {(exportCommodity || importCommodity) ? (
        <p className="ws-macro__detail">
          {exportCommodity ? (
            <span>
              Top export: <strong>{exportCommodity}</strong>
              {typeof macro.top_export_sensitivity === "number"
                ? ` (${Math.round(macro.top_export_sensitivity * 100)}% sensitivity)`
                : ""}
            </span>
          ) : null}
          {exportCommodity && importCommodity ? <span aria-hidden> · </span> : null}
          {importCommodity ? (
            <span>
              Top import: <strong>{importCommodity}</strong>
              {typeof macro.top_import_sensitivity === "number"
                ? ` (${Math.round(macro.top_import_sensitivity * 100)}% sensitivity)`
                : ""}
            </span>
          ) : null}
        </p>
      ) : null}
    </section>
  );
}

interface PlaceDependenciesSectionProps {
  paths: DependencyPath[];
}

function PlaceDependenciesSection({ paths }: PlaceDependenciesSectionProps) {
  return (
    <section className="ws-section ws-place-deps" data-testid="place-dependencies">
      <h3 className="ws-section__title">
        Place-driven exposure
        <span className="ws-section__count">{paths.length}</span>
      </h3>
      <ul className="ws-place-deps__list">
        {paths.map((path) => (
          <li key={path.id} className="ws-place-deps__item">
            <p className="ws-place-deps__title">{path.title}</p>
            <p className="ws-place-deps__rationale">{path.rationale}</p>
            <span className="ws-place-deps__confidence">
              Confidence {Math.round(path.overall_confidence * 100)}%
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function openEAgent(
  ref: EvidenceRef,
  openEvent: (event: SignalEvent, intent: "deep-link") => void,
): void {
  // Inflate an EvidenceRef into the minimum SignalEvent shape EventPanel needs.
  const placeholder: SignalEvent = {
    id: ref.id,
    dedupe_key: ref.id,
    type: ref.type as SignalEvent["type"],
    sub_type: null,
    title: ref.title,
    summary: ref.title,
    description: null,
    severity: ref.severity,
    severity_score: ref.severity_score,
    confidence: ref.confidence,
    status: "active",
    place: {
      latitude: null,
      longitude: null,
      country_code: ref.country_code,
      country_name: ref.country_name,
      region: null,
      admin1: null,
      locality: null,
    },
    start_time: null,
    end_time: null,
    source_timestamp: ref.source_timestamp,
    ingested_at: ref.source_timestamp ?? new Date().toISOString(),
    sources: [
      {
        adapter: "agent.citation",
        provider: "agent",
        provider_event_id: ref.id,
        url: ref.url,
        retrieved_at: ref.source_timestamp ?? new Date().toISOString(),
        source_timestamp: ref.source_timestamp,
        publisher: ref.publisher,
        reliability: 0.6,
      },
    ],
    merged_from: [],
    tags: [],
    entities: [],
    score: null,
    properties: {},
  };
  openEvent(placeholder, "deep-link");
}

interface NoAnswerEmptyProps {
  evidenceCount: number;
  fallbackNotice: string | null;
}

function NoAnswerEmpty({ evidenceCount, fallbackNotice }: NoAnswerEmptyProps) {
  return (
    <div className="ws-empty" data-testid="query-no-answer">
      <span className="ws-eyebrow">No grounded answer</span>
      <p>
        {evidenceCount > 0
          ? "Evidence is below, but the agent did not produce a grounded narrative."
          : "No matching signals in the current corpus."}
      </p>
      {fallbackNotice ? (
        <p className="ws-muted">{fallbackNotice}</p>
      ) : null}
    </div>
  );
}

function QuerySkeleton() {
  return (
    <div className="ws-skeleton" aria-busy="true" aria-live="polite">
      <div className="ws-skeleton__block" style={{ width: "36%" }} />
      <div className="ws-skeleton__block" style={{ width: "82%" }} />
      <div className="ws-skeleton__block" style={{ width: "70%" }} />
      <div className="ws-skeleton__block" style={{ width: "55%" }} />
      <div className="ws-skeleton__block" style={{ width: "48%" }} />
    </div>
  );
}
