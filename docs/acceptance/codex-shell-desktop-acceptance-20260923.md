# Möbius Codex-style desktop acceptance — 2026-09-23

Status: **partial acceptance; release gate not passed**. This report covers the
current development build, not the maintained `E:\SOFTWARE\Mobius` installation.

## Isolation and evidence

- Repository: `E:\Workspaces\Mobius\repos\desktop`.
- Actual Tauri/WebView2 debug executable: `target\debug\mobius-desktop.exe`.
- Test workspace, database, Harness homes, WebView2 profile, screenshots, and
  Playwright output: `E:\Workspaces\_audits\mobius-codex-shell-20260923`.
- The audit registered `qa-isolated` directory and a project-private `qa-private`
  Skill. The Skill's managed copy was installed and uninstalled; its source
  remained unchanged. Synthetic source transcripts remain only in this audit.
- Six 2026-09-23 Codex transcript files were indexed from the maintained Codex
  home **read-only**. Three aquant graph relations and their necessary Session
  metadata were copied from the production Möbius database into the audit DB
  using `graph-fixture.sql`; no message bodies were copied and the source DB was
  attached read-only. The graph source files are not approved in the audit DB,
  so nodes correctly show an unauthorized/unavailable source status.
- This audit tree is **retained for review**, not an accepted distributable or
  deletion candidate. The maintained installation and desktop shortcut were
  not changed.
- A second audit, `E:\Workspaces\_audits\mobius-cross-harness-20260923`,
  used a new **empty** `workspace` directory. It remained empty after the
  native tests. Möbius state and handoff packets stayed in its separate
  `app-isolated` subtree. Official Harness CLIs created only new native test
  Session records; no existing project, Harness executable/configuration, or
  historical transcript was edited.

## Passing checks

| Surface | Actual verification |
| --- | --- |
| Build/core | `npm run build:desktop`, `cargo test --workspace` (85 core unit tests plus desktop/CLI/MCP/integration checks), and `npm run test:window-drag` passed. One separately provisioned isolated-acceptance fixture is explicitly ignored. |
| Desktop regression | `npx playwright test --config playwright.codex-shell.config.ts`: **18/18 passed** serially on the isolated Tauri WebView2 after the final fixes. |
| Shell/navigation | Collapsible sidebar, `Ctrl+K`, project direct-open, Library/session round-trip, onboarding/Escape, theme and language persistence, named controls and 1100×720 root overflow. |
| Session catalogue | agentTect approved Grok sample: 54 records, 7 roots, 47 children; child records remain discoverable. Separate same-name directories remain path-distinct. Project sorting matches latest root conversation activity, not scan time. Sidebar shows time, Harness and checkout folder. |
| Search/naming | Content search lands on and expands the exact message; manual aliases remain editable/searchable. Harness wrappers and Claude sidecar metadata are not mislabelled as sessions. |
| Sources/memory | Approved Codex root add → index → remove round-trip; source transcript unchanged. Memory search returns an explicit local result. Last refresh: 280 discovered, 0 index errors beyond one real Claude JSONL with no shareable messages. |
| Library/editor | Private note create/preview/return/trash/restore; mounted text explicit save; live tree add and delete while an editor buffer is dirty; external-edit conflict refuses overwrite. |
| Canvas | Object creation, save, leave and reopen preserves the object. |
| Skills | Skill market and installed views are distinct; project-private Skill is discoverable. Managed project copy install/uninstall leaves original unchanged. Checkout labels include project, branch/kind and full path. |
| Terminal | New PowerShell starts in the selected audit project, accepts input, returns output and closes. |
| Handoff/graph | Handoff review generates exact `@session` references without launching a Harness. Real copied graph shows 3 nodes, 1 verified edge, and pending-target warning. Layout, compact nodes and graph/list mode persist. |
| Live cross-Harness chain | In the empty audit project, one short Codex probe was handed to Pi, then Claude, then Grok Build. The four native Session IDs were indexed with the same verified checkout; the lineage graph returned **4 nodes / 3 confirmed edges / 0 missing sources**. The reference-only packets were read by the target Harnesses. |
| Live-discovered repairs | Claude's `subagents/agent-*.jsonl` inherited its parent's `sessionId`; it is now indexed as a non-resumable child with its own identity. Grok's `<user_query>` wrapper now preserves exact handoff-marker detection. Handoff-created titles now use the original task instead of raw launch instructions. Reindex of the actual records confirmed these changes. |
| Unconfirmed handoff recovery | OMP opened its first-run provider-login wizard, so no model call or target Session was claimed. Closing its terminal now records `cancelled`; a prior unbound launch became `unknown` after restart. Already confirmed edges stayed `bound`. |
| Visual spot check | The actual 1440×823 desktop window was inspected in worktree graph, Library/editor, and folded Session views. The main sidebar stayed available across routes and the inspected controls were visible without root clipping. This is a spot check, not the full fixed-Codex pixel/state baseline. |

## Not accepted / required before release

1. **OMP is not accepted**: its official CLI presents the first-run provider
   sign-in wizard. Configuring it would change a Harness outside this task's
   permitted boundary, so the test stopped without an OMP model call. The
   Codex→Pi→Claude→Grok chain is real, but native resume/send/cancel/approval
   still needs a separate cross-Harness acceptance matrix. Claude's test was
   stopped after it read the packet to limit model calls; the confirmed edge
   proves identity, not a completed downstream task.
2. The remote [agentskill.sh](https://agentskill.sh/) homepage was reachable
   during research, but the desktop marketplace API request and local curl
   request timed out. The UI now shows an explicit unavailable state, retry and
   external-site link rather than a false "no matching skills" result. The
   live marketplace load/install path remains unverified.
3. Pixel/state comparisons against fixed Codex Desktop 26.915.4065.0 are not
   complete for every dialog, menu, scale, theme and window size. The 1100×720
   geometry check emulates the WebView viewport; it is not a Win32 window-resize
   matrix. The existing 58-row self-test checklist predates the new shell and
   has stale selectors/removed workbench expectations; migrate and execute it
   before calling this a full product acceptance.
4. A distributable installer, `E:\SOFTWARE\Mobius` update, desktop shortcut
   target, and installed-product launch have **not** been tested or changed.

No Harness executable, configuration or existing source transcript was edited
by this tranche. Do not publish a release or replace the maintained installation
until the remaining gates above are closed.
