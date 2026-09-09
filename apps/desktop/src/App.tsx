import { lazy, Suspense, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Archive, Braces, Check, ChevronDown, FolderGit2, Languages, Layers2, LoaderCircle, Maximize2, Minus, Moon, NotebookPen, PanelRight, Plus, RefreshCw, Search, Sparkles, Sun, TerminalSquare, X } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { desktopApi } from "./api";
import { FirstRunOnboarding } from "./FirstRunOnboarding";
import { useI18n } from "./i18n";
import { MobiusLogo } from "./MobiusLogo";
import type { HealthStatus, ProviderIndexReport, TerminalInfo, WorkspaceView } from "./types";
import "./mobius-shell.css";
import "./relay-graph.css";

const TerminalPage = lazy(() => import("./TerminalPage").then((module) => ({ default: module.TerminalPage })));
const WorkspaceAtlas = lazy(() => import("./WorkspaceAtlas").then((module) => ({ default: module.WorkspaceAtlas })));
const SessionLibraryV2 = lazy(() => import("./SessionLibraryV2").then((module) => ({ default: module.SessionLibraryV2 })));
const NotesLibraryV2 = lazy(() => import("./NotesLibraryV2").then((module) => ({ default: module.NotesLibraryV2 })));
const SkillsLibraryV2 = lazy(() => import("./SkillsLibraryV2").then((module) => ({ default: module.SkillsLibraryV2 })));
const BoardPage = lazy(() => import("./BoardPage").then((module) => ({ default: module.BoardPage })));
type Page = "workbench" | "sessions" | "notes" | "skills";
type Theme = "light" | "dark";

function language(locale: "zh-CN" | "en") {
  const zh = locale === "zh-CN";
  return {
    workbench: zh ? "工作台" : "Workbench", sessions: zh ? "会话" : "Sessions", notes: zh ? "资料" : "Library", canvas: zh ? "画布" : "Canvas", documents: zh ? "资料库" : "Documents", skills: zh ? "技能" : "Skills",
    search: zh ? "搜索会话、资料和设置" : "Search sessions, library and settings", scan: zh ? "扫描会话" : "Scan sessions",
    scanning: zh ? "正在扫描已发现的本地来源…" : "Scanning discovered local sources…", scanDone: (indexed: number, unchanged: number) => zh ? `扫描完成：已索引 ${indexed}，未变化 ${unchanged}` : `Scan complete: ${indexed} indexed, ${unchanged} unchanged`,
    focus: zh ? "专注" : "Focus", exitFocus: zh ? "退出专注" : "Exit focus", showWorkspaces: zh ? "工作区" : "Workspaces",
    desktop: zh ? "本地优先" : "Local-first", browser: zh ? "浏览器预览" : "Browser preview", indexing: zh ? "正在建立本地会话索引…" : "Indexing local sessions…", loading: zh ? "正在加载…" : "Loading…"
  };
}

export function App() {
  const { locale, setLocale } = useI18n();
  const text = language(locale);
  const [page, setPage] = useState<Page>("workbench");
  const [workbenchPanel, setWorkbenchPanel] = useState<"workspaces" | "terminal">("workspaces");
  const [libraryMode, setLibraryMode] = useState<"documents" | "canvas">("documents");
  // The Library is the only catalog for documents *and* boards.  This value
  // is deliberately navigation state rather than a separate canvas-library
  // overlay, so a board can always be reached from the same left-hand list as
  // a note or mounted document.
  const [requestedBoardId, setRequestedBoardId] = useState<string | undefined>();
  // The control room opens in its night-drive state by default. A deliberate
  // "light" choice is preserved, but first launch should match the product's
  // local-terminal purpose rather than flash a bright canvas before theme state
  // has hydrated.
  const [theme, setTheme] = useState<Theme>(() => localStorage.getItem("mobius.theme") === "light" ? "light" : "dark");
  const [workspaces, setWorkspaces] = useState<WorkspaceView[]>([]);
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [requestedTerminal, setRequestedTerminal] = useState<TerminalInfo | null>(null);
  const [terminalCount, setTerminalCount] = useState(0);
  const [toast, setToast] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [indexing, setIndexing] = useState(false);
  const [terminalFocus, setTerminalFocus] = useState(false);
  const [sessionRevision, setSessionRevision] = useState(0);
  const [onboarding, setOnboarding] = useState(() => localStorage.getItem("mobius.onboarding.complete") !== "1");

  const reload = useCallback(async () => {
    try { const [next, status, indexStatus, liveTerminals] = await Promise.all([desktopApi.listWorkspaces(), desktopApi.health(), desktopApi.sessionIndexStatus(), desktopApi.listTerminals()]); setWorkspaces(next); setHealth(status); setIndexing(indexStatus.running); setTerminalCount(liveTerminals.length); }
    catch (reason) { setError(String(reason)); }
  }, []);
  useEffect(() => {
    // A full-shell palette flip otherwise starts hundreds of independent CSS
    // transitions. Freeze them for a frame so the mode switch remains crisp.
    const root = document.documentElement;
    root.classList.add("mobius-theme-switching");
    root.dataset.theme = theme;
    localStorage.setItem("mobius.theme", theme);
    void root.offsetWidth;
    const frame = window.requestAnimationFrame(() => root.classList.remove("mobius-theme-switching"));
    return () => window.cancelAnimationFrame(frame);
  }, [theme]);
  useEffect(() => { void reload(); }, [reload]);
  useEffect(() => { if (!toast) return; const timer = window.setTimeout(() => setToast(null), 3600); return () => window.clearTimeout(timer); }, [toast]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape" && terminalFocus) { event.preventDefault(); setTerminalFocus(false); return; }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k" && !(event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement)) { event.preventDefault(); setPage("sessions"); }
    };
    // xterm handles Escape itself. Capture it before the terminal consumes the
    // event so focus mode can always be exited without leaving a stuck overlay.
    window.addEventListener("keydown", key, true); return () => window.removeEventListener("keydown", key, true);
  }, [terminalFocus]);
  useEffect(() => {
    const navigate = (event: Event) => { if ((event as CustomEvent<string>).detail === "sessions") setPage("sessions"); };
    window.addEventListener("mobius:navigate", navigate); return () => window.removeEventListener("mobius:navigate", navigate);
  }, []);
  useEffect(() => {
    let disposed = false; let unlisten: (() => void) | undefined;
    void desktopApi.onSessionRefreshComplete(() => { if (!disposed) { setSessionRevision((value) => value + 1); void reload(); } }).then((next) => { if (disposed) next(); else unlisten = next; }).catch((reason) => { if (!disposed) setError(String(reason)); });
    return () => { disposed = true; unlisten?.(); };
  }, [reload]);

  const openTerminal = useCallback((terminal: TerminalInfo) => { setRequestedTerminal(terminal); setTerminalCount((count) => Math.max(count, 1)); setTerminalFocus(false); setWorkbenchPanel("terminal"); setPage("workbench"); }, []);
  const createFreeTerminal = useCallback(async () => {
    try {
      // Registration may have completed while the rendered workspace list is
      // still stale. Resolve the current selection from the backend at click time.
      const current = await desktopApi.listWorkspaces();
      const selectedId = localStorage.getItem("mobius.workspace.current");
      const selected = current.find((workspace) => workspace.workspace.id === selectedId) ?? current[0];
      const suggested = selected?.checkouts[0]?.canonical_path ?? await desktopApi.pickDirectory("E:\\Workspaces");
      if (!suggested) return;
      openTerminal(await desktopApi.createTerminal(suggested, "PowerShell"));
    } catch (reason) { setError(String(reason)); }
  }, [openTerminal, workspaces]);
  const windowAction = useCallback(async (action: "minimize" | "maximize" | "close") => {
    if (desktopApi.runtime !== "desktop") return;
    try {
      const window = getCurrentWindow();
      if (action === "minimize") await window.minimize();
      else if (action === "maximize") await window.toggleMaximize();
      else await window.close();
    } catch (reason) {
      setError(String(reason));
    }
  }, []);
  const refresh = async () => { setScanning(true); setIndexing(true); try { const report: ProviderIndexReport = await desktopApi.refreshSessions(); setToast(text.scanDone(report.indexed, report.unchanged)); await reload(); } catch (reason) { setError(String(reason)); await reload(); } finally { setScanning(false); } };
  const nav = useMemo<Array<{ id: Exclude<Page, "skills">; icon: ReactNode; label: string }>>(() => [
    { id: "workbench", icon: <TerminalSquare/>, label: text.workbench }, { id: "sessions", icon: <Archive/>, label: text.sessions }, { id: "notes", icon: <NotebookPen/>, label: text.notes }
  ], [text.notes, text.sessions, text.workbench]);
  const title = page === "notes" ? text.notes : nav.find((item) => item.id === page)?.label ?? text.skills;

  return <div className={`mobius-app ${terminalFocus ? "terminal-focus" : ""}`}>
    <header className="mobius-topbar" data-tauri-drag-region><div className="mobius-brand" data-tauri-drag-region><MobiusLogo size={30}/><strong>MÖBIUS</strong><span>LOCAL AGENT WORKSPACE</span></div><button className="global-search" type="button" onClick={() => setPage("sessions")}><Search size={17}/><span>{text.search}</span><kbd>Ctrl K</kbd></button><div className="topbar-actions"><button className="top-icon" type="button" onClick={() => setPage("skills")} aria-label="Manage skills" title={text.skills}><Braces size={17}/></button><button className="top-icon" type="button" onClick={() => setOnboarding(true)} aria-label="Open Möbius guide"><Sparkles size={17}/></button><button className="top-icon" type="button" onClick={() => setLocale(locale === "zh-CN" ? "en" : "zh-CN")} aria-label="Switch language"><Languages size={17}/><span>{locale === "zh-CN" ? "EN" : "中文"}</span></button><button className="top-icon" type="button" onClick={() => setTheme(theme === "light" ? "dark" : "light")} aria-label="Switch theme">{theme === "light" ? <Moon size={17}/> : <Sun size={17}/>}</button><span className="window-controls"><button type="button" onClick={() => void windowAction("minimize")} aria-label="Minimize"><Minus size={15}/></button><button type="button" onClick={() => void windowAction("maximize")} aria-label="Maximize"><Maximize2 size={14}/></button><button className="window-close" type="button" onClick={() => void windowAction("close")} aria-label="Close"><X size={15}/></button></span></div></header>
    <aside className="mobius-rail" aria-label="Möbius navigation">{nav.map((item) => <button key={item.id} className={page === item.id ? "rail-item active" : "rail-item"} type="button" onClick={() => { setTerminalFocus(false); if (item.id === "notes") { setRequestedBoardId(undefined); setLibraryMode("documents"); } setPage(item.id); }} title={item.label}>{item.icon}<span>{item.label}</span></button>)}<div className="rail-bottom"><i/><small>{desktopApi.runtime === "desktop" ? text.desktop : text.browser}</small></div></aside>
    <main className="mobius-main"><header className="pagebar"><div><span>{page === "workbench" ? workbenchPanel === "terminal" ? "LOCAL / POWERSHELL" : "LOCAL / WORKSPACES" : page === "notes" ? "LOCAL LIBRARY" : "MÖBIUS / LOCAL-FIRST"}</span><h1>{title}</h1></div>{page === "workbench" ? <div className="pagebar-actions">{workbenchPanel === "terminal" ? <><button className="soft-button" type="button" onClick={() => { setTerminalFocus(false); setWorkbenchPanel("workspaces"); }}><FolderGit2 size={16}/>{text.showWorkspaces}</button><button className="soft-button" type="button" onClick={() => setTerminalFocus((value) => !value)}>{terminalFocus ? <ChevronDown size={16}/> : <PanelRight size={16}/>} {terminalFocus ? text.exitFocus : text.focus}</button></> : <><button className="soft-button" type="button" onClick={() => setWorkbenchPanel("terminal")}><TerminalSquare size={16}/>{locale === "zh-CN" ? `终端 ${terminalCount}` : `Terminals ${terminalCount}`}</button><button className="primary-button" type="button" onClick={() => void createFreeTerminal()}><Plus size={16}/>{locale === "zh-CN" ? "新建 PowerShell" : "New PowerShell"}</button></>}</div> : page === "sessions" ? <button className="primary-button" type="button" onClick={() => void refresh()} disabled={scanning}>{scanning ? <LoaderCircle className="spin" size={16}/> : <RefreshCw size={16}/>} {text.scan}</button> : page === "skills" ? <button className="soft-button" type="button" onClick={() => setPage("workbench")}><TerminalSquare size={16}/>{text.workbench}</button> : null}</header><section className="mobius-page-host">
      {page === "workbench" && workbenchPanel === "workspaces" ? <Suspense fallback={<Loading label={text.loading}/>}><WorkspaceAtlas workspaces={workspaces} reload={reload} openTerminal={openTerminal} onError={setError} onToast={setToast} locale={locale} onOpenSessions={(focus) => { sessionStorage.setItem("mobius.session.focus", JSON.stringify(focus)); setPage("sessions"); }}/></Suspense> : null}
      {page === "workbench" && workbenchPanel === "terminal" ? <div className="mobius-terminal"><Suspense fallback={<Loading label={text.loading}/> }><TerminalPage workspaces={workspaces} requestedTerminal={requestedTerminal} onConsumed={() => setRequestedTerminal(null)} onError={setError} focusMode={terminalFocus} onExitFocus={() => setTerminalFocus(false)}/></Suspense></div> : null}
      {page === "sessions" ? <Suspense fallback={<Loading label={text.loading}/>}><SessionLibraryV2 revision={sessionRevision} workspaces={workspaces} health={health} openTerminal={openTerminal} onError={setError} onToast={setToast} locale={locale} focus={null} onFocusConsumed={() => undefined}/></Suspense> : null}
      {page === "notes" && libraryMode === "documents" ? <Suspense fallback={<Loading label={text.loading}/>}><NotesLibraryV2 onError={setError} onToast={setToast} locale={locale} onOpenCanvas={(boardId) => { setRequestedBoardId(boardId); setLibraryMode("canvas"); }}/></Suspense> : null}
      {page === "notes" && libraryMode === "canvas" ? <Suspense fallback={<Loading label={text.loading}/>}><BoardPage onToast={setToast} initialBoardId={requestedBoardId} onBackToLibrary={() => { setRequestedBoardId(undefined); setLibraryMode("documents"); }}/></Suspense> : null}
      {page === "skills" ? <Suspense fallback={<Loading label={text.loading}/>}><SkillsLibraryV2 workspaces={workspaces} onError={setError} onToast={setToast} locale={locale}/></Suspense> : null}
    </section></main>
    {onboarding ? <FirstRunOnboarding onClose={() => setOnboarding(false)} onNavigate={(target) => setPage(target === "workspaces" ? "workbench" : target)} onError={setError}/> : null}
    {indexing ? <div className="indexing-status" role="status" aria-live="polite"><LoaderCircle className="spin" size={14}/>{text.indexing}</div> : null}
    {scanning ? <div className="scan-status"><LoaderCircle className="spin" size={15}/>{text.scanning}</div> : null}
    {toast ? <div className="mobius-notice success" role="status"><Check size={16}/>{toast}<button type="button" onClick={() => setToast(null)} aria-label="Dismiss"><X size={15}/></button></div> : null}
    {error ? <div className="mobius-notice error" role="alert"><span>{error}</span><button type="button" onClick={() => setError(null)} aria-label="Dismiss"><X size={15}/></button></div> : null}
  </div>;
}

function Loading({ label }: { label: string }) { return <div className="mobius-empty"><LoaderCircle className="spin"/><p>{label}</p></div>; }
