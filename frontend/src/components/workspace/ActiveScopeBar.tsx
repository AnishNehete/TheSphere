"use client";

import { useOverlayStore } from "@/store/useOverlayStore";
import {
  WORKSPACE_MODE_LABEL,
  useWorkspaceModeStore,
} from "@/store/useWorkspaceModeStore";

import { formatRelative } from "./formatters";

// Phase 14 — persistent active scope / status bar.
// One stable location that always answers:
//   - what mode am I in?
//   - what scope / entity / portfolio is active?
//   - am I Live or As-of?
//   - how fresh is the data?
//   - what confidence does this brief carry?
// The bar sits directly under the top command layer so the eye catches it
// without ever hunting for state.
export function ActiveScopeBar() {
  const mode = useWorkspaceModeStore((s) => s.mode);
  const overlay = useOverlayStore();

  const scope = resolveScopeLabel(overlay);
  const asOf = overlay.portfolioAsOf;
  const liveState = mode === "replay" || asOf
    ? `As-of ${formatAsOf(asOf)}`
    : "Live";
  const confidence = resolveConfidence(overlay);
  const freshness = overlay.lastUpdated
    ? `Updated ${formatRelative(overlay.lastUpdated)}`
    : null;

  return (
    <div className="ws-scope-bar" role="status" aria-live="polite" data-testid="active-scope-bar">
      <div className="ws-scope-bar__cell ws-scope-bar__cell--mode">
        <span className="ws-scope-bar__key">Mode</span>
        <span className="ws-scope-bar__value" data-testid="scope-bar-mode">
          {WORKSPACE_MODE_LABEL[mode]}
        </span>
      </div>
      <div className="ws-scope-bar__sep" aria-hidden>·</div>
      <div className="ws-scope-bar__cell ws-scope-bar__cell--scope">
        <span className="ws-scope-bar__key">Scope</span>
        <span className="ws-scope-bar__value" data-testid="scope-bar-scope">
          {scope ?? "No scope"}
        </span>
      </div>
      <div className="ws-scope-bar__sep" aria-hidden>·</div>
      <div className="ws-scope-bar__cell">
        <span className="ws-scope-bar__key">State</span>
        <span
          className={
            "ws-scope-bar__value ws-scope-bar__state " +
            (asOf ? "ws-scope-bar__state--asof" : "ws-scope-bar__state--live")
          }
          data-testid="scope-bar-state"
        >
          {liveState}
        </span>
      </div>
      {confidence !== null ? (
        <>
          <div className="ws-scope-bar__sep" aria-hidden>·</div>
          <div className="ws-scope-bar__cell">
            <span className="ws-scope-bar__key">Confidence</span>
            <span className="ws-scope-bar__value ws-scope-bar__value--mono">
              {Math.round(confidence * 100)}%
            </span>
          </div>
        </>
      ) : null}
      {freshness ? (
        <>
          <div className="ws-scope-bar__sep" aria-hidden>·</div>
          <div className="ws-scope-bar__cell ws-scope-bar__cell--muted">
            <span className="ws-scope-bar__value">{freshness}</span>
          </div>
        </>
      ) : null}
    </div>
  );
}

function resolveScopeLabel(overlay: ReturnType<typeof useOverlayStore.getState>): string | null {
  if (overlay.mode === "portfolio") {
    return overlay.selectedPortfolio?.name ?? overlay.selectedPortfolioId ?? "Portfolio";
  }
  if (overlay.mode === "compare") {
    const n = overlay.compareTargets.length;
    if (n === 0) return "No targets";
    return `${n} target${n === 1 ? "" : "s"}`;
  }
  if (overlay.mode === "event") {
    return overlay.selectedEvent?.title ?? overlay.selectedEventId ?? null;
  }
  if (overlay.mode === "country") {
    return overlay.selectedCountryName ?? overlay.selectedCountryCode ?? null;
  }
  if (overlay.mode === "query") {
    return overlay.queryText ? `"${overlay.queryText}"` : null;
  }
  return null;
}

function resolveConfidence(
  overlay: ReturnType<typeof useOverlayStore.getState>,
): number | null {
  if (overlay.mode === "portfolio") {
    return overlay.portfolioRiskScore?.confidence ?? null;
  }
  if (overlay.mode === "country") {
    return overlay.countryDetail?.summary.confidence ?? null;
  }
  if (overlay.mode === "query") {
    return overlay.agentResponse?.confidence ?? null;
  }
  return null;
}

function formatAsOf(iso: string | null): string {
  if (!iso) return "now";
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
  } catch {
    return iso;
  }
}
