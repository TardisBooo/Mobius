# Möbius desktop interaction smoke matrix

## Control

| Field | Value |
|---|---|
| Plan ID | MOBIUS-DESKTOP-SMOKE-001 |
| Contract / revision | Möbius 0.3.7+ desktop UX |
| Runtime | Windows 11, Tauri 2, WebView2, PowerShell/ConPTY |
| Data boundary | Fresh E: verification workspace; isolated D: vault/artifact/catalog roots |
| Overall status | IN_PROGRESS until every row has automated or recorded manual evidence |

## Traceability matrix

Latest corrective evidence: [0.3.8 real trajectory / native resume / installer gates](final-gates-20260908.md). Overall status remains IN_PROGRESS: installed Grok new-turn verification is blocked by a native credit-limit screen; passing fixture tests does not clear it.

| ID | Surface | Interaction / state | Expected result | Evidence |
|---|---|---|---|---|
| SH-01 | Window | drag title bar | Window moves; controls remain clickable | interaction-regression.spec.ts (native mousedown path) |
| SH-02 | Window | minimize, restore, maximize, restore | Native state changes once per click; app remains responsive | CTL-WINDOW |
| SH-03 | Window | close | Process and PTYs terminate cleanly | final test step |
| SH-04 | Global | light/dark switch on every page | No hard/low-contrast controls; no layout shift or overflow | CTL-THEME screenshots |
| SH-05 | Global | Chinese/English switch | All primary labels update; layout remains usable | CTL-I18N |
| SH-06 | Global | Ctrl+K, rail navigation, browser back-equivalent routes | Correct surface is focused; terminal tabs are retained | CTL-NAV |
| SH-07 | Global | first-run guide: steps/back/skip/close | Focus is trapped/restored and completion persists | CTL-ONBOARD |
| WB-01 | Workspaces | add via typed path / folder picker / cancel / invalid path | Valid isolated path registers once; invalid path is recoverable | FLOW-WORKSPACE |
| WB-02 | Workspaces | expand/collapse project and select checkout | Tree state and detail selection are consistent | FLOW-WORKSPACE |
| WB-03 | Workspaces | pin/unpin, drag into recent area | Recent set persists without changing project status | interaction-regression.spec.ts |
| WB-04 | Details | Sessions / Files / Worktrees / Project skills tabs | Each tab loads and scrolls independently | FLOW-WORKSPACE |
| WB-05 | Details | open terminal from project/session | PTY cwd equals checkout and accepts repeated input | FLOW-PTY |
| WB-06 | Details | Handoff graph tab, source/target nodes and pending target | Only marker-correlated sessions join the chain; nodes open the exact indexed session | CORE-RELAY / FLOW-HANDOFF |
| TM-01 | Terminal | create free PowerShell, choose/cancel folder | New tab only after confirmation | FLOW-PTY |
| TM-02 | Terminal | type, paste, Enter, resize, switch tabs | Exact input/output retained; no freeze; terminal remains readable in light mode | interaction-regression.spec.ts / FLOW-PTY |
| TM-03 | Terminal | close active/background tab | Only requested PTY closes; focus moves predictably | FLOW-PTY |
| TM-04 | Terminal | focus mode / Escape / return to workspaces / return to terminal | No stuck overlay; existing tabs remain reachable | FLOW-PTY |
| TM-05 | Terminal | session reference picker search/filter/message/range/copy | Exact reference/package copied; terminal is not mutated automatically | FLOW-REFERENCE |
| SE-01 | Sessions | scan and source manager add/remove/cancel | Read-only index refreshes and original files are unchanged | FLOW-SESSION |
| SE-02 | Sessions | project/check-out tree expand/collapse and provider filters | Scope is applied before pagination; list remains scrollable | FLOW-SESSION |
| SE-03 | Sessions | search and select hit | Matching text and exact message are highlighted and scrolled into view | FLOW-SESSION |
| SE-04 | Sessions | native resume | Supported Harness resumes exact ID in recorded checkout | FLOW-RESUME |
| SE-05 | Sessions | same-Agent handoff action | Uses native resume directly; no folder picker | FLOW-HANDOFF |
| SE-06 | Sessions | cross-Agent handoff | Starts target Harness in same checkout; no folder picker | FLOW-HANDOFF |
| SE-07 | Sessions | repeated A→B→C handoff | Immutable packages form one relay chain after target indexing | CORE-RELAY |
| SE-08 | Sessions | copy precise reference / handoff packet | Clipboard output contains provider, session ID and message ordinal | FLOW-HANDOFF |
| SE-09 | Mome | empty query, hit, miss, token bound, copy | Search is explicit, bounded and cited; no implicit injection | FLOW-MOME |
| LI-01 | Library | recursive Canvas / Notes / Mounts folding | Every branch folds independently; selected item remains visible | interaction-regression.spec.ts |
| LI-02 | Notes | new, edit, autosave, explicit save, reopen | Content persists and duplicate saves are prevented | interaction-regression.spec.ts |
| LI-03 | Notes | Source / Preview / Split and Markdown assets | Rendered Markdown is safe and readable in both themes | FLOW-NOTE |
| LI-04 | Mounts | picker/manual path, mount, recursive browse, unmount | Mount is logical; source is unchanged; virtual root is not duplicated | interaction-regression.spec.ts |
| CA-01 | Canvas | create/open/rename/save/back/reopen/nested board | Scene and title persist; navigation never loses the board | FLOW-CANVAS |
| CA-02 | Canvas | pan/zoom/fit/fullscreen/outline | Canvas remains responsive and occupies available space | FLOW-CANVAS |
| CA-03 | Canvas | sticky/text/shape/frame/connector/drawing/erase | Each tool creates or changes only the intended object | FLOW-CANVAS |
| CA-04 | Canvas | paste text, URL, @session and mixed clipboard | One correctly typed card per payload; editable after insertion | FLOW-CANVAS |
| CA-05 | Canvas | image/video/audio/PDF/file drop and picker | Local media previews without blocking UI; metadata persists | FLOW-CANVAS |
| CA-06 | Canvas | YouTube/X/general URL preview, play, refresh, open original | Deterministic safe card or explicit fallback; remote load is user initiated | FLOW-CANVAS |
| CA-07 | Canvas | object menu at pointer, copy, layer, delete, dismiss | Menu stays inside viewport near trigger and closes predictably | FLOW-CANVAS |
| CA-08 | Canvas | undo/redo, rapid save, switch while dirty | No scene loss, duplicate node or freeze | FLOW-CANVAS |
| SK-01 | Skills | global/project scope and market/installed filters | Catalogue reflects selected target and remains searchable | FLOW-SKILL |
| SK-02 | Skills | view source/managed copy | Read-only source is distinct from editable managed copy | FLOW-SKILL |
| SK-03 | Skills | preview install/install/edit/save/uninstall/cancel | Only managed destination changes; validation is inline | FLOW-SKILL |
| SK-04 | Skills | history list and restore | Every save creates a recoverable version | FLOW-SKILL |
| UX-01 | Every page | all visible controls geometry | Named; at least 24×24 px; not clipped; enabled state is meaningful | CTL-GEOMETRY |
| UX-02 | Every dialog | Escape, close button, Tab cycle, focus restore | Modal traps focus and restores trigger | CTL-A11Y |
| UX-03 | Lists/canvas | wheel, nested scroll, 200% zoom, long CJK/path/title | No unusable overflow or dead scroll region | CTL-HARD |
| UX-04 | Error paths | unavailable binary, bad directory, bad URL, read-only file | Local actionable error; current input/state preserved | CTL-ERROR |

### Interaction regression checkpoint 2026-09-10

`apps/desktop/tests/interaction-regression.spec.ts` was run against the packaged
debug desktop binary over the WebView2 CDP endpoint with an isolated
`E:\Workspaces\Mobius-Verification-20260910` fixture. The single test passed and
covered the actual drag gesture, editable-note save and read-back, recursive
mount folding/root de-duplication, forced-dark terminal contrast while the app
is in light mode, and the custom title-bar drag listener. The test also failed
on any page error or console error. This is fixture/UI evidence; it does not
replace real external-Agent, PTY, or installer lifecycle gates.
The same test passed against the rebuilt optimized release binary in
`ui-regression-release-20260910-c` after the note-loading race was fixed.

## Coverage and release boundary

Positive, negative, boundary, concurrency, recovery and regression cases must all pass. A release is blocked by any crash/freeze, source-file mutation, lost note/canvas content, incorrect PTY cwd, inaccessible control, handoff folder picker, or theme contrast failure. Browser-only checks do not qualify for native window, picker, PTY or process-lifecycle rows.

## Evidence manifest

### Checkpoint 2026-09-08

- Core unit tests: 38 passed. Desktop Rust tests: 12 passed. TypeScript check passed.
- Desktop run `full-control-audit-20260908-70/playwright-control-audit-27`: FAIL at cross-Agent handoff. The `.cmd` shim received only the first line of the multiline prompt. This is a product failure, not a test waiver.
- A batch-shim fallback now retains the full UTF-8 packet in the isolated artifact store and sends a single-line instruction to read it via `MOBIUS_HANDOFF_PACKET`. Desktop retest remains required. This adds a target-Agent file read; it is not native cross-Harness resume.
- Handoff graph links require an exact handoff marker. Merely starting an unrelated session in the same checkout must not link it.
- Full trajectory selection, multi-hop UI verification, all-controls coverage and release packaging remain incomplete. No release acceptance is claimed by this checkpoint.
- Desktop run `playwright-control-audit-30`: existing end-to-end script PASS (40.9 s). Covers native WebView UI, PowerShell, fixture Harness launch/handoff, explicit recall, references, library/canvas persistence and managed global/project skill CRUD. Six fixture source transcript hashes unchanged. This is not a claim that real model conversations or every matrix row passed.
- Inspected `skills-controls-light.png` and `skills-controls-dark.png` from run 30. Install-target height is restored; both palettes render distinctly. Full typography/contrast audit is still pending.
- Extended desktop run `playwright-control-audit-34`: PASS (44.5 s), now including native minimize/unminimize state assertions, single graph rendering, source-node navigation, and graph control checks/screenshots in both themes. Graph target completion and multi-hop continuity remain pending; fixture stubs do not create real target-Agent conversations.
- Visual review of run 34 found legacy `.relay-edge` CSS squeezing new graph nodes despite clickable-control checks passing. Scoped the grid rule and added a minimum node-width regression assertion. Run `playwright-control-audit-35`: PASS (43.9 s).

Each run stores Playwright traces/screenshots, console errors, UI geometry JSON, database assertions and source hashes below its fresh `E:\Workspaces\Mobius-Verification-*\runs\<run>` directory. D-side test vault, accepted-artifact and catalogue roots use the identical run name.
