import { chromium, expect, test, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const cdp = process.env.MOBIUS_CDP ?? "http://127.0.0.1:9374";
const dragDemo = "E:/Workspaces/_verification/mobius-full-20260915/runs/provider-001/drag-demo";
const skillSource = `${dragDemo}/.codex/skills/drag-private-source/SKILL.md`;
const fixtures = [
  "E:/Workspaces/_verification/mobius-full-20260915/runs/drag-demo-lineage-001/harness/codex/sessions/round-1-codex.jsonl",
  skillSource,
];
const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

async function pageFromCdp(): Promise<Page> {
  const browser = await chromium.connectOverCDP(cdp);
  const page = browser.contexts()[0]?.pages()[0];
  if (!page) throw new Error("Möbius WebView page is unavailable");
  page.setDefaultTimeout(20_000);
  return page;
}

test("checklist: expand checkouts, unique dialog cancel, graph tab, canvas reopen, source round-trip", async () => {
  const before = Object.fromEntries(fixtures.filter((path) => existsSync(path)).map((path) => [path, sha256(path)]));
  const page = await pageFromCdp();
  await page.bringToFront();
  await page.evaluate(() => {
    localStorage.setItem("mobius.onboarding.complete", "1");
    localStorage.setItem("mydesk.locale.v2", "en");
    localStorage.setItem("mobius.theme", "dark");
  });
  await page.reload();
  await page.waitForLoadState("domcontentloaded");

  await page.locator(".mobius-rail .rail-item").nth(1).click();
  await expect(page.locator(".workspace-atlas")).toBeVisible();
  await page.locator(".atlas-project-button").filter({ hasText: "drag-demo" }).first().click();
  await expect(page.locator(".atlas-checkouts button").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Handoff graph", exact: true })).toBeVisible();
  await expect(page.locator(".project-session-row")).toHaveCount(5, { timeout: 30_000 });

  await page.getByRole("button", { name: "Add workspace" }).click();
  const addDialog = page.locator(".mobius-modal");
  await expect(addDialog.getByRole("button", { name: "Close dialog" })).toHaveCount(1);
  await expect(addDialog.getByRole("button", { name: "Cancel", exact: true })).toHaveCount(1);
  await addDialog.locator("input").fill("E:\\__mobius_missing_dir__");
  await addDialog.getByRole("button", { name: "Register workspace" }).click();
  await expect(page.locator(".mobius-notice.error")).toBeVisible();
  await page.locator(".mobius-notice.error").getByRole("button", { name: "Dismiss" }).click();
  await addDialog.getByRole("button", { name: "Cancel", exact: true }).click();

  await page.getByRole("button", { name: "Handoff graph", exact: true }).click();
  await expect(page.locator(".react-flow__node.lineage-node").first()).toBeVisible();
  await page.getByRole("button", { name: "Preview settings" }).click();
  const settings = page.locator(".lineage-settings-popover");
  await settings.getByLabel("Graph layout").selectOption("vertical");
  await settings.locator("label").filter({ hasText: "Compact nodes" }).locator("input").check();
  await page.reload();
  await page.locator(".mobius-rail .rail-item").nth(1).click();
  await page.locator(".atlas-project-button").filter({ hasText: "drag-demo" }).first().click();
  await page.getByRole("button", { name: "Handoff graph", exact: true }).click();
  await expect.poll(() => page.evaluate(() => localStorage.getItem("mobius.lineage.direction"))).toBe("vertical");

  await page.locator(".mobius-rail .rail-item").nth(0).click();
  await expect(page.locator(".session-list-row")).toHaveCount(5, { timeout: 40_000 });
  await page.getByRole("button", { name: "Sources" }).click();
  const sources = page.getByRole("dialog", { name: "Session sources" });
  await expect(sources.locator(".source-list").first().locator("article")).toHaveCount(5);
  const grok = sources.locator(".source-list article").filter({ hasText: "Grok" }).first();
  const grokPath = (await grok.locator("code").innerText()).trim();
  await grok.locator("[aria-label*='Remove source']").click();
  await expect(sources.locator(".source-list").first().locator("article")).toHaveCount(4, { timeout: 30_000 });
  await sources.locator("select[aria-label='Agent provider']").selectOption("grok");
  await sources.locator(".source-add input").fill(grokPath);
  await sources.getByRole("button", { name: "Add source" }).click();
  await expect(sources.locator(".source-list").first().locator("article")).toHaveCount(5, { timeout: 40_000 });
  await sources.getByRole("button", { name: "Close" }).click();

  await page.locator(".mobius-rail .rail-item").nth(2).click();
  await expect(page.locator(".notes-library-v2")).toBeVisible();
  await page.locator(".library-create-button").click();
  await page.getByRole("menuitem").filter({ hasText: "New canvas" }).click();
  const board = page.locator(".mobius-board");
  await expect(board).toBeVisible();
  await board.locator("[aria-label='Canvas title']").fill("Checklist Canvas");
  await board.locator(".board-toolbar [aria-label='Sticky note (N)']").click();
  await board.locator(".react-flow__pane").click({ position: { x: 280, y: 220 } });
  await expect(page.locator(".react-flow__node")).toHaveCount(1, { timeout: 8_000 });
  await board.getByRole("button", { name: "Back to Library" }).click();
  await expect(page.locator(".library-tree-file").filter({ hasText: "Checklist Canvas" })).toBeVisible({ timeout: 10_000 });
  await page.locator(".library-tree-file").filter({ hasText: "Checklist Canvas" }).first().click();
  await expect(page.locator(".mobius-board")).toBeVisible();
  await expect(page.locator(".react-flow__node")).toHaveCount(1, { timeout: 10_000 });

  const after = Object.fromEntries(fixtures.filter((path) => existsSync(path)).map((path) => [path, sha256(path)]));
  expect(after).toEqual(before);
  expect(existsSync(resolve(dragDemo, ".agents/skills/drag-private-source"))).toBeFalsy();
});
