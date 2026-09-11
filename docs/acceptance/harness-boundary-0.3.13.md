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
