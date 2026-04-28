import { test, expect } from "@playwright/test";

test("loads the sphere shell", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByTestId("globe-canvas")).toBeVisible();
  await expect(page.getByTestId("boot-gate")).toBeHidden({ timeout: 20000 });
  await expect(page.getByTestId("investigation-workspace")).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId("hero-section")).toBeVisible();
  await expect(page.getByTestId("intelligence-search")).toBeVisible();
  await expect(page.getByRole("button", { name: /^flights$/i })).toBeVisible();

  await page.getByLabel("AI Search").fill("France");
  await page.getByRole("button", { name: /^run investigation$/i }).click();
  await expect(page.getByText(/resolved france/i)).toBeVisible();
});
