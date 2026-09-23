import { defineConfig } from "@playwright/test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const auditRoot = process.env.MOBIUS_AUDIT_ROOT;
if (!auditRoot || !/^E:\\Workspaces\\_audits\\mobius-[^\\]+$/i.test(resolve(auditRoot)) || !existsSync(auditRoot)) {
  throw new Error("MOBIUS_AUDIT_ROOT must be an existing named Möbius audit under E:\\Workspaces\\_audits");
}
if (!process.env.MOBIUS_CODEX_SHELL_CDP) {
  throw new Error("MOBIUS_CODEX_SHELL_CDP must target an isolated Tauri WebView2 debug port");
}
export default defineConfig({
  testDir: "./tests",
  testMatch: "codex-shell.desktop.spec.ts",
  timeout: 45_000,
  workers: 1,
  outputDir: resolve(auditRoot, "playwright"),
  use: { screenshot: "only-on-failure" },
  reporter: [["list"]],
});
