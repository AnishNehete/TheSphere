import { CameraDirector, resolveFocusTarget } from "@/engine/camera";
import { GlobeControls } from "@/engine/controls";
import { useAppStore } from "@/store/useAppStore";
import { useDataStore } from "@/store/useDataStore";

describe("camera director", () => {
  beforeEach(() => {
    useAppStore.setState({
      engineReady: true,
      engineError: null,
      feedsReady: true,
      feedError: null,
      interactionMode: "intro",
      cameraOwner: "intro",
      introProgress: 0,
      diagnosticsEnabled: false,
      diagnosticsView: "full",
      qualityPreset: "high",
      reduceMotion: false,
      activeLayer: "flights",
      showBorders: true,
      showClouds: true,
      showLabels: true,
      showHeatmap: true,
      autoRotate: true,
      userInteracting: false,
      hoveredCountry: null,
      selectedCountry: null,
      selectedRegionSlug: null,
      selectedSignalId: null,
      hoverTooltip: null,
      queryBrief: null,
    });
    useDataStore.setState({
      flights: [],
      weather: [],
      conflicts: [],
      health: [],
      countryMetrics: [],
      regions: [
        {
          id: "europe",
          slug: "europe",
          name: "Europe",
          centroid: { lat: 50, lon: 10 },
          geojson: {
            type: "Feature",
            geometry: {
              type: "Polygon",
              coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]],
            },
          },
        },
      ],
      lastUpdated: null,
    });
  });

  it("resolves focus targets for country, region, and signal selections", () => {
    useAppStore.setState({ selectedCountry: "FRA" });
    expect(resolveFocusTarget(useAppStore.getState(), useDataStore.getState()).target.length()).toBeGreaterThan(0);

    useAppStore.setState({
      selectedCountry: null,
      selectedRegionSlug: "europe",
    });
    expect(resolveFocusTarget(useAppStore.getState(), useDataStore.getState()).target.length()).toBeGreaterThan(0);

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
          severity: 0.8,
          timestamp: "2026-01-01T00:00:00.000Z",
          iso3Hint: "FRA",
          regionHint: "europe",
        },
      ],
    });
    useAppStore.setState({
      selectedRegionSlug: null,
      selectedSignalId: "flt-1",
    });
    expect(resolveFocusTarget(useAppStore.getState(), useDataStore.getState()).target.length()).toBeGreaterThan(0);
  });

  it("hands intro ownership off to controls after the cinematic intro completes", () => {
    const controls = new GlobeControls();
    const director = new CameraDirector(controls);

    director.update(9.5, 9.5, useAppStore.getState(), useDataStore.getState());

    expect(useAppStore.getState()).toMatchObject({
      interactionMode: "explore",
      cameraOwner: "controls",
      introProgress: 1,
    });
  });

  it("hands focus ownership off to controls after the focus transition completes", () => {
    const controls = new GlobeControls();
    const director = new CameraDirector(controls);

    useAppStore.setState({
      interactionMode: "country-focus",
      cameraOwner: "focus",
      selectedCountry: "FRA",
    });

    director.update(2, 2, useAppStore.getState(), useDataStore.getState());

    expect(useAppStore.getState().cameraOwner).toBe("controls");
  });
});
