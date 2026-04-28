"use client";

import { useFrame } from "@react-three/fiber";
import { useEffect } from "react";

import { updateSunVectors } from "@/lib/three/sunDirection";

// Phase 19C.3 — drives the shared SUN_DIRECTION / SUN_POSITION vectors
// from the current UTC time. Other materials read those vectors via
// `.copy(SUN_DIRECTION)` in their own useFrame, so updating once per
// frame here propagates a real-time terminator everywhere coherently.
export function SunDirectionDriver() {
  useEffect(() => {
    // Set an initial value before the first render so static SSR-like
    // mounts or non-render-loop consumers (lighting fallbacks) read a
    // sane vector instead of the bundle's compile-time constant.
    updateSunVectors();
  }, []);

  useFrame(() => {
    updateSunVectors();
  });

  return null;
}
