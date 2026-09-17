# Approval tokens: agents do not grant themselves history

An MCP server that can search every local Codex and Claude transcript is a privilege boundary, not a convenience feature.

Möbius keeps metadata tools open (`list_sessions`, `get_session`, `get_lineage`, `get_index_health`) and puts a human token in front of anything that returns bodies or launches a handoff (`search_sessions`, `mome_recall`, `read_session_range` / `get_messages`, `commit_handoff`).

## What the token is

- Short-lived
- Single-use
- Scoped to an exact query, byte range, or handoff id

The desktop or `mobius-connect approvals` mints it after a person types `APPROVE` in a real terminal. The MCP process cannot mint one. `request_session_approval` only describes the grant. A model saying "the user authorized this" is not a credential.

That is more friction than always-on MCP search. It matches the Möbius rule that ordinary chat does not read other sessions. Search is not read, and read is not inheritance. Hybrid embeddings use the same grant as lexical recall: turning on Ollama does not expand what an agent may see.

## Operational rules

The token is shown once. Do not log it. Do not retry an unknown launch with the same token. Inspect `handoff status` instead. A started process is not a bound native session.

MCP also cannot add sources or attach a PTY. Broadening approved roots is a person at a terminal (`sources add`), never a tool call.

Related: [MCP contract](https://github.com/TardisBooo/mobius-connect/blob/main/docs/MCP.md), [handoff as a graph](01-cross-agent-handoff.md), [SOP](../sop-session-hub.md).
