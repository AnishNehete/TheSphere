import { Vector3 } from "three";

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

// Geographic → world-space projection.
//
// The earth shader uses `atan(-n.z, n.x)` for its spherical UV lookup, which
// matches Three.js SphereGeometry's default UV winding (so +X → u=0.5, +Z → u=0.25,
// −X → u=0/1 seam, −Z → u=0.75). On the standard NASA Blue Marble equirectangular
// texture that the engine loads, u=0.25 is the 90°W meridian and u=0.75 is the
// 90°E meridian. To make a border/marker drawn via latLonToVector3 sit over the
// correct texels, longitude +90°E must therefore land at world (0, 0, -1), not
// (0, 0, 1). The z-axis is negated so the convention lines up with both the
// shader and the source texture instead of masking the mismatch visually.
export function latLonToVector3(lat: number, lon: number, radius = 1): Vector3 {
  const normalized = normalizeLatLon(lat, lon);
  const latRad = normalized.lat * DEG2RAD;
  const lonRad = normalized.lon * DEG2RAD;

  const cosLat = Math.cos(latRad);
  const x = radius * cosLat * Math.cos(lonRad);
  const y = radius * Math.sin(latRad);
  const z = -radius * cosLat * Math.sin(lonRad);

  return new Vector3(x, y, z);
}

export function vector3ToLatLon(vector: Vector3) {
  const normalized = vector.clone().normalize();
  const lat = Math.asin(Math.max(-1, Math.min(1, normalized.y))) * RAD2DEG;
  // Inverse of latLonToVector3: z was negated on the way out, so negate on the way in.
  const lon = Math.atan2(-normalized.z, normalized.x) * RAD2DEG;
  return {
    lat: clampLatitude(lat),
    lon: wrapLongitude(lon),
  };
}

export function wrapLongitude(lon: number) {
  let current = lon;
  while (current < -180) {
    current += 360;
  }
  while (current > 180) {
    current -= 360;
  }
  return current;
}

export function clampLatitude(lat: number) {
  return Math.max(-90, Math.min(90, lat));
}

export function normalizeLatLon(lat: number, lon: number) {
  return {
    lat: clampLatitude(lat),
    lon: wrapLongitude(lon),
  };
}
