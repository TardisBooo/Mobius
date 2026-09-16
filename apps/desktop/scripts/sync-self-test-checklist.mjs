#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const jsonPath = resolve(root, "docs/acceptance/self-test-checklist.json");
const mdPath = resolve(root, "docs/acceptance/self-test-checklist.md");
const specPath = resolve(root, "apps/desktop/tests/self-test-checklist.spec.ts");
const cargoPath = resolve(root, "Cargo.toml");
const checkOnly = process.argv.includes("--check");
const data = JSON.parse(readFileSync(jsonPath, "utf8"));

function markdownFor(doc) {
  const lines = [
    `# ${doc.product} self-test checklist`,
    "",
    `Revision **${doc.revision}**. Updated ${doc.updated}.`,
    "",
    "JSON is the source of truth: `docs/acceptance/self-test-checklist.json`.",
    "Regenerate this file with `node apps/desktop/scripts/sync-self-test-checklist.mjs`.",
    "Verify with `node apps/desktop/scripts/sync-self-test-checklist.mjs --check`.",
    "",
    "## Update policy",
    "",
    ...doc.update_policy.map((rule) => `- ${rule}`),
    "",
    "## Fixture",
    "",
    `| Field | Path |`,
    `|---|---|`,
    `| Workspace | \`${doc.fixture.workspace}\` |`,
    `| Harness home | \`${doc.fixture.harness_home}\` |`,
    `| Isolated run | \`${doc.fixture.run_root}\` |`,
    "",
  ];

  let total = 0;
  const ids = [];
  for (const group of doc.groups) {
    lines.push(`## ${group.id} · ${group.title}`, "");
    lines.push("| ID | Check | Expected | Locator |");
    lines.push("|---|---|---|---|");
    for (const item of group.items) {
      total += 1;
      ids.push(item.id);
      lines.push(`| ${item.id} | ${item.name} | ${item.expect.replaceAll("|", "\\|")} | \`${item.locator ?? "—"}\` |`);
    }
    lines.push("");
  }

  lines.push(`Total rows: **${total}**.`, "");
  return { markdown: `${lines.join("\n")}\n`, total, ids };
}

function cargoVersion() {
  const match = readFileSync(cargoPath, "utf8").match(/\[workspace\.package\][\s\S]*?^version = "([^"]+)"/m);
  if (!match) throw new Error("workspace version missing from Cargo.toml");
  return match[1];
}

const { markdown, total, ids } = markdownFor(data);
const errors = [];
const unique = new Set(ids);
if (unique.size !== ids.length) errors.push(`duplicate checklist ids: ${ids.filter((id, index) => ids.indexOf(id) !== index).join(", ")}`);
if (data.revision !== cargoVersion()) errors.push(`checklist revision ${data.revision} does not match Cargo.toml ${cargoVersion()}`);
if (!Array.isArray(data.update_policy) || data.update_policy.length < 3) errors.push("update_policy is missing");
if (!data.fixture?.workspace || !data.fixture?.harness_home) errors.push("fixture paths are required");

const spec = readFileSync(specPath, "utf8");
for (const needle of [
  "Handoff graph",
  "Close dialog",
  "Register workspace",
  "Session sources",
  "Back to Library",
  "Preview settings",
]) {
  if (!spec.includes(needle)) errors.push(`Playwright spec is missing locator text: ${needle}`);
}

if (checkOnly) {
  const current = readFileSync(mdPath, "utf8");
  if (current !== markdown) errors.push("self-test-checklist.md is stale; run pnpm --dir apps/desktop sync:checklist");
  if (errors.length) {
    console.error(errors.map((item) => `error: ${item}`).join("\n"));
    process.exit(1);
  }
  console.log(`checklist ok (${total} rows, revision ${data.revision})`);
  process.exit(0);
}

if (errors.length) {
  console.error(errors.map((item) => `error: ${item}`).join("\n"));
  process.exit(1);
}

writeFileSync(mdPath, markdown);
console.log(`wrote ${mdPath} (${total} rows)`);
