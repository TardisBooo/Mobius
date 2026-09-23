import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Archive, Braces, ChevronDown, ChevronRight, FolderGit2, LoaderCircle, NotebookPen, RefreshCw, Search, Settings } from "lucide-react";
import { desktopApi } from "./api";
import { AccessibleDialog } from "./AccessibleDialog";
import { ContextMenu } from "./ContextMenu";
import type { SessionPreference, SessionSearchHit, WorkspaceView } from "./types";
import type { SessionFocus } from "./WorkspaceAtlas";

type Page = "workbench" | "sessions" | "notes" | "skills" | "settings";

export function ProjectSidebar({ workspaces, page, locale, revision, refreshing, onNavigate, onOpenSession, onRefresh, onRenamed, onError }: {
  workspaces: WorkspaceView[];
  page: Page;
  locale: "zh-CN" | "en";
  revision: number;
  refreshing: boolean;
  onNavigate: (page: Page) => void;
  onOpenSession: (focus: SessionFocus) => void;
  onRefresh: () => void;
  onRenamed: () => void;
  onError: (error: string) => void;
}) {
  const zh = locale === "zh-CN";
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<string | null>(() => localStorage.getItem("mobius.sidebar.expanded"));
  const [sort, setSort] = useState<"recent" | "name">(() => localStorage.getItem("mobius.sidebar.sort") === "name" ? "name" : "recent");
  const [recent, setRecent] = useState<SessionSearchHit[]>([]);
  const [projectSessions, setProjectSessions] = useState<Record<string, SessionSearchHit[]>>({});
  const [results, setResults] = useState<SessionSearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [preferences, setPreferences] = useState<Record<string, SessionPreference>>({});
  const [pinnedHits, setPinnedHits] = useState<SessionSearchHit[]>([]);
  const [showArchived, setShowArchived] = useState(false);
  const [sessionMenu, setSessionMenu] = useState<{ x: number; y: number; hit: SessionSearchHit } | null>(null);
  const [renaming, setRenaming] = useState<SessionSearchHit | null>(null);
  const [alias, setAlias] = useState("");
  const searchGeneration = useRef(0);
  const selectedId = localStorage.getItem("mobius.sessions.selected");
  useEffect(() => { let active = true; void desktopApi.listSessionPreferences().then((items) => { if (active) setPreferences(Object.fromEntries(items.map((item) => [item.session_id, item]))); }).catch((reason) => { if (active) onError(String(reason)); }); return () => { active = false; }; }, [onError, revision]);
  useEffect(() => { let active = true; const ids = Object.values(preferences).filter((item) => item.pinned).map((item) => item.session_id); void Promise.all(ids.map((id) => desktopApi.getSessionById(id))).then((items) => { if (active) setPinnedHits(items.filter((item) => item !== null).map((session) => ({ session, message: null, ranges: [], last_turn: null }))); }).catch((reason) => { if (active) onError(String(reason)); }); return () => { active = false; }; }, [preferences, onError]);

  const load = useCallback(async (workspaceId: string | null, searchText = "") => {
    return desktopApi.querySessions({ query: searchText, workspace_id: workspaceId, checkout_id: null, providers: [], limit: 200 });
  }, []);
  useEffect(() => {
    let active = true;
    void load(null).then((items) => { if (active) setRecent(items.slice(0, 5)); }).catch((reason) => { if (active) onError(String(reason)); });
    return () => { active = false; };
  }, [load, onError, revision]);
  useEffect(() => {
    if (!expanded || !workspaces.some((item) => item.workspace.id === expanded)) return;
    let active = true;
    void load(expanded).then((items) => { if (active) setProjectSessions((current) => ({ ...current, [expanded]: items })); }).catch((reason) => { if (active) onError(String(reason)); });
    return () => { active = false; };
  }, [expanded, load, onError, revision, workspaces]);
  useEffect(() => {
    const request = ++searchGeneration.current;
    if (!query.trim()) { setResults([]); setLoading(false); return; }
    setLoading(true);
    const timer = window.setTimeout(() => {
      void load(null, query.trim()).then((items) => { if (request === searchGeneration.current) setResults(items); }).catch((reason) => { if (request === searchGeneration.current) onError(String(reason)); }).finally(() => { if (request === searchGeneration.current) setLoading(false); });
    }, 160);
    return () => window.clearTimeout(timer);
  }, [load, onError, query, revision]);
  useEffect(() => {
    const focus = () => { onNavigate("sessions"); input.current?.focus(); input.current?.select(); };
    window.addEventListener("mobius:focus-search", focus);
    return () => window.removeEventListener("mobius:focus-search", focus);
  }, [onNavigate]);
  const ordered = useMemo(() => [...workspaces].sort((a, b) => sort === "name"
    ? a.workspace.display_name.localeCompare(b.workspace.display_name)
    : b.workspace.updated_at.localeCompare(a.workspace.updated_at)), [sort, workspaces]);
  const matchingProjects = useMemo(() => ordered.filter((item) => query.trim() && `${item.workspace.display_name} ${item.workspace.canonical_path}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())), [ordered, query]);
  const toggleProject = (id: string) => {
    const next = expanded === id ? null : id;
    setExpanded(next);
    if (next) localStorage.setItem("mobius.sidebar.expanded", next); else localStorage.removeItem("mobius.sidebar.expanded");
  };
  const open = (hit: SessionSearchHit) => {
    const workspace = workspaces.find((item) => item.checkouts.some((checkout) => checkout.id === hit.session.checkout_id));
    onOpenSession({ workspaceId: workspace?.workspace.id ?? "", checkoutId: null, sessionId: hit.session.id, messageId: hit.message?.id });
  };
  const updatePreference = async (hit: SessionSearchHit, property: "pinned" | "archived") => {
    const current = preferences[hit.session.id] ?? { session_id: hit.session.id, pinned: false, archived: false };
    const next = { ...current, [property]: !current[property] };
    try { await desktopApi.setSessionPreference(hit.session.id, next.pinned, next.archived); setPreferences((value) => ({ ...value, [hit.session.id]: next })); }
    catch (reason) { onError(String(reason)); }
  };
  const visible = (hits: SessionSearchHit[]) => hits.filter((hit) => showArchived || !preferences[hit.session.id]?.archived).sort((a, b) => Number(!!preferences[b.session.id]?.pinned) - Number(!!preferences[a.session.id]?.pinned));
  const sessionButton = (hit: SessionSearchHit) => <button key={hit.session.id} type="button" className={`project-session-link ${hit.session.id === selectedId ? "active" : ""}`} onClick={() => open(hit)} onContextMenu={(event) => { event.preventDefault(); setSessionMenu({ x: event.clientX, y: event.clientY, hit }); }} title={hit.session.title}>
    <span className={`project-harness-dot ${hit.session.provider}`}/><span className="project-session-copy"><strong>{preferences[hit.session.id]?.pinned ? "⌁ " : ""}{hit.session.title}</strong><small>{hit.session.provider} · {hit.session.updated_at.slice(0, 16).replace("T", " ")}{preferences[hit.session.id]?.archived ? (zh ? " · 已归档" : " · Archived") : ""}</small>{hit.message?.content ? <small className="project-session-excerpt">{hit.message.content.slice(0, 120)}</small> : null}</span>
  </button>;

  return <aside className="project-sidebar" aria-label={zh ? "项目与会话" : "Projects and sessions"}>
    <div className="project-sidebar-search"><Search size={16}/><input ref={input} value={query} onChange={(event) => setQuery(event.target.value)} placeholder={zh ? "搜索项目或会话" : "Search projects or sessions"} aria-label={zh ? "搜索项目或会话" : "Search projects or sessions"}/><kbd>Ctrl K</kbd></div>
    <div className="project-sidebar-scroll">
      {query.trim() ? <section className="project-sidebar-section"><header><span>{zh ? "搜索结果" : "Results"}</span><small>{matchingProjects.length + results.length}</small></header>{matchingProjects.map((item) => <button key={item.workspace.id} type="button" className="project-sidebar-project" onClick={() => { setQuery(""); setExpanded(item.workspace.id); localStorage.setItem("mobius.sidebar.expanded", item.workspace.id); onNavigate("sessions"); }}><FolderGit2 size={16}/><strong title={item.workspace.canonical_path}>{item.workspace.display_name}</strong></button>)}{loading ? <p className="project-sidebar-empty"><LoaderCircle className="spin" size={14}/></p> : results.length ? visible(results).map(sessionButton) : !matchingProjects.length ? <p className="project-sidebar-empty">{zh ? "没有找到项目或会话" : "No projects or sessions found"}</p> : null}</section> : <>
        {pinnedHits.length ? <section className="project-sidebar-section"><header><span>{zh ? "置顶" : "Pinned"}</span><small>{pinnedHits.length}</small></header>{visible(pinnedHits).map(sessionButton)}</section> : null}
        <section className="project-sidebar-section"><header><span>{zh ? "最近" : "Recent"}</span><button type="button" title={zh ? "扫描会话" : "Scan sessions"} aria-label={zh ? "扫描会话" : "Scan sessions"} disabled={refreshing} onClick={onRefresh}>{refreshing ? <LoaderCircle className="spin" size={14}/> : <RefreshCw size={14}/>}</button></header>{visible(recent.filter((hit) => !preferences[hit.session.id]?.pinned)).map(sessionButton)}</section>
        <section className="project-sidebar-section"><header><span>{zh ? "项目" : "Projects"}</span><button type="button" onClick={() => { const next = sort === "name" ? "recent" : "name"; setSort(next); localStorage.setItem("mobius.sidebar.sort", next); }} title={sort === "name" ? (zh ? "按名称排序" : "Sort by name") : (zh ? "按时间排序" : "Sort by recent")}>{sort === "name" ? "A–Z" : "↓"}</button></header>
          {ordered.map((item) => <div key={item.workspace.id} className="project-sidebar-group"><button type="button" className={`project-sidebar-project ${expanded === item.workspace.id ? "active" : ""}`} aria-expanded={expanded === item.workspace.id} onClick={() => toggleProject(item.workspace.id)}>{expanded === item.workspace.id ? <ChevronDown size={15}/> : <ChevronRight size={15}/>}<FolderGit2 size={16}/><strong title={item.workspace.canonical_path}>{item.workspace.display_name}</strong></button>{expanded === item.workspace.id ? <div className="project-sidebar-children">{visible(projectSessions[item.workspace.id] ?? []).map(sessionButton)}{projectSessions[item.workspace.id]?.length === 0 ? <p className="project-sidebar-empty">{zh ? "暂无会话" : "No sessions"}</p> : null}{(projectSessions[item.workspace.id]?.length ?? 0) === 200 ? <p className="project-sidebar-empty">{zh ? "显示最近 200 条；用搜索查找更早会话" : "Latest 200; search for older sessions"}</p> : null}</div> : null}</div>)}
        </section>
        <button className="project-archive-toggle" type="button" onClick={() => setShowArchived((value) => !value)}>{zh ? (showArchived ? "隐藏归档" : "显示归档") : (showArchived ? "Hide archived" : "Show archived")}</button>
      </>}
    </div>
    <nav className="project-sidebar-nav mobius-rail" aria-label={zh ? "应用导航" : "App navigation"}>
      <button className={`rail-item ${page === "sessions" ? "active" : ""}`} onClick={() => onNavigate("sessions")}><Archive size={17}/>{zh ? "会话" : "Sessions"}</button>
      <button className={`rail-item ${page === "workbench" ? "active" : ""}`} onClick={() => onNavigate("workbench")}><FolderGit2 size={17}/>{zh ? "工作区" : "Workspaces"}</button>
      <button className={`rail-item ${page === "notes" ? "active" : ""}`} onClick={() => onNavigate("notes")}><NotebookPen size={17}/>{zh ? "资料与画布" : "Library & canvas"}</button>
      <button className={page === "skills" ? "active" : ""} onClick={() => onNavigate("skills")}><Braces size={17}/>{zh ? "技能" : "Skills"}</button>
      <button className={page === "settings" ? "active" : ""} onClick={() => onNavigate("settings")}><Settings size={17}/>{zh ? "设置" : "Settings"}</button>
    </nav>
    {sessionMenu ? <ContextMenu x={sessionMenu.x} y={sessionMenu.y} onClose={() => setSessionMenu(null)} items={[{ id: "open", label: zh ? "打开会话" : "Open session", onSelect: () => open(sessionMenu.hit) }, { id: "rename", label: zh ? "重命名会话" : "Rename session", onSelect: () => { setRenaming(sessionMenu.hit); setAlias(sessionMenu.hit.session.title); } }, { id: "pin", label: preferences[sessionMenu.hit.session.id]?.pinned ? (zh ? "取消置顶" : "Unpin") : (zh ? "置顶" : "Pin"), onSelect: () => void updatePreference(sessionMenu.hit, "pinned") }, { id: "archive", label: preferences[sessionMenu.hit.session.id]?.archived ? (zh ? "取消归档" : "Unarchive") : (zh ? "归档" : "Archive"), onSelect: () => void updatePreference(sessionMenu.hit, "archived") }, { id: "reference", label: zh ? "复制会话引用" : "Copy session reference", onSelect: () => void navigator.clipboard.writeText(`@session:${sessionMenu.hit.session.provider}/${sessionMenu.hit.session.provider_session_id}`).catch((reason) => onError(String(reason))) }]}/> : null}
    {renaming ? <AccessibleDialog title={zh ? "重命名会话" : "Rename session"} closeLabel={zh ? "关闭" : "Close"} onClose={() => setRenaming(null)}><form className="project-rename-dialog" onSubmit={(event) => { event.preventDefault(); if (!alias.trim()) return; void desktopApi.setSessionAlias(renaming.session.id, alias.trim()).then(() => { setRenaming(null); onRenamed(); }).catch((reason) => onError(String(reason))); }}><label>{zh ? "显示名称" : "Display name"}<input value={alias} onChange={(event) => setAlias(event.target.value)} maxLength={200} autoFocus/></label><div className="modal-actions"><button type="button" className="soft-button" onClick={() => setRenaming(null)}>{zh ? "取消" : "Cancel"}</button><button type="submit" className="primary-button" disabled={!alias.trim()}>{zh ? "保存" : "Save"}</button></div></form></AccessibleDialog> : null}
  </aside>;
}
