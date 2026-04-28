/**
 * Sphere Cinematic Globe - Sun Contract (Phase 0)
 *
 * SINGLE SOURCE OF TRUTH for sun direction. Every visual system
 * (atmosphere shell, tiles lighting, night lights, ocean specular, clouds)
 * MUST consume the vector produced by this module via the SunController
 * component that Phase 1 will introduce.
 *
 * Conventions:
 *   - Vector is in the same ECEF frame as geo.ts.
 *   - Points FROM the Earth center TOWARD the sun, normalized.
 *   - Time input: Unix epoch milliseconds (UTC).
 *
 * DO NOT recompute sun direction anywhere else. No shader, no component,
 * no hook may derive a second sun vector. Multiple sources of truth for
 * the terminator is the #1 way the visual goes out of sync.
 */

import type { Vector3 } from "three";

export interface SunDirectionInput {
  /** Unix epoch milliseconds (UTC). */
  readonly timestampMs: number;
}

/**
 * Compute the unit sun direction in the globe's ECEF frame.
 *
 * Phase 1 will use a simplified solar-position formula (declination +
 * hour angle; no nutation, no equation-of-time correction beyond the
 * basics). This is adequate for believable day/night terminator alignment.
 *
 * Zero-allocation contract: callers pass a pre-allocated Vector3 as `out`
 * and receive the same reference back. This function is intended to be
 * called at most a few times per second (not per frame); the out-param
 * shape exists for consistency with geo.ts, not because of GC pressure.
 *
 * @throws Phase 0 stub - Phase 1 will implement.
 */
export function computeSunDirectionEcef(
  input: SunDirectionInput,
  out: Vector3,
): Vector3 {
  void input;
  void out;
  throw new Error(
    "[globe-cinematic] sun.computeSunDirectionEcef not yet implemented (Phase 1)",
  );
}
