// Phase 12.3 — QueryPanel place intelligence rendering tests.
//
// Verifies that the panel surfaces:
//   * the resolved place card (name + type + scope label + confidence)
//   * a fallback notice when one is present
//   * the macro context block (currency, sectors, top commodity)
//   * place-driven dependency snippets
//
// The agent client is mocked so the test runs hermetically.

import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { QueryPanel } from "@/components/workspace/QueryPanel";
import type { AgentResponse } from "@/lib/intelligence/types";
import { useOverlayStore } from "@/store/useOverlayStore";

const mockQueryAgent = vi.fn();

vi.mock("@/lib/intelligence/client", () => ({
  queryAgent: (...args: unknown[]) => mockQueryAgent(...args),
}));

function tokyoResponse(): AgentResponse {
  return {
    query: "What happened in tokyo",
    interpreted_query: "What is happening in Tokyo?",
    intent: "general_retrieval",
    reasoning_mode: "rule_based",
    resolved_entities: [
      {
        kind: "city",
        id: "city:tokyo",
        name: "Tokyo",
        country_code: "JPN",
      },
      {
        kind: "country",
        id: "country:JPN",
        name: "Japan",
        country_code: "JPN",
      },
    ],
    answer: [
      { text: "Top live signals for Tokyo: …", evidence_ids: ["jp-storm"] },
    ],
    evidence: [
      {
        id: "jp-storm",
        title: "Severe storm warning issued across southern Japan",
        type: "weather",
        severity: "elevated",
        severity_score: 0.78,
        confidence: 0.7,
        source_timestamp: new Date().toISOString(),
        country_code: "JPN",
        country_name: "Japan",
        publisher: "test-publisher",
        url: "https://test.example/jp-storm",
      },
    ],
    follow_ups: [],
    related_countries: [],
    related_events: ["jp-storm"],
    confidence: 0.7,
    generated_at: new Date().toISOString(),
    resolved_place: {
      query: "What happened in tokyo",
      place_id: "city:tokyo",
      name: "Tokyo",
      type: "city",
      country_code: "JPN",
      country_name: "Japan",
      parent_id: "country:JPN",
      parent_name: "Japan",
      latitude: 35.6762,
      longitude: 139.6503,
      bbox: null,
      aliases: ["tokyo metropolis", "tokio"],
      tags: ["megacity", "financial-hub"],
      fallback_level: "nearby_city",
      is_fallback: false,
      confidence: 0.75,
      macro_context: {
        country_code: "JPN",
        currency_code: "JPY",
        logistics_hub: true,
        sector_tags: ["automotive", "electronics", "semiconductors"],
        top_export_commodity: "autos",
        top_export_sensitivity: 0.75,
        top_import_commodity: "crude_oil",
        top_import_sensitivity: 0.95,
        trade_dependence_score: 0.72,
        shipping_exposure: 0.88,
      },
      source: "place_resolver",
    },
    fallback_notice: null,
    scope_used: "exact_place",
    scope_confidence: 0.75,
    macro_context: {
      country_code: "JPN",
      currency_code: "JPY",
      logistics_hub: true,
      sector_tags: ["automotive", "electronics"],
      top_export_commodity: "autos",
      top_export_sensitivity: 0.75,
      top_import_commodity: "crude_oil",
      top_import_sensitivity: 0.95,
      trade_dependence_score: 0.72,
      shipping_exposure: 0.88,
    },
    place_dependencies: [
      {
        id: "place-city:tokyo:logistics",
        title: "Tokyo → logistics → supply chains",
        rationale: "Place → logistics template. Tokyo throughput drives supply chains.",
        nodes: [],
        edges: [],
        focal_event_id: "jp-storm",
        focal_country_code: "JPN",
        overall_confidence: 0.7,
      },
    ],
    time_context: null,
    compare_summary: null,
    workers_invoked: [],
    caveats: [],
    causal_chains: null,
    portfolio_impact: null,
  };
}

function redSeaFallbackResponse(): AgentResponse {
  return {
    query: "What happened in red sea",
    interpreted_query: "What is happening in Red Sea?",
    intent: "general_retrieval",
    reasoning_mode: "rule_based",
    resolved_entities: [
      {
        kind: "region",
        id: "region:red-sea",
        name: "Red Sea",
        country_code: null,
      },
    ],
    answer: [{ text: "Region-aggregated signal", evidence_ids: [] }],
    evidence: [],
    follow_ups: [],
    related_countries: [],
    related_events: [],
    confidence: 0.35,
    generated_at: new Date().toISOString(),
    resolved_place: {
      query: "What happened in red sea",
      place_id: "region:red-sea",
      name: "Red Sea",
      type: "region",
      country_code: null,
      country_name: null,
      parent_id: null,
      parent_name: null,
      latitude: 22.0,
      longitude: 38.0,
      bbox: [32.5, 12.5, 43.5, 30.0],
      aliases: ["red sea corridor"],
      tags: ["shipping-route"],
      fallback_level: "alias_substring",
      is_fallback: true,
      confidence: 0.8,
      macro_context: null,
      source: "place_resolver",
    },
    fallback_notice:
      "Red Sea is a multi-country region. Showing region-linked signals from contributing countries.",
    scope_used: "region",
    scope_confidence: 0.8,
    macro_context: null,
    place_dependencies: [],
    time_context: null,
    compare_summary: null,
    workers_invoked: [],
    caveats: [],
    causal_chains: null,
    portfolio_impact: null,
  };
}

beforeEach(() => {
  mockQueryAgent.mockReset();
  useOverlayStore.setState({
    isOpen: true,
    mode: "query",
    queryText: "",
    agentResponse: null,
    isLoading: false,
    error: null,
    queryResults: null,
  });
});

afterEach(() => {
  useOverlayStore.setState({
    isOpen: false,
    mode: "idle",
    queryText: "",
    agentResponse: null,
    isLoading: false,
    error: null,
  });
});

describe("QueryPanel — Phase 12.3 place intelligence", () => {
  it("renders resolved place card + macro context for Tokyo", async () => {
    mockQueryAgent.mockResolvedValueOnce(tokyoResponse());
    useOverlayStore.getState().openQuery("What happened in tokyo");

    render(<QueryPanel />);

    await waitFor(() => {
      expect(screen.getByTestId("resolved-place-card")).toBeTruthy();
    });
    const card = screen.getByTestId("resolved-place-card");
    expect(card.textContent).toContain("Tokyo");
    expect(card.textContent).toContain("City");
    expect(card.textContent).toContain("Exact place");
    expect(card.textContent).toContain("in Japan");

    const macro = screen.getByTestId("macro-context");
    expect(macro.textContent).toContain("JPY");
    expect(macro.textContent).toContain("Logistics hub");
    expect(macro.textContent?.toLowerCase()).toContain("autos");

    const deps = screen.getByTestId("place-dependencies");
    expect(deps.textContent).toContain("Tokyo");
  });

  it("renders fallback notice for region scope and suppresses macro context", async () => {
    mockQueryAgent.mockResolvedValueOnce(redSeaFallbackResponse());
    useOverlayStore.getState().openQuery("What happened in red sea");

    render(<QueryPanel />);

    await waitFor(() => {
      expect(screen.getByTestId("resolved-place-card")).toBeTruthy();
    });
    const card = screen.getByTestId("resolved-place-card");
    expect(card.textContent).toContain("Red Sea");
    expect(card.textContent).toContain("Region");
    expect(card.textContent).toContain("Region scope");
    expect(card.textContent).toContain("Fallback");
    expect(card.textContent).toContain("multi-country region");

    expect(screen.queryByTestId("macro-context")).toBeNull();
  });
});
