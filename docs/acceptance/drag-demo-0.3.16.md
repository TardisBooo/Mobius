# MÖBIUS 0.3.16 drag-demo acceptance

Date: 2026-09-15 (Asia/Shanghai)

## Isolated fixture

- Workspace: `E:\Workspaces\_verification\mobius-full-20260915\runs\provider-001\drag-demo`
- Run and evidence: `E:\Workspaces\_verification\mobius-full-20260915\runs\drag-demo-lineage-001`
- The fixture workspace is intentionally disposable and is not a Git worktree.
- Five read-only Harness fixtures represent Codex, Claude Code, Pi, Grok and OMP Sessions.
- No real Harness history, configuration or executable was modified.

## Results

| Case | Result | Evidence |
|---|---|---|
| Multiple Sessions in one project | PASS | Five Sessions resolve to the same registered drag-demo checkout and remain individually inspectable. |
| Multi-round handoff | PASS | Four verified edges form one chain: Codex → Claude → Pi → OMP, plus a parallel Codex → Grok branch. The OMP node resolves four nodes in its ancestry path. |
| Reference-only merge preview | PASS | Two selected sources produced a reviewable reference-only graph package without transcript summarization or copying. Target choices include Codex, Claude, Pi, Grok and OMP. |
| Graph node comprehension | PASS | Each node exposes Harness, time, title and optional native ID/source status. Selecting OMP displayed its indexed final reply; search dimmed the four non-matching nodes. |
| Preview settings | PASS | Left-to-right/top-to-bottom layout, compact nodes, native-ID visibility and source-status visibility are configurable and persist across reload. |
| Responsive graph controls | PASS | At a 1100 px viewport the panel measured 685/685 px client/scroll width, with no horizontal overflow. |
| Project-private Skill install | PASS | `drag-private-source` was copied only to drag-demo's `.agents\skills`, edited through the desktop UI and recorded as a project target. |
| Skill isolation and cleanup | PASS | The managed Skill never appeared in the global catalogue; the source SHA-256 remained unchanged; uninstall removed the managed destination and manifest entry. |
| Installed package lifecycle | PASS | The v0.3.16 NSIS package installed silently, passed the complete drag-demo run, and uninstalled silently with exit code 0. |

Machine-readable result: `drag-demo-results.json`. Visual evidence: `graph-preview-vertical-compact.png` in the run directory.

## Code and build checks

- `cargo test --workspace`: PASS
- `npm run check`: PASS
- `npm run build`: PASS
- `npm run test:window-drag`: PASS
- installed-build `verify-drag-demo.cjs`: PASS

## Packages

| File | SHA-256 |
|---|---|
| `MOBIUS-0.3.16-windows-x64-setup.exe` | `449F395F465E5B98F645EE20C05E6BDC6433FFB98F92FED839A653A3F1C013B5` |
| `MOBIUS-0.3.16-windows-x64-portable.zip` | `D54491672284FAB5187C79A5E725B4935CB827AAEB5B962E684858B780CAF884` |

Development packages are unsigned and may trigger Windows SmartScreen.
