// Phase 16 — beta readiness env gate.
//
// Asserts the env-driven config reads conservatively (defaults off where
// it should), accepts common true/false strings, and produces the demo
// banner copy only when explicitly enabled.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getBetaConfig, resetBetaConfigCache } from "@/lib/runtime/betaConfig";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  resetBetaConfigCache();
});

afterEach(() => {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("NEXT_PUBLIC_SPHERE_")) delete process.env[k];
  }
  for (const [k, v] of Object.entries(ORIGINAL_ENV)) {
    if (k.startsWith("NEXT_PUBLIC_SPHERE_") && v) process.env[k] = v;
  }
  resetBetaConfigCache();
});

describe("getBetaConfig", () => {
  it("defaults demo portfolio off and feed health on", () => {
    delete process.env.NEXT_PUBLIC_SPHERE_DEMO_PORTFOLIO;
    delete process.env.NEXT_PUBLIC_SPHERE_FEED_HEALTH;
    delete process.env.NEXT_PUBLIC_SPHERE_SHOW_RUNTIME_HINTS;
    resetBetaConfigCache();
    const config = getBetaConfig();
    expect(config.demoPortfolioEnabled).toBe(false);
    expect(config.feedHealthVisible).toBe(true);
    expect(config.showRuntimeHints).toBe(false);
    expect(config.demoBannerCopy).toBeNull();
  });

  it("emits the demo banner when the public deploy flag is on", () => {
    process.env.NEXT_PUBLIC_SPHERE_DEMO_PORTFOLIO = "true";
    resetBetaConfigCache();
    const config = getBetaConfig();
    expect(config.demoPortfolioEnabled).toBe(true);
    expect(config.demoBannerCopy).toContain("demo");
  });

  it("respects all common true/false spellings", () => {
    for (const truthy of ["1", "true", "yes", "on", "TRUE"]) {
      process.env.NEXT_PUBLIC_SPHERE_DEMO_PORTFOLIO = truthy;
      resetBetaConfigCache();
      expect(getBetaConfig().demoPortfolioEnabled).toBe(true);
    }
    for (const falsy of ["0", "false", "no", "off"]) {
      process.env.NEXT_PUBLIC_SPHERE_DEMO_PORTFOLIO = falsy;
      resetBetaConfigCache();
      expect(getBetaConfig().demoPortfolioEnabled).toBe(false);
    }
  });

  it("can disable the feed-health pill when the env flag is off", () => {
    process.env.NEXT_PUBLIC_SPHERE_FEED_HEALTH = "false";
    resetBetaConfigCache();
    expect(getBetaConfig().feedHealthVisible).toBe(false);
  });
});
