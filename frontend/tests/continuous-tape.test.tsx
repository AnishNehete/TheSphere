// Phase 16.7 — continuous market tape.
//
// Pins the DOM contract that drives the continuous drift:
//   1. The strip exposes data-continuous="true" when motion is allowed.
//   2. A cloned mirror track is emitted (data-clone="true") so the
//      auto-flow can wrap silently at the half-track boundary.
//   3. Reduced-motion users get NO clone and no continuous flag.

import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { StocksStrip } from "@/components/workspace/StocksStrip";
import type { SignalEvent } from "@/lib/intelligence/types";
import { useAccessibilityStore } from "@/store/useAccessibilityStore";
import { useOverlayStore } from "@/store/useOverlayStore";
import { useWorkspaceModeStore } from "@/store/useWorkspaceModeStore";

function makeStock(symbol: string): SignalEvent {
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
    properties: { symbol, change_pct: 0.4, price: 100 },
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

describe("Continuous market tape (Phase 16.7)", () => {
  it("emits a cloned mirror track and continuous flag when motion is allowed", () => {
    useOverlayStore.setState({
      latestStocks: [makeStock("AAPL"), makeStock("MSFT"), makeStock("NVDA")],
    });

    render(<StocksStrip />);

    const strip = screen.getByTestId("multi-asset-strip");
    expect(strip.getAttribute("data-continuous")).toBe("true");
    expect(strip.getAttribute("data-pulse-driven")).toBe("true");
    expect(screen.getByTestId("multi-asset-track")).toBeTruthy();
    expect(screen.getByTestId("multi-asset-track-clone")).toBeTruthy();
  });

  it("suppresses the clone and continuous flag under reduced motion", () => {
    useAccessibilityStore.setState({ reduceMotion: true });
    useOverlayStore.setState({
      latestStocks: [makeStock("AAPL")],
    });

    render(<StocksStrip />);

    const strip = screen.getByTestId("multi-asset-strip");
    expect(strip.getAttribute("data-continuous")).toBe("false");
    expect(strip.getAttribute("data-pulse-driven")).toBe("false");
    expect(screen.queryByTestId("multi-asset-track-clone")).toBeNull();
  });

  it("keeps the marquee animation armed after a ticker is clicked (Phase 17A.3)", async () => {
    useOverlayStore.setState({
      latestStocks: [makeStock("AAPL"), makeStock("MSFT"), makeStock("NVDA")],
    });

    render(<StocksStrip />);
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );

    const list = screen.getByTestId("asset-group-equities-list");
    const firstButton = list.querySelector("button");
    expect(firstButton).not.toBeNull();
    firstButton?.click();

    // Phase 17A.3 follow-up — the tape is now a CSS marquee, so the
    // contract isn't `data-autoflow="on"` any more; instead the inner
    // wrapper carries the `--marquee` modifier class and stays armed
    // across clicks. CSS hover/focus pauses are the only pause path.
    const marquee = screen.getByTestId("multi-asset-marquee");
    expect(marquee.className).toContain("ws-multiasset__inner--marquee");
  });

  it("renders the broader Phase 16.7 equities basket without spam", () => {
    const symbols = [
      "AAPL", "MSFT", "NVDA", "TSLA", "SPY", "GOOGL", "META", "AMZN",
      "QQQ", "JPM", "BAC", "XOM",
    ];
    useOverlayStore.setState({
      latestStocks: symbols.map(makeStock),
    });

    render(<StocksStrip />);

    const list = screen.getByTestId("asset-group-equities-list");
    // GROUP_LIMIT is 12; all curated symbols above should render.
    expect(list.querySelectorAll("li").length).toBe(12);
  });
});
