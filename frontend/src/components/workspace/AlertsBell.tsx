"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  deleteAlertRule,
  listAlertEvents,
  listAlertRules,
  type AlertEventWire,
  type AlertRuleWire,
} from "@/lib/intelligence/alerts";
import { useOverlayStore } from "@/store/useOverlayStore";

// Phase 17C.2 — Alerts bell.
//
// Top-shell affordance with two responsibilities:
//
// 1. Poll /api/intelligence/alerts/events?since=<lastSeen> every 30s
//    to keep an unread-count badge fresh. The cursor is the most recent
//    fired_at observed; new fires arrive strictly after, so the cursor
//    moves only when fresh events land. The cursor is also persisted
//    to localStorage so reloading does not flood the badge with old
//    events.
// 2. On open, render the recent events newest-first plus a tiny rules
//    summary so the operator can see what's wired and remove rules
//    they no longer want.
//
// Honest-data guarantees:
//
// * No alert is derived client-side. The bell mirrors the backend ring
//   buffer 1:1; the backend's pure evaluator + cooldown gate is the
//   source of record.
// * Clicking an event hands its symbol to the canonical
//   ``selectMarketSymbol`` setter — same path the strip + posture card
//   already use. No new state model.

const POLL_INTERVAL_MS = 30_000;
const SEEN_STORAGE_KEY = "sphere.alerts.lastSeenAt";

function readLastSeen(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(SEEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeLastSeen(value: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(SEEN_STORAGE_KEY, value);
  } catch {
    // localStorage may be unavailable (incognito, quota); the badge
    // will simply re-flag the same events on next reload.
  }
}

export function AlertsBell() {
  const selectMarketSymbol = useOverlayStore((s) => s.selectMarketSymbol);

  const [events, setEvents] = useState<AlertEventWire[]>([]);
  const [rules, setRules] = useState<AlertRuleWire[]>([]);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastSeenAt, setLastSeenAt] = useState<string | null>(() =>
    readLastSeen(),
  );
  const popoverRef = useRef<HTMLDivElement>(null);

  const refreshEvents = useCallback(async () => {
    try {
      // Always pull a small page; ``since`` is purely an optimization
      // for the network. The full page is what we render in the
      // dropdown anyway.
      const response = await listAlertEvents({ limit: 25 });
      setEvents(response.items);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load alerts");
    }
  }, []);

  const refreshRules = useCallback(async () => {
    try {
      const response = await listAlertRules();
      setRules(response.items);
    } catch (err) {
      // Rules failure is non-fatal — keep the events surface alive.
      setError(err instanceof Error ? err.message : "Failed to load rules");
    }
  }, []);

  // Polling cycle. Lifecycle is independent of `open` so the badge
  // updates whether or not the popover is visible.
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      await refreshEvents();
    };
    void tick();
    const id = window.setInterval(tick, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [refreshEvents]);

  // Load rules lazily on first open so we don't pay for them every
  // 30s for an analyst who never opens the dropdown.
  useEffect(() => {
    if (!open) return;
    void refreshRules();
  }, [open, refreshRules]);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (event: MouseEvent) => {
      if (!popoverRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  // When the user opens the popover, mark all currently-known events
  // as seen so the badge clears. New events that arrive later still
  // count because they have a strictly later fired_at.
  const markAllSeen = useCallback(() => {
    if (events.length === 0) return;
    const newest = events[0].fired_at;
    setLastSeenAt(newest);
    writeLastSeen(newest);
  }, [events]);

  const handleToggle = useCallback(() => {
    setOpen((prev) => {
      const next = !prev;
      if (next) {
        // Defer the seen-mark to after the render so the badge does
        // not flicker mid-open.
        window.setTimeout(markAllSeen, 0);
      }
      return next;
    });
  }, [markAllSeen]);

  const unreadCount = useMemo(() => {
    if (lastSeenAt === null) return events.length;
    return events.filter((e) => e.fired_at > lastSeenAt).length;
  }, [events, lastSeenAt]);

  const handleEventClick = useCallback(
    (event: AlertEventWire) => {
      selectMarketSymbol(event.triggering_posture.symbol, "equities");
      setOpen(false);
    },
    [selectMarketSymbol],
  );

  const handleDeleteRule = useCallback(
    async (ruleId: string) => {
      try {
        await deleteAlertRule(ruleId);
        await refreshRules();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to delete rule");
      }
    },
    [refreshRules],
  );

  return (
    <div className="ws-alerts" ref={popoverRef}>
      <button
        type="button"
        className="ws-alerts__trigger"
        onClick={handleToggle}
        aria-expanded={open}
        aria-haspopup="menu"
        data-testid="alerts-bell-trigger"
        aria-label={
          unreadCount > 0
            ? `${unreadCount} new alert${unreadCount === 1 ? "" : "s"}`
            : "No new alerts"
        }
      >
        <span className="ws-alerts__icon" aria-hidden>
          ◉
        </span>
        <span className="ws-alerts__label">Alerts</span>
        {unreadCount > 0 ? (
          <span
            className="ws-alerts__badge"
            data-testid="alerts-bell-badge"
          >
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        ) : null}
      </button>
      {open ? (
        <div className="ws-alerts__popover" role="menu">
          {error ? (
            <div className="ws-alerts__state ws-alerts__state--err">
              {error}
            </div>
          ) : null}
          <section className="ws-alerts__section">
            <h3 className="ws-alerts__section-title">Recent fires</h3>
            {events.length === 0 ? (
              <div className="ws-alerts__state">No alerts yet</div>
            ) : (
              <ul className="ws-alerts__list">
                {events.map((event) => (
                  <li key={event.id} className="ws-alerts__item">
                    <button
                      type="button"
                      className="ws-alerts__item-btn"
                      onClick={() => handleEventClick(event)}
                    >
                      <div className="ws-alerts__item-row">
                        <span
                          className={`ws-alerts__pill ws-alerts__pill--${event.delta.kind}`}
                        >
                          {event.delta.kind === "posture_band_change"
                            ? "Band"
                            : "Conf↓"}
                        </span>
                        <span className="ws-alerts__item-rule">
                          {event.rule_name}
                        </span>
                        <time
                          className="ws-alerts__item-when"
                          dateTime={event.fired_at}
                        >
                          {new Date(event.fired_at).toLocaleTimeString()}
                        </time>
                      </div>
                      <p className="ws-alerts__item-summary">
                        {event.delta.summary}
                      </p>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
          {rules.length > 0 ? (
            <section className="ws-alerts__section ws-alerts__section--rules">
              <h3 className="ws-alerts__section-title">Watching</h3>
              <ul className="ws-alerts__rules">
                {rules.map((rule) => (
                  <li key={rule.id} className="ws-alerts__rule">
                    <span className="ws-alerts__rule-name">{rule.name}</span>
                    <span className="ws-alerts__rule-meta">
                      {rule.symbol} ·{" "}
                      {rule.kind === "posture_band_change"
                        ? "band"
                        : `conf ≥ ${Math.round((rule.threshold ?? 0) * 100)}%`}
                    </span>
                    <button
                      type="button"
                      className="ws-alerts__rule-delete"
                      onClick={() => handleDeleteRule(rule.id)}
                      title="Delete rule"
                      aria-label={`Delete rule ${rule.name}`}
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
