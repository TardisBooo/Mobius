import { chromium, expect, test, type Browser, type Page } from "@playwright/test";

const cdp = process.env.MOBIUS_ISOLATED_CDP;
const verificationRoot = process.env.MOBIUS_TEST_ROOT ?? "";
const relayWorkspace = `${verificationRoot}\\workspaces\\relay-demo`;
const fixtureRoot = process.env.MOBIUS_V020_FIXTURE_RUN ?? `${verificationRoot}\\runs\\run-024-v020-atlas`;
const atlasWorkspace = `${fixtureRoot}\\workspace\\mobius-v020-atlas-fixture`;
const sessionMarker = "MOBIUS_V020_ATLAS_SESSION_20260907";

type TauriInternals = {
  invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
};

type TerminalInfo = { id: string; state: string; cwd: string };
type WorkspaceView = {
  workspace: { id: string; canonical_path: string; display_name: string };
  checkouts: Array<{ id: string; canonical_path: string }>;
};

async function appPage(browser: Browser): Promise<Page> {
  const pages = browser.contexts().flatMap((context) => context.pages());
  const page = pages.find((candidate) => candidate.url().includes("tauri.localhost")) ?? pages[0];
  if (!page) throw new Error("No Möbius WebView page exposed through the isolated CDP endpoint");
  await page.waitForLoadState("domcontentloaded");
  return page;
}

async function invoke<T>(page: Page, command: string, args?: Record<string, unknown>): Promise<T> {
  return page.evaluate(async ({ command, args }) => {
    const internals = (window as unknown as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__;
    if (!internals) throw new Error("Tauri IPC bridge is unavailable in this page");
    return internals.invoke(command, args);
  }, { command, args }) as Promise<T>;
}

test.skip(!cdp, "MOBIUS_ISOLATED_CDP must point at a newly launched isolated Möbius profile");

test.skip("legacy isolated desktop WebView and PTY smoke", async () => {
  if (!cdp || /(?:^|:)9222(?:\/|$)/.test(cdp)) {
    throw new Error("Refusing any shared/default CDP endpoint; use an isolated non-9222 port");
  }
  const browser = await chromium.connectOverCDP(cdp);
  const page = await appPage(browser);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });

  await expect(page.getByText(/莫比乌斯|Möbius/).first()).toBeVisible();
  const health = await invoke<{ database_path: string }>(page, "health");
  expect(health.database_path).toContain("Mobius-Verification-20260907");

  const marker = `MOBIUS_ISOLATED_CDP_PTY_${Date.now()}`;
  const terminal = await invoke<TerminalInfo>(page, "terminal_create", {
    cwd: relayWorkspace,
    title: "isolated-cdp-pty",
    initialCommand: null,
  });
  expect(terminal.cwd).toBe(relayWorkspace);
  await invoke<void>(page, "terminal_resize", { id: terminal.id, rows: 41, cols: 127 });
  await invoke<void>(page, "terminal_write", {
    id: terminal.id,
    data: `Write-Output '${marker}'\r`,
  });
  await expect.poll(async () => {
    const snapshot = await invoke<{ data: string }>(page, "terminal_snapshot", { id: terminal.id });
    return snapshot.data;
  }, { timeout: 10_000 }).toContain(marker);
  await invoke<void>(page, "terminal_close", { id: terminal.id });
  await expect.poll(async () => {
    const terminals = await invoke<TerminalInfo[]>(page, "terminal_list");
    return terminals.some((item) => item.id === terminal.id);
  }, { timeout: 5_000 }).toBe(false);

  expect(errors, errors.join("\n")).toEqual([]);
  await page.screenshot({ path: `${process.env.MOBIUS_PLAYWRIGHT_OUTPUT}/isolated-desktop-smoke.png` });
  await browser.close();
});

test("isolated v0.3 Workbench, SessionLibraryV2, and PTY smoke", async () => {
  if (!cdp || /(?:^|:)9222(?:\/|$)/.test(cdp)) {
    throw new Error("Refusing any shared/default CDP endpoint; use an isolated non-9222 port");
  }
  if (!fixtureRoot.startsWith(`${verificationRoot}\\runs\\`)) {
    throw new Error("MOBIUS_V020_FIXTURE_RUN must remain inside the isolated verification run directory");
  }
  const browser = await chromium.connectOverCDP(cdp);
  const page = await appPage(browser);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });

  try {
    // Fresh renderer profile: bypass onboarding and select English only for
    // this isolated fixture, so assertions target the v0.2 surfaces.
    await page.evaluate(() => {
      localStorage.setItem("mobius.onboarding.complete", "1");
      localStorage.setItem("mydesk.locale.v2", "en");
      localStorage.setItem("mobius.workspace.recent.v2", "[]");
    });
    await page.reload();
    await expect(page.locator(".workspace-atlas")).toBeVisible();
    const health = await invoke<{ database_path: string }>(page, "health");
    expect(health.database_path).toContain("run-024-v020-atlas");

    // Fixture histories are copied after desktop startup. Register through
    // WorkspaceAtlas before refresh so the test proves project association.
    await page.locator(".atlas-add").click();
    const registerDialog = page.locator(".mobius-modal[role=dialog]");
    await expect(registerDialog).toBeVisible();
    await registerDialog.locator("input").fill(atlasWorkspace);
    await registerDialog.locator("button.primary-button").click();
    await expect(page.locator(".workspace-inspector-v2")).toContainText("mobius-v020-atlas-fixture");
    await expect(page.locator(".workspace-inspector-v2 code").first()).toContainText("mobius-v020-atlas-fixture");

    const workspaces = await invoke<WorkspaceView[]>(page, "list_workspaces_v2");
    const workspace = workspaces.find((item) => item.workspace.canonical_path === atlasWorkspace);
    expect(workspace, "registered fixture workspace").toBeTruthy();
    expect(workspace!.checkouts.length, "registered fixture checkout").toBeGreaterThan(0);
    const checkout = workspace!.checkouts.find((item) => item.canonical_path === atlasWorkspace) ?? workspace!.checkouts[0];
    const report = await invoke<{ errors: string[] }>(page, "refresh_sessions");
    expect(report.errors, report.errors.join("\n")).toEqual([]);
    await expect.poll(async () => invoke<Array<{ session: { id: string } }>(page, "query_sessions", {
      query: sessionMarker, workspace_id: workspace!.workspace.id, checkout_id: checkout.id, providers: [], limit: 20,
    }), { timeout: 10_000 }).toHaveLength(2);

    await page.locator(".inspector-tabs button").nth(1).click();
    await page.locator(".inspector-tabs button").nth(0).click();
    await expect(page.locator(".project-session-panel")).toContainText(sessionMarker);

    // The rail has exactly the three primary destinations: Workbench,
    // Sessions, and Library. Skills live behind the top command action.
    await expect(page.locator(".rail-item")).toHaveCount(3);
    await page.locator(".rail-item").nth(1).click();
    await expect(page.locator(".session-library-v2")).toBeVisible();
    const tree = page.locator(".session-tree-v2");
    await expect(tree).toContainText("mobius-v020-atlas-fixture");
    await tree.locator(".session-tree-toggle").first().click();
    await tree.locator(".session-checkout-tree button").first().click();
    await expect(page.locator(".session-result-list-v2")).toContainText(sessionMarker);

    await page.locator(".session-list-row", { hasText: sessionMarker }).first().click();
    const reader = page.locator(".session-reader-v2");
    await expect(reader).toContainText(sessionMarker);
    await page.locator(".message-stream-v2 article", { hasText: sessionMarker }).first().click();
    await page.locator(".reader-actions-v2 button").nth(1).click();
    const referenceDialog = page.locator(".mobius-modal[role=dialog]");
    await expect(referenceDialog).toBeVisible();
    await expect(referenceDialog).toContainText(/never writes to a terminal|不会写入终端/);
    await referenceDialog.locator("button.primary-button").click();
    await expect(page.locator(".reference-tray")).toHaveCount(0);
    await referenceDialog.locator("button").first().click();

    for (const selector of [".session-result-list-v2", ".session-reader-v2"]) {
      const metrics = await page.locator(selector).evaluate((element) => ({ overflowY: getComputedStyle(element).overflowY, clientHeight: element.clientHeight }));
      expect(metrics.overflowY, `${selector} must remain a visible vertical scroll container`).toBe("auto");
      expect(metrics.clientHeight, `${selector} must be visible`).toBeGreaterThan(0);
    }

    const terminalMarker = `MOBIUS_V020_ATLAS_PTY_${Date.now()}`;
    const terminal = await invoke<TerminalInfo>(page, "terminal_create", { cwd: atlasWorkspace, title: "v020-atlas-pty", initialCommand: null });
    expect(terminal.cwd).toBe(atlasWorkspace);
    await invoke<void>(page, "terminal_resize", { id: terminal.id, rows: 41, cols: 127 });
    await invoke<void>(page, "terminal_write", { id: terminal.id, data: `Write-Output '${terminalMarker}'\r` });
    await expect.poll(async () => (await invoke<{ data: string }>(page, "terminal_snapshot", { id: terminal.id })).data, { timeout: 10_000 }).toContain(terminalMarker);
    await invoke<void>(page, "terminal_close", { id: terminal.id });
    await expect.poll(async () => (await invoke<TerminalInfo[]>(page, "terminal_list")).some((item) => item.id === terminal.id), { timeout: 5_000 }).toBe(false);

    expect(errors, errors.join("\n")).toEqual([]);
    await page.screenshot({ path: `${process.env.MOBIUS_PLAYWRIGHT_OUTPUT}/isolated-v020-atlas-smoke.png` });
  } finally {
    await browser.close();
  }
});
