import { create } from "zustand";

import { useOverlayStore } from "./useOverlayStore";
import type { OverlayState } from "./useOverlayStore";

/**
 * Phase 14 — Explicit workspace modes.
 *
 * WorkspaceMode is the user-facing "what am I doing right now" axis, kept
 * separate from the panel-driven OverlayMode so that mode, scope, and overlay
 * panel cannot silently disagree. The canonical rule:
 *
 *   - The ModeSwitcher is the visible source of truth for mode.
 *   - Opening a compare / portfolio panel implicitly sets the matching mode.
 *   - Entering as-of cursor from portfolio upgrades the mode to "replay".
 *   - Search / country / event focus all map back to "investigate".
 */
export type WorkspaceMode = "investigate" | "compare" | "portfolio" | "replay";

export const WORKSPACE_MODES: readonly WorkspaceMode[] = [
  "investigate",
  "compare",
  "portfolio",
  "replay",
] as const;

export const WORKSPACE_MODE_LABEL: Record<WorkspaceMode, string> = {
  investigate: "Investigate",
  compare: "Compare",
  portfolio: "Portfolio",
  replay: "Replay",
};

interface WorkspaceModeState {
  mode: WorkspaceMode;
  explicitlySet: boolean;
  setMode: (mode: WorkspaceMode) => void;
  syncFromOverlay: (overlay: OverlayState) => void;
}

export const useWorkspaceModeStore = create<WorkspaceModeState>((set) => ({
  mode: "investigate",
  explicitlySet: false,
  setMode: (mode) => set({ mode, explicitlySet: true }),
  syncFromOverlay: (overlay) =>
    set((state) => {
      const derived = deriveMode(overlay);
      if (state.explicitlySet && state.mode === derived) {
        // user picked this explicitly and overlay agrees — keep it
        return state;
      }
      if (state.mode === derived) return state;
      return { mode: derived, explicitlySet: false };
    }),
}));

export function deriveMode(overlay: Pick<OverlayState, "mode" | "portfolioAsOf">): WorkspaceMode {
  if (overlay.mode === "portfolio") {
    return overlay.portfolioAsOf ? "replay" : "portfolio";
  }
  if (overlay.mode === "compare") return "compare";
  return "investigate";
}
