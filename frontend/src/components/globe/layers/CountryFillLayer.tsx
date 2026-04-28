"use client";

// CountryFillLayer
// ----------------
// Renders the hover and selected country affordances (fill + outline).
//
// Product contract (see docs/ui/globe-borders.md):
//   - Default always-on borders are faded out at wide framing by
//     CountryBordersLayer. This layer is the primary cartographic
//     affordance during interaction, so it MUST work on its own
//     without depending on default borders being visible.
//   - Hovered country: subtle tint + elegant outline.
//   - Selected country: stronger tint + stronger outline.
//   - Hovered outline must never cover the selected outline: if the
//     hovered ISO3 equals the selected ISO3 we skip the hover pass
//     entirely (see `hoveredCountry !== selectedCountry` guards below).
//   - Hover/selected outlines sit only SLIGHTLY above the default border
//     radius (+0.00018 / +0.0003). These offsets are intentionally tight:
//     larger offsets re-introduce a "floating shell" effect that reads as
//     wireframe, which defeats the premium brief.

import { useEffect, useMemo } from "react";
import { Color, MeshBasicMaterial } from "three";

import { buildCountryBorderGeometry, buildCountryFillGeometry } from "@/lib/three/geo";
import { COUNTRY_BORDER_RADIUS, COUNTRY_FILL_RADIUS, SCENE_RENDER_ORDER } from "@/lib/three/globeSceneConfig";
import { useAppStore } from "@/store/useAppStore";
import { createBorderLineMaterial } from "@/components/globe/layers/borderLineMaterial";

export function CountryFillLayer() {
  const hoveredCountry = useAppStore((state) => state.hoveredCountry);
  const selectedCountry = useAppStore((state) => state.selectedCountry);

  const hoveredFill = useMemo(
    () => (hoveredCountry && hoveredCountry !== selectedCountry ? buildCountryFillGeometry(hoveredCountry, COUNTRY_FILL_RADIUS) : null),
    [hoveredCountry, selectedCountry]
  );
  const selectedFill = useMemo(
    () => (selectedCountry ? buildCountryFillGeometry(selectedCountry, COUNTRY_FILL_RADIUS + 0.0004) : null),
    [selectedCountry]
  );
  const hoveredBorder = useMemo(
    () => (hoveredCountry && hoveredCountry !== selectedCountry ? buildCountryBorderGeometry(hoveredCountry, COUNTRY_BORDER_RADIUS + 0.00018) : null),
    [hoveredCountry, selectedCountry]
  );
  const selectedBorder = useMemo(
    () => (selectedCountry ? buildCountryBorderGeometry(selectedCountry, COUNTRY_BORDER_RADIUS + 0.0003) : null),
    [selectedCountry]
  );

  const hoveredFillMaterial = useMemo(
    () =>
      new MeshBasicMaterial({
        color: new Color("#5b8aa0"),
        transparent: true,
        opacity: 0.04,
        depthTest: true,
        depthWrite: false,
      }),
    []
  );
  const selectedFillMaterial = useMemo(
    () =>
      new MeshBasicMaterial({
        color: new Color("#89c2d7"),
        transparent: true,
        opacity: 0.08,
        depthTest: true,
        depthWrite: false,
      }),
    []
  );
  // Hover outline: visible on both lit and unlit hemispheres but gently
  // dimmed on the night side (nightFadeStrength 0.34). Front-face window
  // is pushed slightly past the silhouette so countries near the limb
  // still read. Keep opacity well below the selected outline so the two
  // states are easy to distinguish at a glance.
  const hoveredLineMaterial = useMemo(
    () =>
      createBorderLineMaterial({
        color: "#b5d2df",
        opacity: 0.42,
        frontFadeStart: -0.08,
        frontFadeEnd: 0.22,
        nightFadeStrength: 0.34,
      }),
    []
  );
  // Selected outline: the strongest cartographic affordance on the globe.
  // Almost no night fade (0.18) because the user has explicitly committed
  // to this country — the outline should remain locatable even when the
  // selection rotates onto the unlit side.
  const selectedLineMaterial = useMemo(
    () =>
      createBorderLineMaterial({
        color: "#eef8fb",
        opacity: 0.62,
        frontFadeStart: -0.1,
        frontFadeEnd: 0.18,
        nightFadeStrength: 0.18,
      }),
    []
  );

  useEffect(() => {
    return () => {
      hoveredFillMaterial.dispose();
      selectedFillMaterial.dispose();
      hoveredLineMaterial.dispose();
      selectedLineMaterial.dispose();
    };
  }, [hoveredFillMaterial, hoveredLineMaterial, selectedFillMaterial, selectedLineMaterial]);

  useEffect(() => () => hoveredFill?.dispose(), [hoveredFill]);
  useEffect(() => () => selectedFill?.dispose(), [selectedFill]);
  useEffect(() => () => hoveredBorder?.dispose(), [hoveredBorder]);
  useEffect(() => () => selectedBorder?.dispose(), [selectedBorder]);

  return (
    <>
      {hoveredFill ? <mesh geometry={hoveredFill} material={hoveredFillMaterial} renderOrder={SCENE_RENDER_ORDER.hoveredCountryFill} /> : null}
      {selectedFill ? <mesh geometry={selectedFill} material={selectedFillMaterial} renderOrder={SCENE_RENDER_ORDER.selectedCountryFill} /> : null}
      {hoveredBorder ? <lineSegments geometry={hoveredBorder} material={hoveredLineMaterial} renderOrder={SCENE_RENDER_ORDER.hoveredCountryLine} /> : null}
      {selectedBorder ? <lineSegments geometry={selectedBorder} material={selectedLineMaterial} renderOrder={SCENE_RENDER_ORDER.selectedCountryLine} /> : null}
    </>
  );
}
