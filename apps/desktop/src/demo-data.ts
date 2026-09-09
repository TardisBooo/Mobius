import type {
  AgentStatus,
  ContextHit,
  ContextRecord,
  HealthStatus,
  ProjectSummary,
  SkillInfo,
  WikiQueueItem
} from "./types";

export const demoHealth: HealthStatus = {
  database_path: "D:\\DataVault\\MyDesk\\index\\mydesk.sqlite3",
  contexts: 148,
  sessions: 92,
  notes: 31,
  boards: 8,
  wiki_entries: 17
};

export const demoProjects: ProjectSummary[] = [
  { slug: "mydesk", count: 54, latest_at: "2026-09-04T10:43:00Z" },
  { slug: "sync-protocol", count: 21, latest_at: "2026-09-03T16:12:00Z" },
  { slug: "personal-vault", count: 14, latest_at: "2026-09-02T09:30:00Z" },
  { slug: "platform-research", count: 11, latest_at: "2026-08-29T08:05:00Z" }
];

export const demoHits: ContextHit[] = [
  {
    id: "session:codex:mydesk-arch",
    kind: "session",
    agent: "codex",
    project_slug: "mydesk",
    title: "Architecture: shared context and local index",
    summary: "Rust core, SQLite FTS5, a small writer daemon, desktop workbench, and read-only source adapters.",
    snippet: "The source session stays untouched while MyDesk owns its normalized index and durable notes.",
    source_path: "E:\\Workspaces\\MyDesk\\.agents\\sessions\\architecture.jsonl",
    updated_at: "2026-09-04T10:43:00Z",
    score: 0.98
  },
  {
    id: "note:context-contract",
    kind: "note",
    agent: null,
    project_slug: "mydesk",
    title: "Context contract",
    summary: "Rules for snapshots, mention resolution, and conflict-safe wiki proposals.",
    snippet: "Every durable context item needs a stable id, a provenance path, and an explicit writer.",
    source_path: "D:\\DataVault\\MyDesk\\vault\\notes\\context-contract.md",
    updated_at: "2026-09-04T09:21:00Z",
    score: 0.92
  },
  {
    id: "board:knowledge-map",
    kind: "board",
    agent: null,
    project_slug: "mydesk",
    title: "Knowledge map",
    summary: "A board linking session decisions to reference notes and implementation tasks.",
    snippet: "Index adapters → context rail → curated knowledge → reusable skills.",
    source_path: "D:\\DataVault\\MyDesk\\vault\\boards\\knowledge-map.json",
    updated_at: "2026-09-03T16:12:00Z",
    score: 0.83
  },
  {
    id: "session:claude:sync-boundaries",
    kind: "session",
    agent: "claude",
    project_slug: "sync-protocol",
    title: "Session import boundaries",
    summary: "Adapter requirements for imported sources and untouched historical JSONL.",
    snippet: "Avoid parsing another tool's private database; prefer its public API or an explicit export.",
    source_path: "C:\\Users\\MSI-NB\\.claude\\projects\\sync-protocol\\session.jsonl",
    updated_at: "2026-09-03T15:44:00Z",
    score: 0.79
  }
];

export const demoRecord: ContextRecord = {
  id: "session:codex:mydesk-arch",
  kind: "session",
  agent: "codex",
  project_slug: "mydesk",
  title: "Architecture: shared context and local index",
  summary: "Rust core, SQLite FTS5, a small writer daemon, desktop workbench, and read-only source adapters.",
  body: "User wants a unified workspace across Codex, Claude, Pi and Grok. The core constraint is that raw session files are source material, not MyDesk-owned state. MyDesk should normalize searchable excerpts into SQLite, retain a source path and adapter identity, and write only its own vault, snapshots, index, and managed-skill manifests.\n\nThe interactive surface should be terminal-first. The desktop app should feel like a dense PowerShell workbench: a narrow project rail, a main task surface, and a context rail that can answer a cross-session recall without opening another terminal.\n\nDecisions: Rust is the durable core; Tauri makes a light native desktop shell; SQLite FTS5 powers retrieval; an MCP stdio server lets an agent resolve @project, @session, @note, and @board references without giving it raw write access.",
  source_path: "E:\\Workspaces\\MyDesk\\.agents\\sessions\\architecture.jsonl",
  created_at: "2026-09-04T10:13:00Z",
  updated_at: "2026-09-04T10:43:00Z",
  metadata: {
    adapter: "demo",
    tags: ["architecture", "context", "local-first"]
  }
};

export const demoSkills: SkillInfo[] = [
  {
    id: "skill:repo-scout",
    name: "repo-scout",
    source_path: "C:\\Users\\MSI-NB\\.agents\\skills\\repo-scout\\SKILL.md",
    source_kind: "local",
    content_hash: "e22a54c922...",
    scope: "global",
    managed: true
  },
  {
    id: "skill:wiki",
    name: "wiki",
    source_path: "E:\\Workspaces\\MyDesk\\.agents\\skills\\wiki\\SKILL.md",
    source_kind: "local",
    content_hash: "a4a90bcc17...",
    scope: "project",
    managed: false
  },
  {
    id: "skill:research",
    name: "research",
    source_path: "E:\\Codex\\Home\\skills\\research-zh\\SKILL.md",
    source_kind: "codex",
    content_hash: "8b1e2f0531...",
    scope: "global",
    managed: false
  }
];

export const demoAgents: AgentStatus[] = [
  { id: "codex", label: "Codex", status: "connected", sessions: 37, detail: "MCP ready · direct local adapter" },
  { id: "claude", label: "Claude", status: "connected", sessions: 28, detail: "MCP ready · external session index" },
  { id: "pi", label: "Pi", status: "needs_setup", sessions: 0, detail: "Add MyDesk MCP command" },
  { id: "grok", label: "Grok", status: "needs_setup", sessions: 0, detail: "Add MyDesk MCP command" },
];

export const demoWikiQueue: WikiQueueItem[] = [
  {
    id: "wiki-queue:preview-1",
    source_context_id: "session:codex:mydesk-arch",
    state: "queued",
    created_at: "2026-09-04T09:00:00Z",
    updated_at: "2026-09-04T09:00:00Z"
  },
  {
    id: "wiki-queue:preview-2",
    source_context_id: "note:context-contract",
    state: "queued",
    created_at: "2026-09-03T16:00:00Z",
    updated_at: "2026-09-03T16:00:00Z"
  }
];
