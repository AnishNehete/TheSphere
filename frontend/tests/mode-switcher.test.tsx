import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import { ModeSwitcher } from "@/components/workspace/ModeSwitcher";
import { useOverlayStore } from "@/store/useOverlayStore";
import { useWorkspaceModeStore } from "@/store/useWorkspaceModeStore";

function resetStores() {
  useOverlayStore.getState().closeOverlay();
  useOverlayStore.getState().clearCompareTargets();
  useWorkspaceModeStore.setState({
    mode: "investigate",
    explicitlySet: false,
  });
}

describe("ModeSwitcher", () => {
  beforeEach(resetStores);

  it("renders all four modes", () => {
    render(<ModeSwitcher />);
    expect(screen.getByRole("tab", { name: /Switch to Investigate/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Switch to Compare/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Switch to Portfolio/i })).toBeInTheDocument();
    // Replay is disabled until a portfolio is selected — fall back to title text.
    expect(screen.getByTitle(/Select a portfolio to enter Replay mode/i)).toBeInTheDocument();
  });

  it("selecting Compare opens the compare overlay and marks Compare active", async () => {
    render(<ModeSwitcher />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: /Switch to Compare/i }));
    expect(useWorkspaceModeStore.getState().mode).toBe("compare");
    expect(useOverlayStore.getState().mode).toBe("compare");
  });

  it("selecting Portfolio clears any as-of cursor", async () => {
    useOverlayStore.getState().openPortfolio("pf-1");
    useOverlayStore.getState().setPortfolioAsOf("2026-04-20T12:00:00.000Z");
    render(<ModeSwitcher />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: /Switch to Portfolio/i }));
    expect(useOverlayStore.getState().portfolioAsOf).toBeNull();
    expect(useWorkspaceModeStore.getState().mode).toBe("portfolio");
  });

  it("Replay is disabled without a selected portfolio", () => {
    render(<ModeSwitcher />);
    const replayPill = screen.getByTitle(/Select a portfolio to enter Replay mode/i);
    expect(replayPill).toBeDisabled();
  });

  it("Replay becomes available and sets an as-of cursor when clicked", async () => {
    useOverlayStore.getState().openPortfolio("pf-1");
    render(<ModeSwitcher />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: /Switch to Replay/i }));
    expect(useWorkspaceModeStore.getState().mode).toBe("replay");
    expect(useOverlayStore.getState().portfolioAsOf).not.toBeNull();
  });
});
