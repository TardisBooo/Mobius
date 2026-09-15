# MÖBIUS 0.3.17 UI distillation acceptance

Date: 2026-09-15 (Asia/Shanghai)

## Scope and evidence

- Source: `E:\Workspaces\Mobius\repos\desktop`
- Maintained installation: `E:\SOFTWARE\Mobius`
- Isolated UI run: `E:\Workspaces\_verification\mobius-ui-distill-20260915\runs\ui-001`
- Accepted release artifacts: `D:\AcceptedArtifacts\Mobius\v0.3.17`
- The installed build was exercised against the existing read-only `drag-demo` Session graph. No Harness executable or history was changed.

## Results

| Area | Result | Evidence |
|---|---|---|
| Repeated chrome | PASS | Brand subtitle, page eyebrow, workspace-map heading and library heading are removed while their controls remain reachable. |
| Global search | PASS | The persistent wide field is reduced to a 34 px icon entry point; page-local search remains visible. |
| Lineage settings | PASS | The large settings section is replaced by a 224 × 141 px translucent popover that is closed by default. |
| Graph layout | PASS | The graph stage is bounded to 342 px in the installed test, its controls form a 91 × 31 px horizontal group at the top, and the detail actions sit in the detail header. |
| Scroll ownership | PASS | No vertically scrollable descendant remains inside the graph content; page and project-tree scrolling remain independent. |
| Responsive layout | PASS | The 1100 × 760 viewport has no body-level horizontal overflow. |
| View and preference controls | PASS | Graph/list switching, layout selection and local preference persistence passed. |
| Theme | PASS | The installed application switched between light and dark themes and retained readable contrast. |
| Maintained installation | PASS | NSIS upgrade returned 0; registry version is 0.3.17; executable version is 0.3.17. |
| Data preservation | PASS | `D:\DataVault\Mobius` and the maintained WebView profile retained identical file counts and byte totals across installation. |
| Desktop shortcut | PASS | `Desktop\Mobius.lnk` resolves to `E:\SOFTWARE\Mobius\mobius-desktop.exe`; launching the shortcut opened the maintained executable. |

Machine-readable installed-build result: `ui-acceptance-result.json` in the accepted artifact directory. All 20 assertions passed.

## Checks

- `cargo test --workspace`: PASS — 99 passed, 0 failed, 1 separately provisioned fixture test ignored by design.
- `npm run check`: PASS.
- `npm run build`: PASS.
- `npm run test:window-drag`: PASS.
- optimized `pnpm tauri build`: PASS.
- installed-build WebView UI acceptance: PASS — 20/20.
- failed cases: none.
- blocked cases: none.
- unexecuted cases: the separately provisioned Rust fixture test; it is unrelated to this UI-only change and remains explicitly ignored.

## Packages

| File | SHA-256 |
|---|---|
| `MOBIUS-0.3.17-windows-x64-portable.zip` | `285E649EB7E0C0BBC3E7BA0F64B33403D425515A27205DFF33FB1585D354AC73` |
| `MOBIUS-0.3.17-windows-x64-setup.exe` | `77FF4AADE6E3581840663310AE82BC147850D6313686FE7B60AF59E73C62349C` |

Development packages are unsigned and may trigger Windows SmartScreen.
