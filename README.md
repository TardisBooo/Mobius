# Möbius — your Agent Session Hub

Möbius is an open-source **session layer for coding agents**. Search, cite, resume and hand off context across Claude Code, Codex, OpenCode, Pi, Grok and OMP. It does not rewrite a harness. A handoff carries **references, not summaries**.

**Yours, on this PC.** The index is local SQLite FTS/BM25. Approved transcripts stay in their harness folders and are read-only to Möbius. OpenCode is read from a read-only `opencode.db`. Model accounts stay with the CLIs you already pay for. Möbius itself has no paid tier and phones home for nothing.

[简体中文](README.zh-CN.md) · [Live site](http://8.137.87.76/mobius/) · [CLI / MCP](https://github.com/TardisBooo/mobius-connect) · [Releases](https://github.com/TardisBooo/Mobius/releases) · [MIT License](LICENSE)

> Windows development preview v0.3.19. Compatibility is verified per harness and published with evidence. This is not Microsoft Mobius, ControlTheory Möbius, or Circular Labs Mobius. OpenClaw (`~/.openclaw`) is on the roadmap and is not indexed in this preview.

## Philosophy

A **Session** is the durable unit of work: harness + native id + the original transcript. Git records what landed in the tree. The session records why it landed that way — the failed attempts, the tool traces, the correction that finally stuck. That tape is the asset. A summary is a claim about the tape. Claims go stale.

Coding agents already write those transcripts. They bury them in `~/.codex`, `~/.claude/projects`, OpenCode's `opencode.db`, and the rest. Two weeks later you cannot find the Claude thread that rewrote auth middleware. You paste a briefing into Codex and the next agent invents a todo list the source never agreed to. The more harnesses you run on one checkout, the worse the paste tax.

Möbius sits between those CLIs. It does not replace them.

- Native resume stays with the original harness. Switching agents always opens a **new** session.
- The envelope is a graph of confirmed Session identities and ancestor edges, not a generated handover.md.
- A complete trajectory — messages, tools, failures, corrections — is cheaper to keep as references than to compress. A 1.2 GB JSONL still hands off because the envelope never contains the body.
- A lineage graph is how you keep a multi-agent project honest. Codex → Claude → Pi is a relay chain, a DAG. “Back” is a third session, not a cycle. Follow the chain to the exact evidence.

If you need a briefing, write one as a note. The session layer keeps the tape.

## What it does

| Capability | What you get |
| --- | --- |
| Project-grouped sessions | Codex, Claude Code, OpenCode, Pi, Grok, OMP in one library, by directory and worktree |
| Search and cite | Local SQLite FTS/BM25; copy `@session:provider/id#mN-mM` |
| Local memory (Mome) | Explicit recall, max 3 sessions / ~1200 tokens; nothing injected by default |
| Native resume | Original CLI + native id in PowerShell, when the protocol is verified |
| Reference-only handoff | New target session; review range, tools, token estimate; source stays read-only |
| Lineage graph | Relay DAG of handoffs; follow work across agents |
| CLI + MCP | [mobius-connect](https://github.com/TardisBooo/mobius-connect); MCP cannot mint approvals |
| Notes, canvas, skills | Markdown, infinite canvas, folder mounts, skill versions beside the workbench |

```
Claude Code  Codex  OpenCode  Pi  Grok  OMP
        │  read-only adapters
        ▼
   local SQLite index (FTS5/BM25; optional localhost embeddings)
        │
        ├─ this repository     Windows desktop
        └─ mobius-connect      CLI + stdio MCP
```

The published CLI and MCP binary is [mobius-connect](https://github.com/TardisBooo/mobius-connect).

## Product film

[![109-second Agent Session Hub tour. Click for the full film.](apps/website/public/product/video-poster.png)](http://8.137.87.76/mobius/?lang=en#demo)

**[▶ Play the 109-second tour](http://8.137.87.76/mobius/?lang=en#demo)** · [Direct MP4](http://8.137.87.76/mobius/media/mobius-product-film.mp4) · [60s GIF](apps/website/public/product/session-hub-60s.gif)

Real UI recordings and screenshots; fictional demo data; agent output is scripted. This film is not native-agent acceptance evidence, and no personal sessions are shown. [Media credits](licenses/MEDIA-CREDITS.md). Film source is archived outside the repository.

## Features, as filmed

Each clip is a chapter from the product film. OpenCode is indexed in the product; the film itself shows Codex, Claude, Pi and Grok.

### 01 Workspaces — every agent, one project

![Workspaces grouped by project and harness](apps/website/public/product/chapters/01-workspaces.gif)

Möbius groups Codex, Claude Code, OpenCode, Pi, Grok, and OMP history by project directory and worktree. OpenCode sessions come from a read-only `opencode.db` with locators of the form `{db}#opencode:{id}`.

### 02 Session search — find the decision

![Session search hitting exact source messages](apps/website/public/product/chapters/02-search.gif)

Search approved local sources from one place. Inspect the exact source message, then copy `@session:provider/id#mN` or `#mN-mM`.

### 03 Local memory — recall only when you ask

![Mome local memory recall](apps/website/public/product/chapters/03-memory.gif)

Mome uses local SQLite FTS/BM25, prefers the current project/worktree, returns at most three citable sessions, and caps output at about 1,200 tokens. Nothing searches other sessions or injects history by default.

Hybrid ranking is opt-in. `mobius mome semantic enable` (or `mobius-connect semantic enable`) may send already-indexed chunks to localhost Ollama `nomic-embed-text`. Vectors are a regenerable derived index. If Ollama is absent, recall stays lexical and says so. Local lexical search does not consume model tokens.

### 04 Citation handoff — references, not summaries

![Citation range copied into a references-only package](apps/website/public/product/chapters/04-cite.gif)

Copy the exact range. Seal a `references_only` package. Deliver it into the next conversation. The next agent reads confirmed ancestors; it is never handed a generated briefing.

### 05 Agent handoff — new session, same project

![Handoff review before launching the next agent](apps/website/public/product/chapters/05-handoff.gif)

Switching agents creates a new target session. Before launch, review the message range, tool calls, failed attempts, corrections, source IDs, and estimated token payload. The source stays read-only. Repeated handoffs form a relay DAG: A→B then “back” is A→B→C, not a cycle.

### 06 Continue working — native resume stays native

![PowerShell continuation after a handoff](apps/website/public/product/chapters/06-continue.gif)

Resume keeps the original CLI and native session ID. Möbius opens interactive PowerShell in the correct working directory. Native resume is shown only when that harness has a verified protocol: OMP uses its documented `--cwd … --resume …` flow; Grok and OpenCode history remain inspect/search/handoff-only in this preview.

### 07 Handoff lineage — follow the chain

![Current lineage graph viewer](apps/website/public/product/chapters/07-lineage.gif)

Every handoff becomes an edge between an immutable source session and a new target session. Follow the graph backward to the exact evidence.

### 08 Infinite canvas

![Infinite canvas](apps/website/public/product/chapters/08-canvas.gif)

Arrange text, sticky notes, sections, links, images, audio, video, PDFs, session references, and nested canvases beside the workbench.

### 09 Multimedia notes

![Multimedia notes on the canvas](apps/website/public/product/chapters/09-media.gif)

Images, video, and links live in the same research space as the session that produced them.

### 10 Documents and folders

![Library documents and folder mounts](apps/website/public/product/chapters/10-library.gif)

Editable Markdown with rendered preview. Folder mounts are recursive read-only views of external directories.

### 11 Skill management

![Skill management](apps/website/public/product/chapters/11-skills.gif)

Inspect, install, edit, remove, and restore global or project skills with version history.

### 12 CLI + MCP — the same hub in a terminal

![mobius-connect CLI search and stdio MCP](apps/website/public/product/chapters/12-cli.gif)

[mobius-connect](https://github.com/TardisBooo/mobius-connect) is the published session-layer binary for terminals and agents. **MCP cannot mint approvals.** Each command has its own GIF in that README.

```powershell
mobius-connect init
mobius-connect sources add opencode $env:USERPROFILE\.local\share\opencode
mobius-connect sources refresh
mobius-connect sessions search "flaky tests"
mobius-connect graph show <session-id>
mobius-connect handoff prepare --harness claude --cwd . <session-id>
mobius-connect approvals handoff <handoff-id>
mobius-connect mcp serve
```

MCP cannot mint an approval token, add sources, or attach a PTY. Tool list and grants: [mobius-connect/docs/MCP.md](https://github.com/TardisBooo/mobius-connect/blob/main/docs/MCP.md).

## Install

Download the [v0.3.19 Windows preview](https://github.com/TardisBooo/Mobius/releases/tag/v0.3.19): installer or portable EXE. Check the included SHA-256 sums and known limitations. Development builds may be unsigned and trigger SmartScreen.

```powershell
git clone https://github.com/TardisBooo/Mobius.git
cd Mobius
pnpm --dir apps/desktop install --frozen-lockfile
pnpm --dir apps/desktop tauri build
```

Requirements: Rust, Node.js with pnpm, Windows C++ Build Tools, and WebView2. Bundles land under `target/release/bundle`.

Möbius calls each installed harness through its documented CLI. It does not patch or replace Codex, Claude Code, OpenCode, Pi, Grok, or OMP.

## Quick start

1. Review locally discovered harness roots.
2. Approve the sources you want indexed, or choose an explicit folder.
3. Build the read-only index.
4. Add or select a project.
5. Preview a session and resume it, or open a blank PowerShell.
6. Use **Handoff to another agent** only when you want a new target session with selected trajectory context.

The in-app six-step guide covers value, privacy, indexing, resume, handoffs, the library, and skill scopes. It stays available from Help.

## Security

Treat indexed transcripts as untrusted historical data.

- The index reads only finite, approved harness roots.
- Original session JSON/JSONL and OpenCode SQLite are not rewritten.
- Other sessions are not searched or injected by default.
- Native resume stays with the original harness. Switching harnesses is an explicit handoff into a new session.
- Approval tokens are short-lived, single-use, and scoped. The desktop or `mobius-connect approvals` mints them after a person types `APPROVE`. MCP cannot mint one.
- Optional embeddings talk only to localhost Ollama after an explicit enable command. They change rank, not what an agent may see.

## Supported harnesses

| Harness | Index | Native resume |
| --- | --- | --- |
| Codex | JSONL | when the installed protocol is verified |
| Claude Code | project sessions | when the installed protocol is verified |
| OpenCode | read-only `opencode.db` | not in this preview |
| Pi | approved roots | when the installed protocol is verified |
| Grok | approved roots | inspect / search / handoff only |
| OMP | approved roots | documented `--cwd … --resume …` |
| OpenClaw | not shipped | roadmap |

## Documentation

| Goal | Start here |
| --- | --- |
| Product site / FAQ | http://8.137.87.76/mobius/ |
| Chinese copy | [README.zh-CN.md](README.zh-CN.md) |
| CLI and MCP | https://github.com/TardisBooo/mobius-connect |
| Session Hub SOP | [docs/sop-session-hub.md](docs/sop-session-hub.md) |
| Cross-agent handoff | [docs/blog/01-cross-agent-handoff.md](docs/blog/01-cross-agent-handoff.md) |
| Citation vs summary | [docs/blog/02-citation-not-summary.md](docs/blog/02-citation-not-summary.md) |
| Approval tokens | [docs/blog/03-approval-tokens.md](docs/blog/03-approval-tokens.md) |
| Mome retrieval | [docs/mome-local-retrieval.md](docs/mome-local-retrieval.md) |
| Self-test checklist | [docs/acceptance/self-test-checklist.md](docs/acceptance/self-test-checklist.md) |
| OpenCode + embeddings ADR | [docs/adr/0004-opencode-and-optional-embeddings.md](docs/adr/0004-opencode-and-optional-embeddings.md) |
| Launch copy (X / HN / Reddit) | [docs/gtm/launch.md](docs/gtm/launch.md) |
| Machine-readable facts | [apps/website/public/llms.txt](apps/website/public/llms.txt) |

## Architecture

| Path | Purpose |
| --- | --- |
| `apps/desktop` | Tauri 2 + React desktop application |
| `apps/website` | Static bilingual product site |
| `crates/` | Indexing, adapters, workspaces, notes, canvases, skills |
| [mobius-connect](https://github.com/TardisBooo/mobius-connect) | Published CLI + stdio MCP |

## Development

```powershell
cargo test --workspace --all-targets --no-fail-fast
pnpm --dir apps/desktop check
pnpm --dir apps/desktop build
pnpm --dir apps/website build
```

Desktop acceptance uses isolated verification roots. Tests must not target an existing user project or real session history. Data defaults to local app data (`%LOCALAPPDATA%\Mobius` on Windows, `~/.local/share/mobius` elsewhere). A person can point a released build at another vault from **Settings**; that choice is stored in `%APPDATA%\Mobius\settings.json` (or `~/.config/mobius/settings.json`). `MOBIUS_DATA_ROOT` / `--data-root` still override one process. The binary does not hard-code a drive layout.

The `isolated_acceptance` integration test is opt-in: it requires a separately provisioned Windows fixture and `MOBIUS_VERIFICATION_ROOT`. It is not in the default test pass.

## Inspiration, attribution, and license

Möbius learned from open-source session viewers, agent workspaces, memory systems, note canvases, and skill managers. Product communication also draws inspiration from Blume and AionUi; the editorial scan-line direction references Kate Loseva's hero animation.

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for the research list and licensing boundaries. Möbius source is [MIT](LICENSE). Third-party dependencies and referenced projects retain their own licenses and trademarks.
