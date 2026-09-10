import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from "react";
import { Archive, ArrowRight, Braces, ChevronDown, ChevronRight, CirclePlay, File, Folder, FolderGit2, FolderOpen, FolderPlus, GitBranch, GripVertical, LoaderCircle, PanelRight, Pin, Plus, Search, TerminalSquare, Workflow, X } from "lucide-react";
import { AccessibleDialog } from "./AccessibleDialog";
import { desktopApi } from "./api";
import type { Checkout, DirectoryEntry, RelayGraph, SessionSearchHit, SkillInfo, TerminalInfo, WorkspaceView } from "./types";

export type SessionFocus = { workspaceId: string; checkoutId: string | null; sessionId?: string };

type Locale = "zh-CN" | "en";

function words(locale: Locale) {
  const zh = locale === "zh-CN";
  return {
    zh,
    tree: zh ? "工程列表" : "Projects",
    recent: zh ? "近期工作区" : "Recent workspaces",
    recentHint: zh ? "从左侧拖入工程，建立一个可自行维护的近期工作区。" : "Drag projects here from the tree to maintain your own recent workspace.",
    add: zh ? "添加工作区" : "Add workspace",
    addHint: zh ? "登记目录不会移动文件，也不会改动 Git 或会话记录。" : "Registering a directory never moves files or changes Git or session history.",
    open: zh ? "打开终端" : "Open terminal",
    sessions: zh ? "会话" : "Sessions",
    files: zh ? "目录" : "Files",
    worktrees: zh ? "Worktrees" : "Worktrees",
    skills: zh ? "项目技能" : "Project skills",
    handoffs: zh ? "交接图" : "Handoff graph",
    allWorktrees: zh ? "全部 worktree" : "All worktrees",
    pinned: zh ? "已添加" : "Pinned",
    addRecent: zh ? "加入近期" : "Add to recent",
    removeRecent: zh ? "从近期移除" : "Remove from recent",
    drop: zh ? "拖到这里加入近期工作区" : "Drop a project here to add it",
    noWorkspace: zh ? "尚未登记工作区。" : "No workspaces are registered yet.",
    noSessions: zh ? "这个工程还没有可显示的会话。" : "No sessions are associated with this project yet.",
    scanHint: zh ? "会话按目录和 worktree 聚合；原始记录始终保持只读。" : "Sessions are grouped by directory and worktree; original transcripts remain read-only.",
    resume: zh ? "继续原会话" : "Resume original",
    inspect: zh ? "在会话库中查看" : "Inspect in session library",
    projectPath: zh ? "工程目录" : "Project directory",
    noFiles: zh ? "此目录中没有可显示的文件。" : "No visible files in this directory.",
    loading: zh ? "正在读取…" : "Loading…",
    selected: zh ? "已选工程" : "Selected project",
    manualPath: zh ? "或手动输入目录" : "Or enter a directory manually",
    register: zh ? "登记工作区" : "Register workspace",
    cancel: zh ? "取消" : "Cancel",
    dirty: zh ? "有改动" : "dirty",
    sessionsCount: zh ? "个会话" : "sessions"
  };
}

function providerName(value: string) {
  return value === "pi" ? "Pi" : value === "grok" ? "Grok" : value === "claude" ? "Claude" : "Codex";
}

function stableUnique(items: SessionSearchHit[]) {
  return [...new Map(items.map((item) => [item.session.id, item])).values()].sort((left, right) => right.session.updated_at.localeCompare(left.session.updated_at));
}

export function WorkspaceAtlas({ workspaces, reload, openTerminal, onError, onToast, onOpenSessions, locale }: {
  workspaces: WorkspaceView[];
  reload: () => Promise<void>;
  openTerminal: (terminal: TerminalInfo) => void;
  onError: (message: string) => void;
  onToast: (message: string) => void;
  onOpenSessions: (focus: SessionFocus) => void;
  locale: Locale;
}) {
  const text = words(locale);
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedCheckoutId, setSelectedCheckoutId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropActive, setDropActive] = useState(false);
  // Keep the payload outside React state as a native drag can finish before
  // the state update has committed in a WebView. This gives the drop target a
  // reliable fallback when DataTransfer#getData is empty during drop.
  const dragPayload = useRef<string | null>(null);
  const [path, setPath] = useState("E:\\Workspaces\\");
  const addPathRef = useRef<HTMLInputElement>(null);
  const [pins, setPins] = useState<string[]>(() => {
    try {
      const value = JSON.parse(localStorage.getItem("mobius.workspace.recent.v2") ?? "[]") as unknown;
      return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
    } catch { return []; }
  });

  useEffect(() => { localStorage.setItem("mobius.workspace.recent.v2", JSON.stringify(pins)); }, [pins]);
  useEffect(() => {
    const marker = "mobius.workspace.recent.v2.seeded";
    if (localStorage.getItem(marker) || !workspaces.length) return;
    setPins(workspaces.slice().sort((a, b) => b.workspace.updated_at.localeCompare(a.workspace.updated_at)).slice(0, 6).map((item) => item.workspace.id));
    localStorage.setItem(marker, "1");
  }, [workspaces]);
  useEffect(() => {
    setPins((current) => current.filter((id) => workspaces.some((item) => item.workspace.id === id)));
    if (selectedId && !workspaces.some((item) => item.workspace.id === selectedId)) setSelectedId(null);
  }, [selectedId, workspaces]);

  const filtered = useMemo(() => {
    const value = query.trim().toLocaleLowerCase();
    return value ? workspaces.filter((item) => `${item.workspace.display_name} ${item.workspace.canonical_path} ${item.checkouts.map((checkout) => checkout.branch ?? checkout.kind).join(" ")}`.toLocaleLowerCase().includes(value)) : workspaces;
  }, [query, workspaces]);
  const recent = pins.map((id) => workspaces.find((item) => item.workspace.id === id)).filter((item): item is WorkspaceView => Boolean(item));
  const selected = workspaces.find((item) => item.workspace.id === selectedId) ?? recent[0] ?? filtered[0] ?? null;
  const pin = (id: string) => setPins((current) => current.includes(id) ? current : [id, ...current]);
  const unpin = (id: string) => setPins((current) => current.filter((currentId) => currentId !== id));
  const select = (id: string, checkoutId: string | null = null) => {
    setSelectedId(id);
    setSelectedCheckoutId(checkoutId);
    // The session library deliberately opens in the same workspace the person
    // was just inspecting; this is a local UI preference, never transcript data.
    localStorage.setItem("mobius.workspace.current", id);
    setExpanded((current) => new Set(current).add(id));
  };
  const beginDrag = (event: DragEvent<HTMLElement>, id: string) => {
    // Keep the payload on the row itself. Nested interactive controls are
    // explicitly non-draggable below; otherwise WebView2 can start a second
    // drag source and the drop event arrives without the workspace id.
    event.dataTransfer?.setData("application/x-mobius-workspace", id);
    event.dataTransfer?.setData("text/plain", id);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "copy";
    dragPayload.current = id;
    setDraggingId(id);
  };
  const endDrag = () => {
    setDraggingId(null);
    setDropActive(false);
    // WebView2 can dispatch dragend before drop. Keep the ref briefly so the
    // drop handler still has a deterministic fallback when DataTransfer is
    // empty, then release it for a later external drag.
    window.setTimeout(() => { dragPayload.current = null; }, 250);
  };
  const dropProject = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    setDropActive(false);
    const id = event.dataTransfer?.getData("application/x-mobius-workspace") || event.dataTransfer?.getData("text/plain") || dragPayload.current || draggingId;
    dragPayload.current = null;
    setDraggingId(null);
    if (id && workspaces.some((item) => item.workspace.id === id)) pin(id);
  };
  const create = async () => {
    if (!path.trim()) return;
    try { await desktopApi.registerWorkspace(path.trim()); await reload(); setAdding(false); onToast(locale === "zh-CN" ? "工作区已登记" : "Workspace registered"); }
    catch (reason) { onError(String(reason)); }
  };
  const chooseWorkspaceDirectory = async () => {
    try {
      const selected = await desktopApi.pickDirectory(path);
      if (selected) setPath(selected);
    } catch (reason) { onError(String(reason)); }
  };

  return <div className="workspace-atlas">
    <aside className="atlas-project-tree" aria-label={text.tree}>
      <header className="atlas-tree-header"><div><span>WORKSPACE MAP</span><strong>{text.tree}</strong></div><button className="icon-soft atlas-add" type="button" onClick={() => setAdding(true)} title={text.add}><FolderPlus size={17}/></button></header>
      <label className="atlas-filter"><Search size={15}/><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={locale === "zh-CN" ? "查找工程或分支" : "Find a project or branch"}/></label>
      <div className="atlas-tree-scroll">{filtered.map((item) => {
        const isOpen = expanded.has(item.workspace.id);
        const isSelected = selected?.workspace.id === item.workspace.id;
        return <section key={item.workspace.id} className={`atlas-tree-item ${isSelected ? "selected" : ""}`}>
          <div className={`atlas-tree-row ${draggingId === item.workspace.id ? "dragging" : ""}`} data-workspace-id={item.workspace.id} draggable onDragStart={(event) => beginDrag(event, item.workspace.id)} onDragEnd={endDrag} aria-grabbed={draggingId === item.workspace.id} title={locale === "zh-CN" ? "拖动此项目到右侧近期工作区" : "Drag this project to Recent workspaces"}>
            <button className="atlas-expand" type="button" onClick={() => setExpanded((current) => { const next = new Set(current); next.has(item.workspace.id) ? next.delete(item.workspace.id) : next.add(item.workspace.id); return next; })} aria-label={isOpen ? "Collapse project" : "Expand project"} aria-expanded={isOpen}>{isOpen ? <ChevronDown size={15}/> : <ChevronRight size={15}/>}</button>
            <button className="atlas-project-button" type="button" draggable={false} title={item.workspace.canonical_path} onClick={() => select(item.workspace.id)} aria-current={isSelected ? "page" : undefined}><FolderGit2 size={16}/><span><strong>{item.workspace.display_name}</strong><small>{item.checkouts.length} {text.worktrees.toLocaleLowerCase()}</small></span></button>
            <button className="atlas-pin" type="button" onClick={() => pin(item.workspace.id)} title={pins.includes(item.workspace.id) ? text.pinned : text.addRecent} disabled={pins.includes(item.workspace.id)}><Pin size={14}/></button>
          </div>
          {isOpen ? <div className="atlas-checkouts">{item.checkouts.map((checkout) => <button key={checkout.id} type="button" className={selectedCheckoutId === checkout.id ? "active" : ""} onClick={() => { select(item.workspace.id, checkout.id); }}><GitBranch size={13}/><span>{checkout.branch ?? checkout.kind}</span>{checkout.dirty ? <i aria-label={text.dirty} role="img"/> : null}</button>)}</div> : null}
        </section>;
      })}{!filtered.length ? <div className="atlas-tree-empty">{text.noWorkspace}</div> : null}</div>
    </aside>
    <section className="atlas-workarea">
      <header className="atlas-recent-header"><div><span>YOUR WORKBENCH</span><h2>{text.recent}</h2><p>{text.recentHint}</p></div><button className="primary-button" type="button" onClick={() => setAdding(true)}><FolderPlus size={16}/>{text.add}</button></header>
      <section className={`recent-workspace-grid ${dropActive ? "drop-active" : ""}`} onDragEnter={(event) => { const types = [...event.dataTransfer.types]; if (dragPayload.current || draggingId || types.length === 0 || types.includes("application/x-mobius-workspace") || types.includes("text/plain")) setDropActive(true); }} onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; setDropActive(true); }} onDragLeave={(event) => { const nextTarget = event.relatedTarget as Node | null; if (!nextTarget || !event.currentTarget.contains(nextTarget)) setDropActive(false); }} onDrop={dropProject} aria-label={text.recent}>
        {recent.map((item) => <RecentWorkspaceCard key={item.workspace.id} item={item} selected={selected?.workspace.id === item.workspace.id} onSelect={() => select(item.workspace.id)} onRemove={() => unpin(item.workspace.id)} onOpen={() => { const checkout = item.checkouts[0]; if (checkout) void desktopApi.createTerminal(checkout.canonical_path, `PowerShell · ${item.workspace.display_name}`).then(openTerminal).catch((reason) => onError(String(reason))); }} text={text}/>) }
        <div className="recent-drop-target" aria-label={text.drop}><Plus size={18}/><span>{text.drop}</span></div>
      </section>
      {selected ? <WorkspaceInspector item={selected} initialCheckoutId={selectedCheckoutId} openTerminal={openTerminal} onError={onError} onOpenSessions={onOpenSessions} locale={locale}/> : <div className="atlas-empty"><FolderGit2 size={26}/><strong>{text.noWorkspace}</strong><span>{text.addHint}</span></div>}
    </section>
    {adding ? <AccessibleDialog title={text.add} closeLabel={text.cancel} onClose={() => setAdding(false)} initialFocusRef={addPathRef}><p className="modal-help">{text.addHint}</p><label className="form-label">{text.manualPath}<span className="folder-picker-input"><input ref={addPathRef} value={path} onChange={(event) => setPath(event.target.value)} placeholder="E:\\Workspaces\\Example"/><button className="soft-button" type="button" onClick={() => void chooseWorkspaceDirectory()}><FolderOpen size={15}/>{locale === "zh-CN" ? "选择目录" : "Choose folder"}</button></span></label><div className="modal-actions"><button className="soft-button" onClick={() => setAdding(false)}>{text.cancel}</button><button className="primary-button" onClick={() => void create()}>{text.register}</button></div></AccessibleDialog> : null}
  </div>;
}

function RecentWorkspaceCard({ item, selected, onSelect, onRemove, onOpen, text }: { item: WorkspaceView; selected: boolean; onSelect: () => void; onRemove: () => void; onOpen: () => void; text: ReturnType<typeof words> }) {
  const dirty = item.checkouts.filter((checkout) => checkout.dirty).length;
  return <article className={`recent-workspace-card ${selected ? "selected" : ""}`} onClick={onSelect} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelect(); } }} tabIndex={0} aria-current={selected ? "true" : undefined}>
    <header><span className="recent-symbol"><FolderGit2 size={20}/></span><div><strong>{item.workspace.display_name}</strong><code>{item.workspace.canonical_path}</code></div><button className="icon-soft recent-remove" type="button" onClick={(event) => { event.stopPropagation(); onRemove(); }} title={text.removeRecent}><X size={14}/></button></header>
    <div className="recent-card-meta"><span><b>{item.checkouts.length}</b> {text.worktrees.toLocaleLowerCase()}</span><span><b>{dirty}</b> {text.dirty}</span></div>
    <footer><button className="soft-button" type="button" onClick={(event) => { event.stopPropagation(); onOpen(); }}><TerminalSquare size={15}/>{text.open}</button><GripVertical size={15}/></footer>
  </article>;
}

function WorkspaceInspector({ item, initialCheckoutId, openTerminal, onError, onOpenSessions, locale }: { item: WorkspaceView; initialCheckoutId: string | null; openTerminal: (terminal: TerminalInfo) => void; onError: (message: string) => void; onOpenSessions: (focus: SessionFocus) => void; locale: Locale }) {
  const text = words(locale);
  const [tab, setTab] = useState<"sessions" | "files" | "worktrees" | "skills" | "handoffs">("sessions");
  // A project opens at its aggregate scope. Selecting the first worktree by
  // default hid valid sessions belonging to sibling worktrees.
  const [checkoutId, setCheckoutId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionSearchHit[]>([]);
  const [relayGraph, setRelayGraph] = useState<RelayGraph>({ chains: [], edges: [], handoffs: [] });
  const [loading, setLoading] = useState(false);
  useEffect(() => { setCheckoutId(initialCheckoutId); setTab("sessions"); }, [initialCheckoutId, item.workspace.id]);
  const checkout = item.checkouts.find((candidate) => candidate.id === checkoutId) ?? item.checkouts[0];
  const loadSessions = useCallback(async () => {
    setLoading(true);
    try {
      const scoped = await desktopApi.querySessions({ query: "", workspace_id: item.workspace.id, checkout_id: checkoutId, providers: [], limit: 160 });
      const checkoutScopes = checkoutId ? [checkoutId] : item.checkouts.map((candidate) => candidate.id);
      const fallback = await Promise.all(checkoutScopes.map((id) => desktopApi.querySessions({ query: "", workspace_id: null, checkout_id: id, providers: [], limit: 160 })));
      setSessions(stableUnique([...scoped, ...fallback.flat()]));
    } catch (reason) { onError(String(reason)); } finally { setLoading(false); }
  }, [checkoutId, item.checkouts, item.workspace.id, onError]);
  useEffect(() => { if (tab === "sessions" || tab === "handoffs") void loadSessions(); }, [loadSessions, tab]);
  useEffect(() => {
    if (tab !== "handoffs") return;
    setLoading(true);
    void desktopApi.workspaceRelayGraph(item.workspace.id)
      .then(setRelayGraph)
      .catch((reason) => onError(String(reason)))
      .finally(() => setLoading(false));
  }, [item.workspace.id, onError, tab]);
  const resume = async (sessionId: string) => { try { openTerminal(await desktopApi.resumeSession(sessionId)); } catch (reason) { onError(String(reason)); } };
  const byProvider = useMemo(() => {
    const groups = new Map<string, SessionSearchHit[]>();
    for (const hit of sessions) groups.set(hit.session.provider, [...(groups.get(hit.session.provider) ?? []), hit]);
    return groups;
  }, [sessions]);
  return <section className="workspace-inspector-v2" aria-label={text.selected}>
    <header className="inspector-title"><div><span>{text.selected.toUpperCase()}</span><h2>{item.workspace.display_name}</h2><code>{item.workspace.canonical_path}</code></div><label><span>{text.allWorktrees}</span><select value={checkoutId ?? ""} onChange={(event) => setCheckoutId(event.target.value || null)}><option value="">{text.allWorktrees}</option>{item.checkouts.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.branch ?? candidate.kind}</option>)}</select></label></header>
    <nav className="inspector-tabs"><button className={tab === "sessions" ? "active" : ""} onClick={() => setTab("sessions")}><Archive size={15}/>{text.sessions}<em>{sessions.length || ""}</em></button><button className={tab === "files" ? "active" : ""} onClick={() => setTab("files")}><Folder size={15}/>{text.files}</button><button className={tab === "worktrees" ? "active" : ""} onClick={() => setTab("worktrees")}><GitBranch size={15}/>{text.worktrees}</button><button className={tab === "skills" ? "active" : ""} onClick={() => setTab("skills")}><Braces size={15}/>{text.skills}</button><button className={tab === "handoffs" ? "active" : ""} onClick={() => setTab("handoffs")}><Workflow size={15}/>{text.handoffs}<em>{relayGraph.edges.length || ""}</em></button></nav>
    <div className="inspector-content">{tab === "sessions" ? <div className="project-session-panel"><p className="project-session-note">{text.scanHint}</p>{loading ? <div className="atlas-loading"><LoaderCircle className="spin" size={16}/>{text.loading}</div> : sessions.length ? [...byProvider.entries()].map(([provider, values]) => <section key={provider}><header><span className={`provider-pill ${provider}`}>{providerName(provider)}</span><small>{values.length} {text.sessionsCount}</small></header>{values.map((hit) => <article key={hit.session.id}><div><strong>{hit.session.title}</strong><small>{hit.session.updated_at.slice(0, 16).replace("T", " · ")} · {hit.session.state}</small><code>{hit.session.provider_session_id}</code></div><div className="project-session-actions">{hit.session.capabilities.includes("native_resume") ? <button className="soft-button" onClick={() => void resume(hit.session.id)}><CirclePlay size={14}/>{text.resume}</button> : null}<button className="icon-soft" onClick={() => onOpenSessions({ workspaceId: item.workspace.id, checkoutId, sessionId: hit.session.id })} title={text.inspect}><PanelRight size={16}/></button></div></article>)}</section>) : <div className="atlas-empty compact"><Archive size={24}/><strong>{text.noSessions}</strong><button className="soft-button" onClick={() => onOpenSessions({ workspaceId: item.workspace.id, checkoutId })}>{text.inspect}</button></div>}</div> : null}
      {tab === "files" && checkout ? <DirectoryExplorer checkout={checkout} onError={onError} text={text}/> : null}
      {tab === "worktrees" ? <div className="inspector-worktree-list">{item.checkouts.map((candidate) => <article key={candidate.id}><GitBranch size={16}/><div><strong>{candidate.branch ?? candidate.kind}</strong><code>{candidate.canonical_path}</code></div><span className={candidate.dirty ? "dirty-dot" : "clean-dot"}/><button className="soft-button" onClick={() => void desktopApi.createTerminal(candidate.canonical_path, `PowerShell · ${item.workspace.display_name}`).then(openTerminal).catch((reason) => onError(String(reason)))}><TerminalSquare size={14}/>{text.open}</button></article>)}</div> : null}
      {tab === "skills" ? <WorkspaceSkills checkouts={item.checkouts} checkoutId={checkoutId} onError={onError} locale={locale}/> : null}
      {tab === "handoffs" ? <WorkspaceRelayGraph graph={relayGraph} sessions={sessions} loading={loading} locale={locale} onOpenSession={(sessionId) => onOpenSessions({ workspaceId: item.workspace.id, checkoutId, sessionId })}/> : null}
    </div>
  </section>;
}

function WorkspaceRelayGraph({ graph, sessions, loading, locale, onOpenSession }: { graph: RelayGraph; sessions: SessionSearchHit[]; loading: boolean; locale: Locale; onOpenSession: (sessionId: string) => void }) {
  const zh = locale === "zh-CN";
  const bySession = new Map(sessions.map((hit) => [hit.session.id, hit.session]));
  const handoffs = new Map(graph.handoffs.map((handoff) => [handoff.id, handoff]));
  if (loading) return <div className="atlas-loading"><LoaderCircle className="spin" size={16}/>{zh ? "正在读取交接图…" : "Loading handoff graph…"}</div>;
  if (!graph.edges.length) return <div className="relay-graph-empty"><Workflow size={26}/><strong>{zh ? "还没有 Agent 交接" : "No Agent handoffs yet"}</strong><p>{zh ? "从项目会话中选择消息并交接后，关系会自动出现在这里。" : "Select a message in a project session and hand it off; the relationship will appear here automatically."}</p></div>;
  return <div className="workspace-relay-graph">
    <header><div><strong>{zh ? "Agent 交接链" : "Agent handoff chains"}</strong><span>{zh ? "Möbius 只维护索引关系，不修改原始会话。" : "Möbius stores only the lineage index and never changes source sessions."}</span></div><small>{graph.chains.length} {zh ? "条链" : "chains"} · {graph.edges.length} {zh ? "次交接" : "handoffs"}</small></header>
    {graph.chains.map((chain) => <section key={chain.id} className="relay-chain-card"><header><strong>{chain.title}</strong><time>{chain.updated_at.slice(0, 16).replace("T", " · ")}</time></header><div className="relay-chain-flow">{graph.edges.filter((edge) => edge.chain_id === chain.id).map((edge) => {
      const source = bySession.get(edge.source_session_id); const target = edge.target_session_id ? bySession.get(edge.target_session_id) : undefined; const handoff = handoffs.get(edge.handoff_id);
      return <div className="relay-edge" key={edge.id}><button type="button" onClick={() => onOpenSession(edge.source_session_id)}><span className={`provider-pill ${source?.provider ?? ""}`}>{source?.provider ?? "session"}</span><strong>{source?.title ?? edge.source_session_id}</strong></button><span className="relay-arrow"><ArrowRight size={17}/><small>{zh ? "接手" : "take over"}</small></span>{target ? <button type="button" onClick={() => onOpenSession(target.id)}><span className={`provider-pill ${target.provider}`}>{target.provider}</span><strong>{target.title}</strong></button> : <div className="relay-pending"><span className={`provider-pill ${handoff?.target_provider ?? ""}`}>{handoff?.target_provider ?? "Agent"}</span><strong>{zh ? "等待识别目标会话" : "Waiting for target session"}</strong></div>}</div>;
    })}</div></section>)}
  </div>;
}

function DirectoryExplorer({ checkout, onError, text }: { checkout: Checkout; onError: (message: string) => void; text: ReturnType<typeof words> }) {
  const [entries, setEntries] = useState<Record<string, DirectoryEntry[]>>({});
  const [open, setOpen] = useState<Set<string>>(() => new Set([""]));
  const [loading, setLoading] = useState<Set<string>>(() => new Set());
  const load = useCallback(async (relativePath: string) => {
    setLoading((current) => new Set(current).add(relativePath));
    try { const next = await desktopApi.listWorkspaceDirectory(checkout.id, relativePath); setEntries((current) => ({ ...current, [relativePath]: next })); }
    catch (reason) { onError(String(reason)); }
    finally { setLoading((current) => { const next = new Set(current); next.delete(relativePath); return next; }); }
  }, [checkout.id, onError]);
  useEffect(() => { setEntries({}); setOpen(new Set([""])); void load(""); }, [checkout.id, load]);
  const toggle = (entry: DirectoryEntry) => { if (entry.kind !== "directory") return; setOpen((current) => { const next = new Set(current); next.has(entry.relative_path) ? next.delete(entry.relative_path) : next.add(entry.relative_path); return next; }); if (!entries[entry.relative_path]) void load(entry.relative_path); };
  const render = (parent: string, depth: number): ReactNode => loading.has(parent) && !entries[parent] ? <div className="directory-loading" style={{ paddingInlineStart: 16 + depth * 18 }}><LoaderCircle className="spin" size={14}/>{text.loading}</div> : entries[parent]?.map((entry) => <div key={entry.relative_path}><button className="directory-explorer-row" style={{ paddingInlineStart: 14 + depth * 18 }} disabled={entry.kind !== "directory"} onClick={() => toggle(entry)}>{entry.kind === "directory" ? entry.has_children ? open.has(entry.relative_path) ? <ChevronDown size={14}/> : <ChevronRight size={14}/> : <span/> : <span/>}{entry.kind === "directory" ? open.has(entry.relative_path) ? <FolderOpen size={15}/> : <Folder size={15}/> : <File size={15}/>}<span>{entry.name}</span></button>{entry.kind === "directory" && open.has(entry.relative_path) ? render(entry.relative_path, depth + 1) : null}</div>);
  return <div className="directory-explorer"><header><FolderGit2 size={15}/><code>{checkout.canonical_path}</code></header>{render("", 0) ?? <div className="atlas-empty compact"><Folder size={22}/><strong>{text.noFiles}</strong></div>}</div>;
}

function WorkspaceSkills({ checkouts, checkoutId, onError, locale }: { checkouts: Checkout[]; checkoutId: string | null; onError: (message: string) => void; locale: Locale }) {
  const [skills, setSkills] = useState<Array<SkillInfo & { checkout: Checkout }>>([]);
  const activeCheckouts = checkoutId ? checkouts.filter((checkout) => checkout.id === checkoutId) : checkouts;
  const checkoutKey = activeCheckouts.map((checkout) => checkout.id).join("|");
  useEffect(() => {
    let active = true;
    void Promise.all(activeCheckouts.map(async (checkout) => {
      const found = await desktopApi.listCheckoutSkills(checkout.id);
      // A skill package may exist in two sibling worktrees with the same
      // content hash.  Keep both rows addressable in the aggregate inspector.
      return found.map((skill) => ({ ...skill, id: `${checkout.id}:${skill.id}`, checkout }));
    }))
      .then((groups) => { if (active) setSkills(groups.flat().sort((left, right) => left.name.localeCompare(right.name))); })
      .catch((reason) => { if (active) onError(String(reason)); });
    return () => { active = false; };
  }, [checkoutKey, onError]);
  return <div className="workspace-skill-list">{skills.length ? skills.map((skill) => <article key={skill.id}><Braces size={16}/><div><strong>{skill.name}</strong><code>{skill.source_path}</code></div></article>) : <div className="atlas-empty compact"><Braces size={22}/><strong>{locale === "zh-CN" ? "此 worktree 暂无项目技能。" : "No project skills in this worktree."}</strong></div>}</div>;
}
