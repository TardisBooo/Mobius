# Repositories

Möbius is two public repositories under one product name.

| Repository | What it is |
| --- | --- |
| [TardisBooo/Mobius](https://github.com/TardisBooo/Mobius) | Windows desktop: session library, PowerShell workbench, handoff graph, notes, canvas, skills |
| [TardisBooo/mobius-connect](https://github.com/TardisBooo/mobius-connect) | CLI and stdio MCP for search, citation, lineage, handoff, and Mome |

A person at a Windows desktop uses **Möbius**. A person at a terminal, or an agent over MCP, uses **mobius-connect**. Both read the same approved local sources. Neither rewrites harness transcripts.

To build `mobius-connect` from source, clone the desktop repository next to it as `desktop`:

```
git clone https://github.com/TardisBooo/mobius-connect.git
git clone https://github.com/TardisBooo/Mobius.git desktop
cd mobius-connect
cargo build --release
```

Durable data defaults to local app data (`%LOCALAPPDATA%\Mobius` on Windows, `~/.local/share/mobius` elsewhere). Tests use isolated `--data-root` directories. They must not point at a real user vault.

## Frozen contract (both repos)

1. Do not modify harness source, launchers, model config, or original transcripts.
2. A handoff carries references, not a generated summary.
3. A Session is source + harness + native id. It is not a process or a directory.
4. MCP cannot mint approval tokens, add sources, or attach a PTY.
