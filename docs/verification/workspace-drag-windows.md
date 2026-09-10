# Windows workspace drag regression

## Cause and fix

The workbench uses HTML5 `dragstart` / `dragover` / `drop`. The desktop
window omitted `dragDropEnabled`, whose Tauri default is `true`. That native
handler conflicts with HTML5 drops on Windows. The window now explicitly
sets `dragDropEnabled: false` so WebView2 can deliver the frontend events.

Reference: https://v2.tauri.app/reference/config/#windowconfig

The terminal and canvas also use frontend drop handlers; no Tauri native
drag-drop event consumers are registered in the frontend.

## Checks performed (2026-09-10)

- `pnpm test:window-drag`: failed before the configuration change, passed
  after it. This guards the native configuration which CDP cannot exercise.
- `pnpm check`: passed.
- `pnpm exec tauri build --no-bundle`: optimized Windows executable built.
- `playwright.interaction.config.ts` against that executable in an isolated
  WebView profile: passed (1 test). Project-name drag created a recent card;
  repeated drag did not duplicate it; page reload retained it. The existing
  note, mount, terminal contrast and global skill checks also passed.

## Native mouse acceptance is still pending

Computer Use failed to connect to its native pipe (`os error 2`). Retry and
kernel reset did not recover it. No successful OS mouse gesture is claimed.
CDP dragging is a frontend regression check, not native Windows acceptance.

On the rebuilt executable, drag from the project name onto the recent
workspace drop zone. Verify one card appears, repeat without duplication,
cancel a drag outside the drop zone, and restart to check persistence.
Repeat in both themes. Do not use an older running process: the window
configuration takes effect only when a new executable process starts.
