// api/climate/v1
// Climate and weather event data.
// Proxies to FastAPI backend /events?layer=weather.

import type { NextRequest } from "next/server";

import { fail, success } from "../../_lib/envelope";
import { upstream } from "../../_lib/upstream";

const SOURCE = "climate/v1";

interface BackendEvent {
  id: string;
  type: string;
  lat: number;
  lon: number;
  severity: number;
  timestamp: string;
  metadata: {
    label?: string | null;
    radius_km?: number | null;
    region?: string | null;
  };
}

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const limit = searchParams.get("limit") ?? "100";
  const region = searchParams.get("region") ?? undefined;

  try {
    const params: Record<string, string> = { layer: "weather", limit };
    if (region) {
      params.region = region;
    }

    const result = await upstream<{ items: BackendEvent[] }>({
      path: "/events",
      params,
    });

    return success(result.items, SOURCE);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to fetch climate data.";
    return fail(message, SOURCE, 502);
  }
}
