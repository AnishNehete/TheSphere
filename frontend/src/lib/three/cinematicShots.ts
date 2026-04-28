// cinematicShots
// ---------------
// Reusable cinematic shot types for Phase 6A.
//
// Each shot encodes a complete camera language: where the camera sits, how it
// drifts, how it frames the globe relative to the UI, and how aggressively it
// damps between frames. Shots are *derived* from the active CameraMode +
// scene context — they are pure functions, never stored as state.
//
// UI-aware composition:
//   The Sphere hero layout is a full 100vh sticky stage with a small brand
//   chip top-left, a centered search dock at the bottom (padding-bottom
//   clamp(56px, 9vh, 110px)), and a layer row directly below the dock. All
//   investigation panels live BELOW the fold in workspace-main. The visually
//   clear region is therefore horizontally centered and skewed slightly above
//   vertical center to clear the search dock. `frameOffsetX/Y` encode a
//   screen-space camera shift that positions the globe relative to that hero:
//   Positive X shifts the camera *right* → globe appears *left* in frame.
//   Positive Y shifts the camera *up* → globe appears *lower* in frame.
//   The new layout wants near-zero X bias (globe centered) and a small
//   negative Y so the globe sits above the dock instead of under it.
//
// Contract: changes here must be verified at both wide-orbit and close-focus
// distances, in both intro and investigation modes.

import type { CameraMode, GlobeLayerId } from "@/lib/types";

import { SUN_DIRECTION } from "@/lib/three/globeSceneConfig";
import { getLayerVisualMode } from "@/lib/three/layerVisualModes";
import {
  resolveWeatherShot,
  resolveWeatherShotByType,
} from "@/lib/three/weatherShots";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface CinematicShot {
  // Orbital pose
  distance: number;
  polar: number;           // radians from +Y
  azimuth: number;         // radians
  fov: number;             // degrees

  // Composition — screen-space camera shift.
  // Positive X → camera right → globe left in frame.
  // Positive Y → camera up → globe lower in frame.
  frameOffsetX: number;
  frameOffsetY: number;

  // Motion
  driftSpeed: number;      // rad/s azimuth drift
  driftAmplitudeY: number; // vertical sinusoidal bob (world units)
  driftFrequencyY: number; // bob frequency (Hz)

  // Damping (higher = faster convergence to target)
  positionSmoothing: number;
  lookSmoothing: number;
  fovSmoothing: number;
}

export interface ShotContext {
  hasFocusTarget: boolean;
  isSignalFocus: boolean;
  elapsed: number;
  reduceMotion: boolean;
  activeLayer?: GlobeLayerId;
}

export interface ShotDrift {
  azimuthDrift: number;
  verticalBob: number;
}

// ---------------------------------------------------------------------------
// Shot presets
// ---------------------------------------------------------------------------

/** Wide establishing shot. The globe feels massive. Slow majestic drift. */
const HERO_ORBIT_WIDE: CinematicShot = {
  distance: 3.8,
  polar: 1.08,
  azimuth: 0.72,
  fov: 38,
  frameOffsetX: 0.08,
  frameOffsetY: -0.06,
  driftSpeed: 0.016,
  driftAmplitudeY: 0.012,
  driftFrequencyY: 0.06,
  positionSmoothing: 2.8,
  lookSmoothing: 3.2,
  fovSmoothing: 2.4,
};

/** Camera faces the terminator for maximum day/night drama. */
const TERMINATOR_REVEAL: CinematicShot = {
  distance: 3.1,
  polar: 1.14,
  // Overridden at resolve time to face the sun terminator.
  azimuth: 0,
  fov: 28,
  // Centered in new layout — terminator arc should be the hero.
  frameOffsetX: 0.0,
  // Small lift so the terminator arc reads above the centered search dock.
  frameOffsetY: -0.02,
  driftSpeed: 0.01,
  driftAmplitudeY: 0.008,
  driftFrequencyY: 0.04,
  positionSmoothing: 2.2,
  lookSmoothing: 2.6,
  fovSmoothing: 2.0,
};

/** Closer inspection angle for layer transitions. */
const MEDIUM_INSPECTION: CinematicShot = {
  distance: 2.35,
  polar: 1.12,
  azimuth: 1.44,
  fov: 31,
  frameOffsetX: 0.0,
  frameOffsetY: -0.02,
  driftSpeed: 0.008,
  driftAmplitudeY: 0.004,
  driftFrequencyY: 0.05,
  positionSmoothing: 3.8,
  lookSmoothing: 4.2,
  fovSmoothing: 3.2,
};

/** Gentle persistent movement for idle state. Premium screensaver feel. */
const SLOW_DRIFT: CinematicShot = {
  distance: 3.8,
  polar: 1.08,
  azimuth: 0.72,
  fov: 38,
  frameOffsetX: 0.08,
  frameOffsetY: -0.06,
  driftSpeed: 0.012,
  driftAmplitudeY: 0.01,
  driftFrequencyY: 0.035,
  positionSmoothing: 3.0,
  lookSmoothing: 3.4,
  fovSmoothing: 2.8,
};

/**
 * Phase 7.6 — ISS/NASA side-view limb shot.
 *
 * Composition goals (what makes an orbital photo read as "from orbit"
 * rather than "CG planet"):
 *   - Polar angle slightly off-equatorial so the limb arcs through the
 *     frame diagonally, not as a flat horizontal line.
 *   - FOV kept tight (24) to compress atmosphere depth and keep the
 *     limb arc long and gentle across the frame.
 *   - Distance moderate (2.60) — close enough to make the atmosphere
 *     feel layered, far enough that the full sphere silhouette still
 *     anchors the composition.
 *   - Horizontal frame offset pulls the globe mass to the left of the
 *     centered search dock so the right-side negative space reads as
 *     "deep space beyond the limb" — the single visual cue that sells
 *     the ISS/NASA feel more than any shader trick.
 *   - Vertical lift raises the limb arc above the dock.
 *   - Motion near-zero because orbital stills feel deliberate; a tiny
 *     drift keeps it from looking frozen.
 */
const SIDE_VIEW_LIMB: CinematicShot = {
  distance: 2.60,
  polar: 1.24,
  azimuth: 2.42,
  fov: 24,
  // Globe mass pushed left → right-side negative space reads as deep space.
  frameOffsetX: -0.10,
  // Lift the limb arc above the centered search dock.
  frameOffsetY: -0.04,
  // Very slow drift so the shot feels like a deliberate orbital still.
  driftSpeed: 0.004,
  driftAmplitudeY: 0.003,
  driftFrequencyY: 0.02,
  positionSmoothing: 3.4,
  lookSmoothing: 3.8,
  fovSmoothing: 3.0,
};

/**
 * Pulls in close when a query resolves. In the new layout the investigation
 * panels live BELOW the fold (workspace-main) rather than in a right rail, so
 * we no longer need to push the globe hard left. Instead we keep the subject
 * near center with a mild right-ward camera shift so the globe sits just left
 * of the search query chip that persists in the hero.
 */
const QUERY_FOCUS: CinematicShot = {
  distance: 1.88,
  polar: 1.14,
  azimuth: 0.92,
  fov: 24,
  // Mild bias — keeps the focus subject visually anchored without masking.
  frameOffsetX: 0.03,
  frameOffsetY: -0.02,
  // No drift during active investigation — the globe serves the query.
  driftSpeed: 0,
  driftAmplitudeY: 0,
  driftFrequencyY: 0,
  positionSmoothing: 4.5,
  lookSmoothing: 5.0,
  fovSmoothing: 3.8,
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Compute the azimuth that places the camera perpendicular to the sun
 * direction, maximising the visible terminator arc.
 */
function terminatorAzimuth(): number {
  const sun = SUN_DIRECTION;
  const sunAzimuth = Math.atan2(sun.z, sun.x);
  return sunAzimuth + Math.PI * 0.5;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Resolve the best cinematic shot for the current camera mode + context. */
export function resolveShotForMode(
  mode: CameraMode,
  context: ShotContext
): CinematicShot {
  let base: CinematicShot;
  const isWeather = context.activeLayer === "weather";

  switch (mode) {
    case "intro":
      base = isWeather
        ? resolveWeatherShotByType("weather-hero-wide")
        : HERO_ORBIT_WIDE;
      break;
    case "handoff":
      base = isWeather
        ? resolveWeatherShotByType("terminator-weather")
        : { ...TERMINATOR_REVEAL, azimuth: terminatorAzimuth() };
      break;
    case "transition":
      base = isWeather
        ? resolveWeatherShotByType("storm-corridor")
        : MEDIUM_INSPECTION;
      break;
    case "live-idle":
      base = SLOW_DRIFT;
      break;
    case "side-view":
      base = SIDE_VIEW_LIMB;
      break;
    case "country-focus":
      base = QUERY_FOCUS;
      break;
    case "signal-focus":
      base = {
        ...QUERY_FOCUS,
        distance: 1.72,
        fov: 26,
        frameOffsetX: 0.04,
      };
      break;
    case "weather-hero":
      base = resolveWeatherShot(context);
      break;
    default:
      base = SLOW_DRIFT;
  }

  // Weather-composed shots already encode optimal framing (sun-relative
  // azimuth, glint avoidance, cloud readability bias). Applying generic
  // layer biases on top would double-dip.
  const weatherComposed =
    mode === "weather-hero" ||
    (isWeather &&
      (mode === "intro" || mode === "handoff" || mode === "transition"));

  // Apply layer visual mode biases when a layer is active.
  // These subtly shift framing so each domain feels intentionally different.
  if (context.activeLayer && !weatherComposed) {
    const layerMode = getLayerVisualMode(context.activeLayer);
    base = {
      ...base,
      distance: base.distance + layerMode.distanceBias,
      polar: base.polar + layerMode.polarBias,
      fov: base.fov + layerMode.fovBias,
    };
  }

  if (context.reduceMotion) {
    return {
      ...base,
      driftSpeed: 0,
      driftAmplitudeY: 0,
      positionSmoothing: base.positionSmoothing * 1.5,
      lookSmoothing: base.lookSmoothing * 1.5,
      fovSmoothing: base.fovSmoothing * 1.5,
    };
  }

  return base;
}

/** Compute the drift-adjusted azimuth offset and vertical bob for a shot. */
export function computeShotDrift(
  shot: CinematicShot,
  elapsed: number
): ShotDrift {
  return {
    azimuthDrift: elapsed * shot.driftSpeed,
    verticalBob:
      Math.sin(elapsed * shot.driftFrequencyY * Math.PI * 2) *
      shot.driftAmplitudeY,
  };
}
