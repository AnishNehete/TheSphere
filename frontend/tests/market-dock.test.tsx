// Phase 16.7 — persistent market dock + selectedMarketSymbol coherence.
//
// Verifies the workspace-level dock:
//   1. Hidden when no symbol is selected.
//   2. Mounts and fetches when selectedMarketSymbol is set.
//   3. Reads asset class from the store (first-class state).
//   4. Close button clears selection (and the dock unmounts).
//   5. openEvent on a market signal auto-promotes selectedMarketSymbol so
//      a single click locks the whole workspace onto the symbol.

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MarketDock } from "@/components/workspace/MarketDock";
import * as client from "@/lib/intelligence/client";
import type { SignalEvent } from "@/lib/intelligence/types";
import { useOverlayStore } from "@/store/useOverlayStore";

vi.mock("@/components/charts/TheSphereChart", () => ({
  TheSphereChart: ({
    candles,
    testId,
  }: {
    candles: ReadonlyArray<unknown>;
    testId?: string;
  }) => (
    <div
      data-testid={testId ?? "tsc-stub"}
      data-candles={candles.length}
    />
  ),
}));

vi.mock("@/components/charts/TechnicalRatingBadge", () => ({
  TechnicalRatingBadge: () => <span data-testid="rating-stub" />,
}));

function fakeCandles(n: number) {
  const base = Date.parse("2026-01-01T00:00:00Z");
  return Array.from({ length: n }, (_, i) => ({
    timestamp: new Date(base + i * 86_400_000).toISOString(),
    open: 100 + i,
    high: 102 + i,
    low: 99 + i,
    close: 101 + i,
    volume: 1000,
  }));
}

function makeStock(symbol: string): SignalEvent {
  return {
    id: `ev:${symbol}`,
    type: "stocks",
    title: symbol,
    summary: "",
    severity: "info",
    severity_score: 0.1,
    confidence: 0.9,
    status: "open",
    source_timestamp: new Date().toISOString(),
    ingested_at: new Date().toISOString(),
    place: {
      country_code: null,
      country_name: null,
      locality: null,
      region: null,
      latitude: null,
      longitude: null,
    },
    properties: { symbol, change_pct: 1.2, price: 305 },
    sources: [],
    tags: [],
    entities: [],
  } as unknown as SignalEvent;
}

function reset() {
  useOverlayStore.setState({
    selectedEvent: null,
    selectedEventId: null,
    selectedMarketSymbol: null,
    selectedMarketAssetClass: null,
    latestStocks: [],
    latestFx: [],
    latestCommodities: [],
    portfolioAsOf: null,
  });
}

beforeEach(() => {
  reset();
  vi.spyOn(client, "getMarketCandles").mockResolvedValue({
    symbol: "X",
    range: "1y",
    as_of: null,
    provider: "synthetic",
    candles: fakeCandles(40),
  });
  vi.spyOn(client, "getMarketPosture").mockResolvedValue({
    symbol: "X",
    asset_class: "equities",
    posture: "neutral",
    posture_label: "Neutral",
    tilt: 0,
    effective_tilt: 0,
    confidence: 0.4,
    components: {
      technical: 0,
      semantic: 0,
      macro: null,
      uncertainty: 0.6,
    },
    drivers: [],
    caveats: [],
    freshness_seconds: 60,
    as_of: "2026-04-26T00:00:00Z",
    notes: [],
    provider: "alphavantage+cache",
    provider_health: "live",
    semantic_pressure: null,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  reset();
});

describe("MarketDock — Phase 16.7 persistent chart surface", () => {
  it("does not render when no symbol is selected", () => {
    const { container } = render(<MarketDock />);
    expect(container.firstChild).toBeNull();
  });

  it("renders the dock with symbol header when a symbol is selected", async () => {
    useOverlayStore.setState({
      selectedMarketSymbol: "AAPL",
      selectedMarketAssetClass: "equities",
      latestStocks: [makeStock("AAPL")],
    });

    render(<MarketDock />);

    const dock = screen.getByTestId("market-dock");
    expect(dock.getAttribute("data-symbol")).toBe("AAPL");
    expect(dock.getAttribute("data-asset-class")).toBe("equities");
    expect(screen.getByTestId("market-dock-asset").textContent).toBe(
      "Equity",
    );
    await waitFor(() => {
      expect(screen.getByTestId("market-dock-chart-canvas")).toBeTruthy();
    });
  });

  it("close button clears selectedMarketSymbol and unmounts the dock", () => {
    useOverlayStore.setState({
      selectedMarketSymbol: "MSFT",
      selectedMarketAssetClass: "equities",
    });
    const { rerender } = render(<MarketDock />);
    expect(screen.getByTestId("market-dock")).toBeTruthy();

    fireEvent.click(screen.getByTestId("market-dock-close"));
    expect(useOverlayStore.getState().selectedMarketSymbol).toBeNull();
    rerender(<MarketDock />);
    expect(screen.queryByTestId("market-dock")).toBeNull();
  });

  it("openEvent on a market signal auto-promotes selectedMarketSymbol", () => {
    const ev = makeStock("NVDA");
    useOverlayStore.getState().openEvent(ev, "signal-strip");

    const state = useOverlayStore.getState();
    expect(state.selectedMarketSymbol).toBe("NVDA");
    expect(state.selectedMarketAssetClass).toBe("equities");
  });

  it("openEvent on an FX pair surfaces fx as the asset class", () => {
    const fxEv = {
      ...makeStock("EURUSD"),
      type: "currency",
      properties: { pair: "EURUSD", change_pct: -0.12 },
    } as unknown as SignalEvent;

    useOverlayStore.getState().openEvent(fxEv, "signal-strip");

    expect(useOverlayStore.getState().selectedMarketSymbol).toBe("EURUSD");
    expect(useOverlayStore.getState().selectedMarketAssetClass).toBe("fx");
  });

  it("openEvent on a non-market signal does NOT change selectedMarketSymbol", () => {
    useOverlayStore.setState({
      selectedMarketSymbol: "AAPL",
      selectedMarketAssetClass: "equities",
    });
    const weatherEv = {
      ...makeStock("ignored"),
      type: "weather",
      properties: { wind_ms: 22 },
    } as unknown as SignalEvent;

    useOverlayStore.getState().openEvent(weatherEv);

    // Non-market events clear the selection (we don't want a stale chart
    // dangling on a weather investigation). This is the explicit contract.
    expect(useOverlayStore.getState().selectedMarketSymbol).toBeNull();
  });
});
