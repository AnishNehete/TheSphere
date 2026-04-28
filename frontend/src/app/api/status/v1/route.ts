// api/status/v1
// Platform health and service status.
// Proxies to FastAPI backend /health.

import { fail, success } from "../../_lib/envelope";
import { upstream } from "../../_lib/upstream";

const SOURCE = "status/v1";

interface BackendHealth {
  status: string;
  postgres: boolean;
  redis: boolean;
  uptime_seconds?: number;
}

export async function GET() {
  try {
    const result = await upstream<BackendHealth>({
      path: "/health",
    });

    return success(result, SOURCE);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to reach backend.";
    return fail(message, SOURCE, 502);
  }
}
