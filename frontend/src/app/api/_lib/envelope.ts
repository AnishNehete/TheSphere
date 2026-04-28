// _lib/envelope.ts
// Standard API response envelope for all Sphere v1 endpoints.
// Mirrors the worldmonitor pattern of consistent response shapes.

import { NextResponse } from "next/server";

export interface ApiEnvelope<T = unknown> {
  ok: boolean;
  data: T | null;
  error: string | null;
  meta: {
    version: "v1";
    timestamp: string;
    source: string;
  };
}

export function success<T>(data: T, source: string): NextResponse<ApiEnvelope<T>> {
  return NextResponse.json({
    ok: true,
    data,
    error: null,
    meta: {
      version: "v1",
      timestamp: new Date().toISOString(),
      source,
    },
  });
}

export function fail(message: string, source: string, status = 500): NextResponse<ApiEnvelope<null>> {
  return NextResponse.json(
    {
      ok: false,
      data: null,
      error: message,
      meta: {
        version: "v1",
        timestamp: new Date().toISOString(),
        source,
      },
    },
    { status }
  );
}

export function notImplemented(source: string): NextResponse<ApiEnvelope<null>> {
  return fail("This domain endpoint is planned but not yet connected to a live data source.", source, 501);
}
