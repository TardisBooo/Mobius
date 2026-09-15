# Close the remaining interaction and visual acceptance gaps

Written against: `9661c2c9138234683ab9542a2acad3eea22af74c`

## Evidence chain

- Surface: desktop shell navigation, global search, and Library splitter focus state
- Problem: the Workspaces rail item reopens the last terminal subpage instead of the workspace atlas; the global-search control changes page without focusing a search input; the focused Library splitter becomes a full-height high-contrast stripe.
- Design evidence: `apps/desktop/src/App.tsx`, `apps/desktop/src/mobius-shell.css`, `docs/prototypes/agent-workbench.html`, and isolated screenshots under `E:\Workspaces\_verification\mobius-full-20260915\runs\run-002\evidence`.
- Owner: `apps/desktop/src/App.tsx`, `apps/desktop/src/SessionLibraryV2.tsx`, and `apps/desktop/src/mobius-shell.css`.
- Scope and affected surfaces: left-rail navigation, top-bar search activation and keyboard shortcut, Library resize handle in light and dark themes.
- Uncertainty: none; all three failures are reproducible in the isolated desktop build.

## Design decision

Make destination controls deterministic. The Workspaces rail item always opens the workspace atlas, while explicit terminal controls open the terminal panel. Treat the top-bar search as a real activation control by navigating to Agents and focusing the session search after mount; keep Ctrl+K available outside text-entry and terminal surfaces. Replace the splitter's full-height filled focus stripe with a restrained one-pixel rail plus a short centered accent handle and retain the shared two-pixel focus outline.

## Reuse

- Existing `page`, `workbenchPanel`, and `terminalFocus` state in `App.tsx`.
- Existing `.session-search-v2 input` rather than introducing a second search overlay.
- Existing `--m-line`, `--m-accent`, and global `:focus-visible` treatment.
- Exemplar: the short active indicator on `.rail-item.active::before` in `apps/desktop/src/mobius-shell.css`.

No new primitive is required.

## Changes

1. `apps/desktop/src/App.tsx`
   - Change: route the Workspaces rail item through one helper that clears terminal focus, sets `workbenchPanel` to `workspaces`, and then sets `page` to `workbench`.
   - Preserve: explicit terminal creation, Resume, Continue, and Handoff continue to open `workbenchPanel="terminal"`.
   - Verify: from an open terminal, clicking the left Workspaces rail item renders `.workspace-atlas` in one action.
2. `apps/desktop/src/App.tsx` and `apps/desktop/src/SessionLibraryV2.tsx`
   - Change: pass a focus request to the Agents surface, consume it once after the search field is mounted, and focus the existing input for both top-bar click and Ctrl+K outside editable/terminal targets.
   - Preserve: terminal Ctrl+K remains available to the terminal and ordinary session browsing remains separate from explicit Mome recall.
   - Verify: clicking the top search control places the caret in the session search; typing immediately filters the Session list.
3. `apps/desktop/src/mobius-shell.css`
   - Change: keep a neutral one-pixel splitter rail and show a short centered accent segment on hover/focus instead of filling the full height.
   - Preserve: five-pixel pointer target, column-resize cursor, keyboard resizing, and the shared focus outline.
   - Verify: both themes show a discoverable resize affordance without visually dividing the entire application with a heavy stripe.
4. `apps/desktop/tests/interaction-regression.spec.ts` and/or a dedicated isolated desktop acceptance test
   - Change: add regression coverage for terminal-to-atlas rail navigation, top-search focus, and splitter focus appearance/keyboard resize.
   - Preserve: the independent fixture root and source-hash invariants.
   - Verify: the three reproduced failures become deterministic passing assertions.

## Scope

- Inherit: English and Simplified Chinese labels, light/dark themes, supported native viewports from 1100×720 upward.
- Verify: Agents, Workspaces, terminal return path, Library source/preview/split modes, and onboarding focus return.
- Exclude: Harness implementation/configuration, transcript rewriting, the 800px viewport below the native window minimum, website/video/release work, and unrelated visual redesign.

## Validation

- Product: repeat the independent run at `E:\Workspaces\_verification\mobius-full-20260915` and expect all smoke-matrix rows to pass.
- Interface: exercise the affected controls with mouse and keyboard in both themes at 1600×1000 and 1100×720; inspect screenshots after animations settle.
- System: confirm no new search overlay or alternate navigation state is introduced and terminal Ctrl+K behavior remains intact.
- Repository: `pnpm check && pnpm build && pnpm test:window-drag` in `apps/desktop` → all pass; `cargo test --workspace` at repository root → all non-ignored tests pass.

## Stop conditions

- Stop if focusing the existing session input would require copying search state into the shell, if the Workspaces rail item is intentionally specified to restore the last subpage, or if the splitter owner moves out of `NotesLibraryV2`.

## Design documentation

- After acceptance and validation: record the deterministic navigation and search-focus contracts in the interaction smoke matrix; no new design-system primitive is needed.
