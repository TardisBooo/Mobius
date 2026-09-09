# Mome local retrieval boundary

Mome is an explicit, local context-recall feature. It is not default chat
history, and no command adds another session to a prompt unless the caller
requests it.

## What recall does today

`mobius mome recall <query>` and the MCP `mome_recall` tool search a
regenerable SQLite FTS5/BM25 index built from already-indexed messages. Source
session files are not opened by recall. Each response is limited to 1,200
estimated tokens and at most three distinct, precisely cited sessions.

The hook form is also opt-in: only a prompt that begins exactly with
`@mome ` produces a context packet. The CLI returns that packet for the
Harness integration to handle; it never types, pastes, or injects it into a
PTY. MCP recall additionally needs a short-lived desktop approval matching
the exact query and selected scope.

This release is **lexical BM25 only**. `retrievalMode: "lexical_bm25"` and
`semanticStatus: "lexical_only_no_semantic_backend_configured"` deliberately
mean that no semantic/vector ranker has run. An installed embedding model is
not presented as hybrid retrieval until a vector backend is actually wired in.

## Optional local model runtime

Mome can inspect the conventional local [Ollama](https://ollama.com/) CLI for
an embedding model without downloading or contacting a model service:

```powershell
mobius mome model status
mobius mome doctor
```

The default inspected model is `nomic-embed-text`; another local model name
can be supplied with `--model`. The status command runs only `ollama ls` if
Ollama is on `PATH`. It reports whether the model is local and makes clear that
semantic retrieval remains disabled.

No model is bundled, and neither recall, hook, MCP, doctor, nor model status
downloads one. An operator who has reviewed the model source and wants to
allow the network-affecting step must make that choice explicit:

```powershell
mobius mome model install --model nomic-embed-text --accept-download
```

That command directly runs `ollama pull` for the exact validated model name.
Without `--accept-download` it refuses before starting a download. If Ollama
is not installed or running, Mome reports that condition and leaves the host
unchanged.

## Remaining semantic/hybrid boundary

Local model installation is setup and diagnosis only in this release. Mome
does not yet create embeddings, persist vectors, or send transcript text to
Ollama. Consequently it cannot honestly claim hybrid retrieval. A future
backend must remain explicit, disclose that selected indexed text will be sent
to a local runtime, use a regenerable derived vector index, and preserve the
same three-session/1,200-token/citation limits.
