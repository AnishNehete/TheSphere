export type ExperiencePhase = "boot" | "intro" | "handoff" | "live";

export type GlobeLayerId = "flights" | "weather" | "conflict" | "health";
export type HudRailMode = "global" | GlobeLayerId;
export type GlobeQualityPreset = "low" | "medium" | "high";
export type DiagnosticsView = "full" | "earth" | "borders" | "dots" | "uv" | "day" | "normal" | "specular";
export interface GeoAuditSettings {
  borders: boolean;
  pickHits: boolean;
  clouds: boolean;
  atmosphere: boolean;
  postprocessing: boolean;
  // Phase 19C.3 — additional layer toggles for visual diagnostics so a
  // reviewer can confirm which environment systems actually rendered.
  stars: boolean;
  sun: boolean;
  markers: boolean;
  night: boolean;
}

export type CameraMode =
  | "intro"
  | "handoff"
  | "transition"
  | "live-idle"
  | "country-focus"
  | "signal-focus"
  | "side-view"
  | "weather-hero";

export interface LatLon {
  lat: number;
  lon: number;
}

export interface CountryCentroid extends LatLon {
  iso3: string;
  name: string;
}

export interface RegionRecord {
  id: string;
  slug: string;
  name: string;
  centroid: LatLon;
  geojson: {
    type: "Feature";
    properties?: Record<string, unknown>;
    geometry: {
      type: "Polygon" | "MultiPolygon";
      coordinates: number[][][] | number[][][][];
    };
  };
}

export interface CountryMetric {
  iso3: string;
  score: number;
  label: string;
  delta: number;
}

export interface FlightSignal {
  id: string;
  callsign: string;
  origin: string;
  destination: string;
  originPoint: LatLon;
  destinationPoint: LatLon;
  position: LatLon;
  altitudeFt: number;
  speedKts: number;
  severity: number;
  timestamp: string;
  iso3Hint?: string;
  regionHint?: string;
}

export interface WeatherSignal {
  id: string;
  label: string;
  center: LatLon;
  radiusKm: number;
  severity: number;
  timestamp: string;
  iso3Hint?: string;
}

export interface ConflictSignal {
  id: string;
  label: string;
  center: LatLon;
  severity: number;
  actors: [string, string];
  timestamp: string;
  iso3Hint?: string;
}

export interface HealthSignal {
  id: string;
  label: string;
  center: LatLon;
  spread: number;
  severity: number;
  timestamp: string;
  iso3Hint?: string;
}

export interface SignalSummary {
  id: string;
  title: string;
  detail: string;
  severity: number;
  timestamp: string;
  iso3Hint?: string;
}

export interface FeedEnvelope {
  flights: FlightSignal[];
  weather: WeatherSignal[];
  conflicts: ConflictSignal[];
  health: HealthSignal[];
  countryMetrics: CountryMetric[];
  lastUpdated: string;
}

export interface LayerModuleContract {
  id: GlobeLayerId;
  visible: boolean;
  onEnter?: () => void;
  onExit?: () => void;
  onUpdate?: (deltaSeconds: number) => void;
  onDispose?: () => void;
}

export type SearchResolutionType = "country" | "signal" | "region" | "layer" | "none";

export interface SearchResolution {
  query: string;
  type: SearchResolutionType;
  label: string;
  layer?: GlobeLayerId | null;
  countryIso3?: string;
  signalId?: string;
  regionSlug?: string;
  message?: string;
}

export interface SearchQueryResult {
  action: "activate_layer" | "focus_region" | "track_entity" | "idle";
  available: boolean;
  rawLayer: string | null;
  layer: GlobeLayerId | null;
  region: string | null;
  entityId: string | null;
  cameraPreset: string;
}

export type ScanAttentionLevel = "baseline" | "watch" | "elevated" | "critical";
export type ScanTrendDirection = "rising" | "stable" | "easing";

export interface RegionScanScope {
  kind: "global" | "country" | "region";
  title: string;
  countryIso3?: string | null;
  regionSlug?: string | null;
}

export interface ScanEvidenceItem {
  id: string;
  title: string;
  detail: string;
  severity: number;
  timestamp: string;
  iso3Hint?: string;
  layer: GlobeLayerId;
  weight: number;
  recencyWeight: number;
  ageHours: number;
  isPinned: boolean;
}

export interface RegionScanResult {
  scope: RegionScanScope;
  title: string;
  attentionLevel: ScanAttentionLevel;
  score: number;
  topSignals: ScanEvidenceItem[];
  trendDirection: ScanTrendDirection;
  trendSummary: string;
  likelyImpactAreas: string[];
  brief: string;
  dominantLayer: GlobeLayerId;
  evidence: ScanEvidenceItem[];
  signalCount: number;
  hotspotCount: number;
  flightCount: number;
  updatedAt: string | null;
}
