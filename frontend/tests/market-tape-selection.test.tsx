// Phase 16.6 — selected-ticker coordination.
//
// Verifies the click contract from the lower tape:
//   1. tape ticker click sets `selectedMarketSymbol` in the overlay store
//   2. that symbol gets the `ws-ticker--selected` class
//   3. selecting a second ticker moves the highlight
//   4. closeOverlay() clears the selection so a stale highlight never
//      lingers across investigations.

import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { StocksStrip } from "@/components/workspace/StocksStrip";
import type { SignalEvent } from "@/lib/intelligence/types";
import { useAccessibilityStore } from "@/store/useAccessibilityStore";
import { useOverlayStore } from "@/store/useOverlayStore";
import { useWorkspaceModeStore } from "@/store/useWorkspaceModeStore";

function makeStock(symbol: string, price = 100): SignalEvent {
  return {
    id: `eq:${symbol}`,
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
    properties: { symbol, change_pct: 0.4, price },
    sources: [],
    tags: [],
    entities: [],
  } as unknown as SignalEvent;
}

function reset() {
  useOverlayStore.setState({
    latestStocks: [],
    latestFx: [],
    latestCommodities: [],
    portfolioAsOf: null,
    selectedPortfolio: null,
    selectedCountryCode: null,
    selectedMarketSymbol: null,
    selectedMarketAssetClass: null,
  });
  useWorkspaceModeStore.setState({ mode: "investigate", explicitlySet: false });
  useAccessibilityStore.setState({ reduceMotion: false });
}

beforeEach(reset);
afterEach(reset);

describe("Selected-ticker coordination (Phase 16.6)", () => {
  it("sets selectedMarketSymbol on the overlay store when a ticker is clicked", () => {
    useOverlayStore.setState({
      latestStocks: [makeStock("AAPL"), makeStock("MSFT")],
    });
    render(<StocksStrip />);

    fireEvent.click(screen.getByRole("button", { name: /AAPL/ }));

    expect(useOverlayStore.getState().selectedMarketSymbol).toBe("AAPL");
    expect(useOverlayStore.getState().selectedMarketAssetClass).toBe(
      "equities",
    );
  });

  it("applies the selected class only to the chosen ticker", () => {
    useOverlayStore.setState({
      latestStocks: [makeStock("AAPL"), makeStock("MSFT")],
    });
    render(<StocksStrip />);

    fireEvent.click(screen.getByRole("button", { name: /AAPL/ }));

    const aapl = screen.getByRole("button", { name: /AAPL/ });
    const msft = screen.getByRole("button", { name: /MSFT/ });
    expect(aapl.getAttribute("data-selected")).toBe("true");
    expect(msft.getAttribute("data-selected")).toBe("false");
    expect(aapl.className).toContain("ws-ticker--selected");
    expect(msft.className).not.toContain("ws-ticker--selected");
  });

  it("moves the highlight when a second ticker is clicked", () => {
    useOverlayStore.setState({
      latestStocks: [makeStock("AAPL"), makeStock("MSFT")],
    });
    render(<StocksStrip />);

    fireEvent.click(screen.getByRole("button", { name: /AAPL/ }));
    fireEvent.click(screen.getByRole("button", { name: /MSFT/ }));

    expect(useOverlayStore.getState().selectedMarketSymbol).toBe("MSFT");
    const aapl = screen.getByRole("button", { name: /AAPL/ });
    const msft = screen.getByRole("button", { name: /MSFT/ });
    expect(aapl.getAttribute("data-selected")).toBe("false");
    expect(msft.getAttribute("data-selected")).toBe("true");
  });

  it("closeOverlay clears the selected market symbol", () => {
    useOverlayStore.setState({
      latestStocks: [makeStock("AAPL")],
    });
    render(<StocksStrip />);

    fireEvent.click(screen.getByRole("button", { name: /AAPL/ }));
    expect(useOverlayStore.getState().selectedMarketSymbol).toBe("AAPL");

    useOverlayStore.getState().closeOverlay();
    expect(useOverlayStore.getState().selectedMarketSymbol).toBeNull();
    expect(useOverlayStore.getState().selectedMarketAssetClass).toBeNull();
  });
});
