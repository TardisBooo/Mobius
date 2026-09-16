import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Archive, ArrowRight, CheckCircle2, ChevronRight, CirclePlay, Copy, FolderCog, FolderGit2, Link2, LoaderCircle, PanelRight, Plus, Search, Send, ShieldCheck, Sparkles, Trash2 } from "lucide-react";
import { desktopApi } from "./api";
import { AccessibleDialog } from "./AccessibleDialog";
import { ContextMenu } from "./ContextMenu";
import type { AgentKind, ApprovedSessionSources, HealthStatus, LineageManifest, Message, MomeRecallResponse, SessionSearchHit, SessionSourceRoot, TerminalInfo, WorkspaceView } from "./types";
import type { SessionFocus } from "./WorkspaceAtlas";

type Locale = "zh-CN" | "en";
const agents: AgentKind[] = ["codex", "claude", "pi", "grok", "omp"];

function labels(locale: Locale) {
  const zh = locale === "zh-CN";
  return {
    all: zh ? "全部会话" : "All sessions", search: zh ? "搜索消息、架构、进度或踩坑" : "Search messages, architecture, progress or pitfalls",
    loading: zh ? "正在读取会话…" : "Loading sessions…", empty: zh ? "没有匹配的会话" : "No matching sessions", resume: zh ? "恢复" : "Resume", connected: zh ? "已连接" : "Connected",
    addContext: zh ? "添加上下文" : "Add context", copyReference: zh ? "复制精准引用" : "Copy precise reference", copyPackage: zh ? "复制上下文包" : "Copy context package",
    messages: zh ? "消息" : "Messages", loadEarlier: zh ? "显示更早消息" : "Show earlier messages", workspace: zh ? "目录 / 检出 / Harness" : "PATH / CHECKOUT / HARNESS",
    noNative: zh ? "原生恢复不可用" : "Native resume unavailable", source: zh ? "会话来源" : "Session source", current: zh ? "当前工作区" : "Current workspace",
    unassigned: zh ? "未关联目录" : "Unassigned directory", copied: zh ? "已复制到剪贴板" : "Copied to clipboard", contextTitle: zh ? "添加上下文" : "Add context",
    contextHint: zh ? "精确引用：选择一条消息并复制其 @session 链接。相关上下文：仅在你显式运行 Mome 本地检索时查找。两者都不会写入终端或自动注入内容。" : "Exact reference: choose one message and copy its @session link. Related context: use Mome only when you explicitly search locally. Neither writes to a terminal or injects content.",
    close: zh ? "关闭" : "Close", selected: zh ? "已选消息" : "Selected message", projectSessions: zh ? "工作区会话" : "Workspace sessions", openSession: zh ? "打开会话" : "Open session", copySource: zh ? "复制来源路径" : "Copy source path",
    mome: zh ? "查找相关记忆" : "Find related memory", momeTitle: zh ? "Mome · 查找相关记忆" : "Mome · Find related memory",
    momeHint: zh ? "Mome 仅在你输入查询后检索本地相关上下文。结果可审查、可复制；它不会创建 @session 精确引用，也不会写入终端或自动注入内容。" : "Mome searches related local context only after you enter a query. Results are reviewable and copyable; it does not create an @session reference or write to a terminal.",
    momePlaceholder: zh ? "描述当前任务、架构或遇到的问题" : "Describe the current task, architecture, or obstacle", momeRecall: zh ? "本地查找" : "Search locally",
    momeEmpty: zh ? "没有找到足够相关的已索引内容。" : "No sufficiently related indexed context was found.", momeCopy: zh ? "复制上下文包" : "Copy context package",
    momeFallback: zh ? "当前为本地 BM25 词法检索；尚未配置语义/向量后端。" : "Using local BM25 lexical recall; no semantic/vector backend is configured.", sources: zh ? "来源" : "Sources",
    sourcesTitle: zh ? "会话来源" : "Session sources", sourcesHint: zh ? "只添加你选择的 Harness 目录。批准后会刷新本地只读索引；不会修改来源文件。" : "Add only Harness directories you choose. Approved sources refresh the local read-only index; source files are never changed.",
    addSource: zh ? "添加来源" : "Add source", chooseDirectory: zh ? "选择目录" : "Choose directory", sourcePath: zh ? "目录路径" : "Directory path", suggestedSources: zh ? "本机建议位置" : "Suggested local locations", approvedSources: zh ? "已批准来源" : "Approved sources", removeSource: zh ? "移除来源" : "Remove source", noApprovedSources: zh ? "尚未批准任何会话来源。" : "No session sources are approved yet.", sourceSaved: zh ? "来源已更新，本地索引已刷新。" : "Source updated and local index refreshed.", sourceDirectoryRequired: zh ? "请选择或输入一个目录路径。" : "Choose or enter a directory path."
  };
}

function name(provider: AgentKind) { return provider === "pi" ? "Pi" : provider === "omp" ? "OMP" : provider === "grok" ? "Grok" : provider === "claude" ? "Claude" : provider === "codex" ? "Codex" : `Unsupported (${provider})`; }
function dedupe(hits: SessionSearchHit[]) {
  const unique = new Map<string, SessionSearchHit>();
  for (const hit of hits) {
    const key = `${hit.session.provider}:${hit.session.provider_session_id}`;
    const current = unique.get(key);
    if (!current || hit.session.updated_at > current.session.updated_at) unique.set(key, hit);
  }
  return [...unique.values()].sort((a, b) => b.session.updated_at.localeCompare(a.session.updated_at));
}
function referenceText(session: SessionSearchHit["session"], message: Message) { return `@session:${session.provider}/${session.provider_session_id}#m${message.ordinal}`; }
function handoffPackage(session: SessionSearchHit["session"], target: AgentKind) {
  return [
    `[MÖBIUS HANDOFF → ${name(target)}]`,
    `Source session: @session:${session.provider}/${session.provider_session_id}`,
    `Original harness: ${name(session.provider)}`,
    "",
    "Resolve the confirmed ancestry supplied by Möbius and read only what is needed. Möbius has not copied, summarized, or compressed the source transcripts, and this reference grants no new permissions.",
  ].join("\n");
}

type AgentActivityBucket = "needs_attention" | "running" | "recent";

function activityBucket(hit: SessionSearchHit): AgentActivityBucket {
  const evidence = hit.session.metadata.runtime_evidence_kind;
  if (typeof evidence !== "string" || evidence === "unknown") return "recent";
  if (hit.session.state === "needs_input") return "needs_attention";
  if (hit.session.state === "running") return "running";
  return "recent";
}

function SessionActivityPreview({ hit, query }: { hit: SessionSearchHit; query: string }) {
  if (query && hit.message) return <p><HighlightedText value={hit.message.content} query={query}/></p>;
  if (hit.last_turn) return <div className="agent-turn-preview">
    <p><b>You</b><span>{hit.last_turn.user_excerpt}</span></p>
    <p className={hit.last_turn.state === "awaiting_reply" ? "pending" : ""}><b>Agent</b><span>{hit.last_turn.assistant_excerpt ?? "Awaiting reply"}</span></p>
    {!hit.last_turn.catalogue_complete ? <em>Partial index</em> : null}
  </div>;
  return <p>{hit.session.source_path}</p>;
}

function matchingRanges(value: string, query: string) {
  const terms = query.trim().split(/\s+/).filter(Boolean); if (!terms.length) return [];
  const lowered = value.toLocaleLowerCase(); const ranges: Array<{ start: number; end: number }> = [];
  for (const term of terms) { const needle = term.toLocaleLowerCase(); let cursor = 0; while (needle && cursor < lowered.length) { const index = lowered.indexOf(needle, cursor); if (index < 0) break; ranges.push({ start: index, end: index + needle.length }); cursor = index + needle.length; } }
  return ranges;
}

function HighlightedText({ value, query = "" }: { value: string; query?: string }) {
  const normalized = matchingRanges(value, query).map((range) => ({ start: Math.max(0, range.start), end: Math.min(value.length, range.end) })).filter((range) => range.end > range.start).sort((left, right) => left.start - right.start || right.end - left.end);
  const merged: Array<{ start: number; end: number }> = []; for (const range of normalized) { const last = merged.at(-1); if (last && range.start <= last.end) last.end = Math.max(last.end, range.end); else merged.push(range); }
  if (!merged.length) return <>{value}</>; const parts: Array<{ value: string; match: boolean }> = []; let cursor = 0; for (const range of merged) { if (range.start > cursor) parts.push({ value: value.slice(cursor, range.start), match: false }); parts.push({ value: value.slice(range.start, range.end), match: true }); cursor = range.end; } if (cursor < value.length) parts.push({ value: value.slice(cursor), match: false });
  return <>{parts.map((part, index) => part.match ? <mark key={index} className="session-match">{part.value}</mark> : <span key={index}>{part.value}</span>)}</>;
}

export function SessionLibraryV2({ revision, indexing, workspaces, health, attachedSessionIds, openTerminal, onError, onToast, locale, focus, onFocusConsumed }: {
  revision: number; indexing: boolean; workspaces: WorkspaceView[]; health: HealthStatus | null; attachedSessionIds: string[]; openTerminal: (terminal: TerminalInfo, sessionId: string | null) => void; onError: (message: string) => void; onToast: (message: string) => void; locale: Locale; focus: SessionFocus | null; onFocusConsumed: () => void;
}) {
  const text = labels(locale);
  const handoffLabel = locale === "zh-CN" ? "交接" : "Hand off";
  const referenceHint = locale === "zh-CN"
    ? "交接会自动携带当前 Session 已确认的历史来路。原始记录保持只读，不会被总结、压缩或复制。"
    : "Handoff automatically carries this Session's confirmed history by reference. Source transcripts stay read-only and are never summarized, compressed, or copied.";
  const initialWorkspace = () => { try { const id = localStorage.getItem("mobius.workspace.current"); return workspaces.some((item) => item.workspace.id === id) ? id : workspaces[0]?.workspace.id ?? null; } catch { return workspaces[0]?.workspace.id ?? null; } };
  const [query, setQuery] = useState(() => localStorage.getItem("mobius.sessions.query") ?? "");
  const [provider, setProvider] = useState<AgentKind | "all">(() => {
    const stored = localStorage.getItem("mobius.sessions.provider");
    return agents.includes(stored as AgentKind) ? stored as AgentKind : "all";
  });
  const [workspaceId, setWorkspaceId] = useState<string | null>(() => {
    const stored = localStorage.getItem("mobius.sessions.workspace");
    return stored === "__all__" ? null : stored ?? initialWorkspace();
  });
  const [checkoutId, setCheckoutId] = useState<string | null>(() => {
    const stored = localStorage.getItem("mobius.sessions.checkout");
    return stored === "__all__" ? null : stored;
  });
  // Workspaces arrive asynchronously on first entry. Initialise the initial
  // project once, but do not treat a later explicit global scope (`null`) as
  // an uninitialised value and immediately overwrite the user's choice.
  const scopeInitialized = useRef(false);
  const explicitGlobalScope = useRef(localStorage.getItem("mobius.sessions.workspace") === "__all__");
  const [hits, setHits] = useState<SessionSearchHit[]>([]); const [loading, setLoading] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(() => localStorage.getItem("mobius.sessions.selected")); const [loadedMessages, setMessages] = useState<Message[]>([]); const [messageId, setMessageId] = useState<string | null>(() => localStorage.getItem("mobius.sessions.message")); const [messageLimit, setMessageLimit] = useState(180); const [handoffOpen, setHandoffOpen] = useState(false); const [momeOpen, setMomeOpen] = useState(false); const [sourcesOpen, setSourcesOpen] = useState(false);
  const messageStreamRef = useRef<HTMLDivElement>(null);
  const restoreMessageScroll = useRef<number | null>(null);
  const [lineage, setLineage] = useState<LineageManifest | null>(null);
  const [lineageLoading, setLineageLoading] = useState(false);
  useEffect(() => { if (indexing && momeOpen) setMomeOpen(false); }, [indexing, momeOpen]);
  const [sessionMenu, setSessionMenu] = useState<{ x: number; y: number; hit: SessionSearchHit } | null>(null);
  useEffect(() => { localStorage.setItem("mobius.sessions.query", query); }, [query]);
  useEffect(() => { localStorage.setItem("mobius.sessions.provider", provider); }, [provider]);
  useEffect(() => { localStorage.setItem("mobius.sessions.workspace", workspaceId ?? "__all__"); }, [workspaceId]);
  useEffect(() => { localStorage.setItem("mobius.sessions.checkout", checkoutId ?? "__all__"); }, [checkoutId]);
  useEffect(() => { if (selectedId) localStorage.setItem("mobius.sessions.selected", selectedId); }, [selectedId]);
  useEffect(() => { if (messageId) localStorage.setItem("mobius.sessions.message", messageId); }, [messageId]);
  // Never offer a previous session's message for copying/handoff during fetch.
  const messages = useMemo(() => loadedMessages.filter((message) => message.session_id === selectedId), [loadedMessages, selectedId]);
  const [storedFocus, setStoredFocus] = useState<SessionFocus | null>(() => {
    if (focus) return focus; try { const raw = sessionStorage.getItem("mobius.session.focus"); sessionStorage.removeItem("mobius.session.focus"); if (!raw) return null; const value = JSON.parse(raw) as Partial<SessionFocus>; return typeof value.workspaceId === "string" ? { workspaceId: value.workspaceId, checkoutId: typeof value.checkoutId === "string" ? value.checkoutId : null, sessionId: typeof value.sessionId === "string" ? value.sessionId : undefined } : null; } catch { return null; }
  });
  const effectiveFocus = focus ?? storedFocus;
  useEffect(() => {
    const focusSearch = () => window.requestAnimationFrame(() => document.querySelector<HTMLInputElement>(".session-search-v2 input")?.focus());
    const shortcut = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k" && !(event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement)) focusSearch();
    };
    const trigger = document.querySelector<HTMLElement>(".global-search");
    trigger?.addEventListener("click", focusSearch);
    window.addEventListener("keydown", shortcut);
    focusSearch();
    return () => {
      trigger?.removeEventListener("click", focusSearch);
      window.removeEventListener("keydown", shortcut);
    };
  }, []);
  useEffect(() => {
    if (scopeInitialized.current || !workspaces.length) return;
    scopeInitialized.current = true;
    setWorkspaceId((current) => current ?? (explicitGlobalScope.current ? null : initialWorkspace()));
  }, [workspaces]);
  useEffect(() => { if (!effectiveFocus) return; setWorkspaceId(effectiveFocus.workspaceId); setCheckoutId(effectiveFocus.checkoutId); setSelectedId(effectiveFocus.sessionId ?? null); setStoredFocus(null); onFocusConsumed(); }, [effectiveFocus, onFocusConsumed]);
  const search = useCallback(async () => { setLoading(true); try { const next = await desktopApi.querySessions({ query, workspace_id: workspaceId, checkout_id: checkoutId, providers: provider === "all" ? agents : [provider], limit: 240 }); const unique = dedupe(next.filter((hit) => agents.includes(hit.session.provider))); setHits(unique); setSelectedId((current) => unique.some((item) => item.session.id === current) ? current : unique[0]?.session.id ?? null); } catch (reason) { onError(String(reason)); } finally { setLoading(false); } }, [checkoutId, onError, provider, query, revision, workspaceId]);
  useEffect(() => { const timer = window.setTimeout(() => void search(), 130); return () => window.clearTimeout(timer); }, [search]);
  const selected = hits.find((item) => item.session.id === selectedId) ?? null;
  useEffect(() => { if (!selected) { setMessages([]); setMessageId(null); return; } let active = true; void desktopApi.getSessionMessages(selected.session.id).then((next) => { if (!active) return; const matchedIndex = selected.message ? next.findIndex((message) => message.id === selected.message?.id) : -1; setMessages(next); setMessageLimit(matchedIndex >= 0 ? Math.max(180, next.length - matchedIndex) : 180); setMessageId((current) => selected.message?.id ?? (next.some((message) => message.id === current) ? current : next.filter((message) => message.role === "user" || message.role === "assistant").at(-1)?.id ?? next.at(-1)?.id ?? null)); }).catch((reason) => onError(String(reason))); return () => { active = false; }; }, [onError, selected]);
  useEffect(() => {
    setLineage(null);
    if (!selectedId || desktopApi.runtime !== "desktop") return;
    let active = true;
    setLineageLoading(true);
    void desktopApi.sessionLineage([selectedId])
      .then((value) => { if (active) setLineage(value); })
      .catch((reason) => { if (active) onError(String(reason)); })
      .finally(() => { if (active) setLineageLoading(false); });
    return () => { active = false; };
  }, [onError, selectedId]);
  useEffect(() => {
    if (!selectedId) return;
    const saved = Number(localStorage.getItem(`mobius.sessions.scroll.${selectedId}`));
    restoreMessageScroll.current = Number.isFinite(saved) && saved > 0 ? saved : null;
  }, [selectedId]);
  useEffect(() => {
    if (!messageId) return;
    const frame = window.requestAnimationFrame(() => {
      const stream = messageStreamRef.current;
      if (!stream) return;
      if (restoreMessageScroll.current !== null) {
        stream.scrollTop = restoreMessageScroll.current;
        restoreMessageScroll.current = null;
      } else {
        stream.querySelector<HTMLElement>("article.selected")?.scrollIntoView({ block: "center", behavior: "smooth" });
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [messageId, messages.length, selectedId]);
  const selectedMessage = messages.find((message) => message.id === messageId) ?? null; const visibleMessages = messages.slice(Math.max(0, messages.length - messageLimit)); const activeWorkspace = workspaces.find((item) => item.workspace.id === workspaceId) ?? null;
  const copy = async (value: string) => { try { await navigator.clipboard.writeText(value); onToast(text.copied); } catch (reason) { onError(String(reason)); } };
  const [resumingId, setResumingId] = useState<string | null>(null);
  const resume = async () => {
    if (!selected || resumingId) return;
    setResumingId(selected.session.id);
    try { openTerminal(await desktopApi.resumeSession(selected.session.id), selected.session.id); }
    catch (reason) { onError(String(reason)); }
    finally { setResumingId(null); }
  };
  const startHandoff = async (target: AgentKind, packet: string, trajectoryId?: string) => {
    if (!selected) return;
    try {
      const recorded = typeof selected.session.metadata?.cwd === "string" ? selected.session.metadata.cwd : undefined;
      const workspace = workspaces.find((item) => item.checkouts.some((checkout) => checkout.id === selected.session.checkout_id));
      const checkout = workspace?.checkouts.find((item) => item.id === selected.session.checkout_id);
      const cwd = checkout?.canonical_path ?? recorded;
      if (!cwd) throw new Error(locale === "zh-CN" ? "该会话没有可验证的工作目录，请先把它关联到工作区。" : "This session has no verified working directory. Associate it with a workspace first.");
      const lineage = workspace && checkout ? { sourceSessionId: selected.session.id, sourceMessageId: selectedMessage?.id ?? "", checkoutId: checkout.id, workspaceId: workspace.workspace.id } : undefined;
      if (!lineage) throw new Error(locale === "zh-CN" ? "请先登记此会话的工作目录，以便保存交接关系。" : "Register this session's workspace before handing it off so its lineage can be recorded.");
      openTerminal(await desktopApi.startAgentHandoff(target, cwd, packet, lineage, trajectoryId), null);
      setHandoffOpen(false);
    } catch (reason) { onError(String(reason)); }
  };
  const selectScope = (nextWorkspace: string | null, nextCheckout: string | null) => { setWorkspaceId(nextWorkspace); setCheckoutId(nextCheckout); if (nextWorkspace) localStorage.setItem("mobius.workspace.current", nextWorkspace); };
  const selectSession = (sessionId: string, nextMessageId: string | null = null) => {
    // Keep the identity synchronously so rapid navigation cannot race React's
    // persistence effect and lose the Session the person was reading.
    localStorage.setItem("mobius.sessions.selected", sessionId);
    if (nextMessageId) localStorage.setItem("mobius.sessions.message", nextMessageId);
    setSelectedId(sessionId);
    setMessageId(nextMessageId);
  };
  const activityGroups = useMemo(() => {
    const groups: Record<AgentActivityBucket, SessionSearchHit[]> = { needs_attention: [], running: [], recent: [] };
    for (const hit of hits) groups[activityBucket(hit)].push(hit);
    return groups;
  }, [hits]);
  const activityLabels: Record<AgentActivityBucket, string> = locale === "zh-CN"
    ? { needs_attention: "需要处理", running: "正在运行", recent: "最近会话" }
    : { needs_attention: "Needs attention", running: "Running", recent: "Recent" };
  const renderSessionRow = (hit: SessionSearchHit) => <button key={hit.session.id} className={hit.session.id === selectedId ? "session-list-row active" : "session-list-row"} onContextMenu={(event) => { event.preventDefault(); setSessionMenu({ x: event.clientX, y: event.clientY, hit }); }} onClick={() => selectSession(hit.session.id, hit.message?.id ?? null)}><span className={`provider-pill ${hit.session.provider}`}>{name(hit.session.provider)}</span><div><strong>{hit.session.title}</strong><SessionActivityPreview hit={hit} query={query}/><small>{hit.session.updated_at.slice(0, 16).replace("T", " · ")} · {hit.session.state}</small></div>{hit.message ? <span className="match-marker">m{hit.message.ordinal}<ChevronRight size={13}/></span> : null}</button>;

  return <div className="session-library-v2">
    <section className="session-results-v2" aria-label={locale === "zh-CN" ? "Agent 会话" : "Agent sessions"}><header><div className="session-search-v2"><Search size={17}/><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={text.search}/></div><label className="session-workspace-filter"><span>{locale === "zh-CN" ? "工作区" : "Workspace"}</span><select aria-label={locale === "zh-CN" ? "筛选工作区" : "Filter workspace"} value={workspaceId ?? ""} onChange={(event) => selectScope(event.target.value || null, null)}><option value="">{text.all}</option>{workspaces.map((workspace) => <option key={workspace.workspace.id} value={workspace.workspace.id}>{workspace.workspace.display_name}</option>)}</select></label>{activeWorkspace?.checkouts.length ? <label className="session-workspace-filter"><span>{locale === "zh-CN" ? "检出目录" : "Checkout"}</span><select aria-label={locale === "zh-CN" ? "筛选检出目录" : "Filter checkout"} value={checkoutId ?? ""} onChange={(event) => selectScope(activeWorkspace.workspace.id, event.target.value || null)}><option value="">{locale === "zh-CN" ? "全部检出目录" : "All checkouts"}</option>{activeWorkspace.checkouts.map((checkout) => <option key={checkout.id} value={checkout.id}>{checkout.canonical_path}</option>)}</select></label> : null}<div className="session-filter-v2"><button className={provider === "all" ? "active" : ""} onClick={() => setProvider("all")}>{text.all}</button>{agents.map((agent) => <button key={agent} className={provider === agent ? "active" : ""} onClick={() => setProvider(agent)}>{name(agent)}</button>)}</div><div className="session-library-actions"><button className="soft-button" type="button" onClick={() => setSourcesOpen(true)}><FolderCog size={15}/>{text.sources}</button><button className="soft-button session-mome-trigger" type="button" onClick={() => setMomeOpen(true)}><Sparkles size={15}/>{text.mome}</button></div></header><div className="session-result-list-v2">{loading ? <div className="session-loading"><LoaderCircle className="spin" size={18}/>{text.loading}</div> : hits.length ? (["needs_attention", "running", "recent"] as AgentActivityBucket[]).map((bucket) => activityGroups[bucket].length ? <section className="agent-activity-group" key={bucket}><header><span>{activityLabels[bucket]}</span><small>{activityGroups[bucket].length}</small></header>{activityGroups[bucket].map(renderSessionRow)}</section> : null) : <div className="session-empty"><Archive size={27}/><strong>{text.empty}</strong></div>}</div></section>
    <main className="session-reader-v2">{selected ? <>
      <header><div><span className={`provider-pill ${selected.session.provider}`}>{name(selected.session.provider)}</span><h2>{selected.session.title}</h2><small>{activeWorkspace?.workspace.display_name ?? text.unassigned}</small></div>
      <div className="reader-actions-v2">
        {attachedSessionIds.includes(selected.session.id) ? <span className="session-connected" role="status"><CheckCircle2 size={16}/>{text.connected}</span> : selected.session.capabilities.includes("native_resume") ? <button className="primary-button" disabled={resumingId === selected.session.id} onClick={() => void resume()}>{resumingId === selected.session.id ? <LoaderCircle className="spin" size={16}/> : <CirclePlay size={16}/>} {text.resume}</button> : <button className="soft-button" disabled>{text.noNative}</button>}
        <button className="soft-button" onClick={() => setHandoffOpen(true)} aria-label={handoffLabel}><Send size={16}/>{handoffLabel}</button>
        <button className="icon-soft" aria-label={text.copyReference} title={text.copyReference} disabled={!selectedMessage} onClick={() => selectedMessage && void copy(referenceText(selected.session, selectedMessage))}><Link2 size={16}/></button>
      </div></header>
      <div className="message-toolbar"><span>{text.messages}</span><small>{messages.length}</small></div>
      <div ref={messageStreamRef} className="message-stream-v2" onScroll={(event) => { if (selectedId) localStorage.setItem(`mobius.sessions.scroll.${selectedId}`, String(event.currentTarget.scrollTop)); }}>{messages.length > visibleMessages.length ? <button className="earlier-messages" onClick={() => setMessageLimit((current) => current + 180)}>{text.loadEarlier}</button> : null}{visibleMessages.map((message) => { const matched = selected.message?.id === message.id; return <article key={message.id} className={`${message.id === messageId ? "selected" : ""} ${matched ? "has-search-match" : ""} ${message.role}`} onClick={() => setMessageId(message.id)} tabIndex={0} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setMessageId(message.id); } }}><header><span>{message.role}</span><small>m{message.ordinal}</small></header><p>{matched ? <HighlightedText value={message.content} query={query}/> : message.content}</p></article>; })}</div>
    </> : <div className="session-empty reader"><PanelRight size={28}/><strong>{text.empty}</strong></div>}</main>
    <aside className="session-context-v2" aria-label={locale === "zh-CN" ? "会话上下文" : "Session context"}>{selected ? <><header><strong>{locale === "zh-CN" ? "上下文" : "Context"}</strong></header><div className="reader-explanation"><ShieldCheck size={14}/><span>{referenceHint}</span></div><dl><dt>Harness</dt><dd>{name(selected.session.provider)}</dd><dt>{locale === "zh-CN" ? "工作区" : "Workspace"}</dt><dd>{activeWorkspace?.workspace.display_name ?? text.unassigned}</dd><dt>Checkout</dt><dd>{selected.session.checkout_id ?? text.unassigned}</dd><dt>{text.source}</dt><dd>{selected.session.provider_session_id}</dd><dt>{locale === "zh-CN" ? "原始记录" : "Transcript"}</dt><dd><code>{selected.session.source_path}</code><small>{locale === "zh-CN" ? "只读" : "read-only"}</small></dd></dl><SessionMemoryPath lineage={lineage} currentSessionId={selected.session.id} loading={lineageLoading} locale={locale}/></> : null}</aside>
    {sessionMenu ? <ContextMenu x={sessionMenu.x} y={sessionMenu.y} onClose={() => setSessionMenu(null)} items={[
      { id: "open-session", label: text.openSession, icon: <PanelRight size={14}/>, onSelect: () => selectSession(sessionMenu.hit.session.id, sessionMenu.hit.message?.id ?? null) },
      { id: "resume-session", label: text.resume, icon: <CirclePlay size={14}/>, disabled: !sessionMenu.hit.session.capabilities.includes("native_resume"), onSelect: () => { const id = sessionMenu.hit.session.id; void desktopApi.resumeSession(id).then((terminal) => openTerminal(terminal, id)).catch((reason) => onError(String(reason))); } },
      { id: "copy-source", label: text.copySource, icon: <Copy size={14}/>, onSelect: () => void copy(sessionMenu.hit.session.source_path) },
      { id: "copy-reference", label: text.copyReference, icon: <Link2 size={14}/>, disabled: !sessionMenu.hit.message, onSelect: () => { if (sessionMenu.hit.message) void copy(referenceText(sessionMenu.hit.session, sessionMenu.hit.message)); } },
    ]}/> : null}
    {handoffOpen && selected ? <HandoffDialog source={selected} locale={locale} onClose={() => setHandoffOpen(false)} onStart={startHandoff}/> : null}
    {momeOpen && !indexing ? <MomeDialog text={text} workspaceId={workspaceId} checkoutId={checkoutId} providers={provider === "all" ? [] : [provider]} onClose={() => setMomeOpen(false)} onCopy={copy} onError={onError}/> : null}
    {sourcesOpen ? <SourcesDialog text={text} onClose={() => setSourcesOpen(false)} onError={onError} onToast={onToast} onRefresh={search}/> : null}
  </div>;
}

function SessionMemoryPath({ lineage, currentSessionId, loading, locale }: { lineage: LineageManifest | null; currentSessionId: string; loading: boolean; locale: Locale }) {
  const zh = locale === "zh-CN";
  const nodes = [...(lineage?.nodes ?? [])].sort((left, right) => (left.updated_at ?? "").localeCompare(right.updated_at ?? ""));
  return <section className="session-memory-path" aria-label={zh ? "当前会话的记忆来路" : "Memory path for current session"}>
    <header><span>{zh ? "记忆来路" : "Memory path"}</span><small>{loading ? "…" : Math.max(0, nodes.length - 1)}</small></header>
    {loading ? <p>{zh ? "正在读取 Session 祖先…" : "Loading Session ancestors…"}</p> : nodes.length > 1 ? <div>{nodes.map((node) => <article key={node.session_id} className={node.session_id === currentSessionId ? "current" : ""}><i/><span><strong>{node.title ?? node.native_id ?? node.session_id}</strong><small>{node.harness ?? "?"} · {node.updated_at ? new Date(node.updated_at).toLocaleString(locale) : (zh ? "时间未知" : "Time unknown")}</small></span></article>)}</div> : <p>{zh ? "这个 Session 尚无已确认的上游交接。" : "This Session has no confirmed upstream handoff."}</p>}
  </section>;
}

function HandoffDialog({ source, locale, onClose, onStart }: { source: SessionSearchHit; locale: Locale; onClose: () => void; onStart: (target: AgentKind, packet: string, trajectoryId?: string) => Promise<void> }) {
  const zh = locale === "zh-CN";
  const targetChoices = agents;
  const [target, setTarget] = useState<AgentKind>(source.session.provider);
  const [starting, setStarting] = useState(false);
  const [review, setReview] = useState<Awaited<ReturnType<typeof desktopApi.prepareHandoffTrajectory>> | null>(null);
  const [preparing, setPreparing] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    setPreparing(true); setError(""); setReview(null);
    void desktopApi.prepareHandoffTrajectory(source.session.id)
      .then((value) => { if (active) setReview(value); })
      .catch((reason) => { if (active) setError(String(reason)); })
      .finally(() => { if (active) setPreparing(false); });
    return () => { active = false; };
  }, [source.session.id]);
  return <AccessibleDialog title={zh ? "交接当前会话" : "Hand off this session"} closeLabel={zh ? "关闭" : "Close"} onClose={onClose}>
    <div className="relay-dialog-v2">
      <p>{zh ? "选择目标 Agent 即可。Möbius 会自动携带当前会话已确认的历史来路；不会总结、压缩或复制原始日志。" : "Choose the target Agent. Möbius automatically carries the current session's confirmed history by reference—without summarizing, compressing, or copying transcripts."}</p>
      <section className="handoff-route">
        <span className={`provider-pill ${source.session.provider}`}>{name(source.session.provider)}</span><ArrowRight size={15}/>
        <label><span>{zh ? "目标 Agent" : "Target Agent"}</span><select aria-label={zh ? "目标 Agent" : "Target Agent"} value={target} onChange={(event) => setTarget(event.target.value as AgentKind)}>{targetChoices.map((agent) => <option key={agent} value={agent}>{name(agent)}</option>)}</select></label>
      </section>
      <section className="reference-preview">
        <span className={`provider-pill ${source.session.provider}`}>{name(source.session.provider)}</span>
        <code>@session:{source.session.provider}/{source.session.provider_session_id}</code>
        <p>{source.session.title}</p>
      </section>
      <section className="trajectory-review">
        {preparing ? <p className="handoff-resolving"><LoaderCircle className="spin" size={15}/>{zh ? "正在准备历史来路…" : "Preparing session history…"}</p> : null}
        {error ? <p role="alert">{error}</p> : null}
        {review ? <p className="handoff-ready"><CheckCircle2 size={15}/><span>{zh ? `${review.source_count} 个相关 Session 将通过引用提供，原始记录保持只读。` : `${review.source_count} related ${review.source_count === 1 ? "Session" : "Sessions"} will be available by reference. Source transcripts stay read-only.`}</span></p> : null}
      </section>
      <div className="modal-actions"><button className="soft-button" type="button" onClick={onClose}>{zh ? "取消" : "Cancel"}</button><button className="primary-button" disabled={starting || preparing || !review} onClick={() => { setStarting(true); void onStart(target, handoffPackage(source.session, target), review?.id).finally(() => setStarting(false)); }}><CirclePlay size={15}/>{starting ? (zh ? "正在启动…" : "Starting…") : (zh ? `交接给 ${name(target)}` : `Hand off to ${name(target)}`)}</button></div>
    </div>
  </AccessibleDialog>;
}

function SourcesDialog({ text, onClose, onError, onToast, onRefresh }: { text: ReturnType<typeof labels>; onClose: () => void; onError: (message: string) => void; onToast: (message: string) => void; onRefresh: () => Promise<void> }) {
  const [approved, setApproved] = useState<ApprovedSessionSources>({ version: 1, roots: [] }); const [suggested, setSuggested] = useState<SessionSourceRoot[]>([]); const [provider, setProvider] = useState<AgentKind>("codex"); const [path, setPath] = useState(""); const [loading, setLoading] = useState(true); const [saving, setSaving] = useState(false);
  const load = async () => { setLoading(true); try { const [roots, ideas] = await Promise.all([desktopApi.listApprovedSessionSources(), desktopApi.listSuggestedSessionSources()]); setApproved(roots); setSuggested(ideas); } catch (reason) { onError(String(reason)); } finally { setLoading(false); } };
  useEffect(() => { void load(); }, []);
  const refreshIndex = async () => { try { await desktopApi.refreshSessions(); await onRefresh(); onToast(text.sourceSaved); } catch (reason) { onError(String(reason)); } };
  const add = async () => { if (!path.trim()) { onError(text.sourceDirectoryRequired); return; } setSaving(true); try { setApproved(await desktopApi.addApprovedSessionSource(provider, path.trim())); setPath(""); await refreshIndex(); } catch (reason) { onError(String(reason)); } finally { setSaving(false); } };
  const remove = async (root: SessionSourceRoot) => { setSaving(true); try { setApproved(await desktopApi.removeApprovedSessionSource(root.agent, root.path)); await refreshIndex(); } catch (reason) { onError(String(reason)); } finally { setSaving(false); } };
  const chooseDirectory = async () => { try { const picked = await desktopApi.pickDirectory(path || undefined); if (picked) setPath(picked); } catch (reason) { onError(String(reason)); } };
  return <AccessibleDialog title={text.sourcesTitle} closeLabel={text.close} onClose={onClose}><div className="session-sources-dialog"><p className="context-dialog-hint">{text.sourcesHint}</p><section className="source-add"><select value={provider} onChange={(event) => setProvider(event.target.value as AgentKind)} aria-label="Agent provider">{agents.map((agent) => <option key={agent} value={agent}>{name(agent)}</option>)}</select><label><span>{text.sourcePath}</span><input value={path} onChange={(event) => setPath(event.target.value)} placeholder="C:\\Users\\…"/></label><button className="soft-button" type="button" onClick={() => void chooseDirectory()}><FolderGit2 size={15}/>{text.chooseDirectory}</button><button className="primary-button" type="button" disabled={saving} onClick={() => void add()}><Plus size={15}/>{text.addSource}</button></section><section className="source-list"><header><strong>{text.approvedSources}</strong><small>{approved.roots.length}</small></header>{loading ? <div className="session-loading"><LoaderCircle className="spin" size={16}/></div> : approved.roots.length ? approved.roots.map((root) => <article key={`${root.agent}:${root.path}`}><span className={`provider-pill ${root.agent}`}>{name(root.agent)}</span><code>{root.path}</code><button className="icon-soft" type="button" disabled={saving} aria-label={`${text.removeSource}: ${root.path}`} title={text.removeSource} onClick={() => void remove(root)}><Trash2 size={15}/></button></article>) : <p>{text.noApprovedSources}</p>}</section>{suggested.length ? <section className="source-list suggested"><header><strong>{text.suggestedSources}</strong><small>{suggested.length}</small></header>{suggested.map((root) => <button type="button" key={`${root.agent}:${root.path}`} onClick={() => { setProvider(root.agent); setPath(root.path); }}><span className={`provider-pill ${root.agent}`}>{name(root.agent)}</span><code>{root.path}</code><Plus size={14}/></button>)}</section> : null}</div></AccessibleDialog>;
}

function momePacket(response: MomeRecallResponse) {
  return [
    `[Möbius Mome · ${response.sources.length} cited local sources · ~${response.estimated_tokens} tokens]`,
    ...response.sources.map((source) => `${source.citation}\nHarness: ${name(source.provider)} · messages ${source.start_ordinal}–${source.end_ordinal}\n\n${source.text}`)
  ].join("\n\n---\n\n");
}

function MomeDialog({ text, workspaceId, checkoutId, providers, onClose, onCopy, onError }: {
  text: ReturnType<typeof labels>; workspaceId: string | null; checkoutId: string | null; providers: AgentKind[]; onClose: () => void; onCopy: (value: string) => Promise<void>; onError: (message: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<MomeRecallResponse | null>(null);
  const recallGeneration = useRef(0);
  const recall = async () => {
    if (!query.trim()) return;
    const generation = ++recallGeneration.current;
    setLoading(true);
    try {
      const response = await Promise.race([
        desktopApi.momeRecall({ query: query.trim(), workspace_id: workspaceId, checkout_id: checkoutId, providers, max_tokens: 1200 }),
        new Promise<never>((_, reject) => window.setTimeout(() => reject(new Error("Mome search timed out after 8 seconds. Refresh the local index and retry.")), 8_000)),
      ]);
      if (generation === recallGeneration.current) setResult(response);
    }
    catch (reason) { if (generation === recallGeneration.current) onError(String(reason)); }
    finally { if (generation === recallGeneration.current) setLoading(false); }
  };
  const close = () => { recallGeneration.current += 1; setLoading(false); onClose(); };
  return <AccessibleDialog title={text.momeTitle} closeLabel={text.close} onClose={close}>
    <div className="mome-dialog"><p className="context-dialog-hint">{text.momeHint}</p><label className="mome-query"><Search size={17}/><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void recall(); } }} placeholder={text.momePlaceholder}/></label>
      <div className="modal-actions"><button className="soft-button" type="button" onClick={close}>{text.close}</button><button className="primary-button" type="button" disabled={!query.trim() || loading} onClick={() => void recall()}>{loading ? <LoaderCircle className="spin" size={15}/> : <Sparkles size={15}/>} {text.momeRecall}</button></div>
      {result ? <section className="mome-result"><header><div><strong>{text.sources} · {result.sources.length}</strong><small>~{result.estimated_tokens} / {result.max_tokens} tokens</small></div>{result.semantic_status === "lexical_only_no_semantic_backend_configured" ? <span>{text.momeFallback}</span> : null}</header>{result.sources.length ? <div className="mome-sources">{result.sources.map((source) => <article key={source.content_hash}><code>{source.citation}</code><small>{name(source.provider)} · m{source.start_ordinal}–m{source.end_ordinal} · ~{source.estimated_tokens}</small><p>{source.text}</p></article>)}</div> : <p className="mome-empty">{text.momeEmpty}</p>}{result.sources.length ? <button className="primary-button" type="button" onClick={() => void onCopy(momePacket(result))}><Copy size={15}/>{text.momeCopy}</button> : null}</section> : null}
    </div>
  </AccessibleDialog>;
}
