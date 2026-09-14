# ADR 0002: Reference-only Session handoff

Status: Accepted  
Date: 2026-09-15

## Context

A handoff can copy a prose summary or a projected chat transcript into a new Agent. That is convenient, but it silently changes the source, can omit decisions and does not preserve multi-hop provenance. Möbius already indexes native Sessions and must support several independent Sessions in the same directory.

## Decision

A Handoff transports a Reference Envelope, not generated prose or copied transcript content. The envelope points to the selected Session and its confirmed ancestors and exposes bounded read methods. The receiving Harness or LLM decides which original records to read.

The primary UI exposes this as one Session-level action: **Hand off this session**. The user chooses only the target Agent. Möbius automatically resolves the current Session and every confirmed ancestor into the envelope; it does not ask the user to select graph nodes, branches, messages, or a history scope. Graph inspection remains an optional diagnostic view and is not part of the handoff path.

Lineage is Session-to-Session. It is independent from Workspace, checkout, directory and Runtime parentage. A completed edge is written only after the target native Session identifier is verified. Failed, canceled and ambiguous operations remain operations and never masquerade as edges.

## Consequences

- Very large histories remain cheap to hand off because the envelope is bounded.
- Missing or revoked sources stay visible rather than being replaced with stale copied text.
- The target may choose not to read an ancestor; Möbius records provenance, not comprehension.
- UI can borrow Paseo's turn-boundary and fork placement patterns without adopting its chat-history attachment semantics.
- A user can hand off an empty or partially indexed Session because message selection is not part of Handoff identity.
