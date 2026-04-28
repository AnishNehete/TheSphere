"use client";

import type { ReactNode } from "react";

import type {
  TrendDirection,
  TrendWindow,
  WindowDelta,
} from "@/lib/intelligence/trends";
import { TREND_WINDOW_LABEL } from "@/lib/intelligence/trends";
import type { ChangesSinceSummary } from "@/lib/intelligence/timeline";
import { replayCopy } from "@/lib/intelligence/timeline";

// Wave 15C — shared signal grammar primitives.
//
// EventPanel established the section order and `data-grammar-field` contract
// in 15B. 15C lifts those primitives into a shared module so every panel
// (Country, Query, Portfolio, Event, plus future ones) reads from the same
// vocabulary. The benefit: every panel feels like it belongs to one product,
// and the contract tests can assert grammar consistency across panels.
//
// What lives here:
//   - MetadataStrip  — the canonical "domain · severity · confidence ·
//                       freshness · status · scope" header strip
//   - GrammarSection — wraps a section with the `data-grammar-section`
//                       attribute so contract tests can find it
//   - DeltaChip      — small chip for trend windows (24h / 7d / 30d)
//   - TrendStrip     — composite of three DeltaChips for the canonical windows
//   - ReplayBadge    — replay-aware live/as-of indicator used in panels
//   - ChangesSinceLine — short timeline summary for panel headers
//
// Nothing here is policy. The primitives are dumb renderers that take
// already-computed data so they can be unit-tested cheaply.

export type GrammarFieldKey =
  | "domain"
  | "severity"
  | "confidence"
  | "freshness"
  | "status"
  | "geography"
  | "scope"
  | "delta"
  | "posture";

export interface MetadataField {
  key: GrammarFieldKey;
  label: string;
  value: ReactNode;
  /** Optional title attribute for hover detail. */
  title?: string;
}

interface MetadataStripProps {
  fields: MetadataField[];
  /**
   * Optional test-id override. Defaults to "signal-grammar-meta" so existing
   * 15B tests keep passing without modification.
   */
  testId?: string;
}

export function MetadataStrip({ fields, testId = "signal-grammar-meta" }: MetadataStripProps) {
  return (
    <section className="ws-section ws-signal-grammar" data-testid={testId}>
      <dl className="ws-meta ws-meta--grid">
        {fields.map((f) => (
          <div key={f.key} data-grammar-field={f.key} title={f.title}>
            <dt>{f.label}</dt>
            <dd>{f.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

interface GrammarSectionProps {
  field: string;
  title?: ReactNode;
  className?: string;
  /** Optional override for the section's data-testid. Defaults to `signal-grammar-${field}`. */
  testId?: string;
  children: ReactNode;
}

export function GrammarSection({
  field,
  title,
  className,
  testId,
  children,
}: GrammarSectionProps) {
  return (
    <section
      className={`ws-section${className ? ` ${className}` : ""}`}
      data-testid={testId ?? `signal-grammar-${field}`}
      data-grammar-section={field}
    >
      {title ? <h3 className="ws-section__title">{title}</h3> : null}
      {children}
    </section>
  );
}

interface DeltaChipProps {
  delta: WindowDelta;
  /** Optional override for the visible label. */
  label?: string;
}

export function DeltaChip({ delta, label }: DeltaChipProps) {
  const sign = delta.delta > 0 ? "+" : delta.delta < 0 ? "" : "±";
  const directionClass = `ws-delta-chip--${delta.direction}`;
  const win = TREND_WINDOW_LABEL[delta.window];
  return (
    <span
      className={`ws-delta-chip ${directionClass}`}
      title={`${win}: ${delta.current} now / ${delta.previous} prior · pressure ${delta.pressureNow.toFixed(1)} → ${(delta.pressureNow + delta.pressureDelta).toFixed(1)}`}
      data-window={delta.window}
      data-direction={delta.direction}
      data-testid={`delta-chip-${delta.window}`}
    >
      <span className="ws-delta-chip__win">{label ?? win}</span>
      <span className="ws-delta-chip__val">
        {sign}
        {delta.delta}
      </span>
    </span>
  );
}

interface TrendStripProps {
  deltas: Record<TrendWindow, WindowDelta>;
  /** When true, show the 30d chip — defaults to true. */
  show30d?: boolean;
}

export function TrendStrip({ deltas, show30d = true }: TrendStripProps) {
  const windows: TrendWindow[] = show30d ? ["24h", "7d", "30d"] : ["24h", "7d"];
  return (
    <div
      className="ws-trend-strip"
      data-testid="trend-strip"
      data-grammar-field="delta"
    >
      {windows.map((w) => (
        <DeltaChip key={w} delta={deltas[w]} />
      ))}
    </div>
  );
}

interface ReplayBadgeProps {
  asOf: string | null;
  /** Optional override for the test-id. */
  testId?: string;
}

export function ReplayBadge({ asOf, testId = "replay-badge" }: ReplayBadgeProps) {
  const isAsOf = Boolean(asOf);
  return (
    <span
      className={`ws-replay-badge ws-replay-badge--${isAsOf ? "asof" : "live"}`}
      data-testid={testId}
      data-asof={asOf ?? ""}
      data-grammar-field="freshness"
      title={replayCopy(asOf)}
    >
      <span className={`ws-badge--${isAsOf ? "asof" : "live"}`}>
        {isAsOf ? "As-of" : "Live"}
      </span>
      {isAsOf && asOf ? (
        <span className="ws-replay-badge__time">{asOf.slice(0, 16).replace("T", " ")}Z</span>
      ) : null}
    </span>
  );
}

interface ChangesSinceLineProps {
  summary: ChangesSinceSummary;
  isReplay: boolean;
}

export function ChangesSinceLine({ summary, isReplay }: ChangesSinceLineProps) {
  return (
    <p
      className="ws-grammar-changes-since"
      data-testid="grammar-changes-since"
      data-grammar-section="changes-since"
      data-replay={isReplay ? "true" : "false"}
    >
      {summary.copy}
    </p>
  );
}

interface PostureChipProps {
  posture: "stable" | "loosening" | "tightening" | "insufficient";
  copy: string;
}

export function PostureChip({ posture, copy }: PostureChipProps) {
  return (
    <span
      className={`ws-posture-chip ws-posture-chip--${posture}`}
      data-testid={`posture-chip-${posture}`}
      data-grammar-field="posture"
      title={copy}
    >
      {posture}
    </span>
  );
}

export function directionLabel(direction: TrendDirection): string {
  switch (direction) {
    case "up":
      return "rising";
    case "down":
      return "easing";
    default:
      return "flat";
  }
}
