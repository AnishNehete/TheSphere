// api/conflict/v1
// Conflict and security event data.
// Proxies to FastAPI backend /events?layer=conflict.

import type { NextRequest } from "next/server";

import { fail, success } from "../../_lib/envelope";
import { upstream } from "../../_lib/upstream";

const SOURCE = "conflict/v1";

interface BackendEvent {
  id: string;
  type: string;
  lat: number;
  lon: number;
  severity: number;
  timestamp: string;
  metadata: {
    label?: string | null;
    actors?: [string, string] | null;
    region?: string | null;
  };
}

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const limit = searchParams.get("limit") ?? "100";
  const region = searchParams.get("region") ?? undefined;

  try {
    const params: Record<string, string> = { layer: "conflict", limit };
    if (region) {
      params.region = region;
    }

    const result = await upstream<{ items: BackendEvent[] }>({
      path: "/events",
      params,
    });

    return success(result.items, SOURCE);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to fetch conflict data.";
    return fail(message, SOURCE, 502);
  }
}
