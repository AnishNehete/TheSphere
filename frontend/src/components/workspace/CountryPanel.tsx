"use client";

import { useEffect, useMemo } from "react";

import { getCountrySummary } from "@/lib/intelligence/client";
import { computeAllWindowDeltas, describePostureDrift } from "@/lib/intelligence/trends";
import { summariseChangesSince } from "@/lib/intelligence/timeline";
import type { SignalCategory, SignalEvent } from "@/lib/intelligence/types";
import { IntelligenceApiError } from "@/lib/intelligence/types";
import { useOverlayStore } from "@/store/useOverlayStore";

import {
  SEVERITY_LABEL,
  categoryLabel,
  formatConfidence,
  formatRelative,
  formatUtc,
} from "./formatters";
import { DependencySection } from "./DependencySection";
import { OverlayPanel } from "./OverlayPanel";
import { SourceList } from "./SourceList";
import { PanelReveal } from "./motion/PanelReveal";
import {
  ChangesSinceLine,
  MetadataStrip,
  PostureChip,
  ReplayBadge,
  TrendStrip,
  type MetadataField,
} from "./grammar/SignalGrammar";

const CATEGORY_ORDER: SignalCategory[] = [
  "weather",
  "news",
  "stocks",
  "currency",
  "flights",
  "conflict",
  "health",
  "disease",
  "mood",
  "commodities",
];

export function CountryPanel() {
  const code = useOverlayStore((s) => s.selectedCountryCode);
  const detail = useOverlayStore((s) => s.countryDetail);
  const fallbackName = useOverlayStore((s) => s.selectedCountryName);
  const isLoading = useOverlayStore((s) => s.isLoading);
  const error = useOverlayStore((s) => s.error);
  const setCountryDetail = useOverlayStore((s) => s.setCountryDetail);
  const setLoading = useOverlayStore((s) => s.setLoading);
  const setError = useOverlayStore((s) => s.setError);
  const openEvent = useOverlayStore((s) => s.openEvent);
  const addCompareTarget = useOverlayStore((s) => s.addCompareTarget);
  const openCompare = useOverlayStore((s) => s.openCompare);
  const compareTargets = useOverlayStore((s) => s.compareTargets);

  useEffect(() => {
    if (!code) return;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    getCountrySummary(code, { signal: controller.signal })
      .then((response) => setCountryDetail(response))
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        const message =
          err instanceof IntelligenceApiError
            ? err.status === 404
              ? "No intelligence is scoped to this country yet."
              : "This country is temporarily unavailable."
            : err instanceof Error
              ? err.message
              : "Country lookup failed.";
        setError(message);
      });
    return () => controller.abort();
  }, [code, setCountryDetail, setError, setLoading]);

  const summary = detail?.summary;
  const displayName = summary?.country_name ?? fallbackName ?? code ?? "—";
  const asOf = useOverlayStore((s) => s.portfolioAsOf);

  // Wave 15C — trend windows over the events backing this country brief.
  const eventStream = detail?.events ?? [];
  const trendDeltas = useMemo(
    () => computeAllWindowDeltas(eventStream, asOf),
    [eventStream, asOf],
  );
  const posture = useMemo(
    () => describePostureDrift(trendDeltas["7d"]),
    [trendDeltas],
  );
  const changesSince = useMemo(
    () => summariseChangesSince(eventStream, "24h", asOf),
    [eventStream, asOf],
  );

  const metaFields: MetadataField[] | null = summary
    ? [
        {
          key: "scope",
          label: "Scope",
          value: summary.country_code,
        },
        {
          key: "severity",
          label: "Watch posture",
          value: (
            <span className={`ws-chip ws-chip--${summary.watch_label}`}>
              {SEVERITY_LABEL[summary.watch_label]} · {Math.round(summary.watch_score * 100)}
            </span>
          ),
        },
        {
          key: "confidence",
          label: "Confidence",
          value: formatConfidence(summary.confidence),
        },
        {
          key: "freshness",
          label: "Updated",
          value: (
            <span title={formatUtc(summary.updated_at)}>
              {formatRelative(summary.updated_at)}
            </span>
          ),
        },
      ]
    : null;

  return (
    <OverlayPanel
      eyebrow="Country intelligence"
      title={displayName}
      subtitle={
        summary
          ? `${SEVERITY_LABEL[summary.watch_label]} · updated ${formatRelative(summary.updated_at)}`
          : code
            ? `ISO ${code}`
            : undefined
      }
    >
      {isLoading && !summary ? <CountrySkeleton /> : null}

      {error && !summary ? (
        <EmptyState
          eyebrow="Temporarily unavailable"
          message={error}
        />
      ) : null}

      {summary && detail ? (
        <PanelReveal testId="country-panel-reveal">
          {metaFields ? <MetadataStrip fields={metaFields} testId="country-grammar-meta" /> : null}

          <section
            className="ws-section ws-grammar-trend-row"
            data-testid="country-grammar-trend"
            data-grammar-section="trend"
          >
            <div className="ws-grammar-trend-row__head">
              <ReplayBadge asOf={asOf} testId="country-panel-replay-badge" />
              <PostureChip posture={posture.posture} copy={posture.copy} />
            </div>
            <TrendStrip deltas={trendDeltas} />
            <ChangesSinceLine summary={changesSince} isReplay={Boolean(asOf)} />
          </section>

          <section className="ws-section">
            <div className="ws-section__row ws-section__row--split">
              <div>
                <p className="ws-eyebrow">Watch posture</p>
                <div className="ws-watch">
                  <strong className="ws-watch__score">
                    {Math.round(summary.watch_score * 100)}
                  </strong>
                  <span className={`ws-watch__tag ws-watch__tag--${summary.watch_label}`}>
                    {SEVERITY_LABEL[summary.watch_label]}
                  </span>
                  <span
                    className={`ws-watch__delta ws-watch__delta--${summary.watch_delta >= 0 ? "up" : "down"}`}
                  >
                    {summary.watch_delta >= 0 ? "+" : ""}
                    {summary.watch_delta.toFixed(2)}
                  </span>
                </div>
              </div>
              <dl className="ws-meta">
                <div>
                  <dt>Confidence</dt>
                  <dd>{formatConfidence(summary.confidence)}</dd>
                </div>
                <div>
                  <dt>Updated</dt>
                  <dd title={formatUtc(summary.updated_at)}>
                    {formatRelative(summary.updated_at)}
                  </dd>
                </div>
                <div>
                  <dt>Top signals</dt>
                  <dd>{summary.top_signals.length}</dd>
                </div>
              </dl>
            </div>
            {summary.summary ? (
              <p className="ws-section__body">{summary.summary}</p>
            ) : (
              <p className="ws-section__body ws-muted">
                No executive summary has been written for this country yet.
              </p>
            )}
          </section>

          <section className="ws-section">
            <h3 className="ws-section__title">Signal counts</h3>
            <div className="ws-counts">
              {CATEGORY_ORDER.map((cat) => {
                const count = summary.counts_by_category[cat] ?? 0;
                if (count === 0) return null;
                return (
                  <div key={cat} className="ws-count">
                    <span>{categoryLabel(cat)}</span>
                    <strong>{count}</strong>
                  </div>
                );
              })}
              {Object.keys(summary.counts_by_category).length === 0 ? (
                <p className="ws-muted">No signals scoped to this country.</p>
              ) : null}
            </div>
          </section>

          <section className="ws-section">
            <h3 className="ws-section__title">Top active signals</h3>
            {summary.top_signals.length === 0 ? (
              <EmptyState
                eyebrow="Clear"
                message="No elevated signals for this country right now."
              />
            ) : (
              <ul className="ws-signal-list">
                {summary.top_signals.slice(0, 6).map((signal) => (
                  <SignalRow
                    key={signal.id}
                    event={signal}
                    onClick={() => openEvent(signal, "deep-link")}
                  />
                ))}
              </ul>
            )}
          </section>

          <section className="ws-section">
            <h3 className="ws-section__title">Recent evidence</h3>
            {detail.events.length === 0 ? (
              <EmptyState
                eyebrow="Empty timeline"
                message="No recent evidence has been ingested for this country."
              />
            ) : (
              <ol className="ws-timeline">
                {detail.events.slice(0, 10).map((event) => (
                  <li key={event.id} className="ws-timeline__item">
                    <button
                      type="button"
                      className="ws-timeline__button"
                      onClick={() => openEvent(event, "deep-link")}
                    >
                      <span className="ws-timeline__time">
                        {formatRelative(event.source_timestamp ?? event.ingested_at)}
                      </span>
                      <span className="ws-timeline__title">{event.title}</span>
                      <span className={`ws-timeline__severity ws-sev--${event.severity}`}>
                        {SEVERITY_LABEL[event.severity]}
                      </span>
                    </button>
                  </li>
                ))}
              </ol>
            )}
          </section>

          <DependencySection countryCode={summary.country_code} />

          <section className="ws-section">
            <h3 className="ws-section__title">Provenance</h3>
            <SourceList sources={summary.sources} compact />
          </section>

          <section className="ws-section ws-section--pivots">
            <h3 className="ws-section__title">Suggested pivots</h3>
            <div className="ws-pivots">
              {summary.headline_signal_id ? (
                <PivotChip
                  label="Open headline signal"
                  hint={summary.top_signals[0]?.title ?? ""}
                  onClick={() => {
                    const headline = summary.top_signals.find(
                      (s) => s.id === summary.headline_signal_id,
                    );
                    if (headline) openEvent(headline, "deep-link");
                  }}
                />
              ) : null}
              <PivotChip
                label="Add to compare"
                hint={
                  compareTargets.some((t) => t.id === `country:${summary.country_code}`)
                    ? "Already in compare set"
                    : `${compareTargets.length}/3 selected`
                }
                onClick={() => {
                  addCompareTarget({
                    kind: "country",
                    id: `country:${summary.country_code}`,
                    label: summary.country_name,
                    country_code: summary.country_code,
                  });
                }}
                disabled={compareTargets.some(
                  (t) => t.id === `country:${summary.country_code}`,
                )}
              />
              {compareTargets.length >= 2 ? (
                <PivotChip
                  label="Open compare view"
                  hint={`${compareTargets.length} target${compareTargets.length === 1 ? "" : "s"}`}
                  onClick={() => openCompare()}
                />
              ) : null}
            </div>
          </section>
        </PanelReveal>
      ) : null}
    </OverlayPanel>
  );
}

function SignalRow({ event, onClick }: { event: SignalEvent; onClick: () => void }) {
  return (
    <li className="ws-signal-row">
      <button type="button" className="ws-signal-row__button" onClick={onClick}>
        <span className={`ws-dot ws-dot--${event.severity}`} aria-hidden />
        <span className="ws-signal-row__main">
          <span className="ws-signal-row__title">{event.title}</span>
          <span className="ws-signal-row__meta">
            {categoryLabel(event.type)} · {formatRelative(event.source_timestamp ?? event.ingested_at)}
            {" · "}
            {formatConfidence(event.confidence)} confidence
          </span>
        </span>
      </button>
    </li>
  );
}

function CountrySkeleton() {
  return (
    <div className="ws-skeleton" aria-busy="true" aria-live="polite">
      <div className="ws-skeleton__block" style={{ width: "60%" }} />
      <div className="ws-skeleton__block" style={{ width: "85%" }} />
      <div className="ws-skeleton__block" style={{ width: "40%" }} />
      <div className="ws-skeleton__block" style={{ width: "78%" }} />
      <div className="ws-skeleton__block" style={{ width: "52%" }} />
    </div>
  );
}

function EmptyState({ eyebrow, message }: { eyebrow: string; message: string }) {
  return (
    <div className="ws-empty">
      <span className="ws-eyebrow">{eyebrow}</span>
      <p>{message}</p>
    </div>
  );
}

function PivotChip({
  label,
  hint,
  onClick,
  disabled = false,
}: {
  label: string;
  hint?: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button type="button" className="ws-pivot" onClick={onClick} disabled={disabled}>
      <span className="ws-pivot__label">{label}</span>
      {hint ? <span className="ws-pivot__hint">{hint}</span> : null}
    </button>
  );
}
