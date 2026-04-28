// Wave 15C — trend / delta intelligence.
//
// Pure helpers that turn a stream of timestamped signal events into
// confidence-aware deltas across canonical analyst windows (24h, 7d, 30d).
// The output is intentionally narrow: each window returns counts per
// severity, posture, and a delta vs the *prior* equal-length window so the
// rest of the UI can describe drift without inventing structure.
//
// Why this lives outside the panels: the math is the most testable part of
// the trend surface. Keeping it pure also lets us reuse the same helpers in
// future export / scoring contexts.

import type { SignalEvent, SignalSeverity } from "./types";

// Canonical analyst windows expressed in milliseconds.
export const TREND_WINDOWS_MS = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
} as const;

export type TrendWindow = keyof typeof TREND_WINDOWS_MS;

export const TREND_WINDOW_LABEL: Record<TrendWindow, string> = {
  "24h": "24h",
  "7d": "7d",
  "30d": "30d",
};

export type TrendDirection = "up" | "down" | "flat";

export interface SeverityCounts {
  info: number;
  watch: number;
  elevated: number;
  critical: number;
}

const ZERO_COUNTS: SeverityCounts = {
  info: 0,
  watch: 0,
  elevated: 0,
  critical: 0,
};

const SEVERITY_PRESSURE: Record<SignalSeverity, number> = {
  info: 0.25,
  watch: 0.5,
  elevated: 1,
  critical: 1.6,
};

export interface WindowDelta {
  window: TrendWindow;
  windowMs: number;
  /** Signals inside the current window. */
  current: number;
  /** Signals inside the equal-length window that ended at the start of `current`. */
  previous: number;
  /** current - previous. Negative means decay, positive means buildup. */
  delta: number;
  direction: TrendDirection;
  severityNow: SeverityCounts;
  severityPrev: SeverityCounts;
  /**
   * Severity-weighted pressure score for the current window.
   * Critical = 1.6x, elevated = 1x, watch = 0.5x, info = 0.25x.
   */
  pressureNow: number;
  pressurePrev: number;
  pressureDelta: number;
  /**
   * Confidence is bounded by sample-size: more events in the comparison
   * window yields more confidence. Capped at 0.9 because trend math is
   * inherently descriptive, not predictive.
   */
  confidence: number;
}

/**
 * Compute a single trend window snapshot from a flat event list.
 * The pivot defaults to "now" but can be set to an as-of timestamp so the
 * same engine drives Live and Replay modes identically.
 */
export function computeWindowDelta(
  events: ReadonlyArray<SignalEvent>,
  window: TrendWindow,
  pivot: Date | string | null = null,
): WindowDelta {
  const windowMs = TREND_WINDOWS_MS[window];
  const pivotMs = resolvePivot(pivot);
  const currentStart = pivotMs - windowMs;
  const previousStart = pivotMs - windowMs * 2;

  const severityNow: SeverityCounts = { ...ZERO_COUNTS };
  const severityPrev: SeverityCounts = { ...ZERO_COUNTS };
  let pressureNow = 0;
  let pressurePrev = 0;
  let current = 0;
  let previous = 0;

  for (const event of events) {
    const ts = eventTimestampMs(event);
    if (ts === null) continue;
    if (ts > pivotMs) continue;
    if (ts > currentStart) {
      current += 1;
      severityNow[event.severity] += 1;
      pressureNow += SEVERITY_PRESSURE[event.severity];
    } else if (ts > previousStart) {
      previous += 1;
      severityPrev[event.severity] += 1;
      pressurePrev += SEVERITY_PRESSURE[event.severity];
    }
  }

  const delta = current - previous;
  const pressureDelta = pressureNow - pressurePrev;
  const direction = directionFromDelta(delta);
  const confidence = bounded(
    Math.log10(Math.max(1, current + previous + 1)) / Math.log10(50),
    0,
    0.9,
  );

  return {
    window,
    windowMs,
    current,
    previous,
    delta,
    direction,
    severityNow,
    severityPrev,
    pressureNow,
    pressurePrev,
    pressureDelta,
    confidence,
  };
}

/**
 * Compute every window in one pass for callers that want all three.
 */
export function computeAllWindowDeltas(
  events: ReadonlyArray<SignalEvent>,
  pivot: Date | string | null = null,
): Record<TrendWindow, WindowDelta> {
  const out = {} as Record<TrendWindow, WindowDelta>;
  for (const w of Object.keys(TREND_WINDOWS_MS) as TrendWindow[]) {
    out[w] = computeWindowDelta(events, w, pivot);
  }
  return out;
}

export interface PostureDriftSummary {
  /** Short label for badges: "stable" | "loosening" | "tightening". */
  posture: "stable" | "loosening" | "tightening" | "insufficient";
  /** One-line copy that is honest about the change without overclaiming. */
  copy: string;
  /** 0..1 confidence in the drift label. */
  confidence: number;
}

/**
 * Build a posture-drift one-liner from a window delta. The output uses
 * grounded language — "tightening", "loosening" — rather than implying
 * causality. When samples are too thin we say so.
 */
export function describePostureDrift(delta: WindowDelta): PostureDriftSummary {
  if (delta.current + delta.previous < 3) {
    return {
      posture: "insufficient",
      copy: "Insufficient activity to describe drift.",
      confidence: Math.min(0.3, delta.confidence),
    };
  }
  const pressureRatio =
    delta.pressurePrev > 0
      ? (delta.pressureNow - delta.pressurePrev) / delta.pressurePrev
      : delta.pressureNow > 0
        ? 1
        : 0;
  const window = TREND_WINDOW_LABEL[delta.window];
  if (Math.abs(pressureRatio) < 0.15 && Math.abs(delta.delta) <= 1) {
    return {
      posture: "stable",
      copy: `Posture stable across the last ${window} window.`,
      confidence: delta.confidence,
    };
  }
  if (delta.pressureDelta > 0) {
    const pct = Math.round(Math.abs(pressureRatio) * 100);
    return {
      posture: "tightening",
      copy: `Pressure tightening ${pct}% vs prior ${window} (${delta.current} now / ${delta.previous} prior).`,
      confidence: delta.confidence,
    };
  }
  const pct = Math.round(Math.abs(pressureRatio) * 100);
  return {
    posture: "loosening",
    copy: `Pressure loosening ${pct}% vs prior ${window} (${delta.current} now / ${delta.previous} prior).`,
    confidence: delta.confidence,
  };
}

/** Build a compact label like "+3 (24h)" or "-12% (7d)". */
export function formatDeltaChip(delta: WindowDelta): string {
  const sign = delta.delta > 0 ? "+" : delta.delta < 0 ? "" : "±";
  return `${sign}${delta.delta} ${TREND_WINDOW_LABEL[delta.window]}`;
}

function eventTimestampMs(event: SignalEvent): number | null {
  const iso = event.source_timestamp ?? event.ingested_at ?? null;
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

function resolvePivot(pivot: Date | string | null): number {
  if (pivot === null) return Date.now();
  if (pivot instanceof Date) return pivot.getTime();
  const t = Date.parse(pivot);
  return Number.isFinite(t) ? t : Date.now();
}

function directionFromDelta(delta: number): TrendDirection {
  if (delta > 0) return "up";
  if (delta < 0) return "down";
  return "flat";
}

function bounded(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}
