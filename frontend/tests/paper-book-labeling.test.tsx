// Phase 16.6 — paper / demo / sample portfolio labeling.
//
// Verifies that the PortfolioPanel surfaces a clear "Demo book" /
// "Paper book" / "Sample book" pill plus an honest banner whenever the
// portfolio carries a paper-book signal — and stays silent for real books.

import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PortfolioPanel } from "@/components/workspace/PortfolioPanel";
import type {
  PortfolioHolding,
  PortfolioRecord,
} from "@/lib/intelligence/types";
import { useOverlayStore } from "@/store/useOverlayStore";

vi.mock("@/lib/intelligence/client", () => ({
  getPortfolio: vi.fn(() => new Promise(() => undefined)),
  getPortfolioBrief: vi.fn(() => new Promise(() => undefined)),
  getPortfolioRiskScore: vi.fn(() => new Promise(() => undefined)),
  getPortfolioSemantic: vi.fn(() => new Promise(() => undefined)),
  getPortfolioTechnical: vi.fn(() => new Promise(() => undefined)),
  getHoldingCandles: vi.fn(() => new Promise(() => undefined)),
}));

function makeHolding(symbol: string): PortfolioHolding {
  return {
    id: `h-${symbol}`,
    portfolio_id: "p1",
    symbol,
    name: symbol,
    quantity: 1,
    average_cost: 100,
    market_value: 100,
    currency: "USD",
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

function makePortfolio(overrides: Partial<PortfolioRecord>): PortfolioRecord {
  return {
    id: "p1",
    name: "Real Book",
    description: null,
    base_currency: "USD",
    benchmark_symbol: null,
    notes: null,
    tags: [],
    created_at: "2026-04-01T00:00:00Z",
    updated_at: "2026-04-25T00:00:00Z",
    holdings: [makeHolding("AAPL")],
    ...overrides,
  };
}

function reset() {
  useOverlayStore.setState({
    selectedPortfolioId: null,
    selectedPortfolio: null,
    portfolioBrief: null,
    portfolioTechnical: null,
    portfolioSemantic: null,
    portfolioRiskScore: null,
    selectedHoldingSymbol: null,
    portfolioAsOf: null,
  });
}

beforeEach(reset);
afterEach(reset);

describe("Paper-book labeling (Phase 16.6)", () => {
  it("renders a Demo book pill when the portfolio carries a demo tag", () => {
    const demo = makePortfolio({
      name: "Acme Holdings",
      tags: ["demo"],
    });
    useOverlayStore.setState({
      selectedPortfolioId: demo.id,
      selectedPortfolio: demo,
    });
    render(<PortfolioPanel />);

    const pill = screen.getByTestId("portfolio-paper-book-pill");
    expect(pill.getAttribute("data-paper-kind")).toBe("demo");
    expect(pill.textContent).toBe("Demo book");
  });

  it("renders a Paper book pill when only the name signals paper", () => {
    const paper = makePortfolio({
      name: "Paper Book — Q1",
      tags: [],
    });
    useOverlayStore.setState({
      selectedPortfolioId: paper.id,
      selectedPortfolio: paper,
    });
    render(<PortfolioPanel />);

    const pill = screen.getByTestId("portfolio-paper-book-pill");
    expect(pill.getAttribute("data-paper-kind")).toBe("paper");
    expect(pill.textContent).toBe("Paper book");
  });

  it("renders an honest banner clarifying the values are not real", () => {
    const sample = makePortfolio({ tags: ["sample"] });
    useOverlayStore.setState({
      selectedPortfolioId: sample.id,
      selectedPortfolio: sample,
    });
    render(<PortfolioPanel />);

    const banner = screen.getByTestId("portfolio-paper-book-banner");
    expect(banner.textContent).toMatch(/Sample book/i);
    expect(banner.textContent).toMatch(/paper-only/i);
    expect(banner.textContent).toMatch(/CSV or manual import/i);
  });

  it("stays silent for a real portfolio with no demo signal", () => {
    const real = makePortfolio({ name: "Acme Cap", tags: [] });
    useOverlayStore.setState({
      selectedPortfolioId: real.id,
      selectedPortfolio: real,
    });
    render(<PortfolioPanel />);

    expect(
      screen.queryByTestId("portfolio-paper-book-pill"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("portfolio-paper-book-banner"),
    ).not.toBeInTheDocument();
  });
});
