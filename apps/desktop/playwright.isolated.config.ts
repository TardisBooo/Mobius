import { defineConfig } from "@playwright/test";
import { existsSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";

const verificationRoot = resolve("E:\\Workspaces\\Mobius-Verification-20260907");
const testRootInput = process.env.MOBIUS_TEST_ROOT;
const outputDir = process.env.MOBIUS_PLAYWRIGHT_OUTPUT;
if (!testRootInput || !outputDir) {
  throw new Error("MOBIUS_TEST_ROOT and MOBIUS_PLAYWRIGHT_OUTPUT are required for an isolated smoke run");
}
const testRoot = resolve(testRootInput);
const resolvedOutput = resolve(outputDir);
const outputRelative = relative(testRoot, resolvedOutput);
if (testRoot !== verificationRoot || !existsSync(testRoot) || !statSync(testRoot).isDirectory()) {
  throw new Error(`MOBIUS_TEST_ROOT must be the isolated verification root: ${verificationRoot}`);
}
if (outputRelative.startsWith("..") || outputRelative.includes(":")) {
  throw new Error("MOBIUS_PLAYWRIGHT_OUTPUT must remain inside MOBIUS_TEST_ROOT");
}

export default defineConfig({
  testDir: "./tests",
  testMatch: "mobius.isolated.smoke.spec.ts",
  timeout: 45_000,
  workers: 1,
  outputDir: resolvedOutput,
  use: { viewport: { width: 1500, height: 940 }, screenshot: "only-on-failure" },
  reporter: [["list"]],
});
