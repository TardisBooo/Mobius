import { defineConfig } from "@playwright/test";
import { existsSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";

const verificationRoot = resolve("E:\\Workspaces\\Mobius-Verification-20260907-v03");
const testRoot = resolve(process.env.MOBIUS_TEST_ROOT ?? "");
const outputDir = resolve(process.env.MOBIUS_PLAYWRIGHT_OUTPUT ?? "");
const runName = process.env.MOBIUS_DESKTOP_SMOKE_RUN ?? "";
const inside = (candidate: string, parent: string) => {
  const value = relative(parent, candidate);
  return value === "" || (!value.startsWith("..") && !value.includes(":"));
};

if (testRoot !== verificationRoot || !existsSync(testRoot) || !statSync(testRoot).isDirectory()) {
  throw new Error(`MOBIUS_TEST_ROOT must be ${verificationRoot}`);
}
if (!/^[a-z0-9-]+$/i.test(runName)) throw new Error("MOBIUS_DESKTOP_SMOKE_RUN must name a simple fresh directory");
if (!inside(outputDir, resolve(verificationRoot, "runs", runName))) throw new Error("MOBIUS_PLAYWRIGHT_OUTPUT must remain below this fresh test run");

export default defineConfig({
  testDir: "./tests",
  testMatch: "mobius.full.desktop.spec.ts",
  // The spec sets the same ceiling explicitly. Keep the config aligned so a
  // full desktop acceptance flow is not terminated halfway through its later
  // media and managed-skill checks.
  timeout: 360_000,
  use: { viewport: { width: 1500, height: 940 }, screenshot: "only-on-failure", actionTimeout: 10_000 },
  workers: 1,
  outputDir,
  reporter: [["list"]],
});
