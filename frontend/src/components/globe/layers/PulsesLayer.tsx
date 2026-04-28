"use client";

import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import {
  Color,
  InstancedMesh,
  MeshBasicMaterial,
  Object3D,
  Quaternion,
  TorusGeometry,
  Vector3,
} from "three";

import { latLonToVector3 } from "@/lib/three/coordinate";
import { SCENE_RENDER_ORDER } from "@/lib/three/globeSceneConfig";
import type { ConflictSignal, HealthSignal } from "@/lib/types";

interface PulsesLayerProps {
  conflicts: ConflictSignal[];
  health: HealthSignal[];
  visible: boolean;
  freezeMotion?: boolean;
}

interface PulseDescriptor {
  position: Vector3;
  orientation: Quaternion;
  baseScale: number;
  speed: number;
}

const Z_AXIS = new Vector3(0, 0, 1);

export function PulsesLayer({ conflicts, health, visible, freezeMotion = false }: PulsesLayerProps) {
  const healthRef = useRef<InstancedMesh>(null);
  const conflictRef = useRef<InstancedMesh>(null);
  const healthGeometry = useMemo(() => new TorusGeometry(1, 0.16, 12, 32), []);
  const conflictGeometry = useMemo(() => new TorusGeometry(1, 0.08, 8, 24), []);
  const healthMaterial = useMemo(
    () =>
      new MeshBasicMaterial({
        color: new Color("#8ec8ba"),
        transparent: true,
        opacity: 0.09,
        depthTest: true,
        depthWrite: false,
      }),
    []
  );
  const conflictMaterial = useMemo(
    () =>
      new MeshBasicMaterial({
        color: new Color("#f0a185"),
        transparent: true,
        opacity: 0.11,
        depthTest: true,
        depthWrite: false,
      }),
    []
  );
  const dummy = useMemo(() => new Object3D(), []);

  const healthDescriptors = useMemo<PulseDescriptor[]>(
    () =>
      health.slice(0, 48).map((signal, index) => {
        const position = latLonToVector3(signal.center.lat, signal.center.lon, 1.024);
        const orientation = new Quaternion().setFromUnitVectors(Z_AXIS, position.clone().normalize());
        return {
          position,
          orientation,
          baseScale: Math.min(0.032, 0.014 + signal.severity * 0.026),
          speed: 0.7 + index * 0.02,
        };
      }),
    [health]
  );

  const conflictDescriptors = useMemo<PulseDescriptor[]>(
    () =>
      conflicts.slice(0, 36).map((signal, index) => {
        const position = latLonToVector3(signal.center.lat, signal.center.lon, 1.026);
        const orientation = new Quaternion().setFromUnitVectors(Z_AXIS, position.clone().normalize());
        return {
          position,
          orientation,
          baseScale: Math.min(0.028, 0.013 + signal.severity * 0.018),
          speed: 1.15 + index * 0.03,
        };
      }),
    [conflicts]
  );

  useFrame(({ clock }) => {
    const elapsed = freezeMotion ? 0 : clock.elapsedTime;

    if (healthRef.current) {
      for (let index = 0; index < healthDescriptors.length; index += 1) {
        const pulse = healthDescriptors[index];
        const wave = 1 + Math.sin(elapsed * pulse.speed + index * 0.76) * 0.24;
        dummy.position.copy(pulse.position);
        dummy.quaternion.copy(pulse.orientation);
        dummy.scale.setScalar(pulse.baseScale * wave);
        dummy.updateMatrix();
        healthRef.current.setMatrixAt(index, dummy.matrix);
      }
      healthRef.current.count = healthDescriptors.length;
      healthRef.current.instanceMatrix.needsUpdate = true;
    }

    if (conflictRef.current) {
      for (let index = 0; index < conflictDescriptors.length; index += 1) {
        const pulse = conflictDescriptors[index];
        const impact = 0.82 + Math.pow(Math.abs(Math.sin(elapsed * pulse.speed + index)), 5) * 0.56;
        dummy.position.copy(pulse.position);
        dummy.quaternion.copy(pulse.orientation);
        dummy.scale.setScalar(pulse.baseScale * impact);
        dummy.updateMatrix();
        conflictRef.current.setMatrixAt(index, dummy.matrix);
      }
      conflictRef.current.count = conflictDescriptors.length;
      conflictRef.current.instanceMatrix.needsUpdate = true;
    }
  });

  useEffect(() => {
    return () => {
      healthGeometry.dispose();
      conflictGeometry.dispose();
      healthMaterial.dispose();
      conflictMaterial.dispose();
    };
  }, [conflictGeometry, conflictMaterial, healthGeometry, healthMaterial]);

  if (!visible) {
    return null;
  }

  return (
    <group>
      <instancedMesh
        ref={healthRef}
        args={[healthGeometry, healthMaterial, Math.max(healthDescriptors.length, 1)]}
        renderOrder={SCENE_RENDER_ORDER.pulsesHealth}
        frustumCulled={false}
      />
      <instancedMesh
        ref={conflictRef}
        args={[conflictGeometry, conflictMaterial, Math.max(conflictDescriptors.length, 1)]}
        renderOrder={SCENE_RENDER_ORDER.pulsesConflict}
        frustumCulled={false}
      />
    </group>
  );
}
