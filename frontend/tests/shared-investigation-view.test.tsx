import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { SharedInvestigationView } from "@/components/workspace/SharedInvestigationView";
import type { SavedInvestigationWire } from "@/lib/intelligence/investigations";
import type {
  MarketNarrative,
  MarketPostureResponse,
} from "@/lib/intelligence/types";

const CAPTURED_AT = "2026-04-26T12:00:00Z";

function postureFixture(): MarketPostureResponse {
  return {
    symbol: "AAPL",
    asset_class: "equities",
    posture: "buy",
    posture_label: "Buy",
    tilt: 0.42,
    effective_tilt: 0.31,
    confidence: 0.74,
    components: {
      technical: 0.5,
      semantic: 0.3,
      macro: null,
      uncertainty: 0.26,
    },
    drivers: [
      {
        component: "technical",
        label: "50DMA reclaim",
        signed_contribution: 0.25,
        rationale: "Price reclaimed the 50-day moving average.",
        evidence_ids: ["evt-tech-1"],
      },
    ],
    caveats: ["Light volume"],
    freshness_seconds: 180,
    as_of: CAPTURED_AT,
    notes: [],
    provider: "alphavantage",
    provider_health: "live",
    semantic_pressure: null,
  };
}

function narrativeFixture(): MarketNarrative {
  return {
    symbol: "AAPL",
    narrative: "The current posture leans constructive on technical reclaim.",
    cited_driver_ids: ["evt-tech-1"],
    narrative_caveats: [],
    posture_alignment_check: "aligned",
    source: "deterministic",
    generated_at: CAPTURED_AT,
  };
}

function record(): SavedInvestigationWire {
  return {
    id: "inv_xyz",
    name: "AAPL deep dive",
    created_at: CAPTURED_AT,
    share_token: "tok_abc",
    snapshot: {
      workspace_mode: "investigate",
      selection: {
        country_code: "USA",
        country_name: "United States",
        event_id: null,
        event_summary: null,
        market_symbol: "AAPL",
        market_asset_class: "equities",
      },
      market_posture: postureFixture(),
      market_narrative: narrativeFixture(),
      portfolio_id: null,
      portfolio_as_of: null,
      compare_targets: [
        {
          kind: "country",
          id: "USA",
          label: "United States",
          country_code: "USA",
        },
      ],
      caveats: ["Light volume"],
      provider_health_at_capture: "live",
      freshness_seconds_at_capture: 180,
      captured_at: CAPTURED_AT,
    },
  };
}

describe("SharedInvestigationView", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-26T12:15:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  it("renders the read-only banner with captured_at + age + provider health", () => {
    render(<SharedInvestigationView record={record()} />);

    expect(screen.getByText("Read-only snapshot")).toBeTruthy();
    expect(
      screen.getByTestId("shared-age").textContent,
    ).toBe("15m ago");
    expect(
      screen.getByTestId("shared-provider").textContent,
    ).toContain("live at capture");
    expect(
      screen.getByTestId("shared-captured-at").textContent,
    ).toContain("Captured");
  });

  it("shows the frozen posture envelope from the snapshot", () => {
    render(<SharedInvestigationView record={record()} />);
    expect(screen.getByText("Buy")).toBeTruthy();
    expect(screen.getByText("AAPL")).toBeTruthy();
    expect(screen.getByText("50DMA reclaim")).toBeTruthy();
    expect(screen.getByText(/conf 74%/)).toBeTruthy();
  });

  it("never silently fetches live data when mounted", () => {
    const fetchSpy = vi.fn();
    const originalFetch = global.fetch;
    global.fetch = fetchSpy as unknown as typeof fetch;
    try {
      render(<SharedInvestigationView record={record()} />);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("renders the frozen narrative + alignment metadata", () => {
    render(<SharedInvestigationView record={record()} />);
    expect(
      screen.getByText(/leans constructive on technical reclaim/),
    ).toBeTruthy();
    expect(screen.getByText(/Source: deterministic/)).toBeTruthy();
  });

  it("renders the compare set", () => {
    render(<SharedInvestigationView record={record()} />);
    expect(screen.getByText("Compare set")).toBeTruthy();
    expect(screen.getByText("United States")).toBeTruthy();
  });

  it("surfaces caveats with the at-capture framing", () => {
    render(<SharedInvestigationView record={record()} />);
    expect(screen.getByText("Caveats at capture")).toBeTruthy();
    // "Light volume" appears once inside the posture block and once in
    // the at-capture caveats list.
    expect(screen.getAllByText("Light volume").length).toBeGreaterThanOrEqual(
      2,
    );
  });
});
