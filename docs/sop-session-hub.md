# SOP — Möbius Agent Session Hub

Use this when shipping desktop, CLI or MCP changes that touch sessions.

## Frozen contract

1. Do not modify harness source, launchers, model config or original transcripts.
2. Session history is never summarized as the handoff payload.
3. A Session is identity + trajectory, not a directory or a process.
4. MCP cannot mint approvals, add sources, or attach a PTY.

## Change types

| Change | Where | Gate |
| --- | --- | --- |
| Adapter / indexer | core crate | `cargo test --offline` |
| Recall / embeddings | `mome.rs`, `embedding.rs`, CLI `mome semantic` | lexical still works with Ollama absent |
| Lineage / handoff | `lineage.rs`, `mobius-connect` | manifest `content_mode` is `references_only` |
| MCP tools | `mobius-connect mcp serve` | same tool names; no self-grant |
| Desktop UI | `apps/desktop` | self-test checklist + both viewports if layout changed |
| Public copy | README, `llms.txt`, website, `docs/gtm/launch.md` | facts match the code, including OpenCode and hybrid status; do not claim OpenClaw |

## Release order

1. Core tests.
2. Desktop CLI/MCP and `mobius-connect` tests.
3. Isolated `--data-root` handoff: init → add source → search → graph → prepare → human APPROVE → commit.
4. Confirm original source mtime/size unchanged.
5. Rewrite README / `llms.txt` only after the behaviour exists.
6. Keep desktop (`TardisBooo/Mobius`) and CLI/MCP (`TardisBooo/mobius-connect`) READMEs in the same Agent Session Hub voice. Public repo map: `docs/REPOS.md`.

## Do not ship

- Silent embedding downloads.
- Claiming hybrid recall when the model is not wired.
- Treating `awaiting_identity` as a finished handoff.
- SessionStart hooks that inject history.
- Social posts (X / HN / r/ClaudeCode) before a person reviews the 60-second GIF and confirms posting. Drafts: `docs/gtm/launch.md`. GIF: `apps/website/public/product/session-hub-60s.gif`.
