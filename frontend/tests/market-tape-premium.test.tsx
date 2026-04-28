// Phase 16.5 — premium market tape.
//
// Asserts the premium tape contract: per-group icons, live dot, update
// pulse on real price changes, reduced-motion path, and that legacy
// direction classes (--up / --down) still render without animation when
// the price has not actually changed.

import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { StocksStrip } from "@/components/workspace/StocksStrip";
import type { SignalEvent } from "@/lib/intelligence/types";
import { useAccessibilityStore } from "@/store/useAccessibilityStore";
import { useOverlayStore } from "@/store/useOverlayStore";
import { useWorkspaceModeStore } from "@/store/useWorkspaceModeStore";

function makeStock(symbol: string, price = 100, pct = 0.4): SignalEvent {
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
    properties: { symbol, change_pct: pct, price },
    sources: [],
    tags: [],
    entities: [],
  } as unknown as SignalEvent;
}

function resetStores() {
  useOverlayStore.setState({
    latestStocks: [],
    latestFx: [],
    latestCommodities: [],
    portfolioAsOf: null,
    selectedPortfolio: null,
    selectedCountryCode: null,
  });
  useWorkspaceModeStore.setState({ mode: "investigate", explicitlySet: false });
  useAccessibilityStore.setState({ reduceMotion: false });
}

beforeEach(resetStores);
afterEach(resetStores);

describe("Premium market tape (Phase 16.5)", () => {
  it("renders an asset-class icon per visible group", () => {
    useOverlayStore.setState({
      latestStocks: [makeStock("AAPL", 100)],
      latestFx: [
        {
          ...makeStock("EURUSD", 1.1, -0.1),
          id: "fx:EURUSD",
          type: "currency",
          title: "EURUSD",
          properties: { pair: "EURUSD", change_pct: -0.1, price: 1.1 },
        } as unknown as SignalEvent,
      ],
      latestCommodities: [
        {
          ...makeStock("CL", 80, 1.2),
          id: "co:CL",
          type: "commodities",
          title: "CL",
          properties: { symbol: "CL", change_pct: 1.2, price: 80 },
        } as unknown as SignalEvent,
      ],
    });
    render(<StocksStrip />);

    expect(screen.getByTestId("asset-group-equities-icon")).toBeInTheDocument();
    expect(screen.getByTestId("asset-group-fx-icon")).toBeInTheDocument();
    expect(screen.getByTestId("asset-group-commodities-icon")).toBeInTheDocument();
  });

  it("renders a live-dot per visible group as a calm liveness signal", () => {
    useOverlayStore.setState({
      latestStocks: [makeStock("AAPL", 100)],
    });
    render(<StocksStrip />);
    expect(screen.getByTestId("asset-group-equities-livedot")).toBeInTheDocument();
  });

  it("does not pulse on first render (no previous price to diff against)", () => {
    useOverlayStore.setState({
      latestStocks: [makeStock("AAPL", 100)],
    });
    render(<StocksStrip />);
    const ticker = screen.getByRole("button", { name: /AAPL/ });
    expect(ticker.getAttribute("data-pulse")).toBe("none");
  });

  it("applies an upward pulse class when a tracked price increases", async () => {
    useOverlayStore.setState({
      latestStocks: [makeStock("AAPL", 100)],
    });
    render(<StocksStrip />);
    // Effect runs once with price 100 (no diff). Now bump.
    await act(async () => {
      useOverlayStore.setState({
        latestStocks: [makeStock("AAPL", 101)],
      });
    });
    const ticker = screen.getByRole("button", { name: /AAPL/ });
    expect(ticker.className).toContain("ws-ticker--pulse-up");
    expect(ticker.getAttribute("data-pulse")).toBe("up");
  });

  it("applies a downward pulse class when a tracked price decreases", async () => {
    useOverlayStore.setState({
      latestStocks: [makeStock("AAPL", 100)],
    });
    render(<StocksStrip />);
    await act(async () => {
      useOverlayStore.setState({
        latestStocks: [makeStock("AAPL", 99)],
      });
    });
    const ticker = screen.getByRole("button", { name: /AAPL/ });
    expect(ticker.className).toContain("ws-ticker--pulse-down");
    expect(ticker.getAttribute("data-pulse")).toBe("down");
  });

  it("propagates the reduce-motion preference onto the tape root", () => {
    useAccessibilityStore.setState({ reduceMotion: true });
    useOverlayStore.setState({
      latestStocks: [makeStock("AAPL", 100)],
    });
    render(<StocksStrip />);
    const strip = screen.getByTestId("multi-asset-strip");
    expect(strip).toHaveAttribute("data-reduce-motion", "true");
  });

  it("hides the futures group when no futures-shaped symbols arrive", () => {
    useOverlayStore.setState({
      latestStocks: [makeStock("AAPL", 100)],
    });
    render(<StocksStrip />);
    expect(screen.queryByTestId("asset-group-futures")).not.toBeInTheDocument();
  });

  it("shows the futures group when an index-future symbol is in the feed", () => {
    useOverlayStore.setState({
      latestStocks: [
        makeStock("AAPL", 100),
        makeStock("ES", 5300, 0.1),
      ],
    });
    render(<StocksStrip />);
    expect(screen.getByTestId("asset-group-futures")).toBeInTheDocument();
    // Futures should not bleed back into equities.
    const equitiesList = screen.getByTestId("asset-group-equities-list");
    expect(equitiesList.textContent).not.toContain("ES");
  });
});
