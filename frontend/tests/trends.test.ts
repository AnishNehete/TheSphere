// Wave 15C — trend / delta engine tests.
//
// The math is the operator-grade contract for every trend chip in the
// workspace. We assert that:
//   - windows are exclusive of the pivot (no future bars leaking into "now")
//   - prior-window comparison is the equal-length window ending at the
//     start of the current one
//   - direction respects the delta sign with a flat tie-break at zero
//   - confidence is bounded to [0, 0.9]
//   - posture-drift copy is honest about thin samples

import { describe, expect, it } from "vitest";

import {
  computeAllWindowDeltas,
  computeWindowDelta,
  describePostureDrift,
  formatDeltaChip,
  TREND_WINDOWS_MS,
} from "@/lib/intelligence/trends";
import type { SignalEvent, SignalSeverity } from "@/lib/intelligence/types";

function makeEvent(
  iso: string,
  severity: SignalSeverity = "watch",
): SignalEvent {
  return {
    id: iso,
    dedupe_key: iso,
    type: "news",
    sub_type: null,
    title: iso,
    summary: "",
    description: null,
    severity,
    severity_score: 0.5,
    confidence: 0.5,
    status: "active",
    place: {
      latitude: null,
      longitude: null,
      country_code: null,
      country_name: null,
      region: null,
      admin1: null,
      locality: null,
    },
    start_time: null,
    end_time: null,
    source_timestamp: iso,
    ingested_at: iso,
    sources: [],
    merged_from: [],
    tags: [],
    entities: [],
    score: null,
    properties: {},
  };
}

function offsetIso(pivot: Date, ms: number): string {
  return new Date(pivot.getTime() - ms).toISOString();
}

describe("computeWindowDelta", () => {
  const pivot = new Date("2026-04-25T12:00:00Z");

  it("counts only events at-or-before the pivot", () => {
    const events: SignalEvent[] = [
      makeEvent(offsetIso(pivot, 1 * 60 * 60 * 1000)),
      makeEvent(new Date(pivot.getTime() + 60 * 60 * 1000).toISOString()),
    ];
    const delta = computeWindowDelta(events, "24h", pivot);
    expect(delta.current).toBe(1);
  });

  it("partitions into current and prior equal-length windows", () => {
    const events: SignalEvent[] = [
      makeEvent(offsetIso(pivot, 2 * 60 * 60 * 1000)), // current
      makeEvent(offsetIso(pivot, 12 * 60 * 60 * 1000)), // current
      makeEvent(offsetIso(pivot, 30 * 60 * 60 * 1000)), // prior 24h
      makeEvent(offsetIso(pivot, 50 * 60 * 60 * 1000)), // older still
    ];
    const delta = computeWindowDelta(events, "24h", pivot);
    expect(delta.current).toBe(2);
    expect(delta.previous).toBe(1);
    expect(delta.delta).toBe(1);
    expect(delta.direction).toBe("up");
  });

  it("flags flat direction when current matches prior", () => {
    const events: SignalEvent[] = [
      makeEvent(offsetIso(pivot, 60 * 60 * 1000)),
      makeEvent(offsetIso(pivot, 30 * 60 * 60 * 1000)),
    ];
    const delta = computeWindowDelta(events, "24h", pivot);
    expect(delta.delta).toBe(0);
    expect(delta.direction).toBe("flat");
  });

  it("weights critical events more heavily in pressure", () => {
    const events: SignalEvent[] = [
      makeEvent(offsetIso(pivot, 60 * 60 * 1000), "critical"),
      makeEvent(offsetIso(pivot, 30 * 60 * 60 * 1000), "info"),
    ];
    const delta = computeWindowDelta(events, "24h", pivot);
    expect(delta.pressureNow).toBeGreaterThan(delta.pressurePrev);
    expect(delta.pressureDelta).toBeGreaterThan(0);
  });

  it("bounds confidence to [0, 0.9]", () => {
    const events: SignalEvent[] = Array.from({ length: 1000 }, (_, i) =>
      makeEvent(offsetIso(pivot, (i + 1) * 60 * 1000)),
    );
    const delta = computeWindowDelta(events, "7d", pivot);
    expect(delta.confidence).toBeGreaterThanOrEqual(0);
    expect(delta.confidence).toBeLessThanOrEqual(0.9);
  });

  it("computes all canonical windows in one pass", () => {
    const events: SignalEvent[] = [
      makeEvent(offsetIso(pivot, 60 * 60 * 1000)),
      makeEvent(offsetIso(pivot, 5 * 24 * 60 * 60 * 1000)),
    ];
    const all = computeAllWindowDeltas(events, pivot);
    expect(all["24h"].current).toBe(1);
    expect(all["7d"].current).toBe(2);
    expect(all["30d"].current).toBe(2);
    expect(all["7d"].windowMs).toBe(TREND_WINDOWS_MS["7d"]);
  });
});

describe("describePostureDrift", () => {
  const pivot = new Date("2026-04-25T12:00:00Z");

  it("returns insufficient when sample is thin", () => {
    const events: SignalEvent[] = [
      makeEvent(offsetIso(pivot, 60 * 60 * 1000)),
    ];
    const delta = computeWindowDelta(events, "7d", pivot);
    const drift = describePostureDrift(delta);
    expect(drift.posture).toBe("insufficient");
  });

  it("returns tightening when pressure is rising on a non-thin sample", () => {
    const events: SignalEvent[] = [
      makeEvent(offsetIso(pivot, 60 * 60 * 1000), "critical"),
      makeEvent(offsetIso(pivot, 2 * 60 * 60 * 1000), "elevated"),
      makeEvent(offsetIso(pivot, 3 * 60 * 60 * 1000), "elevated"),
      makeEvent(offsetIso(pivot, 9 * 24 * 60 * 60 * 1000), "info"),
    ];
    const delta = computeWindowDelta(events, "7d", pivot);
    const drift = describePostureDrift(delta);
    expect(drift.posture).toBe("tightening");
    expect(drift.copy).toContain("tightening");
  });

  it("returns loosening when pressure is falling", () => {
    const events: SignalEvent[] = [
      makeEvent(offsetIso(pivot, 60 * 60 * 1000), "info"),
      makeEvent(offsetIso(pivot, 8 * 24 * 60 * 60 * 1000), "critical"),
      makeEvent(offsetIso(pivot, 9 * 24 * 60 * 60 * 1000), "elevated"),
      makeEvent(offsetIso(pivot, 10 * 24 * 60 * 60 * 1000), "elevated"),
    ];
    const delta = computeWindowDelta(events, "7d", pivot);
    const drift = describePostureDrift(delta);
    expect(drift.posture).toBe("loosening");
  });
});

describe("formatDeltaChip", () => {
  it("shows a + sign for positive deltas", () => {
    const chip = formatDeltaChip({
      window: "24h",
      windowMs: TREND_WINDOWS_MS["24h"],
      current: 5,
      previous: 2,
      delta: 3,
      direction: "up",
      severityNow: { info: 0, watch: 0, elevated: 0, critical: 0 },
      severityPrev: { info: 0, watch: 0, elevated: 0, critical: 0 },
      pressureNow: 0,
      pressurePrev: 0,
      pressureDelta: 0,
      confidence: 0.5,
    });
    expect(chip).toBe("+3 24h");
  });

  it("uses ± for zero", () => {
    const chip = formatDeltaChip({
      window: "7d",
      windowMs: TREND_WINDOWS_MS["7d"],
      current: 5,
      previous: 5,
      delta: 0,
      direction: "flat",
      severityNow: { info: 0, watch: 0, elevated: 0, critical: 0 },
      severityPrev: { info: 0, watch: 0, elevated: 0, critical: 0 },
      pressureNow: 0,
      pressurePrev: 0,
      pressureDelta: 0,
      confidence: 0.5,
    });
    expect(chip.startsWith("±")).toBe(true);
  });
});
