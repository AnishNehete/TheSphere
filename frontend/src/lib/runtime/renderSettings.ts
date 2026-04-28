import type { DiagnosticsView, GeoAuditSettings, GlobeQualityPreset } from "@/lib/types";

export const QUALITY_STORAGE_KEY = "the-sphere.render-quality";
export const DEFAULT_GLOBE_QUALITY: GlobeQualityPreset = "high";
export const DEFAULT_DIAGNOSTICS_VIEW: DiagnosticsView = "full";
export const DEFAULT_DIAGNOSTICS_SEED = "nasa-audit";
export const FROZEN_DIAGNOSTICS_TIMESTAMP = "2026-01-01T00:00:00.000Z";

interface RuntimeRenderSettings {
  diagnosticsEnabled: boolean;
  diagnosticsView: DiagnosticsView;
  diagnosticsSeed: string | null;
  geoAuditEnabled: boolean;
  geoAudit: GeoAuditSettings;
  qualityPreset: GlobeQualityPreset;
}

const DEFAULT_GEO_AUDIT_SETTINGS: GeoAuditSettings = {
  borders: false,
  pickHits: false,
  clouds: false,
  atmosphere: false,
  postprocessing: false,
  stars: false,
  sun: false,
  markers: false,
  night: false,
};

export function parseDiagnosticsFlag(value: string | null | undefined) {
  if (!value) {
    return false;
  }

  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "on";
}

export function parseDiagnosticsView(value: string | null | undefined): DiagnosticsView {
  switch ((value ?? "").trim().toLowerCase()) {
    case "earth":
    case "borders":
    case "dots":
    case "uv":
    case "day":
    case "normal":
    case "specular":
      return value!.trim().toLowerCase() as DiagnosticsView;
    default:
      return DEFAULT_DIAGNOSTICS_VIEW;
  }
}

export function parseQualityPreset(value: string | null | undefined): GlobeQualityPreset | null {
  switch ((value ?? "").trim().toLowerCase()) {
    case "low":
    case "medium":
    case "high":
      return value!.trim().toLowerCase() as GlobeQualityPreset;
    default:
      return null;
  }
}

export function getRuntimeRenderSettings(): RuntimeRenderSettings {
  if (typeof window === "undefined") {
    return {
      diagnosticsEnabled: false,
      diagnosticsView: DEFAULT_DIAGNOSTICS_VIEW,
      diagnosticsSeed: null,
      geoAuditEnabled: false,
      geoAudit: DEFAULT_GEO_AUDIT_SETTINGS,
      qualityPreset: DEFAULT_GLOBE_QUALITY,
    };
  }

  const params = new URLSearchParams(window.location.search);
  const diagnosticsEnabled = parseDiagnosticsFlag(params.get("diagnostics"));
  const diagnosticsView = parseDiagnosticsView(params.get("diagnosticsView") ?? params.get("view"));
  const diagnosticsSeed = diagnosticsEnabled ? params.get("seed") ?? DEFAULT_DIAGNOSTICS_SEED : null;
  const geoAuditEnabled = parseDiagnosticsFlag(params.get("geoAudit") ?? params.get("audit"));

  const qualityFromQuery = parseQualityPreset(params.get("quality"));
  const qualityFromStorage = parseQualityPreset(window.localStorage.getItem(QUALITY_STORAGE_KEY));

  return {
    diagnosticsEnabled,
    diagnosticsView,
    diagnosticsSeed,
    geoAuditEnabled,
    geoAudit: {
      borders: geoAuditEnabled && parseDiagnosticsFlag(params.get("auditBorders")),
      pickHits: geoAuditEnabled && parseDiagnosticsFlag(params.get("auditPickHits")),
      clouds: geoAuditEnabled && parseDiagnosticsFlag(params.get("auditClouds")),
      atmosphere: geoAuditEnabled && parseDiagnosticsFlag(params.get("auditAtmosphere")),
      postprocessing: geoAuditEnabled && parseDiagnosticsFlag(params.get("auditPost")),
      stars: geoAuditEnabled && parseDiagnosticsFlag(params.get("auditStars")),
      sun: geoAuditEnabled && parseDiagnosticsFlag(params.get("auditSun")),
      markers: geoAuditEnabled && parseDiagnosticsFlag(params.get("auditMarkers")),
      night: geoAuditEnabled && parseDiagnosticsFlag(params.get("auditNight")),
    },
    qualityPreset: qualityFromQuery ?? qualityFromStorage ?? DEFAULT_GLOBE_QUALITY,
  };
}

export function isDiagnosticsRuntimeEnabled() {
  return getRuntimeRenderSettings().diagnosticsEnabled;
}

export function getRuntimeTimestamp() {
  if (isDiagnosticsRuntimeEnabled()) {
    return FROZEN_DIAGNOSTICS_TIMESTAMP;
  }

  return new Date().toISOString();
}

export function getRuntimeSeedBucket(intervalMs: number, salt = 0) {
  const { diagnosticsSeed } = getRuntimeRenderSettings();
  if (diagnosticsSeed) {
    return hashString(`${diagnosticsSeed}:${intervalMs}:${salt}`);
  }

  return Math.floor(Date.now() / intervalMs) ^ salt;
}

function hashString(input: string) {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return hash >>> 0;
}
