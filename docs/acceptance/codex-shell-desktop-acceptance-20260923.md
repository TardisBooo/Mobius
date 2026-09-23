# Möbius Codex-style desktop acceptance — 2026-09-23

Status: **partial release acceptance; local 0.3.20 upgrade completed on
2026-09-24**. The isolated checks below were repeated on the optimized 0.3.20
executable before the maintained `E:\SOFTWARE\Mobius` installation was upgraded.

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
  deletion candidate. Before the 2026-09-24 upgrade, the maintained installation
  and desktop shortcut were not changed.
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
| Desktop regression | `npx playwright test --config playwright.codex-shell.config.ts`: **18/18 passed** serially on the isolated Tauri WebView2 after the market layout changes. |
| Shell/navigation | Collapsible sidebar, `Ctrl+K`, project direct-open, Library/session round-trip, onboarding/Escape, theme and language persistence, named controls and 1100×720 root overflow. |
| Session catalogue | agentTect approved Grok sample: 54 records, 7 roots, 47 children; child records remain discoverable. Separate same-name directories remain path-distinct. Project sorting matches latest root conversation activity, not scan time. Sidebar shows time, Harness and checkout folder. |
| Search/naming | Content search lands on and expands the exact message; manual aliases remain editable/searchable. Harness wrappers and Claude sidecar metadata are not mislabelled as sessions. |
| Sources/memory | Approved Codex root add → index → remove round-trip; source transcript unchanged. Memory search returns an explicit local result. Last refresh: 280 discovered, 0 index errors beyond one real Claude JSONL with no shareable messages. |
| Library/editor | Private note create/preview/return/trash/restore; mounted text explicit save; live tree add and delete while an editor buffer is dirty; external-edit conflict refuses overwrite. |
| Canvas | Object creation, save, leave and reopen preserves the object. |
| Skills | Skill market and installed views are distinct; project-private Skill is discoverable. Managed project copy install/uninstall leaves original unchanged. Checkout labels include project, branch/kind and full path. The live agentskill.sh catalogue displayed 12 cards in the actual desktop, and a live `SKILL.md` fetch returned 6,273 characters. Three-column market cards keep all action labels on one line at 1440×823. |
| Terminal | New PowerShell starts in the selected audit project, accepts input, returns output and closes. |
| Handoff/graph | Handoff review generates exact `@session` references without launching a Harness. Real copied graph shows 3 nodes, 1 verified edge, and pending-target warning. Layout, compact nodes and graph/list mode persist. |
| Live cross-Harness chain | In the empty audit project, one short Codex probe was handed to Pi, then Claude, then Grok Build. The four native Session IDs were indexed with the same verified checkout; the lineage graph returned **4 nodes / 3 confirmed edges / 0 missing sources**. The reference-only packets were read by the target Harnesses. |
| Live-discovered repairs | Claude's `subagents/agent-*.jsonl` inherited its parent's `sessionId`; it is now indexed as a non-resumable child with its own identity. Grok's `<user_query>` wrapper now preserves exact handoff-marker detection. Handoff-created titles now use the original task instead of raw launch instructions. Reindex of the actual records confirmed these changes. |
| Unconfirmed handoff recovery | OMP opened its first-run provider-login wizard, so no model call or target Session was claimed. Closing its terminal now records `cancelled`; a prior unbound launch became `unknown` after restart. Already confirmed edges stayed `bound`. |
| Native resume probe | Pi launched its exact native `--session` path and remained idle without a model prompt. Codex reached its own folder-trust confirmation for the fresh audit directory; this was not accepted on the user's behalf. Resuming the previously interrupted Claude turn auto-continued model work, so that terminal was stopped immediately to limit calls. Grok/OMP native resume was not attempted. |
| Visual spot check | The actual 1440×823 desktop window was inspected in worktree graph, Library/editor, and folded Session views. The main sidebar stayed available across routes and the inspected controls were visible without root clipping. This is a spot check, not the full fixed-Codex pixel/state baseline. |

## Explicitly excluded from this acceptance round

**OMP was skipped at the user's direction.** Its official CLI presented a
first-run provider-login wizard; no OMP model call or target Session was
claimed, and no Harness settings were changed.

## Not accepted / required before release

1. The Codex→Pi→Claude→Grok chain is real, but native resume/send/cancel/approval
   still needs a separate cross-Harness acceptance matrix. Native CLI trust and
   onboarding gates were left to the user. Claude's test was stopped after it
   read the packet to limit model calls; the confirmed edge proves identity,
   not a completed downstream task. Its later resume automatically restarted
   the interrupted turn and was stopped immediately.
2. The live [agentskill.sh](https://agentskill.sh/) catalogue and read-only
   skill-content fetch **did succeed** in the desktop after reducing the first
   page to 12 cards. The service remained intermittent: other desktop requests
   failed and correctly showed retry/external-site actions rather than a false
   empty result. A remote skill was **not installed**; that write path remains
   unexecuted pending an explicitly approved test installation.
3. Pixel/state comparisons against fixed Codex Desktop 26.915.4065.0 are not
   complete for every dialog, menu, scale, theme and window size. The 1100×720
   geometry check emulates the WebView viewport; it is not a Win32 window-resize
   matrix. The existing 58-row self-test checklist predates the new shell and
   has stale selectors/removed workbench expectations; migrate and execute it
   before calling this a full product acceptance.
4. The 0.3.20 NSIS installer, maintained-install upgrade, shortcut target, and
   installed-product launch passed the checks below. A separate clean-install /
   uninstall / rollback lifecycle has **not** been executed for 0.3.20.

No Harness executable, configuration or existing source transcript was edited
by this tranche. The local installed copy was replaced at the user's direction;
do not present the remaining checks as passed or publish a GitHub release until
the unexecuted release-wide gates above are closed.

## 2026-09-24 local upgrade and installed-build check

- Candidate: optimized `target\release\mobius-desktop.exe`, FileVersion
  `0.3.20`; NSIS `MÖBIUS_0.3.20_x64-setup.exe`, SHA-256
  `3B440D8469680D45143D3A2C87FDC9EB928D1ECC80C06C81747B110AB2E6A65D`.
- `pnpm --dir apps/desktop exec tauri build --bundles nsis`,
  `cargo test --workspace`, `pnpm --dir apps/desktop check`,
  `pnpm --dir apps/desktop test:window-drag`, and
  `pnpm --dir apps/desktop check:checklist` passed. The 58-row checklist command
  checks document synchronization, **not** the 58 interactions.
- The optimized executable, running with isolated data and approved source
  fixtures, passed the real Tauri WebView2 suite **18/18** in 48.8 seconds.
- The installer was also copied to
  `E:\Workspaces\_audits\mobius-install-20260924\MÖBIUS_0.3.20_x64-setup.exe`
  with the same SHA-256 for retained candidate review. The installed EXE and
  post-bundle build EXE have the same 22,182,912-byte length; they differ in
  three bytes, consistent with Tauri's logged NSIS bundle-type patch, and both
  report 0.3.20.
- Before upgrade, the 0.3.19 executable, uninstaller, and canonical shortcut
  were copied to `E:\Workspaces\_audits\mobius-install-20260924` for recovery.
  The upgrade used the installer with `/S /D=E:\SOFTWARE\Mobius` and exited 0.
  HKCU registration and installed EXE both report `0.3.20`.
- Immediately after installation, `D:\DataVault\Mobius` remained 757 files /
  6,499,071,398 bytes and the maintained WebView profile remained 326 files /
  36,783,160 bytes, matching their pre-upgrade counts and bytes. Normal app
  startup then refreshed its own index, so later SQLite/WAL bytes are not
  expected to match the pre-launch inventory.
- The installer generated an extra `MÖBIUS.lnk` with no target. It was moved
  recoverably to the same audit directory. The sole desktop `Mobius.lnk` points
  to `E:\SOFTWARE\Mobius\mobius-desktop.exe` with that working directory.
  Launching it produced only the maintained executable (PID 60388 at test time).
- The installed UI was inspected directly: Skill market loaded, Library mounted
  tree and open editor loaded, the persistent sidebar returned to a folded
  Session, and the startup Session index reached `running=false`. No installed
  UI error was observed in these paths. This is a focused installed smoke test,
  not the unexecuted full visual/control matrix above.
