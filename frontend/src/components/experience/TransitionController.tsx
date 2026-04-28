"use client";

import { useEffect } from "react";

import { useExperienceStore } from "@/store/useExperienceStore";
import { useAccessibilityStore } from "@/store/useAccessibilityStore";
import { useGlobeStore } from "@/store/useGlobeStore";
import { useRenderSettingsStore } from "@/store/useRenderSettingsStore";
import { useUIStore } from "@/store/useUIStore";

const STANDARD_INTRO_DURATION_MS = 8600;
const REDUCED_INTRO_DURATION_MS = 1400;
const STANDARD_HANDOFF_DURATION_MS = 2200;
const REDUCED_HANDOFF_DURATION_MS = 500;
const DIAGNOSTICS_TRANSITION_DURATION_MS = 1;

export function TransitionController() {
  const phase = useExperienceStore((state) => state.phase);
  const setIntroProgress = useExperienceStore((state) => state.setIntroProgress);
  const setTransitionLocked = useExperienceStore((state) => state.setTransitionLocked);
  const completeIntro = useExperienceStore((state) => state.completeIntro);
  const enterLive = useExperienceStore((state) => state.enterLive);

  const setCameraMode = useGlobeStore((state) => state.setCameraMode);
  const setAutoRotate = useGlobeStore((state) => state.setAutoRotate);
  const setShowHud = useUIStore((state) => state.setShowHud);
  const setShowIntroOverlay = useUIStore((state) => state.setShowIntroOverlay);
  const reduceMotion = useAccessibilityStore((state) => state.reduceMotion);
  const diagnosticsEnabled = useRenderSettingsStore((state) => state.diagnosticsEnabled);
  const introDurationMs = diagnosticsEnabled
    ? DIAGNOSTICS_TRANSITION_DURATION_MS
    : reduceMotion
      ? REDUCED_INTRO_DURATION_MS
      : STANDARD_INTRO_DURATION_MS;
  const handoffDurationMs = diagnosticsEnabled
    ? DIAGNOSTICS_TRANSITION_DURATION_MS
    : reduceMotion
      ? REDUCED_HANDOFF_DURATION_MS
      : STANDARD_HANDOFF_DURATION_MS;

  useEffect(() => {
    if (phase !== "intro") {
      return;
    }

    setCameraMode("intro");
    setTransitionLocked(true);
    setShowHud(false);
    setShowIntroOverlay(!diagnosticsEnabled);
    setAutoRotate(!reduceMotion && !diagnosticsEnabled);

    if (diagnosticsEnabled) {
      setIntroProgress(1);
      completeIntro();
      return;
    }

    let raf = 0;
    const start = performance.now();

    const step = (now: number) => {
      const elapsed = now - start;
      const progress = Math.min(1, elapsed / introDurationMs);
      setIntroProgress(progress);

      if (progress >= 1) {
        completeIntro();
        return;
      }

      raf = window.requestAnimationFrame(step);
    };

    raf = window.requestAnimationFrame(step);
    return () => {
      if (raf) {
        window.cancelAnimationFrame(raf);
      }
    };
  }, [
    completeIntro,
    diagnosticsEnabled,
    introDurationMs,
    phase,
    reduceMotion,
    setAutoRotate,
    setCameraMode,
    setIntroProgress,
    setShowHud,
    setShowIntroOverlay,
    setTransitionLocked,
  ]);

  useEffect(() => {
    if (phase !== "handoff") {
      return;
    }

    setCameraMode("handoff");
    setTransitionLocked(true);

    const timer = window.setTimeout(() => {
      setShowIntroOverlay(false);
      setShowHud(true);
      setCameraMode("live-idle");
      setTransitionLocked(false);
      enterLive();
    }, handoffDurationMs);

    return () => {
      window.clearTimeout(timer);
    };
  }, [
    enterLive,
    handoffDurationMs,
    phase,
    setCameraMode,
    setShowHud,
    setShowIntroOverlay,
    setTransitionLocked,
  ]);

  useEffect(() => {
    if (phase !== "live") {
      return;
    }
    setCameraMode("live-idle");
    setAutoRotate(!reduceMotion && !diagnosticsEnabled);
    setShowHud(true);
    setShowIntroOverlay(false);
  }, [diagnosticsEnabled, phase, reduceMotion, setAutoRotate, setCameraMode, setShowHud, setShowIntroOverlay]);

  return null;
}
