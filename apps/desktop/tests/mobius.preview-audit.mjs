import { chromium } from "@playwright/test";
import path from "node:path";

const baseUrl = process.env.MOBIUS_PREVIEW_URL ?? "http://127.0.0.1:5174";
const outputPath = process.env.MOBIUS_PREVIEW_SCREENSHOT;
if (!outputPath) throw new Error("MOBIUS_PREVIEW_SCREENSHOT must be an isolated verification path");
const verificationRoot = path.resolve("E:/Workspaces/Mobius-Verification-20260907");
if (!path.resolve(outputPath).startsWith(`${verificationRoot}${path.sep}`)) {
  throw new Error("Preview evidence must remain inside the Möbius verification root");
}
const parsedOutput = path.parse(outputPath);
const canvasOutputPath = path.join(parsedOutput.dir, `${parsedOutput.name}-canvas${parsedOutput.ext}`);

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text());
});

await page.goto(baseUrl, { waitUntil: "networkidle" });

// A fresh preview context correctly opens first-run onboarding. Verify the
// dialog is present, then use its real Escape interaction before exercising
// the rest of the desktop surface. Do not bypass the overlay with force clicks.
const onboarding = page.locator(".onboarding[role=dialog]");
await onboarding.waitFor({ state: "visible" });
await page.keyboard.press("Escape");
await onboarding.waitFor({ state: "hidden" });

const libraryButton = page.locator(".rail-item").filter({ hasText: /资料|Library/ });
await libraryButton.click();
await page.getByRole("button", { name: /新建画布|New canvas/ }).click();
const board = page.locator(".mobius-board");
await board.waitFor({ state: "visible" });
const bounds = await board.boundingBox();
if (!bounds || bounds.width < 1100 || bounds.height < 700) {
  throw new Error(`Freeform canvas did not receive the primary workspace: ${JSON.stringify(bounds)}`);
}

const toolbar = page.locator(".board-toolbar");
const pane = page.locator(".react-flow__pane");
await toolbar.getByRole("button", { name: /随笔 \(N\)|Sticky note \(N\)/ }).click();
await page.waitForTimeout(80);
await pane.click({ position: { x: 260, y: 260 } });
await toolbar.getByRole("button", { name: /分区|Section/ }).click();
await page.waitForTimeout(80);
await pane.click({ position: { x: 560, y: 330 } });
await toolbar.getByRole("button", { name: /网页链接|Web link/ }).click();
await page.waitForTimeout(80);
await pane.click({ position: { x: 90, y: 100 } });
await page.waitForTimeout(80);
const linkComposer = page.locator(".board-modal");
await linkComposer.getByRole("textbox").fill("https://example.com/reference");
await linkComposer.getByRole("button", { name: /加入画布|Add to canvas/ }).click();
await page.screenshot({ path: canvasOutputPath, fullPage: false });

await page.getByRole("button", { name: /会话|Sessions/ }).first().click();
await page.locator(".session-library-v2").waitFor({ state: "visible" });

if (errors.length) throw new Error(errors.join("\n"));
await page.screenshot({ path: outputPath, fullPage: false });
console.log(JSON.stringify({ canvas: bounds, errors, title: await page.title() }));
await browser.close();
