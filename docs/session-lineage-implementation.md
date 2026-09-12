# Session lineage implementation

## Contract

Handoffs carry a graph of native session references, not a transcript snapshot,
summary, compression, or an instruction to read every event. Native harness code,
configuration and historical logs remain untouched. Desktop, independent CLI and
MCP must share the same graph and source authorization semantics.

## Baseline audit

- Published baseline: b4b2f88 (0.3.13).
- The MyDesk working directory contains untracked 0.1.0 source and is not the
  published application. Preserve it; do not build releases from it.
- Legacy trajectory preparation reads and copies complete native logs, rejects
  files over 16 MiB, and forces full reading. Replace that launch path.
- Legacy relay chains are workspace-filtered and bind a single source edge.
  Session ancestry must be independent of presentation filters and support merges.

## Acceptance status (development branch, not a release)

- [x] Reference-only preparation of a >1 GB source without reading its body.
- [x] Branch ancestry excludes siblings; merge ancestry deduplicates shared roots.
- [x] Missing sources remain explicit; unauthorized sources are not exposed.
- [ ] Native session identity, event provenance and display timestamps are factual.
- [ ] Desktop graph, independent CLI, MCP and explicit plugin share behavior.
- [ ] Real harness launch, source resolution, internal/external native resume.
- [ ] Build, packaged desktop interaction and independent release verification.

Old snapshots are retained for compatibility and recovery, not rewritten.
No release is accepted merely because tests using fixtures pass.

## Recorded checks

- `cargo test -p mydesk-core --offline --quiet`: 58 unit tests passed; seven
  additional integration tests passed. The separately provisioned legacy
  acceptance test is ignored and is not counted as passed.
- `cargo build -p mobius-desktop --offline`: debug desktop built.
- `pnpm run build` in `apps/desktop`: TypeScript and production frontend built.
- `tests/acceptance/verify-lineage-webview.cjs`: real Tauri IPC and WebView,
  fictional four-session diamond. Passed ancestry highlighting, node dragging,
  context menu, persisted alias, multi-source review, explicit confirmation and
  actual light/dark theme button switching. This does not launch a harness.
- `probe_reference_source`: an explicitly selected real source of 1,224,790,320
  bytes produced a 758-byte graph; preparation and validation took 56 ms in that
  run. No full-source copy was created, no read-to-EOF prompt was generated,
  and source size/mtime were unchanged during the probe. Native source identity
  was obtained from its bounded header; its conversation body was not read.
- Native Windows Computer Use was unavailable (native pipe absent after the
  documented recovery attempts). Do not equate WebView testing with physical
  native desktop/installer acceptance.
- `verify-native-codex-lifecycle.cjs --submit-test-turn`: installed official
  Codex CLI 0.154.0 created a real fixed-response test turn, read its thread and
  resumed the same native thread after the server process was restarted. It
  used existing native authentication without copying credentials, an isolated
  project and read-only permissions. No harness configuration or historical
  session was edited. This is app-server lifecycle evidence, not external TUI
  `/resume`, cross-harness handoff or memory-content acceptance.
  Protocol reference: [official app-server documentation](https://learn.chatgpt.com/docs/app-server#start-or-resume-a-thread).
  The installed API required `read-only` sandbox spelling; an empty thread did
  not yet have a persisted rollout. Both findings are reflected in the test.

## Remaining release gates

Native launch and external resume for each supported harness; robust target
identity provenance beyond a user-message marker; plugin-host loading; lifecycle
reconciliation after ambiguous process results; installer lifecycle; and the
independent repository's immutable shared-core dependency remain unaccepted.
The standalone HTML export is a static reference list, not a completed graph UI.
No harness source/configuration or historical transcript was changed by this work.

The old `verify-real-trajectory.cjs` and `launch-real.ps1` describe the previous
snapshot design and historical fixture paths. They are retained for historical
review, not used as acceptance evidence for reference-only handoffs.

## Workspace disposition

The stale untracked source in the original MyDesk directory is preserved.
Canonical development is under `E:\Workspaces\Mobius\repos\desktop`; the
independent tool is under the sibling `mobius-connect` repository. Verification
trees under `E:\Workspaces\_verification\mobius-lineage-20260912-run01` (failed
old-constraint seed) and `run02` (isolated WebView evidence) are retained for
review, not accepted deliverables or approved deletion targets. Durable accepted
outputs belong in `D:\AcceptedArtifacts\Mobius`; no new release has been accepted.
Native test trees `E:\Workspaces\_verification\mobius-native-codex-20260912-run01`
and `run02` retain the rejected-schema and empty-thread probes; `run03` retains
the passing live native test report. All three are retained for review. The
single new test conversation was written by Codex itself and is not deleted.
