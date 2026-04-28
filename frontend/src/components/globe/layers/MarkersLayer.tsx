"use client";

import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { Color, ConeGeometry, InstancedMesh, MeshStandardMaterial, Object3D, Quaternion, Vector3 } from "three";

import { latLonToVector3 } from "@/lib/three/coordinate";
import { SCENE_RENDER_ORDER } from "@/lib/three/globeSceneConfig";
import type { ConflictSignal } from "@/lib/types";

interface MarkersLayerProps {
  markers: ConflictSignal[];
  visible: boolean;
}

const Y_AXIS = new Vector3(0, 1, 0);

export function MarkersLayer({ markers, visible }: MarkersLayerProps) {
  const meshRef = useRef<InstancedMesh>(null);
  const geometry = useMemo(() => new ConeGeometry(1, 2.2, 5), []);
  const material = useMemo(
    () =>
      new MeshStandardMaterial({
        color: new Color("#f28b6d"),
        emissive: new Color("#5a2018"),
        emissiveIntensity: 0.18,
        roughness: 0.54,
        metalness: 0.04,
      }),
    []
  );
  const dummy = useMemo(() => new Object3D(), []);
  const orientation = useMemo(() => new Quaternion(), []);
  const items = useMemo(() => markers.slice(0, 90), [markers]);

  useLayoutEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) {
      return;
    }
    for (let index = 0; index < items.length; index += 1) {
      const marker = items[index];
      const normal = latLonToVector3(marker.center.lat, marker.center.lon, 1).normalize();
      const point = normal.clone().multiplyScalar(1.022);
      orientation.setFromUnitVectors(Y_AXIS, normal);
      dummy.position.copy(point.add(normal.clone().multiplyScalar(0.008 + marker.severity * 0.009)));
      dummy.quaternion.copy(orientation);
      dummy.scale.setScalar(Math.min(0.024, 0.01 + marker.severity * 0.01));
      dummy.updateMatrix();
      mesh.setMatrixAt(index, dummy.matrix);
    }
    mesh.count = items.length;
    mesh.instanceMatrix.needsUpdate = true;
  }, [dummy, items, orientation]);

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
    <instancedMesh
      ref={meshRef}
      args={[geometry, material, Math.max(items.length, 1)]}
      renderOrder={SCENE_RENDER_ORDER.markers}
      frustumCulled={false}
    />
  );
}
