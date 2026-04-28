import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildShareUrl,
  buildSnapshotFromStores,
  captureWith,
  describeAge,
  restoreSnapshotIntoStores,
} from "@/lib/intelligence/investigations";
import type {
  MarketNarrative,
  MarketPostureResponse,
} from "@/lib/intelligence/types";
import { useOverlayStore } from "@/store/useOverlayStore";
import { useWorkspaceModeStore } from "@/store/useWorkspaceModeStore";

const FROZEN_NOW = new Date("2026-04-26T12:00:00Z");

function resetStores(): void {
  useOverlayStore.getState().closeOverlay();
  useOverlayStore.getState().clearCompareTargets();
  useOverlayStore.getState().clearPortfolio();
  useWorkspaceModeStore.setState({ mode: "investigate", explicitlySet: false });
}

function postureFixture(symbol: string = "AAPL"): MarketPostureResponse {
  return {
    symbol,
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
    as_of: FROZEN_NOW.toISOString(),
    notes: [],
    provider: "alphavantage",
    provider_health: "live",
    semantic_pressure: null,
  };
}

function narrativeFixture(symbol: string = "AAPL"): MarketNarrative {
  return {
    symbol,
    narrative: "The current posture leans constructive on technical reclaim.",
    cited_driver_ids: ["evt-tech-1"],
    narrative_caveats: ["Provider degraded earlier"],
    posture_alignment_check: "aligned",
    source: "deterministic",
    generated_at: FROZEN_NOW.toISOString(),
  };
}

describe("buildSnapshotFromStores", () => {
  beforeEach(() => resetStores());
  afterEach(() => resetStores());

  it("captures workspace mode + selection from current canonical state", () => {
    useOverlayStore
      .getState()
      .openCountry("USA", "United States", "deep-link");
    useOverlayStore.getState().selectMarketSymbol("AAPL", "equities");

    const snapshot = buildSnapshotFromStores({ capturedAt: FROZEN_NOW });

    expect(snapshot.workspace_mode).toBe("investigate");
    expect(snapshot.selection.country_code).toBe("USA");
    expect(snapshot.selection.country_name).toBe("United States");
    expect(snapshot.selection.market_symbol).toBe("AAPL");
    expect(snapshot.selection.market_asset_class).toBe("equities");
    expect(snapshot.captured_at).toBe(FROZEN_NOW.toISOString());
    expect(snapshot.compare_targets).toEqual([]);
    expect(snapshot.market_posture).toBeNull();
  });

  it("captures the live compare set", () => {
    useOverlayStore
      .getState()
      .addCompareTarget({
        kind: "country",
        id: "USA",
        label: "United States",
        country_code: "USA",
      });
    useOverlayStore.getState().addCompareTarget({
      kind: "country",
      id: "JPN",
      label: "Japan",
      country_code: "JPN",
    });

    const snapshot = buildSnapshotFromStores({ capturedAt: FROZEN_NOW });
    expect(snapshot.compare_targets.map((t) => t.id)).toEqual(["USA", "JPN"]);
  });
});

describe("captureWith", () => {
  beforeEach(() => resetStores());
  afterEach(() => resetStores());

  it("freezes posture + narrative envelopes verbatim and merges caveats", () => {
    useOverlayStore.getState().selectMarketSymbol("AAPL", "equities");
    const posture = postureFixture();
    const narrative = narrativeFixture();

    const snapshot = captureWith(
      {
        marketPosture: posture,
        marketNarrative: narrative,
        extraCaveats: ["Manual override"],
      },
      { capturedAt: FROZEN_NOW },
    );

    expect(snapshot.market_posture).toEqual(posture);
    expect(snapshot.market_narrative).toEqual(narrative);
    expect(snapshot.provider_health_at_capture).toBe("live");
    expect(snapshot.freshness_seconds_at_capture).toBe(180);
    // Dedupe across posture + narrative + extra
    expect(snapshot.caveats.sort()).toEqual(
      ["Light volume", "Manual override", "Provider degraded earlier"].sort(),
    );
  });

  it("falls back to unconfigured provider health when no posture is supplied", () => {
    const snapshot = captureWith({}, { capturedAt: FROZEN_NOW });
    expect(snapshot.provider_health_at_capture).toBe("unconfigured");
    expect(snapshot.freshness_seconds_at_capture).toBeNull();
  });
});

describe("restoreSnapshotIntoStores", () => {
  beforeEach(() => resetStores());
  afterEach(() => resetStores());

  it("hydrates canonical stores so capture→restore→capture is idempotent", () => {
    useOverlayStore
      .getState()
      .openCountry("USA", "United States", "deep-link");
    useOverlayStore.getState().selectMarketSymbol("AAPL", "equities");
    useOverlayStore.getState().addCompareTarget({
      kind: "country",
      id: "USA",
      label: "United States",
      country_code: "USA",
    });

    const snapshot = captureWith(
      { marketPosture: postureFixture() },
      { capturedAt: FROZEN_NOW },
    );

    resetStores();
    restoreSnapshotIntoStores(snapshot);

    const reCaptured = captureWith(
      { marketPosture: postureFixture() },
      { capturedAt: FROZEN_NOW },
    );

    // Mode + selection slices must round-trip exactly.
    expect(reCaptured.workspace_mode).toEqual(snapshot.workspace_mode);
    expect(reCaptured.selection).toEqual(snapshot.selection);
    expect(reCaptured.compare_targets).toEqual(snapshot.compare_targets);
    expect(reCaptured.market_posture).toEqual(snapshot.market_posture);
  });

  it("does not silently re-fetch live data — restore is store-only", () => {
    const fetchSpy = vi.fn();
    const originalFetch = global.fetch;
    global.fetch = fetchSpy as unknown as typeof fetch;
    try {
      restoreSnapshotIntoStores({
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
        compare_targets: [],
        caveats: [],
        provider_health_at_capture: "live",
        freshness_seconds_at_capture: 180,
        captured_at: FROZEN_NOW.toISOString(),
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("restores compare-mode without dropping into country/portfolio mode", () => {
    const snapshot = {
      workspace_mode: "compare" as const,
      selection: {
        country_code: null,
        country_name: null,
        event_id: null,
        event_summary: null,
        market_symbol: null,
        market_asset_class: null,
      },
      market_posture: null,
      market_narrative: null,
      portfolio_id: null,
      portfolio_as_of: null,
      compare_targets: [
        {
          kind: "country" as const,
          id: "USA",
          label: "United States",
          country_code: "USA",
        },
        {
          kind: "country" as const,
          id: "JPN",
          label: "Japan",
          country_code: "JPN",
        },
      ],
      caveats: [],
      provider_health_at_capture: "live" as const,
      freshness_seconds_at_capture: null,
      captured_at: FROZEN_NOW.toISOString(),
    };

    restoreSnapshotIntoStores(snapshot);

    expect(useWorkspaceModeStore.getState().mode).toBe("compare");
    expect(useOverlayStore.getState().compareTargets.map((t) => t.id)).toEqual([
      "USA",
      "JPN",
    ]);
  });
});

describe("describeAge", () => {
  it("labels recent snapshots as 'just now'", () => {
    const captured = "2026-04-26T12:00:00Z";
    const now = new Date("2026-04-26T12:00:30Z");
    const label = describeAge(captured, now);
    expect(label.text).toBe("just now");
    expect(label.ageSeconds).toBe(30);
  });

  it("labels minutes ago", () => {
    const captured = "2026-04-26T11:45:00Z";
    const now = new Date("2026-04-26T12:00:00Z");
    expect(describeAge(captured, now).text).toBe("15m ago");
  });

  it("labels hours ago", () => {
    const captured = "2026-04-26T08:00:00Z";
    const now = new Date("2026-04-26T12:00:00Z");
    expect(describeAge(captured, now).text).toBe("4h ago");
  });

  it("labels days ago", () => {
    const captured = "2026-04-23T08:00:00Z";
    const now = new Date("2026-04-26T08:00:00Z");
    expect(describeAge(captured, now).text).toBe("3d ago");
  });
});

describe("buildShareUrl", () => {
  it("composes /share/<token> against the provided origin", () => {
    expect(buildShareUrl("abc123", "https://sphere.example/")).toBe(
      "https://sphere.example/share/abc123",
    );
  });
});
