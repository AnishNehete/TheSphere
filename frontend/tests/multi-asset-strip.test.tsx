// Wave 15B — multi-asset bottom strip tests.
//
// Asserts the strip's three groups (equities / FX / commodities), mode-aware
// scoping (portfolio holdings restrict the equities group), and as-of label
// coherence with the replay cursor.

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { StocksStrip } from "@/components/workspace/StocksStrip";
import type {
  PortfolioHolding,
  PortfolioRecord,
  SignalEvent,
} from "@/lib/intelligence/types";
import { useOverlayStore } from "@/store/useOverlayStore";
import { useWorkspaceModeStore } from "@/store/useWorkspaceModeStore";

function makeEquity(symbol: string, pct: number): SignalEvent {
  return makeSignal({
    id: `eq-${symbol}`,
    type: "stocks",
    title: symbol,
    properties: { symbol, change_pct: pct, price: 100 },
  });
}

function makeFx(pair: string, pct: number): SignalEvent {
  return makeSignal({
    id: `fx-${pair}`,
    type: "currency",
    title: pair,
    properties: { pair, change_pct: pct, price: 1.1 },
  });
}

function makeCommodity(symbol: string, pct: number): SignalEvent {
  return makeSignal({
    id: `co-${symbol}`,
    type: "commodities",
    title: symbol,
    properties: { symbol, change_pct: pct, price: 80 },
  });
}

function makeSignal(overrides: Partial<SignalEvent>): SignalEvent {
  return {
    id: "x",
    dedupe_key: "x",
    type: "stocks",
    sub_type: null,
    title: "x",
    summary: "x",
    description: null,
    severity: "watch",
    severity_score: 0.4,
    confidence: 0.6,
    status: "active",
    place: {
      latitude: null,
      longitude: null,
      country_code: null,
      country_name: null,
      region: null,
      admin1: null,
      locality: null,
    },
    start_time: null,
    end_time: null,
    source_timestamp: "2026-04-24T12:00:00Z",
    ingested_at: "2026-04-24T12:00:00Z",
    sources: [],
    merged_from: [],
    tags: [],
    entities: [],
    score: null,
    properties: {},
    ...overrides,
  };
}

function makeHolding(symbol: string, currency = "USD"): PortfolioHolding {
  return {
    id: `h-${symbol}`,
    portfolio_id: "p1",
    symbol,
    name: symbol,
    quantity: 1,
    average_cost: 100,
    market_value: 100,
    currency,
    asset_type: "equity",
    exchange: null,
    region: null,
    sector: null,
    country_code: null,
    weight: 1,
    notes: null,
    enrichment_confidence: 1,
    metadata: {},
    last_price: 100,
    price_as_of: null,
    cost_basis: 100,
    unrealized_pnl: 0,
    unrealized_pnl_pct: 0,
    price_is_stale: false,
    price_missing: false,
  };
}

function resetStores() {
  useOverlayStore.getState().closeOverlay();
  useOverlayStore.getState().setLatestSignals([]);
  useOverlayStore.getState().setLatestStocks([]);
  useOverlayStore.getState().setLatestFx([]);
  useOverlayStore.getState().setLatestCommodities([]);
  useWorkspaceModeStore.setState({ mode: "investigate", explicitlySet: false });
}

describe("StocksStrip multi-asset surface", () => {
  beforeEach(resetStores);

  it("renders three asset groups when each feed has data", () => {
    useOverlayStore
      .getState()
      .setLatestStocks([makeEquity("AAPL", 0.4), makeEquity("MSFT", -0.2)]);
    useOverlayStore
      .getState()
      .setLatestFx([makeFx("EURUSD", -0.1), makeFx("USDJPY", 0.35)]);
    useOverlayStore
      .getState()
      .setLatestCommodities([makeCommodity("CL", 1.2), makeCommodity("GC", -0.4)]);

    render(<StocksStrip />);
    expect(screen.getByTestId("asset-group-equities")).toBeInTheDocument();
    expect(screen.getByTestId("asset-group-fx")).toBeInTheDocument();
    expect(screen.getByTestId("asset-group-commodities")).toBeInTheDocument();
  });

  it("scopes equities to the portfolio holdings in portfolio mode", () => {
    useOverlayStore
      .getState()
      .setLatestStocks([
        makeEquity("AAPL", 0.4),
        makeEquity("MSFT", 0.1),
        makeEquity("NVDA", -0.2),
      ]);
    const portfolio: PortfolioRecord = {
      id: "p1",
      name: "Demo",
      description: null,
      base_currency: "USD",
      benchmark_symbol: null,
      notes: null,
      tags: [],
      created_at: "2026-04-01T00:00:00Z",
      updated_at: "2026-04-24T00:00:00Z",
      holdings: [makeHolding("AAPL"), makeHolding("MSFT")],
    };
    useOverlayStore.getState().openPortfolio("p1", portfolio);
    useWorkspaceModeStore.setState({ mode: "portfolio", explicitlySet: true });

    render(<StocksStrip />);
    const list = screen.getByTestId("asset-group-equities-list");
    expect(list.textContent).toContain("AAPL");
    expect(list.textContent).toContain("MSFT");
    expect(list.textContent).not.toContain("NVDA");
  });

  it("shows the as-of label when portfolio replay cursor is active", () => {
    useOverlayStore
      .getState()
      .setLatestStocks([makeEquity("AAPL", 0.4)]);
    useOverlayStore.getState().setPortfolioAsOf("2026-04-01T12:00:00Z");
    useWorkspaceModeStore.setState({ mode: "replay", explicitlySet: true });

    render(<StocksStrip />);
    const strip = screen.getByTestId("multi-asset-strip");
    expect(strip.textContent).toContain("as of 2026-04-01");
  });

  it("falls back to the empty state when every feed is empty", () => {
    render(<StocksStrip />);
    expect(screen.getByText(/No market signals available/i)).toBeInTheDocument();
  });
});
