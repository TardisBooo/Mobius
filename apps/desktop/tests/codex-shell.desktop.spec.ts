import { chromium, expect, test, type Browser, type Page } from "@playwright/test";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
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

test("first-run guide opens, closes with Escape and can be reopened", async () => {
  const browser = await chromium.connectOverCDP(endpoint);
  try {
    const page = await appPage(browser);
    await page.evaluate(() => localStorage.removeItem("mobius.onboarding.complete"));
    await page.reload();
    await expect(page.locator(".onboarding")).toBeVisible();
    await expect(page.locator(".onboarding .onboarding-progress button")).toHaveCount(6);
    await page.keyboard.press("Escape");
    await expect(page.locator(".onboarding")).toHaveCount(0);
    await page.getByRole("button", { name: "Open Möbius guide" }).click();
    await expect(page.locator(".onboarding")).toBeVisible();
    await page.keyboard.press("Escape");
    await page.evaluate(() => localStorage.setItem("mobius.onboarding.complete", "1"));
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
    await expect(page.locator(".message-stream-v2 article.collapsed")).toHaveCount(await page.locator(".message-stream-v2 article").count());
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

test("source management and memory search remain reachable from the unified session page", async () => {
  const browser = await chromium.connectOverCDP(endpoint);
  try {
    const page = await appPage(browser);
    await page.locator(".project-sidebar-nav button").filter({ hasText: /技能|Skills/ }).click();
    await page.getByRole("button", { name: /管理会话来源|Manage session sources/ }).click();
    await expect(page.locator(".session-sources-dialog")).toBeVisible();
    await expect(page.locator(".session-sources-dialog .source-list").first()).toBeVisible();
    await page.locator(".mobius-modal").getByRole("button", { name: /关闭|Close/ }).first().click();
    await page.locator(".project-sidebar-nav button").filter({ hasText: /资料与画布|Library & canvas/ }).click();
    await page.getByRole("button", { name: /查找相关记忆|Find related memory/ }).click();
    await expect(page.locator(".mome-dialog .mome-query input")).toBeVisible();
    await page.locator(".mome-dialog .mome-query input").fill("academy.viewatom.com");
    await expect(page.locator(".mome-dialog .modal-actions .primary-button")).toBeEnabled();
    await page.locator(".mome-dialog .modal-actions .primary-button").click();
    await expect(page.locator(".mome-result")).toBeVisible({ timeout: 12_000 });
    await page.locator(".mome-dialog .modal-actions .soft-button").click();
    await expect(page.locator(".mome-dialog")).toHaveCount(0);
  } finally { await browser.close(); }
});

test("approved Codex source can be added, indexed and removed without altering its transcript", async () => {
  test.setTimeout(120_000);
  const sourceRoot = join(auditRoot, "harness", "codex", "sessions");
  const transcript = join(sourceRoot, "qa-synthetic.jsonl");
  const original = readFileSync(transcript, "utf8");
  const browser = await chromium.connectOverCDP(endpoint);
  let page: Page | null = null;
  try {
    page = await appPage(browser);
    await page.getByRole("button", { name: /管理会话来源|Manage session sources/ }).click();
    const dialog = page.locator(".session-sources-dialog");
    const approved = dialog.locator(".source-list").first();
    await expect(approved.locator("article")).toHaveCount(5);
    const before = await approved.locator("article").count();
    await dialog.locator(".source-add select").selectOption("codex");
    await dialog.locator(".source-add input").fill(sourceRoot);
    await dialog.locator(".source-add .primary-button").click();
    await expect(approved.locator("article")).toHaveCount(before + 1, { timeout: 40_000 });
    const added = approved.locator("article").filter({ hasText: sourceRoot });
    await expect(added).toBeVisible();
    await expect.poll(async () => page.evaluate(async () => {
      const hits = await (window as unknown as { __TAURI_INTERNALS__: { invoke: (command: string, args: object) => Promise<Array<{ session: { title: string } }>> } }).__TAURI_INTERNALS__.invoke("query_sessions", { query: { query: "SOURCE_MANAGER_QA", workspace_id: null, checkout_id: null, providers: [], limit: 20 } });
      return hits.some((hit) => hit.session.title.includes("SOURCE_MANAGER_QA"));
    }), { timeout: 15_000 }).toBe(true);
    await added.locator("button[aria-label^='移除来源'],button[aria-label^='Remove source']").click();
    await expect(approved.locator("article")).toHaveCount(before, { timeout: 40_000 });
    expect(readFileSync(transcript, "utf8")).toBe(original);
  } finally {
    if (page) await page.evaluate(async (path) => {
      const invoke = (window as unknown as { __TAURI_INTERNALS__: { invoke: (command: string, args?: object) => Promise<unknown> } }).__TAURI_INTERNALS__.invoke;
      const sources = await invoke("list_approved_session_sources") as { roots: Array<{ agent: string; path: string }> };
      if (sources.roots.some((root) => root.agent === "codex" && root.path.replace(/^\\\\\?\\/, "").toLowerCase() === path.toLowerCase())) {
        await invoke("remove_approved_session_source", { agent: "codex", path });
      }
    }, sourceRoot).catch(() => undefined);
    await browser.close();
  }
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
    const liveName = `live-added-${Date.now()}.txt`;
    const liveFile = join(fixtureDirectory, liveName);
    writeFileSync(liveFile, "new file\n", "utf8");
    await expect(page.locator(".library-mount-branch .library-tree-file").filter({ hasText: liveName.replace(/\.txt$/, "") })).toBeVisible();
    unlinkSync(liveFile);
    await expect(page.locator(".library-mount-branch .library-tree-file").filter({ hasText: liveName.replace(/\.txt$/, "") })).toHaveCount(0);
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

test("private note can be created, previewed, revisited, trashed and restored", async () => {
  test.setTimeout(90_000);
  const browser = await chromium.connectOverCDP(endpoint);
  const title = `Acceptance note ${Date.now()}`;
  try {
    const page = await appPage(browser);
    page.on("dialog", (dialog) => void dialog.accept());
    await page.locator(".project-sidebar-nav .rail-item").filter({ hasText: /资料与画布|Library & canvas/ }).click();
    await page.locator(".library-create-button").click();
    await page.getByRole("menuitem").filter({ hasText: /新建笔记|New note/ }).click();
    await page.locator(".note-editor-v2 > header input").fill(title);
    await page.locator(".cm-content").fill("# Acceptance heading\n\nA saved private note.");
    await page.locator(".note-editor-v2 > header .primary-button").click();
    const row = page.locator(".library-tree-file").filter({ hasText: title });
    await expect(row).toBeVisible();
    await page.locator(".note-view-switch button").filter({ hasText: /预览|Preview/ }).click();
    await expect(page.locator(".markdown-preview h1")).toHaveText("Acceptance heading");
    await page.locator(".project-sidebar-nav .rail-item").filter({ hasText: /会话|Sessions/ }).click();
    await page.locator(".project-sidebar-nav .rail-item").filter({ hasText: /资料与画布|Library & canvas/ }).click();
    await expect(page.locator(".note-editor-v2 > header input")).toHaveValue(title);
    await row.click({ button: "right" });
    await page.getByRole("menuitem").filter({ hasText: /移入回收站|Move to trash/ }).click();
    await expect(row).toHaveCount(0);
    const trashed = page.locator(".library-trash-item").filter({ hasText: title });
    await expect(trashed).toBeVisible();
    await trashed.locator("button").click();
    await expect(page.locator(".library-tree-file").filter({ hasText: title })).toBeVisible();
  } finally { await browser.close(); }
});

test("canvas object persists after leaving and reopening its tab", async () => {
  test.setTimeout(90_000);
  const browser = await chromium.connectOverCDP(endpoint);
  const title = `Acceptance canvas ${Date.now()}`;
  try {
    const page = await appPage(browser);
    await page.locator(".project-sidebar-nav .rail-item").filter({ hasText: /资料与画布|Library & canvas/ }).click();
    await page.locator(".library-create-button").click();
    await page.getByRole("menuitem").filter({ hasText: /新建画布|New canvas/ }).click();
    const board = page.locator(".mobius-board");
    await expect(board).toBeVisible();
    await board.locator("input[aria-label='画布标题'],input[aria-label='Canvas title']").fill(title);
    await board.locator(".board-toolbar button[aria-label='随笔 (N)'],.board-toolbar button[aria-label='Sticky note (N)']").click();
    await board.locator(".react-flow__pane").click({ position: { x: 250, y: 180 } });
    await expect(board.locator(".react-flow__node")).toHaveCount(1);
    await board.locator(".board-save").click();
    await board.getByRole("button", { name: /返回资料库|Back to Library/ }).click();
    const row = page.locator(".library-tree-file").filter({ hasText: title });
    await expect(row).toBeVisible();
    await row.click();
    await expect(page.locator(".mobius-board .react-flow__node")).toHaveCount(1);
  } finally { await browser.close(); }
});

test("skill market and project-private installed skills are distinct", async () => {
  test.setTimeout(60_000);
  const browser = await chromium.connectOverCDP(endpoint);
  try {
    const page = await appPage(browser);
    await page.locator(".project-sidebar-nav button").filter({ hasText: /技能|Skills/ }).click();
    await expect(page.locator(".skills-library-v2")).toBeVisible();
    await expect(page.locator(".skills-segment").first().locator("button.active")).toContainText(/技能市场|Skill market/);
    await expect.poll(async () => page.locator(".marketplace-card-v2,.market-error-v2").count(), { timeout: 35_000 }).toBeGreaterThan(0);
    if (await page.locator(".market-error-v2").count()) {
      await expect(page.locator(".market-error-v2 button")).toContainText(/重试|Retry/);
      await expect(page.locator(".market-error-v2 a")).toHaveAttribute("href", "https://agentskill.sh/");
    } else {
      const firstCard = page.locator(".marketplace-card-v2").first();
      const fits = await firstCard.evaluate((card) => {
        const bounds = card.getBoundingClientRect();
        const actions = [...card.querySelectorAll<HTMLElement>("footer .soft-button")];
        return bounds.width >= 310 && actions.length === 3 && actions.every((action) => {
          const rect = action.getBoundingClientRect();
          return rect.height <= 36 && action.scrollWidth <= action.clientWidth + 1
            && rect.left >= bounds.left && rect.right <= bounds.right;
        });
      });
      expect(fits, "marketplace action labels should fit inside their cards").toBe(true);
    }
    await page.locator(".skills-segment").first().locator("button").filter({ hasText: /已安装|Installed/ }).click();
    await page.locator(".skills-segment").nth(1).locator("button").filter({ hasText: /项目|Project/ }).click();
    const checkout = page.locator(".skills-checkout-select select");
    const fixtureOption = checkout.locator("option").filter({ hasText: "mobius-codex-shell-20260923\\workspace" });
    await checkout.selectOption(await fixtureOption.getAttribute("value") ?? "");
    const skill = page.locator(".skill-card-v2").filter({ hasText: "qa-private" });
    await expect(skill).toBeVisible();
    await expect(skill).toContainText(/project/);
    await skill.locator("button").filter({ hasText: /查看|View/ }).click();
    await expect(page.locator(".skill-drawer-v2")).toContainText("Isolated project-private skill fixture");
  } finally { await browser.close(); }
});

test("project-private skill managed copy installs and uninstalls without changing its source", async () => {
  test.setTimeout(90_000);
  const source = join(fixtureDirectory, ".codex", "skills", "qa-private", "SKILL.md");
  const destination = join(fixtureDirectory, ".agents", "skills", "qa-private", "SKILL.md");
  const original = readFileSync(source, "utf8");
  const browser = await chromium.connectOverCDP(endpoint);
  try {
    const page = await appPage(browser);
    await page.locator(".project-sidebar-nav button").filter({ hasText: /技能|Skills/ }).click();
    await page.locator(".skills-segment").first().locator("button").filter({ hasText: /已安装|Installed/ }).click();
    await page.locator(".skills-segment").nth(1).locator("button").filter({ hasText: /项目|Project/ }).click();
    const checkout = page.locator(".skills-checkout-select select");
    const checkoutId = await checkout.locator("option").filter({ hasText: "mobius-codex-shell-20260923\\workspace" }).getAttribute("value");
    await checkout.selectOption(checkoutId!);
    await page.locator(".skills-target-select select").selectOption(`project:${checkoutId}`);
    await page.locator(".skill-card-v2").filter({ hasText: "qa-private" }).first().locator("button").filter({ hasText: /查看|View/ }).click();
    await page.locator(".skill-drawer-v2 footer button").filter({ hasText: /创建可编辑副本|Create editable copy/ }).click();
    await expect(page.locator(".skill-confirm-v2 code")).toContainText("qa-private");
    await page.locator(".skill-confirm-v2 .primary-button").click();
    await expect.poll(() => existsSync(destination)).toBe(true);
    expect(readFileSync(source, "utf8")).toBe(original);
    await page.locator(".skill-drawer-v2 footer button").filter({ hasText: /打开受管副本|Open managed copy/ }).click();
    await page.locator(".skill-drawer-v2 footer button").filter({ hasText: /卸载受管副本|Uninstall managed copy/ }).click();
    await page.locator(".skill-confirm-v2 .danger-button").click();
    await expect.poll(() => existsSync(destination)).toBe(false);
    expect(readFileSync(source, "utf8")).toBe(original);
  } finally { await browser.close(); }
});

test("new PowerShell uses the selected project directory and remains interactive", async () => {
  test.setTimeout(60_000);
  const browser = await chromium.connectOverCDP(endpoint);
  const marker = `MOBIUS_TERMINAL_${Date.now()}`;
  try {
    const page = await appPage(browser);
    await page.locator(".project-sidebar-search input").fill("qa-isolated");
    await page.locator(".project-sidebar-section .project-sidebar-project").filter({ hasText: "qa-isolated" }).click();
    await page.getByRole("button", { name: /新建 PowerShell|New PowerShell/ }).click();
    await expect(page.locator(".terminal-tab")).toHaveCount(1);
    const terminal = await page.evaluate(async () => {
      const terminals = await (window as unknown as { __TAURI_INTERNALS__: { invoke: (command: string) => Promise<Array<{ id: string; cwd: string }>> } }).__TAURI_INTERNALS__.invoke("terminal_list");
      return terminals.at(-1);
    });
    expect(terminal?.cwd.toLowerCase()).toBe(fixtureDirectory.toLowerCase());
    await page.evaluate(async ({ id, marker }) => {
      await (window as unknown as { __TAURI_INTERNALS__: { invoke: (command: string, args: Record<string, string>) => Promise<void> } }).__TAURI_INTERNALS__.invoke("terminal_write", { id, data: `Write-Output ${marker}\r` });
    }, { id: terminal!.id, marker });
    await expect.poll(async () => page.evaluate(async (id) => {
      const snapshot = await (window as unknown as { __TAURI_INTERNALS__: { invoke: (command: string, args: Record<string, string>) => Promise<{ data: string }> } }).__TAURI_INTERNALS__.invoke("terminal_snapshot", { id });
      return snapshot.data;
    }, terminal!.id), { timeout: 15_000 }).toContain(marker);
    await page.locator(".terminal-tab-close").click();
    await expect(page.locator(".terminal-tab")).toHaveCount(0);
  } finally { await browser.close(); }
});

test("all primary routes keep named controls and fit the compact desktop viewport", async () => {
  test.setTimeout(60_000);
  const browser = await chromium.connectOverCDP(endpoint);
  try {
    const page = await appPage(browser);
    const original = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    await page.setViewportSize({ width: 1100, height: 720 });
    for (const route of [/会话|Sessions/, /资料与画布|Library & canvas/, /技能|Skills/, /设置|Settings/]) {
      await page.locator(".project-sidebar-nav button").filter({ hasText: route }).click();
      const audit = await page.evaluate(() => {
        const root = document.querySelector<HTMLElement>(".mobius-app")!;
        const unnamed = [...root.querySelectorAll<HTMLElement>("button, input, select, textarea")].filter((control) => {
          const rect = control.getBoundingClientRect();
          const style = getComputedStyle(control);
          if (rect.width < 1 || rect.height < 1 || style.display === "none" || style.visibility === "hidden") return false;
          return !(control.getAttribute("aria-label")?.trim() || control.getAttribute("title")?.trim() || control.getAttribute("placeholder")?.trim() || control.textContent?.trim());
        }).map((control) => control.outerHTML.slice(0, 160));
        return { overflow: root.scrollWidth - root.clientWidth, unnamed };
      });
      expect(audit.overflow).toBeLessThanOrEqual(2);
      expect(audit.unnamed).toEqual([]);
    }
    const previousTheme = await page.evaluate(() => localStorage.getItem("mobius.theme"));
    await page.getByRole("button", { name: "Switch theme" }).click();
    const changedTheme = await page.evaluate(() => localStorage.getItem("mobius.theme"));
    expect(changedTheme).not.toBe(previousTheme);
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", changedTheme!);
    await page.getByRole("button", { name: "Switch theme" }).click();
    const previousLocale = await page.evaluate(() => localStorage.getItem("mobius.locale.v2"));
    await page.getByRole("button", { name: "Switch language" }).click();
    const changedLocale = await page.evaluate(() => localStorage.getItem("mobius.locale.v2"));
    expect(changedLocale).not.toBe(previousLocale);
    await page.reload();
    await expect(page.locator(".project-sidebar-nav")).toContainText(changedLocale === "en" ? "Sessions" : "会话");
    await page.getByRole("button", { name: "Switch language" }).click();
    await page.setViewportSize(original);
  } finally { await browser.close(); }
});

test("agentTect shows only root sessions with time, harness and checkout", async () => {
  const browser = await chromium.connectOverCDP(endpoint);
  try {
    const page = await appPage(browser);
    const group = page.locator(".project-sidebar-group").filter({ has: page.locator(".project-sidebar-open").filter({ hasText: "agentTect" }) }).first();
    const disclosure = group.locator(".project-sidebar-disclosure");
    if (await disclosure.getAttribute("aria-expanded") === "false") await disclosure.click();
    await expect(group.locator(".project-session-link")).toHaveCount(7);
    const metadata = await group.locator(".project-session-link small").first().innerText();
    expect(metadata).toMatch(/\d{1,2}\/\d{1,2}.*grok.*agentTect/i);
    await group.locator(".project-sidebar-child-toggle").click();
    await expect(group.locator(".project-session-link")).toHaveCount(54);
  } finally { await browser.close(); }
});

test("project recency follows session activity instead of index refresh time", async () => {
  const browser = await chromium.connectOverCDP(endpoint);
  try {
    const page = await appPage(browser);
    await page.locator(".project-sidebar-section button[title='按名称排序'],.project-sidebar-section button[title='Sort by name']").count().then(async (count) => {
      if (count) await page.locator(".project-sidebar-section button[title='按名称排序'],.project-sidebar-section button[title='Sort by name']").click();
    });
    const workspaces = await page.evaluate(async () => (window as unknown as { __TAURI_INTERNALS__: { invoke: (command: string) => Promise<Array<{ workspace: { id: string; canonical_path: string; created_at: string }; latest_session_at?: string }>> } }).__TAURI_INTERNALS__.invoke("list_workspaces_v2"));
    const expected = [...workspaces].sort((a, b) => (Date.parse(b.latest_session_at ?? b.workspace.created_at) || 0) - (Date.parse(a.latest_session_at ?? a.workspace.created_at) || 0) || a.workspace.id.localeCompare(b.workspace.id)).slice(0, 5).map((item) => item.workspace.canonical_path.toLowerCase());
    const visibleOrder = (await page.locator(".project-sidebar-open").evaluateAll((items) => items.slice(0, 5).map((item) => (item.getAttribute("title") ?? "").toLowerCase())));
    expect(visibleOrder).toEqual(expected);
  } finally { await browser.close(); }
});

test("sidebar content search opens the exact matching message", async () => {
  const browser = await chromium.connectOverCDP(endpoint);
  try {
    const page = await appPage(browser);
    const marker = "CLAUDE55_DEFAULT_1M_OK";
    await page.locator(".project-sidebar-search input").fill(marker);
    const result = page.locator(".project-sidebar-section .project-session-link").filter({ hasText: marker }).first();
    await expect(result).toBeVisible();
    await result.click();
    await expect(page.locator(".session-reader-v2 h2")).toContainText(marker);
    await expect(page.locator(".message-stream-v2 article.selected.expanded")).toContainText(marker);
  } finally { await browser.close(); }
});

test("session alias can be edited without losing its searchable native history", async () => {
  const browser = await chromium.connectOverCDP(endpoint);
  try {
    const page = await appPage(browser);
    await page.locator(".project-sidebar-search input").fill("SOURCE_MANAGER_QA");
    const row = page.locator(".project-sidebar-section .project-session-link").first();
    await expect(row).toBeVisible();
    const original = await row.locator("strong").innerText();
    const alias = `Audit alias ${Date.now()}`;
    await row.click({ button: "right" });
    await page.getByRole("menuitem").filter({ hasText: /重命名会话|Rename session/ }).click();
    await page.locator(".project-rename-dialog input").fill(alias);
    await page.locator(".project-rename-dialog .primary-button").click();
    await expect(row.locator("strong")).toHaveText(alias);
    await row.click({ button: "right" });
    await page.getByRole("menuitem").filter({ hasText: /重命名会话|Rename session/ }).click();
    await page.locator(".project-rename-dialog input").fill(original);
    await page.locator(".project-rename-dialog .primary-button").click();
    await expect(row.locator("strong")).toHaveText(original);
  } finally { await browser.close(); }
});

test("handoff review carries exact session references without launching a harness", async () => {
  test.setTimeout(60_000);
  const browser = await chromium.connectOverCDP(endpoint);
  try {
    const page = await appPage(browser);
    await page.locator(".project-sidebar-section .project-session-link").filter({ hasText: "Möbius isolated acceptance" }).first().click();
    await expect(page.locator(".reader-actions-v2 button[aria-label='交接'],.reader-actions-v2 button[aria-label='Hand off']")).toBeEnabled();
    await page.locator(".reader-actions-v2 button[aria-label='交接'],.reader-actions-v2 button[aria-label='Hand off']").click();
    const dialog = page.locator(".mobius-modal");
    await expect(dialog).toContainText(/交接当前会话|Hand off this session/);
    await expect(dialog.locator(".reference-preview code")).toContainText("@session:grok/");
    await expect(dialog.locator(".handoff-ready")).toBeVisible({ timeout: 20_000 });
    await dialog.locator(".handoff-route select").selectOption("pi");
    await expect(dialog.locator(".modal-actions .primary-button")).toBeEnabled();
    await dialog.locator(".modal-actions .soft-button").click();
    await expect(dialog).toHaveCount(0);
  } finally { await browser.close(); }
});

test("verified graph distinguishes confirmed edges from pending handoffs and persists its view", async () => {
  test.setTimeout(60_000);
  const browser = await chromium.connectOverCDP(endpoint);
  try {
    const page = await appPage(browser);
    await page.locator(".project-sidebar-search input").fill("aquant");
    await page.locator(".project-sidebar-section .project-sidebar-project").filter({ hasText: "aquant" }).first().click();
    await page.locator(".inspector-tabs button").filter({ hasText: /交接图|Handoff graph/ }).click();
    await page.getByRole("button", { name: /图谱|Graph/, exact: true }).click();
    await expect(page.locator(".react-flow__node.lineage-node")).toHaveCount(3);
    await expect(page.locator(".react-flow__edge")).toHaveCount(1);
    await expect(page.locator(".session-lineage-panel > p[role='status']")).toContainText(/尚未识别|no verified target/);
    await page.getByRole("button", { name: /预览设置|Preview settings/ }).click();
    const settings = page.locator(".lineage-settings-popover");
    await settings.locator("select").selectOption("vertical");
    await settings.locator("label").filter({ hasText: /紧凑节点|Compact nodes/ }).locator("input").check();
    await expect(page.locator(".react-flow__node.lineage-node.compact")).toHaveCount(3);
    await page.getByRole("button", { name: /列表|List/, exact: true }).click();
    await expect(page.locator(".lineage-list > div")).toHaveCount(3);
    await page.locator(".lineage-list button").first().click();
    await expect(page.locator(".lineage-detail-head")).toBeVisible();
    await page.reload();
    await page.locator(".project-sidebar-search input").fill("aquant");
    await page.locator(".project-sidebar-section .project-sidebar-project").filter({ hasText: "aquant" }).first().click();
    await page.locator(".inspector-tabs button").filter({ hasText: /交接图|Handoff graph/ }).click();
    await expect(page.getByRole("button", { name: /列表|List/, exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect.poll(() => page.evaluate(() => localStorage.getItem("mobius.lineage.direction"))).toBe("vertical");
  } finally { await browser.close(); }
});
