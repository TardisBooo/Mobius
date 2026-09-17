# Cross-agent handoff is a graph, not a briefing

A coding-agent session ends when its context window ends. The project does not.

The usual fix is a handover file: current state, next steps, decisions. That is useful for a human shift change. It is the wrong shape for switching from Codex to Claude.

Möbius treats a Session as a durable harness conversation: source, harness, native id. Native resume stays with the original CLI. A handoff always creates a new target session. The payload is a lineage graph: entry sessions, ancestor nodes, confirmed edges, and locators for original files. Möbius does not claim the target has read those files. The target decides what to open.

That rule comes from a failure we kept hitting. Copying a transcript, or asking a model to compress one, destroys the evidence trail and can invent a todo list the source never agreed to. A 1.2 GB Codex JSONL can still be handed off because the envelope never contains the body.

## What the envelope holds

- Session identities (provider + native id)
- Confirmed inherited edges (handoff / merge). Reference edges do not inherit.
- Locators into the original files, including OpenCode's `{db}#opencode:{id}`
- A reviewable token estimate

`content_mode` is `references_only`. If you want a briefing, write one in a note. The session layer keeps the tape.

## What the operator still has to do

CLI `approvals handoff` and MCP `commit_handoff` share one short-lived token. A person types `APPROVE` in a real terminal. MCP cannot mint that token. A launcher PID is not a bound native session; inspect `handoff status` (`prepared`, `starting`, `awaiting_identity`, `bound`, `failed`).

## Why this gets more useful as agents multiply

Each extra harness on the same checkout multiplies paste events. The graph does not get smarter by itself. It stays auditable: who continued the work, from which session, over which message range.

Related: [precise citation versus summary](02-citation-not-summary.md), [approval tokens](03-approval-tokens.md), [ADR 0002](../adr/0002-reference-only-session-handoff.md).
