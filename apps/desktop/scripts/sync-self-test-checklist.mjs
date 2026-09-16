#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const jsonPath = resolve(root, "docs/acceptance/self-test-checklist.json");
const mdPath = resolve(root, "docs/acceptance/self-test-checklist.md");
const data = JSON.parse(readFileSync(jsonPath, "utf8"));

const lines = [
  `# ${data.product} self-test checklist`,
  "",
  `Revision **${data.revision}**. Updated ${data.updated}.`,
  "",
  "JSON is the source of truth: `docs/acceptance/self-test-checklist.json`.",
  "Regenerate this file with `node apps/desktop/scripts/sync-self-test-checklist.mjs`.",
  "",
  "## Update policy",
  "",
  ...data.update_policy.map((rule) => `- ${rule}`),
  "",
  "## Fixture",
  "",
  `| Field | Path |`,
  `|---|---|`,
  `| Workspace | \`${data.fixture.workspace}\` |`,
  `| Harness home | \`${data.fixture.harness_home}\` |`,
  `| Isolated run | \`${data.fixture.run_root}\` |`,
  "",
];

let total = 0;
for (const group of data.groups) {
  lines.push(`## ${group.id} · ${group.title}`, "");
  lines.push("| ID | Check | Expected | Locator |");
  lines.push("|---|---|---|---|");
  for (const item of group.items) {
    total += 1;
    lines.push(`| ${item.id} | ${item.name} | ${item.expect.replaceAll("|", "\\|")} | \`${item.locator ?? "—"}\` |`);
  }
  lines.push("");
}

lines.push(`Total rows: **${total}**.`, "");
writeFileSync(mdPath, `${lines.join("\n")}\n`);
console.log(`wrote ${mdPath} (${total} rows)`);
