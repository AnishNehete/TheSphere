// api/regions/v1
// Region data with geospatial boundaries.
// Proxies to FastAPI backend /regions.

import { fail, success } from "../../_lib/envelope";
import { upstream } from "../../_lib/upstream";

const SOURCE = "regions/v1";

interface BackendRegion {
  id: string;
  slug: string;
  name: string;
  centroid: { lat: number; lon: number };
  geojson: unknown;
}

export async function GET() {
  try {
    const result = await upstream<{ items: BackendRegion[] }>({
      path: "/regions",
    });

    return success(result.items, SOURCE);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to fetch regions.";
    return fail(message, SOURCE, 502);
  }
}
