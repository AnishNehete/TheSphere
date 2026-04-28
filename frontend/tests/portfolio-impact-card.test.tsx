// Phase 19B — PortfolioImpactCard rendering tests.

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { PortfolioImpactCard } from "@/components/workspace/answer/PortfolioImpactCard";
import type { PortfolioImpact } from "@/lib/intelligence/types";

function baseImpact(overrides: Partial<PortfolioImpact> = {}): PortfolioImpact {
  return {
    generated_at: "2026-04-26T12:00:00Z",
    portfolio_id: "pf-1",
    portfolio_name: "Demo Sandbox",
    is_demo: true,
    holdings_count: 3,
    impacted_holdings: [
      {
        holding_id: "h-tsla",
        symbol: "TSLA",
        name: "Tesla",
        asset_type: "equity",
        sector: "Auto",
        country_code: "USA",
        weight: 0.2,
        exposure_type: "direct",
        matched_chain_id: "c-direct",
        matched_driver_id: null,
        matched_symbol: "TSLA",
        matched_domain: null,
        impact_direction: "down",
        confidence: 0.78,
        rationale: "TSLA appears directly on the causal chain 'EV demand softens'.",
        caveats: [],
      },
      {
        holding_id: "h-xom",
        symbol: "XOM",
        name: "Exxon Mobil",
        asset_type: "equity",
        sector: "Energy",
        country_code: "USA",
        weight: 0.1,
        exposure_type: "indirect",
        matched_chain_id: "c-oil",
        matched_driver_id: null,
        matched_symbol: null,
        matched_domain: "oil",
        impact_direction: "up",
        confidence: 0.55,
        rationale: "XOM sits in the oil channel via Energy.",
        caveats: [],
      },
    ],
    matched_chain_ids: ["c-direct", "c-oil"],
    summary: "Demo Sandbox (demo book): 1 direct, 1 indirect exposure to active drivers.",
    caveats: [
      "Mapped against a demo / paper book — no real capital is implied.",
    ],
    ...overrides,
  };
}

describe("PortfolioImpactCard", () => {
  it("renders nothing when impact is null", () => {
    const { container } = render(<PortfolioImpactCard impact={null} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when impact has no impacted holdings", () => {
    const { container } = render(
      <PortfolioImpactCard
        impact={baseImpact({ impacted_holdings: [] })}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders impacted holdings with exposure labels", () => {
    render(<PortfolioImpactCard impact={baseImpact()} />);

    const card = screen.getByTestId("portfolio-impact-card");
    expect(card).toBeTruthy();
    expect(card.getAttribute("data-is-demo")).toBe("true");

    // Both rows should be visible.
    const rows = screen.getAllByTestId("portfolio-impact-row");
    expect(rows).toHaveLength(2);

    // Direct + indirect labels.
    expect(screen.getByText("Direct")).toBeTruthy();
    expect(screen.getByText("Indirect")).toBeTruthy();

    // Symbols.
    expect(screen.getByText("TSLA")).toBeTruthy();
    expect(screen.getByText("XOM")).toBeTruthy();

    // Direction text.
    expect(screen.getByText(/Pressure ↓/)).toBeTruthy();
    expect(screen.getByText(/Pressure ↑/)).toBeTruthy();
  });

  it("renders the demo badge when is_demo is true", () => {
    render(<PortfolioImpactCard impact={baseImpact()} />);
    expect(screen.getByTestId("portfolio-impact-demo-badge")).toBeTruthy();
  });

  it("hides the demo badge when is_demo is false", () => {
    render(
      <PortfolioImpactCard
        impact={baseImpact({
          is_demo: false,
          portfolio_name: "Live Book",
          summary: "Live Book: 1 direct, 1 indirect exposure to active drivers.",
        })}
      />,
    );
    expect(screen.queryByTestId("portfolio-impact-demo-badge")).toBeNull();
    const card = screen.getByTestId("portfolio-impact-card");
    expect(card.getAttribute("data-is-demo")).toBe("false");
  });

  it("surfaces the summary text and caveats", () => {
    render(<PortfolioImpactCard impact={baseImpact()} />);
    expect(
      screen.getByText(
        /1 direct, 1 indirect exposure to active drivers/i,
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(/no real capital is implied/i),
    ).toBeTruthy();
  });

  it("collapses overflow holdings into a remaining counter", () => {
    const overflowImpact = baseImpact({
      impacted_holdings: [
        ...baseImpact().impacted_holdings,
        ...Array.from({ length: 6 }, (_, idx) => ({
          holding_id: `h-extra-${idx}`,
          symbol: `EXT${idx}`,
          name: null,
          asset_type: "equity",
          sector: "Tech",
          country_code: "USA",
          weight: 0.01,
          exposure_type: "weak" as const,
          matched_chain_id: "c-extra",
          matched_driver_id: null,
          matched_symbol: null,
          matched_domain: "country_risk" as const,
          impact_direction: "unknown" as const,
          confidence: 0.3,
          rationale: "Extra row.",
          caveats: [],
        })),
      ],
    });
    render(<PortfolioImpactCard impact={overflowImpact} />);
    const rows = screen.getAllByTestId("portfolio-impact-row");
    expect(rows).toHaveLength(5);
    expect(screen.getByText(/3 more holdings touched/i)).toBeTruthy();
  });
});
