import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Archive, ArrowRight, ChevronDown, ChevronRight, CirclePlay, Copy, FolderCog, FolderGit2, GitBranch, Link2, LoaderCircle, PanelRight, Plus, Search, Send, ShieldCheck, Sparkles, Trash2 } from "lucide-react";
import { desktopApi } from "./api";
import { AccessibleDialog } from "./AccessibleDialog";
import { ContextMenu } from "./ContextMenu";
import type { AgentKind, ApprovedSessionSources, HealthStatus, Message, MomeRecallResponse, SessionSearchHit, SessionSourceRoot, TerminalInfo, WorkspaceView } from "./types";
import type { SessionFocus } from "./WorkspaceAtlas";

type Locale = "zh-CN" | "en";
const agents: AgentKind[] = ["codex", "claude", "pi", "grok"];

function labels(locale: Locale) {
  const zh = locale === "zh-CN";
  return {
    all: zh ? "全部会话" : "All sessions", search: zh ? "搜索消息、架构、进度或踩坑" : "Search messages, architecture, progress or pitfalls",
    loading: zh ? "正在读取会话…" : "Loading sessions…", empty: zh ? "没有匹配的会话" : "No matching sessions", resume: zh ? "继续原会话" : "Resume original",
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

function name(provider: AgentKind) { return provider === "pi" ? "Pi" : provider === "grok" ? "Grok" : provider === "claude" ? "Claude" : provider === "codex" ? "Codex" : `Unsupported (${provider})`; }
function dedupe(hits: SessionSearchHit[]) { const unique = new Map<string, SessionSearchHit>(); for (const hit of hits) if (!unique.has(hit.session.id)) unique.set(hit.session.id, hit); return [...unique.values()].sort((a, b) => b.session.updated_at.localeCompare(a.session.updated_at)); }
function referenceText(session: SessionSearchHit["session"], message: Message) { return `@session:${session.provider}/${session.provider_session_id}#m${message.ordinal}`; }
function handoffPackage(session: SessionSearchHit["session"], message: Message, target: AgentKind) {
  return [
    `[MÖBIUS HANDOFF → ${name(target)}]`,
    `Source: ${referenceText(session, message)}`,
    `Original harness: ${name(session.provider)}`,
    `Message: m${message.ordinal}`,
    "",
    "This is an explicit, user-approved transfer package. Review the cited source before acting; it does not grant new permissions.",
    "",
    message.content,
  ].join("\n");
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

export function SessionLibraryV2({ revision, workspaces, health, openTerminal, onError, onToast, locale, focus, onFocusConsumed }: {
  revision: number; workspaces: WorkspaceView[]; health: HealthStatus | null; openTerminal: (terminal: TerminalInfo) => void; onError: (message: string) => void; onToast: (message: string) => void; locale: Locale; focus: SessionFocus | null; onFocusConsumed: () => void;
}) {
  const text = labels(locale);
  const handoffLabel = locale === "zh-CN" ? "交接给其他 Agent" : "Hand off to another Agent";
  const referenceHint = locale === "zh-CN"
    ? "精准引用只复制 @session 链接；交接会生成面向目标 Agent 的可审查文本包。两者都不会写入终端或自动注入内容。"
    : "Precise reference copies only an @session link. Handoff creates a reviewable packet for a chosen Agent. Neither writes to a terminal or injects content.";
  const initialWorkspace = () => { try { const id = localStorage.getItem("mobius.workspace.current"); return workspaces.some((item) => item.workspace.id === id) ? id : workspaces[0]?.workspace.id ?? null; } catch { return workspaces[0]?.workspace.id ?? null; } };
  const [query, setQuery] = useState(""); const [provider, setProvider] = useState<AgentKind | "all">("all"); const [workspaceId, setWorkspaceId] = useState<string | null>(initialWorkspace); const [checkoutId, setCheckoutId] = useState<string | null>(null);
  // Workspaces arrive asynchronously on first entry. Initialise the initial
  // project once, but do not treat a later explicit global scope (`null`) as
  // an uninitialised value and immediately overwrite the user's choice.
  const scopeInitialized = useRef(false);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set()); const [hits, setHits] = useState<SessionSearchHit[]>([]); const [loading, setLoading] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null); const [loadedMessages, setMessages] = useState<Message[]>([]); const [messageId, setMessageId] = useState<string | null>(null); const [messageLimit, setMessageLimit] = useState(180); const [handoffOpen, setHandoffOpen] = useState(false); const [momeOpen, setMomeOpen] = useState(false); const [sourcesOpen, setSourcesOpen] = useState(false);
  const [sessionMenu, setSessionMenu] = useState<{ x: number; y: number; hit: SessionSearchHit } | null>(null);
  // Never offer a previous session's message for copying/handoff during fetch.
  const messages = useMemo(() => loadedMessages.filter((message) => message.session_id === selectedId), [loadedMessages, selectedId]);
  const [storedFocus, setStoredFocus] = useState<SessionFocus | null>(() => {
    if (focus) return focus; try { const raw = sessionStorage.getItem("mobius.session.focus"); sessionStorage.removeItem("mobius.session.focus"); if (!raw) return null; const value = JSON.parse(raw) as Partial<SessionFocus>; return typeof value.workspaceId === "string" ? { workspaceId: value.workspaceId, checkoutId: typeof value.checkoutId === "string" ? value.checkoutId : null, sessionId: typeof value.sessionId === "string" ? value.sessionId : undefined } : null; } catch { return null; }
  });
  const effectiveFocus = focus ?? storedFocus;
  useEffect(() => {
    if (scopeInitialized.current || !workspaces.length) return;
    scopeInitialized.current = true;
    setWorkspaceId((current) => current ?? initialWorkspace());
  }, [workspaces]);
  useEffect(() => { if (!effectiveFocus) return; setWorkspaceId(effectiveFocus.workspaceId); setCheckoutId(effectiveFocus.checkoutId); setSelectedId(effectiveFocus.sessionId ?? null); setExpanded((current) => new Set(current).add(effectiveFocus.workspaceId)); setStoredFocus(null); onFocusConsumed(); }, [effectiveFocus, onFocusConsumed]);
  const search = useCallback(async () => { setLoading(true); try { const next = await desktopApi.querySessions({ query, workspace_id: workspaceId, checkout_id: checkoutId, providers: provider === "all" ? [] : [provider], limit: 240 }); const unique = dedupe(next); setHits(unique); setSelectedId((current) => unique.some((item) => item.session.id === current) ? current : unique[0]?.session.id ?? null); } catch (reason) { onError(String(reason)); } finally { setLoading(false); } }, [checkoutId, onError, provider, query, revision, workspaceId]);
  useEffect(() => { const timer = window.setTimeout(() => void search(), 130); return () => window.clearTimeout(timer); }, [search]);
  const selected = hits.find((item) => item.session.id === selectedId) ?? null;
  useEffect(() => { if (!selected) { setMessages([]); setMessageId(null); return; } let active = true; void desktopApi.getSessionMessages(selected.session.id).then((next) => { if (!active) return; const matchedIndex = selected.message ? next.findIndex((message) => message.id === selected.message?.id) : -1; setMessages(next); setMessageLimit(matchedIndex >= 0 ? Math.max(180, next.length - matchedIndex) : 180); setMessageId((current) => selected.message?.id ?? (next.some((message) => message.id === current) ? current : next.filter((message) => message.role === "user" || message.role === "assistant").at(-1)?.id ?? next.at(-1)?.id ?? null)); }).catch((reason) => onError(String(reason))); return () => { active = false; }; }, [onError, selected]);
  useEffect(() => { if (!messageId) return; const frame = window.requestAnimationFrame(() => document.querySelector<HTMLElement>(".message-stream-v2 article.selected")?.scrollIntoView({ block: "center", behavior: "smooth" })); return () => window.cancelAnimationFrame(frame); }, [messageId, messages.length, selectedId]);
  const selectedMessage = messages.find((message) => message.id === messageId) ?? null; const visibleMessages = messages.slice(Math.max(0, messages.length - messageLimit)); const activeWorkspace = workspaces.find((item) => item.workspace.id === workspaceId) ?? null;
  const copy = async (value: string) => { try { await navigator.clipboard.writeText(value); onToast(text.copied); } catch (reason) { onError(String(reason)); } };
  const resume = async () => { if (!selected) return; try { openTerminal(await desktopApi.resumeSession(selected.session.id)); } catch (reason) { onError(String(reason)); } };
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
      openTerminal(await desktopApi.startAgentHandoff(target, cwd, packet, lineage, trajectoryId));
      setHandoffOpen(false);
    } catch (reason) { onError(String(reason)); }
  };
  const selectScope = (nextWorkspace: string | null, nextCheckout: string | null) => { setWorkspaceId(nextWorkspace); setCheckoutId(nextCheckout); if (nextWorkspace) localStorage.setItem("mobius.workspace.current", nextWorkspace); };
  const byCheckoutAndHarness = useMemo(() => {
    const result = new Map<string, Map<AgentKind, SessionSearchHit[]>>(); for (const hit of hits) { const checkout = hit.session.checkout_id ?? "unassigned"; const byHarness = result.get(checkout) ?? new Map<AgentKind, SessionSearchHit[]>(); byHarness.set(hit.session.provider, [...(byHarness.get(hit.session.provider) ?? []), hit]); result.set(checkout, byHarness); } return result;
  }, [hits]);

  return <div className="session-library-v2">
    <aside className="session-tree-v2" aria-label={text.workspace}><header><span>{text.workspace}</span><small>{health?.sessions ?? 0}</small></header><button className={!workspaceId ? "session-scope active" : "session-scope"} onClick={() => selectScope(null, null)}><Archive size={15}/>{text.all}</button><div className="session-tree-scroll">{workspaces.map((workspace) => {
      const isOpen = expanded.has(workspace.workspace.id), isCurrent = workspaceId === workspace.workspace.id && !checkoutId;
      return <section key={workspace.workspace.id}><div className={`session-workspace-row ${isCurrent ? "selected" : ""}`}><button className="session-tree-toggle" aria-label={`${isOpen ? (locale === "zh-CN" ? "折叠" : "Collapse") : (locale === "zh-CN" ? "展开" : "Expand")} ${workspace.workspace.display_name}`} aria-expanded={isOpen} onClick={() => setExpanded((current) => { const next = new Set(current); next.has(workspace.workspace.id) ? next.delete(workspace.workspace.id) : next.add(workspace.workspace.id); return next; })}>{isOpen ? <ChevronDown size={14}/> : <ChevronRight size={14}/>}</button><button className="session-workspace-button" onClick={() => selectScope(workspace.workspace.id, null)}><FolderGit2 size={15}/><span>{workspace.workspace.display_name}</span></button></div>{isOpen ? <div className="session-checkout-tree">{workspace.checkouts.map((checkout) => <section key={checkout.id}><button className={checkoutId === checkout.id ? "active" : ""} onClick={() => selectScope(workspace.workspace.id, checkout.id)}><GitBranch size={13}/><span>{checkout.canonical_path}</span>{checkout.dirty ? <i/> : null}</button>{workspaceId === workspace.workspace.id && (checkoutId === checkout.id || !checkoutId) ? <HarnessTree groups={byCheckoutAndHarness.get(checkout.id)} selectedId={selectedId} onSelect={setSelectedId}/> : null}</section>)}</div> : null}</section>;
    })}</div><footer><ShieldCheck size={14}/><span>{text.projectSessions}<b>{activeWorkspace?.workspace.display_name ?? text.unassigned}</b></span></footer></aside>
    <section className="session-results-v2"><header><div className="session-search-v2"><Search size={17}/><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={text.search}/></div><div className="session-filter-v2"><button className={provider === "all" ? "active" : ""} onClick={() => setProvider("all")}>{text.all}</button>{agents.map((agent) => <button key={agent} className={provider === agent ? "active" : ""} onClick={() => setProvider(agent)}>{name(agent)}</button>)}</div><div className="session-library-actions"><button className="soft-button" type="button" onClick={() => setSourcesOpen(true)}><FolderCog size={15}/>{text.sources}</button><button className="soft-button session-mome-trigger" type="button" onClick={() => setMomeOpen(true)}><Sparkles size={15}/>{text.mome}</button></div></header><div className="session-result-list-v2">{loading ? <div className="session-loading"><LoaderCircle className="spin" size={18}/>{text.loading}</div> : hits.length ? hits.map((hit) => <button key={hit.session.id} className={hit.session.id === selectedId ? "session-list-row active" : "session-list-row"} onContextMenu={(event) => { event.preventDefault(); setSessionMenu({ x: event.clientX, y: event.clientY, hit }); }} onClick={() => { setSelectedId(hit.session.id); setMessageId(hit.message?.id ?? null); }}><span className={`provider-pill ${hit.session.provider}`}>{name(hit.session.provider)}</span><div><strong>{hit.session.title}</strong><p><HighlightedText value={hit.message?.content ?? hit.session.source_path} query={query}/></p><small>{hit.session.updated_at.slice(0, 16).replace("T", " · ")} · {hit.session.state}</small></div>{hit.message ? <span className="match-marker">m{hit.message.ordinal}<ChevronRight size={13}/></span> : null}</button>) : <div className="session-empty"><Archive size={27}/><strong>{text.empty}</strong></div>}</div></section>
    <aside className="session-reader-v2">{selected ? <>
      <header><span className={`provider-pill ${selected.session.provider}`}>{name(selected.session.provider)}</span><h2>{selected.session.title}</h2><code>{selected.session.source_path}</code></header>
      <div className="reader-actions-v2">
        {selected.session.capabilities.includes("native_resume") ? <button className="primary-button" onClick={() => void resume()}><CirclePlay size={16}/>{text.resume}</button> : <button className="soft-button" disabled>{text.noNative}</button>}
        <button className="soft-button" disabled={!selectedMessage} onClick={() => setHandoffOpen(true)}><Send size={16}/>{handoffLabel}</button>
        <button className="soft-button" disabled={!selectedMessage} onClick={() => selectedMessage && void copy(referenceText(selected.session, selectedMessage))}><Link2 size={16}/>{text.copyReference}</button>
      </div>
      <div className="reader-explanation"><ShieldCheck size={14}/><span>{referenceHint}</span></div>
      <dl><dt>Harness</dt><dd>{name(selected.session.provider)}</dd><dt>Checkout</dt><dd>{selected.session.checkout_id ?? text.unassigned}</dd><dt>{text.source}</dt><dd>{selected.session.provider_session_id}</dd></dl>
      <div className="message-toolbar"><span>{text.messages}</span><small>{messages.length}</small></div>
      <div className="message-stream-v2">{messages.length > visibleMessages.length ? <button className="earlier-messages" onClick={() => setMessageLimit((current) => current + 180)}>{text.loadEarlier}</button> : null}{visibleMessages.map((message) => { const matched = selected.message?.id === message.id; return <article key={message.id} className={`${message.id === messageId ? "selected" : ""} ${matched ? "has-search-match" : ""} ${message.role}`} onClick={() => setMessageId(message.id)} tabIndex={0} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setMessageId(message.id); } }}><header><span>{message.role}</span><small>m{message.ordinal}</small></header><p>{matched ? <HighlightedText value={message.content} query={query}/> : message.content}</p></article>; })}</div>
    </> : <div className="session-empty reader"><PanelRight size={28}/><strong>{text.empty}</strong></div>}</aside>
    {sessionMenu ? <ContextMenu x={sessionMenu.x} y={sessionMenu.y} onClose={() => setSessionMenu(null)} items={[
      { id: "open-session", label: text.openSession, icon: <PanelRight size={14}/>, onSelect: () => { setSelectedId(sessionMenu.hit.session.id); setMessageId(sessionMenu.hit.message?.id ?? null); } },
      { id: "resume-session", label: text.resume, icon: <CirclePlay size={14}/>, disabled: !sessionMenu.hit.session.capabilities.includes("native_resume"), onSelect: () => { void desktopApi.resumeSession(sessionMenu.hit.session.id).then(openTerminal).catch((reason) => onError(String(reason))); } },
      { id: "copy-source", label: text.copySource, icon: <Copy size={14}/>, onSelect: () => void copy(sessionMenu.hit.session.source_path) },
      { id: "copy-reference", label: text.copyReference, icon: <Link2 size={14}/>, disabled: !sessionMenu.hit.message, onSelect: () => { if (sessionMenu.hit.message) void copy(referenceText(sessionMenu.hit.session, sessionMenu.hit.message)); } },
    ]}/> : null}
    {handoffOpen && selected && selectedMessage ? <HandoffDialog source={selected} message={selectedMessage} locale={locale} onClose={() => setHandoffOpen(false)} onCopy={copy} onStart={startHandoff}/> : null}
    {momeOpen ? <MomeDialog text={text} workspaceId={workspaceId} checkoutId={checkoutId} providers={provider === "all" ? [] : [provider]} onClose={() => setMomeOpen(false)} onCopy={copy} onError={onError}/> : null}
    {sourcesOpen ? <SourcesDialog text={text} onClose={() => setSourcesOpen(false)} onError={onError} onToast={onToast} onRefresh={search}/> : null}
  </div>;
}

function HarnessTree({ groups, selectedId, onSelect }: { groups: Map<AgentKind, SessionSearchHit[]> | undefined; selectedId: string | null; onSelect: (id: string) => void }) {
  if (!groups?.size) return null;
  return <div className="session-harness-tree">{[...groups.entries()].map(([provider, sessions]) => <section key={provider}><strong><span className={`provider-pill ${provider}`}>{name(provider)}</span><small>{sessions.length}</small></strong>{sessions.map((hit) => <button key={hit.session.id} className={hit.session.id === selectedId ? "active" : ""} onClick={() => onSelect(hit.session.id)} title={hit.session.title}><span>{hit.session.title}</span></button>)}</section>)}</div>;
}

function HandoffDialog({ source, message, locale, onClose, onCopy, onStart }: { source: SessionSearchHit; message: Message; locale: Locale; onClose: () => void; onCopy: (value: string) => Promise<void>; onStart: (target: AgentKind, packet: string, trajectoryId?: string) => Promise<void> }) {
  const zh = locale === "zh-CN";
  const targetChoices = agents;
  const [target, setTarget] = useState<AgentKind>(source.session.provider);
  const [copied, setCopied] = useState(false);
  const [starting, setStarting] = useState(false);
  const [review, setReview] = useState<Awaited<ReturnType<typeof desktopApi.prepareHandoffTrajectory>> | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState("");
  const prepare = async () => {
    setPreparing(true); setConfirmed(false); setError(""); setReview(null);
    try { setReview(await desktopApi.prepareHandoffTrajectory(source.session.id)); }
    catch (reason) { setError(String(reason)); }
    finally { setPreparing(false); }
  };
  const copyPacket = async () => {
    await onCopy(handoffPackage(source.session, message, target));
    setCopied(true);
  };
  return <AccessibleDialog title={zh ? "交接给其他 Agent" : "Hand off to another Agent"} closeLabel={zh ? "关闭" : "Close"} onClose={onClose}>
    <div className="relay-dialog-v2">
      <p>{zh ? "在当前工作目录新建目标 Agent 会话，传递所选会话及其祖先的图谱与来源引用。不总结、不压缩、不复制原始日志；由目标 Agent 自行决定如何读取。恢复原会话请使用会话列表中的恢复按钮。" : "Create a new target session in this working directory with the selected session's ancestry graph and source references. No summaries, compression or copied transcripts. The target decides what to read. Use Resume original in the session list to continue the existing session."}</p>
      <section className="handoff-route">
        <span className={`provider-pill ${source.session.provider}`}>{name(source.session.provider)}</span><ArrowRight size={15}/>
        <label><span>{zh ? "目标 Agent" : "Target Agent"}</span><select aria-label={zh ? "目标 Agent" : "Target Agent"} value={target} onChange={(event) => { setTarget(event.target.value as AgentKind); setCopied(false); }}>{targetChoices.map((agent) => <option key={agent} value={agent}>{name(agent)}</option>)}</select></label>
      </section>
      <section className="reference-preview">
        <span className={`provider-pill ${source.session.provider}`}>{name(source.session.provider)}</span>
        <code>{referenceText(source.session, message)}</code>
        <p>{message.content}</p>
      </section>
      <section className="trajectory-review">
        <button className="soft-button" disabled={preparing || starting} onClick={() => void prepare()}>{preparing ? (zh ? "正在定位会话祖先…" : "Resolving session ancestry…") : (zh ? "预览交接图谱与引用" : "Review graph and references")}</button>
        {error ? <p role="alert">{error}</p> : null}
        {review ? <><p>{zh ? "来源节点" : "Source nodes"}: {review.source_count} · {Math.ceil(review.bytes / 1024)} KiB {zh ? "图谱文件" : "graph file"}</p>
          <details><summary>{zh ? "查看完整图谱 JSON 与文件位置" : "View complete graph JSON and location"}</summary><p style={{ overflowWrap: "anywhere" }}>{review.snapshot_path}</p><pre style={{ maxHeight: 220, overflow: "auto", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{review.preview}</pre></details>
          <label><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)}/>{zh ? "确认向目标 Agent 提供这些会话身份、关系与来源位置。缺失来源会明确标注，日志正文不会自动注入。" : "Share these session identities, relationships and source locations with the target Agent. Missing sources are explicit; transcript bodies are not injected."}</label></> : null}
      </section>
      <div className="modal-actions"><span className="handoff-status" aria-live="polite">{copied ? (zh ? "选中消息已复制。" : "Selected message copied.") : null}</span><button className="soft-button" onClick={() => void copyPacket()}><Copy size={15}/>{zh ? "复制选中消息" : "Copy selected message"}</button><button className="primary-button" disabled={starting || !review || !confirmed} onClick={() => { setStarting(true); void onStart(target, handoffPackage(source.session, message, target), review?.id).finally(() => setStarting(false)); }}><CirclePlay size={15}/>{starting ? (zh ? "正在启动…" : "Starting…") : (zh ? `新建 ${name(target)} 会话并交接` : `Create ${name(target)} session and hand off`)}</button></div>
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
  const recall = async () => {
    if (!query.trim()) return;
    setLoading(true);
    try { setResult(await desktopApi.momeRecall({ query: query.trim(), workspace_id: workspaceId, checkout_id: checkoutId, providers, max_tokens: 1200 })); }
    catch (reason) { onError(String(reason)); }
    finally { setLoading(false); }
  };
  return <AccessibleDialog title={text.momeTitle} closeLabel={text.close} onClose={onClose}>
    <div className="mome-dialog"><p className="context-dialog-hint">{text.momeHint}</p><label className="mome-query"><Search size={17}/><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void recall(); } }} placeholder={text.momePlaceholder}/></label>
      <div className="modal-actions"><button className="soft-button" type="button" onClick={onClose}>{text.close}</button><button className="primary-button" type="button" disabled={!query.trim() || loading} onClick={() => void recall()}>{loading ? <LoaderCircle className="spin" size={15}/> : <Sparkles size={15}/>} {text.momeRecall}</button></div>
      {result ? <section className="mome-result"><header><div><strong>{text.sources} · {result.sources.length}</strong><small>~{result.estimated_tokens} / {result.max_tokens} tokens</small></div>{result.semantic_status === "lexical_only_no_semantic_backend_configured" ? <span>{text.momeFallback}</span> : null}</header>{result.sources.length ? <div className="mome-sources">{result.sources.map((source) => <article key={source.content_hash}><code>{source.citation}</code><small>{name(source.provider)} · m{source.start_ordinal}–m{source.end_ordinal} · ~{source.estimated_tokens}</small><p>{source.text}</p></article>)}</div> : <p className="mome-empty">{text.momeEmpty}</p>}{result.sources.length ? <button className="primary-button" type="button" onClick={() => void onCopy(momePacket(result))}><Copy size={15}/>{text.momeCopy}</button> : null}</section> : null}
    </div>
  </AccessibleDialog>;
}
