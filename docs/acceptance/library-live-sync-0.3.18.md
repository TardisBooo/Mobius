# MÖBIUS 0.3.18 mounted Library live-sync acceptance

Date: 2026-09-16 (Asia/Shanghai)

## Scope

- Source: `E:\Workspaces\Mobius\repos\desktop`
- Maintained installation: `E:\SOFTWARE\Mobius`
- Desktop shortcut: `C:\Users\MSI-NB\Desktop\Mobius.lnk`
- Isolated verification: `E:\Workspaces\_verification\mobius-ui-state-20260916`
- Accepted package: `D:\AcceptedArtifacts\Mobius\v0.3.18\MOBIUS-0.3.18-windows-x64-setup.exe`

## Design

The native desktop owns one recursive watcher for the private notes vault and each user-approved mounted source. File events are debounced for 180 ms and cause the renderer to request one complete atomic Library snapshot. Only the newest snapshot can replace the view. The existing five-second scan remains a fallback for filesystems that drop native events or for a source that temporarily disappears.

This follows the useful boundary in VS Code's file-watcher design: native recursive watching is the fast path, overlapping roots are deduplicated, missing paths have a slower fallback, and the editor's unsaved working copy is not overwritten by an external event.

References:

- <https://github.com/microsoft/vscode/wiki/File-Watcher-Internals>
- <https://github.com/microsoft/vscode/wiki/Working-Copies>
- <https://github.com/microsoft/vscode/blob/main/src/vs/platform/files/node/diskFileSystemProvider.ts>

## Installed-build results

| Case | Result | Observed latency |
|---|---|---:|
| Create Markdown in mounted directory | PASS | 846 ms |
| Update the open read-only document and preview | PASS | 834 ms |
| Rename the mounted document | PASS | 836 ms |
| Delete the mounted document and clear stale UI | PASS | 363 ms |
| Source unavailable exposes no retained file list | PASS | immediate accepted snapshot |
| Source recovery receives a complete new snapshot | PASS | next native/fallback refresh |
| Collapse all, then expand one mounted tree | PASS | direct interaction |

The realtime test explicitly overrode `document.visibilityState` to disable the timer fallback. It therefore could pass only through the native watcher event path. The broader installed-build suite passed all 14 assertions covering manual/background refresh, stale selection removal, tree interaction, workspace sort and navigation memory.

## Package and installation

- Registry version: `0.3.18`
- Executable version: `0.3.18`
- Install location: `E:\SOFTWARE\Mobius`
- Registered MÖBIUS installations: `1`
- Desktop shortcuts after cleanup: `1`
- Shortcut target: `E:\SOFTWARE\Mobius\mobius-desktop.exe`
- Accepted setup packages for 0.3.18: `1`
- Installer SHA-256: `9ECE5A4412AFCAA73F95BB474101629203230EAF637C3C219CEF0E0A36C646F2`

The final in-place installation preserved the data vault at 403 files / 5,127,278,497 bytes and the maintained WebView profile at 317 files / 35,957,142 bytes. The installer's extra targetless `MÖBIUS.lnk` was moved to the Recycle Bin; the canonical `Mobius.lnk` was retained and launch-tested.

## Checks

- `cargo test --workspace`: PASS — 101 passed, 0 failed, 1 separately provisioned fixture ignored by design.
- `npm run check`: PASS.
- `npm run test:window-drag`: PASS.
- `pnpm exec tauri build`: PASS; optimized EXE and NSIS package produced.
- Installed-build live filesystem acceptance: PASS.
- Installed-build Library/navigation regression: PASS — 14/14 assertions.
