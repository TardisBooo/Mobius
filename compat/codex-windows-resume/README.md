# Windows Codex resume compatibility

This is a separate, locally built Codex compatibility change, not an official
OpenAI release and not a binary bundled into the MÖBIUS installer.

Upstream: https://github.com/openai/codex

Base revision: `8e3b180d49951c3e53140710b2baad09791cc999`.

Patch: [`windows-resume.patch`](windows-resume.patch). Apply it to a checkout
of that revision with `git apply windows-resume.patch`. Upstream licensing is
preserved in `UPSTREAM-LICENSE` and `UPSTREAM-NOTICE` (Apache-2.0 and notices),
separate from the MÖBIUS repository's MIT license.

## Why two repairs are needed

MÖBIUS fixes its own catalogue identities and verifies the native source before
launching it. Codex owns the external terminal's history picker. Fixing one
does not automatically fix the other.

On Windows, the compatibility change:

- Compares ordinary and verbatim drive/UNC cwd spellings consistently, without
  removing the current-project filter.
- Explicitly requests all historical providers in the picker. The API treats
  an omitted provider filter differently from an empty provider list.
- Keeps the currently configured local provider when restoring a historical
  thread, while restoring its saved model. Remote routing stays server-owned.

No historical JSONL, credentials, project trust or provider labels are rewritten.

## Build and acceptance

Use the repository-pinned Rust toolchain and standard release profile:

```powershell
cargo build --release -p codex-cli --bin codex
just test -p codex-state -p codex-tui --lib --release -j 4 -E 'package(codex-state) | test(resume_picker) | test(thread_resume_params)'
```

Run these inside upstream `codex-rs`, with the patch applied. Do not disable LTO
only for the final CLI crate: its existing release dependencies may contain
LLVM bitcode that cannot be linked that way on Windows.

Before switching any launcher, follow
[external acceptance](../../docs/acceptance/external-codex-resume.md).
An exact-ID API result alone is insufficient: default Cwd/Active discovery,
actual `/resume`, and the restored continuation ID must all pass.

Preserve the original executable and launcher outside the active build tree.
Install an accepted compatibility executable alongside the original, not over
a running executable. Record the exact launcher change and rollback path.
An npm update can replace the launcher and therefore remove this local patch.

Raw terminal evidence can contain private conversation content. Keep it out of
Git, release attachments and public screenshots.
