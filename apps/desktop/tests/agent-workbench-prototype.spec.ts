import { expect, test } from "@playwright/test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const prototypeUrl = pathToFileURL(
  resolve(process.cwd(), "../../docs/prototypes/agent-workbench.html"),
).toString();

test("agent triage, selection and theme are interactive", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto(prototypeUrl);

  await expect(page.getByText("Needs attention", { exact: true })).toBeVisible();
  await expect(page.locator("#context")).toBeVisible();

  await page.locator('[data-agent="search"]').click();
  await expect(page.locator("#session-title")).toHaveText("Index external sessions");
  await expect(page.locator('[data-agent="search"]')).toHaveClass(/active/);

  await page.locator("#theme").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});

test("context yields to the conversation at compact desktop width", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 800 });
  await page.goto(prototypeUrl);

  await expect(page.locator("#context")).toBeHidden();
  for (const label of ["Open source", "Hand off", "Continue"]) {
    await expect(page.getByRole("button", { name: label })).toBeVisible();
  }
});

