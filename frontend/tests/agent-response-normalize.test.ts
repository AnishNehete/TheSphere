import { describe, expect, it } from "vitest";

import { normalizeAgentResponse } from "@/lib/intelligence/client";
import type { AgentResponseWire } from "@/lib/intelligence/types";

// Phase 15A — regression: stale backend missing the Phase 12.3 place-intel
// fields used to crash QueryPanel via `.length` on undefined. The client
// normalizer must always produce an AgentResponse the UI can render without
// further null checks.
describe("normalizeAgentResponse", () => {
  it("fills place-intel defaults when the wire payload omits them", () => {
    const wire: AgentResponseWire = {
      query: "why is morocco elevated",
      interpreted_query: "Why is Morocco on elevated watch right now?",
      intent: "why_elevated",
      reasoning_mode: "rule_based",
      resolved_entities: [
        {
          kind: "country",
          id: "country:MAR",
          name: "Morocco",
          country_code: "MAR",
        },
      ],
      answer: [{ text: "Morocco is on watch.", evidence_ids: ["news-1"] }],
      evidence: [],
      follow_ups: [],
      related_countries: [],
      related_events: [],
      confidence: 0.79,
      generated_at: "2026-04-25T03:28:55Z",
      // Phase 12.3 fields intentionally missing.
    };
    const normalized = normalizeAgentResponse(wire);
    expect(normalized.place_dependencies).toEqual([]);
    expect(normalized.resolved_place).toBeNull();
    expect(normalized.fallback_notice).toBeNull();
    expect(normalized.scope_used).toBe("global");
    expect(normalized.scope_confidence).toBe(0);
    expect(normalized.macro_context).toBeNull();
  });

  it("preserves a complete wire payload", () => {
    const wire: AgentResponseWire = {
      query: "x",
      interpreted_query: "x",
      intent: "general_retrieval",
      reasoning_mode: "rule_based",
      resolved_entities: [],
      answer: [],
      evidence: [],
      follow_ups: [],
      related_countries: [],
      related_events: [],
      confidence: 0.5,
      generated_at: "2026-04-25T00:00:00Z",
      resolved_place: null,
      fallback_notice: "Used parent country.",
      scope_used: "country",
      scope_confidence: 0.6,
      place_dependencies: [],
      macro_context: null,
    };
    const normalized = normalizeAgentResponse(wire);
    expect(normalized.fallback_notice).toBe("Used parent country.");
    expect(normalized.scope_used).toBe("country");
    expect(normalized.scope_confidence).toBe(0.6);
  });

  it("survives an entirely empty payload", () => {
    const normalized = normalizeAgentResponse({} as AgentResponseWire);
    expect(normalized.answer).toEqual([]);
    expect(normalized.evidence).toEqual([]);
    expect(normalized.follow_ups).toEqual([]);
    expect(normalized.place_dependencies).toEqual([]);
    expect(normalized.intent).toBe("general_retrieval");
    expect(normalized.confidence).toBe(0);
    // Phase 18A.1 fields default to safe empty values.
    expect(normalized.time_context).toBeNull();
    expect(normalized.compare_summary).toBeNull();
    expect(normalized.workers_invoked).toEqual([]);
    expect(normalized.caveats).toEqual([]);
  });

  // Phase 18A.4 — preserve the new typed retrieval surface from the wire.
  it("preserves the 18A.1 retrieval surface when present", () => {
    const wire: AgentResponseWire = {
      query: "Compare Japan vs Korea last 24h",
      interpreted_query: "Compare Japan vs Korea (last 24h)",
      intent: "status_check",
      reasoning_mode: "rule_based",
      resolved_entities: [],
      answer: [],
      evidence: [],
      follow_ups: [],
      related_countries: [],
      related_events: [],
      confidence: 0.6,
      generated_at: "2026-04-25T00:00:00Z",
      time_context: {
        kind: "since",
        coverage: "windowed",
        label: "last 24h",
        answer_mode_label: "Last 24h",
        since: "2026-04-24T00:00:00Z",
        until: "2026-04-25T00:00:00Z",
        matched_event_count: 4,
        is_historical: false,
      },
      compare_summary: {
        requested: true,
        collapsed: false,
        mode: "vs",
        raw_phrase: " vs ",
        targets: [],
        headline: "Japan vs Korea",
      },
      workers_invoked: ["place", "compare", "timeline"],
      caveats: ["Compare resolution was partial."],
    };
    const normalized = normalizeAgentResponse(wire);
    expect(normalized.time_context?.coverage).toBe("windowed");
    expect(normalized.compare_summary?.mode).toBe("vs");
    expect(normalized.workers_invoked).toEqual(["place", "compare", "timeline"]);
    expect(normalized.caveats).toHaveLength(1);
  });
});
