"use client";

import { useEffect, useState } from "react";

import { getHealth } from "@/lib/intelligence/client";
import type { HealthResponse } from "@/lib/intelligence/types";

const POLL_INTERVAL_MS = 60_000;

export function HealthBadge() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [errored, setErrored] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const response = await getHealth();
        if (!cancelled) {
          setHealth(response);
          setErrored(false);
        }
      } catch {
        if (!cancelled) setErrored(true);
      }
    };
    void load();
    const timer = window.setInterval(load, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  if (errored) {
    return (
      <div className="ws-health ws-health--down" role="status">
        <span className="ws-health__dot" aria-hidden />
        <span className="ws-health__label">Backbone offline</span>
      </div>
    );
  }

  if (!health) {
    return (
      <div className="ws-health ws-health--idle" role="status">
        <span className="ws-health__dot" aria-hidden />
        <span className="ws-health__label">Checking…</span>
      </div>
    );
  }

  const staleCount = health.adapters.filter((a) => a.stale).length;
  const persistence = health.persistence;
  const investigationsDurable = persistence?.investigations?.startsWith("SqlAlchemy") ?? false;
  const alertsDurable = persistence?.alerts?.startsWith("Redis") ?? false;
  const chartsSynthetic = persistence?.marketDataProvider?.startsWith("Synthetic") ?? false;
  const label =
    health.status === "ok"
      ? `Live · ${health.totalEventsIngested} events`
      : `Degraded · ${staleCount} stale`;
  const tooltipLines = [
    ...health.adapters.map(
      (a) => `${a.adapter}: ${a.lastItemCount}${a.stale ? " (stale)" : ""}`,
    ),
    "—",
    `investigations: ${persistence?.investigations ?? "?"}${investigationsDurable ? "" : " ⚠ in-memory"}`,
    `alerts: ${persistence?.alerts ?? "?"}${alertsDurable ? "" : " ⚠ in-memory"}`,
    `charts: ${persistence?.marketDataProvider ?? "?"}${chartsSynthetic ? " ⚠ synthetic" : ""}`,
  ].join("\n");

  return (
    <div
      className={`ws-health ws-health--${health.status === "ok" ? "ok" : "degraded"}`}
      role="status"
      title={tooltipLines}
      data-charts={chartsSynthetic ? "synthetic" : "live"}
    >
      <span className="ws-health__dot" aria-hidden />
      <span className="ws-health__label">{label}</span>
      {chartsSynthetic ? (
        <span className="ws-health__sub" data-testid="health-charts-synthetic">
          · charts: demo
        </span>
      ) : null}
    </div>
  );
}
