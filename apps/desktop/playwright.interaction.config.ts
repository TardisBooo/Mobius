import { defineConfig } from "@playwright/test";
import { existsSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";

const verificationRoot = resolve("E:\\Workspaces\\_verification");
const testRoot = resolve(process.env.MOBIUS_TEST_ROOT ?? "");
const outputDir = resolve(process.env.MOBIUS_PLAYWRIGHT_OUTPUT ?? "");
const relativeOutput = relative(testRoot, outputDir);
const relativeRoot = relative(verificationRoot, testRoot);
if (!relativeRoot || relativeRoot.startsWith("..") || relativeRoot.includes(":")) throw new Error(`MOBIUS_TEST_ROOT must be a named directory below ${verificationRoot}`);
if (!existsSync(testRoot) || !statSync(testRoot).isDirectory()) throw new Error("MOBIUS_TEST_ROOT must exist and be a directory");
if (!outputDir || relativeOutput.startsWith("..") || relativeOutput.includes(":")) throw new Error("MOBIUS_PLAYWRIGHT_OUTPUT must remain inside the isolated verification root");

export default defineConfig({
  testDir: "./tests",
  testMatch: "interaction-regression.spec.ts",
  timeout: 45_000,
  workers: 1,
  outputDir,
  use: { viewport: { width: 1500, height: 940 }, screenshot: "only-on-failure" },
  reporter: [["list"]],
});
