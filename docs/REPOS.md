# Repositories

Möbius ships as two GitHub repositories. They share one Rust core and one product name.

| Repository | Public name | What it is |
| --- | --- | --- |
| [TardisBooo/Mobius](https://github.com/TardisBooo/Mobius) | Möbius desktop | Windows workspace: session library, PowerShell workbench, handoff graph, notes, canvas, skills |
| [TardisBooo/mobius-connect](https://github.com/TardisBooo/mobius-connect) | mobius-connect | CLI and stdio MCP for search, citation, lineage, handoff, and Mome |

## Who uses which

- A person at a Windows desktop uses **Möbius**.
- A person at a terminal, or an agent over MCP, uses **mobius-connect**.
- Both read the same approved local sources. Neither rewrites harness transcripts.

## Shared core

`mobius-connect` depends on `mydesk-core` from the desktop tree (`../desktop/crates/mydesk-core` in a sibling checkout). Internal crate names keep `mydesk-*` so existing vault paths and commands stay stable. The public product name is Möbius.

The desktop workspace still builds `mydesk-cli` (`mobius` / `mydesk`) and `mydesk-mcp` for the vault the desktop owns. Those binaries are not the published CLI/MCP product. The published session-layer binary is `mobius-connect`.

## Checkout layout used in development

```
E:\Workspaces\Mobius\repos\desktop          # this repository
E:\Workspaces\Mobius\repos\mobius-connect   # CLI + MCP
D:\DataVault\Mobius                         # durable local data
D:\AcceptedArtifacts\Mobius                 # accepted deliverables
```

Durable session history never lives only on E:. Tests use isolated `--data-root` directories. They must not point at a real user vault.

## Frozen contract (both repos)

1. Do not modify harness source, launchers, model config, or original transcripts.
2. A handoff carries references, not a generated summary.
3. A Session is source + harness + native id. It is not a process or a directory.
4. MCP cannot mint approval tokens, add sources, or attach a PTY.
