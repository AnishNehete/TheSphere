"use client";

import { useEffect, useMemo } from "react";
import {
  AdditiveBlending,
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  ShaderMaterial,
} from "three";

import { SCENE_RENDER_ORDER } from "@/lib/three/globeSceneConfig";
import type { GlobeQualityPreset } from "@/lib/types";

interface StarfieldLayerProps {
  qualityPreset: GlobeQualityPreset;
  intensity?: number;
  /**
   * Phase 10C — density multiplier scaling the tier baseline count. Lets the
   * high tier carry astrophotography-grade richness while the low tier
   * stays on its cost-controlled baseline.
   */
  densityMultiplier?: number;
}

// Radius of the procedural star shell. Sits well beyond the globe (1.0) and
// the cloud/atmosphere envelope (~1.05), but close enough to avoid precision
// loss in the far clip plane.
const STAR_RADIUS = 72;

// Phase 19C.3 — star counts roughly doubled per tier so the night sky
// reads as populated and cinematic instead of a sparse dot pattern.
// Combined with the density multiplier in GLOBE_RENDER_QUALITY, the
// medium/high tiers now ship astrophotography-grade richness.
const STAR_COUNTS: Record<GlobeQualityPreset, number> = {
  low: 2400,
  medium: 5200,
  high: 8400,
};

// Deterministic PRNG (mulberry32). Stable star positions across reloads without
// pulling in a seeding library — critical for cinematic shots.
function mulberry32(seed: number): () => number {
  let t = seed;
  return function random(): number {
    t |= 0;
    t = (t + 0x6d2b79f5) | 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

interface StarAttributes {
  positions: Float32Array;
  sizes: Float32Array;
  tints: Float32Array;
}

// Phase 5 Part 6 — galactic plane axis (tilted ~63 deg from ecliptic).
// Used in both JS (to boost density near the Milky Way) and GLSL (to
// boost size/brightness there). The axis is precomputed for stability.
const GALACTIC_AXIS_X = Math.sin(1.097);  // sin(62.87 deg)
const GALACTIC_AXIS_Y = Math.cos(1.097);  // cos(62.87 deg)

function buildStarAttributes(count: number, seed: number): StarAttributes {
  const positions = new Float32Array(count * 3);
  const sizes = new Float32Array(count);
  const tints = new Float32Array(count * 3);
  const random = mulberry32(seed);

  // Four tint anchors: mostly cool/neutral, occasional warm giants,
  // rare deep-blue hot stars (Phase 5 addition for spectral depth).
  const warm = new Color("#ffe6c4");
  const cool = new Color("#d6e6ff");
  const neutral = new Color("#f6f8ff");
  const hotBlue = new Color("#a8c8ff");

  for (let i = 0; i < count; i += 1) {
    // Uniform point on a sphere via inverse CDF of the z-marginal.
    const u = random();
    const v = random();
    const theta = 2 * Math.PI * u;
    const phi = Math.acos(2 * v - 1);
    const sinPhi = Math.sin(phi);

    let x = sinPhi * Math.cos(theta);
    let y = Math.cos(phi);
    let z = sinPhi * Math.sin(theta);

    // Phase 5 Part 6 — galactic concentration. ~25% of stars are biased
    // toward the galactic plane, creating an implicit Milky Way density
    // band without needing a background mesh.
    const galacticBias = random();
    if (galacticBias < 0.25) {
      const galacticLat = x * GALACTIC_AXIS_X + y * GALACTIC_AXIS_Y;
      const correction = galacticLat * 0.55;
      x -= correction * GALACTIC_AXIS_X;
      y -= correction * GALACTIC_AXIS_Y;
      const len = Math.sqrt(x * x + y * y + z * z);
      x /= len;
      y /= len;
      z /= len;
    }

    positions[i * 3 + 0] = STAR_RADIUS * x;
    positions[i * 3 + 1] = STAR_RADIUS * y;
    positions[i * 3 + 2] = STAR_RADIUS * z;

    // Phase 10C — five size populations tuned for astrophotography feel.
    // The dust tier widens downward (0.36..0.82) so the bulk of added stars
    // from a higher density multiplier read as deep-sky grain rather than a
    // crowd of medium points. Anchor (supergiant) counts stay fixed.
    const sizeRoll = random();
    const sizeBase =
      sizeRoll > 0.9975 ? 3.7 + random() * 1.3
      : sizeRoll > 0.988 ? 2.5 + random() * 1.1
      : sizeRoll > 0.94 ? 1.45 + random() * 0.75
      : sizeRoll > 0.78 ? 0.95 + random() * 0.45
      : 0.36 + random() * 0.46;
    sizes[i] = sizeBase;

    const tintRoll = random();
    const picked =
      tintRoll > 0.96 ? warm
      : tintRoll > 0.90 ? hotBlue
      : tintRoll > 0.55 ? cool
      : neutral;
    const jitter = 0.86 + random() * 0.14;
    tints[i * 3 + 0] = picked.r * jitter;
    tints[i * 3 + 1] = picked.g * jitter;
    tints[i * 3 + 2] = picked.b * jitter;
  }

  return { positions, sizes, tints };
}

const STAR_VERTEX_SHADER = `
  attribute float aSize;
  attribute vec3 aTint;

  varying vec3 vTint;
  varying float vAlpha;
  varying float vGalacticBoost;

  uniform float uPixelRatio;
  uniform float uIntensity;

  void main() {
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);

    // Phase 5 Part 6 — galactic plane boost. Stars near the Milky Way
    // appear ~30% larger and ~12% brighter, creating an implicit density
    // band in the star field without needing a background mesh.
    vec3 galacticAxis = vec3(${GALACTIC_AXIS_X.toFixed(4)}, ${GALACTIC_AXIS_Y.toFixed(4)}, 0.0);
    float galacticLat = abs(dot(normalize(position), galacticAxis));
    float galacticHaze = exp(-galacticLat * galacticLat * 6.0);
    vGalacticBoost = galacticHaze;

    float boostedSize = aSize * (1.0 + galacticHaze * 0.30);
    // Phase 6A — point stability. Compute the raw screen-space size, then
    // floor it at 0.8 CSS px so no star drops to sub-pixel and flickers
    // between visible/invisible during camera motion. Stars that WOULD be
    // sub-pixel are faded out gracefully via smoothstep instead.
    float rawSize = boostedSize * uPixelRatio * (280.0 / max(-mvPosition.z, 1.0));
    gl_PointSize = max(rawSize, 0.8);
    gl_Position = projectionMatrix * mvPosition;
    vTint = aTint;
    float subPixelFade = smoothstep(0.4, 1.2, rawSize);
    vAlpha = clamp(aSize * 0.6, 0.15, 1.0) * uIntensity * (1.0 + galacticHaze * 0.12) * subPixelFade;
  }
`;

const STAR_FRAGMENT_SHADER = `
  precision mediump float;

  varying vec3 vTint;
  varying float vAlpha;
  varying float vGalacticBoost;

  void main() {
    // Circular soft falloff — no square GL_POINTS artefact, no spiky hot cores.
    vec2 centered = gl_PointCoord * 2.0 - 1.0;
    float r2 = dot(centered, centered);
    if (r2 > 1.0) {
      discard;
    }
    float falloff = exp(-r2 * 4.5);
    vec3 color = vTint * falloff;
    // Phase 5 Part 6 — extremely subtle warm galactic dust tint on stars
    // near the Milky Way plane. Restrained to 0.025 opacity so it reads
    // as "deep sky hint" not "nebula wallpaper".
    color += vec3(0.92, 0.88, 0.78) * falloff * vGalacticBoost * 0.025;
    gl_FragColor = vec4(color, falloff * vAlpha);
  }
`;

// Phase 19C.3 — intensity lifted so the increased star count reads as a
// richer field instead of a wider field of dim points. Sub-pixel fade
// inside the vertex shader still floors flickery stars.
const DEFAULT_INTENSITY = 0.36;

export function StarfieldLayer({
  qualityPreset,
  intensity = DEFAULT_INTENSITY,
  densityMultiplier = 1,
}: StarfieldLayerProps) {
  const baseCount = STAR_COUNTS[qualityPreset];
  const scaled = Math.round(baseCount * Math.max(0.5, Math.min(2.5, densityMultiplier)));
  const count = scaled;

  const geometry = useMemo(() => {
    const attrs = buildStarAttributes(count, 0x1b5c2a);
    const geom = new BufferGeometry();
    geom.setAttribute("position", new Float32BufferAttribute(attrs.positions, 3));
    geom.setAttribute("aSize", new Float32BufferAttribute(attrs.sizes, 1));
    geom.setAttribute("aTint", new Float32BufferAttribute(attrs.tints, 3));
    return geom;
  }, [count]);

  const material = useMemo(() => {
    const pixelRatio =
      typeof window === "undefined" ? 1 : Math.min(window.devicePixelRatio ?? 1, 2);
    return new ShaderMaterial({
      vertexShader: STAR_VERTEX_SHADER,
      fragmentShader: STAR_FRAGMENT_SHADER,
      transparent: true,
      depthTest: true,
      depthWrite: false,
      blending: AdditiveBlending,
      toneMapped: false,
      uniforms: {
        uIntensity: { value: intensity },
        uPixelRatio: { value: pixelRatio },
      },
    });
  }, [intensity]);

  useEffect(() => {
    return () => {
      geometry.dispose();
      material.dispose();
    };
  }, [geometry, material]);

  return (
    <points renderOrder={SCENE_RENDER_ORDER.stars} frustumCulled={false}>
      <primitive attach="geometry" object={geometry} />
      <primitive attach="material" object={material} />
    </points>
  );
}
