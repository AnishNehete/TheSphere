"use client";

import { useEffect } from "react";

import { compareTargets as compareTargetsClient } from "@/lib/intelligence/client";
import type { CompareTarget, SignalSeverity } from "@/lib/intelligence/types";
import { IntelligenceApiError } from "@/lib/intelligence/types";
import { useOverlayStore } from "@/store/useOverlayStore";

import {
  SEVERITY_LABEL,
  categoryLabel,
  formatRelative,
} from "./formatters";
import { OverlayPanel } from "./OverlayPanel";

// Phase 12B — side-by-side compare for up to 3 targets. Keep it calm:
// stacked cards, not a wide diff table. Each target card mirrors what the
// CountryPanel shows in miniature so an analyst can scan differences without
// leaving the workspace shell.

const SEVERITY_ROW: SignalSeverity[] = ["info", "watch", "elevated", "critical"];

export function ComparePanel() {
  const selections = useOverlayStore((s) => s.compareTargets);
  const response = useOverlayStore((s) => s.compareResponse);
  const isLoading = useOverlayStore((s) => s.isLoading);
  const error = useOverlayStore((s) => s.error);
  const removeTarget = useOverlayStore((s) => s.removeCompareTarget);
  const clearTargets = useOverlayStore((s) => s.clearCompareTargets);
  const setCompareResponse = useOverlayStore((s) => s.setCompareResponse);
  const setLoading = useOverlayStore((s) => s.setLoading);
  const setError = useOverlayStore((s) => s.setError);
  const openCountry = useOverlayStore((s) => s.openCountry);

  useEffect(() => {
    if (selections.length < 2) {
      setCompareResponse(null);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    compareTargetsClient(
      selections.map((s) => ({ kind: s.kind, id: s.id.split(":")[1] ?? s.id })),
      { signal: controller.signal },
    )
      .then(setCompareResponse)
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        const message =
          err instanceof IntelligenceApiError
            ? "Compare is temporarily unavailable."
            : err instanceof Error
              ? err.message
              : "Compare failed.";
        setError(message);
      });
    return () => controller.abort();
  }, [selections, setCompareResponse, setError, setLoading]);

  const subtitle =
    selections.length < 2
      ? "Add a second target to compare"
      : response
        ? response.headline
        : isLoading
          ? "Building side-by-side view…"
          : undefined;

  return (
    <OverlayPanel
      eyebrow="Compare"
      title={selections.map((s) => s.label).join("  vs  ") || "Compare"}
      subtitle={subtitle}
    >
      {selections.length === 0 ? (
        <div className="ws-empty">
          <span className="ws-eyebrow">Empty</span>
          <p>
            Click two countries on the globe to build a compare set, or use the
            &ldquo;Add to compare&rdquo; pivot on event panels for cross-domain
            picks.
          </p>
        </div>
      ) : null}

      {selections.length === 1 ? (
        <div className="ws-empty">
          <span className="ws-eyebrow">One target</span>
          <p>
            Click a second country on the globe — Compare mode will pick it up
            automatically.
          </p>
        </div>
      ) : null}

      {error && !response ? (
        <div className="ws-empty">
          <span className="ws-eyebrow">Temporarily unavailable</span>
          <p>{error}</p>
        </div>
      ) : null}

      {response && response.targets.length >= 2 ? (
        <>
          <section className="ws-section">
            <div className="ws-compare-grid">
              {response.targets.map((target) => (
                <CompareCard
                  key={target.id}
                  target={target}
                  onRemove={() => removeTarget(target.id)}
                  onOpenCountry={openCountry}
                />
              ))}
            </div>
          </section>

          {response.diffs.length > 0 ? (
            <section className="ws-section">
              <h3 className="ws-section__title">Diffs</h3>
              <ul className="ws-diff-list">
                {response.diffs.map((diff) => (
                  <li key={diff.dimension} className="ws-diff">
                    <span className="ws-diff__dimension">{diff.dimension.replace(/_/g, " ")}</span>
                    <span className="ws-diff__values">
                      <span>{formatDiffValue(diff.left_value)}</span>
                      <span aria-hidden>→</span>
                      <span>{formatDiffValue(diff.right_value)}</span>
                    </span>
                    {diff.delta_note ? (
                      <span className="ws-diff__note">{diff.delta_note}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <section className="ws-section ws-section--pivots">
            <button type="button" className="ws-pivot" onClick={clearTargets}>
              <span className="ws-pivot__label">Clear compare set</span>
              <span className="ws-pivot__hint">Removes all targets</span>
            </button>
          </section>
        </>
      ) : null}
    </OverlayPanel>
  );
}

function CompareCard({
  target,
  onRemove,
  onOpenCountry,
}: {
  target: CompareTarget;
  onRemove: () => void;
  onOpenCountry: (code: string, name?: string) => void;
}) {
  const summary = target.summary;
  return (
    <article className="ws-compare-card">
      <header className="ws-compare-card__head">
        <div>
          <span className="ws-eyebrow">
            {target.kind === "country" ? "Country" : "Event"}
          </span>
          <strong className="ws-compare-card__title">{target.label}</strong>
        </div>
        <button
          type="button"
          className="ws-compare-card__remove"
          onClick={onRemove}
          aria-label={`Remove ${target.label} from compare`}
        >
          ×
        </button>
      </header>

      {summary ? (
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
      ) : target.event ? (
        <span className={`ws-chip ws-chip--${target.event.severity}`}>
          {SEVERITY_LABEL[target.event.severity]} ·{" "}
          {Math.round(target.event.severity_score * 100)}
        </span>
      ) : null}

      {target.freshness_minutes !== null ? (
        <p className="ws-muted">
          Freshest signal {formatRelative(relativeFromMinutes(target.freshness_minutes))}
        </p>
      ) : null}

      {Object.keys(target.counts_by_category).length > 0 ? (
        <div className="ws-counts">
          {Object.entries(target.counts_by_category)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([cat, n]) => (
              <div key={cat} className="ws-count">
                <span>{categoryLabel(cat)}</span>
                <strong>{n}</strong>
              </div>
            ))}
        </div>
      ) : null}

      <div className="ws-compare-card__sev">
        {SEVERITY_ROW.map((sev) => {
          const count = target.severity_distribution[sev] ?? 0;
          return (
            <span key={sev} className="ws-compare-card__sev-cell">
              <span className={`ws-dot ws-dot--${sev}`} aria-hidden />
              <span>{count}</span>
            </span>
          );
        })}
      </div>

      {target.recent_events.length > 0 ? (
        <ul className="ws-compare-card__events">
          {target.recent_events.slice(0, 3).map((event) => (
            <li key={event.id}>
              <span className={`ws-dot ws-dot--${event.severity}`} aria-hidden />
              <span className="ws-compare-card__event-title">{event.title}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {target.kind === "country" && target.country_code ? (
        <button
          type="button"
          className="ws-pivot ws-pivot--inline"
          onClick={() => onOpenCountry(target.country_code!, target.label)}
        >
          <span className="ws-pivot__label">Open country brief</span>
        </button>
      ) : null}
    </article>
  );
}

function formatDiffValue(value: string | number | null): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "number") return value.toString();
  return value;
}

function relativeFromMinutes(minutes: number): string {
  const date = new Date(Date.now() - minutes * 60_000);
  return date.toISOString();
}
