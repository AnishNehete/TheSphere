/**
 * Phase 7.7 — NASA Weather Composition Shots
 *
 * Five weather-oriented cinematic presets designed to frame cloud structure
 * the way NASA Earth Observatory and ISS photography does: as a first-class
 * compositional element rather than background texture.
 *
 * Each shot's azimuth is computed relative to the sun direction so clouds
 * are well-lit while the ocean specular hotspot stays off the focal center.
 * The presets cycle on a timer when the weather-hero camera mode is active;
 * individual presets are also used by standard cinematic modes (intro,
 * handoff, transition) when the weather layer is active.
 *
 * Scoring heuristics are purely geometric (sun angle + glint proximity).
 * They can be replaced with real cloud-coverage analysis once live weather
 * data drives the camera.
 *
 * Composition rules (NASA / ISS observational feel):
 *   - Earth is NOT always centered — intentional negative space.
 *   - Cloud-rich zones sit in visually strong frame regions.
 *   - Large coherent weather masses outweigh tiny detail clusters.
 *   - Atmosphere limb supports the weather story without overpowering it.
 *   - Glint is allowed as a secondary accent, never the focal element.
 *   - UI layout zones (search bar, side panels) are respected via
 *     frameOffsetX/Y so the focal weather structure lands in open
 *     visual territory.
 */

import type { CinematicShot, ShotContext } from "@/lib/three/cinematicShots";
import { SUN_DIRECTION } from "@/lib/three/globeSceneConfig";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type WeatherShotType =
  | "weather-hero-wide"
  | "storm-corridor"
  | "terminator-weather"
  | "polar-swirl"
  | "tropical-system";

export interface WeatherCompositionDiag {
  activeShotType: WeatherShotType;
  reason: string;
  cloudReadability: number;
  glintPenalty: number;
  compositionScore: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SHOT_HOLD_SECONDS = 40;

const SHOT_CYCLE: readonly WeatherShotType[] = [
  "weather-hero-wide",
  "storm-corridor",
  "terminator-weather",
  "tropical-system",
  "polar-swirl",
];

// ---------------------------------------------------------------------------
// Shot presets
// ---------------------------------------------------------------------------
// Azimuth is 0 — overridden at resolve time from sun-relative offsets.

/** Broad hemisphere establishing shot. Major cloud bands, documentary feel. */
const WEATHER_HERO_WIDE: CinematicShot = {
  distance: 3.20,
  polar: 1.05,
  azimuth: 0,
  fov: 28,
  frameOffsetX: -0.06,
  frameOffsetY: -0.03,
  driftSpeed: 0.012,
  driftAmplitudeY: 0.008,
  driftFrequencyY: 0.04,
  positionSmoothing: 2.6,
  lookSmoothing: 3.0,
  fovSmoothing: 2.2,
};

/** Frames a mid-latitude storm belt (Atlantic/Pacific storm trains). */
const STORM_CORRIDOR: CinematicShot = {
  distance: 2.70,
  polar: 1.18,
  azimuth: 0,
  fov: 30,
  frameOffsetX: 0.0,
  frameOffsetY: -0.025,
  driftSpeed: 0.010,
  driftAmplitudeY: 0.006,
  driftFrequencyY: 0.035,
  positionSmoothing: 3.0,
  lookSmoothing: 3.4,
  fovSmoothing: 2.6,
};

/** Perpendicular to sun — cloud silhouettes against the terminator arc. */
const TERMINATOR_WEATHER: CinematicShot = {
  distance: 2.85,
  polar: 1.12,
  azimuth: 0,
  fov: 27,
  frameOffsetX: -0.04,
  frameOffsetY: -0.03,
  driftSpeed: 0.008,
  driftAmplitudeY: 0.005,
  driftFrequencyY: 0.03,
  positionSmoothing: 2.8,
  lookSmoothing: 3.2,
  fovSmoothing: 2.4,
};

/** Steep polar angle — spiral/banded high-latitude cloud patterns. */
const POLAR_SWIRL: CinematicShot = {
  distance: 2.50,
  polar: 0.68,
  azimuth: 0,
  fov: 30,
  frameOffsetX: 0.02,
  frameOffsetY: -0.02,
  driftSpeed: 0.010,
  driftAmplitudeY: 0.004,
  driftFrequencyY: 0.025,
  positionSmoothing: 3.2,
  lookSmoothing: 3.6,
  fovSmoothing: 2.8,
};

/** Close equatorial view — dense tropical cloud mass over ocean. */
const TROPICAL_SYSTEM: CinematicShot = {
  distance: 2.20,
  polar: 1.22,
  azimuth: 0,
  fov: 25,
  frameOffsetX: 0.03,
  frameOffsetY: -0.02,
  driftSpeed: 0.006,
  driftAmplitudeY: 0.003,
  driftFrequencyY: 0.03,
  positionSmoothing: 3.6,
  lookSmoothing: 4.0,
  fovSmoothing: 3.0,
};

const SHOT_PRESETS: Record<WeatherShotType, CinematicShot> = {
  "weather-hero-wide": WEATHER_HERO_WIDE,
  "storm-corridor": STORM_CORRIDOR,
  "terminator-weather": TERMINATOR_WEATHER,
  "polar-swirl": POLAR_SWIRL,
  "tropical-system": TROPICAL_SYSTEM,
};

// ---------------------------------------------------------------------------
// Sun-relative azimuth offsets
// ---------------------------------------------------------------------------
// Each shot is placed at a deliberate angular offset from the sun to
// maximise cloud readability while keeping the specular hotspot peripheral.
//
//   0°  = looking straight at the sub-solar hemisphere (peak glint)
//  90°  = terminator view (peak cloud silhouette)
//  50-70° = optimal cloud body readability (well-lit, glint off-center)

const AZIMUTH_OFFSETS: Record<WeatherShotType, number> = {
  "weather-hero-wide":  Math.PI * 0.38,
  "storm-corridor":     Math.PI * 0.28,
  "terminator-weather": Math.PI * 0.50,
  "polar-swirl":        Math.PI * 0.42,
  "tropical-system":    Math.PI * 0.34,
};

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

function sunAzimuth(): number {
  return Math.atan2(SUN_DIRECTION.z, SUN_DIRECTION.x);
}

function resolveAzimuthForShot(type: WeatherShotType): number {
  return sunAzimuth() + AZIMUTH_OFFSETS[type];
}

// ---------------------------------------------------------------------------
// Scoring heuristics
// ---------------------------------------------------------------------------

/**
 * How close a camera azimuth is to the ocean specular hotspot.
 * Returns 0 (no glint risk) to 1 (dead center of glint).
 */
function computeGlintPenalty(cameraAzimuth: number): number {
  const sunAz = sunAzimuth();
  let delta = Math.abs(cameraAzimuth - sunAz);
  delta = delta % (Math.PI * 2);
  if (delta > Math.PI) delta = Math.PI * 2 - delta;
  return Math.max(0, 1 - delta / (Math.PI * 0.28));
}

/**
 * Heuristic cloud readability at the center of the framed hemisphere.
 * Clouds are most readable at moderate sun angles (NdotL 0.3–0.7).
 * Too bright → washed out / glint. Too dark → unlit and invisible.
 */
function computeCloudReadability(
  cameraAzimuth: number,
  cameraPolar: number
): number {
  const sunAz = sunAzimuth();
  const sunLen = Math.max(SUN_DIRECTION.length(), 1e-6);
  const sunPolar = Math.acos(SUN_DIRECTION.y / sunLen);

  const framedAz = cameraAzimuth + Math.PI;
  const framedPolar = Math.PI - cameraPolar;

  const cosAngle =
    Math.sin(framedPolar) * Math.sin(sunPolar) * Math.cos(framedAz - sunAz) +
    Math.cos(framedPolar) * Math.cos(sunPolar);

  const ndotl = Math.max(cosAngle, 0);
  if (ndotl < 0.15) return 0.2;
  if (ndotl < 0.30) return 0.2 + (ndotl - 0.15) * 4.0;
  if (ndotl < 0.70) return 0.8 + (ndotl - 0.30) * 0.5;
  return Math.max(0, 1.0 - (ndotl - 0.70) * 2.0);
}

// ---------------------------------------------------------------------------
// Shot selection
// ---------------------------------------------------------------------------

function activeShotType(elapsed: number): WeatherShotType {
  const index = Math.floor(elapsed / SHOT_HOLD_SECONDS) % SHOT_CYCLE.length;
  return SHOT_CYCLE[index];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Resolve a specific weather shot type with sun-relative azimuth. */
export function resolveWeatherShotByType(
  type: WeatherShotType
): CinematicShot {
  const base = SHOT_PRESETS[type];
  return { ...base, azimuth: resolveAzimuthForShot(type) };
}

/** Resolve the current cycling weather shot based on elapsed time. */
export function resolveWeatherShot(context: ShotContext): CinematicShot {
  return resolveWeatherShotByType(activeShotType(context.elapsed));
}

/** Diagnostic snapshot of the current weather composition state. */
export function getWeatherCompositionDiag(
  context: ShotContext
): WeatherCompositionDiag {
  const type = activeShotType(context.elapsed);
  const azimuth = resolveAzimuthForShot(type);
  const base = SHOT_PRESETS[type];
  const glint = computeGlintPenalty(azimuth);
  const readability = computeCloudReadability(azimuth, base.polar);
  const cycleIndex =
    Math.floor(context.elapsed / SHOT_HOLD_SECONDS) % SHOT_CYCLE.length;

  return {
    activeShotType: type,
    reason: `Shot ${cycleIndex + 1}/${SHOT_CYCLE.length}: ${type}`,
    cloudReadability: Math.round(readability * 100) / 100,
    glintPenalty: Math.round(glint * 100) / 100,
    compositionScore:
      Math.round((readability * 0.6 + (1 - glint) * 0.4) * 100) / 100,
  };
}
