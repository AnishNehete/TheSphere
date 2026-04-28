import { PerspectiveCamera, Vector3 } from "three";

import { centroidForIso3 } from "@/lib/three/geo";
import { buildOrbitalPosition, resolveCameraPosition, type CameraPose } from "@/lib/three/camera";
import { latLonToVector3 } from "@/lib/three/coordinate";
import { damp } from "@/lib/three/easing";
import { useAppStore, type AppState } from "@/store/useAppStore";
import { useDataStore } from "@/store/useDataStore";

import { GlobeControls } from "./controls";

const ORIGIN = new Vector3(0, 0, 0);
const WORLD_UP = new Vector3(0, 1, 0);
const _cDir = new Vector3();
const _cRight = new Vector3();
const _cUp = new Vector3();

const COMP_OFFSET_X = 0.08;
const COMP_OFFSET_Y = -0.06;

function applyCompositionOffset(camera: PerspectiveCamera) {
  _cDir.copy(camera.position).normalize();
  _cRight.crossVectors(WORLD_UP, _cDir).normalize();
  _cUp.crossVectors(_cDir, _cRight).normalize();
  camera.position.addScaledVector(_cRight, COMP_OFFSET_X);
  camera.position.addScaledVector(_cUp, COMP_OFFSET_Y);
}

const EXPLORE_POSE: CameraPose = {
  distance: 3.8,
  polar: 1.08,
  azimuth: 0.72,
  fov: 38,
  lateral: 0,
  vertical: 0,
};

const COUNTRY_POSE: CameraPose = {
  distance: 1.9,
  polar: 1.14,
  azimuth: 1.12,
  fov: 24,
  lateral: 0.14,
  vertical: 0.08,
};

const SIGNAL_POSE: CameraPose = {
  distance: 1.65,
  polar: 1.08,
  azimuth: 0.98,
  fov: 26,
  lateral: 0.16,
  vertical: 0.11,
};

const INTRO_DURATION_MS = 5400;
const REDUCED_INTRO_DURATION_MS = 1400;
const FOCUS_DURATION_MS = 1400;
const REDUCED_FOCUS_DURATION_MS = 480;

export interface FocusTargetResolution {
  target: Vector3;
  targetLatLon: { lat: number; lon: number } | null;
}

interface FocusTransition {
  key: string;
  progressMs: number;
  durationMs: number;
  fromPosition: Vector3;
  fromTarget: Vector3;
  fromFov: number;
  toPosition: Vector3;
  toTarget: Vector3;
  toFov: number;
}

export function resolveFocusTarget(state: AppState, dataState: ReturnType<typeof useDataStore.getState>): FocusTargetResolution {
  if (state.selectedSignalId) {
    const rows = [...dataState.flights, ...dataState.weather, ...dataState.conflicts, ...dataState.health];
    const signal = rows.find((entry) => entry.id === state.selectedSignalId);
    if (signal) {
      const latLon = "position" in signal ? signal.position : signal.center;
      return {
        target: latLonToVector3(latLon.lat, latLon.lon, 0.58),
        targetLatLon: latLon,
      };
    }
  }

  if (state.selectedCountry) {
    const centroid = centroidForIso3(state.selectedCountry);
    if (centroid) {
      return {
        target: latLonToVector3(centroid.lat, centroid.lon, 0.54),
        targetLatLon: centroid,
      };
    }
  }

  if (state.selectedRegionSlug) {
    const region = dataState.regions.find((entry) => entry.slug === state.selectedRegionSlug);
    if (region) {
      return {
        target: latLonToVector3(region.centroid.lat, region.centroid.lon, 0.52),
        targetLatLon: region.centroid,
      };
    }
  }

  return {
    target: ORIGIN.clone(),
    targetLatLon: null,
  };
}

function easeInOutCubic(value: number) {
  return value < 0.5 ? 4 * value * value * value : 1 - Math.pow(-2 * value + 2, 3) / 2;
}

function lerp(from: number, to: number, progress: number) {
  return from + (to - from) * progress;
}

function getFocusPose(state: AppState) {
  if (state.interactionMode === "signal-focus") {
    return SIGNAL_POSE;
  }

  if (state.interactionMode === "country-focus") {
    return COUNTRY_POSE;
  }

  return EXPLORE_POSE;
}

export class CameraDirector {
  readonly camera: PerspectiveCamera;

  private readonly controls: GlobeControls;

  private readonly currentLookTarget = new Vector3();

  private currentFov = EXPLORE_POSE.fov;

  private introElapsedMs = 0;

  private focusTransition: FocusTransition | null = null;

  constructor(controls: GlobeControls) {
    this.controls = controls;
    this.camera = new PerspectiveCamera(EXPLORE_POSE.fov, 1, 0.01, 120);
    this.camera.position.copy(buildOrbitalPosition(EXPLORE_POSE.distance, EXPLORE_POSE.polar, EXPLORE_POSE.azimuth));
    applyCompositionOffset(this.camera);
    this.camera.lookAt(ORIGIN);
    this.currentFov = EXPLORE_POSE.fov;
  }

  resize(width: number, height: number) {
    this.camera.aspect = width / Math.max(height, 1);
    this.camera.updateProjectionMatrix();
  }

  update(deltaSeconds: number, elapsedSeconds: number, state: AppState, dataState: ReturnType<typeof useDataStore.getState>) {
    const resolvedFocus = resolveFocusTarget(state, dataState);

    if (!state.engineReady || state.interactionMode === "boot") {
      this.controls.applyPreset({
        enabled: false,
        allowAutoRotate: false,
        target: ORIGIN,
        radius: EXPLORE_POSE.distance,
        minRadius: 1.4,
        maxRadius: EXPLORE_POSE.distance,
      });
      this.camera.position.copy(buildOrbitalPosition(EXPLORE_POSE.distance, EXPLORE_POSE.polar, EXPLORE_POSE.azimuth));
      applyCompositionOffset(this.camera);
      this.currentLookTarget.copy(ORIGIN);
      this.camera.lookAt(this.currentLookTarget);
      this.applyFov(EXPLORE_POSE.fov);
      return;
    }

    if (state.diagnosticsEnabled && state.interactionMode === "intro") {
      useAppStore.getState().setIntroProgress(1);
      useAppStore.getState().finishIntro();
    }

    if (state.cameraOwner === "intro" || state.interactionMode === "intro") {
      this.updateIntro(deltaSeconds, elapsedSeconds, state);
      return;
    }

    if (state.cameraOwner === "focus") {
      this.updateFocusTransition(deltaSeconds, state, resolvedFocus.target);
      return;
    }

    this.focusTransition = null;
    this.introElapsedMs = 0;
    this.updateControls(deltaSeconds, state, resolvedFocus.target);
  }

  private updateIntro(deltaSeconds: number, elapsedSeconds: number, state: AppState) {
    const durationMs = state.reduceMotion || state.diagnosticsEnabled ? REDUCED_INTRO_DURATION_MS : INTRO_DURATION_MS;
    this.introElapsedMs = Math.min(durationMs, this.introElapsedMs + deltaSeconds * 1000);
    const rawProgress = this.introElapsedMs / durationMs;
    const azimuth = EXPLORE_POSE.azimuth + elapsedSeconds * 0.008;

    this.camera.position.copy(buildOrbitalPosition(EXPLORE_POSE.distance, EXPLORE_POSE.polar, azimuth));
    this.currentLookTarget.copy(ORIGIN);
    this.camera.lookAt(this.currentLookTarget);
    this.applyFov(EXPLORE_POSE.fov);
    useAppStore.getState().setIntroProgress(rawProgress);

    if (rawProgress >= 1) {
      this.controls.syncFromCamera(this.camera, ORIGIN);
      useAppStore.getState().finishIntro();
    }
  }

  private updateFocusTransition(deltaSeconds: number, state: AppState, target: Vector3) {
    const transitionKey = `${state.interactionMode}:${state.selectedCountry ?? ""}:${state.selectedRegionSlug ?? ""}:${state.selectedSignalId ?? ""}`;
    const pose = getFocusPose(state);
    const transitionDuration = state.reduceMotion ? REDUCED_FOCUS_DURATION_MS : FOCUS_DURATION_MS;
    const desiredTarget = target.clone();
    const desiredPosition = desiredTarget.lengthSq() === 0 ? buildOrbitalPosition(EXPLORE_POSE.distance, EXPLORE_POSE.polar, EXPLORE_POSE.azimuth) : resolveCameraPosition(desiredTarget, pose);
    const desiredFov = pose.fov;

    if (!this.focusTransition || this.focusTransition.key !== transitionKey) {
      this.focusTransition = {
        key: transitionKey,
        progressMs: 0,
        durationMs: transitionDuration,
        fromPosition: this.camera.position.clone(),
        fromTarget: this.currentLookTarget.clone(),
        fromFov: this.currentFov,
        toPosition: desiredPosition,
        toTarget: desiredTarget,
        toFov: desiredFov,
      };
    } else {
      this.focusTransition.toPosition.copy(desiredPosition);
      this.focusTransition.toTarget.copy(desiredTarget);
      this.focusTransition.toFov = desiredFov;
    }

    const transition = this.focusTransition;
    transition.progressMs = Math.min(transition.durationMs, transition.progressMs + deltaSeconds * 1000);
    const rawProgress = transition.progressMs / transition.durationMs;
    const progress = easeInOutCubic(rawProgress);

    this.camera.position.lerpVectors(transition.fromPosition, transition.toPosition, progress);
    this.currentLookTarget.lerpVectors(transition.fromTarget, transition.toTarget, progress);
    this.camera.lookAt(this.currentLookTarget);
    this.applyFov(lerp(transition.fromFov, transition.toFov, progress));

    if (rawProgress >= 1) {
      this.controls.syncFromCamera(this.camera, transition.toTarget);
      this.focusTransition = null;
      useAppStore.getState().setCameraOwner("controls");
    }
  }

  private updateControls(deltaSeconds: number, state: AppState, target: Vector3) {
    const pose = getFocusPose(state);
    const controlsEnabled = state.interactionMode !== "intro";
    const allowAutoRotate =
      !state.reduceMotion && state.autoRotate && state.interactionMode === "explore" && target.lengthSq() === 0;
    this.controls.applyPreset({
      enabled: controlsEnabled,
      allowAutoRotate,
      target,
      radius: pose.distance,
      minRadius: state.interactionMode === "explore" ? 1.55 : 1.3,
      maxRadius: state.interactionMode === "explore" ? 5.8 : 3.9,
    });
    this.controls.update(this.camera, deltaSeconds);
    applyCompositionOffset(this.camera);
    this.currentLookTarget.set(
      damp(this.currentLookTarget.x, target.x, 7.4, deltaSeconds),
      damp(this.currentLookTarget.y, target.y, 7.4, deltaSeconds),
      damp(this.currentLookTarget.z, target.z, 7.4, deltaSeconds)
    );
    this.camera.lookAt(this.currentLookTarget);
    this.applyFov(damp(this.currentFov, pose.fov, 5.2, deltaSeconds));
  }

  private applyFov(targetFov: number) {
    this.currentFov = targetFov;
    this.camera.fov = targetFov;
    this.camera.updateProjectionMatrix();
  }

  verifyStartupAlignment(): { aligned: boolean; details: Record<string, unknown> } {
    const pos = this.camera.position;
    const expected = buildOrbitalPosition(EXPLORE_POSE.distance, EXPLORE_POSE.polar, EXPLORE_POSE.azimuth);
    const posDrift = pos.distanceTo(expected);
    const fovDrift = Math.abs(this.currentFov - EXPLORE_POSE.fov);
    return {
      aligned: posDrift < 0.01 && fovDrift < 0.5,
      details: {
        expectedDistance: EXPLORE_POSE.distance,
        expectedPolar: EXPLORE_POSE.polar,
        expectedAzimuth: EXPLORE_POSE.azimuth,
        expectedFov: EXPLORE_POSE.fov,
        actualFov: this.currentFov,
        positionDrift: posDrift,
        fovDrift,
      },
    };
  }
}
