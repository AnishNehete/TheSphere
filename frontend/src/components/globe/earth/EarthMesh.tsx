"use client";

import { forwardRef } from "react";
import type { Mesh, Texture, Vector3 } from "three";

import type { EarthDebugView } from "@/lib/three/earthShader";
import { SCENE_RENDER_ORDER } from "@/lib/three/globeSceneConfig";
import type { GlobeTextureSet } from "@/lib/three/textureManager";

import { EarthMaterial } from "./EarthMaterial";

interface EarthMeshProps {
  textures: GlobeTextureSet;
  cloudShadowMap?: Texture | null;
  /** Phase 8B — shared climatology DataTexture for shadow-parity. */
  climatologyMap?: Texture | null;
  /** Phase 9A — live volumetric coverage RT for true shadow parity. */
  cloudCoverageRT?: Texture | null;
  sunDirection?: Vector3;
  debugView?: EarthDebugView;
  segments?: number;
  skyMap?: Texture | null;
  /** Phase 10B — atmosphere sample count forwarded from the quality tier. */
  atmosphereSamples?: number;
}

export const EarthMesh = forwardRef<Mesh, EarthMeshProps>(function EarthMesh(
  {
    textures,
    cloudShadowMap = null,
    climatologyMap = null,
    cloudCoverageRT = null,
    sunDirection,
    debugView = "default",
    segments = 192,
    skyMap = null,
    atmosphereSamples = 6,
  },
  ref
) {
  return (
    <mesh ref={ref} renderOrder={SCENE_RENDER_ORDER.earth}>
      <sphereGeometry args={[1, segments, segments]} />
      <EarthMaterial
        dayMap={textures.day}
        nightMap={textures.night}
        normalMap={textures.normal}
        specularMap={textures.specular}
        cloudShadowMap={cloudShadowMap}
        climatologyMap={climatologyMap}
        cloudCoverageRT={cloudCoverageRT}
        sunDirection={sunDirection}
        debugView={debugView}
        skyMap={skyMap}
        atmosphereSamples={atmosphereSamples}
      />
    </mesh>
  );
});
