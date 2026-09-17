# ADR 0004: OpenCode SQLite adapter and optional local embeddings

- Status: Accepted
- Date: 2026-09-16

## Context

Möbius is the session layer between local coding agents. OpenCode stores history
in `opencode.db`, not JSONL. Keyword search misses paraphrases such as "flaky
tests" vs "intermittent CI failures". Summaries are not an acceptable substitute
for trajectory.

## Decision

1. Add `AgentKind::Opencode` as a first-class supported provider.
2. Index OpenCode by opening `opencode.db` read-only. Catalogue each native
   session with locator `{db}#opencode:{id}` so range reads cannot leak other
   sessions from the same file.
3. Keep lexical BM25 as the required recall path.
4. Add opt-in localhost embeddings (Ollama `nomic-embed-text`) as a regenerable
   derived index. Hybrid ranking uses RRF. Missing models fail open to lexical
   and report `semantic_status`.
5. Preserve the Mome citation budget: at most three sessions, about 1,200 tokens.

## Consequences

- Desktop, CLI and MCP must list `opencode` beside existing harnesses.
- Native resume for OpenCode stays disabled until a verified protocol exists.
- Vectors may be deleted and rebuilt; transcripts remain the authority.
- Enablement must disclose that selected indexed chunks may be sent to localhost.
