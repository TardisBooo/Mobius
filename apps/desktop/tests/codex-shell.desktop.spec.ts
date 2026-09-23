import { chromium, expect, test, type Browser, type Page } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const endpoint = process.env.MOBIUS_CODEX_SHELL_CDP!;
const auditRoot = process.env.MOBIUS_AUDIT_ROOT!;
const fixtureDirectory = join(auditRoot, "workspace");
const fixtureFile = join(fixtureDirectory, "memo.txt");

async function appPage(browser: Browser): Promise<Page> {
  const page = browser.contexts().flatMap((context) => context.pages()).find((candidate) => candidate.url().includes("tauri.localhost"));
  if (!page) throw new Error("No isolated Möbius Tauri WebView page");
  await page.evaluate(() => {
    localStorage.setItem("mobius.onboarding.complete", "1");
    localStorage.setItem("mobius.page", "sessions");
    localStorage.setItem("mobius.sidebar.open", "1");
    for (const key of Object.keys(localStorage)) if (key.startsWith("mobius.sessions.expanded.")) localStorage.removeItem(key);
  });
  await page.reload();
  return page;
}

test("project/session shell and keyboard search use one navigation surface", async () => {
  const browser = await chromium.connectOverCDP(endpoint);
  try {
    const page = await appPage(browser);
    await expect(page.locator(".project-sidebar")).toBeVisible();
    await expect(page.locator(".session-library-embedded")).toBeVisible();
    await expect(page.locator(".session-results-v2")).toBeHidden();
    await expect(page.locator(".project-sidebar-nav .rail-item")).toHaveCount(2);
    await page.keyboard.press("Control+k");
    await expect(page.locator(".project-sidebar-search input")).toBeFocused();
    await page.locator(".project-sidebar-search input").fill("a nonmatching test query");
    await expect(page.locator(".project-sidebar-section").first()).toContainText(/搜索结果|Results/);
    await page.locator(".project-sidebar-search input").fill("");
  } finally { await browser.close(); }
});

test("sidebar, project detail, folded messages and library round-trip", async () => {
  const browser = await chromium.connectOverCDP(endpoint);
  try {
    const page = await appPage(browser);
    await page.getByRole("button", { name: /收起侧栏|Collapse sidebar/ }).click();
    await expect(page.locator(".project-sidebar")).toBeHidden();
    await page.keyboard.press("Control+k");
    await expect(page.locator(".project-sidebar")).toBeVisible();
    await expect(page.locator(".project-sidebar-search input")).toBeFocused();
    await page.getByRole("button", { name: /收起侧栏|Collapse sidebar/ }).click();
    await page.locator(".global-search").click();
    await expect(page.locator(".project-sidebar")).toBeVisible();
    await expect(page.locator(".project-sidebar-search input")).toBeFocused();

    const project = page.locator(".project-sidebar-open").first();
    await expect(project).toBeVisible();
    await project.click();
    await expect(page.locator(".project-context-view")).toBeVisible();
    await expect(page.locator(".recent-workspace-grid")).toHaveCount(0);

    await page.locator(".project-sidebar-nav .rail-item").filter({ hasText: /会话|Sessions/ }).click();
    const session = page.locator(".project-session-link").first();
    await expect(session).toBeVisible();
    await session.click();
    await expect(page.locator(".message-stream-v2 .message-fold-trigger").first()).toBeVisible();
    const folded = page.locator(".message-stream-v2 article").first();
    await expect(folded).toHaveClass(/collapsed/);
    await folded.locator(".message-fold-trigger").click();
    await expect(folded).toHaveClass(/expanded/);
    await expect(folded.locator(".session-message-body")).toBeVisible();

    await page.locator(".project-sidebar-nav .rail-item").filter({ hasText: /资料与画布|Library & canvas/ }).click();
    await expect(page.locator(".notes-library-v2")).toBeVisible();
    await expect(page.locator(".project-sidebar")).toBeVisible();
    await page.locator(".project-sidebar-nav .rail-item").filter({ hasText: /会话|Sessions/ }).click();
    await expect(page.locator(".session-library-embedded")).toBeVisible();
  } finally { await browser.close(); }
});

test("writable mount saves explicitly and refuses an external conflict", async () => {
  writeFileSync(fixtureFile, "first line\nsecond line\n", "utf8");
  const browser = await chromium.connectOverCDP(endpoint);
  try {
    const page = await appPage(browser);
    await page.locator(".project-sidebar-nav .rail-item").filter({ hasText: /资料与画布|Library & canvas/ }).click();
    await expect(page.locator(".notes-library-v2")).toBeVisible();
    expect(await page.locator(".notes-library-v2").evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThan(500);
    const [tree, splitter, editor] = await Promise.all([
      page.locator(".notes-nav-v2").boundingBox(),
      page.locator(".notes-library-splitter").boundingBox(),
      page.locator(".note-editor-v2").boundingBox(),
    ]);
    expect(tree && splitter && editor).toBeTruthy();
    expect(splitter!.x - (tree!.x + tree!.width)).toBeLessThan(2);
    expect(editor!.x - (splitter!.x + splitter!.width)).toBeLessThan(2);
    expect(editor!.width).toBeGreaterThan(500);
    await expect(page.locator(".project-sidebar")).toBeVisible();
    if (await page.locator(".library-mount-branch").filter({ hasText: "Fixture" }).count() === 0) {
      await page.locator("button[title='挂载目录'],button[title='Mount folder']").click();
      const dialog = page.locator(".mobius-modal");
      await dialog.locator("input").nth(0).fill(fixtureDirectory);
      await dialog.locator("input").nth(1).fill("Fixture");
      await dialog.locator("select").selectOption("read_write");
      await dialog.locator("button.primary-button").click();
    }
    await page.locator(".library-mount-branch").filter({ hasText: "Fixture" }).locator(".library-tree-file").filter({ hasText: "memo" }).click();
    await expect(page.locator(".cm-content")).toContainText("first line");
    await page.locator(".cm-content").fill("edited in Möbius");
    await page.waitForTimeout(750);
    expect(readFileSync(fixtureFile, "utf8")).toContain("first line");
    await page.locator(".note-editor-v2>header .primary-button").click();
    await expect.poll(() => readFileSync(fixtureFile, "utf8")).toContain("edited in Möbius");
    await page.locator(".cm-content").fill("unsaved working copy");
    writeFileSync(join(fixtureDirectory, "added.txt"), "new file\n", "utf8");
    await expect(page.locator(".library-mount-branch .library-tree-file").filter({ hasText: "added" })).toBeVisible();
    writeFileSync(fixtureFile, "external edit\n", "utf8");
    await page.locator(".note-editor-v2>header .primary-button").click();
    await expect(page.getByText(/文件在外部发生变化|File changed outside Möbius/)).toBeVisible();
    expect(readFileSync(fixtureFile, "utf8")).toContain("external edit");
    await page.locator(".mobius-modal button").first().click();
    await page.locator(".project-sidebar-nav button").filter({ hasText: /设置|Settings/ }).click();
    await expect(page.locator(".page-settings")).toBeVisible();
    await page.locator(".project-sidebar-nav .rail-item").filter({ hasText: /资料与画布|Library & canvas/ }).click();
    await expect(page.locator(".cm-content")).toContainText("unsaved working copy");
  } finally { await browser.close(); }
});
