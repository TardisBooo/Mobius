# Launch copy — Möbius Agent Session Hub

Use these drafts as-is or trim. Do not post until the user confirms credentials. The 60-second GIF is `apps/website/public/product/session-hub-60s.gif`. Do not claim OpenClaw support. Do not claim native resume for Grok or OpenCode.

Facts locked to v0.3.19:

- Open-source Agent Session Hub (MIT, $0)
- Search / cite / resume / hand off across Claude Code, Codex, OpenCode, Pi, Grok, OMP
- Windows preview; Rust + Tauri + SQLite; local-first
- Handoff is a references-only graph
- MCP cannot mint approvals
- Distinct from Microsoft Mobius / ControlTheory Möbius
- Site: http://8.137.87.76/mobius/
- Desktop: https://github.com/TardisBooo/Mobius
- CLI/MCP: https://github.com/TardisBooo/mobius-connect

Attach `apps/website/public/product/session-hub-60s.gif` (60s social cut: search → cite → handoff → lineage) plus the handoff-graph screenshot. Full tour GIF: `apps/website/public/product/session-hub.gif`. Master MP4 with music: `apps/website/public/media/mobius-product-film.mp4` (32.6 MB, 109.3s, SHA-256 6779F673…5E79E8). Film source and version lineage live outside the repo at `D:\AcceptedArtifacts\Mobius\media\product-film-lineage\`.

---

## One-liner

Open-source Agent Session Hub: search, cite, resume and hand off context across Claude Code, Codex, OpenCode and other local coding agents.

## Positioning (keep this order)

1. Pain: cross-session / cross-agent context is lost on every paste.
2. Product: a session layer, not another chat CLI.
3. Proof: Rust/SQLite adapters (including OpenCode's `opencode.db`), reference-only handoff, human approval tokens.
4. Trend: more agents make the session layer more valuable, not less.

## What not to say

- "Supports OpenClaw" (roadmap only)
- "Semantic search is on by default" (BM25 default; hybrid is opt-in localhost Ollama)
- "Claude can resume a Codex session natively"
- "We summarize your history for the next agent"
- "MCP can approve its own reads"

---

## X / Twitter (primary)

You already have Claude Code, Codex, OpenCode sitting on disk.

The next agent cannot search, cite, or continue that work without a paste that drops the trail.

Möbius is an open-source Agent Session Hub for Windows.

- Search approved local sessions (incl. OpenCode's SQLite)
- Copy `@session:provider/id#m12-m14`
- Resume in the original harness
- Hand off a graph of references, not a summary

Local SQLite. MIT. $0. No model accounts included.

http://8.137.87.76/mobius/
https://github.com/TardisBooo/Mobius

CLI/MCP without the desktop:
https://github.com/TardisBooo/mobius-connect

GIF: 60s tour of search → cite → handoff → lineage graph. File: `apps/website/public/product/session-hub-60s.gif`.

### X thread (optional 4 posts)

1. Cross-agent context loss is the complaint I kept hitting. Paste into Claude what Codex already did, and you get a briefing that cannot be audited. Möbius keeps the tape.
2. A Session is source + harness + native id. Native resume stays with the original CLI. A handoff always creates a new session and carries confirmed ancestor edges.
3. Search is local FTS/BM25. Optional localhost embeddings fail open to lexical. MCP can list metadata; it cannot mint the token that returns bodies.
4. Desktop: TardisBooo/Mobius. CLI/MCP: TardisBooo/mobius-connect. Windows preview v0.3.19.

---

## Hacker News

**Title:** Show HN: Möbius – local Agent Session Hub for Claude Code, Codex, and OpenCode

**Text:**

I got tired of re-explaining a Codex investigation to Claude (and vice versa). Summaries go stale. Pasting a JSONL blows the window and drops the evidence trail.

Möbius is an open-source session layer that sits next to the CLIs you already run. It indexes approved local transcripts (Codex JSONL, Claude project sessions, OpenCode's `opencode.db`, plus Pi/Grok/OMP), groups them by project/worktree, and lets you:

- copy an exact `@session:provider/id#mN-mM` citation
- resume in the original harness when that protocol is verified
- hand off a references-only ancestry graph to a new target session
- search with SQLite FTS5/BM25 (optional localhost Ollama embeddings, fail-open)

Rust core, Tauri desktop on Windows, sibling CLI+MCP (`mobius-connect`). Original files stay read-only. MCP cannot mint approval tokens, add sources, or attach a PTY.

Not Microsoft Mobius. Not a memory summarizer. OpenClaw adapter is not in this preview.

Site: http://8.137.87.76/mobius/
Desktop: https://github.com/TardisBooo/Mobius
CLI/MCP: https://github.com/TardisBooo/mobius-connect

Happy to talk about the graph envelope vs handover.md, the OpenCode SQLite locator, and why approvals are a human TTY step.

---

## r/ClaudeCode

**Title:** Möbius: local session hub so Claude can cite/resume/hand off Codex and OpenCode history (without eating the JSONL)

**Text:**

If you bounce between Claude Code and Codex (or OpenCode), the usual move is paste-a-summary or dump-the-transcript. Both lose the trail.

Möbius is a Windows-first, MIT, local-first Agent Session Hub:

- indexes approved Claude / Codex / OpenCode / Pi / Grok / OMP sessions by project
- exact citations like `@session:claude/<id>#m12-m14`
- native resume stays with Claude (or whichever harness owns the session)
- switching harnesses is an explicit handoff: new session + ancestor graph, not a generated briefing
- MCP is available via `mobius-connect`; it cannot approve its own reads

I am the author. Preview is v0.3.19. Demo GIF in the first comment / product page.

http://8.137.87.76/mobius/
https://github.com/TardisBooo/Mobius

Not affiliated with Anthropic. Does not include Claude Pro/API credits.

---

## r/LocalLLaMA (optional, shorter)

Local-first session index for coding agents (Rust/SQLite). BM25 is the default; hybrid rank via localhost Ollama `nomic-embed-text` is opt-in and fails open. No cloud index. Windows preview.

---

## GEO / SEO phrases to keep consistent

Use these on the site, README, and `llms.txt`. Do not rotate synonyms per page.

- Agent Session Hub
- session layer for coding agents
- search, cite, resume, hand off
- references, not summaries
- local SQLite FTS/BM25
- OpenCode `opencode.db` (read-only)
- MCP cannot mint approvals
- Distinct from Microsoft Mobius and ControlTheory Möbius

Chinese equivalents:

- Agent 会话层
- 搜索、引用、恢复、交接
- 传引用，不传摘要
- 本地 SQLite FTS/BM25
- OpenCode 只读 `opencode.db`

## Follow-up links after a post

1. Blog 01 graph handoff
2. Blog 02 citation vs summary
3. Blog 03 approval tokens
4. `docs/MCP.md` on mobius-connect
5. SOP `docs/sop-session-hub.md`
