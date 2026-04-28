/**
 * Phase 8B — Lightweight climatology texture.
 *
 * Rather than shipping a real multi-megabyte SST/cloud-cover dataset,
 * we bake a small procedural DataTexture at startup that encodes the
 * broad Earth-system climatology the shader needs:
 *
 *   R  — convective likelihood (warm-pool index, 0..1)
 *   G  — mean cloud cover proxy (0..1)
 *   B  — ITCZ latitude shift, remapped to 0..1 (0.5 = equator)
 *   A  — storm corridor preference (0..1)
 *
 * 256 x 128 keeps the memory footprint trivial (~128 kB) while giving
 * the shader something that samples as sampled data, not as live math.
 * The shader still does the fine structure — this texture just
 * provides the Earth-conditioned backbone.
 */

import { DataTexture, LinearFilter, RepeatWrapping, RGBAFormat, UnsignedByteType } from "three";

const CLIM_WIDTH = 256;
const CLIM_HEIGHT = 128;

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(Math.max((x - edge0) / (edge1 - edge0), 0), 1);
  return t * t * (3 - 2 * t);
}

/**
 * Build a 256x128 RGBA8 climatology texture. The math follows the same
 * Earth-system heuristics as Phase 8A but is evaluated once on the CPU
 * and sampled as texture data at runtime.
 */
export function createClimatologyTexture(): DataTexture {
  const data = new Uint8Array(CLIM_WIDTH * CLIM_HEIGHT * 4);

  for (let y = 0; y < CLIM_HEIGHT; y++) {
    const v = (y + 0.5) / CLIM_HEIGHT;
    const lat = (v - 0.5) * Math.PI;
    const absLat = Math.abs(lat);
    const hem = Math.sign(lat + 0.001);

    for (let x = 0; x < CLIM_WIDTH; x++) {
      const u = (x + 0.5) / CLIM_WIDTH;
      const lon = (u - 0.5) * Math.PI * 2;

      // R — convective likelihood. Peaks in tropics and along the warm
      // pool / Amazon / African convective cores.
      const tropical = Math.exp(-(absLat * absLat) / 0.05);
      const warmPool = 0.5 + 0.3 * Math.sin(lon * 3.0 + 0.4) + 0.2 * Math.sin(lon * 1.0 - 1.2);
      const convection = Math.min(1.0, tropical * Math.max(0.3, warmPool) * 1.3);

      // G — mean cloud cover climatology. ITCZ + mid-latitude storm
      // tracks high, subtropical descent low.
      const itcz = Math.exp(-(absLat * absLat) / 0.020) * 0.6;
      const midLat = Math.exp(-Math.pow(absLat - 0.82, 2) / 0.035) * 0.55;
      const subtropCalm = Math.exp(-Math.pow(absLat - 0.44, 2) / 0.022) * 0.35;
      const polar = Math.exp(-Math.pow(absLat - 1.1, 2) / 0.045) * 0.30;
      let cover = 0.32 + itcz + midLat + polar - subtropCalm;
      cover = Math.min(1.0, Math.max(0.0, cover));

      // B — ITCZ shift. Slight northward skew (real climatological
      // ITCZ sits ~5N), modulated by longitude (monsoon excursions).
      const itczCenter = 0.09 + 0.035 * Math.sin(lon * 1.0 - 0.8);
      const itczLocal = Math.exp(-Math.pow(lat - itczCenter, 2) / 0.012);
      const itczB = Math.min(1.0, itczLocal);

      // A — storm corridor preference. Mid-latitudes dominate,
      // with a southern-ocean reinforcement (unbroken belt).
      const midCorridor = midLat * 1.4;
      const southernOcean = hem < 0 ? smoothstep(0.65, 0.95, absLat) * 0.35 : 0;
      const corridor = Math.min(1.0, midCorridor + southernOcean);

      const idx = (y * CLIM_WIDTH + x) * 4;
      data[idx + 0] = Math.round(convection * 255);
      data[idx + 1] = Math.round(cover * 255);
      data[idx + 2] = Math.round(itczB * 255);
      data[idx + 3] = Math.round(corridor * 255);
    }
  }

  const texture = new DataTexture(data, CLIM_WIDTH, CLIM_HEIGHT, RGBAFormat, UnsignedByteType);
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.needsUpdate = true;
  return texture;
}
