# Codex-style shell: implementation checkpoint (2026-09-23)

This is an implementation checkpoint, **not** a product release or full acceptance.
The maintained installation at `E:\SOFTWARE\Mobius` was not changed. The desktop test
instance used isolated data below `E:\Workspaces\_audits\mobius-codex-shell-20260923`.

## Implemented in this tranche

- One project/session sidebar, name/time project sorting, recent/pinned/archived sessions,
  persisted expansion and session selection, alias editing, `Ctrl+K` search, and exact
  message navigation from search results.
- A compact session shell with an optional context inspector and Markdown message
  rendering. Handoff is disabled with an explanation unless the Session is associated
  with a registered checkout. The library uses a single navigation tree and document tabs.
- CodeMirror for Markdown and plain-text editing. Private notes retain autosave;
  explicitly writable mounts require save. Mounted text saves check source version
  and authorization and refuse an external-edit conflict. PDF/images are read-only.
- Session preference schema migration (v5) and source-title filtering that does not
  overwrite user aliases during indexing.
- Collapsible project/session sidebar shared with Library & canvas. A project name
  opens its details directly; the former recent-workspace/drop-zone route is not
  rendered. Every message starts folded unless the user expanded it previously;
  exact search hits expand only the matching message. `Ctrl+K` and the global
  search button restore a collapsed sidebar before focusing search; redundant
  Library-only topbar navigation buttons were removed.
- Root-session listing separates confirmed child/subagent records without deleting
  them. Grok summary metadata is read for `session_kind` and latest activity;
  project recency uses the latest root conversation, not catalogue inspection time.
  Time ordering compares parsed instants, including differing UTC offsets. Session
  rows show local time, Harness, and checkout directory. Generic harness wrappers
  are excluded from automatic titles, and native user-query wrappers are unwrapped.

## Evidence

| Gate | Result | Evidence |
| --- | --- | --- |
| React/TypeScript production build | Passed | `npm run build` |
| Tauri debug build | Passed | `npm run build:desktop` |
| Rust core unit tests | Passed | `cargo test -p mydesk-core --lib` (81) |
| Tauri unit tests | Passed | `cargo test -p mobius-desktop --bin mobius-desktop` (12) |
| Isolated real WebView2 desktop tests | Passed | `npx playwright test --config playwright.codex-shell.config.ts` (3): sidebar/project/folded-message/library route and mounted-file conflict |
| agentTect Grok index audit | Passed for approved Grok source in isolated DB | 54 source records; 47 child/parent-marked and 7 roots after reindex. Raw records retained. The production DB has additional Codex sources and was only queried read-only. |
| Project detail visual | Passed, limited | `E:\Workspaces\_audits\mobius-codex-shell-20260923\rebuild-project-compact.png`; compact worktree row and one page scrollbar checked in the real WebView2 |
| Search to exact message | Passed, manual desktop check | Search `CLAUDE55_DEFAULT_1M_OK` selected its matching message |
| Unsaved editor buffer across navigation | Passed | Isolated WebView2 test: mounted-file buffer survives Library → Settings → Library |
| Main-route overflow and control-name smoke | Passed, limited | Sessions, workbench, notes, skills, settings: no root horizontal overflow or unnamed visible button/input |
| Library layout screenshot | Passed for the tested viewport | `E:\Workspaces\_audits\mobius-codex-shell-20260923\library-layout-fixed.png` |

## Not accepted / remaining

- A fixed-version Codex Desktop component/state screenshot baseline and exhaustive
  visual comparison have not been completed. This shell is not claimed to be pixel-
  or behavior-identical to Codex Desktop.
- The single Rust daemon does not yet own all Agent processes and PTYs through a
  versioned Tauri/CLI/MCP protocol. Native create/send/stream/cancel/approval capability
  contracts and fallback boundaries remain to be implemented and verified per Harness.
- The complete project/worktree/session navigation, all context menus and shortcuts,
  canvas integration, search hit highlighting, long-document cases, unsaved-buffer
  recovery after application restart,
  multiple-window and multiple-worktree behavior, and full light/dark/scale matrix
  remain unexecuted in this tranche.
- Packaging, maintained installation, shortcut update, and release are blocked until
  the full acceptance matrix passes. No Harness history or binary was modified.
