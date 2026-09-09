import { chromium, expect, test, type Browser, type Page } from "@playwright/test";
import { copyFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const cdp = process.env.MOBIUS_ISOLATED_CDP;
const verificationRoot = "E:\\Workspaces\\Mobius-Verification-20260907-v03";
const fixtureProject = `${verificationRoot}\\fixture-project`;
const dataRoot = process.env.MOBIUS_DATA_ROOT ?? "";
const runName = process.env.MOBIUS_DESKTOP_SMOKE_RUN ?? "";
const marker = "MOBIUS_V03_SHARED_MEMORY";
const providers = ["Codex", "Claude", "Pi", "Grok", "Apodex"];

type TauriInternals = { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> };
type Terminal = { id: string; cwd: string; state: string };

async function appPage(browser: Browser): Promise<Page> {
  const pages = browser.contexts().flatMap((context) => context.pages());
  const page = pages.find((candidate) => candidate.url().includes("tauri.localhost")) ?? pages[0];
  if (!page) throw new Error("No Mobius WebView was exposed through the isolated CDP endpoint");
  await page.waitForLoadState("domcontentloaded");
  return page;
}

async function invoke<T>(page: Page, command: string, args?: Record<string, unknown>): Promise<T> {
  return page.evaluate(async ({ command, args }) => {
    const internals = (window as unknown as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__;
    if (!internals) throw new Error("Tauri IPC bridge is unavailable");
    return internals.invoke(command, args);
  }, { command, args }) as Promise<T>;
}

test.skip(!cdp, "MOBIUS_ISOLATED_CDP must identify a newly launched v0.3 desktop instance");

test("v0.3 isolated desktop: all harnesses, sessions, @ picker, canvas, and terminal focus", async () => {
  if (!cdp || /(?:^|:)9222(?:\/|$)/.test(cdp)) throw new Error("Refusing a shared/default CDP endpoint");
  if (!/^[a-z0-9-]+$/i.test(runName)) throw new Error("MOBIUS_DESKTOP_SMOKE_RUN is required");
  if (dataRoot !== `D:\\DataVault\\Mobius-Verification-20260907-v03\\runs\\${runName}`) throw new Error("MOBIUS_DATA_ROOT must be this smoke run's isolated data root");

  const browser = await chromium.connectOverCDP(cdp);
  const page = await appPage(browser);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });

  try {
    await page.evaluate(() => {
      localStorage.setItem("mobius.onboarding.complete", "1");
      localStorage.setItem("mydesk.locale.v2", "en");
    });
    await page.reload();
    await expect(page.locator(".workspace-atlas")).toBeVisible();
    const health = await invoke<{ database_path: string }>(page, "health");
    expect(health.database_path).toContain(runName);

    await page.locator(".atlas-add").click();
    const registration = page.locator(".mobius-modal[role=dialog]");
    await expect(registration).toBeVisible();
    await registration.locator("input").fill(fixtureProject);
    await registration.locator("button.primary-button").click();
    await expect(page.locator(".workspace-inspector-v2")).toContainText("fixture-project");

    await page.locator(".rail-item").nth(1).click();
    await expect(page.locator(".session-library-v2")).toBeVisible();
    await page.getByRole("button", { name: "Scan sessions" }).click();
    await expect(page.locator(".scan-status")).toBeHidden({ timeout: 20_000 });
    const search = page.locator(".session-search-v2 input");
    await search.fill(marker);
    await expect(page.locator(".session-list-row")).toHaveCount(5);
    for (const provider of providers) {
      await expect(page.locator(".session-list-row", { has: page.locator(`.provider-pill`, { hasText: provider }) })).toHaveCount(1);
    }

    await page.locator(".session-tree-toggle").first().click();
    await expect(page.locator(".session-harness-tree section")).toHaveCount(5);
    await page.getByRole("button", { name: "Sources" }).click();
    const sources = page.locator(".session-sources-dialog");
    await expect(sources).toContainText("source files are never changed");
    await expect(sources.locator(".source-list article")).toHaveCount(5);
    await page.keyboard.press("Escape");
    await expect(sources).toBeHidden();

    await page.locator(".session-mome-trigger").click();
    const mome = page.locator(".mome-dialog");
    await mome.locator(".mome-query input").fill(marker);
    await mome.locator(".mome-query input").press("Enter");
    await expect(mome.locator(".mome-result")).toBeVisible();
    const citedSources = await mome.locator(".mome-sources article").count();
    expect(citedSources, "Mome must return at least one cited local source and cap the packet at three").toBeGreaterThanOrEqual(1);
    expect(citedSources, "Mome must cap the packet at three cited local sources").toBeLessThanOrEqual(3);
    await page.keyboard.press("Escape");
    await expect(mome).toBeHidden();

    await page.locator(".session-list-row", { hasText: "Codex" }).click();
    await expect(page.locator(".session-reader-v2")).toContainText(marker);
    await page.getByRole("button", { name: "Hand off to another Agent" }).click();
    await expect(page.locator(".mobius-modal[role=dialog]")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator(".mobius-modal[role=dialog]")).toBeHidden();

    await page.locator(".rail-item").first().click();
    await page.locator(".inspector-tabs button", { hasText: "Worktrees" }).click();
    await page.locator(".workspace-inspector-v2 .inspector-worktree-list").getByRole("button", { name: "Open terminal" }).click();
    await expect(page.locator(".terminal-page")).toBeVisible();
    const terminalInput = page.locator(".xterm-helper-textarea").last();
    await terminalInput.focus();
    const terminalMarker = `MOBIUS_V03_DESKTOP_PTY_${Date.now()}`;
    await terminalInput.pressSequentially(`Write-Output '${terminalMarker}'`);
    await terminalInput.press("Enter");
    await expect.poll(async () => {
      const terminals = await invoke<Terminal[]>(page, "terminal_list");
      return (await Promise.all(terminals.map(async (terminal) => (await invoke<{ data: string }>(page, "terminal_snapshot", { id: terminal.id })).data))).join("\n");
    }, { timeout: 12_000 }).toContain(terminalMarker);

    const terminalSnapshot = async () => (await Promise.all((await invoke<Terminal[]>(page, "terminal_list")).map(async (terminal) => (await invoke<{ data: string }>(page, "terminal_snapshot", { id: terminal.id })).data))).join("\n");
    const chineseMarker = `MOBIUS_V03_TERMINAL_中文_${Date.now()}`;
    await terminalInput.focus();
    await terminalInput.pressSequentially(`Write-Output '${chineseMarker}'`);
    await terminalInput.press("Enter");
    await expect.poll(terminalSnapshot, { timeout: 12_000 }).toContain(chineseMarker);

    const interruptedMarker = `MOBIUS_V03_AFTER_CTRLC_${Date.now()}`;
    await terminalInput.focus();
    await terminalInput.pressSequentially("Start-Sleep -Seconds 30");
    await terminalInput.press("Enter");
    await page.waitForTimeout(400);
    await terminalInput.press("Control+C");
    await terminalInput.pressSequentially(`Write-Output '${interruptedMarker}'`);
    await terminalInput.press("Enter");
    await expect.poll(terminalSnapshot, { timeout: 12_000 }).toContain(interruptedMarker);

    await page.setViewportSize({ width: 1280, height: 760 });
    const resizedMarker = `MOBIUS_V03_AFTER_RESIZE_${Date.now()}`;
    await terminalInput.focus();
    await terminalInput.pressSequentially(`Write-Output '${resizedMarker}'`);
    await terminalInput.press("Enter");
    await expect.poll(terminalSnapshot, { timeout: 12_000 }).toContain(resizedMarker);

    await page.locator(".pagebar-actions").getByRole("button", { name: "Focus" }).click();
    await expect(page.locator(".mobius-app")).toHaveClass(/terminal-focus/);
    await page.keyboard.press("Escape");
    await expect(page.locator(".mobius-app")).not.toHaveClass(/terminal-focus/);

    const active = (await invoke<Terminal[]>(page, "terminal_list")).at(-1);
    expect(active, "terminal opened from the registered fixture workspace").toBeTruthy();
    // A duplicate provider/native ID in another approved source must not be
    // silently turned into a copyable @session reference. This fixture is
    // created only under the isolated verification root.
    const originalCodexSource = `${verificationRoot}\\agent-homes\\codex\\sessions\\codex-fixture-11111111-1111-4111-8111-111111111111.jsonl`;
    const duplicateSourceRoot = `${verificationRoot}\\runs\\${runName}\\duplicate-codex-source`;
    const duplicateCodexSource = `${duplicateSourceRoot}\\codex-fixture-duplicate.jsonl`;
    await mkdir(dirname(duplicateCodexSource), { recursive: true });
    await copyFile(originalCodexSource, duplicateCodexSource);
    await invoke(page, "add_approved_session_source", { agent: "codex", path: duplicateSourceRoot });
    await invoke(page, "refresh_sessions");
    await page.locator(".terminal-context-action").click();
    const picker = page.locator(".mobius-modal[role=dialog]");
    await expect(picker).toBeVisible();
    await picker.locator(".session-reference-search input").fill("@session:codex/11111111-1111-4111-8111-111111111111#m0");
    await expect(picker.locator(".session-reference-results button")).toHaveCount(2);
    await expect(picker.locator(".session-reference-results")).toContainText("Codex");
    await expect(picker.locator("[role=alert]")).toContainText("Precise reference is disabled");
    await expect(picker.getByRole("button", { name: "Copy precise reference" })).toBeDisabled();
    await expect(picker.getByRole("button", { name: "Copy context package" })).toBeEnabled();
    await expect(picker.locator(".session-reference-messages button")).toHaveCount(2);
    await expect(picker.locator(".session-reference-messages button.active")).toContainText("m0");
    await page.keyboard.press("Escape");
    await expect(picker).toBeHidden();
    const afterPicker = await invoke<{ data: string }>(page, "terminal_snapshot", { id: active!.id });
    expect(afterPicker.data, "opening/searching the picker must not inject its @ reference into the terminal").not.toContain("@session:codex/11111111-1111-4111-8111-111111111111");
    expect(afterPicker.data, "opening/searching the picker must not inject source-session content into the terminal").not.toContain("Use bounded local recall and explicit citations only.");

    await page.locator(".rail-item").nth(2).click();
    await expect(page.locator(".notes-library-v2")).toBeVisible({ timeout: 20_000 });
    await page.getByRole("button", { name: "New canvas", exact: true }).click();
    const board = page.locator(".mobius-board");
    await expect(board).toBeVisible();
    await page.getByRole("button", { name: "Sticky note (N)" }).click();
    await page.locator(".react-flow__pane").click({ position: { x: 300, y: 230 } });
    await expect(board.locator(".mobius-node")).toHaveCount(1);
    const stage = board.locator(".board-stage");
    const pasteOnCanvas = async (text: string) => stage.evaluate((element, value) => {
      const transfer = new DataTransfer();
      transfer.setData("text/plain", value);
      element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: transfer }));
    }, text);
    // Empty-stage prose, URLs, and exact session references each become useful
    // cards. Trusted video providers have an immediate cover, but the player
    // is still opened only when the person chooses Play embed.
    await pasteOnCanvas("Canvas paste is an editable local text card.");
    await expect(board.locator(".text-node")).toHaveCount(1);
    await pasteOnCanvas("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    const youtubeCard = board.locator(".link-node.link-video", { hasText: "YouTube" });
    await expect(youtubeCard).toHaveCount(1);
    await expect(youtubeCard.locator(".link-card-image")).toHaveAttribute("src", /i\.ytimg\.com/);
    await youtubeCard.getByRole("button", { name: "Play embed" }).click();
    await expect(youtubeCard.locator("iframe.link-embed")).toHaveCount(1);
    await pasteOnCanvas("@session:codex/11111111-1111-4111-8111-111111111111#m0-m1");
    await expect(board.locator(".session-node")).toHaveCount(1);
    // A non-media MIME must remain a local attachment card rather than being
    // rejected by the importer.
    await board.locator("input[type=file]").last().setInputFiles({ name: "canvas-note.md", mimeType: "text/markdown", buffer: Buffer.from("# local canvas attachment") });
    await expect(board.locator(".media-node.file")).toHaveCount(1);
    await board.locator("input[type=file]").first().setInputFiles({ name: "canvas-image.png", mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLkYQAAAABJRU5ErkJggg==", "base64") });
    await expect(board.locator(".media-node.image img")).toBeVisible();
    await page.screenshot({ path: `${process.env.MOBIUS_PLAYWRIGHT_OUTPUT}\\v03-canvas-cards.png`, fullPage: false });
    const canvasTitle = `v03 desktop smoke ${runName}`;
    await board.getByLabel("Canvas title").fill(canvasTitle);
    await board.locator(".board-save").click();
    await expect(board.locator(".board-state")).toContainText("Saved");
    await board.getByRole("button", { name: "Back to Library" }).click();
    await expect(page.locator(".notes-library-v2 .library-canvases-v2")).toContainText(canvasTitle);
    await page.getByRole("button", { name: "New canvas", exact: true }).click();
    await expect(board).toBeVisible();
    await expect(board.getByLabel("Canvas title")).toHaveValue("Untitled canvas");
    await board.getByRole("button", { name: "Back to Library" }).click();
    await expect(page.locator(".notes-library-v2 .library-canvases-v2")).toContainText(canvasTitle);
    await page.screenshot({ path: `${process.env.MOBIUS_PLAYWRIGHT_OUTPUT}\\v03-desktop-smoke.png`, fullPage: false });

    expect(errors, errors.join("\n")).toEqual([]);
  } finally {
    await browser.close();
  }
});
