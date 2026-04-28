"use client";

import { useEffect, useRef } from "react";

import { useAppStore } from "@/store/useAppStore";

const STANDARD_TRANSITION_DURATION_MS = 900;
const REDUCED_TRANSITION_DURATION_MS = 280;

export function GlobeFocusController() {
  const interactionMode = useAppStore((state) => state.interactionMode);
  const activeLayer = useAppStore((state) => state.activeLayer);
  const selectedCountry = useAppStore((state) => state.selectedCountry);
  const selectedRegionSlug = useAppStore((state) => state.selectedRegionSlug);
  const selectedSignalId = useAppStore((state) => state.selectedSignalId);
  const cameraMode = useAppStore((state) => state.cameraMode);
  const userInteracting = useAppStore((state) => state.userInteracting);
  const setCameraMode = useAppStore((state) => state.setCameraMode);
  const setAutoRotate = useAppStore((state) => state.setAutoRotate);
  const reduceMotion = useAppStore((state) => state.reduceMotion);

  const isLive = interactionMode !== "boot" && interactionMode !== "intro";

  const layerRef = useRef(activeLayer);
  const regionRef = useRef(selectedRegionSlug);
  const timerRef = useRef<number | null>(null);
  const transitionDurationMs = reduceMotion ? REDUCED_TRANSITION_DURATION_MS : STANDARD_TRANSITION_DURATION_MS;

  useEffect(() => {
    return () => {
      if (timerRef.current) {
        window.clearTimeout(timerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!isLive) {
      return;
    }

    if (selectedSignalId) {
      if (cameraMode !== "signal-focus") {
        setCameraMode("signal-focus");
      }
      setAutoRotate(false);
      return;
    }

    if (selectedCountry) {
      if (cameraMode !== "country-focus") {
        setCameraMode("country-focus");
      }
      setAutoRotate(false);
      return;
    }

    if (selectedRegionSlug && regionRef.current !== selectedRegionSlug) {
      regionRef.current = selectedRegionSlug;
      if (timerRef.current) {
        window.clearTimeout(timerRef.current);
      }
      setCameraMode("transition");
      setAutoRotate(false);
      timerRef.current = window.setTimeout(() => {
        setCameraMode("live-idle");
      }, transitionDurationMs);
      return;
    }

    if (!selectedRegionSlug) {
      regionRef.current = null;
    }

    if (!selectedSignalId && !selectedCountry && !selectedRegionSlug && cameraMode !== "live-idle") {
      setCameraMode("live-idle");
    }

    if (!selectedSignalId && !selectedCountry && !selectedRegionSlug && !userInteracting) {
      setAutoRotate(!reduceMotion);
    }
  }, [
    cameraMode,
    isLive,
    reduceMotion,
    selectedCountry,
    selectedRegionSlug,
    selectedSignalId,
    setAutoRotate,
    setCameraMode,
    transitionDurationMs,
    userInteracting,
  ]);

  useEffect(() => {
    if (!isLive) {
      layerRef.current = activeLayer;
      return;
    }

    if (layerRef.current === activeLayer) {
      return;
    }

    layerRef.current = activeLayer;

    // When a focus target is active, layer switches should NOT reset the
    // camera mode. The camera stays locked on the focus target and the
    // layer visual mode biases are applied smoothly via the cinematic
    // shot system. This prevents jarring snap-backs during investigation.
    if (selectedCountry || selectedSignalId || selectedRegionSlug) {
      return;
    }

    if (timerRef.current) {
      window.clearTimeout(timerRef.current);
    }

    setCameraMode("transition");
    setAutoRotate(false);
    timerRef.current = window.setTimeout(() => {
      setCameraMode("live-idle");
      setAutoRotate(!reduceMotion);
    }, transitionDurationMs);
  }, [
    activeLayer,
    isLive,
    reduceMotion,
    selectedCountry,
    selectedRegionSlug,
    selectedSignalId,
    setAutoRotate,
    setCameraMode,
    transitionDurationMs,
  ]);

  return null;
}
