import { latLonToVector3, normalizeLatLon, vector3ToLatLon, wrapLongitude } from "@/lib/three/coordinate";

describe("coordinate transforms", () => {
  it("maps canonical lat lon coordinates onto the sphere", () => {
    expect(latLonToVector3(0, 0).toArray().map((value) => Number(value.toFixed(4)))).toEqual([1, 0, 0]);
    expect(latLonToVector3(0, 90).toArray().map((value) => Number(value.toFixed(4)))).toEqual([0, 0, -1]);
    expect(latLonToVector3(90, 0).toArray().map((value) => Number(value.toFixed(4)))).toEqual([0, 1, 0]);
  });

  it("normalizes and round-trips lat lon values", () => {
    expect(normalizeLatLon(120, 220)).toEqual({ lat: 90, lon: -140 });
    expect(wrapLongitude(540)).toBe(180);

    const latLon = vector3ToLatLon(latLonToVector3(42.5, -73.2));
    expect(latLon.lat).toBeCloseTo(42.5, 4);
    expect(latLon.lon).toBeCloseTo(-73.2, 4);
  });

  it("keeps seam and pole edge cases stable", () => {
    const seamEast = vector3ToLatLon(latLonToVector3(12.4, 179.999));
    const seamWest = vector3ToLatLon(latLonToVector3(-18.8, -179.999));
    const northPole = vector3ToLatLon(latLonToVector3(89.999, 42));
    const southPole = vector3ToLatLon(latLonToVector3(-89.999, -128));

    expect(seamEast.lat).toBeCloseTo(12.4, 3);
    expect(seamEast.lon).toBeCloseTo(179.999, 3);
    expect(seamWest.lat).toBeCloseTo(-18.8, 3);
    expect(seamWest.lon).toBeCloseTo(-179.999, 3);
    expect(northPole.lat).toBeCloseTo(89.999, 3);
    expect(southPole.lat).toBeCloseTo(-89.999, 3);
  });
});
