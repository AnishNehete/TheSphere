"use client";

import { useEffect, useMemo } from "react";
import { Color, LineBasicMaterial, MeshBasicMaterial } from "three";

import { buildRegionBorderGeometry, buildRegionFillGeometry } from "@/lib/three/geo";
import { REGION_FILL_RADIUS, REGION_LINE_RADIUS, SCENE_RENDER_ORDER } from "@/lib/three/globeSceneConfig";
import { useDataStore } from "@/store/useDataStore";
import { useAppStore } from "@/store/useAppStore";

export function RegionFocusLayer() {
  const selectedRegionSlug = useAppStore((state) => state.selectedRegionSlug);
  const regions = useDataStore((state) => state.regions);

  const region = useMemo(
    () => regions.find((entry) => entry.slug === selectedRegionSlug) ?? null,
    [regions, selectedRegionSlug]
  );
  const fillGeometry = useMemo(
    () => (region ? buildRegionFillGeometry(region, REGION_FILL_RADIUS) : null),
    [region]
  );
  const lineGeometry = useMemo(
    () => (region ? buildRegionBorderGeometry(region, REGION_LINE_RADIUS) : null),
    [region]
  );

  const fillMaterial = useMemo(
    () =>
      new MeshBasicMaterial({
        color: new Color("#4f6773"),
        transparent: true,
        opacity: 0.05,
        depthTest: true,
        depthWrite: false,
      }),
    []
  );
  const lineMaterial = useMemo(
    () =>
      new LineBasicMaterial({
        color: new Color("#aab9c2"),
        transparent: true,
        opacity: 0.24,
        depthTest: true,
        depthWrite: false,
      }),
    []
  );

  useEffect(() => {
    return () => {
      fillMaterial.dispose();
      lineMaterial.dispose();
    };
  }, [fillMaterial, lineMaterial]);

  useEffect(() => () => fillGeometry?.dispose(), [fillGeometry]);
  useEffect(() => () => lineGeometry?.dispose(), [lineGeometry]);

  if (!region || !fillGeometry || !lineGeometry) {
    return null;
  }

  return (
    <>
      <mesh geometry={fillGeometry} material={fillMaterial} renderOrder={SCENE_RENDER_ORDER.regionFill} />
      <lineSegments geometry={lineGeometry} material={lineMaterial} renderOrder={SCENE_RENDER_ORDER.regionLine} />
    </>
  );
}
