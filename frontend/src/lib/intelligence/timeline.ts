// Wave 15C — timeline / replay intelligence.
//
// Builds "what changed since X" / accumulation summaries that the panels can
// surface so replay feels analytical rather than purely cosmetic.
//
// All output copy stays grounded:
//   - never claims future knowledge when in as-of mode
//   - never invents structure when the events list is too thin to support it
//   - always names the comparison window so the operator can audit the claim
//
// The functions are pure; the panels and ActiveScopeBar consume them via
// `useMemo` to derive the displayed copy.

import type { SignalEvent, SignalSeverity } from "./types";

import {
  TREND_WINDOWS_MS,
  TREND_WINDOW_LABEL,
  type TrendWindow,
} from "./trends";

const SEVERITY_RANK: Record<SignalSeverity, number> = {
  info: 0,
  watch: 1,
  elevated: 2,
  critical: 3,
};

export interface ChangesSinceSummary {
  window: TrendWindow;
  pivotIso: string;
  /** Events whose timestamp falls strictly inside the window. */
  newCount: number;
  /** Critical-or-elevated events that arrived in the window. */
  escalatedCount: number;
  /** Events that have flipped to a `resolved` status inside the window. */
  resolvedCount: number;
  /** Top three drivers — the loudest events in the window, severity then recency. */
  topDrivers: SignalEvent[];
  /** The single sentence that should appear in the panel. */
  copy: string;
}

/**
 * Summarise everything that changed inside a window relative to the pivot.
 * If `pivot` is null we use Date.now() — same engine drives Live and Replay.
 */
export function summariseChangesSince(
  events: ReadonlyArray<SignalEvent>,
  window: TrendWindow,
  pivot: Date | string | null = null,
): ChangesSinceSummary {
  const windowMs = TREND_WINDOWS_MS[window];
  const pivotMs = resolvePivotMs(pivot);
  const pivotIso = new Date(pivotMs).toISOString();
  const windowStart = pivotMs - windowMs;

  const inWindow: SignalEvent[] = [];
  let newCount = 0;
  let escalatedCount = 0;
  let resolvedCount = 0;

  for (const event of events) {
    const ts = eventTimestampMs(event);
    if (ts === null) continue;
    if (ts > pivotMs) continue;
    if (ts < windowStart) continue;
    inWindow.push(event);
    newCount += 1;
    if (SEVERITY_RANK[event.severity] >= SEVERITY_RANK.elevated) {
      escalatedCount += 1;
    }
    if (event.status === "resolved") {
      resolvedCount += 1;
    }
  }

  const topDrivers = pickTopDrivers(inWindow, 3);
  const copy = buildChangesCopy({
    window,
    newCount,
    escalatedCount,
    resolvedCount,
    pivotMs,
    isReplay: pivot !== null,
  });

  return {
    window,
    pivotIso,
    newCount,
    escalatedCount,
    resolvedCount,
    topDrivers,
    copy,
  };
}

export interface AccumulationBucket {
  windowStartIso: string;
  windowEndIso: string;
  count: number;
  severityNow: Record<SignalSeverity, number>;
}

/**
 * Slice the event stream into back-to-back buckets ending at the pivot.
 * Useful for tiny sparkline-style accumulation surfaces that show the
 * arc of the last six 24h windows (or last six 7d windows, etc).
 */
export function bucketAccumulation(
  events: ReadonlyArray<SignalEvent>,
  window: TrendWindow,
  pivot: Date | string | null = null,
  bucketCount = 6,
): AccumulationBucket[] {
  if (bucketCount <= 0) return [];
  const windowMs = TREND_WINDOWS_MS[window];
  const pivotMs = resolvePivotMs(pivot);
  const buckets: AccumulationBucket[] = [];

  for (let i = bucketCount - 1; i >= 0; i--) {
    const end = pivotMs - i * windowMs;
    const start = end - windowMs;
    const severity: Record<SignalSeverity, number> = {
      info: 0,
      watch: 0,
      elevated: 0,
      critical: 0,
    };
    let count = 0;
    for (const event of events) {
      const ts = eventTimestampMs(event);
      if (ts === null) continue;
      if (ts > end) continue;
      if (ts <= start) continue;
      count += 1;
      severity[event.severity] += 1;
    }
    buckets.push({
      windowStartIso: new Date(start).toISOString(),
      windowEndIso: new Date(end).toISOString(),
      count,
      severityNow: severity,
    });
  }
  return buckets;
}

/**
 * Render replay-aware copy for status surfaces. Honest about when
 * the user is reading history vs live.
 */
export function replayCopy(asOf: string | null): string {
  if (!asOf) return "Live · feed cursor at present";
  const d = new Date(asOf);
  if (Number.isNaN(d.getTime())) return `Replay · as of ${asOf}`;
  const utc = d.toISOString().slice(0, 16).replace("T", " ");
  return `Replay · viewing as of ${utc} UTC`;
}

interface ChangesCopyArgs {
  window: TrendWindow;
  newCount: number;
  escalatedCount: number;
  resolvedCount: number;
  pivotMs: number;
  isReplay: boolean;
}

function buildChangesCopy(args: ChangesCopyArgs): string {
  const win = TREND_WINDOW_LABEL[args.window];
  if (args.newCount === 0) {
    return args.isReplay
      ? `No new signals in the ${win} ending at the as-of cursor.`
      : `No new signals in the last ${win}.`;
  }
  const pieces: string[] = [];
  pieces.push(
    args.isReplay
      ? `${args.newCount} signal${args.newCount === 1 ? "" : "s"} in the ${win} ending at the as-of cursor`
      : `${args.newCount} new signal${args.newCount === 1 ? "" : "s"} in the last ${win}`,
  );
  if (args.escalatedCount > 0) {
    pieces.push(
      `${args.escalatedCount} elevated-or-critical`,
    );
  }
  if (args.resolvedCount > 0) {
    pieces.push(
      `${args.resolvedCount} marked resolved`,
    );
  }
  return `${pieces.join(" · ")}.`;
}

function pickTopDrivers(
  events: ReadonlyArray<SignalEvent>,
  limit: number,
): SignalEvent[] {
  return [...events]
    .sort((a, b) => {
      const sevDiff = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
      if (sevDiff !== 0) return sevDiff;
      const aTs = eventTimestampMs(a) ?? 0;
      const bTs = eventTimestampMs(b) ?? 0;
      return bTs - aTs;
    })
    .slice(0, limit);
}

function eventTimestampMs(event: SignalEvent): number | null {
  const iso = event.source_timestamp ?? event.ingested_at ?? null;
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

function resolvePivotMs(pivot: Date | string | null): number {
  if (pivot === null) return Date.now();
  if (pivot instanceof Date) return pivot.getTime();
  const t = Date.parse(pivot);
  return Number.isFinite(t) ? t : Date.now();
}
