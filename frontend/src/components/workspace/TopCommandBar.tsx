"use client";

import { useEffect, useState, type FormEvent } from "react";

import { useOverlayStore } from "@/store/useOverlayStore";
import { useWorkspaceModeStore } from "@/store/useWorkspaceModeStore";

import { ActiveScopeBar } from "./ActiveScopeBar";
import { AlertsBell } from "./AlertsBell";
import { ExampleQueriesRow } from "./ExampleQueriesRow";
import { GithubStarCTA } from "./GithubStarCTA";
import { HealthBadge } from "./HealthBadge";
import { ModeSwitcher } from "./ModeSwitcher";
import { PortfolioEntryButton } from "./PortfolioEntryButton";
import { ReplayCursor } from "./ReplayCursor";
import { SavedInvestigationsMenu } from "./SavedInvestigationsMenu";

// Phase 14 — top command layer reworked as a real control surface.
// Row 1: brand · mode switcher · command input · portfolio · replay cursor ·
//        compare chip · GitHub star · health.
// Row 2: persistent active scope / status bar.
// Search-first doctrine preserved — the command input is the widest and
// visually heaviest element. Mode switching, portfolio access, and replay
// state sit around it without competing with it.
export function TopCommandBar() {
  const openQuery = useOverlayStore((s) => s.openQuery);
  const compareTargets = useOverlayStore((s) => s.compareTargets);
  const openCompare = useOverlayStore((s) => s.openCompare);

  // Keep workspace mode coherent with overlay state on every overlay change.
  const syncFromOverlay = useWorkspaceModeStore((s) => s.syncFromOverlay);
  useEffect(() => {
    const unsubscribe = useOverlayStore.subscribe((state) => {
      syncFromOverlay(state);
    });
    // Initial sync for first render.
    syncFromOverlay(useOverlayStore.getState());
    return unsubscribe;
  }, [syncFromOverlay]);

  const [value, setValue] = useState("");

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = value.trim();
    if (!trimmed) return;
    openQuery(trimmed, undefined, "search");
  };

  return (
    <div className="ws-topbar" data-testid="workspace-topbar">
      <div className="ws-topbar__row ws-topbar__row--primary">
        <div className="ws-topbar__brand" aria-hidden>
          <span className="ws-topbar__mark">◎</span>
          <div className="ws-topbar__lockup">
            <span className="ws-topbar__name">Sphere</span>
            <span className="ws-topbar__tag">Operational-risk investigation</span>
          </div>
        </div>

        <ModeSwitcher />

        <form className="ws-commandbar" role="search" onSubmit={onSubmit}>
          <label htmlFor="ws-command-input" className="ws-commandbar__label">
            <span aria-hidden>⌕</span>
            <input
              id="ws-command-input"
              type="search"
              autoComplete="off"
              placeholder="Ask: why is Morocco elevated? · What changed in Japan? · USDJPY"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              aria-label="Search intelligence"
            />
          </label>
          <button type="submit" disabled={!value.trim()} className="ws-commandbar__submit">
            Investigate
          </button>
        </form>

        <div className="ws-topbar__right">
          <AlertsBell />
          <SavedInvestigationsMenu />
          <PortfolioEntryButton />
          <ReplayCursor />
          {compareTargets.length > 0 ? (
            <button
              type="button"
              className="ws-compare-chip"
              onClick={openCompare}
              aria-label={`Open compare view with ${compareTargets.length} targets`}
            >
              <span className="ws-compare-chip__dot" aria-hidden />
              <span>Compare</span>
              <span className="ws-compare-chip__count">{compareTargets.length}</span>
            </button>
          ) : null}
          <GithubStarCTA />
          <HealthBadge />
        </div>
      </div>

      <ExampleQueriesRow />

      <ActiveScopeBar />
    </div>
  );
}
