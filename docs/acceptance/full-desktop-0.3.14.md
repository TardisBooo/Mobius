# MÖBIUS 0.3.14 full desktop acceptance

Date: 2026-09-15  
Status: **PASS**

## Frozen release surface

- Windows NSIS installer with offline WebView2
- Portable Windows x64 ZIP
- Maintained installation: `E:\SOFTWARE\Mobius`
- Desktop shortcut: `Mobius.lnk`, targeting the maintained executable
- Active Harness scope: Codex, Claude Code, and Pi
- Grok and Apodex remain decodable only for historical catalogue compatibility; they are not discovered, indexed, resumed, handed off, exposed by MCP/CLI choices, or scanned as Skill roots.

## Installed-product scan

The packaged application was installed and launched without verification-only path overrides. It scanned the workstation's configured read-only Harness roots and local project Skill roots.

| Check | Result |
| --- | --- |
| Active scan providers | Codex, Claude, Pi only |
| Candidate Session files inspected | 4,676 |
| Indexed Sessions in the local catalogue | Codex 2,325; Claude 16; Pi 5 |
| Non-session records skipped | 9; each contained no shareable messages |
| Registered workspaces / checkouts | 57 / 112 |
| Existing recorded CWDs left unassigned | 0 |
| Global Skills found | 169 |
| Project checkouts scanned for Skills | 112 |
| Project Skills found | 246 |

The scan initially exposed a legacy workspace-identity collision and a missing final checkout-association pass. Both were repaired and reproduced with regression coverage before the installer was rebuilt. Repeated scans are idempotent. Harness transcripts are never rewritten; the current Codex transcript continued to grow only because the acceptance conversation itself was active.

## Product and UI gates

- 36/36 desktop smoke-matrix rows passed in the independent fixture.
- Real Codex-to-Pi references-only handoff passed with two source Sessions and one confirmed edge.
- Source/preview/split note editing, multi-tab behavior, trash/restore, mounted trees, Canvas media, workspace drag/drop, real PowerShell, Skill install/edit/history/uninstall, theme switching, window controls, keyboard focus, and restart persistence passed.
- Supported viewport checks passed at 1600×1000 and the native minimum 1100×720.
- `pnpm check`, production frontend build, window-drag test, interaction Playwright test, and the Rust workspace tests passed.

## Release files

| File | SHA-256 |
| --- | --- |
| `MOBIUS-0.3.14-windows-x64-portable.zip` | `A5A975F56F75FE30253376C2191CABB86F5706E03DB47F39733A37CAD70E5B43` |
| `MOBIUS-0.3.14-windows-x64-setup.exe` | `10A3826E82523B9E03A6B10589BF809FCE97B5709F60C6EB666FFDF24034D206` |

Unsigned preview builds may trigger Windows SmartScreen. No security prompt was bypassed during acceptance.
