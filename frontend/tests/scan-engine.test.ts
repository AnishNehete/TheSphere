import { buildRegionScan } from "@/lib/scan/buildRegionScan";
import { scoreRegion } from "@/lib/scan/scoreRegion";

const REFERENCE_TIME = "2026-03-30T12:00:00.000Z";

function buildOptions(overrides: Partial<Parameters<typeof buildRegionScan>[0]> = {}) {
  return {
    activeLayer: "conflict" as const,
    selectedCountry: null,
    selectedRegionSlug: null,
    selectedSignalId: null,
    flights: [],
    weather: [],
    conflicts: [],
    health: [],
    countryMetrics: [],
    regions: [],
    lastUpdated: REFERENCE_TIME,
    now: REFERENCE_TIME,
    ...overrides,
  };
}

describe("buildRegionScan", () => {
  it("returns a quiet country scan when no scoped evidence exists", () => {
    const scan = buildRegionScan(
      buildOptions({
        selectedCountry: "FRA",
        conflicts: [
          {
            id: "conflict-usa",
            label: "Tension Node / United States",
            center: { lat: 38, lon: -97 },
            severity: 0.88,
            actors: ["A", "B"],
            timestamp: "2026-03-30T10:00:00.000Z",
            iso3Hint: "USA",
          },
        ],
      })
    );

    expect(scan).toMatchObject({
      title: "France",
      attentionLevel: "baseline",
      score: 0,
      topSignals: [],
      evidence: [],
    });
    expect(scan.brief).toMatch(/quiet watch posture/i);
  });

  it("maps score thresholds to baseline, watch, elevated, and critical attention bands", () => {
    const baseline = scoreRegion([]);
    const watch = scoreRegion(
      Array.from({ length: 5 }, () => ({
        layer: "weather" as const,
        weight: 0.45,
        recencyWeight: 0.55,
      }))
    );
    const elevated = scoreRegion(
      Array.from({ length: 7 }, () => ({
        layer: "conflict" as const,
        weight: 0.75,
        recencyWeight: 0.8,
      }))
    );
    const critical = scoreRegion(
      Array.from({ length: 10 }, () => ({
        layer: "conflict" as const,
        weight: 1,
        recencyWeight: 1,
      }))
    );

    expect(baseline.attentionLevel).toBe("baseline");
    expect(watch.attentionLevel).toBe("watch");
    expect(watch.score).toBeGreaterThanOrEqual(35);
    expect(elevated.attentionLevel).toBe("elevated");
    expect(elevated.score).toBeGreaterThanOrEqual(58);
    expect(critical.attentionLevel).toBe("critical");
    expect(critical.score).toBeGreaterThanOrEqual(78);
  });

  it("falls back to country metric delta when there is not enough older evidence for a trend comparison", () => {
    const scan = buildRegionScan(
      buildOptions({
        selectedCountry: "FRA",
        countryMetrics: [
          {
            iso3: "FRA",
            score: 2.1,
            label: "Escalating",
            delta: 0.42,
          },
        ],
        conflicts: [
          {
            id: "conflict-fra-1",
            label: "Tension Node / France",
            center: { lat: 48.8, lon: 2.3 },
            severity: 0.9,
            actors: ["A", "B"],
            timestamp: "2026-03-30T11:00:00.000Z",
            iso3Hint: "FRA",
          },
        ],
        health: [
          {
            id: "health-fra-1",
            label: "Hospital Surge / France",
            center: { lat: 47.4, lon: 1.8 },
            spread: 180,
            severity: 0.76,
            timestamp: "2026-03-30T09:30:00.000Z",
            iso3Hint: "FRA",
          },
        ],
      })
    );

    expect(scan.trendDirection).toBe("rising");
    expect(scan.trendSummary).toMatch(/rising/i);
  });

  it("pins the selected signal to the top of the evidence order even when another item scores higher", () => {
    const scan = buildRegionScan(
      buildOptions({
        selectedCountry: "FRA",
        selectedSignalId: "weather-pin",
        conflicts: [
          {
            id: "conflict-lead",
            label: "Tension Node / France",
            center: { lat: 48.8, lon: 2.3 },
            severity: 0.95,
            actors: ["A", "B"],
            timestamp: "2026-03-30T11:30:00.000Z",
            iso3Hint: "FRA",
          },
        ],
        weather: [
          {
            id: "weather-pin",
            label: "Storm Front / France",
            center: { lat: 46.7, lon: 1.4 },
            radiusKm: 220,
            severity: 0.42,
            timestamp: "2026-03-29T20:00:00.000Z",
            iso3Hint: "FRA",
          },
        ],
      })
    );

    expect(scan.evidence[0]?.id).toBe("weather-pin");
    expect(scan.evidence[0]?.isPinned).toBe(true);
    expect(scan.topSignals[0]?.id).toBe("weather-pin");
  });

  it("derives impact areas from the dominant source mapping", () => {
    const scan = buildRegionScan(
      buildOptions({
        selectedCountry: "FRA",
        health: [
          {
            id: "health-fra-1",
            label: "Containment Alert / France",
            center: { lat: 47.2, lon: 1.2 },
            spread: 220,
            severity: 0.91,
            timestamp: "2026-03-30T10:30:00.000Z",
            iso3Hint: "FRA",
          },
        ],
      })
    );

    expect(scan.likelyImpactAreas).toEqual(["public health", "hospital capacity", "mobility"]);
  });
});
