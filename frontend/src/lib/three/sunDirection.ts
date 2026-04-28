// Phase 19C.3 — real-time sun direction.
// ------------------------------------------------------------------
// Computes a subsolar lat/lon from a UTC timestamp using NOAA-style
// approximations and projects it into the same world-space frame as the
// globe (Three's SphereGeometry: x = cos(lat)cos(lon), y = sin(lat),
// z = -cos(lat)sin(lon)). The results feed every system that lights or
// shadows the planet so the day/night terminator, sunlit cloud tops,
// twilight band, ocean glint, and lens flare all derive from one
// authoritative sun vector.
//
// The exported SUN_DIRECTION / SUN_POSITION instances in globeSceneConfig
// are mutated in place each frame; downstream materials pick the new value
// up via their existing `.copy(SUN_DIRECTION)` calls inside useFrame.

import type { Vector3 } from "three";

import { SUN_DIRECTION, SUN_POSITION } from "@/lib/three/globeSceneConfig";

const DEG_TO_RAD = Math.PI / 180;
const SUN_DISTANCE = 9.6;

let timeOverride: Date | null = null;

export function setSunTimeOverride(value: Date | string | null): void {
  if (value === null) {
    timeOverride = null;
    return;
  }
  const next = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(next.getTime())) {
    timeOverride = null;
    return;
  }
  timeOverride = next;
}

export function getSunTimeOverride(): Date | null {
  return timeOverride;
}

export function getSunDate(): Date {
  return timeOverride ?? new Date();
}

interface SubsolarPoint {
  lat: number;
  lon: number;
}

// Day-of-year (1..366) for the given UTC date.
function dayOfYearUtc(date: Date): number {
  const start = Date.UTC(date.getUTCFullYear(), 0, 0);
  const diff = date.getTime() - start;
  return Math.floor(diff / 86_400_000);
}

// NOAA-style approximation. Sufficient for visual lighting; not for
// astronomical work. Returns degrees.
export function subsolarLatLon(date: Date = getSunDate()): SubsolarPoint {
  const n = dayOfYearUtc(date);
  const fractionalHour =
    date.getUTCHours() +
    date.getUTCMinutes() / 60 +
    date.getUTCSeconds() / 3600;

  // Solar declination (degrees) — common low-precision form.
  const gamma = ((2 * Math.PI) / 365) * (n - 1 + (fractionalHour - 12) / 24);
  const declinationRad =
    0.006918 -
    0.399912 * Math.cos(gamma) +
    0.070257 * Math.sin(gamma) -
    0.006758 * Math.cos(2 * gamma) +
    0.000907 * Math.sin(2 * gamma) -
    0.002697 * Math.cos(3 * gamma) +
    0.00148 * Math.sin(3 * gamma);
  const lat = declinationRad / DEG_TO_RAD;

  // Equation of time (minutes).
  const eqTimeMin =
    229.18 *
    (0.000075 +
      0.001868 * Math.cos(gamma) -
      0.032077 * Math.sin(gamma) -
      0.014615 * Math.cos(2 * gamma) -
      0.040849 * Math.sin(2 * gamma));

  // Subsolar longitude: where the sun is directly overhead.
  // At UTC noon (with EoT = 0) the sun is over lon = 0.
  let lon = -15 * (fractionalHour - 12) - eqTimeMin / 4;
  // Wrap to [-180, 180].
  lon = ((((lon + 180) % 360) + 360) % 360) - 180;

  return { lat, lon };
}

// Convert (lat, lon) in degrees to a unit vector in the same frame as
// the globe geometry. Mirrors lib/three/coordinate.latLonToVector3 with
// altitude = 0.
export function sunPointToVector3(point: SubsolarPoint, target: Vector3): Vector3 {
  const latRad = point.lat * DEG_TO_RAD;
  const lonRad = point.lon * DEG_TO_RAD;
  const cosLat = Math.cos(latRad);
  target.set(cosLat * Math.cos(lonRad), Math.sin(latRad), -cosLat * Math.sin(lonRad));
  return target;
}

// Mutates the shared SUN_DIRECTION and SUN_POSITION vectors in place so
// every material/light that already reads them picks up the new value
// automatically. Returns the mutated direction for callers that want to
// chain.
export function updateSunVectors(date: Date = getSunDate()): Vector3 {
  const point = subsolarLatLon(date);
  sunPointToVector3(point, SUN_DIRECTION).normalize();
  SUN_POSITION.copy(SUN_DIRECTION).multiplyScalar(SUN_DISTANCE);
  return SUN_DIRECTION;
}
