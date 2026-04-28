import { buildCountryMetrics } from "@/lib/data/transform/countryMetrics";
import { appendPoint } from "@/lib/data/transform/timeSeries";

describe("data transforms", () => {
  it("builds sorted country metrics from normalized feeds", () => {
    const metrics = buildCountryMetrics({
      flights: [
        {
          id: "f1",
          callsign: "AA101",
          origin: "JFK",
          destination: "LHR",
          originPoint: { lat: 1, lon: 1 },
          destinationPoint: { lat: 2, lon: 2 },
          position: { lat: 1, lon: 1 },
          altitudeFt: 30000,
          speedKts: 470,
          severity: 0.7,
          timestamp: "2026-01-01T00:00:00.000Z",
          iso3Hint: "USA",
        },
      ],
      weather: [
        {
          id: "w1",
          label: "Storm",
          center: { lat: 3, lon: 3 },
          radiusKm: 200,
          severity: 0.4,
          timestamp: "2026-01-01T00:00:00.000Z",
          iso3Hint: "USA",
        },
      ],
      conflicts: [
        {
          id: "c1",
          label: "Conflict",
          center: { lat: 4, lon: 4 },
          severity: 0.9,
          actors: ["A", "B"],
          timestamp: "2026-01-01T00:00:00.000Z",
          iso3Hint: "FRA",
        },
      ],
      health: [
        {
          id: "h1",
          label: "Outbreak",
          center: { lat: 5, lon: 5 },
          spread: 120,
          severity: 0.6,
          timestamp: "2026-01-01T00:00:00.000Z",
          iso3Hint: "FRA",
        },
      ],
    });

    expect(metrics.length).toBe(2);
    expect(metrics[0].iso3).toBe("FRA");
    expect(metrics[1].iso3).toBe("USA");
  });

  it("caps time series to max length", () => {
    const points = Array.from({ length: 3 }, (_, index) => ({
      timestamp: `t-${index}`,
      value: index,
    }));
    const next = appendPoint(points, { timestamp: "t-3", value: 3 }, 3);
    expect(next).toEqual([
      { timestamp: "t-1", value: 1 },
      { timestamp: "t-2", value: 2 },
      { timestamp: "t-3", value: 3 },
    ]);
  });
});
