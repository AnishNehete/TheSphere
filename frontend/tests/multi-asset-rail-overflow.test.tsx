// Phase 16 — multi-asset rail overflow + pagination affordance.
//
// We don't try to simulate scrollWidth/clientWidth directly (jsdom does not
// implement layout). Instead we assert the controls are rendered, default
// to disabled, and carry the data-overflow contract attributes the CSS
// uses to fade the edges. The actual scroll math is exercised in browser
// tests.

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { StocksStrip } from "@/components/workspace/StocksStrip";
import type { SignalEvent } from "@/lib/intelligence/types";
import { useOverlayStore } from "@/store/useOverlayStore";

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
    properties: { symbol, change_pct: 0.4, price: 100.0 },
    sources: [],
    tags: [],
    entities: [],
  } as unknown as SignalEvent;
}

beforeEach(() => {
  useOverlayStore.setState({
    latestStocks: [makeStock("AAPL"), makeStock("MSFT"), makeStock("NVDA")],
    latestFx: [],
    latestCommodities: [],
    portfolioAsOf: null,
    selectedPortfolio: null,
    selectedCountryCode: null,
  });
});

describe("StocksStrip overflow affordance (Phase 16)", () => {
  it("renders prev / next pagination buttons when items exist", () => {
    render(<StocksStrip />);
    expect(screen.getByTestId("multi-asset-prev")).toBeInTheDocument();
    expect(screen.getByTestId("multi-asset-next")).toBeInTheDocument();
  });

  it("disables both pagination buttons by default (no measured overflow in jsdom)", () => {
    render(<StocksStrip />);
    expect(screen.getByTestId("multi-asset-prev")).toBeDisabled();
    expect(screen.getByTestId("multi-asset-next")).toBeDisabled();
  });

  it("exposes overflow contract attributes on the strip", () => {
    render(<StocksStrip />);
    const strip = screen.getByTestId("multi-asset-strip");
    expect(strip).toHaveAttribute("data-overflow-start", "false");
    expect(strip).toHaveAttribute("data-overflow-end", "false");
  });

  it("renders a graceful empty state when no market signals exist", () => {
    useOverlayStore.setState({
      latestStocks: [],
      latestFx: [],
      latestCommodities: [],
    });
    render(<StocksStrip />);
    expect(screen.queryByTestId("multi-asset-strip")).not.toBeInTheDocument();
    expect(screen.getByText(/No market signals available/i)).toBeInTheDocument();
  });

  it("Phase 17A.3: groups container is a focusable, labelled marquee region", () => {
    render(<StocksStrip />);
    const groups = screen.getByTestId("multi-asset-groups");
    // The container must be a focusable, labelled region. Phase 17A.3
    // replaced the manual horizontal scroll with a CSS marquee, so the
    // label now describes the auto-scrolling behaviour rather than
    // promising horizontal scroll affordances.
    expect(groups).toHaveAttribute("role", "region");
    expect(groups).toHaveAttribute("tabIndex", "0");
    expect(groups.getAttribute("aria-label") ?? "").toMatch(/auto-scrolling|ticker/i);
  });

  it("Phase 16 hotfix: per-group ticker lists are inline (no nested scroll)", () => {
    render(<StocksStrip />);
    const list = screen.getByTestId("asset-group-equities-list");
    // Inline list must NOT carry the legacy --scroll modifier.
    expect(list.className).toContain("ws-ticker-list--inline");
    expect(list.className).not.toContain("ws-ticker-list--scroll");
  });
});
