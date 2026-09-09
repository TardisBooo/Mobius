import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { listen } from "@tauri-apps/api/event";
import { AtSign, Minimize2, Plus, TerminalSquare, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { desktopApi } from "./api";
import { useI18n } from "./i18n";
import { SessionReferencePicker } from "./SessionReferencePicker";
import type { TerminalInfo, TerminalOutput, WorkspaceView } from "./types";

function shellQuotePath(path: string) { return `'${path.replace(/'/g, "''")}'`; }

function droppedPaths(dataTransfer: DataTransfer) {
  const paths = Array.from(dataTransfer.files).map((file) => (file as File & { path?: string }).path).filter((path): path is string => Boolean(path));
  if (paths.length) return paths;
  const raw = dataTransfer.getData("text/uri-list") || dataTransfer.getData("text/plain");
  return raw.split(/\r?\n/).map((value) => value.trim()).filter(Boolean).map((value) => {
    if (/^file:\/\//i.test(value)) { try { return decodeURIComponent(value.replace(/^file:\/\//i, "").replace(/^\/+/, "")); } catch { return value.replace(/^file:\/\//i, ""); } }
    return value;
  });
}

export function TerminalPage({ workspaces, requestedTerminal, onConsumed, onError, focusMode = false, onExitFocus }: {
  workspaces: WorkspaceView[];
  requestedTerminal: TerminalInfo | null;
  onConsumed: () => void;
  onError: (message: string) => void;
  focusMode?: boolean;
  onExitFocus?: () => void;
}) {
  const { t } = useI18n();
  const [terminals, setTerminals] = useState<TerminalInfo[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [referenceOpen, setReferenceOpen] = useState(false);
  const host = useRef<HTMLDivElement>(null);
  const activeRef = useRef<string | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const snapshotLoading = useRef<string | null>(null);
  const queuedOutput = useRef<Record<string, TerminalOutput[]>>({});
  const lastSequence = useRef<Record<string, number>>({});
  const pasteIntoTerminal = useCallback(async (terminalId: string | null) => {
    if (!terminalId) return;
    try {
      const text = await navigator.clipboard.readText();
      if (text) await desktopApi.writeTerminal(terminalId, text);
    } catch (error) { onError(String(error)); }
  }, [onError]);

  useEffect(() => {
    void desktopApi.listTerminals().then((items) => {
      setTerminals(items);
      setActiveId((id) => id ?? items[0]?.id ?? null);
    }).catch((error) => onError(String(error)));
  }, [onError]);

  useEffect(() => {
    if (!requestedTerminal) return;
    setTerminals((items) => items.some((item) => item.id === requestedTerminal.id) ? items : [...items, requestedTerminal]);
    setActiveId(requestedTerminal.id);
    onConsumed();
  }, [requestedTerminal, onConsumed]);

  useEffect(() => {
    // Browser preview deliberately has no Tauri event bridge. Keep the preview
    // inert rather than attempting a synthetic terminal or logging a bridge error.
    if (desktopApi.runtime !== "desktop") return;
    let disposed = false;
    const unlisten = listen<TerminalOutput>("terminal-output", ({ payload }) => {
      if (disposed || activeRef.current !== payload.terminal_id) return;
      if (snapshotLoading.current === payload.terminal_id) {
        (queuedOutput.current[payload.terminal_id] ??= []).push(payload);
        return;
      }
      if (payload.sequence <= (lastSequence.current[payload.terminal_id] ?? 0)) return;
      lastSequence.current[payload.terminal_id] = payload.sequence;
      terminalRef.current?.write(payload.data);
    });
    return () => {
      disposed = true;
      void unlisten.then((stop) => stop());
    };
  }, []);

  useEffect(() => {
    if (!host.current || !activeId) return;
    let disposed = false;
    let resizeFrame = 0;
    host.current.replaceChildren();
    const terminalTheme = () => document.documentElement.dataset.theme === "light"
      ? { background: "#f4f2ec", foreground: "#202a34", cursor: "#2e6483", selectionBackground: "#b8dcea88" }
      : { background: "#0b0e12", foreground: "#d9e2ee", cursor: "#7eb8e8", selectionBackground: "#36587588" };
    const terminal = new Terminal({
      cursorBlink: true,
      cursorStyle: "bar",
      cursorWidth: 2,
      convertEol: false,
      fontFamily: '"Cascadia Mono", "JetBrains Mono", Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.25,
      theme: terminalTheme(),
      scrollback: 8000
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host.current);
    const themeObserver = new MutationObserver(() => { terminal.options.theme = terminalTheme(); });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    terminalRef.current = terminal;
    activeRef.current = activeId;
    snapshotLoading.current = activeId;
    queuedOutput.current[activeId] = [];

    const resize = () => {
      cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(() => {
        if (disposed) return;
        const dimensions = fit.proposeDimensions();
        if (!dimensions || (terminal.rows === dimensions.rows && terminal.cols === dimensions.cols)) return;
        terminal.resize(dimensions.cols, dimensions.rows);
        void desktopApi.resizeTerminal(activeId, dimensions.rows, dimensions.cols).catch((error) => onError(String(error)));
      });
    };
    resize();
    terminal.focus();

    void desktopApi.terminalSnapshot(activeId).then((snapshot) => {
      if (disposed || activeRef.current !== activeId) return;
      terminal.write(snapshot.data);
      lastSequence.current[activeId] = snapshot.sequence;
      const pending = (queuedOutput.current[activeId] ?? [])
        .filter((output) => output.sequence > snapshot.sequence)
        .sort((left, right) => left.sequence - right.sequence);
      for (const output of pending) {
        terminal.write(output.data);
        lastSequence.current[activeId] = output.sequence;
      }
      queuedOutput.current[activeId] = [];
      snapshotLoading.current = null;
      terminal.focus();
    }).catch((error) => {
      snapshotLoading.current = null;
      onError(String(error));
    });

    const input = terminal.onData((data) => {
      void desktopApi.writeTerminal(activeId, data).catch((error) => onError(String(error)));
    });
    // xterm's browser paste handling is inconsistent in desktop WebViews.
    // Route Ctrl/Cmd+V through the system clipboard explicitly.
    terminal.attachCustomKeyEventHandler((event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === "v") {
        event.preventDefault();
        void pasteIntoTerminal(activeId);
        return false;
      }
      return true;
    });
    const observer = new ResizeObserver(resize);
    observer.observe(host.current);
    return () => {
      disposed = true;
      cancelAnimationFrame(resizeFrame);
      observer.disconnect();
      themeObserver.disconnect();
      input.dispose();
      if (activeRef.current === activeId) activeRef.current = null;
      terminalRef.current = null;
      terminal.dispose();
    };
  }, [activeId, onError, pasteIntoTerminal]);

  const create = async () => {
    const checkout = workspaces.flatMap((workspace) => workspace.checkouts)[0];
    try {
      const cwd = await desktopApi.pickDirectory(checkout?.canonical_path ?? "E:\\Workspaces");
      if (!cwd) return;
      const terminal = await desktopApi.createTerminal(cwd, checkout?.branch ? `PowerShell · ${checkout.branch}` : "PowerShell");
      setTerminals((items) => [...items, terminal]);
      setActiveId(terminal.id);
    } catch (error) { onError(String(error)); }
  };

  const close = async (id: string) => {
    try { await desktopApi.closeTerminal(id); } catch { /* The shell may already have exited. */ }
    setTerminals((items) => {
      const next = items.filter((item) => item.id !== id);
      setActiveId((current) => current === id ? next[0]?.id ?? null : current);
      return next;
    });
    delete lastSequence.current[id];
    delete queuedOutput.current[id];
  };

  return <section className="terminal-page page-fill">
    <div className="terminal-tabs" role="tablist">
      {terminals.map((terminal) => <div key={terminal.id} className={activeId === terminal.id ? "terminal-tab active" : "terminal-tab"} role="tab" aria-selected={activeId === terminal.id}>
        <button className="terminal-tab-select" type="button" onClick={() => setActiveId(terminal.id)}><TerminalSquare size={15}/><span>{terminal.title}</span><i className={terminal.state}/></button>
        <button className="terminal-tab-close" type="button" aria-label={`Close terminal ${terminal.title}`} onClick={() => void close(terminal.id)}><X size={13}/></button>
      </div>)}
      <button className="icon-button" onClick={() => void create()} title={t("New PowerShell")}><Plus size={17}/></button>
      <button className="terminal-context-action" type="button" onClick={() => setReferenceOpen(true)} title="Copy an explicit session reference"><AtSign size={16}/>{t("Context")}</button>
      {focusMode ? <button className="terminal-exit-focus" type="button" onClick={onExitFocus}><Minimize2 size={15}/>Exit focus · Esc</button> : null}
    </div>
    {activeId ? <div className="terminal-stage" ref={host} onContextMenu={(event) => { event.preventDefault(); void pasteIntoTerminal(activeId); }} onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; }} onDrop={(event) => { event.preventDefault(); const paths = droppedPaths(event.dataTransfer); if (paths.length) { void desktopApi.writeTerminal(activeId, paths.map(shellQuotePath).join(" ")).catch((error) => onError(String(error))); terminalRef.current?.focus(); } }}/>: <div className="empty-state"><TerminalSquare size={38}/><strong>{t("No terminal")}</strong><button className="primary-button" onClick={() => void create()}><Plus size={16}/>{t("New PowerShell")}</button></div>}
    {referenceOpen ? <SessionReferencePicker onClose={() => setReferenceOpen(false)} onError={onError}/> : null}
  </section>;
}
