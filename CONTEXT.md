# Möbius domain language

## Project

A durable grouping of related work. A Project can contain several Workspaces and does not identify a conversation.

## Workspace

A stable, opaque work context owned by Möbius. Its directory, Git checkout and branch are attributes, not its identity. Two Workspaces may point at the same directory, and one directory may contain many Sessions.

## Checkout

A filesystem and Git placement associated with a Workspace. Main checkouts, worktrees and plain directories are different placements of work, not conversation ancestry.

## Session

A durable Harness conversation identified by source, Harness and native session identifier. A Session is history; it is not a process, terminal, directory or Agent status.

## Agent Runtime

One live or previously observed execution of an Agent. A Runtime belongs to exactly one Workspace and may be bound to a Session only when native identity evidence exists. Closing a client does not close a Runtime.

## Timeline

The ordered projection of a Session's authoritative Harness history. Live events improve immediacy; the Harness history remains authoritative and reconciles the projection.

## Timeline Cursor

A position composed of an epoch and sequence number. It identifies a projected history boundary without guessing from text, timestamps or array positions.

## Lineage

A directed acyclic graph of explicit Session-to-Session memory flow. Directory proximity, shared titles, runtime parentage and concurrent work do not create lineage.

## Handoff

A user-authorized operation that starts or selects a target Session and offers it references to a source Session and its confirmed ancestors. A Handoff becomes a Lineage edge only after the target native Session identity is verified.

## Runtime Parentage

The relationship created when one running Agent delegates work to a child Agent. It describes orchestration, not inherited memory, and is not a Lineage edge.

## Reference Envelope

The smallest transport for a Handoff: source Session identities, graph revision and bounded read methods. It contains no generated summary, transcript copy, credential or implied instruction to read every ancestor.

## Source Adapter

A read-only adapter that discovers and projects native Harness history. It never rewrites a Harness session or configuration.

## Provider Adapter

An adapter that uses an official Harness API or process interface to create, resume or control a managed Agent. Capabilities are explicit; missing capabilities disable only the corresponding action.

