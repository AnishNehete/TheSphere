import type { GlobeLayerId, RegionRecord, SearchQueryResult } from "@/lib/types";

interface ApiEventRecord {
  id: string;
  type: string;
  lat: number;
  lon: number;
  severity: number;
  timestamp: string;
  metadata: {
    callsign?: string | null;
    flight_id?: string | null;
    origin?: string | null;
    destination?: string | null;
    region?: string | null;
    altitude_ft?: number | null;
    velocity_mph?: number | null;
    heading_deg?: number | null;
    route?: {
      origin: { lat: number; lon: number };
      destination: { lat: number; lon: number };
    } | null;
  };
}

interface ApiRegionRecord {
  id: string;
  slug: string;
  name: string;
  centroid: {
    lat: number;
    lon: number;
  };
  geojson: RegionRecord["geojson"];
}

interface ApiQueryResult {
  layer: string;
  region: string | null;
  entityId: string | null;
  cameraPreset: string;
  action: SearchQueryResult["action"];
  available: boolean;
}

const PRODUCTION_API_URL = "https://thesphere-production-4aea.up.railway.app";

function getApiBaseUrl() {
  if (process.env.NEXT_PUBLIC_API_BASE_URL) {
    return process.env.NEXT_PUBLIC_API_BASE_URL;
  }

  if (typeof window !== "undefined") {
    const host = window.location.hostname;
    if (host !== "localhost" && host !== "127.0.0.1") {
      return PRODUCTION_API_URL;
    }
    return `${window.location.protocol}//${host}:8000`;
  }

  return "http://localhost:8000";
}

export async function fetchFlightEvents(limit = 200): Promise<ApiEventRecord[]> {
  const params = new URLSearchParams({
    layer: "flights",
    limit: String(limit),
  });
  const response = await fetch(`${getApiBaseUrl()}/events?${params.toString()}`, {
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error("Failed to fetch flight events.");
  }

  const data = (await response.json()) as { items?: ApiEventRecord[] };
  return data.items ?? [];
}

export async function fetchRegions(): Promise<ApiRegionRecord[]> {
  const response = await fetch(`${getApiBaseUrl()}/regions`, {
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error("Failed to fetch regions.");
  }

  const data = (await response.json()) as { items?: ApiRegionRecord[] };
  return data.items ?? [];
}

export async function postQuery(input: string): Promise<SearchQueryResult> {
  const response = await fetch(`${getApiBaseUrl()}/query`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      input,
    }),
  });

  if (!response.ok) {
    throw new Error("Failed to resolve search query.");
  }

  const result = (await response.json()) as ApiQueryResult;
  return {
    action: result.action,
    available: result.available,
    rawLayer: result.layer ?? null,
    layer: normalizeQueryLayer(result.layer),
    region: result.region,
    entityId: result.entityId,
    cameraPreset: result.cameraPreset,
  };
}

export function normalizeQueryLayer(layer: string | null): GlobeLayerId | null {
  if (!layer) {
    return null;
  }

  if (layer === "disease") {
    return "health";
  }

  if (layer === "markets") {
    return null;
  }

  return layer as GlobeLayerId;
}

export type { ApiEventRecord, ApiRegionRecord };
