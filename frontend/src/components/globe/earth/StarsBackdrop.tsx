"use client";

import { useFrame } from "@react-three/fiber";
import { BackSide, MeshBasicMaterial, SRGBColorSpace, type Texture } from "three";
import { useEffect, useMemo, useRef } from "react";
import type { Mesh } from "three";

import { GLOBE_RENDER_QUALITY, SCENE_RENDER_ORDER, STARFIELD_ROTATION_SPEED, STARFIELD_TINT } from "@/lib/three/globeSceneConfig";
import type { GlobeQualityPreset } from "@/lib/types";

interface StarsBackdropProps {
  texture: Texture;
  qualityPreset: GlobeQualityPreset;
  freezeMotion?: boolean;
}

export function StarsBackdrop({ texture, qualityPreset, freezeMotion = false }: StarsBackdropProps) {
  const meshRef = useRef<Mesh>(null);
  const qualitySettings = GLOBE_RENDER_QUALITY[qualityPreset];
  texture.colorSpace = SRGBColorSpace;
  const material = useMemo(
    () =>
      new MeshBasicMaterial({
        map: texture,
        side: BackSide,
        transparent: true,
        opacity: qualitySettings.starfieldOpacity,
        color: STARFIELD_TINT.clone(),
        depthWrite: false,
        toneMapped: false,
      }),
    [qualitySettings.starfieldOpacity, texture]
  );

  useFrame((_, delta) => {
    if (!meshRef.current || freezeMotion) {
      return;
    }

    meshRef.current.rotation.y += delta * STARFIELD_ROTATION_SPEED;
  });

  useEffect(() => {
    return () => {
      material.dispose();
    };
  }, [material]);

  return (
    <mesh ref={meshRef} renderOrder={SCENE_RENDER_ORDER.stars}>
      <sphereGeometry args={[82, 64, 64]} />
      <primitive object={material} attach="material" />
    </mesh>
  );
}
