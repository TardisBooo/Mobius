# Harness ownership boundary — 0.3.13

## Contract

MÖBIUS integrates installed agents through their documented command-line
interfaces. It may select a working directory, pass an exact native session ID
and scope a harness home for the child process. It must not patch or replace a
harness executable or launcher, rewrite its history/state database, relabel a
provider, alter credentials, or change project trust.

For Codex, new handoffs and native resume commands now pass the selected project
through the official `-C <directory>` option after converting Windows verbatim
drive and UNC paths to their ordinary spelling. Native resume still uses the
source-verified ID with `codex resume <id>`.

## Root-cause correction

The affected historical transcript already stored an ordinary Windows cwd and
predated the current MÖBIUS build. The official Codex state index contained a
verbatim cwd spelling, while the historical session provider differed from the
current configured provider. MÖBIUS did not write either field.

Official Codex 0.153.4 was restored before this acceptance. Its installed npm
launcher matches the pre-test backup byte-for-byte and reports version 0.153.4.
The experimental source branch was removed and the Codex source worktree was
returned to its original upstream revision. The custom Codex patch, terminal
test and acceptance claims were removed from this repository. The custom binary
is no longer selected by the launcher; a process started before restoration may
continue using its already-loaded executable until that process exits normally.

## Verification

| Gate | Result |
| --- | --- |
| `cargo test -p mydesk-core -p mobius-desktop` | PASS: 50 core and 13 desktop unit tests; 7 integration tests passed; 1 fixture-gated test remained ignored |
| Official Codex app-server, isolated copy of real history | PASS: exact native ID, requested cwd and original transcript prefix preserved; no model turn submitted |
| Official Codex CLI parsing of `-C <directory> resume` | PASS with installed 0.153.4 |
| MÖBIUS command generation | PASS: Codex receives the ordinary working-root argument; other harness command formats are unchanged |
| External PowerShell `/resume`, existing affected state | KNOWN LIMIT: official Cwd/Active picker remains empty |

The final row is not presented as a MÖBIUS pass. An external picker query is
owned by Codex; MÖBIUS cannot change its result without editing the harness or
its state/configuration. Existing affected sessions remain recoverable through
the official exact-ID command exposed by MÖBIUS. A session with an active writer
must be closed normally before another process resumes it.

## Official 0.154.0 revalidation (2026-09-11)

After restoring the official launcher, Codex was updated using
`npm install -g @openai/codex@0.154.0 --registry=https://registry.npmjs.org`.
The installed launcher, native executable and code-mode host match their
official npm distribution files byte-for-byte. No custom harness patch is used.

- Packaged MÖBIUS 0.3.13: PASS with a separate WebView2 user-data directory.
  Real IPC and PowerShell deliver the exact native ID, ordinary `-C` directory
  and source-owned home to the recording CLI. Child sessions, missing sources,
  malformed headers and changed identities are rejected.
- Official Codex 0.154.0 through external PowerShell: PASS for app-server
  history read, exact-ID resume and requested cwd using an isolated copy of a
  real transcript. Original bytes remain unchanged; no model turn is sent.
- The documented CLI shape `-C <directory> resume <id>` is accepted by 0.154.0.
- Interactive TUI continuation in the credential-free isolated profile is
  not accepted: it stops at first-run login. No production credentials were
  copied to bypass that gate. The historical default-picker limitation above
  was observed on 0.153.4. The later 0.154.0 discovery check below isolates
  provider filtering; successful continuation is a separate gate.

Reproduce the external PowerShell check with:

```powershell
python tests/codex_native_resume.py --powershell --codex <official-codex.cmd> --source <source.jsonl> --sandbox <new-verification-directory>
```

The packaged IPC test uses `WEBVIEW2_USER_DATA_FOLDER=<isolated-root>/webview`
to avoid conflict with an already-open user instance. This follow-up changes
only verification and documentation; the accepted 0.3.13 application binary
remains unchanged. Previously loaded processes require a normal restart before
they use the newly installed official version.

## Official 0.154.0 external picker diagnosis

A subsequent real ConPTY test launched official Codex from external PowerShell
using the existing home and project directory. It only inspected the picker;
it did not select or resume a session, submit a prompt, or edit configuration.

| Runtime options | Result |
| --- | --- |
| Current configured provider, project filter | Empty |
| Historical provider via official `-c`, all directories | Populated |
| Historical provider via official `-c`, same project filter | Exactly one main CLI session |
| Same project and historical provider, search by native ID | Expected main session found |

Read-only state inspection found one main CLI session and 60 child sessions
under the affected project, all marked with the historical provider. The
current provider name differs. The last two tests demonstrate that cwd spelling
is not the blocking factor for this case on 0.154.0. The earlier Windows-path
explanation must not be presented as the proven current cause.

The official per-process `-c model_provider=<historical-provider> resume`
option makes the history discoverable without changing the installed harness
or persistent configuration. It also changes the process's provider selection,
so this diagnostic is not a recommendation to execute model work with different
routing or credentials. MÖBIUS exact-ID resume bypasses picker discovery; it
cannot change what an independently launched official picker filters. Plain
external `/resume` under the current provider remains unresolved within the
constraint against modifying harness configuration or historical metadata.

## Resolution after authorized custom-provider rollback

The user subsequently authorized removal of the Codex Grok/router integration.
The pre-integration configuration backup identified the original model and
built-in provider. The rollback restored that model and removed the custom
provider/catalogue, router transport override and Grok Prewalk presets, while
preserving unrelated project settings and hooks. Dedicated router configs and
its startup entry were moved to a recoverable private archive. No harness
source, binary, authentication file, history JSONL or SQLite record was edited.

Revalidation with the unchanged official Codex 0.154.0:

- External PowerShell `codex resume` in the project: default Cwd/Active list
  contains the expected main session, without any provider override.
- Starting Codex and typing `/resume`: the same default list is populated.
- Packaged MÖBIUS with real PowerShell and installed official Codex: same list.
- Selecting the currently active session externally and invoking MÖBIUS'
  `resume_session` handler: both reach the official active-writer protection.

The empty-list issue is resolved after restoring the original provider.
Continuing the still-open conversation requires its existing process to exit
normally; no takeover or model turn was performed. Already-running clients can
retain their previous configuration and must be restarted. The legacy router
has no startup entry; its running process is retained until old clients exit.
