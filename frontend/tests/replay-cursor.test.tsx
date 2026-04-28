// Phase 16 — date / replay control rendering and state transitions.
//
// Asserts:
//   - Live mode renders a current-time display + the Live badge, never a
//     blank input
//   - As-of mode renders a formatted UTC display + Restore live affordance
//   - Restore live transitions cleanly back to Live + clears the workspace
//     replay axis
//   - The picker input is present (so keyboard / pointer users can pick)
//   - data-asof is the testable replay contract on the cursor itself

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { ReplayCursor } from "@/components/workspace/ReplayCursor";
import { useOverlayStore } from "@/store/useOverlayStore";
import { useWorkspaceModeStore } from "@/store/useWorkspaceModeStore";

beforeEach(() => {
  useOverlayStore.getState().setPortfolioAsOf(null);
  useWorkspaceModeStore.getState().setMode("investigate");
});

describe("ReplayCursor (Phase 16)", () => {
  it("renders Live badge + a non-empty display in live mode", () => {
    render(<ReplayCursor />);
    expect(screen.getByText("Live")).toBeInTheDocument();
    const display = screen.getByTestId("replay-cursor-display");
    // Year/month/day shape — never the broken empty input
    expect(display.textContent).toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(screen.getByTestId("replay-cursor-hint").textContent).toMatch(
      /tracking live/i,
    );
  });

  it("flips to As-of and shows Restore live when the cursor is set", () => {
    useOverlayStore.getState().setPortfolioAsOf("2026-04-01T12:30:00Z");
    render(<ReplayCursor />);
    expect(screen.getByText("As-of")).toBeInTheDocument();
    const display = screen.getByTestId("replay-cursor-display");
    expect(display.textContent).toContain("2026-04-01 12:30");
    expect(screen.getByTestId("replay-cursor-restore")).toBeInTheDocument();
    expect(screen.getByTestId("replay-cursor")).toHaveAttribute(
      "data-asof",
      "2026-04-01T12:30:00Z",
    );
  });

  it("Restore live clears the workspace replay axis and exits replay mode", () => {
    useOverlayStore.getState().setPortfolioAsOf("2026-04-01T12:30:00Z");
    useWorkspaceModeStore.getState().setMode("replay");
    render(<ReplayCursor />);
    fireEvent.click(screen.getByTestId("replay-cursor-restore"));
    expect(useOverlayStore.getState().portfolioAsOf).toBeNull();
    expect(useWorkspaceModeStore.getState().mode).not.toBe("replay");
    // After restore, the display is back to the live clock (matches a date)
    expect(screen.getByTestId("replay-cursor-display").textContent).toMatch(
      /\d{4}-\d{2}-\d{2}/,
    );
  });

  it("exposes the native picker input so pointer / keyboard users can pick", () => {
    render(<ReplayCursor />);
    const picker = screen.getByTestId("replay-cursor-input");
    expect(picker).toBeInTheDocument();
    expect(picker.tagName).toBe("INPUT");
    expect(picker).toHaveAttribute("type", "datetime-local");
    expect(picker).toHaveAttribute("max");
  });
});
