"use client";

import { useFrame } from "@react-three/fiber";
import { useRef } from "react";
import { Vector3 } from "three";

import { SUN_DIRECTION, TONE_MAPPING_EXPOSURE } from "@/lib/three/globeSceneConfig";

interface ExposureAdapterOptions {
  /** Enable adaptive exposure. When false the hook restores the base exposure. */
  enabled?: boolean;
  /** IIR response rate (1/s). Smaller = slower. ~0.9 gives a ~1.1s time constant. */
  rate?: number;
  /** Clamp fraction around the base exposure. 0.06 = ±6%. */
  range?: number;
}

/**
 * Phase 10C Part 1 — soft exposure adaptation.
 *
 * Writes `gl.toneMappingExposure` with a slow IIR toward a target exposure
 * computed from sun / camera geometry. There is no framebuffer readback, so
 * the cost is a single dot-product per frame.
 *
 * Bias policy:
 *   - sun-facing framing (camera looks toward the sunlit hemisphere) → cut
 *     exposure slightly to keep bright ocean + sun disk from feeling harsh
 *   - night-facing framing (mostly dark hemisphere) → lift exposure slightly
 *     so the terminator and city lights stay readable
 *
 * The clamp (±`range`) ensures this never reads as "auto-exposure pumping":
 * the delta is small enough that most users do not consciously notice it,
 * but globes composed wholly against the terminator stop feeling crushed
 * and globes in full sun stop feeling blown out.
 */
export function useExposureAdaptation({
  enabled = true,
  rate = 0.9,
  range = 0.06,
}: ExposureAdapterOptions = {}): void {
  const current = useRef(TONE_MAPPING_EXPOSURE);
  const viewDir = useRef(new Vector3());

  useFrame(({ camera, gl }, delta) => {
    if (!enabled) {
      gl.toneMappingExposure = TONE_MAPPING_EXPOSURE;
      current.current = TONE_MAPPING_EXPOSURE;
      return;
    }

    viewDir.current.copy(camera.position).normalize();
    const sunFacing = viewDir.current.dot(SUN_DIRECTION);

    const bias = -sunFacing * 0.55;
    const clampedBias = Math.max(-range, Math.min(range, bias));
    const target = TONE_MAPPING_EXPOSURE * (1 + clampedBias);

    const k = 1 - Math.exp(-rate * Math.max(delta, 0.0001));
    current.current += (target - current.current) * k;
    gl.toneMappingExposure = current.current;
  });
}
