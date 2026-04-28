"use client";

import { useCallback } from "react";

import { useOverlayStore } from "@/store/useOverlayStore";
import {
  WORKSPACE_MODES,
  WORKSPACE_MODE_LABEL,
  type WorkspaceMode,
  useWorkspaceModeStore,
} from "@/store/useWorkspaceModeStore";

// Phase 14 — mode pill switcher.
// Compact, calm, operational. Keyboard accessible via role=tablist semantics.
// The switcher writes user intent into useWorkspaceModeStore. A matching
// side-effect below is responsible for nudging the overlay store toward a
// coherent state without tearing down already-open panels.
export function ModeSwitcher() {
  const current = useWorkspaceModeStore((s) => s.mode);
  const setMode = useWorkspaceModeStore((s) => s.setMode);
  const overlayMode = useOverlayStore((s) => s.mode);
  const openCompare = useOverlayStore((s) => s.openCompare);
  const selectedPortfolioId = useOverlayStore((s) => s.selectedPortfolioId);
  const setPortfolioAsOf = useOverlayStore((s) => s.setPortfolioAsOf);
  const portfolioAsOf = useOverlayStore((s) => s.portfolioAsOf);
  const closeOverlay = useOverlayStore((s) => s.closeOverlay);

  const handleSelect = useCallback(
    (next: WorkspaceMode) => {
      if (next === current) return;
      setMode(next);
      if (next === "investigate") {
        // If a non-investigate panel is open, collapse it back.
        if (overlayMode === "compare" || overlayMode === "portfolio") {
          closeOverlay();
        }
      }
      if (next === "compare") {
        openCompare();
      }
      if (next === "portfolio") {
        // If no portfolio selected, the PortfolioEntryButton handles discovery.
        // Just clear the as-of cursor so we're in Live portfolio.
        if (portfolioAsOf) setPortfolioAsOf(null);
      }
      if (next === "replay") {
        // Replay is meaningful only with a portfolio loaded. If one exists,
        // default the as-of cursor to "now - 1h" as a sensible starting point.
        if (selectedPortfolioId && !portfolioAsOf) {
          const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
          setPortfolioAsOf(oneHourAgo.toISOString());
        }
      }
    },
    [
      closeOverlay,
      current,
      openCompare,
      overlayMode,
      portfolioAsOf,
      selectedPortfolioId,
      setMode,
      setPortfolioAsOf,
    ],
  );

  return (
    <div
      className="ws-mode-switch"
      role="tablist"
      aria-label="Workspace mode"
      data-testid="mode-switcher"
    >
      {WORKSPACE_MODES.map((m) => {
        const active = current === m;
        const disabled =
          m === "replay" && !selectedPortfolioId ? true : false;
        return (
          <button
            key={m}
            type="button"
            role="tab"
            aria-selected={active}
            aria-disabled={disabled}
            disabled={disabled}
            className={`ws-mode-pill${active ? " ws-mode-pill--active" : ""}`}
            onClick={() => handleSelect(m)}
            data-mode={m}
            aria-label={
              disabled
                ? "Select a portfolio to enter Replay mode"
                : `Switch to ${WORKSPACE_MODE_LABEL[m]}`
            }
            title={
              disabled
                ? "Select a portfolio to enter Replay mode"
                : `Switch to ${WORKSPACE_MODE_LABEL[m]}`
            }
          >
            <span className="ws-mode-pill__dot" aria-hidden />
            <span className="ws-mode-pill__label">{WORKSPACE_MODE_LABEL[m]}</span>
          </button>
        );
      })}
    </div>
  );
}
