import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { InvestigationWorkspace } from "@/components/homepage/InvestigationWorkspace";
import { useAppStore } from "@/store/useAppStore";
import { useDataStore } from "@/store/useDataStore";

vi.mock("@/lib/data/polling/useFeedPolling", () => ({
  useFeedPolling: () => ({
    ready: true,
    error: null,
  }),
}));

const LAST_UPDATED = "2026-03-30T12:00:00.000Z";

function seedLiveAppState(overrides: Record<string, unknown> = {}) {
  useAppStore.setState({
    engineReady: true,
    engineError: null,
    feedsReady: true,
    feedError: null,
    interactionMode: "explore",
    cameraOwner: "controls",
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
    cameraMode: "live-idle",
    autoRotate: true,
    userInteracting: false,
    hoveredCountry: null,
    selectedCountry: null,
    selectedRegionSlug: null,
    selectedSignalId: null,
    hoverTooltip: null,
    queryBrief: null,
    scrollProgress: 0,
    ...overrides,
  });
}

function seedDataState(overrides: Record<string, unknown> = {}) {
  useDataStore.setState({
    flights: [],
    weather: [],
    conflicts: [],
    health: [],
    countryMetrics: [],
    regions: [],
    lastUpdated: LAST_UPDATED,
    ...overrides,
  });
}

describe("InvestigationWorkspace", () => {
  beforeEach(() => {
    seedLiveAppState();
    seedDataState();
  });

  it("renders the search-first workspace sections", () => {
    render(<InvestigationWorkspace />);

    expect(screen.getByTestId("investigation-workspace")).toBeInTheDocument();
    expect(screen.getByTestId("hero-section")).toBeInTheDocument();
    expect(screen.getByTestId("hero-search-dock")).toBeInTheDocument();
    expect(screen.getByTestId("summary-section")).toBeInTheDocument();
    expect(screen.getByTestId("evidence-section")).toBeInTheDocument();
    expect(screen.getByTestId("dependency-section")).toBeInTheDocument();
    expect(screen.getByTestId("scoring-section")).toBeInTheDocument();
    expect(screen.getByTestId("actions-section")).toBeInTheDocument();
  });

  it("updates the investigation when searching for a country", async () => {
    seedDataState({
      conflicts: [
        {
          id: "conflict-fra",
          label: "Tension Node / France",
          center: { lat: 48.8, lon: 2.3 },
          severity: 0.91,
          actors: ["A", "B"],
          timestamp: "2026-03-30T10:00:00.000Z",
          iso3Hint: "FRA",
        },
      ],
    });

    render(<InvestigationWorkspace />);
    const user = userEvent.setup();

    await user.type(screen.getByRole("textbox", { name: "AI Search" }), "France");
    await user.click(screen.getByRole("button", { name: "Run Investigation" }));

    expect((await screen.findAllByText("France")).length).toBeGreaterThan(0);
    expect(within(screen.getByTestId("evidence-list")).getByText("Tension Node / France")).toBeInTheDocument();
  });

  it("keeps the country scope while pinning selected evidence", () => {
    seedLiveAppState({
      selectedCountry: "FRA",
      selectedSignalId: "weather-pin",
      activeLayer: "weather",
      interactionMode: "signal-focus",
      cameraOwner: "focus",
      cameraMode: "signal-focus",
    });
    seedDataState({
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
      conflicts: [
        {
          id: "conflict-lead",
          label: "Tension Node / France",
          center: { lat: 48.8, lon: 2.3 },
          severity: 0.96,
          actors: ["A", "B"],
          timestamp: "2026-03-30T11:40:00.000Z",
          iso3Hint: "FRA",
        },
      ],
    });

    render(<InvestigationWorkspace />);

    const evidenceButtons = within(screen.getByTestId("evidence-list")).getAllByRole("button");
    expect(evidenceButtons[0]).toHaveTextContent("Storm Front / France");
    expect(screen.getAllByText("France").length).toBeGreaterThan(0);
  });

  it("renders a quiet-state workspace when no evidence is scoped", () => {
    seedLiveAppState({
      selectedCountry: "FRA",
    });
    seedDataState({
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
    });

    render(<InvestigationWorkspace />);

    expect(screen.getAllByText(/quiet watch posture/i).length).toBeGreaterThan(0);
    expect(within(screen.getByTestId("evidence-list")).getByText(/no elevated evidence is currently scoped/i)).toBeInTheDocument();
    expect(screen.getByText(/dependency path remains empty/i)).toBeInTheDocument();
  });
});
