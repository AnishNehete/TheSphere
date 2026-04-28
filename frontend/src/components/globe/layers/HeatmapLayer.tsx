"use client";

import { useThree } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import { BufferGeometry, Color, Float32BufferAttribute, NormalBlending, ShaderMaterial } from "three";

import { latLonToVector3 } from "@/lib/three/coordinate";
import { SCENE_RENDER_ORDER } from "@/lib/three/globeSceneConfig";
import type { HealthSignal, WeatherSignal } from "@/lib/types";

interface HeatmapLayerProps {
  weather: WeatherSignal[];
  health: HealthSignal[];
  visible: boolean;
}

const POINT_RADIUS = 1.014;

const vertexShader = `
  attribute float aSize;
  attribute float aIntensity;
  uniform float uViewportHeight;
  varying float vIntensity;

  void main() {
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    vIntensity = aIntensity;
    gl_PointSize = clamp(aSize * uViewportHeight / max(-mvPosition.z, 0.001), 8.0, 34.0);
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const fragmentShader = `
  uniform vec3 uBaseColor;
  uniform float uOpacity;
  varying float vIntensity;

  void main() {
    vec2 centered = gl_PointCoord * 2.0 - 1.0;
    float distanceSq = dot(centered, centered);
    if (distanceSq > 1.0) {
      discard;
    }

    float halo = pow(1.0 - distanceSq, 1.9);
    float alpha = halo * uOpacity * mix(0.58, 1.0, vIntensity);
    if (alpha < 0.03) {
      discard;
    }

    vec3 color = mix(uBaseColor * 0.68, vec3(0.82, 0.95, 1.0), vIntensity * 0.34);
    gl_FragColor = vec4(color, alpha);
  }
`;

export function HeatmapLayer({ weather, health, visible }: HeatmapLayerProps) {
  const { size } = useThree();
  const items = useMemo(
    () =>
      [
        ...weather.map((item) => ({
          lat: item.center.lat,
          lon: item.center.lon,
          strength: item.severity,
          scale: 0.018 + item.radiusKm / 28000,
        })),
        ...health.map((item) => ({
          lat: item.center.lat,
          lon: item.center.lon,
          strength: item.severity,
          scale: 0.02 + item.spread / 2400,
        })),
      ].slice(0, 90),
    [health, weather]
  );

  const geometry = useMemo(() => {
    const positions: number[] = [];
    const sizes: number[] = [];
    const intensities: number[] = [];

    for (const item of items) {
      const point = latLonToVector3(item.lat, item.lon, POINT_RADIUS);
      positions.push(point.x, point.y, point.z);
      sizes.push(Math.min(0.082, 0.04 + item.scale * 0.28 + item.strength * 0.02));
      intensities.push(item.strength);
    }

    const nextGeometry = new BufferGeometry();
    nextGeometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
    nextGeometry.setAttribute("aSize", new Float32BufferAttribute(sizes, 1));
    nextGeometry.setAttribute("aIntensity", new Float32BufferAttribute(intensities, 1));
    return nextGeometry;
  }, [items]);

  const material = useMemo(
    () =>
      new ShaderMaterial({
        vertexShader,
        fragmentShader,
        transparent: true,
        depthTest: true,
        depthWrite: false,
        blending: NormalBlending,
        toneMapped: false,
        uniforms: {
          uBaseColor: { value: new Color("#4ca6b7") },
          uOpacity: { value: 0.2 },
          uViewportHeight: { value: size.height },
        },
      }),
    [size.height]
  );

  useEffect(() => {
    material.uniforms.uViewportHeight.value = size.height;
  }, [material, size.height]);

  useEffect(() => {
    return () => {
      geometry.dispose();
      material.dispose();
    };
  }, [geometry, material]);

  if (!visible) {
    return null;
  }

  return (
    <points geometry={geometry} renderOrder={SCENE_RENDER_ORDER.heatmap} frustumCulled={false}>
      <primitive attach="material" object={material} />
    </points>
  );
}
