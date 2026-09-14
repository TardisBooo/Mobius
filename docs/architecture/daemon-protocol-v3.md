# Möbius daemon protocol v3 contract

Status: design baseline; not yet the active wire protocol. The current `mydesk-v2` named pipe remains compatible until clients migrate.

## Ownership

`mobiusd` is the sole owner of managed Agent processes and PTYs. It owns runtime lifecycle, capability negotiation, authoritative Session projections and Lineage operations. Desktop, CLI and MCP are clients.

## Identity rules

- `workspace_id` is opaque and never parsed as a path.
- `session_id` is a Möbius catalogue identity backed by a source, Harness and native ID.
- `runtime_id` identifies one execution and never substitutes for `session_id`.
- `timeline_cursor` is `{ epoch, sequence }`; text and timestamps are not durable cursors.
- `handoff_operation_id` is idempotency scope; it is not a Lineage edge.

## Capability families

- Catalogue: list/search/read Session, read Timeline pages.
- Runtime: create, native resume, send, interrupt, attach terminal, stop.
- Lineage: prepare references, read graph page, commit after identity verification.
- Workspace: list/create/archive, never infer ownership from cwd during normal runtime.

Capabilities are advertised per Provider Adapter. An unsupported capability disables that action only.

## Timeline synchronization

Live events provide immediate presentation. A bounded authoritative history request establishes or reconciles the canonical range. Responses include epoch, minimum and maximum sequence, and older/newer availability. Epoch change or a true gap replaces stale canonical data atomically. Opening a Session fetches the latest bounded tail; older pages are user-driven.

## Handoff state machine

```text
prepared -> starting -> awaiting_identity -> bound
    |          |                |
    +------> failed/cancelled/unknown
```

Only `bound` writes confirmed Lineage edges. Retry reuses the operation ID and reconciles first.

## Security boundary

- Source reads require an approved source root and bounded range.
- Default MCP methods are read-only.
- Handoff commit and runtime control require short-lived user authorization.
- No method installs hooks, changes model/provider configuration, or writes Harness history.
- Logs report paths and state only at the user's authorized detail level; credentials are never returned.

## Migration

1. Add v3 domain objects beside current models.
2. Expose read-only v3 catalogue endpoints.
3. Migrate Desktop Session/Workspace views.
4. Move runtime ownership behind v3.
5. Migrate independent CLI/MCP.
6. Retire v2 only after packaged compatibility and rollback acceptance.

