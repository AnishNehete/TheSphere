"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { useOverlayStore } from "@/store/useOverlayStore";
import {
  useWorkspaceModeStore,
} from "@/store/useWorkspaceModeStore";

// Phase 14 — persistent Live / As-of affordance in the top command layer.
// Wave 15C — promoted to a workspace-wide replay axis.
// Phase 16 — productized the surface (Live ticking clock, As-of UTC label,
// hidden picker, Restore live affordance).
// Phase 16 hotfix — hydration-safe rendering.
//
// Hydration root cause:
//   - `new Date()` in `useState` initialiser produces different ms on the
//     server vs the client.
//   - `formatLiveDisplay` uses `getFullYear/Hours/...` which are local-tz
//     methods; the server's TZ is rarely the user's TZ, so the rendered
//     string disagrees.
//   - `Intl.DateTimeFormat(undefined, ...)` resolves the server's locale,
//     not the user's, so the tz abbreviation also disagrees.
//   - `max={...}` on the input fed off the same local-tz formatter.
//
// Fix shape:
//   - SSR + first paint render a deterministic UTC placeholder ("—" with
//     "UTC" zone hint) so server HTML matches client HTML byte-for-byte.
//   - A `mounted` flag flips on in a client-only `useEffect`; only then do
//     we replace the placeholder with the live local clock and the user's
//     tz abbreviation.
//   - The 30-second tick is also gated on `mounted` so the interval is
//     never installed on the server.
//   - The `max` attribute is omitted until mount; once mounted, we set it
//     to the current local-input value so the picker can't pick the future.
//
// As-of mode is hydration-safe by construction: `formatAsOfDisplay` is a
// pure UTC formatter and doesn't depend on the runtime locale.

export function ReplayCursor() {
  const mode = useWorkspaceModeStore((s) => s.mode);
  const setMode = useWorkspaceModeStore((s) => s.setMode);
  const asOf = useOverlayStore((s) => s.portfolioAsOf);
  const setPortfolioAsOf = useOverlayStore((s) => s.setPortfolioAsOf);
  const selectedPortfolioId = useOverlayStore((s) => s.selectedPortfolioId);

  const localInputValue = useMemo(() => toLocalInputValue(asOf), [asOf]);
  const isAsOf = Boolean(asOf);

  // Hydration-safe live clock. Server / first paint shows the stable "—"
  // placeholder; client takes over after mount.
  const [mounted, setMounted] = useState(false);
  const [liveNow, setLiveNow] = useState<Date | null>(null);
  const [tzAbbrev, setTzAbbrev] = useState<string>("UTC");
  const [pickerMax, setPickerMax] = useState<string | undefined>(undefined);

  useEffect(() => {
    setMounted(true);
    setLiveNow(new Date());
    setTzAbbrev(resolveTzAbbrev());
    setPickerMax(toLocalInputValue(new Date().toISOString()));
  }, []);

  useEffect(() => {
    if (!mounted || isAsOf) return;
    const id = window.setInterval(() => {
      setLiveNow(new Date());
      setPickerMax(toLocalInputValue(new Date().toISOString()));
    }, 30_000);
    return () => window.clearInterval(id);
  }, [mounted, isAsOf]);

  const previousMode = useMemo(() => {
    return selectedPortfolioId ? "portfolio" : "investigate";
  }, [selectedPortfolioId]);

  const handleAsOfChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const next = event.target.value;
      if (!next) {
        setPortfolioAsOf(null);
        if (mode === "replay") setMode(previousMode);
        return;
      }
      const iso = fromLocalInputValue(next);
      setPortfolioAsOf(iso);
      if (mode !== "replay") setMode("replay");
    },
    [mode, previousMode, setMode, setPortfolioAsOf],
  );

  const handleRestoreLive = useCallback(() => {
    setPortfolioAsOf(null);
    if (mode === "replay") setMode(previousMode);
  }, [mode, previousMode, setMode, setPortfolioAsOf]);

  return (
    <div
      className={`ws-replay-cursor${isAsOf ? " ws-replay-cursor--asof" : " ws-replay-cursor--live"}`}
      data-testid="replay-cursor"
      data-asof={asOf ?? ""}
      data-mounted={mounted ? "true" : "false"}
    >
      <div className="ws-replay-cursor__row">
        <span
          className={`ws-replay-cursor__badge ws-badge--${isAsOf ? "asof" : "live"}`}
          aria-live="polite"
        >
          {isAsOf ? "As-of" : "Live"}
        </span>
        {isAsOf ? (
          <span
            className="ws-replay-cursor__display"
            data-testid="replay-cursor-display"
            title={asOf ?? undefined}
          >
            {formatAsOfDisplay(asOf)}
            <span className="ws-replay-cursor__zone">UTC</span>
          </span>
        ) : (
          <span
            className="ws-replay-cursor__display ws-replay-cursor__display--muted"
            data-testid="replay-cursor-display"
          >
            {liveNow ? formatLiveDisplay(liveNow) : LIVE_PLACEHOLDER}
            <span className="ws-replay-cursor__zone">{tzAbbrev}</span>
          </span>
        )}
        <input
          type="datetime-local"
          className="ws-replay-cursor__input"
          value={localInputValue}
          onChange={handleAsOfChange}
          aria-label="As-of timestamp picker"
          title={
            selectedPortfolioId
              ? "Pick an as-of timestamp for historical reconstruction"
              : "Pick an as-of timestamp — drives timeline summaries; portfolio brief reflects as-of when a portfolio is selected"
          }
          data-testid="replay-cursor-input"
          {...(pickerMax ? { max: pickerMax } : {})}
        />
        {isAsOf ? (
          <button
            type="button"
            className="ws-replay-cursor__restore"
            onClick={handleRestoreLive}
            data-testid="replay-cursor-restore"
          >
            Restore live
          </button>
        ) : null}
      </div>
      <span
        className="ws-replay-cursor__hint"
        data-testid="replay-cursor-hint"
      >
        {isAsOf
          ? "Workspace pinned · panels and trends reflect this cursor"
          : "Workspace tracking live signals"}
      </span>
    </div>
  );
}

// --- pure formatters (deterministic, hydration-safe) ----------------------

const LIVE_PLACEHOLDER = "—— —— —— ——:——";

function pad(n: number): string {
  return n.toString().padStart(2, "0");
}

function toLocalInputValue(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

function fromLocalInputValue(local: string): string {
  const d = new Date(local);
  if (Number.isNaN(d.getTime())) return new Date().toISOString();
  return d.toISOString();
}

// As-of formatter: pure UTC, never depends on the runtime locale or tz, so
// it produces identical output on the server and the client. This is the
// invariant that keeps the As-of branch hydration-safe without needing the
// `mounted` gate.
function formatAsOfDisplay(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 16).replace("T", " ");
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
    ` ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
  );
}

// Live formatter: uses local-tz methods. Only called after mount, so server
// vs client divergence is impossible by construction.
function formatLiveDisplay(now: Date): string {
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    ` ${pad(now.getHours())}:${pad(now.getMinutes())}`
  );
}

function resolveTzAbbrev(): string {
  try {
    if (typeof Intl === "undefined") return "Local";
    const parts = new Intl.DateTimeFormat(undefined, {
      timeZoneName: "short",
    }).formatToParts(new Date());
    return parts.find((p) => p.type === "timeZoneName")?.value ?? "Local";
  } catch {
    return "Local";
  }
}
