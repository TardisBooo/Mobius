# MÖBIUS 0.3.15 full desktop acceptance

Date: 2026-09-15 (Asia/Shanghai)

## Scope and boundaries

- Source: `E:\Workspaces\Mobius\repos\desktop`
- Maintained installation: `E:\SOFTWARE\Mobius`
- Isolated verification: `E:\Workspaces\_verification\mobius-full-20260915`
- Real-data diagnostic evidence: `E:\Workspaces\_audits\mobius-0.3.14-diagnostic-20260915`
- Accepted packages: `D:\AcceptedArtifacts\Mobius\v0.3.15`
- Active Harness scope: Codex, Claude Code, Pi, Grok and OMP
- Harness histories and executables remained read-only. MÖBIUS did not patch or replace a Harness.

## Corrective results

| Area | Result | Evidence |
|---|---|---|
| Logical session identity | PASS | Duplicate physical sources are retained for audit but one provider/native ID is shown once. The five-provider fixture produced five logical sessions from six physical files. |
| Session titles | PASS | Native titles are preferred; leading Harness wrappers are excluded. The real agentTect view contained 49 logical sessions and zero wrapper-derived titles. |
| Grok | PASS, bounded | 45 real histories indexed; inspect/search/handoff and global Skill discovery are enabled. Native resume remains hidden because the installed Grok launcher has no verified resume contract. |
| OMP | PASS, bounded | Three real histories indexed and the documented `omp --cwd <path> --resume <id>` launch shape is generated. Fixture Skill discovery passed; the real profile currently contains no OMP Skill directory. |
| Mome responsiveness | PASS | Installed isolated build: 9 ms first query, 10 ms warm query. Maintained install with the real catalogue: 47 ms. Recall no longer walks and hashes every transcript. |
| Source dialog | PASS | 759/759 px wide and 628/628 px narrow client/scroll widths; no horizontal overflow. |
| Desktop interactions | PASS | Visible installed-build regression covered workspace drag/drop and deduplication, note save/rename refresh, create menu, tab context menu, mounted-tree collapse, keyboard splitter, terminal contrast across themes, global search focus, global Skill discovery and marketplace switching. |
| Installer lifecycle | PASS | Silent install returned 0, executable and uninstaller existed, the installed build passed the functional matrices, and silent uninstall returned 0 with both files removed. |
| Maintained install and shortcut | PASS | Installed to `E:\SOFTWARE\Mobius`; desktop shortcut target and working directory resolve to that maintained installation. |

The same interaction run against a deliberately hidden window could not focus a keyboard separator because Windows marks its WebView inactive. The required case was repeated against a visible installed window and passed; it is not counted as a product failure or as an unexecuted case.

## Checks

- `cargo check --workspace`: PASS
- `cargo test --workspace`: PASS (12 desktop, 5 CLI library, 5 CLI binary, 67 core, 1 live isolated Pi source, 4 local-first, 1 auto-discovery, 1 retired-provider, 3 MCP; one separately provisioned fixture test intentionally ignored)
- `npm run check`: PASS
- `npm run build`: PASS
- `npm run test:window-drag`: PASS
- installed five-provider matrix: PASS
- installed visible interaction regression: PASS
- maintained-install real catalogue regression: PASS

## Packages

| File | SHA-256 |
|---|---|
| `MOBIUS-0.3.15-windows-x64-setup.exe` | `427D569A2FA0AEF8F1C50EED17431B877A3425646F7BC14FD8CB3E48C2C6DB29` |
| `MOBIUS-0.3.15-windows-x64-portable.zip` | `3135F7E4C6D0BFC8E89898BDD7CFBD3314654FD74877D373585A0D63CF26077A` |

Development packages are unsigned and may trigger Windows SmartScreen.
