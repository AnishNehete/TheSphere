import { SphereGeometry, Vector3 } from "three";

import { latLonToVector3, vector3ToLatLon } from "@/lib/three/coordinate";

function shaderSphericalUv(point: Vector3) {
  const normal = point.clone().normalize();
  const lon = Math.atan2(-normal.z, normal.x);
  const lat = Math.asin(Math.max(-1, Math.min(1, normal.y)));
  return {
    u: ((lon / (2 * Math.PI)) % 1 + 1.5) % 1,
    v: lat / Math.PI + 0.5,
  };
}

function nearestSphereUv(target: Vector3) {
  const geometry = new SphereGeometry(1, 96, 64);
  const positions = geometry.attributes.position;
  const uvs = geometry.attributes.uv;
  let bestIndex = 0;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (let index = 0; index < positions.count; index += 1) {
    const point = new Vector3(positions.getX(index), positions.getY(index), positions.getZ(index));
    const distance = point.distanceTo(target);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  }

  const result = {
    u: uvs.getX(bestIndex),
    v: uvs.getY(bestIndex),
  };
  geometry.dispose();
  return result;
}

describe("geographic frame audit", () => {
  it("keeps coordinate transforms north-up and aligned with the shader UV winding", () => {
    // latLonToVector3 negates Z so that world positions match the SphereGeometry
    // UV winding that the shader and the NASA equirectangular texture share.
    expect(latLonToVector3(0, 0).toArray().map((value) => Number(value.toFixed(4)))).toEqual([1, 0, 0]);
    expect(latLonToVector3(0, 90).toArray().map((value) => Number(value.toFixed(4)))).toEqual([0, 0, -1]);
    expect(latLonToVector3(0, -90).toArray().map((value) => Number(value.toFixed(4)))).toEqual([0, 0, 1]);
    expect(latLonToVector3(90, 0).toArray().map((value) => Number(value.toFixed(4)))).toEqual([0, 1, 0]);

    const east = latLonToVector3(0, 90).clone().normalize();
    const north = latLonToVector3(90, 0).clone().normalize();
    const forward = latLonToVector3(0, 0).clone().normalize();

    // Surface frame is self-consistent: east = north × forward, which keeps
    // north-up and east-to-the-right when standing on the surface at (0°, 0°).
    expect(north.clone().cross(forward).dot(east)).toBeCloseTo(1, 5);

    const roundTrip = vector3ToLatLon(latLonToVector3(-33.8688, 151.2093));
    expect(roundTrip.lat).toBeCloseTo(-33.8688, 4);
    expect(roundTrip.lon).toBeCloseTo(151.2093, 4);
  });

  it("matches shader UV winding to SphereGeometry UV winding", () => {
    const canonicalPoints = [
      { label: "lon0", point: latLonToVector3(0, 0), expectedU: 0.5 },
      // After the projection fix, east 90° lands at world (0,0,-1), which is
      // u=0.75 on SphereGeometry and on the standard NASA equirectangular texture.
      { label: "east90", point: latLonToVector3(0, 90), expectedU: 0.75 },
      { label: "west90", point: latLonToVector3(0, -90), expectedU: 0.25 },
    ];

    for (const sample of canonicalPoints) {
      const sphereUv = nearestSphereUv(sample.point);
      const shaderUv = shaderSphericalUv(sample.point);

      expect(sphereUv.u).toBeCloseTo(sample.expectedU, 2);
      expect(shaderUv.u).toBeCloseTo(sample.expectedU, 5);
      expect(shaderUv.u).toBeCloseTo(sphereUv.u, 2);
      expect(shaderUv.v).toBeCloseTo(sphereUv.v, 2);
    }
  });
});
