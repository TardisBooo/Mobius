import {
  demoAgents,
  demoHealth,
  demoHits,
  demoProjects,
  demoRecord,
  demoSkills,
  demoWikiQueue
} from "./demo-data";
import type {
  AgentKind,
  AgentStatus,
  AgentSummary,
  ApprovedSessionSources,
  BoardDocument,
  CanvasAssetInfo,
  ContextHit,
  ContextRecord,
  HealthStatus,
  LinkPreview,
  ManagedSkillInstall,
  SkillHistoryEntry,
  McpApprovalGrant,
  McpApprovalRequest,
  MomeRecallRequest,
  MomeRecallResponse,
  RelayGraph,
  Message,
  MountInfo,
  NoteFileInfo,
  NoteDraft,
  ProjectSummary,
  SearchRequest,
  SkillDeployment,
  SkillInfo,
  ProviderIndexReport,
  SessionQuery,
  SessionSourceRoot,
  SessionSearchHit,
  TerminalInfo,
  TerminalSnapshot,
  DirectoryEntry,
  WorkspaceView,
  WikiDraft,
  TrashItem,
  WikiQueueItem
} from "./types";

function inTauri(): boolean {
  return typeof window !== "undefined" && Reflect.has(window, "__TAURI_INTERNALS__");
}

function markdownAssetMime(path: string): string {
  const extension = path.split(".").pop()?.toLowerCase();
  return ({ png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", avif: "image/avif" } as Record<string, string>)[extension ?? ""] ?? "application/octet-stream";
}

async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const module = await import("@tauri-apps/api/core");
  return module.invoke<T>(command, args);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export const desktopApi = {
  runtime: inTauri() ? "desktop" : "browser-preview",

  async listWorkspaces(): Promise<WorkspaceView[]> {
    return inTauri() ? invoke<WorkspaceView[]>("list_workspaces_v2") : [];
  },

  async registerWorkspace(path: string, name?: string): Promise<void> {
    if (inTauri()) await invoke("register_workspace", { path, name: name ?? null });
  },

  /**
   * Opens the native operating-system folder picker. `null` means the person
   * dismissed the dialog; a returned path has already been canonicalized and
   * checked as a directory by the Rust command.
   */
  async pickDirectory(initialPath?: string): Promise<string | null> {
    return inTauri()
      ? invoke<string | null>("pick_directory", { initialPath: initialPath ?? null })
      : null;
  },

  async setWorkspaceStatus(id: string, status: "working" | "paused"): Promise<boolean> {
    return inTauri() ? invoke<boolean>("set_workspace_status", { id, status }) : true;
  },

  async listWorkspaceDirectory(checkoutId: string, relativePath = ""): Promise<DirectoryEntry[]> {
    return inTauri() ? invoke<DirectoryEntry[]>("list_workspace_directory", { checkoutId, relativePath }) : [];
  },

  async refreshSessions(): Promise<ProviderIndexReport> {
    return inTauri() ? invoke<ProviderIndexReport>("refresh_sessions") : { roots: 0, discovered: 0, indexed: 0, unchanged: 0, skipped: 0, errors: [], by_provider: [] };
  },

  async onSessionRefreshComplete(handler: () => void): Promise<() => void> {
    if (!inTauri()) return () => undefined;
    const { listen } = await import("@tauri-apps/api/event");
    return listen("mobius://session-refresh-complete", () => handler());
  },

  async sessionIndexStatus(): Promise<{ running: boolean }> {
    return inTauri() ? invoke<{ running: boolean }>("session_index_status") : { running: false };
  },

  async listSuggestedSessionSources(): Promise<SessionSourceRoot[]> {
    return inTauri() ? invoke<SessionSourceRoot[]>("list_suggested_session_sources") : [];
  },

  async listApprovedSessionSources(): Promise<ApprovedSessionSources> {
    return inTauri() ? invoke<ApprovedSessionSources>("list_approved_session_sources") : { version: 1, roots: [] };
  },

  async addApprovedSessionSource(agent: AgentKind, path: string): Promise<ApprovedSessionSources> {
    if (!inTauri()) return { version: 1, roots: [] };
    return invoke<ApprovedSessionSources>("add_approved_session_source", { agent, path });
  },

  async removeApprovedSessionSource(agent: AgentKind, path: string): Promise<ApprovedSessionSources> {
    if (!inTauri()) return { version: 1, roots: [] };
    return invoke<ApprovedSessionSources>("remove_approved_session_source", { agent, path });
  },

  async grantMcpApproval(request: McpApprovalRequest): Promise<McpApprovalGrant> {
    if (!inTauri()) throw new Error("MCP approval is available in the desktop app.");
    return invoke<McpApprovalGrant>("grant_mcp_approval", { request });
  },

  async querySessions(query: SessionQuery): Promise<SessionSearchHit[]> {
    return inTauri() ? invoke<SessionSearchHit[]>("query_sessions", { query }) : [];
  },

  async getSessionMessages(sessionId: string): Promise<Message[]> {
    return inTauri() ? invoke<Message[]>("get_session_messages", { sessionId }) : [];
  },

  async workspaceRelayGraph(workspaceId: string): Promise<RelayGraph> {
    return inTauri() ? invoke<RelayGraph>("workspace_relay_graph", { workspaceId }) : { chains: [], edges: [], handoffs: [] };
  },

  async sessionLineage(sessionIds: string[]): Promise<import("./types").LineageManifest> {
    return invoke("session_lineage", { sessionIds });
  },
  async setSessionAlias(sessionId: string, alias: string): Promise<void> {
    return invoke("set_session_alias", { sessionId, alias });
  },

  async momeRecall(request: MomeRecallRequest): Promise<MomeRecallResponse> {
    if (!inTauri()) return { query: request.query, retrieval_mode: "browser_preview", semantic_status: "lexical_only_no_semantic_backend_configured", max_tokens: request.max_tokens ?? 1200, estimated_tokens: 0, sources: [] };
    return invoke<MomeRecallResponse>("mome_recall_command", { request });
  },

  async resumeSession(sessionId: string): Promise<TerminalInfo> {
    if (!inTauri()) throw new Error("Session resume is available in the desktop app.");
    return invoke<TerminalInfo>("resume_session", { sessionId });
  },

  async listTerminals(): Promise<TerminalInfo[]> { return inTauri() ? invoke<TerminalInfo[]>("terminal_list") : []; },
  async createTerminal(cwd: string, title?: string): Promise<TerminalInfo> { return invoke<TerminalInfo>("terminal_create", { cwd, title: title ?? null, initialCommand: null }); },
  async prepareHandoffTrajectory(sessionId: string): Promise<{ id: string; source_count: number; bytes: number; estimated_tokens: number; preview: string; snapshot_path: string }> {
    return invoke("prepare_handoff_trajectory", { sessionId });
  },
  async prepareHandoffGraph(sessionIds: string[]): Promise<{ id: string; source_count: number; bytes: number; estimated_tokens: number; preview: string; snapshot_path: string }> {
    return invoke("prepare_handoff_graph", { sessionIds });
  },
  async startAgentHandoff(provider: AgentKind, cwd: string, packet: string, lineage?: { sourceSessionId: string; sourceMessageId: string; checkoutId: string; workspaceId: string }, trajectoryId?: string): Promise<TerminalInfo> {
    return invoke<TerminalInfo>("start_agent_handoff", { provider, cwd, packet, sourceSessionId: lineage?.sourceSessionId ?? null, sourceMessageId: lineage?.sourceMessageId ?? null, checkoutId: lineage?.checkoutId ?? null, workspaceId: lineage?.workspaceId ?? null, trajectoryId: trajectoryId ?? null });
  },
  async writeTerminal(id: string, data: string): Promise<void> { await invoke("terminal_write", { id, data }); },
  async terminalSnapshot(id: string): Promise<TerminalSnapshot> { return invoke<TerminalSnapshot>("terminal_snapshot", { id }); },
  async resizeTerminal(id: string, rows: number, cols: number): Promise<void> { await invoke("terminal_resize", { id, rows, cols }); },
  async closeTerminal(id: string): Promise<void> { await invoke("terminal_close", { id }); },

  async listNoteFiles(): Promise<NoteFileInfo[]> { return inTauri() ? invoke<NoteFileInfo[]>("list_note_files_command") : []; },
  async readNoteFile(path: string): Promise<string> { return invoke<string>("read_note_file_command", { path }); },
  async revealNoteSource(path: string): Promise<void> {
    if (!inTauri()) return;
    await invoke("reveal_note_source", { path });
  },
  async readNoteAsset(sourcePath: string, relativePath: string): Promise<{ bytes: Uint8Array; mimeType: string }> {
    const bytes = await invoke<ArrayBuffer | Uint8Array>("read_note_asset_command", { sourcePath, relativePath });
    const value = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    return { bytes: value, mimeType: markdownAssetMime(relativePath) };
  },
  async updateNoteFile(path: string, draft: NoteDraft): Promise<ContextRecord> {
    if (!inTauri()) throw new Error("Saving is available in the desktop app.");
    return invoke<ContextRecord>("update_note_file_command", { path, draft });
  },
  async listNoteMounts(): Promise<MountInfo[]> { return inTauri() ? invoke<MountInfo[]>("list_note_mounts") : []; },
  async addNoteMount(path: string, virtualPath: string, access: "read_only" | "read_write"): Promise<MountInfo> { return invoke<MountInfo>("add_note_mount", { path, virtualPath, access }); },
  async removeNoteMount(id: string): Promise<boolean> { return invoke<boolean>("remove_note_mount", { id }); },
  async moveNote(path: string, destination: string): Promise<[string, string]> { return invoke<[string, string]>("move_note", { path, destination }); },
  async trashNote(path: string): Promise<TrashItem> { return invoke<TrashItem>("trash_note", { path }); },
  async trashBoard(boardId: string): Promise<TrashItem> { return invoke<TrashItem>("trash_board", { boardId }); },
  async listTrash(): Promise<TrashItem[]> { return inTauri() ? invoke<TrashItem[]>("list_trash") : []; },
  async restoreTrash(id: string): Promise<TrashItem> { return invoke<TrashItem>("restore_trash", { id }); },
  async purgeTrash(id: string): Promise<boolean> { return invoke<boolean>("purge_trash", { id }); },

  async health(): Promise<HealthStatus> {
    return inTauri() ? invoke<HealthStatus>("health") : clone(demoHealth);
  },

  async search(request: SearchRequest): Promise<ContextHit[]> {
    if (inTauri()) {
      return invoke<ContextHit[]>("search_context", { request });
    }
    const query = request.query.trim().toLowerCase();
    const matches = !query
      ? demoHits
      : demoHits.filter((item) =>
          [item.title, item.summary, item.snippet, item.project_slug, item.agent]
            .filter(Boolean)
            .join(" ")
            .toLowerCase()
            .includes(query)
        );
    return clone(matches.slice(0, request.limit ?? 8));
  },

  async readContext(id: string): Promise<ContextRecord | null> {
    if (inTauri()) {
      return invoke<ContextRecord | null>("read_context", { id });
    }
    return id === demoRecord.id ? clone(demoRecord) : null;
  },

  async listProjects(): Promise<ProjectSummary[]> {
    return inTauri() ? invoke<ProjectSummary[]>("list_projects") : clone(demoProjects);
  },

  async listAgents(): Promise<AgentStatus[]> {
    if (!inTauri()) {
      return clone(demoAgents);
    }
    const summaries = await invoke<AgentSummary[]>("list_agents");
    const summaryByAgent = new Map(summaries.map((item) => [item.agent, item]));
    return (["codex", "claude", "pi", "grok"] as const).map((id) => {
      const summary = summaryByAgent.get(id);
      const contexts = summary?.contexts ?? 0;
      return {
        id,
        label: id === "pi" ? "Pi" : id === "grok" ? "Grok" : id === "codex" ? "Codex" : "Claude",
        status: contexts > 0 ? "connected" : "needs_setup",
        sessions: contexts,
        detail: contexts > 0
          ? "Indexed locally" + (summary?.latest_at ? " · " + summary.latest_at.slice(0, 10) : "")
          : "Add a session source or MCP connection"
      };
    });
  },

  async createNote(draft: NoteDraft): Promise<ContextRecord> {
    if (inTauri()) {
      return invoke<ContextRecord>("create_note", { draft });
    }
    return {
      ...clone(demoRecord),
      id: "note:preview",
      kind: "note",
      agent: null,
      title: draft.title,
      body: draft.body,
      project_slug: draft.project_slug,
      updated_at: new Date().toISOString()
    };
  },

  async saveBoard(board: BoardDocument): Promise<ContextRecord> {
    if (inTauri()) {
      return invoke<ContextRecord>("save_board", { board });
    }
    return {
      ...clone(demoRecord),
      id: "board:" + board.id,
      kind: "board",
      title: board.title,
      project_slug: board.project_slug,
      body: JSON.stringify(board.data),
      updated_at: board.updated_at
    };
  },

  async listBoards(): Promise<BoardDocument[]> {
    return inTauri() ? invoke<BoardDocument[]>("list_boards") : [];
  },

  async importCanvasAsset(fileName: string, mimeType: string, bytes: Uint8Array): Promise<CanvasAssetInfo> {
    return invoke<CanvasAssetInfo>("import_canvas_asset", { fileName, mimeType, bytes: Array.from(bytes) });
  },

  async readCanvasAsset(assetId: string): Promise<Uint8Array> {
    const bytes = await invoke<ArrayBuffer | Uint8Array>("read_canvas_asset", { assetId });
    return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  },

  async fetchLinkPreview(rawUrl: string): Promise<LinkPreview> {
    if (inTauri()) return invoke<LinkPreview>("fetch_link_preview", { url: rawUrl });
    // Browser preview deliberately does not crawl arbitrary pages. It still
    // produces a usable bookmark card so the interaction can be previewed in
    // development without granting the browser an implicit crawler role.
    const url = new URL(rawUrl);
    const siteName = url.hostname.replace(/^www\./i, "");
    return {
      kind: /\.(?:avif|bmp|gif|jpe?g|png|svg|webp)$/i.test(url.pathname) ? "image" : /\.(?:m4v|mov|mp4|ogv|webm)$/i.test(url.pathname) ? "video" : "web",
      site_name: siteName,
      title: siteName,
      description: "Bookmark preview is available in the desktop app.",
      image_url: null,
      embed_url: null,
      provider: null
    };
  },

  async saveWiki(draft: WikiDraft): Promise<ContextRecord> {
    if (inTauri()) {
      return invoke<ContextRecord>("save_wiki", { draft });
    }
    return {
      ...clone(demoRecord),
      id: "wiki:preview",
      kind: "wiki",
      agent: null,
      title: draft.title,
      body: draft.body,
      project_slug: draft.project_slug,
      updated_at: new Date().toISOString()
    };
  },

  async listWikiQueue(): Promise<WikiQueueItem[]> {
    return inTauri() ? invoke<WikiQueueItem[]>("list_wiki_queue") : clone(demoWikiQueue);
  },

  async queueWikiReview(sourceContextId: string): Promise<WikiQueueItem> {
    if (inTauri()) {
      return invoke<WikiQueueItem>("queue_wiki_review", { sourceContextId });
    }
    return {
      id: "wiki-queue:browser-" + crypto.randomUUID(),
      source_context_id: sourceContextId,
      state: "queued",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
  },

  async reviewWikiQueue(queueId: string, stateName: "accepted" | "dismissed"): Promise<WikiQueueItem> {
    if (inTauri()) {
      return invoke<WikiQueueItem>("review_wiki_queue", { queueId, stateName });
    }
    const current = demoWikiQueue.find((item) => item.id === queueId);
    return {
      ...(current ?? demoWikiQueue[0]),
      id: queueId,
      state: stateName,
      updated_at: new Date().toISOString()
    };
  },

  async resolveMentions(text: string): Promise<ContextHit[]> {
    if (inTauri()) {
      return invoke<ContextHit[]>("resolve_mentions", { text });
    }
    return text.includes("@") ? clone(demoHits.slice(0, 3)) : [];
  },

  async listSkills(scope: "global" | "project" | "all" = "all"): Promise<SkillInfo[]> {
    return inTauri() ? invoke<SkillInfo[]>("list_skills", { scope }) : clone(demoSkills);
  },

  async listCheckoutSkills(checkoutId: string): Promise<SkillInfo[]> {
    return inTauri() ? invoke<SkillInfo[]>("list_checkout_skills", { checkoutId }) : [];
  },

  async listManagedSkills(): Promise<ManagedSkillInstall[]> {
    return inTauri() ? invoke<ManagedSkillInstall[]>("list_managed_skills") : [];
  },

  async listMarketplaceSkills(query = ""): Promise<Array<{
    slug: string;
    name: string;
    owner: string;
    description: string;
    category?: string;
    repositoryUrl?: string;
    pageUrl: string;
    githubStars?: number;
    qualityScore?: number;
    securityScore?: number;
  }>> {
    return inTauri() ? invoke("fetch_marketplace_skills", { query }) : [];
  },

  async fetchMarketplaceSkill(slug: string): Promise<string> {
    if (inTauri()) return invoke<string>("fetch_marketplace_skill", { slug });
    throw new Error("Marketplace installation is available in the desktop app.");
  },

  async readSkillContent(sourcePath: string): Promise<string> {
    if (inTauri()) {
      return invoke<string>("read_skill_content", { sourcePath });
    }
    const skill = demoSkills.find((item) => item.source_path === sourcePath);
    return skill ? `name: ${skill.name}\n\n# ${skill.name}\n\nBrowser preview only.` : "";
  },

  async writeManagedSkill(managedId: string, content: string): Promise<ManagedSkillInstall> {
    if (inTauri()) {
      return invoke<ManagedSkillInstall>("write_managed_skill", { managedId, content });
    }
    return {
      id: managedId,
      source_path: "",
      destination: "",
      target: "browser-preview",
      tree_hash: "",
      installed_at: new Date().toISOString()
    };
  },

  async previewSkill(sourcePath: string, target: string): Promise<SkillDeployment> {
    if (inTauri()) {
      return invoke<SkillDeployment>("preview_skill", { sourcePath, target });
    }
    const skill = demoSkills.find((item) => item.source_path === sourcePath) ?? demoSkills[0];
    return {
      managed_id: null,
      skill: clone(skill),
      target,
      target_root: target === "project" ? "E:\\Workspaces\\MyDesk\\.agents\\skills" : "C:\\Users\\MSI-NB\\.agents\\skills",
      destination: (target === "project" ? "E:\\Workspaces\\MyDesk\\.agents\\skills\\" : "C:\\Users\\MSI-NB\\.agents\\skills\\") + skill.name,
      can_install: !skill.managed,
      reason: skill.managed ? "This destination already has a managed copy." : "A new managed copy will be created; the source remains untouched."
    };
  },

  async installManagedSkill(sourcePath: string, target: string): Promise<SkillDeployment> {
    if (inTauri()) {
      return invoke<SkillDeployment>("install_managed_skill", { sourcePath, target });
    }
    const preview = await this.previewSkill(sourcePath, target);
    return { ...preview, managed_id: "managed-skill:browser-preview", can_install: false, reason: "Managed copy installed in browser preview." };
  },

  async installMarketplaceSkill(slug: string, name: string, content: string, target: string): Promise<SkillDeployment> {
    if (inTauri()) {
      return invoke<SkillDeployment>("install_marketplace_skill_command", { slug, name, content, target });
    }
    const preview = await this.previewSkill(`marketplace:${slug}`, target);
    return { ...preview, managed_id: "managed-skill:browser-preview", can_install: false, reason: "Managed copy installed in browser preview." };
  },

  async uninstallManagedSkill(managedId: string): Promise<ManagedSkillInstall> {
    if (inTauri()) {
      return invoke<ManagedSkillInstall>("uninstall_managed_skill", { managedId });
    }
    return {
      id: managedId,
      source_path: "",
      destination: "",
      target: "browser-preview",
      tree_hash: "",
      installed_at: new Date().toISOString()
    };
  },
  async listManagedSkillHistory(managedId: string): Promise<SkillHistoryEntry[]> {
    return inTauri() ? invoke<SkillHistoryEntry[]>("managed_skill_history", { managedId }) : [];
  },
  async restoreManagedSkillHistory(managedId: string, historyId: string): Promise<ManagedSkillInstall> {
    if (inTauri()) return invoke<ManagedSkillInstall>("restore_managed_skill_history", { managedId, historyId });
    return { id: managedId, source_path: "", destination: "", target: "browser-preview", tree_hash: "", installed_at: new Date().toISOString() };
  }
};
