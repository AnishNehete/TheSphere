import { useAppStore } from "@/store/useAppStore";

describe("useAppStore", () => {
  beforeEach(() => {
    useAppStore.setState({
      engineReady: false,
      engineError: null,
      feedsReady: false,
      feedError: null,
      interactionMode: "boot",
      cameraOwner: "boot",
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
  });

  it("moves from boot into direct investigation mode when the engine becomes ready", () => {
    const store = useAppStore.getState();
    store.setEngineReady(true);
    expect(useAppStore.getState()).toMatchObject({
      engineReady: true,
      interactionMode: "explore",
      cameraOwner: "controls",
      introProgress: 1,
      cameraMode: "live-idle",
    });
  });

  it("stores runtime and feed readiness independently", () => {
    const store = useAppStore.getState();
    store.setRuntimeSettings({
      diagnosticsEnabled: true,
      diagnosticsView: "dots",
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
      qualityPreset: "medium",
      reduceMotion: true,
    });
    store.setFeedsStatus(true, null);

    expect(useAppStore.getState()).toMatchObject({
      diagnosticsEnabled: true,
      diagnosticsView: "dots",
      qualityPreset: "medium",
      reduceMotion: true,
      autoRotate: false,
      feedsReady: true,
      feedError: null,
    });
  });

  it("updates focus state with explicit camera ownership", () => {
    const store = useAppStore.getState();
    store.focusCountry("FRA");
    expect(useAppStore.getState()).toMatchObject({
      selectedCountry: "FRA",
      selectedRegionSlug: null,
      selectedSignalId: null,
      interactionMode: "country-focus",
      cameraOwner: "focus",
      autoRotate: false,
    });

    store.focusSignal("signal-1", "USA");
    expect(useAppStore.getState()).toMatchObject({
      selectedCountry: "USA",
      selectedSignalId: "signal-1",
      interactionMode: "signal-focus",
      cameraOwner: "focus",
    });

    store.focusRegion("europe");
    expect(useAppStore.getState()).toMatchObject({
      selectedCountry: null,
      selectedRegionSlug: "europe",
      selectedSignalId: null,
      interactionMode: "country-focus",
      cameraOwner: "focus",
    });

    store.clearFocus();
    expect(useAppStore.getState()).toMatchObject({
      selectedCountry: null,
      selectedRegionSlug: null,
      selectedSignalId: null,
      interactionMode: "explore",
      cameraOwner: "controls",
      autoRotate: true,
    });
  });

  it("stores hover tooltip and analyst query state for the overlay", () => {
    const store = useAppStore.getState();
    store.setHoveredCountry("FRA");
    store.setHoverTooltip({
      x: 100,
      y: 120,
      iso3: "FRA",
      eyebrow: "4 live signals",
      title: "France",
      score: 1.9,
      signalCount: 4,
      summary: "France is under active watch.",
      activeLayer: "conflict",
    });
    store.setQueryBrief({
      query: "France",
      title: "France",
      detail: "4 active signals / country focus engaged",
      summary: "France is under active watch.",
      actionLabel: "Analyst Brief",
      type: "country",
      layer: "conflict",
    });

    expect(useAppStore.getState()).toMatchObject({
      hoveredCountry: "FRA",
      hoverTooltip: {
        title: "France",
      },
      queryBrief: {
        title: "France",
        layer: "conflict",
      },
    });

    store.clearQueryBrief();
    expect(useAppStore.getState().queryBrief).toBeNull();
  });
});
