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

test("global search, navigation and workbench tabs change real prototype state", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto(prototypeUrl);

  await page.keyboard.press("Control+k");
  await expect(page.locator("#search-overlay")).toHaveClass(/open/);
  await page.locator("#search-input").fill("lineage");
  await page.locator('[data-result="graph"]').click();
  await expect(page.locator("#session-title")).toHaveText("Design session lineage");

  await page.locator('[data-nav="workspaces"]').click();
  await expect(page.locator("#session-title")).toHaveText("Workspaces");
  await expect(page.locator(".workspace-card")).toHaveCount(4);

  await page.locator('[data-nav="library"]').click();
  await expect(page.locator("#session-title")).toHaveText("Library");
  await expect(page.locator(".library-card")).toHaveCount(4);

  await page.locator('[data-nav="agents"]').click();
  await page.locator('[data-tab="terminal"]').click();
  await expect(page.locator("#session-title")).toHaveText("PowerShell");
  await page.locator('[data-tab="diff"]').click();
  await expect(page.locator("#session-title")).toHaveText("Working diff");
});

test("message, context, graph and reference-only handoff controls respond", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto(prototypeUrl);

  await page.locator("#composer-input").fill("Continue with the verified fixture only.");
  await page.locator("#send").click();
  await expect(page.locator("#timeline")).toContainText("Continue with the verified fixture only.");

  await page.locator("#open-graph").click();
  await expect(page.locator("#graph-overlay")).toHaveClass(/open/);
  await page.keyboard.press("Escape");
  await expect(page.locator("#graph-overlay")).not.toHaveClass(/open/);

  await page.locator("#handoff").click();
  await page.locator('[data-target="Claude"]').click();
  await page.locator("#handoff-confirm").check();
  await page.locator("#handoff-start").click();
  await expect(page.locator("#lineage")).toContainText("New Claude Session");
  await expect(page.locator("#lineage")).toContainText("awaiting native identity");

  await page.locator("#context-close").click();
  await expect(page.locator("#context")).toHaveClass(/hidden/);
  await page.locator("#context-toggle").click();
  await expect(page.locator("#context")).not.toHaveClass(/hidden/);
});

test("source, continue, collapsible groups and keyboard search have feedback", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto(prototypeUrl);

  const attention = page.locator(".section-label").filter({ hasText: "Needs attention" });
  await attention.click();
  await expect(page.locator('[data-agent="review"]')).toBeHidden();
  await attention.click();
  await expect(page.locator('[data-agent="review"]')).toBeVisible();

  await page.locator("#open-source").click();
  await expect(page.locator('[data-tab="source"]')).toBeVisible();
  await expect(page.locator("#timeline")).toContainText("Session ancestry is never inferred");

  await page.locator('[data-nav="agents"]').click();
  await page.locator("#continue").click();
  await expect(page.locator("#composer-input")).toBeFocused();

  await page.keyboard.press("Control+k");
  await page.locator("#search-input").fill("external");
  await page.locator("#search-input").press("Enter");
  await expect(page.locator("#session-title")).toHaveText("Index external sessions");
});
