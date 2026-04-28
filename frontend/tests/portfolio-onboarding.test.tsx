import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PortfolioOnboarding } from "@/components/workspace/PortfolioOnboarding";
import { PortfolioPanel } from "@/components/workspace/PortfolioPanel";
import * as client from "@/lib/intelligence/client";
import * as demo from "@/lib/intelligence/demoPortfolio";
import { useOverlayStore } from "@/store/useOverlayStore";

function resetOverlay() {
  useOverlayStore.getState().closeOverlay();
}

const fakePortfolio = {
  id: "pf-demo",
  name: "Demo · Global Operational Risk",
  description: null,
  base_currency: "USD",
  benchmark_symbol: null,
  notes: null,
  tags: ["demo"],
  created_at: "2026-04-24T00:00:00Z",
  updated_at: "2026-04-24T00:00:00Z",
  holdings: [],
};

describe("Portfolio onboarding", () => {
  beforeEach(() => {
    resetOverlay();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("PortfolioPanel renders onboarding when no portfolio is selected", () => {
    render(<PortfolioPanel />);
    expect(screen.getByTestId("portfolio-onboarding")).toBeInTheDocument();
    expect(screen.getByTestId("onboard-create")).toBeInTheDocument();
    expect(screen.getByTestId("onboard-import")).toBeInTheDocument();
  });

  it("create flow calls createPortfolio and opens the new portfolio", async () => {
    const createSpy = vi
      .spyOn(client, "createPortfolio")
      .mockResolvedValueOnce({ ...fakePortfolio, id: "pf-new", name: "Manual" });
    render(<PortfolioOnboarding />);
    fireEvent.click(screen.getByTestId("onboard-create"));
    fireEvent.change(screen.getByTestId("onboard-create-name"), {
      target: { value: "Manual" },
    });
    fireEvent.click(screen.getByTestId("onboard-create-submit"));
    await waitFor(() => {
      expect(createSpy).toHaveBeenCalledWith({
        name: "Manual",
        base_currency: "USD",
      });
      expect(useOverlayStore.getState().selectedPortfolioId).toBe("pf-new");
    });
  });

  it("demo seed CTA only renders in dev/demo envs", () => {
    vi.spyOn(demo, "isDemoEnv").mockReturnValue(false);
    const { rerender, queryByTestId } = render(<PortfolioOnboarding />);
    expect(queryByTestId("onboard-demo")).not.toBeInTheDocument();
    vi.spyOn(demo, "isDemoEnv").mockReturnValue(true);
    rerender(<PortfolioOnboarding />);
    expect(queryByTestId("onboard-demo")).toBeInTheDocument();
  });

  it("seedDemoPortfolio CTA pushes the seeded portfolio into the overlay store", async () => {
    vi.spyOn(demo, "isDemoEnv").mockReturnValue(true);
    const seedSpy = vi
      .spyOn(demo, "seedDemoPortfolio")
      .mockResolvedValueOnce({ ...fakePortfolio });
    render(<PortfolioOnboarding />);
    fireEvent.click(screen.getByTestId("onboard-demo"));
    await waitFor(() => {
      expect(seedSpy).toHaveBeenCalled();
      expect(useOverlayStore.getState().selectedPortfolioId).toBe("pf-demo");
    });
  });
});
