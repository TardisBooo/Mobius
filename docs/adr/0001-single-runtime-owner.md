# ADR 0001: One runtime owner and non-invasive Harness adapters

Status: Accepted  
Date: 2026-09-15

## Context

Möbius currently mixes desktop-owned terminals, historical Session state and provider-specific launch behavior. Integrating another terminal server alongside it would create two owners for the same process and PTY. Some upstream terminal integrations also obtain status by changing Harness hook or configuration files, which violates Möbius's compatibility boundary.

## Decision

Möbius will converge on one daemon as the only owner of managed Agent processes and PTYs. Desktop, CLI and MCP will use one versioned local protocol.

Provider adapters may use documented official APIs or process interfaces. Source adapters remain read-only. Möbius must not modify Harness source, configuration, hooks or historical Session files. Screen/process observations may report Runtime state but cannot prove native Session identity.

Paseo's daemon/provider separation is the architectural reference. Herdr's PTY, attach/detach and evidence-based state semantics are implementation references; Herdr is not embedded as a second runtime owner.

## Consequences

- Existing desktop commands remain as a compatibility surface while daemon protocol v3 is introduced.
- Runtime status and Session source status become separate models.
- Closing Desktop means detaching unless the user explicitly stops a Runtime or daemon.
- A provider without an official identity signal may remain unbound; the UI must show that uncertainty.
- Any future Herdr backend must prove a no-hook Windows contract before adoption.

