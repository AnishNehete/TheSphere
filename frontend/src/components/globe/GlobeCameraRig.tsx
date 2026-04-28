"use client";

// GlobeCameraRig — Phase 6A cinematic camera system.
// ---------------------------------------------------
// Resolves a cinematic shot for the active CameraMode, applies composition
// offsets in screen space, and exponentially damps position/look/fov to
// create slow, intentional, premium-feeling camera movement.
//
// Shot types:
//   HeroOrbitWide    — wide establishing, slow majestic drift
//   TerminatorReveal — camera faces the day/night boundary
//   MediumInspection — closer angle for layer transitions
//   SlowDrift        — gentle idle movement
//   QueryFocus       — pulls close when a query resolves
//
// The rig only drives non-controllable modes (intro, handoff, transition,
// signal-focus). Controllable modes (live-idle, country-focus) are handled
// by GlobeControls via OrbitControls.

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useRef } from "react";
import { PerspectiveCamera, Vector3 } from "three";

import { useGlobeFocusTarget } from "@/components/globe/useGlobeFocusTarget";
import {
  buildOrbitalPosition,
  isControllableCameraMode,
  resolveCameraPosition,
} from "@/lib/three/camera";
import {
  computeShotDrift,
  resolveShotForMode,
  type ShotContext,
} from "@/lib/three/cinematicShots";
import { latLonToVector3 } from "@/lib/three/coordinate";
import { damp, dampVec3 } from "@/lib/three/easing";
import { useAppStore } from "@/store/useAppStore";

const ORIGIN = new Vector3(0, 0, 0);
const WORLD_UP = new Vector3(0, 1, 0);

// Scratch vectors — reused every frame to avoid allocation.
const _viewDir = new Vector3();
const _screenRight = new Vector3();
const _screenUp = new Vector3();

export function GlobeCameraRig() {
  const { camera } = useThree();
  const cameraMode = useAppStore((state) => state.cameraMode);
  const activeLayer = useAppStore((state) => state.activeLayer);
  const reduceMotion = useAppStore((state) => state.reduceMotion);
  const diagnosticsEnabled = useAppStore((state) => state.diagnosticsEnabled);

  const lookTargetRef = useRef(new Vector3(0, 0, 0));
  const cameraTargetRef = useRef(new Vector3(0, 0, 3.4));
  const { orbitTarget } = useGlobeFocusTarget();

  // Synchronize ref targets when mode or focus changes so the damped
  // animation starts from the camera's actual position.
  useEffect(() => {
    if (diagnosticsEnabled) {
      lookTargetRef.current.copy(ORIGIN);
      cameraTargetRef.current.copy(camera.position);
      return;
    }

    if (isControllableCameraMode(cameraMode)) {
      lookTargetRef.current.copy(orbitTarget);
      cameraTargetRef.current.copy(camera.position);
      return;
    }

    lookTargetRef.current.copy(orbitTarget.lengthSq() > 0 ? orbitTarget : ORIGIN);
    cameraTargetRef.current.copy(camera.position);
  }, [camera, cameraMode, diagnosticsEnabled, orbitTarget]);

  useFrame((state, delta) => {
    if (diagnosticsEnabled || isControllableCameraMode(cameraMode)) {
      return;
    }

    // ---- Resolve cinematic shot ----
    const context: ShotContext = {
      hasFocusTarget: orbitTarget.lengthSq() > 0,
      isSignalFocus: cameraMode === "signal-focus",
      elapsed: state.clock.elapsedTime,
      reduceMotion,
      activeLayer,
    };
    const shot = resolveShotForMode(cameraMode, context);
    const drift = computeShotDrift(shot, state.clock.elapsedTime);

    // ---- Desired look target ----
    const desiredTarget =
      cameraMode === "intro" || cameraMode === "handoff"
        ? ORIGIN.clone()
        : orbitTarget.lengthSq() > 0
          ? orbitTarget.clone()
          : ORIGIN.clone();

    // ---- Desired camera position ----
    let desiredPosition: Vector3;

    if (cameraMode === "intro" || cameraMode === "handoff") {
      // Orbital: camera circles the origin with drift.
      desiredPosition = buildOrbitalPosition(
        shot.distance,
        shot.polar,
        shot.azimuth + drift.azimuthDrift
      );
    } else {
      // Focus/transition: camera positioned behind the focus target.
      const focusTarget =
        desiredTarget.lengthSq() > 0
          ? desiredTarget
          : latLonToVector3(18, 64, 0.18);
      desiredPosition = resolveCameraPosition(focusTarget, {
        distance: shot.distance,
        polar: shot.polar,
        azimuth: shot.azimuth,
        fov: shot.fov,
        lateral: 0,
        vertical: 0,
      });
    }

    // ---- Vertical bob ----
    desiredPosition.y += drift.verticalBob;

    // ---- Composition offset (screen-space) ----
    // Shift the camera in its own right/up plane so the globe's framing
    // accounts for the UI layout. This is consistent regardless of which
    // direction the camera faces.
    _viewDir.subVectors(desiredTarget, desiredPosition);
    if (_viewDir.lengthSq() > 0.001) {
      _viewDir.normalize();
      _screenRight.crossVectors(WORLD_UP, _viewDir);
      if (_screenRight.lengthSq() > 1e-5) {
        _screenRight.normalize();
        _screenUp.crossVectors(_viewDir, _screenRight).normalize();
        desiredPosition.addScaledVector(_screenRight, shot.frameOffsetX);
        desiredPosition.addScaledVector(_screenUp, shot.frameOffsetY);
      }
    }

    // ---- Damp toward targets ----
    const lookTarget = lookTargetRef.current;
    const cameraTarget = cameraTargetRef.current;

    dampVec3(lookTarget, desiredTarget, shot.lookSmoothing, delta);
    dampVec3(cameraTarget, desiredPosition, shot.positionSmoothing, delta);

    camera.position.copy(cameraTarget);
    camera.lookAt(lookTarget);

    if ("fov" in camera) {
      const perspectiveCamera = camera as PerspectiveCamera;
      perspectiveCamera.fov = damp(
        perspectiveCamera.fov,
        shot.fov,
        shot.fovSmoothing,
        delta
      );
      perspectiveCamera.updateProjectionMatrix();
    }
  });

  return null;
}
