import { vi } from "vitest";

import { postQuery } from "@/lib/api";
import { resolveSearchIntent } from "@/lib/search/resolveSearchIntent";

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    postQuery: vi.fn(),
  };
});

const mockedPostQuery = vi.mocked(postQuery);

describe("resolveSearchIntent", () => {
  beforeEach(() => {
    mockedPostQuery.mockReset();
  });

  it("matches exact countries locally", async () => {
    const result = await resolveSearchIntent({
      query: "France",
      flights: [],
      weather: [],
      conflicts: [],
      health: [],
      regions: [],
    });

    expect(result).toMatchObject({
      type: "country",
      countryIso3: "FRA",
    });
    expect(mockedPostQuery).not.toHaveBeenCalled();
  });

  it("matches live callsigns locally", async () => {
    const result = await resolveSearchIntent({
      query: "AA101",
      flights: [
        {
          id: "f-1",
          callsign: "AA101",
          origin: "JFK",
          destination: "LHR",
          originPoint: { lat: 0, lon: 0 },
          destinationPoint: { lat: 1, lon: 1 },
          position: { lat: 0.2, lon: 0.4 },
          altitudeFt: 32000,
          speedKts: 460,
          severity: 0.5,
          timestamp: "2026-01-01T00:00:00.000Z",
          iso3Hint: "USA",
        },
      ],
      weather: [],
      conflicts: [],
      health: [],
      regions: [],
    });

    expect(result).toMatchObject({
      type: "signal",
      signalId: "f-1",
      layer: "flights",
      countryIso3: "USA",
    });
  });

  it("uses backend query compatibility mapping for legacy disease results", async () => {
    mockedPostQuery.mockResolvedValue({
      action: "focus_region",
      available: true,
      rawLayer: "disease",
      layer: "health",
      region: "europe",
      entityId: null,
      cameraPreset: "regional_focus",
    });

    const result = await resolveSearchIntent({
      query: "outbreak middle east",
      flights: [],
      weather: [],
      conflicts: [],
      health: [],
      regions: [
        {
          id: "r-1",
          slug: "europe",
          name: "Europe",
          centroid: { lat: 50, lon: 15 },
          geojson: {
            type: "Feature",
            geometry: {
              type: "Polygon",
              coordinates: [[[-12, 35], [42, 35], [42, 72], [-12, 72], [-12, 35]]],
            },
          },
        },
      ],
    });

    expect(result).toMatchObject({
      type: "region",
      regionSlug: "europe",
      layer: "health",
    });
  });
});
