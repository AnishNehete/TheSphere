// Phase 20A.3 — front-facing horizon fade for globe-mounted markers.
//
// Three.js depthTest correctly hides back-side markers when the globe
// itself writes depth (EarthMaterial does), but two real artifacts
// remain on a transparent ring/sprite:
//
//   1. abrupt pop as the marker crosses the limb — depthTest is binary
//   2. back-side instances still take up a draw call + can z-flicker if
//      another transparent layer has a similar depth bias
//
// Computing dot(markerNormal, cameraDirFromOrigin) gives a clean
// front-facing scalar in [-1, 1]:
//
//   * dot >  threshold   → marker is squarely on the visible hemisphere
//   * dot ∈ [-fade, threshold] → near horizon, ramp opacity/scale
//   * dot < -fade        → back hemisphere, hard cull
//
// Callers either scale the InstancedMesh matrix to zero (cull-by-shrink,
// which also makes raycast skip the marker) or set sprite opacity.

import type { Vector3 } from "three";

/**
 * Default visibility threshold. Markers whose normal·cameraDir is at
 * or above this value render at full size. 0.04 keeps a small
 * horizon buffer so a marker that's *just* on the visible side doesn't
 * read as washed out.
 */
export const FRONT_FACING_THRESHOLD = 0.04;

/**
 * Width of the smoothstep ramp below the threshold. Markers fade from
 * 1 → 0 across this band, then are fully hidden.
 */
export const FRONT_FACING_FADE_BAND = 0.08;

/**
 * Compute a front-facing factor in [0, 1].
 *
 * Inputs:
 *   - markerNormal: unit vector from globe origin to the marker's lat/lon
 *   - cameraDir:    unit vector from globe origin toward the camera
 *
 * Both must be pre-normalized; this helper avoids the sqrt for hot paths.
 */
export function frontFacingFactor(
  markerNormal: Vector3,
  cameraDir: Vector3,
  threshold: number = FRONT_FACING_THRESHOLD,
  fadeBand: number = FRONT_FACING_FADE_BAND,
): number {
  const dot = markerNormal.dot(cameraDir);
  if (dot >= threshold) return 1;
  const lower = threshold - fadeBand;
  if (dot <= lower) return 0;
  const t = (dot - lower) / fadeBand;
  // smoothstep so the fade is perceptually linear at the edges.
  return t * t * (3 - 2 * t);
}
