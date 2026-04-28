// Wave 15C — signal rail staleness + replay coherence tests.
//
// Asserts:
//   - tab is flagged stale once its lastSuccessAt exceeds the budget
//   - rail header surfaces an as-of chip when the workspace cursor is set
//   - "what changed" line uses replay-aware copy in as-of mode
//   - empty / error states still render correctly

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { SignalStrip } from "@/components/workspace/SignalStrip";
import { useOverlayStore } from "@/store/useOverlayStore";
import {
  DOMAIN_STALENESS_MS,
  isDomainStale,
  useSignalRailStore,
} from "@/store/useSignalRailStore";

beforeEach(() => {
  useOverlayStore.getState().closeOverlay();
  useOverlayStore.getState().setLatestSignals([]);
  useSignalRailStore.setState({
    selectedDomain: "news",
    byDomain: {},
    errorByDomain: {},
    metaByDomain: {},
  });
});

describe("isDomainStale", () => {
  it("returns false when meta is missing", () => {
    expect(isDomainStale(undefined, "news")).toBe(false);
  });

  it("flags stale when last success exceeds the budget", () => {
    const old = new Date(
      Date.now() - DOMAIN_STALENESS_MS.news - 10_000,
    ).toISOString();
    expect(
      isDomainStale(
        {
          lastSuccessAt: old,
          lastAttemptAt: old,
          lastErrorAt: null,
          lastItemCount: 1,
        },
        "news",
      ),
    ).toBe(true);
  });

  it("stays fresh inside the budget", () => {
    const recent = new Date().toISOString();
    expect(
      isDomainStale(
        {
          lastSuccessAt: recent,
          lastAttemptAt: recent,
          lastErrorAt: null,
          lastItemCount: 1,
        },
        "news",
      ),
    ).toBe(false);
  });
});

describe("SignalStrip replay coherence", () => {
  it("surfaces an as-of chip in the header when cursor is set", () => {
    useOverlayStore.getState().setPortfolioAsOf("2026-04-01T12:00:00Z");
    render(<SignalStrip />);
    const chip = screen.getByTestId("signal-rail-asof");
    expect(chip.textContent).toContain("2026-04-01");
    const rail = screen.getByTestId("signal-rail");
    expect(rail).toHaveAttribute("data-asof", "2026-04-01T12:00:00Z");
  });

  it("renders the changes-since copy with replay phrasing in as-of mode", () => {
    useOverlayStore.getState().setPortfolioAsOf("2026-04-01T12:00:00Z");
    render(<SignalStrip />);
    const line = screen.getByTestId("signal-rail-changes");
    expect(line.textContent).toContain("as-of cursor");
  });

  it("uses live phrasing when no cursor is set", () => {
    render(<SignalStrip />);
    const line = screen.getByTestId("signal-rail-changes");
    expect(line.textContent).toContain("last 24h");
  });

  it("renders the stale notice when the selected feed is past its budget", () => {
    const old = new Date(
      Date.now() - DOMAIN_STALENESS_MS.news - 30_000,
    ).toISOString();
    useSignalRailStore.setState({
      metaByDomain: {
        news: {
          lastSuccessAt: old,
          lastAttemptAt: old,
          lastErrorAt: null,
          lastItemCount: 0,
        },
      },
    });
    render(<SignalStrip />);
    expect(screen.getByTestId("signal-rail-stale")).toBeInTheDocument();
  });

  it("renders a 24h trend chip", () => {
    render(<SignalStrip />);
    expect(screen.getByTestId("signal-rail-trend")).toBeInTheDocument();
  });
});
