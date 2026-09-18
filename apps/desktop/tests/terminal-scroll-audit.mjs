// One-shot CDP audit: the terminal viewport must scroll overflow history
// with the mouse wheel, including when a running TUI enables mouse
// reporting (DECSET 1000/1006), which makes stock xterm hand the wheel to
// the app and stops viewport scrolling. Run against the installed build:
//   $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9360"
//   Start-Process E:\SOFTWARE\Mobius\mobius-desktop.exe
//   node tests/terminal-scroll-audit.mjs
import { chromium } from "@playwright/test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const endpoint = process.env.MOBIUS_SCROLL_CDP ?? "http://127.0.0.1:9360";
const outputRoot = join(process.cwd(), "test-results", "terminal-scroll-audit");
mkdirSync(outputRoot, { recursive: true });

const invoke = (page, command, args) => page.evaluate(async ({ command, args }) => {
  const internals = window.__TAURI_INTERNALS__;
  if (!internals) throw new Error("Tauri IPC bridge is unavailable");
  return internals.invoke(command, args);
}, { command, args });

const snapshot = async (page, id) => (await invoke(page, "terminal_snapshot", { id })).data;

// The internal xterm 6 scrollbar slider reflects the live scroll position
// even while the scrollbar is visually faded out.
const sliderState = (page) => page.locator(".terminal-stage").evaluate((stage) => {
  const slider = stage.querySelector(".xterm-scrollable-element .scrollbar.vertical .slider");
  const screen = stage.querySelector(".xterm-screen");
  const xterm = stage.querySelector(".xterm");
  if (!slider || !screen || !xterm) return null;
  const top = parseFloat(slider.style.top || "0");
  const height = parseFloat(slider.style.height || "0");
  return {
    sliderTop: Number.isFinite(top) ? top : null,
    sliderHeight: Number.isFinite(height) ? height : null,
    stageHeight: stage.clientHeight,
    stageWidth: stage.clientWidth,
    screenRect: screen.getBoundingClientRect().toJSON(),
    xtermRect: xterm.getBoundingClientRect().toJSON(),
  };
});

const assert = (condition, label) => {
  if (!condition) throw new Error(`AUDIT FAILED: ${label}`);
  console.log(`  ok: ${label}`);
};

const browser = await chromium.connectOverCDP(endpoint);
const page = browser.contexts().flatMap((context) => context.pages()).find((candidate) => candidate.url().includes("tauri.localhost"));
if (!page) throw new Error("Möbius WebView page is unavailable");
page.setDefaultTimeout(20_000);
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });

const fixture = mkdtempSync(join(tmpdir(), "mobius-scroll-audit-"));
writeFileSync(join(fixture, "audit.txt"), "terminal scroll audit fixture\n", "utf8");

try {
  await page.evaluate(() => {
    localStorage.setItem("mobius.onboarding.complete", "1");
    localStorage.setItem("mobius.theme", "light");
    localStorage.setItem("mobius.locale.v2", "en");
  });
  await page.reload();

  // Terminals survive page reloads in the backend; clear stale audit tabs.
  const stale = await invoke(page, "terminal_list", {});
  for (const item of stale) {
    if (item.title === "scroll-audit") await invoke(page, "terminal_close", { id: item.id }).catch(() => {});
  }

  // Create the terminal before mounting the terminal page; the page reads
  // the terminal list on mount and does not watch for new ones.
  const terminal = await invoke(page, "terminal_create", { cwd: fixture, title: "scroll-audit", initialCommand: null });

  // Open the terminal workbench.
  await page.locator(".rail-item").nth(1).click();
  if (!(await page.locator(".terminal-page").isVisible())) {
    await page.getByRole("button", { name: /Terminals/ }).click();
  }
  await page.locator(".terminal-page").waitFor();
  await page.locator(".terminal-tab-select", { hasText: "scroll-audit" }).click();
  await page.locator(".terminal-stage .xterm-helper-textarea").focus();

  // Produce far more output than one screen: unique markers per line.
  await page.keyboard.type("1..200 | ForEach-Object { \"SCROLLFIX-{0:D3}\" -f $_ }", { delay: 2 });
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector(".terminal-stage")?.textContent?.includes("SCROLLFIX-200") ?? false, null, { timeout: 20_000 });

  const before = await sliderState(page);
  assert(before !== null, "xterm internal scrollbar slider is present");
  console.log(`  metrics: stage=${before.stageWidth}x${before.stageHeight} screen=${Math.round(before.screenRect.width)}x${Math.round(before.screenRect.height)} sliderTop=${before.sliderTop} sliderHeight=${before.sliderHeight}`);
  assert(before.screenRect.height <= before.stageHeight + 1, "rendered screen fits inside the pinned stage (no runaway FitAddon rows)");

  const canvasCenter = { x: before.xtermRect.x + before.xtermRect.width / 2, y: before.xtermRect.y + before.xtermRect.height / 2 };

  // 1. Plain wheel-up over fresh PowerShell output must scroll history.
  await page.mouse.move(canvasCenter.x, canvasCenter.y);
  await page.mouse.wheel(0, -240);
  await page.waitForTimeout(300);
  const afterUp = await sliderState(page);
  assert(afterUp.sliderTop !== null && before.sliderTop !== null && afterUp.sliderTop < before.sliderTop, `wheel-up scrolls viewport back in history (slider ${before.sliderTop} -> ${afterUp.sliderTop})`);
  await page.screenshot({ path: join(outputRoot, "01-wheel-up-native.png") });

  // Return to the bottom for the next phase.
  await page.mouse.wheel(0, 6000);
  await page.waitForTimeout(300);

  // 2. A running TUI that enables mouse reporting (the dead-wheel case).
  await page.keyboard.type("[Console]::Write([string]([char]27) + \"[?1000h\" + [string]([char]27) + \"[?1006h\")", { delay: 2 });
  await page.keyboard.press("Enter");
  await page.waitForTimeout(400);
  const hijackBefore = await sliderState(page);
  await page.mouse.wheel(0, -240);
  await page.waitForTimeout(300);
  const hijackAfter = await sliderState(page);
  assert(hijackAfter.sliderTop < hijackBefore.sliderTop, `wheel-up still scrolls while an app holds mouse reporting (slider ${hijackBefore.sliderTop} -> ${hijackAfter.sliderTop})`);
  await page.screenshot({ path: join(outputRoot, "02-wheel-up-mouse-mode.png") });
  await page.keyboard.type("[Console]::Write([string]([char]27) + \"[?1000l\" + [string]([char]27) + \"[?1006l\")", { delay: 2 });
  await page.keyboard.press("Enter");

  // 3. Alternate-screen apps keep xterm's arrow-key wheel translation.
  await page.waitForTimeout(400);
  await page.keyboard.type("[Console]::Write([string]([char]27) + \"[?1049h\")", { delay: 2 });
  await page.keyboard.press("Enter");
  await page.waitForTimeout(400);
  const altBefore = await sliderState(page);
  await page.mouse.wheel(0, -240);
  await page.waitForTimeout(300);
  const altAfter = await sliderState(page);
  assert(altAfter.sliderTop === altBefore.sliderTop, "wheel passes through to alternate-screen apps (no viewport hijack)");
  await page.keyboard.type("[Console]::Write([string]([char]27) + \"[?1049l\")", { delay: 2 });
  await page.keyboard.press("Enter");
  await page.waitForTimeout(400);

  // 4. The terminal survives and stays interactive.
  const marker = `SCROLL_AUDIT_ALIVE_${Date.now()}`;
  await page.keyboard.type(`Write-Output '${marker}'`, { delay: 2 });
  await page.keyboard.press("Enter");
  await page.waitForFunction((needle) => document.querySelector(".terminal-stage")?.textContent?.includes(needle) ?? false, marker.slice(0, 18), { timeout: 10_000 });
  assert(true, "terminal stays interactive after scrolling phases");
  const finalSnapshot = await snapshot(page, terminal.id);
  assert(finalSnapshot.includes("SCROLLFIX-200"), "PTY snapshot still holds the full history");

  if (errors.length) throw new Error(`console errors during audit:\n${errors.join("\n")}`);
  console.log("TERMINAL SCROLL AUDIT PASSED");
} finally {
  await browser.close();
}
