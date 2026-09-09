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
if (!/^[a-z0-9-]+$/i.test(runName)) {
  throw new Error("MOBIUS_DESKTOP_SMOKE_RUN must be a simple fresh run directory name");
}
if (!inside(outputDir, resolve(verificationRoot, "runs", runName))) {
  throw new Error("MOBIUS_PLAYWRIGHT_OUTPUT must remain under this run's fresh verification directory");
}

export default defineConfig({
  testDir: "./tests",
  testMatch: "mobius.v03.desktop.spec.ts",
  timeout: 75_000,
  workers: 1,
  outputDir,
  use: { viewport: { width: 1500, height: 940 }, screenshot: "only-on-failure" },
  reporter: [["list"]],
});
