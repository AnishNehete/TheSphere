import { describe, expect, it } from "vitest";

import { SUN_DIRECTION, SUN_POSITION } from "@/lib/three/globeSceneConfig";
import { subsolarLatLon, updateSunVectors } from "@/lib/three/sunDirection";

describe("subsolarLatLon", () => {
  it("places the sun roughly at the equator on an equinox at UTC noon", () => {
    const equinox = new Date(Date.UTC(2026, 2, 20, 12, 0, 0));
    const point = subsolarLatLon(equinox);
    // Tolerance accommodates the equation-of-time offset at March equinox
    // (≈7-8 minutes, or ~2° of longitude).
    expect(Math.abs(point.lat)).toBeLessThan(2);
    expect(Math.abs(point.lon)).toBeLessThan(3);
  });

  it("moves the subsolar point west by ~15 degrees per UTC hour", () => {
    const noon = new Date(Date.UTC(2026, 2, 20, 12, 0, 0));
    const oneHourLater = new Date(Date.UTC(2026, 2, 20, 13, 0, 0));
    const a = subsolarLatLon(noon);
    const b = subsolarLatLon(oneHourLater);
    expect(a.lon - b.lon).toBeGreaterThan(13);
    expect(a.lon - b.lon).toBeLessThan(17);
  });

  it("places the sun on the Tropic of Cancer near the June solstice", () => {
    const solstice = new Date(Date.UTC(2026, 5, 21, 12, 0, 0));
    const point = subsolarLatLon(solstice);
    expect(point.lat).toBeGreaterThan(22);
    expect(point.lat).toBeLessThan(24);
  });
});

describe("updateSunVectors", () => {
  it("produces a unit-length sun direction and proportional position", () => {
    const date = new Date(Date.UTC(2026, 2, 20, 18, 0, 0));
    updateSunVectors(date);
    const len = SUN_DIRECTION.length();
    expect(Math.abs(len - 1)).toBeLessThan(1e-6);
    const positionLen = SUN_POSITION.length();
    expect(positionLen).toBeGreaterThan(8);
    expect(positionLen).toBeLessThan(11);
  });
});
