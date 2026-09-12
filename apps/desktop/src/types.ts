// "apodex" is retained only to decode legacy catalogues, never as a selectable adapter.
export type AgentKind = "codex" | "claude" | "pi" | "grok" | "apodex" | "unknown";

export type ContextKind =
  | "session"
  | "note"
  | "board"
  | "wiki"
  | "web_clip"
  | "pdf"
  | "command"
  | "skill";

export interface HealthStatus {
  database_path: string;
  contexts: number;
  sessions: number;
  notes: number;
  boards: number;
  wiki_entries: number;
}

export interface ContextRecord {
  id: string;
  kind: ContextKind;
  agent: AgentKind | null;
  project_slug: string | null;
  title: string;
  body: string;
  summary: string;
  source_path: string | null;
  created_at: string;
  updated_at: string;
  metadata: Record<string, unknown> | null;
}

export interface ContextHit {
  id: string;
  kind: ContextKind;
  agent: AgentKind | null;
  project_slug: string | null;
  title: string;
  summary: string;
  snippet: string;
  source_path: string | null;
  updated_at: string;
  score: number;
}

export interface SearchFilter {
  agent?: AgentKind;
  project_slug?: string;
  kind?: ContextKind;
}

export interface SearchRequest {
  query: string;
  filter?: SearchFilter;
  limit?: number;
}

export interface NoteDraft {
  title: string;
  body: string;
  project_slug: string | null;
  tags: string[];
  source_ids: string[];
}

export interface WikiDraft {
  title: string;
  body: string;
  project_slug: string | null;
  tags: string[];
  source_ids: string[];
}

export interface BoardDocument {
  id: string;
  title: string;
  project_slug: string | null;
  data: Record<string, unknown>;
  updated_at: string;
}

export interface TrashItem {
  id: string;
  kind: ContextKind;
  title: string;
  original_path: string;
  deleted_at: string;
}

export interface CanvasAssetInfo { id: string; file_name: string; mime_type: string; size: number; }

/**
 * Sanitised bookmark metadata returned by the local desktop process.  The
 * original URL stays on the canvas object; this record makes reopening a board
 * instantaneous and avoids re-requesting a page just to redraw its card.
 */
export interface LinkPreview {
  kind: "web" | "image" | "video";
  site_name: string;
  title: string;
  description: string;
  image_url: string | null;
  embed_url: string | null;
  provider: string | null;
}

export interface SkillInfo {
  id: string;
  name: string;
  source_path: string;
  source_kind: string;
  content_hash: string;
  scope: string;
  managed: boolean;
}

export interface SkillDeployment {
  managed_id: string | null;
  skill: SkillInfo;
  target: string;
  target_root: string;
  destination: string;
  can_install: boolean;
  reason: string;
}

export interface ManagedSkillInstall {
  id: string;
  source_path: string;
  destination: string;
  target: string;
  tree_hash: string;
  installed_at: string;
}

export interface SkillHistoryEntry {
  id: string;
  managed_id: string;
  created_at: string;
  content_hash: string;
}

export interface WikiQueueItem {
  id: string;
  source_context_id: string;
  state: string;
  created_at: string;
  updated_at: string;
}

export interface AgentStatus {
  id: AgentKind;
  label: string;
  status: "connected" | "read_only" | "needs_setup";
  sessions: number;
  detail: string;
}

export interface AgentSummary {
  agent: AgentKind;
  contexts: number;
  latest_at: string | null;
}

export interface ProjectSummary {
  slug: string;
  count: number;
  latest_at: string;
}

export type WorkspaceStatus = "working" | "paused";
export interface Workspace { id: string; display_name: string; canonical_path: string; git_identity: string | null; status: WorkspaceStatus; created_at: string; updated_at: string; }
export interface Checkout { id: string; workspace_id: string; kind: "main" | "worktree" | "directory"; canonical_path: string; branch: string | null; head: string | null; git_common_dir: string | null; dirty: boolean; ahead: number; behind: number; updated_at: string; }
export interface WorkspaceView { workspace: Workspace; checkouts: Checkout[]; }
export interface DirectoryEntry { name: string; relative_path: string; path: string; kind: "directory" | "file" | "symlink"; has_children: boolean; size: number | null; modified_at: string | null; }
export interface Session { id: string; provider: AgentKind; provider_session_id: string; checkout_id: string | null; title: string; state: string; capabilities: string[]; source_path: string; source_available: boolean; started_at: string | null; updated_at: string; metadata: Record<string, unknown>; }
export interface Message { id: string; session_id: string; ordinal: number; role: "user" | "assistant" | "tool" | "system" | "developer" | "unknown"; kind: string; content: string; timestamp: string | null; source_locator: Record<string, unknown>; redacted: boolean; }
export interface MatchRange { start: number; end: number; }
export interface SessionSearchHit { session: Session; message: Message | null; ranges: MatchRange[]; }
export interface RelayChain { id: string; workspace_id: string; checkout_id: string | null; title: string; created_at: string; updated_at: string; }
export interface RelayEdge { id: string; chain_id: string; source_session_id: string; target_session_id: string | null; handoff_id: string; relation: "take_over" | "parallel"; created_at: string; }
export interface HandoffPackage { id: string; source_session_id: string; target_provider: AgentKind; target_checkout_id: string; mode: "take_over" | "parallel"; payload: Record<string, unknown>; token_estimate: number; created_at: string; }
export interface RelayGraph { chains: RelayChain[]; edges: RelayEdge[]; handoffs: HandoffPackage[]; }
export interface SessionQuery { query: string; workspace_id: string | null; checkout_id: string | null; providers: AgentKind[]; limit: number; }
export interface MomeRecallRequest { query: string; workspace_id: string | null; checkout_id: string | null; providers: AgentKind[]; max_tokens?: number | null; }
export interface MomeSource { provider: AgentKind; session_id: string; session_record_id: string; start_ordinal: number; end_ordinal: number; citation: string; content_hash: string; text: string; estimated_tokens: number; }
export interface MomeRecallResponse { query: string; retrieval_mode: string; semantic_status: "lexical_only_no_semantic_backend_configured"; max_tokens: number; estimated_tokens: number; sources: MomeSource[]; }
export interface ProviderIndexReport { roots: number; discovered: number; indexed: number; unchanged: number; skipped: number; errors: string[]; by_provider: Array<{provider: AgentKind; roots: number; discovered: number; indexed: number; unchanged: number; skipped: number}>; }
export interface SessionSourceRoot { agent: AgentKind; path: string; exists: boolean; mode: string; provenance: string; }
export interface ApprovedSessionSources { version: number; roots: SessionSourceRoot[]; suppressed_auto_roots?: Array<{ agent: AgentKind; path: string }>; }
export interface McpApprovalRequest {
  operations: string[];
  query: string | null;
  workspace_id: string | null;
  checkout_id: string | null;
  providers: string[];
  provider: string | null;
  session_id: string | null;
  start_ordinal: number | null;
  end_ordinal: number | null;
  max_chars: number;
  expires_in_seconds: number;
  single_use: boolean;
}
export interface McpApprovalGrant { approval_id: string; approval_token: string; expires_at: string; max_chars: number; single_use: boolean; }
export interface TerminalInfo { id: string; title: string; cwd: string; state: string; created_at: string; }
export interface TerminalOutput { terminal_id: string; sequence: number; data: string; }
export interface TerminalSnapshot { terminal_id: string; sequence: number; data: string; }
export interface NoteFileInfo { id: string; mount_id: string | null; title: string; virtual_path: string; real_path: string; read_only: boolean; modified_at: string | null; }
export interface MountInfo { id: string; library_id: string; virtual_path: string; real_path: string; access: "read_only" | "read_write"; watcher_mode: string; state: string; created_at: string; updated_at: string; }
export interface SessionReference {
  session_id: string;
  harness: string | null;
  native_id: string | null;
  title: string | null;
  created_at: string | null;
  updated_at: string | null;
  checkout_id: string | null;
  source_path: string | null;
  source_status: string;
  observed_bytes: number | null;
}
export interface LineageManifest {
  schema_version: number;
  id: string;
  content_mode: "references_only";
  entry_session_ids: string[];
  nodes: SessionReference[];
  edges: { id: string; source: string; target: string; handoff_id: string; created_at: string }[];
  missing_sources: string[];
}
