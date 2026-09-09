import { chromium, expect, test, type Browser, type Page } from "@playwright/test";

type TauriInternals = { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> };

async function appPage(browser: Browser): Promise<Page> {
  const pages = browser.contexts().flatMap((context) => context.pages());
  const page = pages.find((candidate) => candidate.url().includes("tauri.localhost")) ?? pages[0];
  if (!page) throw new Error("Möbius WebView page is unavailable");
  page.setDefaultTimeout(15_000);
  return page;
}

async function invoke<T>(page: Page, command: string, args?: Record<string, unknown>): Promise<T> {
  return page.evaluate(async ({ command, args }) => {
    const internals = (window as unknown as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__;
    if (!internals) throw new Error("Tauri IPC bridge is unavailable");
    return internals.invoke(command, args);
  }, { command, args }) as Promise<T>;
}

test("workspace drag, note save, mount tree and terminal contrast", async () => {
  const endpoint = process.env.MOBIUS_INTERACTION_CDP ?? "http://127.0.0.1:9352";
  const workspace = process.env.MOBIUS_INTERACTION_WORKSPACE;
  const mountRoot = process.env.MOBIUS_INTERACTION_MOUNT;
  if (!workspace || !mountRoot) throw new Error("interaction fixture paths are required");
  const browser = await chromium.connectOverCDP(endpoint);
  const page = await appPage(browser);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });

  try {
    await page.evaluate(() => {
      localStorage.setItem("mobius.onboarding.complete", "1");
      localStorage.setItem("mobius.theme", "light");
      localStorage.setItem("mydesk.locale.v2", "en");
      localStorage.setItem("mobius.workspace.recent.v2", "[]");
      localStorage.setItem("mobius.workspace.recent.v2.seeded", "1");
    });
    await page.reload();
    await expect(page.locator(".workspace-atlas")).toBeVisible();

    const project = page.locator(".atlas-project-button").filter({ hasText: "drag-demo" }).first();
    if (await project.count() === 0) {
      await page.locator(".atlas-add").click();
      const dialog = page.locator(".mobius-modal[role=dialog]");
      await dialog.locator("input").fill(workspace);
      await dialog.locator("button.primary-button").click();
    }
    await expect(project).toBeVisible();

    // Exercise the same pointer gesture as a user: drag the row onto the
    // target, not only its child placeholder.
    await project.locator("xpath=..").dragTo(page.locator(".recent-drop-target"));
    await expect(page.locator(".recent-workspace-card", { hasText: "drag-demo" })).toBeVisible();

    // A private note is editable and has an explicit saved state after the
    // native update command completes.
    const note = await invoke<{ source_path?: string }>(page, "create_note", { draft: { title: "Interaction regression note", body: "before", project_slug: null, tags: [], source_ids: [] } });
    expect(note.source_path).toBeTruthy();
    await page.reload();
    await page.locator(".rail-item").nth(2).click();
    await expect(page.locator(".notes-library-v2")).toBeVisible();
    await page.locator(".library-tree-file", { hasText: "interaction-regression-note" }).click();
    const editor = page.locator(".note-editor-v2");
    await editor.locator("textarea").fill("after\n\n- saved through the UI");
    await editor.getByRole("button", { name: /Save|淇濆瓨/ }).click();
    await expect(editor.locator(".note-save-state")).toHaveText(/Saved|已保存/);
    const raw = await invoke<string>(page, "read_note_file_command", { path: note.source_path });
    expect(raw).toContain("saved through the UI");

    // Mounts expose their virtual root exactly once and remain collapsible.
    await invoke(page, "add_note_mount", { path: mountRoot, virtualPath: "Reference", access: "read_only" });
    await page.reload();
    await page.locator(".rail-item").nth(2).click();
    const mount = page.locator(".library-mount-branch", { hasText: "Reference" }).last();
    await expect(mount).toBeVisible();
    await expect(mount.locator(".library-tree-folder", { hasText: "Reference" })).toHaveCount(0);
    await mount.locator(".library-mount-toggle").click();
    await expect(mount.locator(".library-tree-folder, .library-tree-file")).toHaveCount(0);
    await mount.locator(".library-mount-toggle").click();

    // The terminal deliberately stays dark even while the shell is light.
    const terminal = await invoke<{ id: string }>(page, "terminal_create", { cwd: workspace, title: "interaction-regression", initialCommand: null });
    await invoke(page, "terminal_resize", { id: terminal.id, rows: 24, cols: 100 });
    await page.locator(".rail-item").nth(0).click();
    await page.getByRole("button", { name: /Terminals|缁堢/ }).click();
    await expect(page.locator(".terminal-stage")).toBeVisible();
    const terminalColors = await page.locator(".terminal-stage").evaluate((node) => ({ background: getComputedStyle(node).backgroundColor, screen: getComputedStyle(node.querySelector(".xterm-screen")!).backgroundColor }));
    expect(terminalColors.background).toMatch(/rgb\(8, 11, 16\)|#080b10/i);
    expect(terminalColors.screen).toMatch(/rgb\(8, 11, 16\)|#080b10/i);
    for (const theme of ["light", "dark"]) {
      await page.locator("html").evaluate((node, nextTheme) => { node.dataset.theme = nextTheme; }, theme);
      const themedColors = await page.locator(".terminal-stage").evaluate((node) => ({ background: getComputedStyle(node).backgroundColor, screen: getComputedStyle(node.querySelector(".xterm-screen")!).backgroundColor }));
      expect(themedColors.background).toMatch(/rgb\(8, 11, 16\)|#080b10/i);
      expect(themedColors.screen).toMatch(/rgb\(8, 11, 16\)|#080b10/i);
    }
    await invoke(page, "terminal_close", { id: terminal.id });

    // The custom title bar remains present and is not covered by page content.
    await expect(page.locator(".mobius-topbar[data-tauri-drag-region]")).toBeVisible();
    await page.locator(".mobius-topbar .mobius-brand").dispatchEvent("mousedown", { button: 0 });
    expect(errors, errors.join("\n")).toEqual([]);
  } finally {
    await browser.close();
  }
});
