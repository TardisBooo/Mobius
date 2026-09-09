import { chromium, expect, test, type Browser, type Page } from "@playwright/test";

// Retained only as historical reference from the MyDesk prototype. It targets
// user-project paths and real Harnesses, so Möbius must never execute it.
test.skip(true, "Legacy MyDesk smoke is permanently disabled; use mobius.isolated.smoke.spec.ts.");

const CDP = process.env.MYDESK_CDP ?? "http://127.0.0.1:9222";

async function appPage(browser: Browser): Promise<Page> {
  const contexts = browser.contexts();
  const pages = contexts.flatMap((context) => context.pages());
  const page = pages.find((candidate) => candidate.url().includes("tauri.localhost")) ?? pages[0];
  if (!page) throw new Error("MyDesk WebView page unavailable");
  await page.waitForLoadState("domcontentloaded");
  return page;
}

test("MyDesk desktop critical controls", async () => {
  const cdp = await chromium.connectOverCDP(CDP);
  const page = await appPage(cdp);
  await page.reload();
  await page.waitForLoadState("domcontentloaded");
  const englishLocaleButton = page.getByRole("button", { name: "EN", exact: true });
  if (await englishLocaleButton.count()) await englishLocaleButton.click();
  const errors: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  page.on("pageerror", (error) => errors.push(error.message));

  await expect(page.getByText("MyDesk Smoke Test", { exact: true })).toBeVisible();
  await expect(page.getByText("沿着工作区继续", { exact: false })).toHaveCount(0);

  const agentSessionWorkspace = page.getByText("MyDesk-AgentSession-SmokeTest", { exact: true });
  if (await agentSessionWorkspace.count() === 0) {
    await page.getByRole("button", { name: /添加工作区|Add workspace/ }).click();
    await page.locator(".modal input").fill("E:\\Workspaces\\MyDesk-AgentSession-SmokeTest");
    await page.locator(".modal-actions .primary-button").click();
  }
  await expect(agentSessionWorkspace).toBeVisible();

  const card = page.locator(".workspace-card", { hasText: "MyDesk Smoke Test" });
  await card.click();
  await expect(page.locator(".workspace-inspector")).toContainText("E:\\Workspaces\\MyDesk-SmokeTest");
  await page.locator(".directory-row.directory", { hasText: "docs" }).click();
  await expect(page.locator(".directory-row.file", { hasText: "nested-check.md" })).toBeVisible();
  await page.getByRole("button", { name: /Skills/ }).last().click();
  await expect(page.locator(".workspace-skills")).toContainText("smoke-local");
  await page.getByRole("button", { name: /Worktrees/ }).click();
  await expect(page.locator(".worktree-detail-list")).toContainText("master");

  const paused = page.locator(".paused-section");
  await card.dragTo(paused);
  await expect(paused.locator(".workspace-card", { hasText: "MyDesk Smoke Test" })).toBeVisible();
  await paused.locator(".workspace-card", { hasText: "MyDesk Smoke Test" }).dragTo(page.locator(".corridor-rail").first());
  await expect(page.locator(".corridor-rail").first().locator(".workspace-card", { hasText: "MyDesk Smoke Test" })).toBeVisible();

  await page.getByRole("button", { name: /Canvas|无限画布/ }).click();
  const palette = page.locator(".canvas-palette");
  await expect(palette.getByRole("button", { name: /随笔|Jot/ })).toBeVisible();
  await expect(palette.getByRole("button", { name: /笔记|Note/ })).toBeVisible();
  await expect(palette.getByRole("button", { name: /链接|Link/ })).toBeVisible();
  await expect(palette.getByRole("button", { name: /图片|Image/ })).toBeVisible();
  await expect(palette.getByRole("button", { name: /视频|Video/ })).toBeVisible();
  await palette.getByRole("button", { name: /分区|Section/ }).click();
  await palette.getByRole("button", { name: /随笔|Jot/ }).click();
  await palette.getByRole("button", { name: /笔记|Note/ }).click();
  await expect(page.locator(".section-node")).toHaveCount(2);
  await expect(page.locator(".note-node")).toHaveCount(2);
  await expect(page.locator(".jot-node")).toHaveCount(1);
  await page.locator(".jot-node textarea").fill("随笔可以自由输入，不触发整个画布重绘。");
  await page.locator(".jot-node textarea").blur();
  await page.locator(".note-node").last().locator("input").first().fill("自定义研究笔记");
  await page.locator(".note-node").last().locator("textarea").fill("**重点**\n- [ ] 可编辑任务\n[[双向引用]]");
  await page.locator(".note-node").last().locator("textarea").blur();

  await palette.getByRole("button", { name: /链接|Link/ }).click();
  await page.locator(".canvas-link-composer input").fill("https://www.noteey.com/");
  await page.locator(".canvas-link-composer .primary-button").click();
  await expect(page.locator(".link-node")).toContainText("noteey.com");
  const imageChooser = page.waitForEvent("filechooser");
  await palette.getByRole("button", { name: /图片|Image/ }).click();
  await (await imageChooser).setFiles("E:/Workspaces/MyDesk-SmokeTest/assets/canvas-smoke.svg");
  const videoChooser = page.waitForEvent("filechooser");
  await palette.getByRole("button", { name: /视频|Video/ }).click();
  await (await videoChooser).setFiles("E:/Workspaces/MyDesk-SmokeTest/assets/canvas-smoke.mp4");
  const fileChooser = page.waitForEvent("filechooser");
  await palette.getByRole("button", { name: /文件|File/ }).click();
  await (await fileChooser).setFiles("E:/Workspaces/MyDesk-SmokeTest/assets/attachment.txt");
  await expect(page.locator(".media-node.image")).toBeVisible();
  await expect(page.locator(".media-node.video video")).toBeVisible();
  await expect(page.locator(".media-node.file")).toBeVisible();
  await page.locator(".react-flow__controls-fitview").click();
  await page.screenshot({ path: "test-results/mydesk-canvas-media.png", fullPage: false });

  const stressStarted = Date.now();
  for (let index = 0; index < 40; index += 1) await palette.getByRole("button", { name: /随笔|Jot/ }).click();
  expect(Date.now() - stressStarted).toBeLessThan(4_000);
  await expect(page.locator(".jot-node")).toHaveCount(41);
  const interactionStarted = Date.now();
  await page.locator(".jot-node textarea").last().fill("40 节点压力下仍可输入");
  await page.locator(".jot-node textarea").last().blur();
  expect(Date.now() - interactionStarted).toBeLessThan(1_000);
  await page.locator(".canvas-header input").fill("MyDesk Smoke Canvas");
  await page.locator(".canvas-header .primary-button").click();
  await expect(page.locator(".canvas-file-list")).toContainText("MyDesk Smoke Canvas");
  await page.screenshot({ path: "test-results/mydesk-smoke-canvas.png", fullPage: false });

  await page.getByRole("button", { name: /刷新会话|Refresh sessions/ }).click();
  await expect(page.locator(".busy-strip")).toBeHidden({ timeout: 90_000 });
  await page.getByRole("button", { name: /Sessions|会话库/ }).click();
  const sessionWorkspaceGroup = page.locator(".tree-group", { hasText: "MyDesk-AgentSession-SmokeTest" });
  const sessionCheckout = sessionWorkspaceGroup.locator(".tree-item").first();
  await sessionCheckout.click();
  await expect(sessionCheckout).toHaveClass(/active/);
  const sessionSearch = page.locator(".session-search input");
  for (const expected of [
    { marker: "MYDESK_CODEX_SESSION_SMOKE_20260904", provider: "codex", source: "Codex\\Home\\sessions" },
    { marker: "MYDESK_CLAUDE_SESSION_SMOKE_20260904", provider: "claude", source: ".claude\\projects" },
    { marker: "MYDESK_GROK_SESSION_SMOKE_20260904", provider: "grok", source: ".grok\\sessions" }
  ]) {
    await sessionSearch.fill(expected.marker);
    const result = page.locator(".session-row", { hasText: expected.marker }).first();
    await expect(result).toBeVisible({ timeout: 15_000 });
    await expect(result.locator(".provider-badge")).toHaveText(expected.provider);
    await result.click();
    await expect(page.locator(".session-detail")).toContainText(expected.marker);
    await expect(page.locator(".session-detail")).toContainText(expected.source);
    await expect(page.locator(".session-detail")).not.toContainText("Unassigned");
    const nativeResume = page.getByRole("button", { name: /原生恢复|Native resume/ });
    if (expected.provider === "codex" || expected.provider === "claude") await expect(nativeResume).toBeVisible();
    else await expect(nativeResume).toHaveCount(0);
  }
  await page.screenshot({ path: "test-results/mydesk-real-agent-sessions.png", fullPage: false });
  await sessionSearch.fill("MYDESK_CODEX_SESSION_SMOKE_20260904");
  await page.locator(".session-row", { hasText: "MYDESK_CODEX_SESSION_SMOKE_20260904" }).first().click();
  await page.getByRole("button", { name: /原生恢复|Native resume/ }).click();
  await expect(page.locator(".terminal-page")).toBeVisible();
  const codexProviderSessionId = "01a06d11-fb34-77f0-96ea-39edd5515df6";
  const readResumeState = async () => page.evaluate(async () => {
    const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> } }).__TAURI_INTERNALS__;
    const terminals = await internals.invoke("terminal_list") as Array<{ id: string }>;
    const newest = terminals.sort((left: { created_at?: string }, right: { created_at?: string }) => (right.created_at ?? "").localeCompare(left.created_at ?? ""))[0];
    if (!newest) return "waiting";
    const snapshot = await internals.invoke("terminal_snapshot", { id: newest.id }) as { data: string };
    if (snapshot.data.includes("01a06d11-fb34-77f0-96ea-39edd5515df6") && snapshot.data.includes("Ask Codex to do anything")) return `ready:${newest.id}`;
    if (snapshot.data.includes("Do you trust the contents of this directory")) return `trust:${newest.id}`;
    return "waiting";
  });
  await expect.poll(readResumeState, { timeout: 30_000 }).toMatch(/^(ready|trust):/);
  const state = await readResumeState();
  if (state.startsWith("trust:")) {
    await page.evaluate(async (terminalId) => {
      const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> } }).__TAURI_INTERNALS__;
      await internals.invoke("terminal_write", { id: terminalId, data: "1\r" });
    }, state.slice("trust:".length));
  }
  await expect.poll(async () => page.evaluate(async (sessionId) => {
    const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> } }).__TAURI_INTERNALS__;
    const terminals = await internals.invoke("terminal_list") as Array<{ id: string; created_at: string }>;
    const newest = terminals.sort((left, right) => right.created_at.localeCompare(left.created_at))[0];
    if (!newest) return false;
    const snapshot = await internals.invoke("terminal_snapshot", { id: newest.id }) as { data: string };
    return snapshot.data.includes(sessionId) && snapshot.data.includes("Ask Codex to do anything");
  }, codexProviderSessionId), { timeout: 30_000 }).toBe(true);
  const resumeInput = page.locator(".xterm-helper-textarea").last();
  await resumeInput.focus();
  await resumeInput.pressSequentially("MYDESK_RESUME_PTY_INTERACTIVE");
  await expect.poll(async () => page.evaluate(async () => {
    const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> } }).__TAURI_INTERNALS__;
    const terminals = await internals.invoke("terminal_list") as Array<{ id: string; created_at: string }>;
    const newest = terminals.sort((left, right) => right.created_at.localeCompare(left.created_at))[0];
    if (!newest) return "";
    return (await internals.invoke("terminal_snapshot", { id: newest.id }) as { data: string }).data;
  }), { timeout: 10_000 }).toContain("MYDESK_RESUME_PTY_INTERACTIVE");
  await page.screenshot({ path: "test-results/mydesk-codex-native-resume.png", fullPage: false });
  await page.locator(".terminal-tab.active svg").last().click();
  await page.getByRole("button", { name: /Sessions|会话库/ }).click();
  await sessionSearch.fill("");
  await expect(page.locator(".session-row").first()).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: /接力图|Relay map/ }).click();
  await expect(page.locator(".relay-lanes > section")).toHaveCount(5);
  await expect(page.locator(".relay-lanes article").first()).toBeVisible();
  await page.locator(".relay-lanes article").first().click();
  await page.screenshot({ path: "test-results/mydesk-smoke-relay-map.png", fullPage: false });
  await page.getByRole("button", { name: /交给其他 Agent|Hand off/ }).click();
  await expect(page.getByText(/选择要继承的上下文|Choose inherited context/)).toBeVisible();
  await expect(page.locator(".handoff-steps > span")).toHaveCount(4);
  await expect(page.locator(".handoff-context label").first()).toBeVisible();
  await page.locator(".handoff-context .quiet-button").click();
  await page.locator(".modal-actions .primary-button").click();
  await expect(page.locator(".handoff-review")).toBeVisible();
  await page.screenshot({ path: "test-results/mydesk-smoke-handoff.png", fullPage: false });
  await page.locator(".modal > header .icon-button").click();

  await page.getByRole("button", { name: /Workspaces|工作区/ }).click();
  const terminalCard = page.locator(".workspace-card", { hasText: "MyDesk Smoke Test" });
  await terminalCard.click();
  await terminalCard.getByRole("button", { name: /Open terminal|打开终端/ }).click();
  await expect(page.locator(".terminal-page")).toBeVisible();
  const textarea = page.locator(".xterm-helper-textarea").last();
  await textarea.focus();
  await textarea.pressSequentially("Write-Output (-join ([char[]](77,89,68,69,83,75,95,80,84,89,95,82,69,83,85,76,84)))");
  await textarea.press("Enter");
  await expect.poll(async () => page.evaluate(async () => {
    const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> } }).__TAURI_INTERNALS__;
    const terminals = await internals.invoke("terminal_list") as Array<{ id: string }>;
    const snapshots = await Promise.all(terminals.map((terminal) => internals.invoke("terminal_snapshot", { id: terminal.id }) as Promise<{ data: string }>));
    return snapshots.map((snapshot) => snapshot.data).join("\n");
  }), { timeout: 10_000 }).toContain("MYDESK_PTY_RESULT");
  await page.screenshot({ path: "test-results/mydesk-smoke-terminal.png", fullPage: false });

  await page.getByRole("button", { name: /Skills|技能/ }).first().click();
  await expect(page.getByText(/全局技能管理|Global skill management/)).toBeVisible();
  await page.getByRole("button", { name: /中|EN/ }).click();
  await expect(page.getByText(/Global skill management|全局技能管理/)).toBeVisible();

  expect(errors, errors.join("\n")).toEqual([]);
  await cdp.close();
});
