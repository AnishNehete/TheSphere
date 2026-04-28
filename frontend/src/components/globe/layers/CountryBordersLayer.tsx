"use client";

// CountryBordersLayer
// -------------------
// Renders the default, always-on country outline mesh.
//
// Product contract (DO NOT REVERT without reading docs/ui/globe-borders.md):
//   1. At wide / global framing the default borders MUST fade out entirely.
//      Always-on borders turn the planet into a "wireframe shell" which
//      directly breaks Sphere's premium, calm, Apple-like visual brief.
//   2. Interactivity MUST remain fully functional with this layer invisible.
//      Hover and click picking are driven by GlobeRaycaster hitting the
//      earth mesh and resolving lat/lon via findCountryAtLatLon — the
//      border mesh is purely decorative and is NOT part of the pick path.
//   3. Hover and selection affordances are owned by CountryFillLayer, not
//      this file. This layer must never try to emphasize the hovered /
//      selected country itself, or the two layers will fight each other.
//
// If you are a future agent tempted to "simplify" the fade curve or
// re-enable always-on borders: please first read docs/ui/globe-borders.md
// and verify that the resulting globe does not look like a technical
// wireframe at default zoom.

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import type { LineSegments } from "three";

import { buildBorderLineGeometry } from "@/lib/three/geo";
import {
  COUNTRY_BORDER_RADIUS,
  OVERLAY_DEPTH_BIAS,
  OVERLAY_OPACITY_MULT,
  SCENE_RENDER_ORDER,
} from "@/lib/three/globeSceneConfig";
import { createBorderLineMaterial } from "@/components/globe/layers/borderLineMaterial";

interface CountryBordersLayerProps {
  visible: boolean;
  /** Intelligence-driven opacity multiplier (0–1). Defaults to 1. */
  opacityScale?: number;
}

// Opacity is intentionally very low. Even when defaults fully "fade in"
// (camera close to the surface) they should read as a subtle cartographic
// hint — never as a dominant linework pass.
const DEFAULT_BORDER_BASE_OPACITY = 0.048;

// Camera radius thresholds for fading default borders in and out.
// Units are scene units; the globe has GLOBE_RADIUS = 1. At the default
// framing camera distance (~2.6–2.8) the factor is 0, which hides the
// layer entirely and prevents the wireframe-shell look.
// As the user zooms in past ~2.18 the factor ramps to 1, so borders only
// appear once they are useful as a cartographic reference rather than a
// decorative shell.
const DEFAULT_BORDER_FADE_START_RADIUS = 2.18;
const DEFAULT_BORDER_FADE_END_RADIUS = 2.5;

// Linear ramp from 1 (fully visible) near the surface to 0 (hidden) at wide
// framing. Kept as a plain function so it can be unit-tested and so future
// agents can adjust the curve without touching the shader uniforms.
function getDefaultBorderFade(cameraRadius: number) {
  if (cameraRadius <= DEFAULT_BORDER_FADE_START_RADIUS) {
    return 1;
  }

  if (cameraRadius >= DEFAULT_BORDER_FADE_END_RADIUS) {
    return 0;
  }

  const progress =
    (cameraRadius - DEFAULT_BORDER_FADE_START_RADIUS) /
    (DEFAULT_BORDER_FADE_END_RADIUS - DEFAULT_BORDER_FADE_START_RADIUS);

  return 1 - progress;
}

export function CountryBordersLayer({ visible, opacityScale = 1 }: CountryBordersLayerProps) {
  const { camera } = useThree();
  const lineRef = useRef<LineSegments>(null);
  // Phase 3.6 — honor the central OVERLAY_DEPTH_BIAS tuning knob so the border
  // mesh's distance off the surface can be retuned in one place without editing
  // geometry builders or picking math.
  const geometry = useMemo(
    () => buildBorderLineGeometry(COUNTRY_BORDER_RADIUS + OVERLAY_DEPTH_BIAS),
    []
  );
  // Shader-based line material is used (instead of LineBasicMaterial) so
  // that:
  //   - Back-facing segments on the far side of the globe are culled via
  //     the frontFade range, preventing ghosted lines bleeding through the
  //     planet at wide framing.
  //   - Segments on the night side fade out aggressively (nightFadeStrength
  //     0.86) so the unlit hemisphere stays clean and premium.
  const material = useMemo(
    () =>
      createBorderLineMaterial({
        color: "#8ea2b1",
        opacity: DEFAULT_BORDER_BASE_OPACITY,
        frontFadeStart: 0.08,
        frontFadeEnd: 0.24,
        nightFadeStrength: 0.86,
      }),
    []
  );
  const initialFade = visible ? getDefaultBorderFade(camera.position.length()) : 0;

  // Per-frame zoom response. This is the hook the premium contract hangs
  // on: if the fade stops being driven by camera radius, the globe will
  // revert to a wireframe-shell look the moment the user pulls back.
  // `lineRef.visible` is also toggled so that fully faded borders stop
  // submitting draw calls entirely.
  useFrame(() => {
    const fade = visible ? getDefaultBorderFade(camera.position.length()) : 0;
    // Phase 3.6 — OVERLAY_OPACITY_MULT scales the base opacity so the wireframe
    // shell can be calmed (or boosted) globally without retuning each layer.
    // Phase 6B — intelligence-driven opacityScale further modulates per-layer.
    material.uniforms.uOpacity.value =
      DEFAULT_BORDER_BASE_OPACITY * fade * OVERLAY_OPACITY_MULT * opacityScale;

    if (lineRef.current) {
      lineRef.current.visible = fade > 0.001;
    }
  });

  useEffect(() => {
    material.uniforms.uOpacity.value =
      DEFAULT_BORDER_BASE_OPACITY * initialFade * OVERLAY_OPACITY_MULT * opacityScale;

    if (lineRef.current) {
      lineRef.current.visible = initialFade > 0.001;
    }

    return () => {
      geometry.dispose();
      material.dispose();
    };
  }, [geometry, initialFade, material]);

  if (!visible) {
    return null;
  }

  return (
    <lineSegments
      ref={lineRef}
      geometry={geometry}
      material={material}
      renderOrder={SCENE_RENDER_ORDER.countryBorders}
      visible={initialFade > 0.001}
    />
  );
}
