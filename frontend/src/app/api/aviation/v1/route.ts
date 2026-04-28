// api/aviation/v1
// Aviation flight event data.
// Proxies to FastAPI backend /events?layer=flights.

import type { NextRequest } from "next/server";

import { fail, success } from "../../_lib/envelope";
import { upstream } from "../../_lib/upstream";

const SOURCE = "aviation/v1";

interface BackendEvent {
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

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const limit = searchParams.get("limit") ?? "200";
  const region = searchParams.get("region") ?? undefined;

  try {
    const params: Record<string, string> = { layer: "flights", limit };
    if (region) {
      params.region = region;
    }

    const result = await upstream<{ items: BackendEvent[] }>({
      path: "/events",
      params,
    });

    return success(result.items, SOURCE);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to fetch aviation data.";
    return fail(message, SOURCE, 502);
  }
}
