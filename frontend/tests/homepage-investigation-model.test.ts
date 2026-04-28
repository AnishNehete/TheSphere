import { buildHomepageInvestigation } from "@/lib/investigation/buildHomepageInvestigation";
import { useAppStore } from "@/store/useAppStore";
import { useDataStore } from "@/store/useDataStore";

describe("buildHomepageInvestigation", () => {
  it("derives one coherent homepage model with evidence, path, drivers, and score metadata", () => {
    useAppStore.setState({
      engineReady: true,
      engineError: null,
      feedsReady: true,
      feedError: null,
      interactionMode: "country-focus",
      cameraOwner: "focus",
      introProgress: 1,
      diagnosticsEnabled: false,
      diagnosticsView: "full",
      geoAuditEnabled: false,
      geoAudit: {
        borders: false,
        pickHits: false,
        clouds: false,
        atmosphere: false,
        postprocessing: false,
        stars: false,
        sun: false,
        markers: false,
        night: false,
      },
      qualityPreset: "high",
      reduceMotion: false,
      activeLayer: "conflict",
      showBorders: true,
      showClouds: true,
      showLabels: true,
      showHeatmap: true,
      cameraMode: "country-focus",
      autoRotate: false,
      userInteracting: false,
      hoveredCountry: null,
      selectedCountry: "FRA",
      selectedRegionSlug: null,
      selectedSignalId: null,
      hoverTooltip: null,
      queryBrief: null,
      scrollProgress: 0,
    });

    useDataStore.setState({
      flights: [
        {
          id: "flt-1",
          callsign: "AFR001",
          origin: "Paris",
          destination: "New York",
          originPoint: { lat: 48.8, lon: 2.3 },
          destinationPoint: { lat: 40.7, lon: -74 },
          position: { lat: 47, lon: -15 },
          altitudeFt: 35000,
          speedKts: 470,
          severity: 0.55,
          timestamp: "2026-03-30T11:00:00.000Z",
          iso3Hint: "FRA",
          regionHint: "europe",
        },
      ],
      weather: [
        {
          id: "weather-1",
          label: "Storm Front / France",
          center: { lat: 46.7, lon: 1.4 },
          radiusKm: 220,
          severity: 0.62,
          timestamp: "2026-03-30T10:30:00.000Z",
          iso3Hint: "FRA",
        },
      ],
      conflicts: [
        {
          id: "conflict-1",
          label: "Tension Node / France",
          center: { lat: 48.8, lon: 2.3 },
          severity: 0.91,
          actors: ["A", "B"],
          timestamp: "2026-03-30T11:40:00.000Z",
          iso3Hint: "FRA",
        },
      ],
      health: [],
      countryMetrics: [
        {
          iso3: "FRA",
          score: 2.1,
          label: "Escalating",
          delta: 0.42,
        },
      ],
      regions: [],
      lastUpdated: "2026-03-30T12:00:00.000Z",
    });

    const model = buildHomepageInvestigation(useAppStore.getState(), useDataStore.getState());

    expect(model.title).toBe("France");
    expect(model.summary.body).toMatch(/confidence/i);
    expect(model.evidence[0]?.title).toBe("Tension Node / France");
    expect(model.dependencyPath.length).toBeGreaterThan(0);
    expect(model.score.delta).toBe(0.42);
    expect(model.score.drivers.length).toBeGreaterThan(0);
    expect(model.actions.map((item) => item.id)).toEqual(["export", "copy-summary", "investigate-related"]);
  });
});
