// Phase 16.7 — portfolio reframed as ground-truth compare.
//
// The product model: portfolio is a comparison/exposure layer, NOT the
// gate to charts. These tests pin that copy + structure so a future
// regression can't quietly turn portfolio back into a chart paywall.

import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PortfolioPanel } from "@/components/workspace/PortfolioPanel";
import { useOverlayStore } from "@/store/useOverlayStore";

vi.mock("@/lib/intelligence/client", () => ({
  getPortfolio: vi.fn(),
  getPortfolioBrief: vi.fn(),
  getPortfolioRiskScore: vi.fn(),
  getPortfolioSemantic: vi.fn(),
  getPortfolioTechnical: vi.fn(),
  getMarketCandles: vi.fn(),
  getHoldingCandles: vi.fn(),
}));

vi.mock("@/components/workspace/PortfolioOnboarding", () => ({
  PortfolioOnboarding: () => (
    <div data-testid="portfolio-onboarding-stub" />
  ),
}));

function reset() {
  useOverlayStore.setState({
    selectedPortfolioId: null,
    selectedPortfolio: null,
    portfolioBrief: null,
    portfolioTechnical: null,
    portfolioSemantic: null,
    portfolioRiskScore: null,
    portfolioAsOf: null,
    isLoading: false,
    error: null,
  });
}

beforeEach(reset);
afterEach(reset);

describe("Portfolio is ground-truth compare, not chart gate (Phase 16.7)", () => {
  it("empty-state eyebrow + copy frames portfolio as comparison context", () => {
    render(<PortfolioPanel />);

    expect(
      screen.getByText(/Compare to ground truth/i),
    ).toBeTruthy();
    const intro = screen.getByTestId("portfolio-compare-intro");
    expect(intro.textContent ?? "").toMatch(/comparison layer/i);
    expect(intro.textContent ?? "").toMatch(/portfolio is not required/i);
  });
});
