// Phase 17B — Saved Investigations: typed client + snapshot helpers.
//
// The wire types here mirror the backend ``SavedInvestigation`` shapes.
// We deliberately do NOT add a parallel state model — the snapshot
// builder reads from the canonical ``useOverlayStore`` /
// ``useWorkspaceModeStore`` and the restorer writes back into them
// using the existing setters. No shadow store, no derived duplicate.
//
// Honest-freshness rule: snapshots freeze ``MarketPosture`` /
// ``MarketNarrative`` envelopes verbatim. The restorer never silently
// re-fetches the live posture / narrative; a separate "Refresh live"
// action (UI) is what re-runs the engines and labels both copies.

import {
  IntelligenceApiError,
  MarketNarrative,
  MarketPostureResponse,
  PostureAssetClass,
  ProviderHealth,
} from "@/lib/intelligence/types";
import {
  CompareTargetSelection,
  useOverlayStore,
} from "@/store/useOverlayStore";
import {
  WorkspaceMode,
  useWorkspaceModeStore,
} from "@/store/useWorkspaceModeStore";

// ---- wire types -----------------------------------------------------------

export type SavedWorkspaceMode = WorkspaceMode;

export interface CompareTargetSnapshotWire {
  kind: "country" | "event";
  id: string;
  label: string;
  country_code: string | null;
}

export interface WorkspaceSelectionSnapshotWire {
  country_code: string | null;
  country_name: string | null;
  event_id: string | null;
  event_summary: string | null;
  market_symbol: string | null;
  market_asset_class: PostureAssetClass | null;
}

export interface SavedInvestigationSnapshotWire {
  workspace_mode: SavedWorkspaceMode;
  selection: WorkspaceSelectionSnapshotWire;
  market_posture: MarketPostureResponse | null;
  market_narrative: MarketNarrative | null;
  portfolio_id: string | null;
  portfolio_as_of: string | null;
  compare_targets: CompareTargetSnapshotWire[];
  caveats: string[];
  provider_health_at_capture: ProviderHealth;
  freshness_seconds_at_capture: number | null;
  captured_at: string;
}

export interface SavedInvestigationWire {
  id: string;
  name: string;
  created_at: string;
  snapshot: SavedInvestigationSnapshotWire;
  share_token: string | null;
}

export interface SavedInvestigationListItemWire {
  id: string;
  name: string;
  created_at: string;
  captured_at: string;
  workspace_mode: SavedWorkspaceMode;
  primary_label: string;
  has_share: boolean;
}

export interface SavedInvestigationListResponseWire {
  total: number;
  items: SavedInvestigationListItemWire[];
}

export interface SavedInvestigationCreateRequest {
  name: string;
  snapshot: SavedInvestigationSnapshotWire;
}

// ---- snapshot capture from canonical stores -------------------------------

export interface SnapshotInputs {
  /** Optional override; defaults to ``new Date()`` so tests can pin time. */
  capturedAt?: Date;
}

/**
 * Build a ``SavedInvestigationSnapshotWire`` from the *current* state of
 * the canonical overlay + workspace-mode stores.
 *
 * Pure: reads only from the stores' current snapshots, never mutates.
 * The function intentionally accepts no app-state argument; callers that
 * need to test a specific state should populate the stores first.
 */
export function buildSnapshotFromStores(
  inputs: SnapshotInputs = {},
): SavedInvestigationSnapshotWire {
  const overlay = useOverlayStore.getState();
  const mode = useWorkspaceModeStore.getState().mode;
  const posture = overlay.portfolioRiskScore; // not the same as MarketPosture
  void posture;

  const capturedAt = (inputs.capturedAt ?? new Date()).toISOString();

  // The market-posture snapshot is whatever the right panel currently
  // holds (rendered in MarketPostureCard / MarketChart). The store does
  // not currently cache it; consumers that already have the response
  // pass it via captureWith() below.
  return {
    workspace_mode: mode,
    selection: {
      country_code: overlay.selectedCountryCode,
      country_name: overlay.selectedCountryName,
      event_id: overlay.selectedEventId,
      event_summary: overlay.selectedEvent?.summary ?? null,
      market_symbol: overlay.selectedMarketSymbol,
      market_asset_class: overlay.selectedMarketAssetClass,
    },
    market_posture: null,
    market_narrative: null,
    portfolio_id: overlay.selectedPortfolioId,
    portfolio_as_of: overlay.portfolioAsOf,
    compare_targets: overlay.compareTargets.map((t) => ({
      kind: t.kind,
      id: t.id,
      label: t.label,
      country_code: t.country_code,
    })),
    caveats: [],
    provider_health_at_capture: "unconfigured",
    freshness_seconds_at_capture: null,
    captured_at: capturedAt,
  };
}

export interface SnapshotEnrichment {
  /** Fully-typed posture envelope from a recent /market/{symbol}/posture call. */
  marketPosture?: MarketPostureResponse | null;
  /** Bounded narrative envelope from a recent /market/{symbol}/narrative call. */
  marketNarrative?: MarketNarrative | null;
  /** Extra caveats accumulated by the panel (e.g. provider degradations). */
  extraCaveats?: string[];
}

/**
 * Compose a snapshot from the stores plus any posture / narrative the
 * caller has already fetched. Splitting this from the pure
 * ``buildSnapshotFromStores`` keeps the store reader trivially testable
 * while letting the menu attach the typed posture envelope it has on
 * hand without re-fetching.
 *
 * The function also derives ``provider_health_at_capture`` and
 * ``freshness_seconds_at_capture`` from the posture envelope when one is
 * provided, so the share / restore surface can be labeled honestly.
 */
export function captureWith(
  enrichment: SnapshotEnrichment = {},
  inputs: SnapshotInputs = {},
): SavedInvestigationSnapshotWire {
  const base = buildSnapshotFromStores(inputs);
  const posture = enrichment.marketPosture ?? null;
  const narrative = enrichment.marketNarrative ?? null;

  const postureCaveats = posture?.caveats ?? [];
  const narrativeCaveats = narrative?.narrative_caveats ?? [];
  const extra = enrichment.extraCaveats ?? [];
  const caveats = Array.from(
    new Set([...postureCaveats, ...narrativeCaveats, ...extra]),
  );

  return {
    ...base,
    market_posture: posture,
    market_narrative: narrative,
    caveats,
    provider_health_at_capture:
      posture?.provider_health ?? base.provider_health_at_capture,
    freshness_seconds_at_capture:
      posture?.freshness_seconds ?? base.freshness_seconds_at_capture,
  };
}

// ---- restoration into canonical stores ------------------------------------

/**
 * Hydrate the canonical overlay store from a saved snapshot. No new
 * store, no shadow state — only existing setters are called.
 *
 * Restoration is deterministic: the snapshot's posture / narrative are
 * not re-fetched here. Callers that want a "Refresh live" affordance
 * should call the live posture / narrative endpoints separately and
 * keep both copies labeled.
 */
export function restoreSnapshotIntoStores(
  snapshot: SavedInvestigationSnapshotWire,
): void {
  const overlay = useOverlayStore.getState();
  const setMode = useWorkspaceModeStore.getState().setMode;

  // 1. Reset side state that could leak from the previous investigation.
  overlay.clearCompareTargets();
  overlay.clearPortfolio();

  // 2. Apply the workspace mode first so any downstream sync sees the
  //    intended mode, not whatever the current overlay happened to be.
  setMode(snapshot.workspace_mode);

  // 3. Apply selection slices through the canonical setters.
  if (snapshot.selection.country_code) {
    overlay.openCountry(
      snapshot.selection.country_code,
      snapshot.selection.country_name ?? undefined,
      "deep-link",
    );
  }

  if (snapshot.selection.market_symbol) {
    // The selectMarketSymbol setter is narrower than PostureAssetClass —
    // it rejects "unknown" because the chart dock has no rendering for
    // that bucket. Coerce to null in that case so the symbol is still
    // captured but the dock falls back to its default rendering.
    const assetClass = snapshot.selection.market_asset_class;
    const narrow =
      assetClass === "equities" ||
      assetClass === "fx" ||
      assetClass === "commodities" ||
      assetClass === "futures"
        ? assetClass
        : null;
    overlay.selectMarketSymbol(snapshot.selection.market_symbol, narrow);
  }

  // 4. Compare targets — push through the existing setter so the
  //    dedupe / cap rules stay authoritative.
  for (const target of snapshot.compare_targets) {
    const selection: CompareTargetSelection = {
      kind: target.kind,
      id: target.id,
      label: target.label,
      country_code: target.country_code,
    };
    overlay.addCompareTarget(selection);
  }

  // 5. Portfolio (if any) and as-of cursor.
  if (snapshot.portfolio_id) {
    overlay.openPortfolio(snapshot.portfolio_id, undefined, "portfolio");
    if (snapshot.portfolio_as_of) {
      overlay.setPortfolioAsOf(snapshot.portfolio_as_of);
    }
  }

  // 6. Re-apply mode at the end as well: openCountry/openPortfolio call
  //    paths can shove the overlay back to "country"/"portfolio", which
  //    would override an explicit "compare" mode capture. Re-asserting
  //    here keeps the restored mode authoritative.
  setMode(snapshot.workspace_mode);
}

// ---- freshness helper -----------------------------------------------------

export interface FreshnessLabel {
  ageSeconds: number;
  ageMinutes: number;
  text: string;
}

export function describeAge(
  capturedAt: string,
  now: Date = new Date(),
): FreshnessLabel {
  const captured = new Date(capturedAt).getTime();
  const ageSeconds = Math.max(0, Math.floor((now.getTime() - captured) / 1000));
  const ageMinutes = Math.floor(ageSeconds / 60);
  let text: string;
  if (ageSeconds < 60) {
    text = "just now";
  } else if (ageMinutes < 60) {
    text = `${ageMinutes}m ago`;
  } else if (ageMinutes < 60 * 24) {
    text = `${Math.floor(ageMinutes / 60)}h ago`;
  } else {
    text = `${Math.floor(ageMinutes / (60 * 24))}d ago`;
  }
  return { ageSeconds, ageMinutes, text };
}

// ---- typed client ---------------------------------------------------------

export interface InvestigationsClientOptions {
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
  options: InvestigationsClientOptions,
): Promise<T> {
  const baseUrl = resolveBaseUrl(options.baseUrl);
  const url = `${baseUrl}${path}`;
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
      `Investigations API ${path} failed: ${response.status}`,
      path,
      response.status,
    );
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export async function listSavedInvestigations(
  options: InvestigationsClientOptions = {},
): Promise<SavedInvestigationListResponseWire> {
  return call<SavedInvestigationListResponseWire>(
    "/api/intelligence/investigations",
    { method: "GET" },
    options,
  );
}

export async function saveInvestigation(
  payload: SavedInvestigationCreateRequest,
  options: InvestigationsClientOptions = {},
): Promise<SavedInvestigationWire> {
  return call<SavedInvestigationWire>(
    "/api/intelligence/investigations",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
    options,
  );
}

export async function getSavedInvestigation(
  id: string,
  options: InvestigationsClientOptions = {},
): Promise<SavedInvestigationWire> {
  return call<SavedInvestigationWire>(
    `/api/intelligence/investigations/${encodeURIComponent(id)}`,
    { method: "GET" },
    options,
  );
}

export async function deleteSavedInvestigation(
  id: string,
  options: InvestigationsClientOptions = {},
): Promise<void> {
  await call<void>(
    `/api/intelligence/investigations/${encodeURIComponent(id)}`,
    { method: "DELETE" },
    options,
  );
}

export async function issueShareToken(
  id: string,
  options: InvestigationsClientOptions = {},
): Promise<SavedInvestigationWire> {
  return call<SavedInvestigationWire>(
    `/api/intelligence/investigations/${encodeURIComponent(id)}/share`,
    { method: "POST" },
    options,
  );
}

export async function revokeShareToken(
  id: string,
  options: InvestigationsClientOptions = {},
): Promise<SavedInvestigationWire> {
  return call<SavedInvestigationWire>(
    `/api/intelligence/investigations/${encodeURIComponent(id)}/share`,
    { method: "DELETE" },
    options,
  );
}

export async function getSharedInvestigation(
  token: string,
  options: InvestigationsClientOptions = {},
): Promise<SavedInvestigationWire> {
  return call<SavedInvestigationWire>(
    `/api/intelligence/share/${encodeURIComponent(token)}`,
    { method: "GET" },
    options,
  );
}

/**
 * Build the absolute share URL for a given token. Kept here so the menu
 * and the share page do not duplicate the path string.
 */
export function buildShareUrl(token: string, origin?: string): string {
  const root =
    origin ??
    (typeof window !== "undefined" ? window.location.origin : "");
  return `${root.replace(/\/$/, "")}/share/${encodeURIComponent(token)}`;
}
