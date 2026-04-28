// Phase 13A — Portfolio overlay surface smoke test.
//
// Mocks the intelligence client and asserts the PortfolioPanel renders the
// four required sections (holdings / exposure / risks / linked events)
// with the values from the brief.

import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PortfolioPanel } from "@/components/workspace/PortfolioPanel";
import type {
  PortfolioBrief,
  PortfolioRecord,
} from "@/lib/intelligence/types";
import { useOverlayStore } from "@/store/useOverlayStore";

const mockGetPortfolio = vi.fn();
const mockGetBrief = vi.fn();
const mockGetTechnical = vi.fn();
const mockGetSemantic = vi.fn();
const mockGetRisk = vi.fn();
const mockGetCandles = vi.fn();

vi.mock("@/lib/intelligence/client", () => ({
  getPortfolio: (...args: unknown[]) => mockGetPortfolio(...args),
  getPortfolioBrief: (...args: unknown[]) => mockGetBrief(...args),
  getPortfolioTechnical: (...args: unknown[]) => mockGetTechnical(...args),
  getPortfolioSemantic: (...args: unknown[]) => mockGetSemantic(...args),
  getPortfolioRiskScore: (...args: unknown[]) => mockGetRisk(...args),
  getHoldingCandles: (...args: unknown[]) => mockGetCandles(...args),
}));

// Mock lightweight-charts so PortfolioHoldingChart doesn't crash in jsdom
vi.mock("lightweight-charts", () => {
  const seriesApi = { setData: vi.fn(), setMarkers: vi.fn() };
  const chartApi = {
    addLineSeries: vi.fn().mockReturnValue(seriesApi),
    timeScale: () => ({ fitContent: vi.fn() }),
    applyOptions: vi.fn(),
    remove: vi.fn(),
  };
  return {
    createChart: vi.fn().mockReturnValue(chartApi),
    ColorType: { Solid: "solid" },
    LineStyle: { Dashed: 2 },
  };
});

// ResizeObserver polyfill for jsdom
(globalThis as Record<string, unknown>).ResizeObserver = class {
  observe() {}
  disconnect() {}
  unobserve() {}
};

function fakeBrief(): PortfolioBrief {
  return {
    portfolio_id: "port_demo",
    name: "Demo portfolio",
    base_currency: "USD",
    generated_at: new Date().toISOString(),
    holdings_count: 2,
    holdings: [
      {
        id: "hld_aapl",
        portfolio_id: "port_demo",
        symbol: "AAPL",
        name: "Apple Inc.",
        quantity: 10,
        average_cost: 180,
        market_value: null,
        currency: "USD",
        asset_type: "equity",
        exchange: "NASDAQ",
        region: "north-america",
        sector: "Technology",
        country_code: "USA",
        weight: 0.6,
        notes: null,
        enrichment_confidence: 1.0,
        metadata: {},
        last_price: null,
        price_as_of: null,
        cost_basis: null,
        unrealized_pnl: null,
        unrealized_pnl_pct: null,
        price_is_stale: false,
        price_missing: false,
      },
      {
        id: "hld_toyota",
        portfolio_id: "port_demo",
        symbol: "7203.T",
        name: "Toyota Motor",
        quantity: 20,
        average_cost: 2000,
        market_value: null,
        currency: "JPY",
        asset_type: "equity",
        exchange: "TSE",
        region: "east-asia",
        sector: "Automotive",
        country_code: "JPN",
        weight: 0.4,
        notes: null,
        enrichment_confidence: 1.0,
        metadata: {},
        last_price: null,
        price_as_of: null,
        cost_basis: null,
        unrealized_pnl: null,
        unrealized_pnl_pct: null,
        price_is_stale: false,
        price_missing: false,
      },
    ],
    exposure_summary: {
      countries: [
        {
          node: { id: "country:USA", domain: "country", label: "USA", country_code: "USA" },
          weight: 0.6,
          confidence: 0.9,
          contributing_holdings: ["hld_aapl"],
          rationale: "AAPL listed in USA.",
        },
        {
          node: { id: "country:JPN", domain: "country", label: "JPN", country_code: "JPN" },
          weight: 0.4,
          confidence: 0.9,
          contributing_holdings: ["hld_toyota"],
          rationale: "Toyota listed in JPN.",
        },
      ],
      sectors: [
        {
          node: { id: "sector:technology", domain: "sector", label: "Technology", country_code: null },
          weight: 0.6,
          confidence: 0.9,
          contributing_holdings: ["hld_aapl"],
          rationale: null,
        },
      ],
      currencies: [
        {
          node: { id: "currency:USD", domain: "currency", label: "USD", country_code: "USA" },
          weight: 0.6,
          confidence: 0.9,
          contributing_holdings: ["hld_aapl"],
          rationale: null,
        },
        {
          node: { id: "currency:JPY", domain: "currency", label: "JPY", country_code: "JPN" },
          weight: 0.4,
          confidence: 0.9,
          contributing_holdings: ["hld_toyota"],
          rationale: null,
        },
      ],
      commodities: [
        {
          node: { id: "commodity:semiconductors", domain: "commodity", label: "Semiconductors", country_code: null },
          weight: 0.36,
          confidence: 0.7,
          contributing_holdings: ["hld_aapl"],
          rationale: null,
        },
      ],
      macro_themes: [],
      chokepoints: [
        {
          node: { id: "chokepoint:malacca", domain: "chokepoint", label: "Malacca", country_code: null },
          weight: 0.28,
          confidence: 0.7,
          contributing_holdings: ["hld_aapl", "hld_toyota"],
          rationale: null,
        },
      ],
    },
    exposure_graph: { portfolio_id: "port_demo", nodes: [], edges: [] },
    dependency_paths: [
      {
        id: "port-dep-country-USA",
        title: "USA macro → USD → portfolio P&L",
        rationale: "60% of weight in USA.",
        overall_confidence: 0.7,
        contributing_holdings: ["hld_aapl"],
        exposure_node_id: "country:USA",
        related_event_ids: [],
      },
    ],
    top_risks: [
      {
        title: "Country concentration: USA",
        rationale: "60% of portfolio weight is exposed to USA.",
        severity: "elevated",
        confidence: 0.9,
        exposure_node_id: "country:USA",
        related_event_ids: [],
      },
    ],
    linked_events: [
      {
        event_id: "evt-1",
        title: "Severe storm warning issued across Japan",
        type: "weather",
        severity: "elevated",
        severity_score: 0.7,
        country_code: "JPN",
        country_name: "Japan",
        source_timestamp: new Date().toISOString(),
        publisher: "test",
        url: "https://example.com",
        matched_exposure_node_ids: ["country:JPN"],
      },
    ],
    entity: {
      id: "port_demo",
      name: "Demo portfolio",
      primary_country_codes: ["USA", "JPN"],
      primary_sectors: ["Technology"],
      primary_currencies: ["USD", "JPY"],
    },
    confidence: 0.72,
    notes: [],
    valuation_summary: null,
  };
}

function fakeRecord(): PortfolioRecord {
  const brief = fakeBrief();
  return {
    id: brief.portfolio_id,
    name: brief.name,
    description: null,
    base_currency: brief.base_currency,
    benchmark_symbol: null,
    notes: null,
    tags: [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    holdings: brief.holdings,
  };
}

beforeEach(() => {
  mockGetPortfolio.mockReset();
  mockGetBrief.mockReset();
  mockGetTechnical.mockReset();
  mockGetSemantic.mockReset();
  mockGetRisk.mockReset();
  mockGetCandles.mockReset();
  // Phase 15A — auto-select-first-holding now causes PortfolioHoldingChart
  // to mount whenever a brief has any holdings. Provide a calm default so
  // the chart-fetch effect doesn't choke on `undefined.then(...)` and crash
  // every existing brief-rendering test.
  mockGetCandles.mockResolvedValue({
    portfolio_id: "port_demo",
    symbol: "DEMO",
    range: "1y",
    candles: [],
    generated_at: new Date().toISOString(),
  });
  // Default: technical fetch resolves with an empty snapshot list so
  // pre-existing tests render without the unavailable-state copy.
  mockGetTechnical.mockResolvedValue({
    portfolio_id: "port_demo",
    generated_at: new Date().toISOString(),
    snapshots: [],
  });
  // Default: semantic fetch resolves to a calm, zero-event rollup so
  // pre-existing tests render without the unavailable-state copy.
  mockGetSemantic.mockResolvedValue({
    portfolio_id: "port_demo",
    generated_at: new Date().toISOString(),
    rollup: {
      portfolio_id: "port_demo",
      semantic_score: 0,
      event_pressure_level: "calm",
      top_drivers: [],
      contributing_event_count: 0,
      as_of: new Date().toISOString(),
      confidence: 0,
    },
    snapshots: [],
  });
  // Default: risk score fetch resolves to a calm score with the baseline
  // note so pre-existing tests render without the unavailable-state copy.
  mockGetRisk.mockResolvedValue({
    portfolio_id: "port_demo",
    risk_score: 0,
    delta_vs_baseline: 0,
    drivers: [],
    confidence: 0.15,
    score_components: {
      concentration: 0,
      fx: 0,
      commodity: 0,
      chokepoint: 0,
      event_severity: 0,
      semantic_density: 0,
    },
    as_of: new Date().toISOString(),
    freshness_seconds: 0,
    notes: ["Baseline not yet established (<3 historical scores)."],
    bullish_tilt_score: null,
    bearish_tilt_score: null,
    uncertainty_score: null,
    signal_alignment: null,
  });
  useOverlayStore.setState({
    isOpen: true,
    mode: "portfolio",
    selectedPortfolioId: "port_demo",
    selectedPortfolio: null,
    portfolioBrief: null,
    portfolioTechnical: null,
    portfolioSemantic: null,
    portfolioRiskScore: null,
    selectedHoldingSymbol: null,
    isLoading: false,
    error: null,
  });
});

afterEach(() => {
  useOverlayStore.setState({
    isOpen: false,
    mode: "idle",
    selectedPortfolioId: null,
    selectedPortfolio: null,
    portfolioBrief: null,
    portfolioTechnical: null,
    portfolioSemantic: null,
    portfolioRiskScore: null,
    selectedHoldingSymbol: null,
    isLoading: false,
    error: null,
  });
});

describe("PortfolioPanel — Phase 13A", () => {
  it("renders holdings, exposure rollup, top risks, and linked events", async () => {
    mockGetPortfolio.mockResolvedValue(fakeRecord());
    mockGetBrief.mockResolvedValue(fakeBrief());

    render(<PortfolioPanel />);

    await waitFor(() => {
      expect(screen.getByTestId("portfolio-holdings")).toBeTruthy();
    });
    const holdings = screen.getByTestId("portfolio-holdings");
    expect(holdings.textContent).toContain("AAPL");
    expect(holdings.textContent).toContain("7203.T");

    const exposure = screen.getByTestId("portfolio-exposure");
    expect(exposure.textContent).toContain("Countries");
    expect(exposure.textContent).toContain("USA");
    expect(exposure.textContent).toContain("JPN");
    expect(exposure.textContent).toContain("Currencies");
    expect(exposure.textContent).toContain("USD");
    expect(exposure.textContent).toContain("JPY");
    expect(exposure.textContent).toContain("Commodities");
    expect(exposure.textContent).toContain("Chokepoints");

    const risks = screen.getByTestId("portfolio-risks");
    expect(risks.textContent).toContain("Country concentration: USA");

    const events = screen.getByTestId("portfolio-linked-events");
    expect(events.textContent).toContain("Severe storm warning issued across Japan");
  });

  it("renders valuation summary when backend provides one", async () => {
    const brief = fakeBrief();
    brief.valuation_summary = {
      total_market_value: 52_000,
      total_cost_basis: 50_000,
      total_unrealized_pnl: 2_000,
      total_unrealized_pnl_pct: 0.04,
      price_coverage: 1.0,
      stalest_price_as_of: new Date().toISOString(),
      missing_price_symbols: [],
      weight_basis: "market_value",
      provider: "synthetic",
      generated_at: new Date().toISOString(),
    };
    brief.holdings = brief.holdings.map((h, i) => ({
      ...h,
      last_price: i === 0 ? 200 : 2100,
      price_as_of: new Date().toISOString(),
      cost_basis: h.quantity * (h.average_cost ?? 0),
      unrealized_pnl: 200,
      unrealized_pnl_pct: 0.05,
      price_is_stale: false,
      price_missing: false,
    }));
    mockGetPortfolio.mockResolvedValue(fakeRecord());
    mockGetBrief.mockResolvedValue(brief);

    render(<PortfolioPanel />);

    await waitFor(() =>
      expect(screen.getByTestId("portfolio-valuation")).toBeTruthy(),
    );
    const valuation = screen.getByTestId("portfolio-valuation");
    expect(valuation.textContent).toContain("Market value");
    expect(valuation.textContent).toContain("Prices: 2/2 live");
  });

  it("honestly degrades when no valuation summary is available", async () => {
    const brief = fakeBrief();
    brief.valuation_summary = null;
    mockGetPortfolio.mockResolvedValue(fakeRecord());
    mockGetBrief.mockResolvedValue(brief);

    render(<PortfolioPanel />);

    await waitFor(() =>
      expect(screen.getByTestId("portfolio-valuation")).toBeTruthy(),
    );
    expect(screen.getByTestId("portfolio-valuation").textContent).toContain(
      "Live prices unavailable",
    );
  });

  it("renders technical snapshot card with level badges", async () => {
    mockGetPortfolio.mockResolvedValue(fakeRecord());
    mockGetBrief.mockResolvedValue(fakeBrief());
    mockGetTechnical.mockResolvedValue({
      portfolio_id: "port_demo",
      generated_at: new Date().toISOString(),
      snapshots: [
        {
          symbol: "AAPL",
          as_of: new Date().toISOString(),
          currency: "USD",
          last_close: 200,
          sma20: 195,
          sma50: 190,
          sma200: 180,
          price_vs_sma20: 0.025,
          price_vs_sma50: 0.053,
          price_vs_sma200: 0.111,
          rsi14: 82,
          realized_vol_30d: 0.24,
          trend_regime: "above_200",
          technical_signal_level: "stretched_long",
          technical_score: 0.78,
          technical_notes: [],
          bullish_tilt_score: null,
          bearish_tilt_score: null,
          uncertainty_score: null,
          signal_alignment: null,
        },
      ],
    });

    render(<PortfolioPanel />);

    await waitFor(() =>
      expect(screen.getByTestId("portfolio-technical")).toBeTruthy(),
    );
    const technical = screen.getByTestId("portfolio-technical");
    expect(technical.textContent).toContain("AAPL");
    expect(technical.textContent).toContain("Stretched long");
    expect(technical.textContent).toContain("Above 200d");
    expect(technical.textContent).toContain("RSI 82");
  });

  it("honestly degrades when technical fetch fails", async () => {
    mockGetPortfolio.mockResolvedValue(fakeRecord());
    mockGetBrief.mockResolvedValue(fakeBrief());
    mockGetTechnical.mockRejectedValue(new Error("boom"));

    render(<PortfolioPanel />);

    await waitFor(() =>
      expect(screen.getByTestId("portfolio-technical")).toBeTruthy(),
    );
    expect(screen.getByTestId("portfolio-technical").textContent).toContain(
      "Technical signals unavailable",
    );
  });

  it("renders semantic pressure rollup with top drivers", async () => {
    mockGetPortfolio.mockResolvedValue(fakeRecord());
    mockGetBrief.mockResolvedValue(fakeBrief());
    mockGetSemantic.mockResolvedValue({
      portfolio_id: "port_demo",
      generated_at: new Date().toISOString(),
      rollup: {
        portfolio_id: "port_demo",
        semantic_score: 0.62,
        event_pressure_level: "elevated",
        top_drivers: [
          {
            node_id: "country:USA",
            label: "USA",
            contribution: 0.4,
            rationale:
              "2 event(s) matched via country:USA: storm warning; supply chain disruption",
            evidence_ids: ["e1", "e2"],
          },
        ],
        contributing_event_count: 2,
        as_of: new Date().toISOString(),
        confidence: 0.7,
      },
      snapshots: [],
    });

    render(<PortfolioPanel />);

    await waitFor(() =>
      expect(screen.getByTestId("portfolio-semantic")).toBeTruthy(),
    );
    const sem = screen.getByTestId("portfolio-semantic");
    expect(sem.textContent).toContain("Elevated");
    expect(sem.textContent).toContain("USA");
    expect(sem.textContent).toContain("storm warning");
  });

  it("honestly degrades when semantic fetch fails", async () => {
    mockGetPortfolio.mockResolvedValue(fakeRecord());
    mockGetBrief.mockResolvedValue(fakeBrief());
    mockGetSemantic.mockRejectedValue(new Error("boom"));

    render(<PortfolioPanel />);

    await waitFor(() =>
      expect(screen.getByTestId("portfolio-semantic")).toBeTruthy(),
    );
    expect(screen.getByTestId("portfolio-semantic").textContent).toContain(
      "Semantic pressure unavailable",
    );
  });

  it("renders macro risk score with drivers and component breakdown", async () => {
    mockGetPortfolio.mockResolvedValue(fakeRecord());
    mockGetBrief.mockResolvedValue(fakeBrief());
    mockGetRisk.mockResolvedValue({
      portfolio_id: "port_demo",
      risk_score: 54.0,
      delta_vs_baseline: 2.4,
      drivers: [
        {
          component: "event_severity",
          label: "Event Severity",
          weight: 0.18,
          rationale: "3 live events linked to portfolio exposure.",
          evidence_ids: ["e1", "e2"],
        },
        {
          component: "concentration",
          label: "Concentration",
          weight: 0.09,
          rationale: "Herfindahl 0.5 across 3 holdings.",
          evidence_ids: [],
        },
      ],
      confidence: 0.68,
      score_components: {
        concentration: 0.5,
        fx: 0.2,
        commodity: 0.3,
        chokepoint: 0.2,
        event_severity: 0.7,
        semantic_density: 0.4,
      },
      as_of: new Date().toISOString(),
      freshness_seconds: 400,
      notes: [],
      bullish_tilt_score: null,
      bearish_tilt_score: null,
      uncertainty_score: null,
      signal_alignment: null,
    });

    render(<PortfolioPanel />);

    await waitFor(() =>
      expect(screen.getByTestId("portfolio-risk-score")).toBeTruthy(),
    );
    const card = screen.getByTestId("portfolio-risk-score");
    expect(card.textContent).toContain("54");
    expect(card.textContent).toContain("Event Severity");
    expect(card.textContent).toContain("Concentration");
    expect(card.textContent).toContain("68% confidence");
    // Delta copy should show the formatted delta instead of baseline label.
    expect(card.textContent).toContain("+2.4 vs 7d");
  });

  it("honestly degrades when risk fetch fails", async () => {
    mockGetPortfolio.mockResolvedValue(fakeRecord());
    mockGetBrief.mockResolvedValue(fakeBrief());
    mockGetRisk.mockRejectedValue(new Error("boom"));

    render(<PortfolioPanel />);

    await waitFor(() =>
      expect(screen.getByTestId("portfolio-risk-score")).toBeTruthy(),
    );
    expect(screen.getByTestId("portfolio-risk-score").textContent).toContain(
      "Risk score unavailable",
    );
  });

  it("renders Live badge when no as_of is set", async () => {
    mockGetPortfolio.mockResolvedValue(fakeRecord());
    mockGetBrief.mockResolvedValue(fakeBrief());

    render(<PortfolioPanel />);

    await waitFor(() =>
      expect(screen.getByTestId("portfolio-cursor")).toBeTruthy(),
    );
    const cursor = screen.getByTestId("portfolio-cursor");
    expect(cursor.textContent).toContain("Live");
    expect(cursor.textContent).not.toContain("Restore live");
  });

  it("switches to As-of badge and shows Restore live button when date is set", async () => {
    mockGetPortfolio.mockResolvedValue(fakeRecord());
    mockGetBrief.mockResolvedValue(fakeBrief());

    useOverlayStore.setState({ portfolioAsOf: "2025-01-15T23:59:59Z" });
    render(<PortfolioPanel />);

    await waitFor(() =>
      expect(screen.getByTestId("portfolio-cursor")).toBeTruthy(),
    );
    const cursor = screen.getByTestId("portfolio-cursor");
    expect(cursor.textContent).toContain("As of 2025-01-15");
    expect(cursor.textContent).toContain("Restore live");
    expect(cursor.textContent).not.toContain("Live");
  });

  it("renders tilt line with no buy/sell wording when signal_alignment is set", async () => {
    mockGetPortfolio.mockResolvedValue(fakeRecord());
    mockGetBrief.mockResolvedValue(fakeBrief());
    mockGetRisk.mockResolvedValue({
      portfolio_id: "port_demo",
      risk_score: 42.0,
      delta_vs_baseline: 0,
      drivers: [],
      confidence: 0.5,
      score_components: {
        concentration: 0.2,
        fx: 0.1,
        commodity: 0.1,
        chokepoint: 0.1,
        event_severity: 0.2,
        semantic_density: 0.1,
      },
      as_of: new Date().toISOString(),
      freshness_seconds: 0,
      notes: [],
      bullish_tilt_score: 0.62,
      bearish_tilt_score: 0.21,
      uncertainty_score: 0.17,
      signal_alignment: "aligned",
    });

    render(<PortfolioPanel />);

    await waitFor(() =>
      expect(screen.queryByTestId("portfolio-risk-tilt")).toBeTruthy(),
    );
    const tilt = screen.getByTestId("portfolio-risk-tilt");
    expect(tilt.textContent).toContain("Aligned");
    expect(tilt.textContent).toContain("upside");
    expect(tilt.textContent).toContain("downside");
    // Tilt discipline: no buy/sell/recommendation language
    expect(tilt.textContent?.toLowerCase()).not.toContain("buy");
    expect(tilt.textContent?.toLowerCase()).not.toContain("sell");
    expect(tilt.textContent?.toLowerCase()).not.toContain("recommend");
  });

  it("mounts the holding chart when a holding row is clicked", async () => {
    mockGetPortfolio.mockResolvedValue(fakeRecord());
    mockGetBrief.mockResolvedValue(fakeBrief());
    mockGetCandles.mockResolvedValue({
      portfolio_id: "port_demo",
      symbol: "AAPL",
      range: "1y",
      as_of: null,
      provider: "synthetic",
      candles: [],
    });

    const { fireEvent } = await import("@testing-library/react");
    render(<PortfolioPanel />);

    await waitFor(() =>
      expect(screen.getByTestId("portfolio-holdings")).toBeTruthy(),
    );

    // Click the AAPL holding trigger button
    const buttons = screen.getAllByRole("button");
    const aaplButton = buttons.find((b) => b.textContent?.includes("AAPL"));
    expect(aaplButton).toBeTruthy();
    fireEvent.click(aaplButton!);

    await waitFor(() =>
      expect(screen.queryByTestId("portfolio-holding-chart")).toBeTruthy(),
    );
  });
});
