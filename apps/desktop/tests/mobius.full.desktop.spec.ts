import { chromium, expect, test, type Browser, type Page } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { relative, resolve } from "node:path";

const verificationRoot = "E:\\Workspaces\\Mobius-Verification-20260907-v03";
const cdp = process.env.MOBIUS_ISOLATED_CDP;
const runName = process.env.MOBIUS_DESKTOP_SMOKE_RUN ?? "";
const dataRoot = process.env.MOBIUS_DATA_ROOT ?? "";
const artifactRoot = process.env.MOBIUS_ARTIFACTS_ROOT ?? "";
const catalogRoot = process.env.MOBIUS_CATALOG_ROOT ?? "";
const outputRoot = process.env.MOBIUS_PLAYWRIGHT_OUTPUT ?? "";
const runRoot = `${verificationRoot}\\runs\\${runName}`;
const fixtureProject = `${runRoot}\\workspace`;
const targetProject = `${runRoot}\\target-workspace`;
const agentHome = `${runRoot}\\agent-home`;
const extraCodexRoot = `${runRoot}\\extra-codex-sessions`;
const mountedLibrary = `${runRoot}\\mounted-library`;
const exactRef = "@session:codex/11111111-1111-4111-8111-111111111111#m0";
const memoryMarker = "MOBIUS_FULL_SHARED_MEMORY";
const extraMarker = "MOBIUS_FULL_SOURCE_MANAGER";

type TauriInternals = { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> };
type Terminal = { id: string; cwd: string; state: string; title: string };
type Message = { id: string; ordinal: number; role: string; content: string };
type SessionHit = {
  session: { id: string; provider: string; provider_session_id: string; capabilities: string[]; source_path: string; title: string };
  message: Message | null;
};
type WorkspaceView = { workspace: { id: string; canonical_path: string }; checkouts: Array<{ id: string; canonical_path: string }> };
type Mome = { semantic_status: string; max_tokens: number; estimated_tokens: number; sources: Array<{ citation: string; text: string }> };
type ManagedSkill = { id: string; destination: string; target: string };

function sha256(path: string) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function assertSafeEnvironment() {
  const wanted = resolve(verificationRoot);
  const inside = (candidate: string, parent: string) => {
    const value = relative(parent, resolve(candidate));
    return value === "" || (!value.startsWith("..") && !value.includes(":"));
  };
  if (!cdp || /(?:^|:)9222(?:\/|$)/.test(cdp)) throw new Error("MOBIUS_ISOLATED_CDP must be a non-default, dedicated desktop instance");
  if (!/^[a-z0-9-]+$/i.test(runName)) throw new Error("MOBIUS_DESKTOP_SMOKE_RUN must name a fresh, simple run directory");
  if (dataRoot !== `D:\\DataVault\\Mobius-Verification-20260907-v03\\runs\\${runName}`) throw new Error("MOBIUS_DATA_ROOT is outside this isolated acceptance run");
  if (artifactRoot !== `D:\\AcceptedArtifacts\\Mobius-Verification-20260907-v03\\runs\\${runName}`) throw new Error("MOBIUS_ARTIFACTS_ROOT is outside this isolated acceptance run");
  if (catalogRoot !== `D:\\Catalog\\Mobius-Verification-20260907-v03\\runs\\${runName}`) throw new Error("MOBIUS_CATALOG_ROOT is outside this isolated acceptance run");
  if (!inside(outputRoot, resolve(wanted, "runs", runName))) throw new Error("Playwright output is outside the fresh isolated run");
  for (const required of [fixtureProject, targetProject, agentHome, extraCodexRoot, mountedLibrary]) {
    if (!existsSync(required)) throw new Error(`Acceptance fixture is missing: ${required}`);
  }
}

async function appPage(browser: Browser): Promise<Page> {
  const pages = browser.contexts().flatMap((context) => context.pages());
  const page = pages.find((candidate) => candidate.url().includes("tauri.localhost")) ?? pages[0];
  if (!page) throw new Error("The dedicated Möbius WebView was not exposed through CDP");
  await page.waitForLoadState("domcontentloaded");
  return page;
}

async function invoke<T>(page: Page, command: string, args?: Record<string, unknown>): Promise<T> {
  return page.evaluate(async ({ command, args }) => {
    const internals = (window as unknown as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__;
    if (!internals) throw new Error("The Tauri IPC bridge is unavailable");
    return internals.invoke(command, args);
  }, { command, args }) as Promise<T>;
}

type ControlAuditIssue = { kind: string; selector: string; detail: string };

async function auditVisibleControls(page: Page, surface: string) {
  const issues = await page.evaluate<ControlAuditIssue[]>(() => {
    const issues: ControlAuditIssue[] = [];
    const root = document.querySelector<HTMLElement>(".mobius-app");
    if (!root) return [{ kind: "missing-root", selector: ".mobius-app", detail: "application shell is absent" }];
    if (root.scrollWidth > root.clientWidth + 1) {
      issues.push({ kind: "overflow", selector: ".mobius-app", detail: `${root.scrollWidth}px content in ${root.clientWidth}px shell` });
    }
    const controls = [...root.querySelectorAll<HTMLElement>("button, input, select, textarea, a[href], [role='button']")];
    for (const control of controls) {
      const style = getComputedStyle(control);
      const rect = control.getBoundingClientRect();
      if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0 || rect.width < 1 || rect.height < 1) continue;
      if (control.matches("input[type='file']")) continue;
      const label = control.getAttribute("aria-label")?.trim()
        || control.getAttribute("title")?.trim()
        || control.getAttribute("placeholder")?.trim()
        || control.textContent?.trim()
        || (control instanceof HTMLInputElement ? control.value.trim() : "");
      const selector = `${control.tagName.toLocaleLowerCase()}${control.className ? `.${String(control.className).trim().split(/\s+/).join(".")}` : ""}`;
      if (!label) issues.push({ kind: "unnamed", selector, detail: "visible interactive control has no accessible name" });
      const compactInline = control.matches("a") || control.closest(".xterm, .react-flow__node");
      if (!compactInline && (rect.width < 24 || rect.height < 24)) {
        issues.push({
          kind: "hit-target",
          selector,
          detail: `${Math.round(rect.width)}x${Math.round(rect.height)}px; ${control.outerHTML.slice(0, 240)}`,
        });
      }
    }
    return issues;
  });
  expect(issues, `${surface} control audit:\n${issues.map((issue) => `${issue.kind} ${issue.selector}: ${issue.detail}`).join("\n")}`).toEqual([]);
}

async function auditBothThemes(page: Page, surface: string) {
  await auditVisibleControls(page, `${surface} / dark`);
  await page.screenshot({ path: `${outputRoot}\\${surface}-dark.png`, fullPage: false });
  await page.getByRole("button", { name: "Switch theme" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await auditVisibleControls(page, `${surface} / light`);
  await page.screenshot({ path: `${outputRoot}\\${surface}-light.png`, fullPage: false });
  await page.getByRole("button", { name: "Switch theme" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
}

async function snapshots(page: Page): Promise<string> {
  const terminals = await invoke<Terminal[]>(page, "terminal_list");
  return (await Promise.all(terminals.map(async (terminal) => {
    const result = await invoke<{ data: string }>(page, "terminal_snapshot", { id: terminal.id });
    return result.data;
  }))).join("\n");
}

async function terminalSnapshot(page: Page, id: string): Promise<string> {
  return (await invoke<{ data: string }>(page, "terminal_snapshot", { id })).data;
}

async function rejectedMessage(value: Promise<unknown>) {
  try {
    await value;
  } catch (reason) {
    return String(reason);
  }
  throw new Error("Expected the unsafe legacy cross-Harness IPC command to be unavailable");
}

async function pasteIntoCanvas(page: Page, value: string) {
  await page.locator(".board-stage").evaluate((stage, text) => {
    const clipboard = new DataTransfer();
    clipboard.setData("text/plain", text);
    (stage as HTMLElement).focus();
    stage.dispatchEvent(new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: clipboard,
    }));
  }, value);
}

test.skip(!cdp, "MOBIUS_ISOLATED_CDP must identify a newly launched isolated Möbius desktop instance");
// This is a deliberately broad desktop acceptance run: it exercises native
// scanning, a real PowerShell PTY, local filesystem import, media persistence,
// and both managed-skill copy flows. Give the complete run a realistic budget
// while each individual expectation retains its short failure timeout.
test.setTimeout(360_000);

test("full isolated desktop acceptance: all local product flows remain explicit and source-safe", async () => {
  assertSafeEnvironment();
  const browser = await chromium.connectOverCDP(cdp!);
  const page = await appPage(browser);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  const sourceFiles = [
    `${agentHome}\\codex\\sessions\\codex-fixture-11111111-1111-4111-8111-111111111111.jsonl`,
    `${agentHome}\\.claude\\projects\\fixture-project\\claude-fixture-22222222-2222-4222-8222-222222222222.jsonl`,
    `${agentHome}\\.pi\\agent\\sessions\\pi-fixture-33333333-3333-4333-8333-333333333333.jsonl`,
    `${agentHome}\\.grok\\sessions\\fixture-grok\\chat_history.jsonl`,
    `${agentHome}\\.apodex\\sessions\\apodex-fixture-55555555-5555-4555-8555-555555555555.json`,
    `${extraCodexRoot}\\codex-extra-66666666-6666-4666-8666-666666666666.jsonl`,
  ];
  const hashesBefore = new Map(sourceFiles.map((path) => [path, sha256(path)]));

  try {
    await page.evaluate(() => {
      localStorage.setItem("mobius.onboarding.complete", "1");
      localStorage.setItem("mydesk.locale.v2", "en");
      localStorage.setItem("mobius.theme", "dark");
    });
    await page.reload();
    await expect(page.locator(".workspace-atlas")).toBeVisible();

    // The visual system is intentionally dark-first: the desktop opens as a
    // local control room, and the alternate light palette remains a deliberate
    // toggle rather than a flash during first-run hydration.
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--m-bg").trim())).toBe("#090d14");
    await page.screenshot({ path: `${outputRoot}\\night-drive-workbench.png`, fullPage: false });
    const themeToggle = page.locator(".top-icon").last();
    await themeToggle.click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await themeToggle.click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

    // The custom titlebar is part of the product, not decorative chrome.
    // Exercise the real Tauri window commands and confirm their native state.
    await page.getByRole("button", { name: "Maximize" }).click();
    await expect.poll(() => page.evaluate(async () => {
      const internals = (window as unknown as { __TAURI_INTERNALS__: TauriInternals }).__TAURI_INTERNALS__;
      return internals.invoke("plugin:window|is_maximized", { label: "main" });
    })).toBe(true);
    await page.getByRole("button", { name: "Maximize" }).click();
    await expect.poll(() => page.evaluate(async () => {
      const internals = (window as unknown as { __TAURI_INTERNALS__: TauriInternals }).__TAURI_INTERNALS__;
      return internals.invoke("plugin:window|is_maximized", { label: "main" });
    })).toBe(false);
    await auditBothThemes(page, "workbench-controls");
    await page.getByRole("button", { name: "Minimize", exact: true }).click();
    await expect.poll(() => invoke<boolean>(page, "plugin:window|is_minimized", { label: "main" })).toBe(true);
    await invoke(page, "plugin:window|unminimize", { label: "main" });
    await expect.poll(() => invoke<boolean>(page, "plugin:window|is_minimized", { label: "main" })).toBe(false);

    // Workspaces must be explicit: both test repositories are registered via
    // the actual desktop UI before a project-scoped action can write anything.
    for (const project of [fixtureProject, targetProject]) {
      const registered = await invoke<Array<{ workspace: { canonical_path: string } }>>(page, "list_workspaces_v2");
      if (registered.some((entry) => entry.workspace.canonical_path.toLocaleLowerCase() === project.toLocaleLowerCase())) continue;
      await page.locator(".atlas-add").click();
      const registration = page.locator(".mobius-modal[role=dialog]");
      await expect(registration).toBeVisible();
      await registration.locator("input").fill(project);
      await registration.locator("button.primary-button").click();
      await expect(registration).toBeHidden();
    }
    const health = await invoke<{ database_path: string }>(page, "health");
    expect(health.database_path).toContain(runName);

    await page.locator(".rail-item").nth(1).click();
    await expect(page.locator(".session-library-v2")).toBeVisible();
    await page.getByRole("button", { name: "Scan sessions" }).click();
    await expect(page.locator(".scan-status")).toBeHidden({ timeout: 20_000 });
    await page.locator(".session-tree-v2").getByRole("button", { name: "All sessions" }).click();
    // Registering more than one workspace must not cause the first-workspace
    // initializer to undo this explicit global scope selection.
    await expect(page.locator(".session-tree-v2 .session-scope")).toHaveClass(/active/);

    // Ordinary session browsing is deliberately not a Mome search.
    const search = page.locator(".session-search-v2 input");
    await search.fill(memoryMarker);
    await expect(page.locator(".session-list-row")).toHaveCount(4);
    await expect(page.locator(".session-list-row .match-marker")).toHaveCount(4);
    for (const provider of ["Codex", "Claude", "Pi", "Grok"]) {
      await expect(page.locator(".session-list-row", { has: page.locator(".provider-pill", { hasText: provider }) })).toHaveCount(1);
    }
    await expect(page.locator(".mome-dialog")).toHaveCount(0);
    await auditBothThemes(page, "session-library-controls");

    // Source manager changes only Möbius' isolated manifest. The extra root
    // is a copied fixture and is removed again after its scan is verified.
    await page.getByRole("button", { name: "Sources" }).click();
    const sources = page.locator(".session-sources-dialog");
    await expect(sources).toContainText("source files are never changed");
    let staleExtraSources = sources.locator(".source-list article", { hasText: "extra-codex-sessions" });
    while (await staleExtraSources.count()) {
      const staleCount = await staleExtraSources.count();
      await staleExtraSources.first().getByRole("button").click();
      await expect(staleExtraSources).toHaveCount(staleCount - 1);
      staleExtraSources = sources.locator(".source-list article", { hasText: "extra-codex-sessions" });
    }
    await expect.poll(() => sources.locator(".source-list article").count()).toBeGreaterThanOrEqual(4);
    const baselineSourceCount = await sources.locator(".source-list article").count();
    expect(baselineSourceCount).toBeGreaterThanOrEqual(4);
    await expect(sources).toContainText("Codex");
    await expect(sources).toContainText("Claude");
    await expect(sources).toContainText("Pi");
    await expect(sources).toContainText("Grok");
    await expect(sources.locator('.source-add option[value="apodex"]')).toHaveCount(0);
    await sources.locator(".source-add select").selectOption("codex");
    await sources.locator(".source-add input").fill(extraCodexRoot);
    await sources.locator(".source-add button.primary-button").click();
    await expect(sources.locator(".source-list article")).toHaveCount(baselineSourceCount + 1, { timeout: 20_000 });
    await search.fill(extraMarker);
    await expect(page.locator(".session-list-row")).toHaveCount(1, { timeout: 20_000 });
    await expect(page.locator(".session-list-row .match-marker")).toHaveCount(1, { timeout: 20_000 });
    // Tauri canonicalizes Windows roots to an extended-length `\\?\\` path.
    // Locate the approved fixture article by its stable leaf, rather than
    // assuming the display path preserves the input spelling.
    const extraSourceArticle = sources.locator(".source-list article", { hasText: "extra-codex-sessions" });
    await expect(extraSourceArticle).toHaveCount(1);
    await extraSourceArticle.getByRole("button").click();
    await expect(sources.locator(".source-list article")).toHaveCount(baselineSourceCount, { timeout: 20_000 });
    // A source refresh reloads results but must preserve the user's query and
    // open source-management context instead of remounting this whole page.
    await expect(search).toHaveValue(extraMarker);
    // The removed row had focus; document-level Escape must still close the
    // open dialog when its focused control is detached.
    await page.keyboard.press("Escape");
    await expect(sources).toBeHidden();

    // Search response visibly identifies the matching source message and
    // jumps the reader to it rather than only showing a session title.
    await search.fill(memoryMarker);
    // Session search is intentionally debounced. Wait for the post-removal
    // five-record result before selecting so a stale extra-source row cannot
    // be clicked while React is reconciling the result set.
    await expect(page.locator(".session-list-row")).toHaveCount(4);
    await expect(page.locator(".session-list-row .match-marker")).toHaveCount(4);
    const codexRow = page.locator(".session-list-row", { has: page.locator(".provider-pill.codex") });
    await expect(codexRow).toHaveCount(1);
    await codexRow.click();
    await expect(page.locator(".session-reader-v2 .message-stream-v2 article.has-search-match")).toContainText(memoryMarker);
    await page.getByRole("button", { name: "Copy precise reference" }).click();
    await expect(page.locator(".mobius-notice.success")).toContainText("Copied");
    await page.getByRole("button", { name: "Hand off to another Agent" }).click();
    const contextDialog = page.locator(".mobius-modal[role=dialog]");
    await expect(contextDialog.locator(".reference-preview code")).toContainText("@session:codex/");
    await contextDialog.getByLabel("Target Agent").selectOption("claude");
    await auditVisibleControls(page, "handoff-dialog");
    await contextDialog.getByRole("button", { name: "Copy handoff package" }).click();
    await expect(contextDialog.locator(".handoff-status")).toContainText("Handoff package copied");
    await page.keyboard.press("Escape");

    // The primary handoff action stays in the selected session's verified
    // project. Its default is the original Harness and must resume immediately
    // without opening a folder picker or asking for a second path decision.
    await page.getByRole("button", { name: "Hand off to another Agent" }).click();
    const sameAgentDialog = page.locator(".mobius-modal[role=dialog]");
    await expect(sameAgentDialog.getByLabel("Target Agent")).toHaveValue("codex");
    await sameAgentDialog.getByRole("button", { name: "Open Codex and hand off" }).click();
    await expect(page.locator(".terminal-page")).toBeVisible({ timeout: 12_000 });
    await expect.poll(() => snapshots(page), { timeout: 12_000 }).toContain("MOBIUS_NATIVE_RESUME_STUB");

    // Switching Harness is a separate choice in the same dialog. The target
    // opens directly in the same checkout and the reviewed packet becomes the
    // first explicit argument; there is still no folder-selection step.
    await page.locator(".rail-item").nth(1).click();
    await page.locator(".session-tree-v2").getByRole("button", { name: "All sessions" }).click();
    await page.locator(".session-search-v2 input").fill(memoryMarker);
    const codexAgain = page.locator(".session-list-row", { has: page.locator(".provider-pill.codex") });
    await expect(codexAgain).toHaveCount(1);
    await codexAgain.click();
    await page.getByRole("button", { name: "Hand off to another Agent" }).click();
    const crossAgentDialog = page.locator(".mobius-modal[role=dialog]");
    await crossAgentDialog.getByLabel("Target Agent").selectOption("claude");
    await crossAgentDialog.getByRole("button", { name: "Open Claude and hand off" }).click();
    await expect(page.locator(".terminal-page")).toBeVisible({ timeout: 12_000 });
    await expect.poll(() => snapshots(page), { timeout: 12_000 }).toContain("MÖBIUS HANDOFF");

    await page.locator(".rail-item").nth(1).click();
    await page.locator(".session-tree-v2").getByRole("button", { name: "All sessions" }).click();
    await page.locator(".session-search-v2 input").fill(memoryMarker);

    // Direct handoff is an explicit native operation: the reviewed packet is
    // passed as one quoted argument to the selected disposable Harness stub.
    const handoffMarker = `MOBIUS_DIRECT_HANDOFF_${Date.now()}`;
    await invoke<Terminal>(page, "start_agent_handoff", { provider: "codex", cwd: fixtureProject, packet: handoffMarker });
    await expect.poll(() => snapshots(page), { timeout: 12_000 }).toContain(handoffMarker);

    // Mome is opt-in. This call occurs only after the explicit button + query,
    // remains local BM25, and produces reviewable citations within its budget.
    await page.locator(".rail-item").nth(1).click();
    await expect(page.locator(".session-library-v2")).toBeVisible();
    await page.locator(".session-mome-trigger").click();
    const mome = page.locator(".mome-dialog");
    await expect(mome).toBeVisible();
    await mome.locator(".mome-query input").fill(memoryMarker);
    await mome.getByRole("button", { name: "Search locally" }).click();
    await expect(mome.locator(".mome-result")).toBeVisible({ timeout: 30_000 });
    await expect(mome).toContainText("local BM25 lexical recall");
    const momeResponse = await invoke<Mome>(page, "mome_recall_command", { request: { query: memoryMarker, workspace_id: null, checkout_id: null, providers: [], max_tokens: 1200 } });
    expect(momeResponse.semantic_status).toBe("lexical_only_no_semantic_backend_configured");
    expect(momeResponse.estimated_tokens).toBeLessThanOrEqual(1200);
    expect(momeResponse.sources.length).toBeGreaterThanOrEqual(1);
    expect(momeResponse.sources.length).toBeLessThanOrEqual(3);
    await page.keyboard.press("Escape");

    // Exact references are copied only. The dedicated picker must fit a large
    // desktop viewport, expose both actions, and never type into xterm.
    await page.locator(".rail-item").first().click();
    // The new workbench intentionally keeps Recent workspaces user-maintained,
    // so a fresh profile has no corridor card. Create the disposable terminal
    // in the fixture directory, then verify the persistent Terminals entry can
    // return to it after leaving the page.
    const acceptanceTerminalTitle = `Acceptance PowerShell ${Date.now()}`;
    const acceptanceTerminal = await invoke<Terminal>(page, "terminal_create", { cwd: fixtureProject, title: acceptanceTerminalTitle, initialCommand: null });
    await page.locator(".rail-item").nth(1).click();
    await page.locator(".rail-item").first().click();
    if (!await page.locator(".terminal-page").isVisible()) {
      await page.getByRole("button", { name: /Terminals/ }).click();
    }
    await expect(page.locator(".terminal-page")).toBeVisible();
    await page.locator(".terminal-tab-select", { hasText: acceptanceTerminalTitle }).click();
    const terminalInput = page.locator(".terminal-stage .xterm-helper-textarea");
    const plainMarker = `MOBIUS_FULL_NO_AUTO_MEMORY_${Date.now()}`;
    await terminalInput.focus();
    await terminalInput.pressSequentially(`Write-Output '${plainMarker}'`);
    await terminalInput.press("Enter");
    await expect.poll(() => terminalSnapshot(page, acceptanceTerminal.id), { timeout: 12_000 }).toContain(plainMarker);
    await expect.poll(() => terminalSnapshot(page, acceptanceTerminal.id), { timeout: 2_000 }).not.toContain(memoryMarker);
    await auditBothThemes(page, "terminal-controls");

    await page.setViewportSize({ width: 2048, height: 1095 });
    await page.locator(".terminal-context-action").click();
    const picker = page.locator(".mobius-modal[role=dialog]");
    await expect(picker).toBeVisible();
    const pickerSearch = picker.locator(".session-reference-search input");
    // The same native id exists in Codex, Claude, and Pi fixtures. A bare id
    // remains intentionally ambiguous; a provider-qualified @session ref is
    // the only route to the one exact record.
    await pickerSearch.fill("11111111-1111-4111-8111-111111111111");
    await expect(picker.locator(".session-reference-results button")).toHaveCount(3, { timeout: 15_000 });
    await expect(picker.locator(".session-reference-results")).toContainText("Codex");
    await expect(picker.locator(".session-reference-results")).toContainText("Claude");
    await expect(picker.locator(".session-reference-results")).toContainText("Pi");
    await pickerSearch.fill(exactRef);
    await expect(picker.locator(".session-reference-results button")).toHaveCount(1, { timeout: 15_000 });
    await expect(picker.locator(".session-reference-messages button.active")).toContainText("m0");
    const precise = picker.getByRole("button", { name: "Copy precise reference" });
    const packet = picker.getByRole("button", { name: "Copy context package" });
    await expect(precise).toBeVisible();
    await expect(packet).toBeVisible();
    await expect(precise).toBeEnabled();
    await expect(packet).toBeEnabled();
    const layout = await picker.evaluate((dialog) => {
      const pickerRoot = dialog.querySelector<HTMLElement>(".session-reference-picker");
      const columns = dialog.querySelector<HTMLElement>(".session-reference-columns");
      const rect = dialog.getBoundingClientRect();
      const inspect = (element: HTMLElement | null) => element ? ({ clientWidth: element.clientWidth, scrollWidth: element.scrollWidth, rect: element.getBoundingClientRect().toJSON() }) : null;
      return { viewport: { width: window.innerWidth, height: window.innerHeight }, dialog: inspect(dialog as HTMLElement), picker: inspect(pickerRoot), columns: inspect(columns), rect: rect.toJSON() };
    });
    expect(layout.dialog?.scrollWidth, "dialog must not require a horizontal scrollbar").toBeLessThanOrEqual((layout.dialog?.clientWidth ?? 0) + 1);
    expect(layout.picker?.scrollWidth, "reference picker must not overflow horizontally").toBeLessThanOrEqual((layout.picker?.clientWidth ?? 0) + 1);
    expect(layout.columns?.scrollWidth, "two panes must fit inside the modal").toBeLessThanOrEqual((layout.columns?.clientWidth ?? 0) + 1);
    await page.screenshot({ path: `${outputRoot}\\session-reference-picker-2048x1095.png`, fullPage: false });
    await precise.click();
    await expect(picker.locator(".session-reference-status")).toContainText("Copied");
    await packet.click();
    await expect(picker.locator(".session-reference-status")).toContainText("Copied");
    await page.keyboard.press("Escape");
    const freeTerminalSnapshot = await terminalSnapshot(page, acceptanceTerminal.id);
    expect(freeTerminalSnapshot).not.toContain(exactRef);
    expect(freeTerminalSnapshot).not.toContain("Use bounded local recall and explicit citations only.");

    // Interactive PowerShell must continue to function after resizing and an
    // interrupt, including literal Chinese input, while focus mode stays
    // escapable.
    await page.setViewportSize({ width: 1280, height: 760 });
    const chinese = "莫比乌斯终端中文验收";
    await terminalInput.focus();
    await terminalInput.pressSequentially(`Write-Output '${chinese}'`);
    await terminalInput.press("Enter");
    await expect.poll(() => snapshots(page), { timeout: 12_000 }).toContain(chinese);
    await terminalInput.focus();
    await terminalInput.pressSequentially("Start-Sleep -Seconds 20");
    await terminalInput.press("Enter");
    await page.waitForTimeout(450);
    await terminalInput.press("Control+C");
    const afterInterrupt = `MOBIUS_FULL_AFTER_CTRL_C_${Date.now()}`;
    await terminalInput.pressSequentially(`Write-Output '${afterInterrupt}'`);
    await terminalInput.press("Enter");
    await expect.poll(() => snapshots(page), { timeout: 12_000 }).toContain(afterInterrupt);
    await page.locator(".pagebar-actions").getByRole("button", { name: "Focus" }).click();
    await expect(page.locator(".mobius-app")).toHaveClass(/terminal-focus/);
    await page.keyboard.press("Escape");
    await expect(page.locator(".mobius-app")).not.toHaveClass(/terminal-focus/);

    // Same-Harness continuation is adapter-limited. A native Codex record can
    // create an original-Agent terminal; Grok truthfully refuses native resume.
    const sessionHits = await invoke<SessionHit[]>(page, "query_sessions", {
      query: { query: memoryMarker, workspace_id: null, checkout_id: null, providers: [], limit: 30 },
    });
    const codex = sessionHits.find((hit) => hit.session.provider === "codex")!;
    const claude = sessionHits.find((hit) => hit.session.provider === "claude")!;
    const grok = sessionHits.find((hit) => hit.session.provider === "grok")!;
    expect(codex.session.capabilities).toContain("native_resume");
    expect(claude.session.capabilities).toContain("native_resume");
    expect(grok.session.capabilities).not.toContain("native_resume");
    const terminalsBeforeCodexResume = await invoke<Terminal[]>(page, "terminal_list");
    const resumeTerminal = await invoke<Terminal>(page, "resume_session", { sessionId: codex.session.id });
    expect(resumeTerminal.title.toLocaleLowerCase()).toContain("codex");
    await expect.poll(() => snapshots(page), { timeout: 12_000 }).toContain("MOBIUS_NATIVE_RESUME_STUB");
    await expect.poll(() => snapshots(page), { timeout: 12_000 }).toContain(codex.session.provider_session_id);
    expect((await invoke<Terminal[]>(page, "terminal_list")).length).toBe(terminalsBeforeCodexResume.length + 1);
    const terminalsBeforeClaudeResume = await invoke<Terminal[]>(page, "terminal_list");
    const claudeTerminal = await invoke<Terminal>(page, "resume_session", { sessionId: claude.session.id });
    expect(claudeTerminal.cwd.toLowerCase()).toBe(fixtureProject.toLowerCase());
    await expect.poll(() => terminalSnapshot(page, claudeTerminal.id)).toContain("MOBIUS_CLAUDE_HANDOFF_STUB");
    expect((await invoke<Terminal[]>(page, "terminal_list")).length).toBe(terminalsBeforeClaudeResume.length + 1);
    await expect(invoke(page, "resume_session", { sessionId: grok.session.id })).rejects.toThrow(/inspection|handoff|native/i);

    // Cross-Harness continuation is deliberately copy-only. The old APIs
    // which could seed another provider's terminal are unavailable, while the
    // explicit context-package UI above remains reviewable and manual.
    for (const command of ["preview_handoff", "seal_handoff", "list_handoffs", "launch_handoff", "start_cross_agent_context"]) {
      const reason = await rejectedMessage(invoke(page, command, { request: {} }));
      expect(reason, `${command} must not remain callable`).toMatch(/unknown|not allowed|not found|not registered|command/i);
    }
    // A PowerShell snapshot may naturally receive the tail of a preceding
    // Ctrl+C command while this probe runs. Verify the actual safety boundary:
    // rejected legacy IPC must never write either an exact reference or a
    // generated context package into the terminal.
    const afterLegacyProbe = await terminalSnapshot(page, acceptanceTerminal.id);
    expect(afterLegacyProbe).not.toContain(exactRef);
    expect(afterLegacyProbe).not.toContain("Use bounded local recall and explicit citations only.");
    const workspaces = await invoke<WorkspaceView[]>(page, "list_workspaces_v2");

    // Markdown preview uses a logical read-only mount; its original input
    // remains byte-identical. The UI must render Markdown rather than raw text.
    await page.locator(".rail-item").nth(2).click();
    await expect(page.locator(".notes-library-v2")).toBeVisible({ timeout: 20_000 });
    const existingMount = page.locator(".library-mount-branch", { hasText: "Acceptance library" });
    if (await existingMount.count()) {
      await existingMount.getByTitle("Unmount").click();
      await expect(existingMount).toHaveCount(0);
    }
    await page.getByTitle("Mount folder").click();
    const mountDialog = page.locator(".mobius-modal[role=dialog]");
    await mountDialog.locator(".mount-dialog-v2 input").nth(0).fill(mountedLibrary);
    await mountDialog.locator(".mount-dialog-v2 input").nth(1).fill("Acceptance library");
    await mountDialog.getByRole("button", { name: "Mounted" }).click();
    await expect(mountDialog).toBeHidden();
    const mountedFile = page.locator(".library-tree-file", { hasText: "acceptance-markdown" });
    const mountToggle = page.locator(".library-mount-toggle", { hasText: "Acceptance library" });
    await expect(mountedFile).toBeVisible();
    await mountToggle.click();
    await expect(mountedFile).toBeHidden();
    await expect(mountToggle).toHaveAttribute("aria-expanded", "false");
    await mountToggle.click();
    await expect(mountedFile).toBeVisible();
    await expect(mountToggle).toHaveAttribute("aria-expanded", "true");
    await page.locator(".library-tree-file", { hasText: "acceptance-markdown" }).click();
    await expect(page.locator(".markdown-preview h1")).toContainText("Acceptance Markdown");
    await expect(page.locator(".markdown-preview strong")).toContainText("safe preview");
    await auditBothThemes(page, "library-controls");

    // The canvas is an unbounded media notebook: pasting prose, exact
    // references and URLs creates editable cards; local assets are copied into
    // the isolated vault and persist when the board is reopened.
    await page.getByRole("button", { name: "New canvas", exact: true }).click();
    const board = page.locator(".mobius-board");
    await expect(board).toBeVisible({ timeout: 20_000 });
    const canvasTitle = `full acceptance canvas ${runName} ${Date.now()}`;
    await board.getByLabel("Canvas title").fill(canvasTitle);
    const initialNodes = await board.locator(".mobius-node").count();
    await pasteIntoCanvas(page, "Pasted prose must become one editable text card.");
    await expect(board.locator(".text-node")).toHaveCount(1);
    await expect(board.locator(".text-node textarea")).toHaveValue("Pasted prose must become one editable text card.");
    await pasteIntoCanvas(page, exactRef);
    await expect(board.locator(".session-node")).toHaveCount(1);
    await expect(board.locator(".session-node")).toContainText(exactRef);
    // A trusted video provider receives its immediately-recognisable cover;
    // the iframe is still a deliberate play action rather than an implicit
    // player/network side effect of pasting the URL.
    await pasteIntoCanvas(page, "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    await expect(board.locator(".link-node")).toHaveCount(1);
    const youtubeLink = board.locator(".link-node.link-video", { hasText: "YouTube" });
    await expect(youtubeLink).toHaveCount(1);
    await expect(youtubeLink.locator(".link-card-image")).toHaveAttribute("src", /i\.ytimg\.com\/vi\/dQw4w9WgXcQ/);
    await youtubeLink.getByRole("button", { name: "Play embed" }).click();
    await expect(youtubeLink.locator("iframe.link-embed")).toHaveAttribute("src", /youtube-nocookie\.com\/embed\/dQw4w9WgXcQ/);

    // X is a provider-specific bookmark rather than a brittle HTML scrape.
    // It displays useful identity immediately and loads its trusted post frame
    // only after the person chooses to do so.
    await pasteIntoCanvas(page, "https://x.com/example/status/2096462732832772167");
    const xLink = board.locator(".link-node.provider-x");
    await expect(xLink).toHaveCount(1);
    // Newly pasted nodes can land beyond the current React Flow viewport. Fit
    // before invoking its visible opt-in control so this remains a real user
    // click, not a coordinate-dependent synthetic interaction.
    await board.getByRole("button", { name: "Fit canvas" }).click();
    await page.waitForTimeout(180);
    await xLink.getByRole("button", { name: "Load post preview" }).click();
    await expect(xLink.locator("iframe.link-embed")).toHaveAttribute("src", /platform\.twitter\.com\/embed\/Tweet\.html\?id=2096462732832772167/);

    // Ordinary web links are fetched by the bounded native metadata reader
    // and become a bookmark, rather than an opaque "offline" placeholder.
    await pasteIntoCanvas(page, "https://example.com/");
    await expect(board.locator(".link-node")).toHaveCount(3);
    const webLink = board.locator(".link-node.link-web", { hasText: "Example Domain" });
    await expect(webLink).toHaveCount(1, { timeout: 20_000 });
    await expect(webLink).not.toContainText("Offline card");
    // Verify the menu against a visible object. An infinite-canvas node can
    // legitimately be outside the viewport; in that case its menu is clamped
    // to the stage edge by design and cannot be judged against an offscreen
    // trigger coordinate.
    await board.getByRole("button", { name: "Fit canvas" }).click();
    await page.waitForTimeout(220);
    const actionTrigger = youtubeLink.getByRole("button", { name: "Object actions" });
    await actionTrigger.click();
    const actionMenu = board.locator(".board-object-menu");
    await expect(actionMenu).toBeVisible();
    await expect(actionMenu.getByRole("button", { name: "Refresh preview" })).toBeVisible();
    const [triggerBox, menuBox] = await Promise.all([actionTrigger.boundingBox(), actionMenu.boundingBox()]);
    expect(triggerBox && menuBox).toBeTruthy();
    expect(Math.abs((menuBox?.x ?? 0) - (triggerBox?.x ?? 0))).toBeLessThan(290);
    expect(Math.abs((menuBox?.y ?? 0) - (triggerBox?.y ?? 0))).toBeLessThan(300);
    // Keep the dismissal click within the pane at every viewport. The former
    // hard-coded 1120×640 location fell below the pane after the terminal test
    // intentionally reduced the window height, which made the acceptance test
    // wait for an impossible click rather than testing this interaction.
    await board.locator(".react-flow__pane").click({ position: { x: 16, y: 16 } });
    await expect(actionMenu).toHaveCount(0);
    const youtubeBox = await youtubeLink.boundingBox();
    expect(youtubeBox, "the visible card must have a viewport rectangle").toBeTruthy();
    // Target the card's plain domain header, not a nested iframe or input. It
    // is a physical right-click at a known on-screen point and therefore tests
    // the same bubble/capture route a person uses on the canvas.
    await page.mouse.click((youtubeBox?.x ?? 0) + 100, (youtubeBox?.y ?? 0) + 14, { button: "right" });
    await expect(actionMenu).toBeVisible();
    await expect(actionMenu.getByRole("button", { name: "Open original" })).toBeVisible();
    await board.locator(".react-flow__pane").click({ position: { x: 16, y: 16 } });
    await expect(actionMenu).toHaveCount(0);
    const imageInput = board.locator('input[type="file"]').nth(0);
    const videoInput = board.locator('input[type="file"]').nth(1);
    const genericFileInput = board.locator('input[type="file"]').nth(2);
    await imageInput.setInputFiles(`${runRoot}\\canvas-assets\\acceptance-image.png`);
    await videoInput.setInputFiles(`${runRoot}\\canvas-assets\\acceptance-video.mp4`);
    await genericFileInput.setInputFiles(`${runRoot}\\canvas-assets\\acceptance.pdf`);
    await expect(board.locator(".media-node.image")).toHaveCount(1, { timeout: 20_000 });
    await expect(board.locator(".media-node.video")).toHaveCount(1, { timeout: 20_000 });
    await expect(board.locator(".media-node.pdf")).toHaveCount(1, { timeout: 20_000 });
    await board.getByLabel("Nested canvas").click();
    await board.locator(".react-flow__pane").click({ position: { x: 940, y: 320 } });
    await expect(board.locator(".nested-board-node")).toHaveCount(1);
    await board.getByRole("button", { name: "Save" }).click();
    await expect(board.locator(".board-state")).toContainText("Saved");
    const persistedBoards = await invoke<Array<{ title: string; data: { scene?: { nodes?: Array<{ data?: { kind?: string } }> } } }>>(page, "list_boards");
    const persisted = persistedBoards.find((item) => item.title === canvasTitle);
    expect(persisted, "the new canvas must persist into the isolated vault").toBeTruthy();
    const kinds = persisted?.data.scene?.nodes?.map((node) => node.data?.kind) ?? [];
    for (const expected of ["text", "session", "link", "image", "video", "pdf", "board"]) expect(kinds).toContain(expected);
    await board.getByRole("button", { name: "Back to Library" }).click();
    await expect(page.locator(".notes-library-v2")).toBeVisible();
    await page.locator(".library-tree-file", { hasText: canvasTitle }).click();
    await expect(board.locator(".text-node")).toHaveCount(1);
    expect(await board.locator(".mobius-node").count()).toBeGreaterThan(initialNodes);
    await auditBothThemes(page, "canvas-controls");
    await page.screenshot({ path: `${outputRoot}\\canvas-rich-media-persistence.png`, fullPage: false });

    // Use the desktop Skills surface—not only IPC—to inspect, install, edit
    // and uninstall both kinds of managed copy. Originals remain in the
    // fixture and are covered by the source hashes below.
    const fixtureCheckout = workspaces.flatMap((workspace) => workspace.checkouts).find((checkout) => checkout.canonical_path.toLocaleLowerCase() === fixtureProject.toLocaleLowerCase());
    const targetCheckout = workspaces.flatMap((workspace) => workspace.checkouts).find((checkout) => checkout.canonical_path.toLocaleLowerCase() === targetProject.toLocaleLowerCase());
    expect(fixtureCheckout).toBeTruthy();
    expect(targetCheckout).toBeTruthy();
    await page.getByRole("button", { name: "Manage skills" }).click();
    const skills = page.locator(".skills-library-v2");
    await expect(skills).toBeVisible({ timeout: 20_000 });
    await auditBothThemes(page, "skills-controls");
    const skillSearch = skills.locator(".skills-search-v2 input");
    await skillSearch.fill("acceptance-global-source");
    const globalCard = skills.locator(".skill-card-v2", { hasText: "acceptance-global-source" });
    await expect(globalCard).toHaveCount(1);
    await globalCard.getByRole("button", { name: "View" }).click();
    const drawer = page.locator(".skill-drawer-v2");
    await expect(drawer).toContainText("acceptance-global-source");
    await expect(drawer.getByRole("button", { name: "Create editable copy" })).toBeEnabled();
    await drawer.getByRole("button", { name: "Create editable copy" }).click();
    const installDialog = page.locator(".mobius-modal[role=dialog]");
    await expect(installDialog).toContainText("Confirm managed skill install");
    await installDialog.getByRole("button", { name: "Install managed copy" }).click();
    await expect.poll(
      async () => (await invoke<ManagedSkill[]>(page, "list_managed_skills")).some((install) => install.target === "global"),
      { timeout: 15_000 },
    ).toBe(true);
    const globalManaged = (await invoke<ManagedSkill[]>(page, "list_managed_skills")).find((install) => install.target === "global");
    expect(globalManaged, "global managed copy must be recorded").toBeTruthy();
    const normalizeWindowsPath = (value: string) => value.replace(/[\\/]/g, "\\").toLocaleLowerCase();
    expect(normalizeWindowsPath(globalManaged?.destination ?? "")).toContain(
      normalizeWindowsPath(`${agentHome}\\.agents\\skills\\acceptance-global-source`),
    );
    await expect(drawer.getByRole("button", { name: "Open managed copy" })).toBeEnabled();
    await drawer.getByRole("button", { name: "Open managed copy" }).click();
    await expect(drawer.getByRole("button", { name: "Edit" })).toBeEnabled();
    await drawer.getByRole("button", { name: "Edit" }).click();
    await drawer.locator("textarea").fill("name: acceptance-global-source\n\n# Managed global\n\nEdited through the desktop UI in this fixture.");
    await drawer.getByRole("button", { name: "Save changes" }).click();
    await expect(drawer.getByRole("button", { name: "Uninstall managed copy" })).toBeEnabled();
    await drawer.getByRole("button", { name: "Uninstall managed copy" }).click();
    const uninstallDialog = page.locator(".mobius-modal[role=dialog]");
    await expect(uninstallDialog).toContainText("Confirm managed copy removal");
    await uninstallDialog.getByRole("button", { name: "Uninstall managed copy" }).click();
    await expect(drawer.getByRole("button", { name: "Create editable copy" })).toBeEnabled();
    await drawer.getByRole("button", { name: "Close" }).click();
    await expect(drawer).toHaveCount(0);

    // Project discovery is scoped to an explicit checkout. Install the
    // fixture's project skill into the other isolated checkout, edit it in
    // place via the same UI, and remove only that managed copy.
    await skills.locator(".skills-segment").getByRole("button", { name: "Project" }).click();
    await skills.locator(".skills-checkout-select select").selectOption(fixtureCheckout!.id);
    await skillSearch.fill("acceptance-project-skill");
    const projectCard = skills.locator(".skill-card-v2", { hasText: "acceptance-project-skill" });
    await expect(projectCard).toHaveCount(1);
    await projectCard.getByRole("button", { name: "View" }).click();
    await skills.getByLabel("Install target").selectOption(`project:${targetCheckout!.id}`);
    await expect(drawer.getByRole("button", { name: "Create editable copy" })).toBeEnabled();
    await drawer.getByRole("button", { name: "Create editable copy" }).click();
    await expect(page.locator(".mobius-modal[role=dialog]")).toContainText(targetProject);
    await page.locator(".mobius-modal[role=dialog]").getByRole("button", { name: "Install managed copy" }).click();
    await expect(drawer.getByRole("button", { name: "Open managed copy" })).toBeEnabled();
    await drawer.getByRole("button", { name: "Open managed copy" }).click();
    await drawer.getByRole("button", { name: "Edit" }).click();
    await drawer.locator("textarea").fill("name: acceptance-project-skill\n\n# Managed project\n\nFixture-only UI edit.");
    await drawer.getByRole("button", { name: "Save changes" }).click();
    await drawer.getByRole("button", { name: "Uninstall managed copy" }).click();
    await page.locator(".mobius-modal[role=dialog]").getByRole("button", { name: "Uninstall managed copy" }).click();
    await expect(drawer.getByRole("button", { name: "Create editable copy" })).toBeEnabled();
    expect(await invoke<Array<{ id: string }>>(page, "list_managed_skills")).toHaveLength(0);

    await drawer.getByRole("button", { name: "Close" }).click();
    await page.locator(".rail-item").nth(0).click();
    await page.getByRole("button", { name: "Workspaces", exact: true }).click();
    await page.locator(".atlas-project-button").and(page.getByTitle(fixtureProject, { exact: true })).click();
    await page.getByRole("button", { name: "Handoff graph" }).click();
    await expect(page.locator(".workspace-relay-graph")).toHaveCount(1);
    await expect(page.locator(".relay-edge").first()).toBeVisible();
    expect(await page.locator(".relay-edge > button").first().evaluate((node) => node.getBoundingClientRect().width)).toBeGreaterThan(150);
    await auditBothThemes(page, "handoff-graph-controls");
    await page.locator(".relay-edge > button").first().click();
    await expect(page.locator(".session-library-v2")).toBeVisible();

    for (const [path, expected] of hashesBefore) expect(sha256(path), `source transcript changed: ${path}`).toBe(expected);
    expect(pageErrors, pageErrors.join("\n")).toEqual([]);
  } finally {
    await browser.close();
  }
});
