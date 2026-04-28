// api/intelligence/v1
// Investigation query endpoint.
// Proxies POST to FastAPI backend /query for entity resolution and search.

import type { NextRequest } from "next/server";

import { fail, success } from "../../_lib/envelope";
import { upstream } from "../../_lib/upstream";

const SOURCE = "intelligence/v1";

interface QueryPayload {
  query: string;
  layer?: string;
  region?: string;
}

interface BackendQueryResult {
  action: string;
  available: boolean;
  rawLayer: string | null;
  layer: string | null;
  region: string | null;
  entityId: string | null;
  cameraPreset: string;
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as QueryPayload;

    if (!body.query || typeof body.query !== "string") {
      return fail("Missing required field: query", SOURCE, 400);
    }

    const result = await upstream<BackendQueryResult>({
      path: "/query",
      method: "POST",
      body: {
        query: body.query,
        layer: body.layer ?? null,
        region: body.region ?? null,
      },
      timeoutMs: 12000,
    });

    return success(result, SOURCE);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Intelligence query failed.";
    return fail(message, SOURCE, 502);
  }
}
