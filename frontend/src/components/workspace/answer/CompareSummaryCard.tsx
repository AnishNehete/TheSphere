"use client";

import type {
  AgentCompareSummary,
  AgentCompareTarget,
} from "@/lib/intelligence/types";

// Phase 18A.4 — calm two-target compare card. Renders only when the
// retrieval orchestrator detected a compare phrase. Partial resolution
// (one leg unresolved) is surfaced explicitly via a "Partial" badge and
// honest body copy, not a silent collapse.

interface CompareSummaryCardProps {
  summary: AgentCompareSummary | null | undefined;
}

export function CompareSummaryCard({ summary }: CompareSummaryCardProps) {
  if (!summary || !summary.requested) {
    return null;
  }
  const resolved = summary.targets.filter((t) => t.resolution !== "none");
  return (
    <section className="ws-section ws-compare-card" data-testid="compare-summary-card">
      <header className="ws-compare-card__head">
        <h3 className="ws-section__title">Compare</h3>
        {summary.collapsed ? (
          <span
            className="ws-compare-card__badge"
            data-variant="partial"
            data-testid="compare-collapsed-badge"
          >
            Partial resolution
          </span>
        ) : null}
        {summary.mode ? (
          <span className="ws-compare-card__mode">{summary.mode}</span>
        ) : null}
      </header>
      {summary.headline ? (
        <p className="ws-compare-card__headline">{summary.headline}</p>
      ) : null}
      {summary.collapsed ? (
        <p className="ws-muted">
          Only one leg matched a known entity. The answer above falls
          back to that single subject.
        </p>
      ) : null}
      <div className="ws-compare-card__targets" role="list">
        {summary.targets.map((target) => (
          <CompareTargetRow key={target.canonical_id ?? target.raw} target={target} />
        ))}
      </div>
      {!summary.collapsed && resolved.length === 0 ? (
        <p className="ws-muted">No legs resolved against the gazetteer.</p>
      ) : null}
    </section>
  );
}

interface CompareTargetRowProps {
  target: AgentCompareTarget;
}

const RESOLUTION_LABEL: Record<AgentCompareTarget["resolution"], string> = {
  exact: "Exact",
  alias: "Alias",
  fallback: "Fallback",
  none: "Unresolved",
};

function CompareTargetRow({ target }: CompareTargetRowProps) {
  const eventCount = target.event_ids.length;
  const watch =
    target.watch_label !== null
      ? `${target.watch_label}${
          target.watch_score !== null
            ? ` (${Math.round(target.watch_score * 100)})`
            : ""
        }`
      : null;
  return (
    <article
      className="ws-compare-card__target"
      role="listitem"
      data-resolution={target.resolution}
      data-testid="compare-target-row"
    >
      <header className="ws-compare-card__target-head">
        <span className="ws-compare-card__target-label">{target.label}</span>
        <span
          className="ws-compare-card__target-resolution"
          data-resolution={target.resolution}
        >
          {RESOLUTION_LABEL[target.resolution]}
        </span>
      </header>
      <dl className="ws-compare-card__target-meta">
        {watch !== null ? (
          <div>
            <dt>Watch</dt>
            <dd>{watch}</dd>
          </div>
        ) : null}
        <div>
          <dt>Signals</dt>
          <dd>{eventCount}</dd>
        </div>
        {target.freshness_minutes !== null ? (
          <div>
            <dt>Freshness</dt>
            <dd>{Math.round(target.freshness_minutes)}m</dd>
          </div>
        ) : null}
        {target.country_code ? (
          <div>
            <dt>Country</dt>
            <dd>{target.country_code}</dd>
          </div>
        ) : null}
      </dl>
    </article>
  );
}
