import { defineConfig } from "@playwright/test";
import { existsSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";

const verificationRoot = resolve("E:\\Workspaces\\Mobius-Verification-20260907");
const testRootInput = process.env.MOBIUS_TEST_ROOT;
const outputInput = process.env.MOBIUS_PLAYWRIGHT_OUTPUT;
if (!testRootInput) {
  throw new Error("MOBIUS_TEST_ROOT is required; default smoke never targets a user project.");
}
if (!outputInput) {
  throw new Error("MOBIUS_PLAYWRIGHT_OUTPUT is required and must be a fresh directory under MOBIUS_TEST_ROOT.");
}
const testRoot = resolve(testRootInput);
const outputDir = resolve(outputInput);
const within = (candidate: string, parent: string) => {
  const value = relative(parent, candidate);
  return value === "" || (!value.startsWith("..") && !value.includes(":"));
};
if (testRoot !== verificationRoot || !existsSync(testRoot) || !statSync(testRoot).isDirectory()) {
  throw new Error(`MOBIUS_TEST_ROOT must be the isolated verification root: ${verificationRoot}`);
}
if (!within(outputDir, testRoot)) {
  throw new Error("MOBIUS_PLAYWRIGHT_OUTPUT must remain inside MOBIUS_TEST_ROOT.");
}

export default defineConfig({
  testDir: "./tests",
  testMatch: "mobius.isolated.smoke.spec.ts",
  timeout: 45_000,
  workers: 1,
  outputDir,
  use: { viewport: { width: 1500, height: 940 }, screenshot: "only-on-failure" },
  reporter: [["list"]]
});
