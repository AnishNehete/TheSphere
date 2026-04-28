/**
 * Phase 10B — Cloud History / TAA Support
 *
 * Maintains a framebuffer-history texture and the previous-frame
 * view-projection matrix so the volumetric cloud shader can reproject
 * the current cloud-shell hit into the previous frame's screen space,
 * sample history, and blend conservatively for temporal stability.
 *
 * The history is *not* a cloud-only pass — we copy the main framebuffer
 * at the end of each frame via `renderer.copyFramebufferToTexture`. This
 * is cheap (no extra geometry work, no extra shader passes, one GL blit)
 * but it means the history contains Earth+atmosphere+clouds composited.
 * The shader compensates by only reading history where the current
 * frame's cloud alpha is non-trivial and by limiting the blend weight —
 * residual Earth-through-cloud double-exposure stays under a perceptible
 * threshold while the cloud silhouette gains a multi-frame lowpass that
 * suppresses step shimmer and march crawl.
 *
 * The hook returns a stable `Texture` reference plus a handle exposing
 * the previous-frame VP matrix so the cloud material can wire both into
 * its uniform block without prop-drilling renderer internals.
 *
 * Performance:
 *   One full-screen blit per frame (≤ 1 ms on modern GPUs at 1080p).
 *   The destination texture is created lazily on the first capture so
 *   disable/enable toggles do not allocate up front.
 *
 * Constraints:
 *   - Disabled by default; gated on `enabled` so low-tier / diagnostics
 *     builds pay zero cost.
 *   - Uses `copyFramebufferToTexture` (WebGL2 fast path). Falls back
 *     silently if the renderer rejects the copy (e.g. during resize).
 */

"use client";

import * as THREE from "three";
import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";

export interface CloudHistoryHandle {
  /** History texture sampled by the cloud shader (stable reference). */
  readonly texture: THREE.Texture;
  /** Previous frame's combined view*projection matrix. */
  readonly prevViewProjection: THREE.Matrix4;
  /** Previous frame's camera world position (used for velocity rejection). */
  readonly prevCameraPosition: THREE.Vector3;
  /** Inverse-resolution vector for history sampling (1/w, 1/h). */
  readonly invResolution: THREE.Vector2;
  /** 1 when history has been captured at least once, 0 otherwise. */
  readonly ready: { value: number };
}

interface UseCloudHistoryRTParams {
  /** Master on/off — mirror `taaEnabled` from the active quality tier. */
  enabled: boolean;
}

export function useCloudHistoryRT({ enabled }: UseCloudHistoryRTParams): CloudHistoryHandle {
  const { gl, size, camera } = useThree();

  const handle = useMemo<CloudHistoryHandle>(() => {
    const tex = new THREE.Texture();
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.generateMipmaps = false;
    return {
      texture: tex,
      prevViewProjection: new THREE.Matrix4(),
      prevCameraPosition: new THREE.Vector3(),
      invResolution: new THREE.Vector2(1 / Math.max(size.width, 1), 1 / Math.max(size.height, 1)),
      ready: { value: 0 },
    };
  }, [size.height, size.width]);

  useEffect(() => {
    return () => {
      handle.texture.dispose();
    };
  }, [handle.texture]);

  const tempVP = useRef(new THREE.Matrix4()).current;
  const allocatedRef = useRef<{ w: number; h: number } | null>(null);

  useFrame(() => {
    if (!enabled) {
      handle.ready.value = 0;
      return;
    }

    const dpr = gl.getPixelRatio();
    const width = Math.max(1, Math.floor(size.width * dpr));
    const height = Math.max(1, Math.floor(size.height * dpr));

    // Allocate / reallocate destination texture to match framebuffer.
    if (!allocatedRef.current || allocatedRef.current.w !== width || allocatedRef.current.h !== height) {
      const data = new Uint8Array(width * height * 4);
      const newTex = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, THREE.UnsignedByteType);
      newTex.minFilter = THREE.LinearFilter;
      newTex.magFilter = THREE.LinearFilter;
      newTex.wrapS = THREE.ClampToEdgeWrapping;
      newTex.wrapT = THREE.ClampToEdgeWrapping;
      newTex.generateMipmaps = false;
      newTex.needsUpdate = true;
      // Swap the image / backing so outside consumers keep the same
      // Texture object they were handed at mount time.
      handle.texture.image = newTex.image;
      handle.texture.format = newTex.format;
      handle.texture.type = newTex.type;
      handle.texture.needsUpdate = true;
      newTex.dispose();
      allocatedRef.current = { w: width, h: height };
      handle.invResolution.set(1 / width, 1 / height);
      handle.ready.value = 0; // skip sampling until we have a real frame
    }

    try {
      gl.copyFramebufferToTexture(handle.texture, new THREE.Vector2(0, 0), 0);
      handle.ready.value = 1;
    } catch {
      // Swallow — resize-adjacent copies can transiently fail during the
      // first frame after a DPR flip. Next frame will succeed.
      handle.ready.value = 0;
    }

    // Snapshot prev view-projection and camera position *after* copy so
    // the matrices associate with the frame now in the history texture.
    tempVP.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    handle.prevViewProjection.copy(tempVP);
    handle.prevCameraPosition.copy(camera.position);
  }, 1); // priority 1 — run after main scene render (priority 0)

  return handle;
}
