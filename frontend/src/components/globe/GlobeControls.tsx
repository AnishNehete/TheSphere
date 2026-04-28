"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

import { useGlobeFocusTarget } from "@/components/globe/useGlobeFocusTarget";
import {
  buildOrbitalPosition,
  getCameraPoseForMode,
  isControllableCameraMode,
  resolveCameraPosition,
  resolveDiagnosticCameraState,
} from "@/lib/three/camera";
import { USER_IDLE_RESUME_MS } from "@/lib/three/globeSceneConfig";
import { useAppStore } from "@/store/useAppStore";

export function GlobeControls() {
  const { camera, gl } = useThree();
  const cameraMode = useAppStore((state) => state.cameraMode);
  const autoRotate = useAppStore((state) => state.autoRotate);
  const userInteracting = useAppStore((state) => state.userInteracting);
  const setAutoRotate = useAppStore((state) => state.setAutoRotate);
  const setUserInteracting = useAppStore((state) => state.setUserInteracting);
  const selectedCountry = useAppStore((state) => state.selectedCountry);
  const selectedRegionSlug = useAppStore((state) => state.selectedRegionSlug);
  const selectedSignalId = useAppStore((state) => state.selectedSignalId);
  const reduceMotion = useAppStore((state) => state.reduceMotion);
  const diagnosticsEnabled = useAppStore((state) => state.diagnosticsEnabled);

  const controls = useMemo(() => new OrbitControls(camera, gl.domElement), [camera, gl.domElement]);
  const idleTimerRef = useRef<number | null>(null);
  const { orbitTarget } = useGlobeFocusTarget();

  useEffect(() => {
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.rotateSpeed = 0.52;
    controls.zoomSpeed = 0.72;
    controls.panSpeed = 0.2;
    controls.enablePan = false;
    controls.minPolarAngle = 0.3;
    controls.maxPolarAngle = Math.PI - 0.3;

    return () => {
      if (idleTimerRef.current) {
        window.clearTimeout(idleTimerRef.current);
      }
      controls.dispose();
    };
  }, [controls]);

  useEffect(() => {
    const isControllable = diagnosticsEnabled || isControllableCameraMode(cameraMode);
    controls.enabled = isControllable;
    controls.autoRotate =
      !diagnosticsEnabled &&
      !reduceMotion &&
      autoRotate &&
      !userInteracting &&
      cameraMode === "live-idle" &&
      !selectedRegionSlug &&
      !selectedCountry &&
      !selectedSignalId;
    // Phase 19C.6 — autoRotate slowed from 0.16 to 0.10 so each continent
    // sits in frame long enough for a reviewer to read on first load,
    // and so the launch-page screenshot stays roughly Atlantic-centred.
    controls.autoRotateSpeed = reduceMotion ? 0 : 0.10;
    controls.minDistance = diagnosticsEnabled ? 1.5 : cameraMode === "country-focus" ? 1.2 : 1.48;
    controls.maxDistance = diagnosticsEnabled ? 4.8 : cameraMode === "country-focus" ? 4.2 : 6.2;
  }, [
    autoRotate,
    cameraMode,
    controls,
    diagnosticsEnabled,
    reduceMotion,
    selectedCountry,
    selectedRegionSlug,
    selectedSignalId,
    userInteracting,
  ]);

  useEffect(() => {
    if (diagnosticsEnabled) {
      const { target, position, pose } = resolveDiagnosticCameraState();
      controls.target.copy(target);
      camera.position.copy(position);
      camera.lookAt(target);

      if ("fov" in camera) {
        camera.fov = pose.fov;
        camera.updateProjectionMatrix();
      }

      controls.update();
      return;
    }

    if (!isControllableCameraMode(cameraMode)) {
      return;
    }

    const pose = getCameraPoseForMode(cameraMode);
    const target = orbitTarget.clone();
    // Phase 19C.4 — hero composition. Without a focus target, lift the
    // look-target slightly above the origin so the globe (centered at
    // origin) sits a bit lower in frame, clear of the top command bar.
    // When there IS a focus target, leave it untouched so country
    // selection still centers the camera correctly on the chosen point.
    if (target.lengthSq() === 0 && cameraMode === "live-idle") {
      target.set(0, 0.16, 0);
    }
    const position =
      target.lengthSq() === 0
        ? buildOrbitalPosition(pose.distance, pose.polar, pose.azimuth)
        : resolveCameraPosition(target, pose);

    controls.target.copy(target);
    camera.position.copy(position);
    camera.lookAt(target);

    if ("fov" in camera) {
      camera.fov = pose.fov;
      camera.updateProjectionMatrix();
    }

    controls.update();
  }, [camera, cameraMode, controls, diagnosticsEnabled, orbitTarget]);

  useEffect(() => {
    const onStart = () => {
      if (idleTimerRef.current) {
        window.clearTimeout(idleTimerRef.current);
        idleTimerRef.current = null;
      }

      setUserInteracting(true);
      setAutoRotate(false);
    };

    const onEnd = () => {
      setUserInteracting(false);

      if (
        diagnosticsEnabled ||
        reduceMotion ||
        cameraMode !== "live-idle" ||
        selectedCountry ||
        selectedRegionSlug ||
        selectedSignalId
      ) {
        return;
      }

      idleTimerRef.current = window.setTimeout(() => {
        setAutoRotate(true);
      }, USER_IDLE_RESUME_MS);
    };

    controls.addEventListener("start", onStart);
    controls.addEventListener("end", onEnd);

    return () => {
      controls.removeEventListener("start", onStart);
      controls.removeEventListener("end", onEnd);
    };
  }, [
    cameraMode,
    controls,
    diagnosticsEnabled,
    selectedCountry,
    selectedRegionSlug,
    selectedSignalId,
    reduceMotion,
    setAutoRotate,
    setUserInteracting,
  ]);

  useFrame(() => {
    if (!controls.enabled && !controls.autoRotate) {
      return;
    }

    controls.update();
  });

  return null;
}
