// Phase 17A.2 — MarketPostureCard renders the grounded posture surface.
//
// Verifies:
//   1. Loading state shows while the request is in flight.
//   2. Posture label, confidence, provider chip surface from the wire shape.
//   3. Semantic drivers list renders top-N events with direction arrows.
//   4. Caveats list renders honestly when the engine returns them.
//   5. Provider health "unsupported" is rendered as a "Not covered" chip.

import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MarketPostureCard } from "@/components/workspace/MarketPostureCard";
import * as client from "@/lib/intelligence/client";
import type {
  MarketNarrativeResponse,
  MarketPostureResponse,
} from "@/lib/intelligence/types";


function fakePosture(overrides: Partial<MarketPostureResponse> = {}): MarketPostureResponse {
  return {
    symbol: "AAPL",
    asset_class: "equities",
    posture: "buy",
    posture_label: "Buy",
    tilt: 0.42,
    effective_tilt: 0.31,
    confidence: 0.74,
    components: {
      technical: 0.6,
      semantic: -0.2,
      macro: 0.1,
      uncertainty: 0.26,
    },
    drivers: [],
    caveats: ["Realized 30d vol annualized = 0.41 (elevated regime)."],
    freshness_seconds: 60,
    as_of: "2026-04-26T00:00:00Z",
    notes: [],
    provider: "alphavantage+cache",
    provider_health: "live",
    semantic_pressure: {
      symbol: "AAPL",
      asset_class: "equities",
      semantic_score: -0.2,
      semantic_direction: "bearish",
      semantic_confidence: 0.65,
      matched_event_count: 4,
      recency_skew_hours: 6.0,
      top_semantic_drivers: [
        {
          event_id: "e1",
          title: "AAPL supply chain hit by typhoon",
          publisher: "Reuters",
          severity_score: 0.8,
          age_hours: 4,
          direction: "bearish",
          contribution: -0.42,
          reliability: 0.9,
        },
        {
          event_id: "e2",
          title: "AAPL warned on Q3 demand",
          publisher: "Bloomberg",
          severity_score: 0.7,
          age_hours: 12,
          direction: "bearish",
          contribution: -0.28,
          reliability: 0.9,
        },
      ],
      semantic_caveats: [],
    },
    ...overrides,
  };
}


describe("MarketPostureCard", () => {
  // typed as the function shape so .mockResolvedValueOnce / .mockReturnValueOnce
  // remain callable under TypeScript's strict spy generics.
  let postureMock: ReturnType<typeof vi.fn<typeof client.getMarketPosture>>;
  let narrativeMock: ReturnType<typeof vi.fn<typeof client.getMarketNarrative>>;

  beforeEach(() => {
    postureMock = vi.spyOn(client, "getMarketPosture") as unknown as typeof postureMock;
    // Default: narrative never resolves so the deterministic lead stays.
    // Individual tests override this with mockResolvedValueOnce.
    narrativeMock = vi.spyOn(
      client,
      "getMarketNarrative",
    ) as unknown as typeof narrativeMock;
    narrativeMock.mockReturnValue(new Promise(() => undefined));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows a loading affordance while the request is in flight", async () => {
    let resolveFn: (p: MarketPostureResponse) => void = () => undefined;
    const pending = new Promise<MarketPostureResponse>((r) => {
      resolveFn = r;
    });
    postureMock.mockReturnValueOnce(pending);
    render(<MarketPostureCard symbol="AAPL" />);
    expect(screen.getByTestId("market-posture-loading")).toBeTruthy();
    resolveFn(fakePosture());
    await waitFor(() => {
      expect(screen.getByTestId("market-posture-label").textContent).toBe("Buy");
    });
  });

  it("renders posture label, confidence, and provider chip from the wire shape", async () => {
    postureMock.mockResolvedValueOnce(fakePosture());
    render(<MarketPostureCard symbol="AAPL" />);

    await waitFor(() => {
      expect(screen.getByTestId("market-posture-label").textContent).toBe("Buy");
    });
    expect(screen.getByTestId("market-posture-confidence").textContent).toContain(
      "74%",
    );
    const providerChip = screen.getByTestId("market-posture-provider");
    expect(providerChip.textContent).toContain("Alpha Vantage");
    expect(providerChip.className).toContain("ws-posture__provider--live");
  });

  it("renders top-N semantic drivers with direction arrows", async () => {
    postureMock.mockResolvedValueOnce(fakePosture());
    render(<MarketPostureCard symbol="AAPL" />);

    await waitFor(() => {
      expect(screen.getByTestId("market-posture-drivers")).toBeTruthy();
    });
    const drivers = screen
      .getByTestId("market-posture-drivers")
      .querySelectorAll(".ws-posture__driver");
    expect(drivers.length).toBe(2);
    expect(drivers[0].getAttribute("data-direction")).toBe("bearish");
  });

  it("renders caveats from the typed envelope", async () => {
    postureMock.mockResolvedValueOnce(fakePosture());
    render(<MarketPostureCard symbol="AAPL" />);
    await waitFor(() => {
      const block = screen.getByTestId("market-posture-caveats");
      expect(block.textContent).toContain("elevated regime");
    });
  });

  it("lead summary explains 'unsupported' provider state without directional language (Phase 17A.3)", async () => {
    postureMock.mockResolvedValueOnce(
      fakePosture({
        provider_health: "unsupported",
        semantic_pressure: null,
        components: {
          technical: null,
          semantic: null,
          macro: null,
          uncertainty: 0.95,
        },
        posture: "neutral",
        posture_label: "Neutral",
      }),
    );
    render(<MarketPostureCard symbol="ES" />);
    await waitFor(() => {
      const lead = screen.getByTestId("market-posture-lead");
      expect(lead.textContent?.toLowerCase()).toContain("outside provider coverage");
    });
  });

  it("lead summary calls out 'provider not configured' (Phase 17A.3)", async () => {
    postureMock.mockResolvedValueOnce(
      fakePosture({
        provider_health: "unconfigured",
        provider: "unconfigured",
        semantic_pressure: null,
        components: {
          technical: null,
          semantic: null,
          macro: null,
          uncertainty: 1.0,
        },
        posture: "neutral",
        posture_label: "Neutral",
      }),
    );
    render(<MarketPostureCard symbol="AAPL" />);
    await waitFor(() => {
      const lead = screen.getByTestId("market-posture-lead");
      expect(lead.textContent?.toLowerCase()).toContain("not configured");
    });
  });

  it("renders 'Not covered' chip when provider_health is unsupported", async () => {
    postureMock.mockResolvedValueOnce(
      fakePosture({
        provider_health: "unsupported",
        semantic_pressure: null,
        caveats: ["Provider 'alphavantage' does not cover this symbol's asset class — posture is technical-/macro-blind."],
        components: {
          technical: null,
          semantic: null,
          macro: null,
          uncertainty: 0.9,
        },
        posture: "neutral",
        posture_label: "Neutral",
      }),
    );
    render(<MarketPostureCard symbol="ES" />);
    await waitFor(() => {
      const chip = screen.getByTestId("market-posture-provider");
      expect(chip.textContent).toContain("Not covered");
    });
  });

  it("renders a deterministic call summary lead line for a directional posture", async () => {
    postureMock.mockResolvedValueOnce(fakePosture());
    render(<MarketPostureCard symbol="AAPL" />);
    await waitFor(() => {
      const lead = screen.getByTestId("market-posture-lead");
      // technical (0.6) leads over semantic (-0.2) and macro (0.1)
      expect(lead.textContent).toContain("Buy call");
      expect(lead.textContent?.toLowerCase()).toContain("technical leads");
      expect(lead.textContent).toContain("74%");
    });
  });

  it("renders 'low conviction' lead copy when confidence is under 0.4", async () => {
    postureMock.mockResolvedValueOnce(
      fakePosture({
        posture: "buy",
        posture_label: "Buy",
        confidence: 0.32,
        components: {
          technical: 0.18,
          semantic: 0.05,
          macro: 0.0,
          uncertainty: 0.68,
        },
      }),
    );
    render(<MarketPostureCard symbol="AAPL" />);
    await waitFor(() => {
      const lead = screen.getByTestId("market-posture-lead");
      expect(lead.textContent?.toLowerCase()).toContain("low");
    });
  });

  it("renders neutral copy when posture is 'neutral'", async () => {
    postureMock.mockResolvedValueOnce(
      fakePosture({
        posture: "neutral",
        posture_label: "Neutral",
        confidence: 0.55,
        components: {
          technical: 0.05,
          semantic: 0.0,
          macro: -0.02,
          uncertainty: 0.45,
        },
      }),
    );
    render(<MarketPostureCard symbol="AAPL" />);
    await waitFor(() => {
      const lead = screen.getByTestId("market-posture-lead");
      expect(lead.textContent?.toLowerCase()).toContain("neutral");
    });
  });

  it("swaps deterministic lead for the agentic narrative when one is returned (Phase 17A.3)", async () => {
    postureMock.mockResolvedValueOnce(fakePosture());
    const narrativeBody: MarketNarrativeResponse = {
      posture: fakePosture(),
      narrative: {
        symbol: "AAPL",
        narrative:
          "AAPL is leaning bullish on technical strength while news pressure stays mixed; the drivers panel below explains why.",
        cited_driver_ids: ["e1"],
        narrative_caveats: ["News context still mixed."],
        posture_alignment_check: "aligned",
        source: "anthropic",
        generated_at: "2026-04-26T00:00:00Z",
      },
    };
    narrativeMock.mockReset();
    narrativeMock.mockResolvedValueOnce(narrativeBody);

    render(<MarketPostureCard symbol="AAPL" />);

    await waitFor(() => {
      const lead = screen.getByTestId("market-posture-lead");
      expect(lead.textContent).toContain("leaning bullish");
      expect(lead.getAttribute("data-source")).toBe("anthropic");
    });
    const source = screen.getByTestId("market-posture-lead-source");
    expect(source.textContent?.toLowerCase()).toContain("ai summary");
  });

  it("keeps the deterministic lead when narrative call fails (Phase 17A.3)", async () => {
    postureMock.mockResolvedValueOnce(fakePosture());
    narrativeMock.mockReset();
    narrativeMock.mockRejectedValueOnce(new Error("upstream-down"));

    render(<MarketPostureCard symbol="AAPL" />);

    await waitFor(() => {
      const lead = screen.getByTestId("market-posture-lead");
      expect(lead.textContent).toContain("Buy call");
      expect(lead.getAttribute("data-source")).toBe("deterministic");
    });
    expect(screen.queryByTestId("market-posture-lead-source")).toBeNull();
  });

  it("does not call the narrative endpoint for unsupported provider health (Phase 17A.3)", async () => {
    postureMock.mockResolvedValueOnce(
      fakePosture({
        provider_health: "unsupported",
        components: {
          technical: null,
          semantic: null,
          macro: null,
          uncertainty: 0.95,
        },
        posture: "neutral",
        posture_label: "Neutral",
      }),
    );
    narrativeMock.mockReset();
    narrativeMock.mockResolvedValue({} as unknown as MarketNarrativeResponse);

    render(<MarketPostureCard symbol="ES" />);

    await waitFor(() => {
      // Lead summary renders the deterministic unsupported copy.
      const lead = screen.getByTestId("market-posture-lead");
      expect(lead.textContent?.toLowerCase()).toContain("outside provider coverage");
    });
    expect(narrativeMock).not.toHaveBeenCalled();
  });

  it("falls back to error state on fetch failure", async () => {
    postureMock.mockRejectedValueOnce(new Error("boom"));
    render(<MarketPostureCard symbol="AAPL" />);
    await waitFor(() => {
      expect(screen.getByTestId("market-posture-error")).toBeTruthy();
    });
  });
});
