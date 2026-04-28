import { create } from "zustand";

import type { SignalEvent } from "@/lib/intelligence/types";

import type { SignalDomain } from "@/components/workspace/DomainIcon";

// Phase 15A — multi-domain signal rail.
// Wave 15C — adds per-domain freshness metadata so the rail can render
// staleness chips and graceful empty/error states for under-served domains
// without lying about the feed quality.

export interface DomainMeta {
  /** ISO of last successful hydration. null → never succeeded. */
  lastSuccessAt: string | null;
  /** ISO of last attempt regardless of outcome. */
  lastAttemptAt: string | null;
  /** ISO of the most recent error. null → no error in the current attempt. */
  lastErrorAt: string | null;
  /** Item count from the most recent successful hydration. */
  lastItemCount: number;
}

const EMPTY_META: DomainMeta = {
  lastSuccessAt: null,
  lastAttemptAt: null,
  lastErrorAt: null,
  lastItemCount: 0,
};

export interface SignalRailState {
  selectedDomain: SignalDomain;
  byDomain: Partial<Record<SignalDomain, SignalEvent[]>>;
  errorByDomain: Partial<Record<SignalDomain, string>>;
  metaByDomain: Partial<Record<SignalDomain, DomainMeta>>;
  setSelectedDomain: (domain: SignalDomain) => void;
  setDomainSignals: (domain: SignalDomain, events: SignalEvent[]) => void;
  setDomainError: (domain: SignalDomain, error: string | null) => void;
  /** Record an attempt regardless of result so the rail can surface attempt freshness. */
  recordDomainAttempt: (domain: SignalDomain) => void;
}

function nowIso(): string {
  return new Date().toISOString();
}

export const useSignalRailStore = create<SignalRailState>((set) => ({
  selectedDomain: "news",
  byDomain: {},
  errorByDomain: {},
  metaByDomain: {},
  setSelectedDomain: (domain) => set({ selectedDomain: domain }),
  setDomainSignals: (domain, events) =>
    set((state) => {
      const ts = nowIso();
      const previous = state.metaByDomain[domain] ?? EMPTY_META;
      return {
        byDomain: { ...state.byDomain, [domain]: events },
        errorByDomain: { ...state.errorByDomain, [domain]: undefined },
        metaByDomain: {
          ...state.metaByDomain,
          [domain]: {
            ...previous,
            lastSuccessAt: ts,
            lastAttemptAt: ts,
            lastErrorAt: null,
            lastItemCount: events.length,
          },
        },
      };
    }),
  setDomainError: (domain, error) =>
    set((state) => {
      const ts = nowIso();
      const previous = state.metaByDomain[domain] ?? EMPTY_META;
      return {
        errorByDomain: {
          ...state.errorByDomain,
          [domain]: error ?? undefined,
        },
        metaByDomain: {
          ...state.metaByDomain,
          [domain]: {
            ...previous,
            lastAttemptAt: ts,
            lastErrorAt: error ? ts : previous.lastErrorAt,
          },
        },
      };
    }),
  recordDomainAttempt: (domain) =>
    set((state) => {
      const ts = nowIso();
      const previous = state.metaByDomain[domain] ?? EMPTY_META;
      return {
        metaByDomain: {
          ...state.metaByDomain,
          [domain]: { ...previous, lastAttemptAt: ts },
        },
      };
    }),
}));

/**
 * Wave 15C — staleness threshold (in ms) per domain. Tabs whose feed was
 * last updated more than this long ago are flagged as stale in the rail.
 */
export const DOMAIN_STALENESS_MS: Record<SignalDomain, number> = {
  news: 5 * 60 * 1000,
  stocks: 10 * 60 * 1000,
  weather: 15 * 60 * 1000,
  flights: 15 * 60 * 1000,
  health: 60 * 60 * 1000,
  conflict: 30 * 60 * 1000,
};

export function isDomainStale(meta: DomainMeta | undefined, domain: SignalDomain): boolean {
  if (!meta || !meta.lastSuccessAt) return false;
  const age = Date.now() - Date.parse(meta.lastSuccessAt);
  return age > DOMAIN_STALENESS_MS[domain];
}
