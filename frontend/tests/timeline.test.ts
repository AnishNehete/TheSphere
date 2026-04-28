// Wave 15C — timeline / replay engine tests.
//
// Validates:
//   - "what changed since X" honestly counts new / escalated / resolved
//   - replay copy never implies live language when an as-of cursor is set
//   - accumulation buckets are back-to-back and contiguous

import { describe, expect, it } from "vitest";

import {
  bucketAccumulation,
  replayCopy,
  summariseChangesSince,
} from "@/lib/intelligence/timeline";
import type { SignalEvent, SignalSeverity, SignalStatus } from "@/lib/intelligence/types";

function makeEvent(
  iso: string,
  severity: SignalSeverity = "watch",
  status: SignalStatus = "active",
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
    status,
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

describe("summariseChangesSince", () => {
  const pivot = new Date("2026-04-25T12:00:00Z");
  const offset = (ms: number) => new Date(pivot.getTime() - ms).toISOString();

  it("counts escalated and resolved separately", () => {
    const events: SignalEvent[] = [
      makeEvent(offset(60 * 60 * 1000), "critical"),
      makeEvent(offset(2 * 60 * 60 * 1000), "elevated"),
      makeEvent(offset(3 * 60 * 60 * 1000), "watch", "resolved"),
      makeEvent(offset(40 * 60 * 60 * 1000), "elevated"), // outside 24h
    ];
    const summary = summariseChangesSince(events, "24h", pivot);
    expect(summary.newCount).toBe(3);
    expect(summary.escalatedCount).toBe(2);
    expect(summary.resolvedCount).toBe(1);
    expect(summary.copy).toContain("3");
    expect(summary.copy).toContain("elevated-or-critical");
    expect(summary.copy).toContain("resolved");
  });

  it("uses replay-aware copy when pivot is set", () => {
    const summary = summariseChangesSince([], "24h", pivot);
    expect(summary.newCount).toBe(0);
    expect(summary.copy).toContain("as-of cursor");
  });

  it("uses live copy when pivot is null", () => {
    const summary = summariseChangesSince([], "24h", null);
    expect(summary.copy).toContain("last 24h");
    expect(summary.copy).not.toContain("as-of");
  });

  it("ranks top drivers by severity then recency", () => {
    const events: SignalEvent[] = [
      makeEvent(offset(60 * 60 * 1000), "watch"),
      makeEvent(offset(2 * 60 * 60 * 1000), "critical"),
      makeEvent(offset(3 * 60 * 60 * 1000), "elevated"),
      makeEvent(offset(4 * 60 * 60 * 1000), "info"),
    ];
    const summary = summariseChangesSince(events, "24h", pivot);
    expect(summary.topDrivers[0].severity).toBe("critical");
    expect(summary.topDrivers[1].severity).toBe("elevated");
  });
});

describe("bucketAccumulation", () => {
  const pivot = new Date("2026-04-25T12:00:00Z");

  it("returns N back-to-back buckets ending at the pivot", () => {
    const buckets = bucketAccumulation([], "24h", pivot, 4);
    expect(buckets).toHaveLength(4);
    for (let i = 1; i < buckets.length; i++) {
      expect(buckets[i].windowStartIso).toBe(buckets[i - 1].windowEndIso);
    }
    expect(buckets[buckets.length - 1].windowEndIso).toBe(pivot.toISOString());
  });

  it("counts events into the right bucket only", () => {
    const events: SignalEvent[] = [
      makeEvent(new Date(pivot.getTime() - 60 * 60 * 1000).toISOString()),
      makeEvent(new Date(pivot.getTime() - 25 * 60 * 60 * 1000).toISOString()),
    ];
    const buckets = bucketAccumulation(events, "24h", pivot, 3);
    expect(buckets[2].count).toBe(1);
    expect(buckets[1].count).toBe(1);
    expect(buckets[0].count).toBe(0);
  });
});

describe("replayCopy", () => {
  it("returns live copy when no asOf", () => {
    expect(replayCopy(null)).toContain("Live");
  });

  it("returns replay copy when asOf is set", () => {
    expect(replayCopy("2026-04-01T10:00:00Z")).toContain("Replay");
    expect(replayCopy("2026-04-01T10:00:00Z")).toContain("2026-04-01");
  });
});
