"use client";

import { useFrame } from "@react-three/fiber";
import { useRef } from "react";
import type { DirectionalLight } from "three";

import {
  AMBIENT_COLOR,
  FILL_COLOR,
  FILL_POSITION,
  SUN_COLOR,
  SUN_POSITION,
} from "@/lib/three/globeSceneConfig";

// Phase 19C.3 — directional light tracks the live sun position.
// SUN_POSITION is mutated each frame by SunDirectionDriver, so the key
// light, fill light, materials, and lens glare all derive from the same
// authoritative subsolar vector.
export function GlobeLighting() {
  const keyLightRef = useRef<DirectionalLight>(null);

  useFrame(() => {
    const light = keyLightRef.current;
    if (!light) return;
    light.position.copy(SUN_POSITION);
  });

  return (
    <>
      <ambientLight intensity={0.085} color={AMBIENT_COLOR} />
      <directionalLight
        ref={keyLightRef}
        position={[SUN_POSITION.x, SUN_POSITION.y, SUN_POSITION.z]}
        intensity={2.35}
        color={SUN_COLOR}
      />
      <directionalLight
        position={[FILL_POSITION.x, FILL_POSITION.y, FILL_POSITION.z]}
        intensity={0.15}
        color={FILL_COLOR}
      />
    </>
  );
}
