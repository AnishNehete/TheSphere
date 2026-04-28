import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { ActiveScopeBar } from "@/components/workspace/ActiveScopeBar";
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

describe("ActiveScopeBar", () => {
  beforeEach(resetStores);

  it("shows Investigate mode and no-scope state by default", () => {
    render(<ActiveScopeBar />);
    expect(screen.getByTestId("scope-bar-mode")).toHaveTextContent("Investigate");
    expect(screen.getByTestId("scope-bar-scope")).toHaveTextContent("No scope");
    expect(screen.getByTestId("scope-bar-state")).toHaveTextContent("Live");
  });

  it("reflects portfolio scope when a portfolio overlay is open", () => {
    useOverlayStore.getState().openPortfolio("pf-1");
    useWorkspaceModeStore.getState().setMode("portfolio");
    render(<ActiveScopeBar />);
    expect(screen.getByTestId("scope-bar-mode")).toHaveTextContent("Portfolio");
    expect(screen.getByTestId("scope-bar-scope")).toHaveTextContent("pf-1");
  });

  it("flips live state label to As-of when cursor is set", () => {
    useOverlayStore.getState().openPortfolio("pf-1");
    useOverlayStore.getState().setPortfolioAsOf("2026-04-20T12:00:00.000Z");
    useWorkspaceModeStore.getState().setMode("replay");
    render(<ActiveScopeBar />);
    expect(screen.getByTestId("scope-bar-state")).toHaveTextContent(/As-of/);
    expect(screen.getByTestId("scope-bar-state").className).toContain(
      "ws-scope-bar__state--asof",
    );
  });

  it("shows country scope when country overlay is open", () => {
    useOverlayStore.getState().openCountry("fra", "France");
    render(<ActiveScopeBar />);
    expect(screen.getByTestId("scope-bar-scope")).toHaveTextContent("France");
  });
});
