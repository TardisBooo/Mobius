# Agent session contract

Möbius indexes approved local Harness histories without changing their native
transcripts. The session surface is organised as workspace / checkout / Harness
/ session, with message search and selected-message highlighting.

## Continue a session

- **Same Harness only:** `Resume original` starts the original provider's
  verified native resume command in its resolved checkout. It is available only
  for adapters that explicitly advertise native continuation.
- **Different Harness:** Möbius never labels this as resume and never starts a
  target Agent with copied history. Select a message, then copy either an exact
  `@session:provider/id#mN(-mM)` reference or a context package. The person
  chooses where to paste it.

## Exact references

An exact reference identifies a provider-native session and an inclusive,
bounded message range. A range can contain at most 200 messages. The reference
picker and MCP server reject oversized ranges. If more than one approved source
has the same provider/native session ID, simple `@session:` resolution fails as
ambiguous rather than silently choosing a newer source; select the exact source
session in the desktop app and copy a context package instead.

## Related context and MCP

Mome only searches when the person explicitly requests it. Normal prompts do
not search other sessions or inject material into a terminal. MCP transcript
search, range reads, reference resolution, and Mome recall require a
short-lived desktop approval token. The MCP server cannot alter source
transcripts or launch processes.
