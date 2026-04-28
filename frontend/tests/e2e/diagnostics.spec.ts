import { expect, test } from "@playwright/test";

const DIAGNOSTIC_VIEWS = [
  { view: "earth", snapshot: "diagnostics-earth.png" },
  { view: "borders", snapshot: "diagnostics-borders.png" },
  { view: "dots", snapshot: "diagnostics-dots.png" },
  { view: "full", snapshot: "diagnostics-full.png" },
] as const;

test.describe.configure({ timeout: 60000 });

for (const entry of DIAGNOSTIC_VIEWS) {
  test(`captures ${entry.view} diagnostics scene`, async ({ page }) => {
    await page.goto(`/?diagnostics=1&seed=ci&quality=medium&diagnosticsView=${entry.view}`);

    await expect(page.getByTestId("globe-canvas")).toBeVisible();
    await expect(page.getByTestId("boot-gate")).toBeHidden({ timeout: 30000 });
    await expect(page.getByTestId("hud-top-bar")).toBeVisible({ timeout: 15000 });
    await page.waitForTimeout(600);

    const screenshot = await page.getByTestId("globe-canvas").screenshot({
      animations: "disabled",
      timeout: 15000,
    });
    expect(screenshot).toMatchSnapshot(entry.snapshot, {
      maxDiffPixels: 100000,
    });
  });
}
