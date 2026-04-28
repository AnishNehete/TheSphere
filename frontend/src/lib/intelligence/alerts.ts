// Phase 17C.2 — Alert MVP client + types.
//
// Mirrors the backend alerts wire shapes 1:1. The frontend never
// invents alert state — the bell renders backend-evaluated events
// only. Polling cadence is intentionally a 30s simple HTTP loop
// (no WebSocket in the MVP) so the frontend stays trivial to reason
// about and matches the existing intelligence polling pattern.

import {
  IntelligenceApiError,
  MarketPostureResponse,
  PostureAssetClass,
} from "@/lib/intelligence/types";

export type AlertRuleKind = "posture_band_change" | "confidence_drop";
export type AlertDeltaField = "posture" | "confidence";

export interface AlertRuleWire {
  id: string;
  name: string;
  kind: AlertRuleKind;
  symbol: string;
  asset_class: PostureAssetClass;
  threshold: number | null;
  cooldown_seconds: number;
  enabled: boolean;
  created_at: string;
  baseline_posture: string | null;
  baseline_confidence: number | null;
  baseline_at: string | null;
  last_evaluated_at: string | null;
  last_fired_at: string | null;
}

export interface AlertDeltaWire {
  kind: AlertRuleKind;
  field: AlertDeltaField;
  from_value: string;
  to_value: string;
  magnitude: number;
  summary: string;
}

export interface AlertEventWire {
  id: string;
  rule_id: string;
  rule_name: string;
  fired_at: string;
  triggering_posture: MarketPostureResponse;
  delta: AlertDeltaWire;
}

export interface AlertRuleListResponseWire {
  total: number;
  items: AlertRuleWire[];
}

export interface AlertEventListResponseWire {
  total: number;
  items: AlertEventWire[];
}

export interface AlertRuleCreateRequest {
  name: string;
  kind: AlertRuleKind;
  symbol: string;
  asset_class?: PostureAssetClass;
  threshold?: number | null;
  cooldown_seconds?: number;
  enabled?: boolean;
}

export interface AlertsClientOptions {
  baseUrl?: string;
  fetcher?: typeof fetch;
  signal?: AbortSignal;
}

function resolveBaseUrl(explicit: string | undefined): string {
  if (explicit) return explicit.replace(/\/$/, "");
  if (typeof process !== "undefined" && process.env?.NEXT_PUBLIC_API_BASE_URL) {
    return process.env.NEXT_PUBLIC_API_BASE_URL.replace(/\/$/, "");
  }
  if (typeof window !== "undefined") {
    return `${window.location.protocol}//${window.location.hostname}:8000`;
  }
  return "http://localhost:8000";
}

async function call<T>(
  path: string,
  init: RequestInit,
  options: AlertsClientOptions,
  searchParams: Record<string, string | number | undefined> = {},
): Promise<T> {
  const baseUrl = resolveBaseUrl(options.baseUrl);
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams)) {
    if (value === undefined || value === null) continue;
    query.set(key, String(value));
  }
  const suffix = query.toString();
  const url = `${baseUrl}${path}${suffix ? `?${suffix}` : ""}`;
  const fetcher = options.fetcher ?? fetch;
  let response: Response;
  try {
    response = await fetcher(url, {
      ...init,
      cache: "no-store",
      signal: options.signal,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Network error";
    throw new IntelligenceApiError(message, path, null);
  }
  if (!response.ok && response.status !== 204) {
    throw new IntelligenceApiError(
      `Alerts API ${path} failed: ${response.status}`,
      path,
      response.status,
    );
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export async function listAlertRules(
  options: AlertsClientOptions = {},
): Promise<AlertRuleListResponseWire> {
  return call<AlertRuleListResponseWire>(
    "/api/intelligence/alerts/rules",
    { method: "GET" },
    options,
  );
}

export async function createAlertRule(
  payload: AlertRuleCreateRequest,
  options: AlertsClientOptions = {},
): Promise<AlertRuleWire> {
  return call<AlertRuleWire>(
    "/api/intelligence/alerts/rules",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
    options,
  );
}

export async function deleteAlertRule(
  ruleId: string,
  options: AlertsClientOptions = {},
): Promise<void> {
  await call<void>(
    `/api/intelligence/alerts/rules/${encodeURIComponent(ruleId)}`,
    { method: "DELETE" },
    options,
  );
}

export interface ListAlertEventsParams {
  since?: string | null;
  limit?: number;
}

export async function listAlertEvents(
  params: ListAlertEventsParams = {},
  options: AlertsClientOptions = {},
): Promise<AlertEventListResponseWire> {
  return call<AlertEventListResponseWire>(
    "/api/intelligence/alerts/events",
    { method: "GET" },
    options,
    {
      since: params.since ?? undefined,
      limit: params.limit ?? 50,
    },
  );
}
