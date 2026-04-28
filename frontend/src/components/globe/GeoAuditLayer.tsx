"use client";

import { useEffect, useMemo } from "react";
import {
  BufferGeometry,
  CanvasTexture,
  Color,
  Float32BufferAttribute,
  Group,
  LineBasicMaterial,
  LinearFilter,
  MeshBasicMaterial,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  Vector3,
} from "three";

import { buildCountryBorderGeometry } from "@/lib/three/geo";
import { latLonToVector3 } from "@/lib/three/coordinate";
import { SCENE_RENDER_ORDER } from "@/lib/three/globeSceneConfig";

const LINE_RADIUS = 1.004;
const LABEL_RADIUS = 1.085;
const MARKER_RADIUS = 1.014;
const SAMPLES = 180;
const DEBUG_COUNTRY_ISO3 = "JPN";
const DEBUG_MARKERS = [
  { id: "origin", label: "(0, 0)", lat: 0, lon: 0, color: "#ffd36f" },
  { id: "los-angeles", label: "Los Angeles", lat: 34.0522, lon: -118.2437, color: "#ff8c69" },
  { id: "london", label: "London", lat: 51.5074, lon: -0.1278, color: "#8fe0ff" },
  { id: "tokyo", label: "Tokyo", lat: 35.6762, lon: 139.6503, color: "#a7ff9b" },
  { id: "sydney", label: "Sydney", lat: -33.8688, lon: 151.2093, color: "#ffb1f2" },
] as const;

export function GeoAuditLayer() {
  const gridGeometry = useMemo(() => buildAuditGridGeometry(), []);
  const gridMaterial = useMemo(
    () =>
      new LineBasicMaterial({
        color: new Color("#f4deb1"),
        transparent: true,
        opacity: 0.9,
        depthWrite: false,
        depthTest: true,
      }),
    []
  );
  const countryGeometry = useMemo(() => buildCountryBorderGeometry(DEBUG_COUNTRY_ISO3, 1.0065), []);
  const countryMaterial = useMemo(
    () =>
      new LineBasicMaterial({
        color: new Color("#7cf3ff"),
        transparent: true,
        opacity: 0.98,
        depthWrite: false,
        depthTest: true,
      }),
    []
  );
  const markerGeometry = useMemo(() => new SphereGeometry(0.008, 12, 12), []);
  const markers = useMemo(
    () =>
      DEBUG_MARKERS.map((entry) => {
        const point = latLonToVector3(entry.lat, entry.lon, MARKER_RADIUS);
        const label = createSpriteLabel(`${entry.label}\n${formatLatLon(entry.lat, entry.lon)}`, entry.color);
        label.position.copy(latLonToVector3(entry.lat, entry.lon, LABEL_RADIUS));
        label.scale.set(0.28, 0.09, 1);
        label.renderOrder = SCENE_RENDER_ORDER.diagnosticsLabels;
        return {
          ...entry,
          point,
          material: new MeshBasicMaterial({ color: new Color(entry.color), depthTest: true, depthWrite: false }),
          sprite: label,
        };
      }),
    []
  );

  useEffect(() => {
    return () => {
      gridGeometry.dispose();
      gridMaterial.dispose();
      markerGeometry.dispose();
      countryGeometry?.dispose();
      countryMaterial.dispose();
      markers.forEach((marker) => {
        marker.material.dispose();
        const texture = marker.sprite.userData.texture as CanvasTexture | undefined;
        texture?.dispose();
        marker.sprite.material.dispose();
      });
    };
  }, [countryGeometry, countryMaterial, gridGeometry, gridMaterial, markerGeometry, markers]);

  return (
    <group>
      <lineSegments geometry={gridGeometry} material={gridMaterial} renderOrder={SCENE_RENDER_ORDER.diagnosticsLines} />
      {countryGeometry ? <lineSegments geometry={countryGeometry} material={countryMaterial} renderOrder={SCENE_RENDER_ORDER.countryBorders} /> : null}
      {markers.map((marker) => (
        <group key={marker.id}>
          <mesh position={marker.point} geometry={markerGeometry} material={marker.material} renderOrder={SCENE_RENDER_ORDER.markers} />
          <primitive object={marker.sprite} />
        </group>
      ))}
    </group>
  );
}

function buildAuditGridGeometry() {
  const points: number[] = [];
  appendLatitudeLine(points, 0, -180, 180, LINE_RADIUS);
  appendLongitudeLine(points, 0, -89.5, 89.5, LINE_RADIUS);
  appendLongitudeLine(points, 90, -89.5, 89.5, LINE_RADIUS);
  appendLongitudeLine(points, -90, -89.5, 89.5, LINE_RADIUS);

  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(points, 3));
  return geometry;
}

function appendLatitudeLine(points: number[], latitude: number, startLon: number, endLon: number, radius: number) {
  let previous = latLonToVector3(latitude, startLon, radius);
  for (let index = 1; index <= SAMPLES; index += 1) {
    const lon = startLon + ((endLon - startLon) * index) / SAMPLES;
    const current = latLonToVector3(latitude, lon, radius);
    points.push(previous.x, previous.y, previous.z, current.x, current.y, current.z);
    previous = current;
  }
}

function appendLongitudeLine(points: number[], longitude: number, startLat: number, endLat: number, radius: number) {
  let previous = latLonToVector3(startLat, longitude, radius);
  for (let index = 1; index <= SAMPLES; index += 1) {
    const lat = startLat + ((endLat - startLat) * index) / SAMPLES;
    const current = latLonToVector3(lat, longitude, radius);
    points.push(previous.x, previous.y, previous.z, current.x, current.y, current.z);
    previous = current;
  }
}

function createSpriteLabel(text: string, accentColor: string) {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 144;
  const context = canvas.getContext("2d");
  if (!context) {
    return new Sprite(new SpriteMaterial({ map: new CanvasTexture(canvas), transparent: true }));
  }

  context.clearRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "rgba(4, 8, 14, 0.92)";
  context.strokeStyle = accentColor;
  context.lineWidth = 2;
  context.beginPath();
  context.roundRect(12, 12, canvas.width - 24, canvas.height - 24, 18);
  context.fill();
  context.stroke();

  const [line1, line2] = text.split("\n");
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillStyle = "#f6f3ea";
  context.font = "600 28px IBM Plex Mono, monospace";
  context.fillText(line1, canvas.width / 2, 56);
  context.fillStyle = accentColor;
  context.font = "500 22px IBM Plex Mono, monospace";
  context.fillText(line2 ?? "", canvas.width / 2, 96);

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
  sprite.userData.texture = texture;
  return sprite;
}

function formatLatLon(lat: number, lon: number) {
  return `${formatLatitude(lat)} ${formatLongitude(lon)}`;
}

function formatLatitude(value: number) {
  return `${Math.abs(value).toFixed(4)}${value >= 0 ? "N" : "S"}`;
}

function formatLongitude(value: number) {
  return `${Math.abs(value).toFixed(4)}${value >= 0 ? "E" : "W"}`;
}
