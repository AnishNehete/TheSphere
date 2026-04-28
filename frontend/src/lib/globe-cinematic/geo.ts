/**
 * Sphere Cinematic Globe - Geo Contract (Phase 0)
 *
 * Coordinate, unit, and frame conventions shared by every later phase of
 * the cinematic globe. Signatures are frozen here; implementations land in
 * Phase 1.
 *
 * Conventions:
 *   - World unit:  meters
 *   - Datum:       WGS84 (Phase 1 uses spherical; ellipsoid upgrade path
 *                  kept for Phase 5 via the WGS84_* constants below)
 *   - Frame:       Earth-Centered Earth-Fixed (ECEF), right-handed
 *   - Up at point: normalized ECEF position of that point
 *   - Latitude:    degrees, range [-90, 90]
 *   - Longitude:   degrees, range [-180, 180]
 *
 * All globe-cinematic modules MUST convert coordinates through this file.
 * No layer is allowed to roll its own transform.
 */

import type { Vector3 } from "three";

/** Mean Earth radius (authalic sphere) in meters. */
export const EARTH_RADIUS_METERS = 6_371_000;

/** WGS84 semi-major axis in meters (equatorial radius). */
export const WGS84_SEMI_MAJOR_AXIS_METERS = 6_378_137;

/** WGS84 semi-minor axis in meters (polar radius). */
export const WGS84_SEMI_MINOR_AXIS_METERS = 6_356_752.3142;

/** WGS84 first-eccentricity squared; reserved for Phase 5 ellipsoidal math. */
export const WGS84_ECCENTRICITY_SQUARED =
  1 -
  (WGS84_SEMI_MINOR_AXIS_METERS * WGS84_SEMI_MINOR_AXIS_METERS) /
    (WGS84_SEMI_MAJOR_AXIS_METERS * WGS84_SEMI_MAJOR_AXIS_METERS);

export interface LatLonAltitude {
  readonly latitudeDegrees: number;
  readonly longitudeDegrees: number;
  readonly altitudeMeters: number;
}

/**
 * Convert geodetic lat/lon/altitude to ECEF meters.
 *
 * Zero-allocation contract: callers pass a pre-allocated Vector3 as `out`
 * and receive the same reference back. Per-frame hot paths MUST use this
 * form to avoid GC pressure inside the render loop.
 *
 * @throws Phase 0 stub - Phase 1 will implement the spherical conversion.
 */
export function latLonAltToEcef(
  coord: LatLonAltitude,
  out: Vector3,
): Vector3 {
  void coord;
  void out;
  throw new Error(
    "[globe-cinematic] geo.latLonAltToEcef not yet implemented (Phase 1)",
  );
}

/**
 * Convert ECEF meters to geodetic lat/lon/altitude.
 *
 * Returns a fresh object; this path is NOT on the per-frame hot path.
 *
 * @throws Phase 0 stub - Phase 1 will implement.
 */
export function ecefToLatLonAlt(ecef: Vector3): LatLonAltitude {
  void ecef;
  throw new Error(
    "[globe-cinematic] geo.ecefToLatLonAlt not yet implemented (Phase 1)",
  );
}

/**
 * Compute the unit "up" vector at an ECEF point. For the Phase 1 sphere
 * this is the normalized position. Phase 5+ will switch to the ellipsoidal
 * normal.
 *
 * Zero-allocation contract: `out` is written in place.
 *
 * @throws Phase 0 stub - Phase 1 will implement.
 */
export function surfaceUpAtEcef(ecef: Vector3, out: Vector3): Vector3 {
  void ecef;
  void out;
  throw new Error(
    "[globe-cinematic] geo.surfaceUpAtEcef not yet implemented (Phase 1)",
  );
}
