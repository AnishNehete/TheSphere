"use client";

import { useEffect } from "react";

import { REDUCE_MOTION_STORAGE_KEY, useAccessibilityStore } from "@/store/useAccessibilityStore";

export function AccessibilitySync() {
  const setReduceMotion = useAccessibilityStore((state) => state.setReduceMotion);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    const storedPreference = window.localStorage.getItem(REDUCE_MOTION_STORAGE_KEY);

    if (storedPreference === null) {
      setReduceMotion(mediaQuery.matches);
    } else {
      setReduceMotion(storedPreference === "true");
    }

    const syncSystemPreference = (matches: boolean) => {
      if (window.localStorage.getItem(REDUCE_MOTION_STORAGE_KEY) !== null) {
        return;
      }

      setReduceMotion(matches);
    };

    const handleChange = (event: MediaQueryListEvent) => {
      syncSystemPreference(event.matches);
    };

    if ("addEventListener" in mediaQuery) {
      mediaQuery.addEventListener("change", handleChange);
      return () => {
        mediaQuery.removeEventListener("change", handleChange);
      };
    }

    const legacyMediaQuery = mediaQuery as MediaQueryList & {
      addListener?: (listener: (event: MediaQueryListEvent) => void) => void;
      removeListener?: (listener: (event: MediaQueryListEvent) => void) => void;
    };
    const legacyListener = (event: MediaQueryListEvent) => {
      syncSystemPreference(event.matches);
    };
    legacyMediaQuery.addListener?.(legacyListener);
    return () => {
      legacyMediaQuery.removeListener?.(legacyListener);
    };
  }, [setReduceMotion]);

  return null;
}
