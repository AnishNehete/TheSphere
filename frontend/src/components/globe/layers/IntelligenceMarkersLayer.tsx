"use client";

import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import {
  Color,
  InstancedMesh,
  MeshBasicMaterial,
  Object3D,
  RingGeometry,
  Vector3,
} from "three";
import type { ThreeEvent } from "@react-three/fiber";

import { resolveEventMarkers } from "@/lib/intelligence/globeAdapter";
import { latLonToVector3 } from "@/lib/three/coordinate";
import { frontFacingFactor } from "@/lib/three/frontFacing";
import { SCENE_RENDER_ORDER } from "@/lib/three/globeSceneConfig";
import type { SignalEvent, SignalSeverity } from "@/lib/intelligence/types";
import { useOverlayStore } from "@/store/useOverlayStore";
import { useSignalRailStore } from "@/store/useSignalRailStore";

// Phase 12D + 20A.3 — domain-aware event markers over the globe.
//
// Phase 20A wires the layer to the awareness rail: the active rail tab
// determines which domain's events render on the globe, so the rail
// and the globe always agree on what the operator is investigating.
// When an event has no precise lat/lon we fall back to its country
// centroid and tag the marker as country-level so it can render wider
// and softer (honesty rule: no fake precision).
//
// Phase 20A.3 — Final Marker Occlusion Fix:
//
//   * markers no longer use polygonOffset (the prior -2/-2 bias pulled
//     them toward the camera in depth, defeating the earth's z-test
//     and showing them through the globe);
//   * ring orientation is billboarded to the camera every frame so
//     markers don't go edge-on at the limb during rotation;
//   * a front-facing dot test (markerNormal · cameraDir) drives a
//     smoothstep horizon fade — scale ramps to 0 across a small band
//     so back-hemisphere instances effectively cull (raycast skips
//     scale-zero matrices, so picking respects occlusion).

const MAX_MARKERS = 50;

const SEVERITY_COLOR: Record<SignalSeverity, string> = {
  critical: "#ef7a5c",
  elevated: "#f0b36a",
  watch: "#7cb3d9",
  info: "#b8c5d1",
};

const SEVERITY_SCALE: Record<SignalSeverity, number> = {
  critical: 1.0,
  elevated: 0.85,
  watch: 0.7,
  info: 0.55,
};

const MARKER_RADIUS = 1.04;

interface PreparedMarker {
  event: SignalEvent;
  /** Pre-computed unit normal from origin to marker position. */
  normal: Vector3;
  /** Pre-computed world position at MARKER_RADIUS. */
  position: Vector3;
  severity: SignalSeverity;
  baseScale: number;
}

export function IntelligenceMarkersLayer() {
  const latestSignals = useOverlayStore((s) => s.latestSignals);
  const latestStocks = useOverlayStore((s) => s.latestStocks);
  const openEvent = useOverlayStore((s) => s.openEvent);
  const selectedDomain = useSignalRailStore((s) => s.selectedDomain);
  const byDomain = useSignalRailStore((s) => s.byDomain);

  const markers = useMemo<PreparedMarker[]>(() => {
    const railEvents = byDomain[selectedDomain] ?? [];
    const source: SignalEvent[] =
      railEvents.length > 0
        ? railEvents
        : selectedDomain === "news"
          ? [...latestSignals, ...latestStocks]
          : [];
    const resolved = resolveEventMarkers(source, { maxMarkers: MAX_MARKERS });
    return resolved.map((r) => {
      const normal = latLonToVector3(r.lat, r.lon, 1).normalize();
      const position = normal.clone().multiplyScalar(MARKER_RADIUS);
      const baseScale = (r.isCountryFallback ? 0.064 : 0.04)
        * SEVERITY_SCALE[r.event.severity];
      return {
        event: r.event,
        normal,
        position,
        severity: r.event.severity,
        baseScale,
      };
    });
  }, [byDomain, selectedDomain, latestSignals, latestStocks]);

  const geometry = useMemo(() => new RingGeometry(0.6, 1, 32), []);
  const material = useMemo(
    () =>
      new MeshBasicMaterial({
        color: new Color("#ffffff"),
        transparent: true,
        opacity: 0.95,
        // Earth writes depth; depthTest hides back-side instances.
        // We avoid polygonOffset entirely — earlier values pulled the
        // ring toward the camera in depth and produced the
        // "see-through-globe" artifact.
        depthTest: true,
        depthWrite: false,
      }),
    [],
  );
  const meshRef = useRef<InstancedMesh>(null);
  const dummy = useMemo(() => new Object3D(), []);
  const cameraDir = useMemo(() => new Vector3(), []);

  // Static color upload — colors don't change once markers are resolved.
  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const colorBuffer = new Color();
    for (let i = 0; i < markers.length; i += 1) {
      colorBuffer.set(SEVERITY_COLOR[markers[i].severity]);
      mesh.setColorAt(i, colorBuffer);
    }
    mesh.count = markers.length;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [markers]);

  // Per-frame matrix update: billboard each ring to face the camera and
  // shrink to zero across the horizon band so back-hemisphere instances
  // are culled (and unpickable). Cost: O(markers) per frame, capped at
  // MAX_MARKERS = 50 — negligible.
  useFrame(({ camera }) => {
    const mesh = meshRef.current;
    if (!mesh) return;
    cameraDir.copy(camera.position).normalize();
    for (let i = 0; i < markers.length; i += 1) {
      const marker = markers[i];
      const factor = frontFacingFactor(marker.normal, cameraDir);
      dummy.position.copy(marker.position);
      // Billboard: face the camera. Without this, lookAt(0,0,0) made
      // the ring's face point radially outward, so the ring went
      // edge-on at the limb and visually disappeared during rotation.
      dummy.lookAt(camera.position);
      const scale = marker.baseScale * factor;
      dummy.scale.set(scale, scale, scale);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    }
    mesh.count = markers.length;
    mesh.instanceMatrix.needsUpdate = true;
  });

  useEffect(
    () => () => {
      geometry.dispose();
      material.dispose();
    },
    [geometry, material],
  );

  if (markers.length === 0) return null;

  const onClick = (event: ThreeEvent<MouseEvent>) => {
    event.stopPropagation();
    const instanceId = event.instanceId;
    if (instanceId === undefined) return;
    const marker = markers[instanceId];
    if (!marker) return;
    openEvent(marker.event, "globe-click");
  };

  return (
    <instancedMesh
      ref={meshRef}
      args={[geometry, material, Math.max(markers.length, 1)]}
      renderOrder={SCENE_RENDER_ORDER.pulsesConflict + 1}
      frustumCulled={false}
      onClick={onClick}
    />
  );
}
