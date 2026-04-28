import { beforeEach, describe, expect, it } from "vitest";

import { useOverlayStore } from "@/store/useOverlayStore";
import {
  deriveMode,
  useWorkspaceModeStore,
} from "@/store/useWorkspaceModeStore";

function resetStores() {
  useOverlayStore.getState().closeOverlay();
  useOverlayStore.getState().clearCompareTargets();
  useWorkspaceModeStore.setState({
    mode: "investigate",
    explicitlySet: false,
  });
}

describe("useWorkspaceModeStore", () => {
  beforeEach(resetStores);

  it("defaults to investigate mode", () => {
    expect(useWorkspaceModeStore.getState().mode).toBe("investigate");
  });

  it("derives compare mode from overlay compare state", () => {
    useOverlayStore.getState().openCompare();
    useWorkspaceModeStore.getState().syncFromOverlay(useOverlayStore.getState());
    expect(useWorkspaceModeStore.getState().mode).toBe("compare");
  });

  it("derives portfolio mode when a portfolio is opened live", () => {
    useOverlayStore.getState().openPortfolio("pf-1");
    useWorkspaceModeStore.getState().syncFromOverlay(useOverlayStore.getState());
    expect(useWorkspaceModeStore.getState().mode).toBe("portfolio");
  });

  it("derives replay mode when as-of cursor is set on portfolio", () => {
    useOverlayStore.getState().openPortfolio("pf-1");
    useOverlayStore.getState().setPortfolioAsOf("2026-04-20T12:00:00.000Z");
    useWorkspaceModeStore.getState().syncFromOverlay(useOverlayStore.getState());
    expect(useWorkspaceModeStore.getState().mode).toBe("replay");
  });

  it("user-set mode is preserved when it still matches overlay", () => {
    useOverlayStore.getState().openCompare();
    useWorkspaceModeStore.getState().setMode("compare");
    useWorkspaceModeStore.getState().syncFromOverlay(useOverlayStore.getState());
    expect(useWorkspaceModeStore.getState().explicitlySet).toBe(true);
    expect(useWorkspaceModeStore.getState().mode).toBe("compare");
  });

  it("overlay state can override an explicitly set mode when they diverge", () => {
    useWorkspaceModeStore.getState().setMode("compare");
    useOverlayStore.getState().openPortfolio("pf-1");
    useWorkspaceModeStore.getState().syncFromOverlay(useOverlayStore.getState());
    expect(useWorkspaceModeStore.getState().mode).toBe("portfolio");
  });
});

describe("deriveMode", () => {
  it("maps country / event / query / idle to investigate", () => {
    expect(deriveMode({ mode: "country", portfolioAsOf: null })).toBe(
      "investigate",
    );
    expect(deriveMode({ mode: "event", portfolioAsOf: null })).toBe(
      "investigate",
    );
    expect(deriveMode({ mode: "query", portfolioAsOf: null })).toBe(
      "investigate",
    );
    expect(deriveMode({ mode: "idle", portfolioAsOf: null })).toBe(
      "investigate",
    );
  });

  it("maps compare -> compare", () => {
    expect(deriveMode({ mode: "compare", portfolioAsOf: null })).toBe(
      "compare",
    );
  });

  it("maps portfolio -> portfolio or replay depending on as-of", () => {
    expect(deriveMode({ mode: "portfolio", portfolioAsOf: null })).toBe(
      "portfolio",
    );
    expect(
      deriveMode({ mode: "portfolio", portfolioAsOf: "2026-04-20T12:00:00Z" }),
    ).toBe("replay");
  });
});
