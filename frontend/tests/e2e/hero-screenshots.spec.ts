/**
 * Phase 19C.4 — Hero composition screenshot harness.
 *
 * Captures the launch-grade framings reviewers actually look at so a
 * regression in cloud visibility, starfield, sun glare, or panel
 * composition is caught without manual eyeballing.
 *
 * Run with: corepack pnpm test:e2e -- tests/e2e/hero-screenshots.spec.ts
 *
 * The first run records a baseline under
 *   tests/e2e/hero-screenshots.spec.ts-snapshots/
 * Subsequent runs diff against that baseline. Update with
 *   corepack pnpm test:e2e -- --update-snapshots
 */
import { expect, test } from "@playwright/test";

const COMMON_QUERY = "?quality=high";

interface HeroScene {
  name: string;
  url: string;
  snapshot: string;
  /** Optional inline action like running a search before capture. */
  prepare?: (page: import("@playwright/test").Page) => Promise<void>;
}

const SCENES: HeroScene[] = [
  {
    name: "default-launch",
    url: COMMON_QUERY,
    snapshot: "hero-default-launch.png",
  },
  {
    name: "atlantic-americas",
    url: `${COMMON_QUERY}&hero=atlantic`,
    snapshot: "hero-atlantic-americas.png",
  },
  {
    name: "africa-middle-east",
    url: `${COMMON_QUERY}&hero=africa`,
    snapshot: "hero-africa-middle-east.png",
  },
  {
    name: "asia-night",
    url: `${COMMON_QUERY}&hero=asia-night`,
    snapshot: "hero-asia-night.png",
  },
  {
    name: "north-pole",
    url: `${COMMON_QUERY}&hero=north-pole`,
    snapshot: "hero-north-pole.png",
  },
  {
    name: "south-pole",
    url: `${COMMON_QUERY}&hero=south-pole`,
    snapshot: "hero-south-pole.png",
  },
];

test.describe.configure({ timeout: 90_000 });

for (const scene of SCENES) {
  test(`hero: ${scene.name}`, async ({ page }) => {
    await page.goto(`/${scene.url}`);

    // Workspace boot sequence — wait for the chrome to be alive before
    // capturing so we are not screenshotting a black canvas.
    await expect(page.getByTestId("globe-canvas")).toBeVisible();
    await page.waitForTimeout(2_500);

    if (scene.prepare) {
      await scene.prepare(page);
      await page.waitForTimeout(1_500);
    }

    const screenshot = await page.screenshot({
      animations: "disabled",
      fullPage: false,
    });
    expect(screenshot).toMatchSnapshot(scene.snapshot, {
      // Tolerate small frame-to-frame variance in the live cloud
      // advection and starfield additive jitter.
      maxDiffPixels: 250_000,
    });
  });
}
