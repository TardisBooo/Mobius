# External Codex resume acceptance

Möbius' native-launch checks and Codex's own history picker are separate
surfaces. A successful `codex resume <id>` does not prove that the default
`codex resume` or `/resume` picker can discover that ID.

## Required checks

1. Copy one real root-session transcript into a new private test home. Do not
   copy credentials, publish the transcript, or change the original JSONL.
2. Configure a different historical/current provider and an offline test
   endpoint. Keep the test project explicitly untrusted so project-local hooks
   and configuration do not load. Do not accept onboarding security prompts.
3. Compare the original client with the compatibility build using the same
   Windows ordinary/verbatim cwd pair. Keep the default Cwd/Active filters.
4. Confirm the original client reproduces the empty list; the repaired client
   must display the row, restore the exact ID and preserve runtime routing.
5. Repeat through the actual external launcher and `/resume`, without submitting
   a model prompt. Record the restored ID privately, not in public screenshots.
6. Confirm every pre-existing byte of the original transcript is unchanged.
   An append by its already-running writer is not an alteration of old content.

`tests/codex_native_resume.py` exercises the native app-server API;
`tests/codex_resume_pty.py` exercises the actual terminal picker over ConPTY and
reconstructs the rendered screen with `pyte`. The terminal helper requires
`pywinpty` and `pyte` (`pip install -r tests/requirements-resume.txt`, Python
3.11 or newer). Its raw logs and reconstructed screen can contain private
history and must remain outside Git.

## Compatibility patch boundary

The local Windows patch normalizes cwd spellings when comparing indexed
threads, and lets the picker discover threads from historical providers while
explicitly sending an empty provider list (omission means the current provider
in the API). Local Windows resume forwards the current provider while retaining
the saved model settings; remote sessions retain server-side selection.
It does not rewrite history,
relabel database providers, grant project trust or alter credentials.

The cwd comparison resolves equivalent stored spellings in a subquery and
retains the indexed outer cwd lookup. A logical Windows directory can expand
to several historical spellings, so ordering merges those results. Regression
coverage explicitly checks that the outer lookup uses the archived/cwd index.

## Source regression results

- `just test -p codex-state --lib --release -j 4`: 189 tests passed, including
  path equivalence, project isolation, pagination and query-plan coverage.
- The scoped TUI run (`test(resume_picker) | test(thread_resume_params)`) passed
  116 checks. Nextest reported three leak warnings in existing transcript
  preview checks; these are not presented as a warning-free full-suite run.
- `just fmt` and `git diff --check` completed. Unrelated Windows line-ending
  changes from the repository formatter were removed from the patch.

These source checks do not replace real external-terminal acceptance.

## Terminal acceptance — 2026-09-11

| Check | Result |
| --- | --- |
| Original 0.153.4, isolated real-history copy | Reproduced empty default Cwd/Active picker through both entrypoints |
| Compatibility client, same isolated home | `codex resume` and typed `/resume` PASS; original thread ID restored |
| Production home, unoccupied real historical thread | Native client and fresh external PowerShell `codex resume` PASS |
| Production home, fresh external PowerShell, typed `/resume` | PASS; default Cwd/Active filters retained, original ID restored |
| Existing transcript bytes | PASS; prefix hashes unchanged, native/concurrent appends allowed |
| Currently running original thread, both PowerShell entrypoints | Visible in the default picker; second writer correctly refused, not forcibly taken over |

No model turn was submitted. The actual PowerShell checks resolve `codex` through
the installed npm launcher, not a recording shim. The unoccupied real thread was
selected by its native ID in the populated picker; no database relabeling or
temporary removal of the project/provider configuration was used.

The configured `cua_repl` MCP startup warning was reproduced with both the
original 0.153.4 client and the compatibility client. MCP tool execution was
not part of this scoped recovery acceptance; no MCP configuration was changed.

The accepted local client is built from source revision `8e3b180d49` plus the
[compatibility patch](../../compat/codex-windows-resume/README.md), **not an
official OpenAI release**. It reports the upstream workspace version `0.0.0`.
The original 0.153.4 executable remains installed. The backed-up npm launcher
now selects the compatibility executable for new processes and suppresses its
automatic update prompt; manual npm updates may replace that launcher.

Local runtime/provenance/rollback instructions:
`D:/SOFTWARE/CodexResumeCompat/8e3b180d49/README.md`.
Original launcher and executable backup:
`D:/DataVault/Mobius/recovery/resume-20260911/external-codex-original`.

This runtime is not bundled into the MÖBIUS installer. Existing Codex processes
continue using their original binary. A thread with an active writer must be
closed normally in its existing terminal before another terminal can resume it;
do not remove locks, rewrite transcripts or kill unrelated sessions.
