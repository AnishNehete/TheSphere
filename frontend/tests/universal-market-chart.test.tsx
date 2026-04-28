// Phase 16.7 — universal market chart access.
//
// The product model promise: any supported market symbol can open a real
// chart. Chart visibility must NOT be gated by portfolio membership.
//
// These tests verify:
//   1. MarketChart calls the universal /market/{symbol}/candles endpoint
//      and renders without portfolio context.
//   2. EventPanel mounts the universal MarketChart for any market-class
//      signal, regardless of portfolio.
//   3. The chart degrades to an honest "unavailable" state when the
//      provider returns no series — never a fabricated bar.

import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MarketChart } from "@/components/workspace/MarketChart";
import { EventPanel } from "@/components/workspace/EventPanel";
import * as client from "@/lib/intelligence/client";
import type { SignalEvent } from "@/lib/intelligence/types";
import { useOverlayStore } from "@/store/useOverlayStore";

// Stub the heavy chart wrapper — we only care that it receives candles.
vi.mock("@/components/charts/TheSphereChart", () => ({
  TheSphereChart: ({
    candles,
    testId,
  }: {
    candles: ReadonlyArray<unknown>;
    testId?: string;
  }) => (
    <div data-testid={testId ?? "stub-chart"} data-candle-count={candles.length} />
  ),
}));

vi.mock("@/components/charts/TechnicalRatingBadge", () => ({
  TechnicalRatingBadge: () => <span data-testid="rating-stub" />,
}));

function fakeCandles(n: number) {
  const out = [];
  const base = Date.parse("2026-01-01T00:00:00Z");
  for (let i = 0; i < n; i++) {
    out.push({
      timestamp: new Date(base + i * 86_400_000).toISOString(),
      open: 100 + i,
      high: 102 + i,
      low: 99 + i,
      close: 101 + i,
      volume: 1000,
    });
  }
  return out;
}

function makeMarketEvent(symbol: string, type = "stocks"): SignalEvent {
  return {
    id: `ev:${symbol}`,
    type,
    title: `${symbol} moved`,
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
    properties: {
      symbol,
      change_pct: 0.7,
      price: 250,
      previous_close: 248,
      day_low: 247,
      day_high: 252,
    },
    sources: [],
    tags: [],
    entities: [],
  } as unknown as SignalEvent;
}

function resetStore() {
  useOverlayStore.setState({
    selectedEvent: null,
    selectedEventId: null,
    selectedPortfolio: null,
    selectedPortfolioId: null,
    selectedMarketSymbol: null,
    selectedMarketAssetClass: null,
    portfolioAsOf: null,
    latestSignals: [],
  });
}

beforeEach(resetStore);
afterEach(() => {
  vi.restoreAllMocks();
  resetStore();
});

describe("Universal market chart (Phase 16.7)", () => {
  it("MarketChart fetches via getMarketCandles, no portfolio required", async () => {
    const spy = vi.spyOn(client, "getMarketCandles").mockResolvedValue({
      symbol: "NVDA",
      range: "1y",
      as_of: null,
      provider: "synthetic",
      candles: fakeCandles(220),
    });

    render(<MarketChart symbol="NVDA" testId="ut-chart" />);

    await waitFor(() => {
      expect(spy).toHaveBeenCalledWith(
        "NVDA",
        { range: "1y", as_of: undefined },
        expect.objectContaining({ signal: expect.anything() }),
      );
    });
    await waitFor(() => {
      expect(screen.getByTestId("ut-chart-canvas")).toBeTruthy();
    });
    expect(
      screen
        .getByTestId("ut-chart-canvas")
        .getAttribute("data-candle-count"),
    ).toBe("220");
  });

  it("renders an honest unavailable state when the provider returns no candles", async () => {
    vi.spyOn(client, "getMarketCandles").mockResolvedValue({
      symbol: "ZZZZ",
      range: "1y",
      as_of: null,
      provider: "unconfigured",
      candles: [],
    });

    render(<MarketChart symbol="ZZZZ" testId="ut-empty" />);

    await waitFor(() => {
      expect(screen.getByTestId("ut-empty-empty")).toBeTruthy();
    });
    expect(screen.queryByTestId("ut-empty-canvas")).toBeNull();
  });

  it("EventPanel mounts the universal chart for a market signal even with no portfolio", async () => {
    const spy = vi.spyOn(client, "getMarketCandles").mockResolvedValue({
      symbol: "TSLA",
      range: "1y",
      as_of: null,
      provider: "synthetic",
      candles: fakeCandles(60),
    });
    useOverlayStore.setState({
      selectedEvent: makeMarketEvent("TSLA"),
      selectedEventId: "ev:TSLA",
      selectedPortfolio: null,
      selectedPortfolioId: null,
    });

    render(<EventPanel />);

    await waitFor(() => {
      expect(spy).toHaveBeenCalled();
    });
    expect(screen.getByTestId("event-panel-chart")).toBeTruthy();
    // The legacy "open a portfolio for the chart" callout must NOT render.
    expect(
      screen.queryByTestId("event-panel-chart-callout"),
    ).toBeNull();
  });

  it("does not gate chart access on portfolio membership for a non-held symbol", async () => {
    vi.spyOn(client, "getMarketCandles").mockResolvedValue({
      symbol: "META",
      range: "1y",
      as_of: null,
      provider: "synthetic",
      candles: fakeCandles(40),
    });
    useOverlayStore.setState({
      selectedEvent: makeMarketEvent("META"),
      selectedEventId: "ev:META",
      selectedPortfolio: {
        id: "pf:demo",
        name: "Demo book",
        base_currency: "USD",
        holdings: [{ symbol: "AAPL", currency: "USD", weight: 1 }],
        tags: ["demo"],
      } as unknown as never,
      selectedPortfolioId: "pf:demo",
    });

    render(<EventPanel />);

    await waitFor(() => {
      expect(screen.getByTestId("event-panel-chart")).toBeTruthy();
    });
    // META isn't held, but the chart still mounts. The portfolio compare
    // surface should NOT mount because META isn't a holding.
    expect(
      screen.queryByTestId("event-panel-portfolio-compare"),
    ).toBeNull();
  });
});
