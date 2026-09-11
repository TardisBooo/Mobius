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
  was observed on 0.153.4; its status on 0.154.0 remains unverified.

Reproduce the external PowerShell check with:

```powershell
python tests/codex_native_resume.py --powershell --codex <official-codex.cmd> --source <source.jsonl> --sandbox <new-verification-directory>
```

The packaged IPC test uses `WEBVIEW2_USER_DATA_FOLDER=<isolated-root>/webview`
to avoid conflict with an already-open user instance. This follow-up changes
only verification and documentation; the accepted 0.3.13 application binary
remains unchanged. Previously loaded processes require a normal restart before
they use the newly installed official version.
