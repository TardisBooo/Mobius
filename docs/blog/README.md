# Möbius technical notes

Three short design notes for the Agent Session Hub. They match the v0.3.19 code: reference-only handoff, bounded citation, human approval tokens.

| Note | Claim |
| --- | --- |
| [01 Cross-agent handoff](01-cross-agent-handoff.md) | The payload is a lineage graph, not a briefing file |
| [02 Citation vs summary](02-citation-not-summary.md) | `@session:provider/id#mN-mM` is the product; summaries are notes |
| [03 Approval tokens](03-approval-tokens.md) | MCP cannot mint the grant that returns bodies or launches |

Chinese readers: the same facts live in [README.zh-CN.md](../../README.zh-CN.md). These notes stay in English so they can be posted next to the HN / X / r/ClaudeCode drafts in [docs/gtm/launch.md](../gtm/launch.md).
