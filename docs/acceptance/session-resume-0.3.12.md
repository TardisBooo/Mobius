# Session recovery regression — 0.3.12

## Scope

This patch repairs Möbius catalogue identity, source relocation and native-launch
preflight. It does not replace Codex's own picker or change the user's model
provider, authentication, project trust or historical JSONL files.

## Changes

- Codex identity comes from the first session header's `id`, ahead of legacy
  `session_id` aliases and inherited parent headers.
- Child-agent histories retain their own identities and parent references.
  They remain inspectable/searchable, but do not advertise independent native
  resume: Codex rejects unloaded child agents and requires their parent first.
- Reindexing retains Möbius row IDs, preserving exact references and relay edges.
- Previously approved missing roots no longer abort manifest loading. Explicit
  SessionMaps support ordinary/verbatim Windows drive and UNC path forms.
- Sources that disappear lose native-resume availability. Relocation only follows
  explicit mappings and matching source identity; existing row identities are not
  merged. Source availability is checked again immediately before launching.
- Codex launch verifies the source header against the selected ID and scopes
  `CODEX_HOME` to the source's native home, restoring the shell environment afterward.

## Verification

| Gate | Method | Result |
| --- | --- | --- |
| Core regression | `cargo test -p mydesk-core -p mobius-desktop` | 50 core unit tests and 13 desktop unit tests pass; integration runner reports 7 passes, including 2 environment-gated early returns; one pre-existing isolated test remains ignored |
| Identity / parent alias / inherited header | Synthetic header regression | PASS |
| Migration / verbatim paths / stable row IDs | Move a test-owned source and refresh twice | PASS |
| Missing, changed and malformed source | Rebuilt packaged Tauri IPC negative tests | PASS; no unexpected PTY created and no fallback to an inherited header |
| Selected ID and source-owned home | Packaged Tauri + real PowerShell + recording CLI shim | PASS; actual shim output checked, not merely command echo |
| Real Codex root resume | Installed Codex 0.153.4 app-server, isolated copy of real history | PASS; returned ID and cwd match |
| Real Codex child restriction | Same native service with an isolated child-history copy | Confirmed rejection; Möbius disables independent child resume |
| Historical source preservation | Hash every pre-existing byte before/after native check | PASS; concurrent append by the active conversation is allowed |
| Production catalogue repair | Read-only identity and relay audit against pre-repair backup | PASS: 1,902 available Codex rows; zero missing sources, wrong identities, resumable children, lost row IDs or changed relay edges |
| Build | `pnpm exec tauri build` | Optimized Windows EXE and offline-WebView2 NSIS installer built |

No new model turn or paid inference was submitted. The recording shim is not
presented as a real model test. This is a scoped recovery regression, not a claim
that every UI feature, provider or installer/uninstaller lifecycle was retested.

## External Codex picker

Codex's local picker filters by model provider as well as cwd. `resume --all`
disables cwd filtering, **not** provider filtering. A historical `openai` thread
may therefore be absent under a different current provider. Old state databases
can also contain verbatim cwd strings that differ from normalized picker paths.

Use `codex resume <native-session-id>` with the correct `CODEX_HOME` to bypass
list filtering. Provider restoration depends on the client: an exact ID alone
does not guarantee that the currently configured provider is retained.
Do not relabel historical
provider metadata or rewrite transcripts just to make a picker list nonempty.
Möbius uses this exact-ID, source-owned-home route and refuses stale identity.
For Codex it also passes the selected project through the official `-C` option
using an ordinary Windows drive or UNC spelling. It does not patch the Codex
binary or launcher and does not rewrite Codex history, state, provider settings,
credentials or project trust.

**External default-picker acceptance with official Codex 0.153.4: KNOWN LIMIT.**
The real PowerShell `/resume` test reproduces an empty Cwd/Active list when an
existing Codex state row uses a verbatim cwd spelling or a historical model
provider differs from the current configuration. The source transcript can
still contain the ordinary path. This behavior is inside the official picker's
own state query and cannot be changed from Möbius without crossing the ownership
boundary above. Use the exact native ID through Möbius or `codex resume <id>`.
Close an active writer normally before resuming the same thread elsewhere.

## Reproduce

- `cargo test -p mydesk-core -p mobius-desktop`
- `python tests/codex_native_resume.py --codex <native-exe> --source <JSONL> --sandbox <new-isolated-directory>`
- `python tests/audit_resume_catalogue.py --database <mobius.sqlite> --baseline <pre-repair.sqlite>`
- `python tests/setup_resume_fixture.py <new-isolated-directory>` then launch the
  packaged app with its `MOBIUS_*` roots pointed there, a loopback-only WebView2
  diagnostic port 9367, `MOBIUS_CODEX_HOME=<root>/native-home`, a deliberately
  different `CODEX_HOME`, and `<root>/bin` first on PATH.
- Set `MOBIUS_RESUME_TEST_ROOT` and run `node tests/resume-packaged.mjs` from
  `apps/desktop`. This test refuses a shared data profile.

Local recovery backup and private audit evidence belong under
`D:/DataVault/Mobius/recovery/resume-20260911`; accepted release assets belong
under `D:/AcceptedArtifacts/Mobius/v0.3.12`. Temporary native copies and test
profiles under `E:/Workspaces/_verification/mobius-resume-20260911` are retained
for review, not the sole copy of history or accepted outputs.
