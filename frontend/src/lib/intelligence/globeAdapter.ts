// Phase 20A — Globe domain adapter.
//
// Pure functions that map normalized SignalEvent[] (the substrate that
// powers the awareness rail) onto lat/lon coordinates the globe layers
// already understand. The adapter never invents a location — when
// neither precise lat/lon nor a known country centroid is available,
// the event is dropped from the visualization. That is the only honest
// behaviour: a marker on the wrong country is worse than no marker.
//
// Used by every domain visualization (news markers, conflict pulses,
// health hotspots, flight arcs). Each domain has its own typed
// adapter that returns the shape the existing R3F layer expects.

import countryCentroidsData from "@/assets/geo/country-centroids.json";
import type { SignalEvent } from "@/lib/intelligence/types";

interface CountryCentroidRow {
  iso3: string;
  name: string;
  lat: number;
  lon: number;
}

const COUNTRY_CENTROIDS: ReadonlyMap<string, { lat: number; lon: number }> =
  new Map(
    (countryCentroidsData as CountryCentroidRow[]).map((row) => [
      row.iso3.toUpperCase(),
      { lat: row.lat, lon: row.lon },
    ]),
  );

export interface GlobePoint {
  lat: number;
  lon: number;
  /**
   * True when the lat/lon was derived from the event's country centroid
   * because the event itself had no precise coordinates. Layers should
   * widen / soften the marker so a viewer can tell at a glance the
   * placement is country-level, not point-level.
   */
  isCountryFallback: boolean;
}

/**
 * Resolve a SignalEvent to a globe coordinate.
 *
 * Resolution order:
 *   1. event.place.{latitude, longitude} when both are non-null.
 *   2. country centroid keyed on event.place.country_code.
 *   3. ``null`` — caller drops the event from the visualization.
 *
 * Never invents a coordinate.
 */
export function resolveEventLatLon(event: SignalEvent): GlobePoint | null {
  const lat = event.place.latitude;
  const lon = event.place.longitude;
  if (typeof lat === "number" && typeof lon === "number") {
    return { lat, lon, isCountryFallback: false };
  }
  const code = event.place.country_code;
  if (typeof code === "string" && code.length > 0) {
    const centroid = COUNTRY_CENTROIDS.get(code.toUpperCase());
    if (centroid) {
      return {
        lat: centroid.lat,
        lon: centroid.lon,
        isCountryFallback: true,
      };
    }
  }
  return null;
}

export interface ResolvedEventMarker {
  event: SignalEvent;
  lat: number;
  lon: number;
  isCountryFallback: boolean;
}

/**
 * Project a list of events onto the globe, dropping events without a
 * resolvable location and capping at ``maxMarkers`` (severity-first).
 *
 * Stable order: events keep their input order so a re-render of the
 * same list produces the same marker indices — important for InstancedMesh
 * which addresses markers by id.
 */
export function resolveEventMarkers(
  events: readonly SignalEvent[],
  options: { maxMarkers?: number } = {},
): ResolvedEventMarker[] {
  const maxMarkers = options.maxMarkers ?? 50;
  const out: ResolvedEventMarker[] = [];
  const seen = new Set<string>();
  for (const event of events) {
    if (seen.has(event.id)) continue;
    const point = resolveEventLatLon(event);
    if (point === null) continue;
    seen.add(event.id);
    out.push({
      event,
      lat: point.lat,
      lon: point.lon,
      isCountryFallback: point.isCountryFallback,
    });
    if (out.length >= maxMarkers) break;
  }
  return out;
}

/**
 * True when the event has *both* origin and destination coordinates and
 * those coordinates are different — i.e. it can be drawn as a flight arc.
 * Currently events from the flight adapter store route info in
 * ``properties`` (origin_lat / origin_lon / dest_lat / dest_lon) — when
 * those are absent the caller falls back to a single marker.
 */
export interface ResolvedFlightArc {
  event: SignalEvent;
  originLat: number;
  originLon: number;
  destLat: number;
  destLon: number;
}

function readNumberProperty(
  props: Record<string, unknown>,
  key: string,
): number | null {
  const value = props[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function resolveFlightArcs(
  events: readonly SignalEvent[],
  options: { maxArcs?: number } = {},
): ResolvedFlightArc[] {
  const maxArcs = options.maxArcs ?? 25;
  const out: ResolvedFlightArc[] = [];
  for (const event of events) {
    const props = event.properties || {};
    const originLat = readNumberProperty(props, "origin_lat");
    const originLon = readNumberProperty(props, "origin_lon");
    const destLat = readNumberProperty(props, "dest_lat");
    const destLon = readNumberProperty(props, "dest_lon");
    if (
      originLat === null ||
      originLon === null ||
      destLat === null ||
      destLon === null
    ) {
      continue;
    }
    if (originLat === destLat && originLon === destLon) continue;
    out.push({
      event,
      originLat,
      originLon,
      destLat,
      destLon,
    });
    if (out.length >= maxArcs) break;
  }
  return out;
}
