import { regionContainsLatLon } from "@/lib/three/geo";
import type {
  ConflictSignal,
  CountryMetric,
  FlightSignal,
  GlobeLayerId,
  HealthSignal,
  RegionRecord,
  WeatherSignal,
} from "@/lib/types";

export type SignalScope = GlobeLayerId | "global";

export const LAYER_LABELS: Record<GlobeLayerId, string> = {
  flights: "Flights",
  weather: "Weather",
  conflict: "Conflict",
  health: "Health",
};

export interface SignalRow {
  id: string;
  title: string;
  detail: string;
  severity: number;
  timestamp: string;
  iso3Hint?: string;
  layer: GlobeLayerId;
  lat: number;
  lon: number;
}

interface SignalInputs {
  flights: FlightSignal[];
  weather: WeatherSignal[];
  conflicts: ConflictSignal[];
  health: HealthSignal[];
}

function sortByPriority(left: SignalRow, right: SignalRow) {
  if (left.severity !== right.severity) {
    return right.severity - left.severity;
  }

  return new Date(right.timestamp).getTime() - new Date(left.timestamp).getTime();
}

function buildFlightsRows(rows: FlightSignal[]): SignalRow[] {
  return rows.map((signal) => ({
    id: signal.id,
    title: signal.callsign,
    detail: `${signal.origin} -> ${signal.destination}`,
    severity: signal.severity,
    timestamp: signal.timestamp,
    iso3Hint: signal.iso3Hint,
    layer: "flights",
    lat: signal.position.lat,
    lon: signal.position.lon,
  }));
}

function buildWeatherRows(rows: WeatherSignal[]): SignalRow[] {
  return rows.map((signal) => ({
    id: signal.id,
    title: signal.label,
    detail: `${Math.round(signal.radiusKm)} km weather radius`,
    severity: signal.severity,
    timestamp: signal.timestamp,
    iso3Hint: signal.iso3Hint,
    layer: "weather",
    lat: signal.center.lat,
    lon: signal.center.lon,
  }));
}

function buildConflictRows(rows: ConflictSignal[]): SignalRow[] {
  return rows.map((signal) => ({
    id: signal.id,
    title: signal.label,
    detail: `${signal.actors[0]} vs ${signal.actors[1]}`,
    severity: signal.severity,
    timestamp: signal.timestamp,
    iso3Hint: signal.iso3Hint,
    layer: "conflict",
    lat: signal.center.lat,
    lon: signal.center.lon,
  }));
}

function buildHealthRows(rows: HealthSignal[]): SignalRow[] {
  return rows.map((signal) => ({
    id: signal.id,
    title: signal.label,
    detail: `Spread ${signal.spread.toFixed(0)}`,
    severity: signal.severity,
    timestamp: signal.timestamp,
    iso3Hint: signal.iso3Hint,
    layer: "health",
    lat: signal.center.lat,
    lon: signal.center.lon,
  }));
}

export function buildSignalRows(input: SignalInputs, scope: SignalScope, limit = 16): SignalRow[] {
  const flights = buildFlightsRows(input.flights);
  const weather = buildWeatherRows(input.weather);
  const conflicts = buildConflictRows(input.conflicts);
  const health = buildHealthRows(input.health);

  if (scope === "global") {
    return [...flights, ...weather, ...conflicts, ...health].sort(sortByPriority).slice(0, limit);
  }

  if (scope === "flights") {
    return flights.sort(sortByPriority).slice(0, limit);
  }

  if (scope === "weather") {
    return weather.sort(sortByPriority).slice(0, limit);
  }

  if (scope === "conflict") {
    return conflicts.sort(sortByPriority).slice(0, limit);
  }

  return health.sort(sortByPriority).slice(0, limit);
}

export function filterRowsByFocus(rows: SignalRow[], selectedCountry: string | null, region: RegionRecord | null) {
  if (selectedCountry) {
    const countryRows = rows.filter((row) => row.iso3Hint === selectedCountry);
    return countryRows.length > 0 ? countryRows : rows;
  }

  if (region) {
    const regionRows = rows.filter((row) => regionContainsLatLon(region, row.lat, row.lon));
    return regionRows.length > 0 ? regionRows : rows;
  }

  return rows;
}

export function formatUtcTimestamp(timestamp: string | null) {
  if (!timestamp) {
    return "--";
  }

  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) {
    return "--";
  }

  return parsed.toISOString().replace("T", " ").replace(".000Z", "Z");
}

export function formatRelativeTime(timestamp: string | null) {
  if (!timestamp) {
    return "--";
  }

  const parsed = new Date(timestamp).getTime();
  if (Number.isNaN(parsed)) {
    return "--";
  }

  const deltaSeconds = Math.max(0, Math.floor((Date.now() - parsed) / 1000));
  if (deltaSeconds < 60) {
    return `${deltaSeconds}s ago`;
  }

  const deltaMinutes = Math.floor(deltaSeconds / 60);
  if (deltaMinutes < 60) {
    return `${deltaMinutes}m ago`;
  }

  const deltaHours = Math.floor(deltaMinutes / 60);
  return `${deltaHours}h ago`;
}

export function formatTimeStampCompact(timestamp: string) {
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) {
    return "--:--";
  }

  return parsed.toISOString().slice(11, 16);
}

export function getDominantLayer(rows: SignalRow[], fallbackLayer: GlobeLayerId = "conflict") {
  if (rows.length === 0) {
    return fallbackLayer;
  }

  const weights = new Map<GlobeLayerId, number>();
  for (const row of rows) {
    weights.set(row.layer, (weights.get(row.layer) ?? 0) + row.severity + 0.2);
  }

  let dominantLayer = fallbackLayer;
  let highest = -1;
  for (const [layer, value] of weights.entries()) {
    if (value > highest) {
      dominantLayer = layer;
      highest = value;
    }
  }

  return dominantLayer;
}

export function buildAnalystSummary(options: {
  label: string;
  rows: SignalRow[];
  countryMetric?: CountryMetric | null;
  fallbackLayer?: GlobeLayerId;
}) {
  const { label, rows, countryMetric = null, fallbackLayer = "conflict" } = options;
  const signalCount = rows.length;
  const dominantLayer = getDominantLayer(rows, fallbackLayer);
  const dominantLabel = LAYER_LABELS[dominantLayer].toLowerCase();
  const leadSignal = rows[0] ?? null;
  const score = countryMetric?.score ?? (signalCount > 0 ? rows.reduce((sum, row) => sum + row.severity, 0) / signalCount : null);

  if (!leadSignal) {
    return {
      score,
      signalCount,
      dominantLayer,
      summary: `${label} is currently quiet with no priority live signals elevated above background watch posture.`,
    };
  }

  const scoreDescriptor =
    score === null ? "under routine watch" : score >= 2.2 ? "under elevated pressure" : score >= 1.2 ? "under active watch" : "holding a stable posture";

  return {
    score,
    signalCount,
    dominantLayer,
    summary: `${label} is ${scoreDescriptor}, driven primarily by ${dominantLabel} activity. Lead signal: ${leadSignal.title} (${leadSignal.detail}).`,
  };
}
