# ADR 0003: Atomic Library snapshots

Status: Accepted  
Date: 2026-09-16

## Context

Mounted Library Sources are persistent user choices, while their directories can change outside Möbius at any time. The desktop previously requested configured mounts and scanned files independently. Concurrent automatic refreshes, manual refreshes and mount mutations could therefore finish out of order and temporarily combine an older file scan with a newer configuration. A selected read-only document could also remain visible after its source was unmounted or disappeared.

## Decision

Möbius exposes one `NoteLibrarySnapshot` for Library refreshes. A snapshot contains the mount configuration captured at scan start, all files discovered from exactly those mounts, and a runtime status for each mount. Desktop applies only the newest requested snapshot as one replacement; older responses are discarded.

The native desktop owns one recursive filesystem watcher for the private notes vault and each non-overlapping Mounted Library Source. Native events carry no cached directory model; they only signal the renderer to rebuild a snapshot after a short debounce. The periodic snapshot remains a fallback because operating systems and network filesystems may drop watcher events. Clean open documents follow external changes; an unsaved editable working copy is never overwritten by a watcher event.

Mount configuration remains persistent until an explicit unmount. Scan status is transient: an unavailable source has no files in the snapshot and is shown as unavailable rather than being represented by a retained cache. Mount roots must not overlap, because overlapping roots make one physical file appear as multiple competing Library identities.

## Consequences

- A file that is deleted, unmounted or no longer readable disappears on the next accepted snapshot instead of surviving in the tree or editor.
- Refresh order is deterministic even when filesystem scans finish out of order.
- Local create, update, rename and delete operations normally reach the tree and clean preview immediately through native events.
- A large source is capped independently and labelled partial rather than silently starving later mounts.
- Existing configured sources are not automatically removed; users retain ownership of that decision through explicit unmount.
