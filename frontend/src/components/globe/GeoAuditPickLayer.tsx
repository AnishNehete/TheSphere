"use client";

import { useThree } from "@react-three/fiber";
import { useEffect, useMemo, useState } from "react";
import { CanvasTexture, LinearFilter, Mesh, Raycaster, SphereGeometry, Sprite, SpriteMaterial, Vector2 } from "three";

import { vector3ToLatLon } from "@/lib/three/coordinate";

interface GeoAuditPickLayerProps {
  earthRef: { current: Mesh | null };
  enabled: boolean;
}

interface PickMarker {
  id: string;
  x: number;
  y: number;
  z: number;
  label: Sprite;
}

export function GeoAuditPickLayer({ earthRef, enabled }: GeoAuditPickLayerProps) {
  const { camera, gl } = useThree();
  const raycaster = useMemo(() => new Raycaster(), []);
  const pointer = useMemo(() => new Vector2(), []);
  const geometry = useMemo(() => new SphereGeometry(0.01, 12, 12), []);
  const [markers, setMarkers] = useState<PickMarker[]>([]);

  useEffect(() => {
    if (!enabled) {
      setMarkers((current) => {
        current.forEach((marker) => disposeSprite(marker.label));
        return [];
      });
      return;
    }

    const canvas = gl.domElement;
    const onClick = (event: PointerEvent) => {
      if (!earthRef.current) {
        return;
      }

      const rect = canvas.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);

      const intersections = raycaster.intersectObject(earthRef.current, false);
      if (intersections.length === 0) {
        return;
      }

      const point = intersections[0].point.clone().normalize().multiplyScalar(1.02);
      const latLon = vector3ToLatLon(intersections[0].point);
      const label = createPickLabel(latLon.lat, latLon.lon);

      setMarkers((current) => {
        const next = [...current, { id: `${Date.now()}-${current.length}`, x: point.x, y: point.y, z: point.z, label }].slice(-8);
        if (next.length === 8 && current.length >= 8) {
          disposeSprite(current[0].label);
        }
        return next;
      });
    };

    canvas.addEventListener("click", onClick);
    return () => {
      canvas.removeEventListener("click", onClick);
    };
  }, [camera, earthRef, enabled, gl.domElement, pointer, raycaster]);

  useEffect(() => {
    return () => {
      geometry.dispose();
      markers.forEach((marker) => disposeSprite(marker.label));
    };
  }, [geometry, markers]);

  if (!enabled) {
    return null;
  }

  return (
    <group>
      {markers.map((marker) => (
        <group key={marker.id} position={[marker.x, marker.y, marker.z]}>
          <mesh geometry={geometry}>
            <meshBasicMaterial color="#ff5f5f" depthWrite={false} depthTest />
          </mesh>
          <primitive object={marker.label} position={[0, 0.035, 0]} />
        </group>
      ))}
    </group>
  );
}

function createPickLabel(lat: number, lon: number) {
  const canvas = document.createElement("canvas");
  canvas.width = 448;
  canvas.height = 116;
  const context = canvas.getContext("2d");
  if (!context) {
    return new Sprite(new SpriteMaterial({ map: new CanvasTexture(canvas), transparent: true }));
  }

  context.clearRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "rgba(16, 7, 7, 0.92)";
  context.strokeStyle = "rgba(255, 95, 95, 0.95)";
  context.lineWidth = 2;
  context.beginPath();
  context.roundRect(10, 10, canvas.width - 20, canvas.height - 20, 18);
  context.fill();
  context.stroke();

  context.fillStyle = "#ffd5d5";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.font = "600 24px IBM Plex Mono, monospace";
  context.fillText(`pick ${lat.toFixed(4)}, ${lon.toFixed(4)}`, canvas.width / 2, canvas.height / 2);

  const texture = new CanvasTexture(canvas);
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.needsUpdate = true;

  const material = new SpriteMaterial({
    map: texture,
    transparent: true,
    depthWrite: false,
    depthTest: true,
  });
  const sprite = new Sprite(material);
  sprite.scale.set(0.24, 0.062, 1);
  sprite.userData.texture = texture;
  return sprite;
}

function disposeSprite(sprite: Sprite) {
  const texture = sprite.userData.texture as CanvasTexture | undefined;
  texture?.dispose();
  sprite.material.dispose();
}
