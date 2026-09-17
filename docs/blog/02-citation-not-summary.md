# Precise citation versus summary

Search that returns a paragraph titled "what we decided" is a different product from search that returns `@session:codex/abc#m12-m14`. Möbius only ships the second.

A summary is cheaper to paste. It is also the first thing to go stale, and it cannot be audited against the original JSONL. Precise citation is slower to read and honest about coverage: a large source may only have a head-and-tail catalogue. The UI has to say `partial` instead of pretending the index is the transcript.

## Three retrieval modes, one payload shape

1. **Precise reference.** You already know the session. Copy `@session:provider/id#mN` or `#mN-mM` and resolve that range.
2. **Lexical recall.** Mome searches a regenerable SQLite FTS5/BM25 chunk index. It prefers the current project/worktree among approved sources, returns at most three citable sessions, and caps output at about 1,200 tokens. Each hit carries a copyable `@session` range.
3. **Hybrid rank (opt-in).** Localhost Ollama `nomic-embed-text` can rerank those chunks with RRF. Missing Ollama, a missing model, or empty coverage fail open to lexical and set `semantic_status`. Vectors are derived. They may be deleted and rebuilt. They do not change the citation budget.

"Flaky tests" can surface "intermittent CI failures" without Möbius writing a new story about those sessions. Optional embeddings change rank, not the payload shape.

## Why summaries fail as a session layer

A handover.md is a claim about the past. The next agent cannot click through it to the tool call that actually failed. If you need a briefing, write one. Keep it next to the workbench as a note. Do not let the session layer mint it automatically.

Related: [cross-agent handoff](01-cross-agent-handoff.md), [Mome retrieval boundary](../mome-local-retrieval.md), [ADR 0004](../adr/0004-opencode-and-optional-embeddings.md).
