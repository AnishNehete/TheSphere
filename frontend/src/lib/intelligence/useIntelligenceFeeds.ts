"use client";

import { useEffect } from "react";

import { getLatestSignals } from "@/lib/intelligence/client";
import { useOverlayStore } from "@/store/useOverlayStore";
import { useSignalRailStore } from "@/store/useSignalRailStore";

import {
  DOMAIN_TO_CATEGORY,
  type SignalDomain,
} from "@/components/workspace/DomainIcon";

const NEWS_POLL_MS = 45_000;
const STOCKS_POLL_MS = 90_000;
const FX_POLL_MS = 120_000;
const COMMODITIES_POLL_MS = 120_000;
// Wave 15C — eager-warm cycle for the non-news/stocks rail domains.
// Selected domain still polls faster; the eager cycle just makes sure no
// tab is empty on first click. Slow enough to keep network noise low.
const RAIL_EAGER_POLL_MS = 5 * 60 * 1000;
const RAIL_POLL_MS = 60_000;
// Phase 15A — pulled larger pages so the rail can show more than 5 items
// without the user feeling the artificial cap.
const RAIL_LIMIT = 30;
const EAGER_LIMIT = 12;

const EAGER_DOMAINS: SignalDomain[] = ["weather", "flights", "health", "conflict"];

// Keeps the SignalStrip + StocksStrip + multi-domain rail warm without any
// component having to orchestrate fetches itself. Mounted once inside the
// workspace shell.
export function useIntelligenceFeeds() {
  const setLatestSignals = useOverlayStore((s) => s.setLatestSignals);
  const setLatestStocks = useOverlayStore((s) => s.setLatestStocks);
  const setLatestFx = useOverlayStore((s) => s.setLatestFx);
  const setLatestCommodities = useOverlayStore((s) => s.setLatestCommodities);
  const selectedDomain = useSignalRailStore((s) => s.selectedDomain);
  const setDomainSignals = useSignalRailStore((s) => s.setDomainSignals);
  const setDomainError = useSignalRailStore((s) => s.setDomainError);
  const recordDomainAttempt = useSignalRailStore((s) => s.recordDomainAttempt);

  // Backwards-compatible news feed for the existing latestSignals store —
  // SignalStrip falls back to it for the "news" domain so we don't double-poll.
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      recordDomainAttempt("news");
      try {
        const response = await getLatestSignals({ category: "news", limit: RAIL_LIMIT });
        if (!cancelled) {
          setLatestSignals(response.items);
          setDomainSignals("news", response.items);
        }
      } catch {
        if (!cancelled) setDomainError("news", "News feed temporarily unavailable.");
      }
    };
    void load();
    const timer = window.setInterval(load, NEWS_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [setLatestSignals, setDomainSignals, setDomainError, recordDomainAttempt]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      recordDomainAttempt("stocks");
      try {
        const response = await getLatestSignals({ category: "stocks", limit: 15 });
        if (!cancelled) {
          setLatestStocks(response.items);
          setDomainSignals("stocks", response.items);
        }
      } catch {
        if (!cancelled) setDomainError("stocks", "Equity feed temporarily unavailable.");
      }
    };
    void load();
    const timer = window.setInterval(load, STOCKS_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [setLatestStocks, setDomainSignals, setDomainError, recordDomainAttempt]);

  // Wave 15B — FX feed for the multi-asset bottom strip.
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const response = await getLatestSignals({ category: "currency", limit: 12 });
        if (!cancelled) setLatestFx(response.items);
      } catch {
        // Silent: the strip degrades to "no FX signals" without poisoning UX.
      }
    };
    void load();
    const timer = window.setInterval(load, FX_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [setLatestFx]);

  // Wave 15B — Commodities feed for the multi-asset bottom strip.
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const response = await getLatestSignals({ category: "commodities", limit: 12 });
        if (!cancelled) setLatestCommodities(response.items);
      } catch {
        // Silent: same degradation pattern as the FX feed.
      }
    };
    void load();
    const timer = window.setInterval(load, COMMODITIES_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [setLatestCommodities]);

  // Wave 15C — eager warm of the non-news/stocks rail domains so the user
  // doesn't pay first-click latency every time. Slow cadence (5min) keeps
  // network traffic predictable while still making the rail feel "real".
  useEffect(() => {
    let cancelled = false;
    const loadAll = async () => {
      for (const domain of EAGER_DOMAINS) {
        if (cancelled) return;
        const category = DOMAIN_TO_CATEGORY[domain];
        recordDomainAttempt(domain);
        try {
          const response = await getLatestSignals({
            category,
            limit: EAGER_LIMIT,
          });
          if (!cancelled) setDomainSignals(domain, response.items);
        } catch {
          if (!cancelled) {
            setDomainError(
              domain,
              `${category} feed temporarily unavailable.`,
            );
          }
        }
      }
    };
    void loadAll();
    const timer = window.setInterval(loadAll, RAIL_EAGER_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [setDomainSignals, setDomainError, recordDomainAttempt]);

  // Lazy per-domain hydration — faster cadence for whichever tab the user
  // is currently looking at. Plays nicely with the eager cycle: the first
  // selected-domain fetch wins on mount, subsequent ones refresh at 60s.
  useEffect(() => {
    if (selectedDomain === "news" || selectedDomain === "stocks") return;
    const category = DOMAIN_TO_CATEGORY[selectedDomain];
    let cancelled = false;
    const load = async () => {
      recordDomainAttempt(selectedDomain);
      try {
        const response = await getLatestSignals({
          category,
          limit: RAIL_LIMIT,
        });
        if (!cancelled) setDomainSignals(selectedDomain, response.items);
      } catch {
        if (!cancelled) {
          setDomainError(
            selectedDomain,
            `${category} feed temporarily unavailable.`,
          );
        }
      }
    };
    void load();
    const timer = window.setInterval(load, RAIL_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [selectedDomain, setDomainSignals, setDomainError, recordDomainAttempt]);
}

// Re-export so tests can reuse the same domain ordering used by the polling.
export type { SignalDomain };
