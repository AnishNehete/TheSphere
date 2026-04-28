import type { CameraMode } from "@/lib/types";
import { Vector3 } from "three";

import { latLonToVector3 } from "@/lib/three/coordinate";

export interface CameraPose {
  distance: number;
  polar: number;
  azimuth: number;
  fov: number;
  lateral: number;
  vertical: number;
}

const POSES: Record<CameraMode, CameraPose> = {
  // Phase 19C.4 — hero composition (distance 4.6, FOV 32°).
  // Phase 19C.6 — deliberate Atlantic-hero starting framing. The 19C.4
  // pose (polar 1.08, azimuth 0.72) put the camera looking at the
  // Pacific/Australia, which combined with autoRotate produced a
  // "random-feeling" first paint depending on rotation phase. The new
  // pose places the camera over the Atlantic at lat≈12°N, lon≈-30°W
  // (Americas + west Africa + west Europe in frame on launch). polar
  // 1.36 ≈ slight tilt south of equator; azimuth 0.52 rotates the
  // camera so +X (lon=0) sits on the right limb.
  intro: {
    distance: 4.6,
    polar: 1.36,
    azimuth: 0.52,
    fov: 32,
    lateral: 0,
    vertical: 0,
  },
  handoff: {
    distance: 4.6,
    polar: 1.36,
    azimuth: 0.52,
    fov: 32,
    lateral: 0,
    vertical: 0,
  },
  "live-idle": {
    distance: 4.6,
    polar: 1.36,
    azimuth: 0.52,
    fov: 32,
    lateral: 0,
    vertical: 0,
  },
  transition: {
    distance: 2.32,
    polar: 1.12,
    azimuth: 1.44,
    fov: 29,
    lateral: 0.2,
    vertical: 0.14,
  },
  "country-focus": {
    distance: 1.92,
    polar: 1.16,
    azimuth: 0.94,
    fov: 24,
    lateral: 0.12,
    vertical: 0.08,
  },
  "signal-focus": {
    distance: 1.76,
    polar: 1.1,
    azimuth: 0.82,
    fov: 27,
    lateral: 0.16,
    vertical: 0.12,
  },
  // Phase 7.6 — dedicated ISS/NASA limb shot. Mirrors SIDE_VIEW_LIMB in
  // cinematicShots.ts. Framing nudges the globe mass left so the right-hand
  // negative space reads as deep space beyond the limb.
  "side-view": {
    distance: 2.6,
    polar: 1.24,
    azimuth: 2.42,
    fov: 24,
    lateral: -0.22,
    vertical: -0.08,
  },
  "weather-hero": {
    distance: 3.2,
    polar: 1.05,
    azimuth: 0,
    fov: 28,
    lateral: 0,
    vertical: 0,
  },
};

export const DIAGNOSTIC_CAMERA_POSE: CameraPose = {
  distance: 2.7,
  polar: 1.08,
  azimuth: 0.34,
  fov: 25,
  lateral: 0,
  vertical: 0,
};

export function getCameraPoseForMode(mode: CameraMode): CameraPose {
  return POSES[mode];
}

export function isControllableCameraMode(mode: CameraMode) {
  return mode === "live-idle" || mode === "country-focus";
}

export function isLockedCameraMode(mode: CameraMode) {
  return !isControllableCameraMode(mode);
}

const WORLD_UP = new Vector3(0, 1, 0);
const TEMP_RIGHT = new Vector3();
const TEMP_UP = new Vector3();

export function resolveOrbitTarget(params: {
  countryLatLon?: { lat: number; lon: number } | null;
  signalLatLon?: { lat: number; lon: number } | null;
  regionLatLon?: { lat: number; lon: number } | null;
  depth?: number;
}) {
  const { countryLatLon, signalLatLon, regionLatLon, depth = 0.64 } = params;
  const focusLatLon = signalLatLon ?? countryLatLon ?? regionLatLon;
  if (!focusLatLon) {
    return new Vector3(0, 0, 0);
  }

  return latLonToVector3(focusLatLon.lat, focusLatLon.lon, depth);
}

export function resolveCameraPosition(target: Vector3, pose: CameraPose) {
  const targetDirection = target.lengthSq() > 0 ? target.clone().normalize() : new Vector3(0, 0, 1);

  TEMP_RIGHT.crossVectors(WORLD_UP, targetDirection);
  if (TEMP_RIGHT.lengthSq() < 1e-5) {
    TEMP_RIGHT.set(1, 0, 0);
  } else {
    TEMP_RIGHT.normalize();
  }

  TEMP_UP.crossVectors(targetDirection, TEMP_RIGHT).normalize();

  return target
    .clone()
    .add(targetDirection.multiplyScalar(pose.distance))
    .add(TEMP_RIGHT.multiplyScalar(pose.lateral))
    .add(TEMP_UP.multiplyScalar(pose.vertical));
}

export function buildOrbitalPosition(distance: number, polar: number, azimuth: number) {
  const sinPolar = Math.sin(polar);
  return new Vector3(
    distance * sinPolar * Math.cos(azimuth),
    distance * Math.cos(polar),
    distance * sinPolar * Math.sin(azimuth)
  );
}

export function resolveDiagnosticCameraState() {
  const target = new Vector3(0, 0, 0);
  return {
    target,
    position: buildOrbitalPosition(
      DIAGNOSTIC_CAMERA_POSE.distance,
      DIAGNOSTIC_CAMERA_POSE.polar,
      DIAGNOSTIC_CAMERA_POSE.azimuth
    ),
    pose: DIAGNOSTIC_CAMERA_POSE,
  };
}
