import { describe, expect, it } from "vitest";
import { Vector3 } from "three";

import {
  FRONT_FACING_FADE_BAND,
  FRONT_FACING_THRESHOLD,
  frontFacingFactor,
} from "@/lib/three/frontFacing";

describe("frontFacingFactor", () => {
  const cameraDir = new Vector3(0, 0, 1); // camera on +Z looking at origin

  it("returns 1 for marker squarely on the visible hemisphere", () => {
    const normal = new Vector3(0, 0, 1); // dot = 1
    expect(frontFacingFactor(normal, cameraDir)).toBe(1);
  });

  it("returns 0 for marker squarely on the back hemisphere", () => {
    const normal = new Vector3(0, 0, -1); // dot = -1
    expect(frontFacingFactor(normal, cameraDir)).toBe(0);
  });

  it("returns 1 just above threshold", () => {
    const normal = new Vector3(
      Math.sqrt(1 - (FRONT_FACING_THRESHOLD + 0.001) ** 2),
      0,
      FRONT_FACING_THRESHOLD + 0.001,
    );
    expect(frontFacingFactor(normal, cameraDir)).toBe(1);
  });

  it("ramps to 0 across the fade band below threshold", () => {
    const lower = FRONT_FACING_THRESHOLD - FRONT_FACING_FADE_BAND;
    const justAboveLower = lower + 0.001;
    const factor = frontFacingFactor(
      new Vector3(
        Math.sqrt(1 - justAboveLower ** 2),
        0,
        justAboveLower,
      ),
      cameraDir,
    );
    expect(factor).toBeGreaterThan(0);
    expect(factor).toBeLessThan(0.05);
  });

  it("returns 0 at and below the lower bound of the fade band", () => {
    const lower = FRONT_FACING_THRESHOLD - FRONT_FACING_FADE_BAND;
    const normal = new Vector3(
      Math.sqrt(Math.max(0, 1 - lower ** 2)),
      0,
      lower,
    );
    expect(frontFacingFactor(normal, cameraDir)).toBe(0);
  });

  it("smoothly interpolates inside the fade band (smoothstep)", () => {
    // Midpoint of the fade band — smoothstep(0.5) = 0.5.
    const mid = FRONT_FACING_THRESHOLD - FRONT_FACING_FADE_BAND / 2;
    const normal = new Vector3(
      Math.sqrt(1 - mid ** 2),
      0,
      mid,
    );
    expect(frontFacingFactor(normal, cameraDir)).toBeCloseTo(0.5, 5);
  });

  it("is monotone non-decreasing in dot product", () => {
    const samples = [-1, -0.5, -0.1, 0, 0.04, 0.1, 0.5, 1].map((z) =>
      frontFacingFactor(new Vector3(0, 0, z), cameraDir),
    );
    for (let i = 1; i < samples.length; i += 1) {
      expect(samples[i]).toBeGreaterThanOrEqual(samples[i - 1]);
    }
  });
});
