import { beforeEach, describe, expect, it } from "vitest";

import type { CountryDetailResponse, SignalEvent } from "@/lib/intelligence/types";
import { useOverlayStore } from "@/store/useOverlayStore";

function makeEvent(overrides: Partial<SignalEvent> = {}): SignalEvent {
  return {
    id: "evt-1",
    dedupe_key: "dk-1",
    type: "news",
    sub_type: "article",
    title: "Port delays in Singapore",
    summary: "Container backlog widens.",
    description: null,
    severity: "watch",
    severity_score: 0.45,
    confidence: 0.6,
    status: "active",
    place: {
      latitude: 1.3521,
      longitude: 103.8198,
      country_code: "SGP",
      country_name: "Singapore",
      region: "asia",
      admin1: null,
      locality: null,
    },
    start_time: null,
    end_time: null,
    source_timestamp: "2026-04-21T12:00:00Z",
    ingested_at: "2026-04-21T12:05:00Z",
    sources: [],
    merged_from: [],
    tags: ["news", "country:sgp"],
    entities: [],
    score: null,
    properties: {},
    ...overrides,
  };
}

describe("useOverlayStore", () => {
  beforeEach(() => {
    useOverlayStore.getState().closeOverlay();
    useOverlayStore.getState().clearCompareTargets();
    useOverlayStore.setState({ latestSignals: [], latestStocks: [] });
  });

  it("opens country mode with uppercased ISO code and loading true", () => {
    useOverlayStore.getState().openCountry("sgp", "Singapore", "globe-click");
    const state = useOverlayStore.getState();
    expect(state.isOpen).toBe(true);
    expect(state.mode).toBe("country");
    expect(state.selectedCountryCode).toBe("SGP");
    expect(state.selectedCountryName).toBe("Singapore");
    expect(state.isLoading).toBe(true);
    expect(state.focusIntent).toBe("globe-click");
  });

  it("setCountryDetail stops loading and populates the detail", () => {
    useOverlayStore.getState().openCountry("sgp");
    const detail: CountryDetailResponse = {
      summary: {
        country_code: "SGP",
        country_name: "Singapore",
        updated_at: "2026-04-21T12:05:00Z",
        watch_score: 0.42,
        watch_delta: 0.05,
        watch_label: "watch",
        counts_by_category: { news: 3 },
        top_signals: [],
        headline_signal_id: null,
        confidence: 0.7,
        sources: [],
        summary: null,
      },
      events: [],
    };
    useOverlayStore.getState().setCountryDetail(detail);
    const state = useOverlayStore.getState();
    expect(state.isLoading).toBe(false);
    expect(state.countryDetail).toBe(detail);
    expect(state.selectedCountryName).toBe("Singapore");
  });

  it("opens event mode and pins the event's country", () => {
    const event = makeEvent();
    useOverlayStore.getState().openEvent(event, "signal-strip");
    const state = useOverlayStore.getState();
    expect(state.mode).toBe("event");
    expect(state.selectedEventId).toBe(event.id);
    expect(state.selectedEvent).toEqual(event);
    expect(state.selectedCountryCode).toBe("SGP");
    expect(state.focusIntent).toBe("signal-strip");
  });

  it("closeOverlay resets the panel but keeps latest feeds", () => {
    useOverlayStore.getState().setLatestSignals([makeEvent()]);
    useOverlayStore.getState().openCountry("usa");
    useOverlayStore.getState().closeOverlay();
    const state = useOverlayStore.getState();
    expect(state.isOpen).toBe(false);
    expect(state.mode).toBe("idle");
    expect(state.countryDetail).toBeNull();
    expect(state.selectedEvent).toBeNull();
    expect(state.latestSignals).toHaveLength(1);
  });

  it("openQuery sets loading when no pre-fetched results", () => {
    useOverlayStore.getState().openQuery("Singapore port");
    const state = useOverlayStore.getState();
    expect(state.mode).toBe("query");
    expect(state.queryText).toBe("Singapore port");
    expect(state.isLoading).toBe(true);
    expect(state.queryResults).toBeNull();
  });

  it("openQuery with pre-fetched results skips loading", () => {
    useOverlayStore.getState().openQuery("AAPL", {
      query: "AAPL",
      resolved_country_code: null,
      total: 0,
      hits: [],
    });
    const state = useOverlayStore.getState();
    expect(state.isLoading).toBe(false);
    expect(state.queryResults?.query).toBe("AAPL");
  });

  it("addCompareTarget caps at MAX_COMPARE_TARGETS and dedupes", () => {
    const { addCompareTarget } = useOverlayStore.getState();
    addCompareTarget({ kind: "country", id: "country:JPN", label: "Japan", country_code: "JPN" });
    addCompareTarget({ kind: "country", id: "country:JPN", label: "Japan", country_code: "JPN" });
    addCompareTarget({ kind: "country", id: "country:KOR", label: "South Korea", country_code: "KOR" });
    addCompareTarget({ kind: "country", id: "country:USA", label: "United States", country_code: "USA" });
    addCompareTarget({ kind: "country", id: "country:MAR", label: "Morocco", country_code: "MAR" });
    const state = useOverlayStore.getState();
    expect(state.compareTargets.map((t) => t.id)).toEqual([
      "country:JPN",
      "country:KOR",
      "country:USA",
    ]);
  });

  it("openCompare enters compare mode and marks loading when ≥2 targets", () => {
    const store = useOverlayStore.getState();
    store.addCompareTarget({ kind: "country", id: "country:JPN", label: "Japan", country_code: "JPN" });
    store.addCompareTarget({ kind: "country", id: "country:KOR", label: "South Korea", country_code: "KOR" });
    store.openCompare();
    const state = useOverlayStore.getState();
    expect(state.isOpen).toBe(true);
    expect(state.mode).toBe("compare");
    expect(state.isLoading).toBe(true);
  });

  it("pushCompareTarget appends and dedupes like addCompareTarget under cap", () => {
    const store = useOverlayStore.getState();
    store.pushCompareTarget({
      kind: "country",
      id: "country:JPN",
      label: "Japan",
      country_code: "JPN",
    });
    store.pushCompareTarget({
      kind: "country",
      id: "country:JPN",
      label: "Japan",
      country_code: "JPN",
    });
    store.pushCompareTarget({
      kind: "country",
      id: "country:KOR",
      label: "South Korea",
      country_code: "KOR",
    });
    expect(useOverlayStore.getState().compareTargets.map((t) => t.id)).toEqual([
      "country:JPN",
      "country:KOR",
    ]);
  });

  it("pushCompareTarget rolls oldest off when at MAX_COMPARE_TARGETS", () => {
    const store = useOverlayStore.getState();
    store.pushCompareTarget({
      kind: "country",
      id: "country:JPN",
      label: "Japan",
      country_code: "JPN",
    });
    store.pushCompareTarget({
      kind: "country",
      id: "country:KOR",
      label: "South Korea",
      country_code: "KOR",
    });
    store.pushCompareTarget({
      kind: "country",
      id: "country:USA",
      label: "United States",
      country_code: "USA",
    });
    store.pushCompareTarget({
      kind: "country",
      id: "country:MAR",
      label: "Morocco",
      country_code: "MAR",
    });
    expect(useOverlayStore.getState().compareTargets.map((t) => t.id)).toEqual([
      "country:KOR",
      "country:USA",
      "country:MAR",
    ]);
  });

  it("removeCompareTarget + clearCompareTargets", () => {
    const store = useOverlayStore.getState();
    store.addCompareTarget({ kind: "country", id: "country:JPN", label: "Japan", country_code: "JPN" });
    store.addCompareTarget({ kind: "country", id: "country:KOR", label: "South Korea", country_code: "KOR" });
    store.removeCompareTarget("country:JPN");
    expect(useOverlayStore.getState().compareTargets).toHaveLength(1);
    store.clearCompareTargets();
    expect(useOverlayStore.getState().compareTargets).toHaveLength(0);
  });

  it("setAgentResponse stores response and clears loading", () => {
    useOverlayStore.getState().openQuery("Why is Morocco elevated?");
    useOverlayStore.getState().setAgentResponse({
      query: "Why is Morocco elevated?",
      interpreted_query: "Why is Morocco elevated?",
      intent: "why_elevated",
      reasoning_mode: "rule_based",
      resolved_entities: [],
      answer: [{ text: "Test", evidence_ids: ["evt-1"] }],
      evidence: [],
      follow_ups: [],
      related_countries: [],
      related_events: [],
      confidence: 0.5,
      generated_at: new Date().toISOString(),
      resolved_place: null,
      fallback_notice: null,
      scope_used: "global",
      scope_confidence: 0,
      place_dependencies: [],
      macro_context: null,
      time_context: null,
      compare_summary: null,
      workers_invoked: [],
      caveats: [],
      causal_chains: null,
      portfolio_impact: null,
    });
    const state = useOverlayStore.getState();
    expect(state.agentResponse?.intent).toBe("why_elevated");
    expect(state.isLoading).toBe(false);
  });
});
