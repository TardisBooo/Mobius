# MÖBIUS self-test checklist

Revision **0.3.20**. Updated 2026-09-16.

JSON is the source of truth: `docs/acceptance/self-test-checklist.json`.
Regenerate this file with `node apps/desktop/scripts/sync-self-test-checklist.mjs`.
Verify with `node apps/desktop/scripts/sync-self-test-checklist.mjs --check`.

## Update policy

- JSON is the source of truth. Regenerating markdown never invents rows.
- After any UI label, aria-label, dialog, or navigation change, update locators in the matching row.
- A smoke run that writes ui-smoke-consolidated.json may refresh last_result fields only.
- Do not delete a row because a test timed out. Mark last_result and keep the expected product contract.
- Keep revision equal to the Cargo workspace version.
- Run `pnpm --dir apps/desktop check:checklist` after locator edits and before a release commit.

## Fixture

| Field | Path |
|---|---|
| Workspace | `E:/Workspaces/_verification/mobius-full-20260915/runs/provider-001/drag-demo` |
| Harness home | `E:/Workspaces/_verification/mobius-full-20260915/runs/drag-demo-lineage-001/harness` |
| Isolated run | `E:/Workspaces/_verification/mobius-full-20260915/runs/drag-demo-ui-smoke-20260916` |

## OB · Onboarding

| ID | Check | Expected | Locator |
|---|---|---|---|
| OB-01 | First launch shows six-step guide | `.onboarding` dialog with six progress steps | `.onboarding .onboarding-progress button` |
| OB-04 | Finish guide opens workspaces | `.workspace-atlas` after completing or skipping | `.workspace-atlas` |
| OB-06 | Completion persists across reload | `mobius.onboarding.complete=1` and guide absent | `—` |
| OB-07 | Help reopens the guide | Top-bar sparkles button opens `.onboarding` | `button[aria-label='Open Möbius guide']` |
| OB-08 | Escape closes the guide | Guide dismissed, focus restored | `.onboarding` |

## W · Shell / window / i18n / theme

| ID | Check | Expected | Locator |
|---|---|---|---|
| W-01 | Custom title bar and brand | `.mobius-topbar` shows MÖBIUS | `.mobius-topbar .mobius-brand strong` |
| W-02 | Window controls exist | Minimize, Maximize, Close | `.window-controls [aria-label]` |
| W-04 | Theme switch persists | `html[data-theme]` and `mobius.theme` | `button[aria-label='Switch theme']` |
| W-05 | Language switch persists | Rail labels update; `mobius.locale.v2` saved | `button[aria-label='Switch language']` |
| W-06 | Ctrl+K focuses session search | Agents page with caret in `.session-search-v2 input` | `.session-search-v2 input` |
| W-07 | Rail Workspaces always opens atlas | From terminal, Workspaces rail shows `.workspace-atlas` | `.mobius-rail .rail-item` |

## WB · Workspaces

| ID | Check | Expected | Locator |
|---|---|---|---|
| WB-01 | drag-demo appears in project tree | `.atlas-project-button` contains drag-demo | `.atlas-project-button` |
| WB-02 | Selecting a project expands checkouts | `.atlas-checkouts button` visible after select | `.atlas-checkouts button` |
| WB-03 | Inspector has five named tabs | Sessions, Files, Worktrees, Project skills, Handoff graph | `.inspector-tabs button` |
| WB-05 | Sessions tab lists five fixture sessions | `.project-session-row` count is 5 | `.project-session-row` |
| WB-09 | Recent workspaces pin/unpin | Context menu Add to recent / Remove from recent | `.recent-workspace-card` |
| WB-13 | Workspaces rail returns to atlas | Never restores last terminal subpage | `.workspace-atlas` |
| WB-16 | Add workspace dialog cancel is unique | Header close is Close dialog; footer is Cancel | `.mobius-modal` |
| WB-18 | Invalid path is recoverable | Error notice + dialog remains editable | `.mobius-notice.error` |

## SE · Sessions / handoff / Mome

| ID | Check | Expected | Locator |
|---|---|---|---|
| SE-01 | Session library lists five sessions | Five unique fixture titles | `.session-list-row` |
| SE-02 | Search filters the list | Query reduces visible rows | `.session-search-v2 input` |
| SE-10 | Handoff dialog lists five harnesses | Codex Claude Pi Grok OMP | `[role=dialog][aria-labelledby] select` |
| SE-13 | Mome search is explicit and bounded | Dialog titled Mome · Find related memory | `.mome-query input` |
| SE-14 | Sources dialog lists approved roots | Five approved fixture roots | `.session-sources-dialog .source-list article` |
| SE-17 | Removing a source updates the list | Approved count decreases by one | `[aria-label^='Remove source']` |
| SE-18 | Re-adding a source restores the list | Approved count returns to five | `button:has-text('Add source')` |
| SE-20 | Resume without harness is recoverable | Actionable error or Native resume unavailable | `.reader-actions-v2` |

## LG · Handoff graph

| ID | Check | Expected | Locator |
|---|---|---|---|
| LG-01 | Graph renders 5 nodes and 4 edges | One chain Codex→Claude→Pi→OMP plus Codex→Grok | `.react-flow__node.lineage-node` |
| LG-03 | OMP selection highlights four ancestors | `.ancestor` count is 4 | `.react-flow__node.lineage-node.ancestor` |
| LG-06 | Preview settings apply compact layout | `.lineage-node.compact` after compact checkbox | `button[aria-label='Preview settings']` |
| LG-07 | Preview settings persist across reload | `mobius.lineage.*` localStorage keys | `button[aria-label='Handoff graph']` |
| LG-09 | Multi-source preview is references-only | Review dialog preview contains references | `button[aria-label^='Handoff sources']` |
| LG-12 | 1100px graph has no horizontal overflow | panel scrollWidth <= clientWidth + 2 | `.session-lineage-panel` |

## TM · Terminal

| ID | Check | Expected | Locator |
|---|---|---|---|
| TM-01 | New PowerShell opens a tab | `.terminal-tab` count >= 1 | `.terminal-tab` |
| TM-02 | cwd is the drag-demo checkout | snapshot contains drag-demo | `.xterm-helper-textarea` |
| TM-06 | Ctrl+C recovers input | later command still echoes | `.xterm-helper-textarea` |
| TM-07 | Focus mode exits with Escape | `.terminal-focus` removed | `.mobius-app` |
| TM-10 | Session reference picker copies a packet | Copied status after selecting a message | `.session-reference-picker` |

## LI · Library

| ID | Check | Expected | Locator |
|---|---|---|---|
| LI-01 | Four library sections exist | Canvases, Notes, Mounts, Trash | `.library-tree-section header strong` |
| LI-02 | New note autosaves | `.note-save-state` includes Saved | `.note-save-state` |
| LI-08 | Mount dialog cancel is unique | Header Close dialog; footer Cancel | `button[title='Mount folder']` |
| LI-09 | Read-only mount appears in the tree | `.library-mount-branch` count is 1 | `.library-mount-branch` |
| LI-11 | Mounted document is read-only | Save state is Read-only mount | `.note-save-state` |
| LI-15 | Trash restore returns the note | Note row reappears | `.library-trash-item` |

## CA · Canvas

| ID | Check | Expected | Locator |
|---|---|---|---|
| CA-01 | New canvas opens the board | `.mobius-board` visible | `.library-create-button` |
| CA-02 | Toolbar creates objects | At least one `.react-flow__node` | `.board-toolbar` |
| CA-04 | Undo/redo restore object count | Count returns after redo | `[aria-label='Undo']` |
| CA-07 | Saved canvas appears in Library | Tree row with canvas title | `.library-tree-file` |
| CA-08 | Reopening restores objects | Node count >= objects created before leave | `.react-flow__node` |

## SK · Skills

| ID | Check | Expected | Locator |
|---|---|---|---|
| SK-01 | Skills page opens | Skill market / Installed segments | `.skills-library-v2` |
| SK-02 | Marketplace catalogue loads | `.skill-card-v2` count > 0 or explicit empty/error | `button:has-text('Skill market')` |
| SK-04 | Project-private skill is discoverable | drag-private-source in project Installed view | `.skill-card-v2` |
| SK-06 | Managed install targets drag-demo only | `list_managed_skills` destination under drag-demo | `button:has-text('Create editable copy')` |
| SK-10 | Uninstall removes the managed copy | Destination gone; source hash unchanged | `button:has-text('Uninstall managed copy')` |

## UX · Geometry / a11y / boundary

| ID | Check | Expected | Locator |
|---|---|---|---|
| UX-01 | Minimum viewport has no body overflow | 1100×720 overflowX <= 1 | `.mobius-app` |
| UX-02 | Visible controls are named | aria-label, title, placeholder, or text | `button, input, select` |
| BP-01 | Harness fixtures are unchanged | SHA-256 of fixture transcripts unchanged | `—` |
| BP-02 | No leftover managed skill | drag-demo/.agents/skills/drag-private-source absent | `—` |

Total rows: **58**.

