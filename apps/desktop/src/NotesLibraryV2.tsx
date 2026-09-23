import { type ComponentPropsWithoutRef, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { ChevronDown, ChevronRight, ChevronsDown, ChevronsUp, CirclePause, Code2, Eye, FileText, Folder, FolderOpen, FolderPlus, Layers2, LoaderCircle, PanelRight, Plus, RefreshCw, Save, Search, Trash2, Undo2, X } from "lucide-react";
import { AccessibleDialog } from "./AccessibleDialog";
import { desktopApi } from "./api";
import { ContextMenu } from "./ContextMenu";
import { NoteSourceEditor } from "./NoteSourceEditor";
import type { BoardDocument, MountInfo, MountScanStatus, NoteFileInfo, NoteLibrarySnapshot, TrashItem } from "./types";
import "./library-tree.css";

type Locale = "zh-CN" | "en";
type ReadingMode = "source" | "preview" | "split";
const mediaKind = (path: string): "pdf" | "image" | null => /\.pdf$/i.test(path) ? "pdf" : /\.(png|jpe?g|gif|webp|avif)$/i.test(path) ? "image" : null;
const mediaMime = (path: string): string => ({ pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif" } as Record<string, string>)[path.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";
type FileTreeNode = { name: string; path: string; children: FileTreeNode[]; files: NoteFileInfo[] };
type NoteTab = { id: string; file: NoteFileInfo | null; title: string };
type TabMenuState = { tab: NoteTab; x: number; y: number } | null;
type LibraryMenuState = {
  x: number;
  y: number;
  target: { type: "folder" | "note"; file?: NoteFileInfo; path: string; label: string } | { type: "board"; board: BoardDocument } | { type: "mount"; mount: MountInfo } | { type: "trash"; item: TrashItem };
} | null;
const DRAFT_TAB_ID = "note:draft";
type TreeCommand = { revision: number; open: boolean };
type LibraryProjection = NoteLibrarySnapshot & { boards: BoardDocument[]; trash: TrashItem[] };
const EMPTY_LIBRARY_PROJECTION: LibraryProjection = {
  snapshot_id: "initial-library",
  scanned_at: "",
  mounts: [],
  files: [],
  mount_statuses: [],
  boards: [],
  trash: [],
};
const EMPTY_NOTE_FILES: NoteFileInfo[] = [];

function readOpenState(key: string, fallback: boolean) {
  const value = localStorage.getItem(key);
  return value === null ? fallback : value === "1";
}

function isRemovedSourceError(reason: unknown) {
  // The native OS message differs by locale, while the error code is stable
  // enough to recognize the ordinary "file disappeared between scan and read"
  // race. This is a refresh condition for read-only sources, not a product
  // failure worthy of an alarming toast.
  return /os error 2|no such file|cannot find (?:the )?file|找不到指定的文件/i.test(String(reason));
}

function useTreeOpen(key: string, fallback: boolean, command?: TreeCommand) {
  const [open, setOpen] = useState(() => readOpenState(key, fallback));
  useEffect(() => { localStorage.setItem(key, open ? "1" : "0"); }, [key, open]);
  useEffect(() => { if (command) setOpen(command.open); }, [command?.open, command?.revision]);
  return [open, setOpen] as const;
}

function noteTree(files: NoteFileInfo[], rootLabel?: string): FileTreeNode {
  // The mount header is already the virtual root. Strip every repeated root
  // segment so a mount such as `Reference/Reference/file.md` is not rendered
  // as a duplicate folder in the tree.
  const normalizedRoot = rootLabel?.replace(/\\/g, "/").split("/").filter(Boolean).at(-1)?.toLocaleLowerCase();
  const root: FileTreeNode = { name: "", path: "", children: [], files: [] };
  for (const file of files) {
    const parts = file.virtual_path.replace(/\\/g, "/").split("/").filter(Boolean);
    while (normalizedRoot && parts[0]?.toLocaleLowerCase() === normalizedRoot) parts.shift();
    parts.pop();
    let cursor = root;
    for (const part of parts) {
      let child = cursor.children.find((candidate) => candidate.name === part);
      if (!child) {
        child = { name: part, path: cursor.path ? `${cursor.path}/${part}` : part, children: [], files: [] };
        cursor.children.push(child);
      }
      cursor = child;
    }
    cursor.files.push(file);
  }
  const sort = (node: FileTreeNode) => {
    node.children.sort((left, right) => left.name.localeCompare(right.name));
    node.files.sort((left, right) => left.title.localeCompare(right.title));
    node.children.forEach(sort);
  };
  sort(root);
  return root;
}

const TreeBranch = memo(function TreeBranch({ node, selectedId, onSelect, onContextMenu, onMoveNote, scope, command, depth = 0 }: { node: FileTreeNode; selectedId?: string; onSelect: (file: NoteFileInfo) => void; onContextMenu?: (event: React.MouseEvent, target: { type: "folder" | "note"; file?: NoteFileInfo; path: string; label: string }) => void; onMoveNote?: (sourcePath: string, destinationPath: string) => void; scope: string; command: TreeCommand; depth?: number }) {
  const [storedOpen, setStoredOpen] = useTreeOpen(`mobius.library.tree.folder.${scope}.${node.path || "root"}`, true, command);
  // The synthetic root has no visible disclosure control. It must therefore
  // remain a transparent container: collapsing it would hide descendants with
  // no way for a person to open them again through the mounted-folder header.
  const open = node.name ? storedOpen : true;
  const [dropActive, setDropActive] = useState(false);
  const dragDepth = useRef(0);
  const dragOpenTimer = useRef<number | null>(null);
  const destinationPath = node.path;
  const handleDrop = (event: React.DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    dragDepth.current = 0;
    setDropActive(false);
    const sourcePath = event.dataTransfer.getData("application/x-mobius-note");
    if (sourcePath && !sourcePath.startsWith("mount:")) onMoveNote?.(sourcePath, destinationPath);
  };
  return <div className={`${eventTargetClass(destinationPath)} ${dropActive ? "drop-target" : ""}`} onDragEnter={(event) => { if (!event.dataTransfer.types.includes("application/x-mobius-note")) return; dragDepth.current += 1; setDropActive(true); if (!open && (node.children.length || node.files.length)) { dragOpenTimer.current = window.setTimeout(() => setStoredOpen(true), 650); } }} onDragLeave={(event) => { if (!event.dataTransfer.types.includes("application/x-mobius-note")) return; dragDepth.current = Math.max(0, dragDepth.current - 1); if (dragDepth.current === 0) setDropActive(false); if (dragOpenTimer.current !== null) { window.clearTimeout(dragOpenTimer.current); dragOpenTimer.current = null; } }} onDragOver={(event) => { if (event.dataTransfer.types.includes("application/x-mobius-note")) { event.preventDefault(); event.dataTransfer.dropEffect = "move"; } }} onDrop={handleDrop}>
    {node.name ? <button className="library-tree-folder" type="button" style={{ paddingInlineStart: 8 + depth * 14 }} onClick={() => setStoredOpen((value) => !value)} onContextMenu={(event) => { event.preventDefault(); onContextMenu?.(event, { type: "folder", path: node.path, label: node.name }); }} aria-expanded={open}>{open ? <ChevronDown size={14}/> : <ChevronRight size={14}/>}<Folder size={15}/><span>{node.name}</span><small>{node.children.length + node.files.length}</small></button> : null}
    {open ? <div>{node.children.map((child) => <TreeBranch key={child.path} node={child} selectedId={selectedId} onSelect={onSelect} onContextMenu={onContextMenu} onMoveNote={onMoveNote} scope={scope} command={command} depth={depth + (node.name ? 1 : 0)}/>)}{node.files.map((file) => <button key={file.id} draggable={!file.read_only && !file.mount_id} className={selectedId === file.id ? "library-tree-file active" : "library-tree-file"} type="button" style={{ paddingInlineStart: 27 + (depth + (node.name ? 1 : 0)) * 14 }} onClick={() => onSelect(file)} onContextMenu={(event) => { event.preventDefault(); onContextMenu?.(event, { type: "note", file, path: file.real_path, label: file.title }); }} onDragStart={(event) => { if (file.read_only || file.mount_id) { event.preventDefault(); return; } event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("application/x-mobius-note", file.real_path); }} title={file.virtual_path}><FileText size={14}/><span>{file.title}</span>{file.read_only ? <CirclePause size={12}/> : null}</button>)}</div> : null}
  </div>;
});

function eventTargetClass(path: string) {
  return path ? "library-tree-node" : "library-tree-node library-tree-root-drop";
}

function samePath(left: string, right: string) {
  const normalize = (value: string) => value.replace(/\\/g, "/").replace(/^\/\/\?\//, "").replace(/\/+$/, "").toLocaleLowerCase();
  return normalize(left) === normalize(right);
}

// `snapshot_id` is a fresh UUID on every scan, so it cannot prove "nothing
// changed". Compare the projection content instead: an identical fingerprint
// means the 5-second background tick may skip the state swap entirely.
function libraryFingerprint(snapshot: NoteLibrarySnapshot, boards: BoardDocument[], trash: TrashItem[]): string {
  const part = (values: string[]) => [...values].sort().join("\u0002");
  return [
    part(snapshot.mounts.map((mount) => `${mount.id}\u0001${mount.state}\u0001${mount.virtual_path}\u0001${mount.real_path}`)),
    part(snapshot.mount_statuses.map((status) => `${status.mount_id}\u0001${status.state}\u0001${status.file_count}`)),
    part(snapshot.files.map((file) => `${file.id}\u0001${file.title}\u0001${file.virtual_path}\u0001${file.read_only ? 1 : 0}`)),
    part(boards.map((board) => `${board.id}\u0001${board.title}`)),
    part(trash.map((item) => item.id)),
  ].join("\u0003");
}

function sameFileMeta(left: NoteFileInfo, right: NoteFileInfo) {
  return left.id === right.id && left.title === right.title && left.virtual_path === right.virtual_path && left.read_only === right.read_only && samePath(left.real_path, right.real_path);
}

function boardParentId(board: BoardDocument) {
  return ((board.data.scene as { parentId?: string | null } | undefined)?.parentId ?? null);
}

function TreeSection({ icon, title, count, action, children, command, defaultOpen = true }: { icon: React.ReactNode; title: string; count: number; action?: React.ReactNode; children: React.ReactNode; command: TreeCommand; defaultOpen?: boolean }) {
  const [open, setOpen] = useTreeOpen(`mobius.library.tree.section.${title}`, defaultOpen, command);
  return <section className="library-tree-section"><header><button type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open}>{open ? <ChevronDown size={14}/> : <ChevronRight size={14}/>} {icon}<strong>{title}</strong><small>{count}</small></button>{action}</header>{open ? <div className="library-tree-children">{children}</div> : null}</section>;
}

function BoardBranch({ board, boards, depth, onOpen, onContextMenu, command }: { board: BoardDocument; boards: BoardDocument[]; depth: number; onOpen: (id: string) => void; onContextMenu?: (event: React.MouseEvent, board: BoardDocument) => void; command: TreeCommand }) {
  const children = boards.filter((candidate) => ((candidate.data.scene as { parentId?: string | null } | undefined)?.parentId ?? null) === board.id);
  const [open, setOpen] = useTreeOpen(`mobius.library.tree.board.${board.id}`, true, command);
  return <div className="library-board-branch">
    <div className="library-board-row" style={{ paddingInlineStart: 8 + depth * 14 }}>
      {children.length ? <button className="library-tree-toggle" type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open} aria-label={`${open ? "Collapse" : "Expand"} ${board.title}`}>{open ? <ChevronDown size={14}/> : <ChevronRight size={14}/>}</button> : <span className="library-tree-spacer"/>}
      <button className="library-tree-file" type="button" onClick={() => onOpen(board.id)} onContextMenu={(event) => { event.preventDefault(); onContextMenu?.(event, board); }} title={new Date(board.updated_at).toLocaleString()}><Layers2 size={14}/><span>{board.title}</span></button>
    </div>
    {open ? children.map((child) => <BoardBranch key={child.id} board={child} boards={boards} depth={depth + 1} onOpen={onOpen} onContextMenu={onContextMenu} command={command}/>) : null}
  </div>;
}

function MountBranch({ mountInfo, status, files, selectedId, locale, onSelect, onUnmount, onContextMenu, onMountContextMenu, command }: { mountInfo: MountInfo; status?: MountScanStatus; files: NoteFileInfo[]; selectedId?: string; locale: Locale; onSelect: (file: NoteFileInfo) => void; onUnmount: () => void; onContextMenu?: (event: React.MouseEvent, target: { type: "folder" | "note"; file?: NoteFileInfo; path: string; label: string }) => void; onMountContextMenu?: (event: React.MouseEvent, mount: MountInfo) => void; command: TreeCommand }) {
  const [open, setOpen] = useTreeOpen(`mobius.library.tree.mount.${mountInfo.id}`, true, command);
  const itemCount = files.length;
  const sourceUnavailable = status?.state === "unavailable";
  const sourcePartial = status?.state === "partial";
  const scanLabel = sourceUnavailable
    ? (locale === "zh-CN" ? "来源不可用" : "Source unavailable")
    : sourcePartial
      ? (locale === "zh-CN" ? "扫描不完整" : "Partial scan")
      : `${itemCount}`;
  return <section className="library-mount-branch">
    <header className="library-mount-head">
      <button className="library-mount-toggle" type="button" onClick={() => setOpen((value) => !value)} onContextMenu={(event) => { event.preventDefault(); onMountContextMenu?.(event, mountInfo); }} aria-expanded={open} aria-label={`${open ? (locale === "zh-CN" ? "折叠" : "Collapse") : (locale === "zh-CN" ? "展开" : "Expand")} ${mountInfo.virtual_path}`}>{open ? <ChevronDown size={14}/> : <ChevronRight size={14}/>}<FolderOpen size={14}/><span title={mountInfo.real_path}>{mountInfo.virtual_path}</span><small className={sourceUnavailable ? "unavailable" : sourcePartial ? "partial" : ""} title={scanLabel}>{scanLabel}</small></button>
      <button className="icon-soft" type="button" onClick={onUnmount} title={locale === "zh-CN" ? "取消挂载" : "Unmount"}><X size={12}/></button>
    </header>
    {open ? sourceUnavailable ? <p className="library-mount-state">{scanLabel}</p> : <TreeBranch node={noteTree(files, mountInfo.virtual_path)} selectedId={selectedId} onSelect={onSelect} onContextMenu={onContextMenu} scope={`mount.${mountInfo.id}`} command={command}/> : null}
  </section>;
}

function editableNoteBody(raw: string, title: string) {
  const withoutFrontMatter = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n*/, "");
  const heading = new RegExp(`^\\s*#\\s+${title.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\s*(?:\\r?\\n|$)`, "i");
  return withoutFrontMatter.replace(heading, "").replace(/^\r?\n/, "");
}

function copy(locale: Locale) {
  const zh = locale === "zh-CN";
  return {
    openSourceFolder: zh ? "\u6253\u5f00\u6e90\u6587\u4ef6\u5939" : "Open source folder", closeTab: zh ? "\u5173\u95ed\u6807\u7b7e" : "Close tab", createMenu: zh ? "\u65b0\u5efa" : "New", deleteItem: zh ? "\u79fb\u5165\u56de\u6536\u7ad9" : "Move to trash", restoreItem: zh ? "\u6062\u590d" : "Restore", purgeItem: zh ? "\u5f7b\u5e95\u5220\u9664" : "Delete forever", moveInto: zh ? "\u79fb\u5165\u6587\u4ef6\u5939" : "Move into folder", trash: zh ? "\u56de\u6536\u7ad9" : "Trash", restoreConfirm: zh ? "\u6062\u590d\u8fd9\u4e2a\u9879\u76ee\uff1f" : "Restore this item?", deleteConfirm: zh ? "\u79fb\u5165\u56de\u6536\u7ad9\uff1f" : "Move this item to trash?",
    library: zh ? "资料库" : "Library", newNote: zh ? "新建笔记" : "New note", newCanvas: zh ? "新建画布" : "New canvas", canvases: zh ? "画布" : "Canvases", save: zh ? "保存" : "Save", saving: zh ? "保存中" : "Saving",
    mount: zh ? "挂载目录" : "Mount folder", readOnly: zh ? "只读挂载" : "Read-only mount", source: zh ? "源码" : "Source", preview: zh ? "预览" : "Preview", split: zh ? "分屏" : "Split",
    search: zh ? "搜索笔记和挂载文件" : "Search notes and mounted files", noNotes: zh ? "新建一篇随笔，或把一个目录作为只读资料库挂入。" : "Write a note, or mount a folder as a read-only library.",
    choose: zh ? "选择目录" : "Choose folder", path: zh ? "目录路径" : "Folder path", name: zh ? "资料库名称" : "Library name", mountHint: zh ? "这是逻辑只读挂载：不会复制、移动或修改原目录中的文件。" : "This is a logical read-only mount. Files are never copied, moved or modified.",
    cancel: zh ? "取消" : "Cancel", remove: zh ? "取消挂载" : "Unmount", editable: zh ? "可编辑" : "Editable", untitled: zh ? "未命名笔记" : "Untitled note", chooseHint: zh ? "选择后会使用系统原生目录选择器。" : "Uses the operating system folder picker.",
    mounted: zh ? "已挂载" : "Mounted", large: zh ? "此文档较大，点击后再渲染预览。" : "This document is large. Click to render its preview.", render: zh ? "渲染预览" : "Render preview", external: zh ? "将在系统浏览器中打开外部链接。继续？" : "Open this external link in your system browser?",
  };
}

function isSafeHref(raw?: string) {
  if (!raw) return false;
  if (raw.startsWith("/") || raw.startsWith("\\") || raw.includes("..") || /^[a-z]:/i.test(raw) || /^[a-z][a-z\d+.-]*:/i.test(raw)) return /^(https?|mailto):/i.test(raw);
  return true;
}
function isSafeRelativeAsset(value: string) { return !!value && !value.includes("..") && !value.startsWith("/") && !value.startsWith("\\") && !/^[a-z]:/i.test(value) && !/^[a-z][a-z\d+.-]*:/i.test(value); }

function SafeMarkdownImage({ sourcePath, src, alt, ...props }: ComponentPropsWithoutRef<"img"> & { sourcePath: string | null }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let active = true; let objectUrl: string | null = null; setUrl(null);
    if (!src || !sourcePath || !isSafeRelativeAsset(src)) return;
    void desktopApi.readNoteAsset(sourcePath, src).then(({ bytes, mimeType }) => {
      if (!active) return;
      const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      objectUrl = URL.createObjectURL(new Blob([buffer], { type: mimeType })); setUrl(objectUrl);
    }).catch(() => undefined);
    return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [sourcePath, src]);
  return url ? <img {...props} src={url} alt={alt} loading="lazy"/> : <span className="markdown-image-blocked">{alt || "Image unavailable"}</span>;
}

const MarkdownPreview = memo(function MarkdownPreview({ markdown, sourcePath, text }: { markdown: string; sourcePath: string | null; text: ReturnType<typeof copy> }) {
  const [renderLarge, setRenderLarge] = useState(markdown.length <= 1024 * 1024);
  useEffect(() => setRenderLarge(markdown.length <= 1024 * 1024), [markdown]);
  const components = useMemo(() => ({
    a: ({ href, children, ...props }: ComponentPropsWithoutRef<"a">) => {
      if (!isSafeHref(href)) return <span>{children}</span>;
      const external = /^(https?|mailto):/i.test(href ?? "");
      return <a {...props} href={href} onClick={(event) => { if (!external) return; event.preventDefault(); if (window.confirm(text.external)) window.open(href, "_blank", "noopener,noreferrer"); }}>{children}</a>;
    },
    img: ({ src, alt, ...props }: ComponentPropsWithoutRef<"img">) => <SafeMarkdownImage sourcePath={sourcePath} src={src} alt={alt ?? ""} {...props}/>,
  }), [sourcePath, text.external]);
  if (!renderLarge) return <div className="markdown-large"><p>{text.large}</p><button className="soft-button" onClick={() => setRenderLarge(true)}><Eye size={15}/>{text.render}</button></div>;
  return <article className="markdown-preview" aria-label={text.preview}><ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} skipHtml components={components}>{markdown}</ReactMarkdown></article>;
});

export function NotesLibraryV2({ onError, onToast, locale, onOpenCanvas }: { onError: (message: string) => void; onToast: (message: string) => void; locale: Locale; onOpenCanvas?: (boardId?: string) => void }) {
  const text = useMemo(() => copy(locale), [locale]);
  const [library, setLibrary] = useState<LibraryProjection>(EMPTY_LIBRARY_PROJECTION); const { files, mounts, boards, trash, mount_statuses: mountStatuses } = library; const [selected, setSelected] = useState<NoteFileInfo | null>(null);
  const [title, setTitle] = useState(""); const [body, setBody] = useState(""); const [query, setQuery] = useState(() => localStorage.getItem("mobius.library.query") ?? ""); const [mode, setMode] = useState<ReadingMode>(() => {
    const stored = localStorage.getItem("mobius.library.mode");
    return stored === "preview" || stored === "split" ? stored : "source";
  });
  const [mountOpen, setMountOpen] = useState(false); const [mountPath, setMountPath] = useState(""); const [virtualPath, setVirtualPath] = useState("Reference"); const [mountAccess, setMountAccess] = useState<"read_only" | "read_write">("read_only"); const mountPathRef = useRef<HTMLInputElement>(null);
  const [wrapSource, setWrapSource] = useState(() => localStorage.getItem("mobius.library.wrap") !== "0");
  const [saving, setSaving] = useState(false); const [reading, setReading] = useState(false); const [saveState, setSaveState] = useState<"idle" | "dirty" | "saved" | "error">("idle"); const lastSaved = useRef(""); const saveInFlight = useRef(false); const titleValueRef = useRef(""); const bodyValueRef = useRef("");
  const [externalConflict, setExternalConflict] = useState<NoteFileInfo | null>(null);
  const [mediaPreview, setMediaPreview] = useState<{ path: string; url: string; kind: "pdf" | "image" } | null>(null);
  useEffect(() => () => { if (mediaPreview) URL.revokeObjectURL(mediaPreview.url); }, [mediaPreview]);
  const [openTabs, setOpenTabs] = useState<NoteTab[]>([]); const [activeTabId, setActiveTabId] = useState<string | null>(null); const [tabMenu, setTabMenu] = useState<TabMenuState>(null); const [libraryMenu, setLibraryMenu] = useState<LibraryMenuState>(null); const [createMenuOpen, setCreateMenuOpen] = useState(false);
  const [treeCommand, setTreeCommand] = useState<TreeCommand>({ revision: 0, open: true });
  const [refreshing, setRefreshing] = useState(false);
  const [dirtyTabIds, setDirtyTabIds] = useState<Set<string>>(() => new Set());
  const [navWidth, setNavWidth] = useState(() => { const value = Number(localStorage.getItem("mobius.library.nav-width")); return Number.isFinite(value) && value >= 220 && value <= 480 ? value : 285; });
  const splitterStart = useRef<{ x: number; width: number } | null>(null);
  const treeScrollRef = useRef<HTMLDivElement>(null);
  const editorContentRef = useRef<HTMLDivElement>(null);
  const restoredSelection = useRef(false);
  const latestLibraryRequest = useRef(0);
  const selectedRef = useRef<NoteFileInfo | null>(null);
  const selectedPathRef = useRef<string | null>(null);
  const selectionReadVersion = useRef(0);
  const automaticRefreshRunning = useRef(false);
  const lastLibraryFingerprint = useRef("");
  const activeTabIdRef = useRef<string | null>(null);
  const editorBusyRef = useRef(false);
  const uiBlockingRef = useRef(false);
  const tabBuffersRef = useRef(new Map<string, { title: string; body: string }>());
  const documentRevisions = useRef(new Map<string, string>());
  const reloadRef = useRef<(quiet?: boolean) => Promise<NoteFileInfo[]>>(async () => []);
  const saveRef = useRef<(quiet?: boolean) => Promise<void>>(async () => {});
  const refreshWorkingCopyRef = useRef<(file: NoteFileInfo) => Promise<void>>(async () => {});
  useEffect(() => { localStorage.setItem("mobius.library.nav-width", String(navWidth)); }, [navWidth]);
  useEffect(() => { localStorage.setItem("mobius.library.query", query); }, [query]);
  useEffect(() => { localStorage.setItem("mobius.library.mode", mode); }, [mode]);
  useEffect(() => { localStorage.setItem("mobius.library.wrap", wrapSource ? "1" : "0"); }, [wrapSource]);
  useEffect(() => {
    void desktopApi.appSettings().then((view) => {
      setMountPath((current) => current || view.data_root);
    }).catch(() => undefined);
  }, []);
  useEffect(() => {
    if (!tabMenu) return;
    const close = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (!target?.closest(".note-tab-context-menu-v2")) setTabMenu(null);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [tabMenu]);
  useEffect(() => {
    const host = document.querySelector(".note-tabs-v2");
    if (!host) return;
    const openContextMenu = (event: Event) => {
      event.preventDefault();
      const target = event.target as Element | null;
      const tabElement = target?.closest(".note-tab-v2");
      if (!tabElement) return;
      const tabs = [...host.querySelectorAll(".note-tab-v2")];
      const tab = openTabs[tabs.indexOf(tabElement)];
      if (!tab) return;
      const pointer = event as MouseEvent;
      setTabMenu({ tab, x: pointer.clientX, y: pointer.clientY });
    };
    host.addEventListener("contextmenu", openContextMenu);
    return () => host.removeEventListener("contextmenu", openContextMenu);
  }, [openTabs]);
  useEffect(() => {
    const move = (event: PointerEvent) => { const start = splitterStart.current; if (!start) return; setNavWidth(Math.max(220, Math.min(480, start.width + event.clientX - start.x))); };
    const up = () => { splitterStart.current = null; document.body.style.removeProperty("cursor"); document.body.style.removeProperty("user-select"); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
    return () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
  }, []);
  useEffect(() => { selectedRef.current = selected; selectedPathRef.current = selected?.real_path ?? null; }, [selected]);
  useEffect(() => { activeTabIdRef.current = activeTabId; }, [activeTabId]);
  useEffect(() => { editorBusyRef.current = saving || reading || saveState === "dirty"; }, [saving, reading, saveState]);
  useEffect(() => { uiBlockingRef.current = mountOpen || createMenuOpen || !!tabMenu || !!libraryMenu; }, [mountOpen, createMenuOpen, tabMenu, libraryMenu]);
  const stashActiveDraft = useCallback(() => {
    const tabId = activeTabIdRef.current;
    if (!tabId) return;
    const draftTitle = titleValueRef.current;
    const draftBody = bodyValueRef.current;
    if (draftTitle || draftBody) tabBuffersRef.current.set(tabId, { title: draftTitle, body: draftBody });
    else tabBuffersRef.current.delete(tabId);
    const dirty = `${draftTitle}\u0000${draftBody}` !== lastSaved.current;
    setDirtyTabIds((current) => {
      const next = new Set(current);
      if (dirty && (draftTitle || draftBody)) next.add(tabId); else next.delete(tabId);
      return next;
    });
  }, []);
  const create = useCallback(() => {
    // Cancel a pending file read before showing a draft. Otherwise a late IO
    // response can paint a source that the newest snapshot has already removed.
    stashActiveDraft();
    selectionReadVersion.current += 1;
    selectedRef.current = null;
    selectedPathRef.current = null;
    tabBuffersRef.current.delete(DRAFT_TAB_ID);
    setDirtyTabIds((current) => { if (!current.has(DRAFT_TAB_ID)) return current; const next = new Set(current); next.delete(DRAFT_TAB_ID); return next; });
    setSelected(null); setActiveTabId(DRAFT_TAB_ID); setOpenTabs((current) => current.some((tab) => tab.id === DRAFT_TAB_ID) ? current : [...current, { id: DRAFT_TAB_ID, file: null, title: "" }].slice(-12)); titleValueRef.current = ""; bodyValueRef.current = ""; setTitle(""); setBody(""); setMode("source"); lastSaved.current = ""; setSaveState("idle");
  }, [stashActiveDraft]);
  const openDraft = useCallback(() => {
    // Returning to the draft tab must restore its buffer, not blank it.
    stashActiveDraft();
    selectionReadVersion.current += 1;
    selectedRef.current = null;
    selectedPathRef.current = null;
    setSelected(null); setActiveTabId(DRAFT_TAB_ID); setOpenTabs((current) => current.some((tab) => tab.id === DRAFT_TAB_ID) ? current : [...current, { id: DRAFT_TAB_ID, file: null, title: "" }].slice(-12));
    const buffered = tabBuffersRef.current.get(DRAFT_TAB_ID);
    const draftTitle = buffered?.title ?? "";
    const draftBody = buffered?.body ?? "";
    titleValueRef.current = draftTitle; bodyValueRef.current = draftBody; setTitle(draftTitle); setBody(draftBody);
    setMode("source"); lastSaved.current = ""; setSaveState(draftTitle || draftBody ? "dirty" : "idle");
  }, [stashActiveDraft]);
  const select = useCallback(async (file: NoteFileInfo) => {
    const alreadyOpen = selectedPathRef.current ? samePath(selectedPathRef.current, file.real_path) : false;
    localStorage.setItem("mobius.library.selected-path", file.real_path);
    selectedRef.current = file;
    selectedPathRef.current = file.real_path;
    setOpenTabs((current) => {
      const existing = current.find((tab) => tab.id === file.id || (tab.file && samePath(tab.file.real_path, file.real_path)));
      if (existing) {
        if (existing.id === file.id && existing.title === file.title && existing.file && sameFileMeta(existing.file, file)) return current;
        return current.map((tab) => tab.file && samePath(tab.file.real_path, file.real_path) ? { id: file.id, file, title: file.title } : tab);
      }
      return [...current, { id: file.id, file, title: file.title }].slice(-12);
    });
    if (alreadyOpen) {
      // Same document is already on screen. Update tab metadata only; do not
      // bump the read generation (that would abort an in-flight first load),
      // blank the body, flip reading, or reset scroll.
      setActiveTabId(file.id);
      if (`${titleValueRef.current}\u0000${bodyValueRef.current}` === lastSaved.current && titleValueRef.current !== file.title) {
        titleValueRef.current = file.title;
        setTitle(file.title);
        lastSaved.current = `${file.title}\u0000${bodyValueRef.current}`;
      }
      return;
    }
    stashActiveDraft();
    const readVersion = ++selectionReadVersion.current;
    setSelected(file); setActiveTabId(file.id);
    setTitle(file.title); setBody(""); setMode(file.read_only ? "preview" : "source"); setReading(true);
    try {
      const kind = mediaKind(file.real_path);
      if (kind) {
        const bytes = await desktopApi.readLibraryMedia(file.real_path);
        if (readVersion !== selectionReadVersion.current) return;
        const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: mediaMime(file.real_path) }));
        setMediaPreview({ path: file.real_path, url, kind });
        titleValueRef.current = file.title; bodyValueRef.current = ""; lastSaved.current = `${file.title}\u0000`;
        setSaveState("idle");
        return;
      }
      setMediaPreview(null);
      const snapshot = file.mount_id ? await desktopApi.readTextDocument(file.real_path) : null;
      const raw = snapshot?.content ?? await desktopApi.readNoteFile(file.real_path);
      if (readVersion !== selectionReadVersion.current) return;
      if (snapshot) documentRevisions.current.set(file.real_path, snapshot.revision);
      const next = file.mount_id ? raw : file.read_only ? raw : editableNoteBody(raw, file.title);
      const buffered = tabBuffersRef.current.get(file.id);
      if (buffered && !file.read_only && (buffered.title !== file.title || buffered.body !== next)) {
        // VSCode-style buffer restore: unsaved keystrokes from the previous
        // visit win over disk; the debounced autosave persists them again.
        lastSaved.current = `${file.title}\u0000${next}`;
        titleValueRef.current = buffered.title; bodyValueRef.current = buffered.body;
        setTitle(buffered.title); setBody(buffered.body); setSaveState("dirty");
      } else {
        tabBuffersRef.current.delete(file.id);
        setDirtyTabIds((current) => { if (!current.has(file.id)) return current; const nextSet = new Set(current); nextSet.delete(file.id); return nextSet; });
        titleValueRef.current = file.title; bodyValueRef.current = next; setBody(next); lastSaved.current = `${file.title}\u0000${next}`; setSaveState("saved");
      }
    } catch (reason) {
      if (readVersion !== selectionReadVersion.current) return;
      if (file.read_only && isRemovedSourceError(reason)) {
        setSaveState("idle");
        void reloadRef.current();
        return;
      }
      setSaveState("error"); onError(String(reason));
    } finally {
      if (readVersion === selectionReadVersion.current) setReading(false);
    }
  }, [onError, stashActiveDraft]);
  const refreshWorkingCopy = useCallback(async (file: NoteFileInfo) => {
    if (mediaKind(file.real_path)) return;
    if (!selectedPathRef.current || !samePath(selectedPathRef.current, file.real_path)) return;
    if (`${titleValueRef.current}\u0000${bodyValueRef.current}` !== lastSaved.current) return;
    const readVersion = selectionReadVersion.current;
    try {
      const snapshot = file.mount_id ? await desktopApi.readTextDocument(file.real_path) : null;
      const raw = snapshot?.content ?? await desktopApi.readNoteFile(file.real_path);
      if (readVersion !== selectionReadVersion.current) return;
      if (!selectedPathRef.current || !samePath(selectedPathRef.current, file.real_path)) return;
      if (`${titleValueRef.current}\u0000${bodyValueRef.current}` !== lastSaved.current) return;
      const next = file.mount_id ? raw : file.read_only ? raw : editableNoteBody(raw, file.title);
      if (snapshot) documentRevisions.current.set(file.real_path, snapshot.revision);
      if (bodyValueRef.current === next && titleValueRef.current === file.title) return;
      const host = editorContentRef.current;
      const scroller = host?.querySelector<HTMLElement>(".cm-scroller, .markdown-preview");
      const scrollTop = scroller?.scrollTop ?? 0;
      titleValueRef.current = file.title;
      bodyValueRef.current = next;
      setTitle(file.title);
      setBody(next);
      lastSaved.current = `${file.title}\u0000${next}`;
      setSaveState("saved");
      requestAnimationFrame(() => {
        const restored = editorContentRef.current?.querySelector<HTMLElement>(".cm-scroller, .markdown-preview");
        if (restored) restored.scrollTop = scrollTop;
      });
    } catch {
      // Explorer already owns disappearance. A failed silent resolve must not
      // blank the working copy that is still on screen.
    }
  }, []);
  useEffect(() => { refreshWorkingCopyRef.current = refreshWorkingCopy; }, [refreshWorkingCopy]);
  const reconcileSnapshot = useCallback((nextFiles: NoteFileInfo[]) => {
    const knownPaths = new Set(nextFiles.map((file) => file.real_path.replace(/\\/g, "/").toLocaleLowerCase()));
    setOpenTabs((current) => {
      const next = current.filter((tab) => !tab.file || knownPaths.has(tab.file.real_path.replace(/\\/g, "/").toLocaleLowerCase()));
      return next.length === current.length ? current : next;
    });
    const current = selectedRef.current;
    if (!current) return;
    const nextSelected = nextFiles.find((file) => samePath(file.real_path, current.real_path));
    if (!nextSelected) {
      const editorHoldsUnsavedWork = !current.read_only && `${titleValueRef.current}\u0000${bodyValueRef.current}` !== lastSaved.current;
      if (editorHoldsUnsavedWork) {
        // The source vanished under an unsaved working copy. Keep the buffer
        // (editor-style) instead of wiping keystrokes; the next explicit save
        // surfaces any real write failure for the operator to resolve.
        return;
      }
      // A source was unmounted, deleted or became unavailable. The old data is
      // no longer authoritative, so clear it instead of keeping a stale editor.
      localStorage.removeItem("mobius.library.selected-path");
      create();
      return;
    }
    selectedRef.current = nextSelected;
    const metadataChanged = !sameFileMeta(current, nextSelected);
    if (metadataChanged) setSelected(nextSelected);
    setOpenTabs((currentTabs) => {
      let changed = false;
      const nextTabs = currentTabs.map((tab) => {
        if (!tab.file || !samePath(tab.file.real_path, nextSelected.real_path)) return tab;
        if (tab.id === nextSelected.id && tab.title === nextSelected.title && tab.file === nextSelected) return tab;
        if (tab.file && sameFileMeta(tab.file, nextSelected) && tab.id === nextSelected.id && tab.title === nextSelected.title) return tab;
        changed = true;
        return { ...tab, id: nextSelected.id, file: nextSelected, title: nextSelected.title };
      });
      return changed ? nextTabs : currentTabs;
    });
    if (activeTabIdRef.current === current.id && current.id !== nextSelected.id) setActiveTabId(nextSelected.id);
    const dirty = `${titleValueRef.current}\u0000${bodyValueRef.current}` !== lastSaved.current;
    // VS Code: a dirty working copy is never resolved from a watcher event.
    // A clean copy may pick up disk contents in place, without blanking the
    // editor or bumping the read generation.
    if (current.title !== nextSelected.title && (activeTabIdRef.current === nextSelected.id || activeTabIdRef.current === current.id) && !dirty) {
      titleValueRef.current = nextSelected.title;
      setTitle(nextSelected.title);
      lastSaved.current = `${nextSelected.title}\u0000${bodyValueRef.current}`;
    }
    if (!dirty && current.modified_at !== nextSelected.modified_at) {
      void refreshWorkingCopyRef.current(nextSelected);
    }
  }, [create]);
  const reload = useCallback(async (quiet = false) => {
    const request = ++latestLibraryRequest.current;
    // A background tick must not flash the refresh spinner; only an explicit
    // person-triggered refresh advertises itself through the button state.
    if (!quiet) setRefreshing(true);
    try {
      const [snapshot, nextBoards, nextTrash] = await Promise.all([desktopApi.noteLibrarySnapshot(), desktopApi.listBoards(), desktopApi.listTrash()]);
      // Only the newest request can replace the view. An older filesystem scan
      // must never overwrite a newer mount/unmount result when it completes late.
      if (request !== latestLibraryRequest.current) return snapshot.files;
      const fingerprint = libraryFingerprint(snapshot, nextBoards, nextTrash);
      if (fingerprint === lastLibraryFingerprint.current) {
        const current = selectedRef.current;
        const nextOpen = current ? snapshot.files.find((file) => samePath(file.real_path, current.real_path)) : undefined;
        if (current && nextOpen && current.modified_at !== nextOpen.modified_at) {
          selectedRef.current = nextOpen;
          const dirty = `${titleValueRef.current}\u0000${bodyValueRef.current}` !== lastSaved.current;
          if (!dirty) void refreshWorkingCopyRef.current(nextOpen);
        }
        return snapshot.files;
      }
      lastLibraryFingerprint.current = fingerprint;
      setLibrary({ ...snapshot, boards: nextBoards, trash: nextTrash });
      reconcileSnapshot(snapshot.files);
      return snapshot.files;
    } catch (reason) {
      if (request === latestLibraryRequest.current) onError(String(reason));
      return [];
    } finally {
      if (request === latestLibraryRequest.current && !quiet) setRefreshing(false);
    }
  }, [onError, reconcileSnapshot]);
  useEffect(() => { reloadRef.current = reload; }, [reload]);
  useEffect(() => { void reload(); }, [reload]);
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    let debounceTimer: number | null = null;
    void desktopApi.onNoteLibraryChanged(() => {
      if (disposed) return;
      if (debounceTimer !== null) window.clearTimeout(debounceTimer);
      debounceTimer = window.setTimeout(() => {
        debounceTimer = null;
        // The explorer must continue to track external changes while a text
        // buffer is dirty. reconcileSnapshot protects that buffer separately.
        if (saveInFlight.current) return;
        void reloadRef.current(true);
      }, 400);
    }).then((stop) => {
      if (disposed) stop(); else unlisten = stop;
    }).catch((reason) => { if (!disposed) onError(String(reason)); });
    return () => {
      disposed = true;
      if (debounceTimer !== null) window.clearTimeout(debounceTimer);
      unlisten?.();
    };
  }, [onError, reload]);
  const draftKey = `${title}\u0000${body}`;
  useEffect(() => {
    if (restoredSelection.current || library.snapshot_id === "initial-library") return;
    const savedPath = localStorage.getItem("mobius.library.selected-path");
    const saved = savedPath ? files.find((file) => samePath(file.real_path, savedPath)) : undefined;
    // A library snapshot is complete by definition. If the saved source is
    // absent now, it is no longer a valid location to restore.
    restoredSelection.current = true;
    if (saved) void select(saved); else if (savedPath) localStorage.removeItem("mobius.library.selected-path");
  }, [files, select]);
  useEffect(() => {
    if (selected) localStorage.setItem("mobius.library.selected-path", selected.real_path);
  }, [selected]);
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      if (!selected || reading) return;
      const target = editorContentRef.current?.querySelector<HTMLElement>(".cm-scroller, .markdown-preview");
      const value = Number(localStorage.getItem(`mobius.library.scroll.${selected.real_path}.${mode}`));
      if (target && Number.isFinite(value) && value > 0) target.scrollTop = value;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [mode, reading, selected?.real_path]);
  useEffect(() => {
    const treeTop = Number(localStorage.getItem("mobius.library.tree.scroll-top"));
    if (treeScrollRef.current && Number.isFinite(treeTop) && treeTop > 0) treeScrollRef.current.scrollTop = treeTop;
  }, [library.snapshot_id]);
  const refreshLibrary = useCallback(async (quiet = false) => {
    await reload(quiet);
    if (!quiet) onToast(locale === "zh-CN" ? "资料库已刷新" : "Library refreshed");
  }, [locale, onToast, reload]);
  useEffect(() => {
    const refreshVisible = () => {
      if (document.visibilityState !== "visible" || automaticRefreshRunning.current) return;
      // Reconcile the tree even if a document is dirty; only its working copy
      // is protected from an unsolicited disk reload.
      if (saveInFlight.current) return;
      automaticRefreshRunning.current = true;
      void refreshLibrary(true).finally(() => { automaticRefreshRunning.current = false; });
    };
    const timer = window.setInterval(refreshVisible, 5000);
    window.addEventListener("focus", refreshVisible);
    document.addEventListener("visibilitychange", refreshVisible);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", refreshVisible); document.removeEventListener("visibilitychange", refreshVisible); };
  }, [refreshLibrary]);
  const save = useCallback(async (quiet = false) => {
    const savedTitle = titleValueRef.current.trim(); const savedBody = bodyValueRef.current;
    const current = selectedRef.current;
    if (!savedTitle || current?.read_only || saveInFlight.current) return;
    saveInFlight.current = true; setSaving(true);
    try {
      if (current?.mount_id) {
        const revision = documentRevisions.current.get(current.real_path);
        if (!revision) throw new Error("Document version is unavailable; reload before saving.");
        const updated = await desktopApi.saveMountedTextDocument(current.real_path, revision, savedBody);
        documentRevisions.current.set(current.real_path, updated.revision);
        lastSaved.current = `${savedTitle}\u0000${savedBody}`;
        tabBuffersRef.current.delete(current.id);
        setDirtyTabIds((ids) => { const next = new Set(ids); next.delete(current.id); return next; });
        setSaveState("saved");
        if (!quiet) onToast(locale === "zh-CN" ? "文件已保存" : "File saved");
        return;
      }
      const draft = { title: savedTitle, body: savedBody, project_slug: null, tags: [], source_ids: [] };
      const record = current ? await desktopApi.updateNoteFile(current.real_path, draft) : await desktopApi.createNote(draft);
      lastSaved.current = `${savedTitle}\u0000${savedBody}`;
      const creating = !current;
      // VS Code: save writes the working copy. It does not resolve the model
      // again, so caret, scroll and focus stay put. Only a first create needs
      // the explorer snapshot so the new file appears in the tree.
      if (creating) {
        const nextFiles = await reload(true);
        const updated = record.source_path ? nextFiles.find((file) => file.real_path === record.source_path) : undefined;
        if (updated) {
          selectedRef.current = updated;
          selectedPathRef.current = updated.real_path;
          setSelected(updated);
          setActiveTabId(updated.id);
          setOpenTabs((tabs) => tabs.map((tab) => tab.id === DRAFT_TAB_ID || tab.file?.real_path === updated.real_path ? { id: updated.id, file: updated, title: updated.title } : tab));
          tabBuffersRef.current.delete(DRAFT_TAB_ID);
          setDirtyTabIds((ids) => { const next = new Set(ids); next.delete(DRAFT_TAB_ID); next.delete(updated.id); return next; });
        }
      } else {
        tabBuffersRef.current.delete(current.id);
        setDirtyTabIds((ids) => { const next = new Set(ids); next.delete(current.id); return next; });
        setOpenTabs((tabs) => tabs.map((tab) => tab.file && samePath(tab.file.real_path, current.real_path) ? { ...tab, title: savedTitle } : tab));
      }
      setSaveState("saved");
      if (!quiet) onToast(locale === "zh-CN" ? "笔记已保存" : "Note saved");
    } catch (reason) { setSaveState("error"); if (current?.mount_id && String(reason).includes("changed")) setExternalConflict(current); else onError(String(reason)); } finally { saveInFlight.current = false; setSaving(false); }
  }, [locale, onError, onToast, reload]);
  useEffect(() => { if (reading || !title.trim() || selected?.read_only || selected?.mount_id || draftKey === lastSaved.current || saving) return; const timer = window.setTimeout(() => void save(true), 600); return () => window.clearTimeout(timer); }, [draftKey, reading, save, saving, selected?.read_only, selected?.mount_id, title]);
  useEffect(() => { saveRef.current = save; }, [save]);
  useEffect(() => {
    // Editor-style manual save: Ctrl/Cmd+S always saves the active document,
    // never navigates the browser's default "save page" dialog.
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "s") return;
      if (selectedRef.current?.read_only || reading) return;
      event.preventDefault();
      if (titleValueRef.current.trim() || bodyValueRef.current) void saveRef.current(true);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [reading]);
  const chooseFolder = async () => { try { const path = await desktopApi.pickDirectory(mountPath); if (path) setMountPath(path); } catch (reason) { onError(String(reason)); } };
  const mount = async () => { if (!mountPath.trim() || !virtualPath.trim()) return; try { await desktopApi.addNoteMount(mountPath.trim(), virtualPath.trim(), mountAccess); setMountOpen(false); await reload(); onToast(locale === "zh-CN" ? (mountAccess === "read_write" ? "目录已作为可写资料库挂载" : "目录已作为只读资料库挂载") : (mountAccess === "read_write" ? "Folder mounted read-write" : "Folder mounted read-only")); } catch (reason) { onError(String(reason)); } };
  const unmount = async (mountInfo: MountInfo) => { try { await desktopApi.removeNoteMount(mountInfo.id); if (selected?.mount_id === mountInfo.id) create(); await reload(); onToast(locale === "zh-CN" ? "已取消挂载，原文件未改动" : "Unmounted; original files are unchanged"); } catch (reason) { onError(String(reason)); } };
  const moveNote = useCallback(async (sourcePath: string, destinationPath: string) => {
    try {
      const [, newPath] = await desktopApi.moveNote(sourcePath, destinationPath);
      const nextFiles = await reload();
      const moved = nextFiles.find((file) => samePath(file.real_path, newPath));
      if (moved) {
        setSelected(moved);
        setActiveTabId(moved.id);
        setOpenTabs((current) => current.map((tab) => tab.file && samePath(tab.file.real_path, sourcePath) ? { ...tab, id: moved.id, file: moved, title: moved.title } : tab));
      }
      onToast(locale === "zh-CN" ? "笔记已移动" : "Note moved");
    }
    catch (reason) { onError(String(reason)); }
  }, [locale, onError, onToast, reload]);
  const onTreeContextMenu = useCallback((event: React.MouseEvent, target: { type: "folder" | "note"; file?: NoteFileInfo; path: string; label: string }) => {
    setLibraryMenu({ x: event.clientX, y: event.clientY, target });
  }, []);
  const onBoardContextMenu = useCallback((event: React.MouseEvent, board: BoardDocument) => {
    setLibraryMenu({ x: event.clientX, y: event.clientY, target: { type: "board", board } });
  }, []);
  const onMountContextMenu = useCallback((event: React.MouseEvent, mount: MountInfo) => {
    setLibraryMenu({ x: event.clientX, y: event.clientY, target: { type: "mount", mount } });
  }, []);
  const trashNote = async (file: NoteFileInfo) => {
    if (file.read_only || file.mount_id || !window.confirm(text.deleteConfirm)) return;
    try {
      await desktopApi.trashNote(file.real_path);
      setOpenTabs((current) => current.filter((tab) => !tab.file || !samePath(tab.file.real_path, file.real_path)));
      if (selected && samePath(selected.real_path, file.real_path)) create();
      await reload();
      onToast(locale === "zh-CN" ? "笔记已移入回收站" : "Note moved to trash");
    } catch (reason) { onError(String(reason)); }
  };
  const trashBoard = async (board: BoardDocument) => {
    if (!window.confirm(text.deleteConfirm)) return;
    try { await desktopApi.trashBoard(board.id); await reload(); onToast(locale === "zh-CN" ? "画布已移入回收站" : "Canvas moved to trash"); }
    catch (reason) { onError(String(reason)); }
  };
  const restoreTrash = async (item: TrashItem) => {
    if (!window.confirm(text.restoreConfirm)) return;
    try { await desktopApi.restoreTrash(item.id); await reload(); onToast(locale === "zh-CN" ? "项目已恢复" : "Item restored"); }
    catch (reason) { onError(String(reason)); }
  };
  const purgeTrash = async (item: TrashItem) => {
    if (!window.confirm(text.deleteConfirm)) return;
    try { await desktopApi.purgeTrash(item.id); await reload(); onToast(locale === "zh-CN" ? "已永久删除" : "Deleted permanently"); }
    catch (reason) { onError(String(reason)); }
  };
  const queryNeedle = query.toLocaleLowerCase();
  const visible = useMemo(() => files.filter((file) => `${file.title} ${file.virtual_path}`.toLocaleLowerCase().includes(queryNeedle)), [files, queryNeedle]);
  const visibleBoards = useMemo(() => boards.filter((board) => board.title.toLocaleLowerCase().includes(queryNeedle)), [boards, queryNeedle]);
  const editableFiles = useMemo(() => visible.filter((file) => !file.mount_id), [visible]);
  const notesTree = useMemo(() => noteTree(editableFiles, "Möbius"), [editableFiles]);
  const rootBoards = useMemo(() => visibleBoards.filter((board) => boardParentId(board) === null), [visibleBoards]);
  const filesByMount = useMemo(() => {
    const grouped = new Map<string, NoteFileInfo[]>();
    for (const file of visible) {
      if (!file.mount_id) continue;
      const bucket = grouped.get(file.mount_id);
      if (bucket) bucket.push(file);
      else grouped.set(file.mount_id, [file]);
    }
    return grouped;
  }, [visible]);
  const [previewBody, setPreviewBody] = useState(body);
  const previewPathRef = useRef<string | null>(null);
  useEffect(() => {
    const path = selected?.real_path ?? DRAFT_TAB_ID;
    if (previewPathRef.current !== path || reading) {
      previewPathRef.current = path;
      setPreviewBody(body);
      return;
    }
    if (mode === "source" && !selected?.read_only) return;
    const timer = window.setTimeout(() => setPreviewBody(body), 160);
    return () => window.clearTimeout(timer);
  }, [body, mode, reading, selected?.read_only, selected?.real_path]);
  const readOnly = !!selected?.read_only;
  const closeTab = (tabId: string) => {
    const index = openTabs.findIndex((tab) => tab.id === tabId); if (index < 0) return;
    if (dirtyTabIds.has(tabId) && !window.confirm(locale === "zh-CN" ? "此文档尚未保存。确定放弃更改并关闭？" : "This document has unsaved changes. Discard them and close?")) return;
    tabBuffersRef.current.delete(tabId);
    setDirtyTabIds((current) => { if (!current.has(tabId)) return current; const next = new Set(current); next.delete(tabId); return next; });
    const next = openTabs.filter((tab) => tab.id !== tabId); setOpenTabs(next);
    if (activeTabId !== tabId) return;
    const replacement = next[Math.min(index, Math.max(0, next.length - 1))];
    if (replacement?.file) void select(replacement.file); else openDraft();
  };
  const reloadConflictedDocument = async () => {
    const file = externalConflict;
    if (!file) return;
    try {
      const snapshot = await desktopApi.readTextDocument(file.real_path);
      documentRevisions.current.set(file.real_path, snapshot.revision);
      titleValueRef.current = file.title; bodyValueRef.current = snapshot.content;
      setTitle(file.title); setBody(snapshot.content);
      lastSaved.current = `${file.title}\u0000${snapshot.content}`;
      tabBuffersRef.current.delete(file.id);
      setDirtyTabIds((current) => { const next = new Set(current); next.delete(file.id); return next; });
      setSaveState("saved"); setExternalConflict(null);
    } catch (reason) { onError(String(reason)); }
  };
  const saveConflictedCopy = async () => {
    if (!externalConflict) return;
    try {
      await desktopApi.createNote({ title: `${externalConflict.title} copy`, body: bodyValueRef.current, project_slug: null, tags: [], source_ids: [] });
      setExternalConflict(null);
      await reload(true);
      onToast(locale === "zh-CN" ? "已在私有笔记中保存副本，原文件未修改" : "Saved a private note copy; the original file was not changed");
    } catch (reason) { onError(String(reason)); }
  };
  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => { event.preventDefault(); splitterStart.current = { x: event.clientX, width: navWidth }; document.body.style.cursor = "col-resize"; document.body.style.userSelect = "none"; event.currentTarget.setPointerCapture?.(event.pointerId); };
  const keyboardResize = (event: ReactKeyboardEvent<HTMLDivElement>) => { if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return; event.preventDefault(); setNavWidth((value) => Math.max(220, Math.min(480, value + (event.key === "ArrowRight" ? 16 : -16)))); };
  return <div className="notes-library-v2" style={{ "--library-nav-width": `${navWidth}px` } as CSSProperties}>
    <aside className="notes-nav-v2"><header className="library-nav-header"><div className="library-create-wrap"><button className="primary-button library-create-button" type="button" aria-haspopup="menu" aria-expanded={createMenuOpen} onClick={() => setCreateMenuOpen((value) => !value)}><Plus size={14}/>{text.createMenu}</button>{createMenuOpen ? <div className="library-create-menu" role="menu"><button type="button" role="menuitem" onClick={() => { setCreateMenuOpen(false); create(); }}><FileText size={15}/><span><strong>{text.newNote}</strong><small>Markdown note</small></span></button>{onOpenCanvas ? <button type="button" role="menuitem" onClick={() => { setCreateMenuOpen(false); onOpenCanvas(); }}><Layers2 size={15}/><span><strong>{text.newCanvas}</strong><small>Infinite canvas</small></span></button> : null}</div> : null}</div><div className="library-nav-tools"><button className="icon-soft" type="button" disabled={refreshing} onClick={() => void refreshLibrary()} title={locale === "zh-CN" ? "刷新资料库" : "Refresh library"}>{refreshing ? <LoaderCircle className="spin" size={14}/> : <RefreshCw size={14}/>}</button><button className="icon-soft" type="button" onClick={() => setTreeCommand((current) => ({ revision: current.revision + 1, open: false }))} title={locale === "zh-CN" ? "全部折叠" : "Collapse all"}><ChevronsUp size={15}/></button><button className="icon-soft" type="button" onClick={() => setTreeCommand((current) => ({ revision: current.revision + 1, open: true }))} title={locale === "zh-CN" ? "全部展开" : "Expand all"}><ChevronsDown size={15}/></button></div></header><label className="notes-search-v2"><Search size={16}/><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={text.search}/></label><div ref={treeScrollRef} className="library-tree-v2" onScroll={(event) => localStorage.setItem("mobius.library.tree.scroll-top", String(event.currentTarget.scrollTop))}>
      <TreeSection command={treeCommand} icon={<Layers2 size={15}/>} title={text.canvases} count={visibleBoards.length}>{rootBoards.map((board) => <BoardBranch command={treeCommand} key={board.id} board={board} boards={visibleBoards} depth={0} onOpen={(id) => onOpenCanvas?.(id)} onContextMenu={onBoardContextMenu}/>)}{!visibleBoards.length ? <p>{locale === "zh-CN" ? "还没有画布" : "No canvases yet"}</p> : null}</TreeSection>
      <TreeSection command={treeCommand} icon={<FileText size={15}/>} title={locale === "zh-CN" ? "笔记" : "Notes"} count={editableFiles.length}><TreeBranch command={treeCommand} scope="notes" node={notesTree} selectedId={selected?.id} onSelect={select} onMoveNote={moveNote} onContextMenu={onTreeContextMenu}/></TreeSection>
      <TreeSection command={treeCommand} icon={<FolderPlus size={15}/>} title={locale === "zh-CN" ? "挂载" : "Mounts"} count={mounts.length} action={<button className="icon-soft" type="button" onClick={() => setMountOpen(true)} title={text.mount}><Plus size={14}/></button>}>{mounts.map((mountInfo) => <MountBranch command={treeCommand} key={mountInfo.id} mountInfo={mountInfo} status={mountStatuses.find((status) => status.mount_id === mountInfo.id)} files={filesByMount.get(mountInfo.id) ?? EMPTY_NOTE_FILES} selectedId={selected?.id} locale={locale} onSelect={select} onUnmount={() => void unmount(mountInfo)} onContextMenu={onTreeContextMenu} onMountContextMenu={onMountContextMenu}/>)}</TreeSection>
      <TreeSection command={treeCommand} icon={<Trash2 size={15}/>} title={text.trash} count={trash.length}>{trash.map((item) => <div key={item.id} className="library-trash-item" onContextMenu={(event) => { event.preventDefault(); setLibraryMenu({ x: event.clientX, y: event.clientY, target: { type: "trash", item } }); }}><Trash2 size={13}/><span title={item.original_path}>{item.title}</span><button className="icon-soft" type="button" onClick={() => void restoreTrash(item)} title={text.restoreItem}><Undo2 size={13}/></button></div>)}</TreeSection>
    </div></aside><div className="notes-library-splitter" role="separator" aria-orientation="vertical" aria-label="Resize library panel" tabIndex={0} onPointerDown={startResize} onKeyDown={keyboardResize}/>
    <section className={`note-editor-v2 mode-${readOnly ? "preview" : mode}`}><div className="note-tabs-v2" role="tablist">{openTabs.map((tab) => { const active = activeTabId === tab.id; const tabTitle = tab.file?.id === selected?.id ? (title || tab.title) : (tab.file?.title || tab.title || text.untitled); return <div className={`note-tab-v2 ${active ? "active" : ""}`} key={tab.id}><button type="button" role="tab" aria-selected={active} onClick={() => { if (tab.file) void select(tab.file); else openDraft(); }}><FileText size={13}/><span>{tabTitle}</span>{dirtyTabIds.has(tab.id) ? <i className="note-tab-dirty-dot" role="img" aria-label={locale === "zh-CN" ? "有未保存更改" : "Unsaved changes"}/> : null}</button><button className="note-tab-close-v2" type="button" aria-label={`Close ${tabTitle}`} onClick={(event) => { event.stopPropagation(); closeTab(tab.id); }}><X size={12}/></button></div>; })}<button className="note-tab-new-v2" type="button" onClick={create} title={text.newNote}><Plus size={14}/></button></div><header><input value={title} onChange={(event) => { titleValueRef.current = event.target.value; setTitle(event.target.value); setSaveState("dirty"); }} readOnly={readOnly || reading || !!selected?.mount_id} placeholder={text.untitled}/><div className="note-view-switch" role="group" aria-label={text.preview}><button className={mode === "source" ? "active" : ""} disabled={readOnly || reading} onClick={() => setMode("source")} title={text.source}><Code2 size={15}/><span>{text.source}</span></button><button className={mode === "preview" ? "active" : ""} disabled={reading} onClick={() => setMode("preview")} title={text.preview}><Eye size={15}/><span>{text.preview}</span></button><button className={mode === "split" ? "active" : ""} disabled={readOnly || reading} onClick={() => setMode("split")} title={text.split}><PanelRight size={15}/><span>{text.split}</span></button></div><div className="note-actions">{readOnly ? <button className="soft-button" type="button" onClick={() => { const copyTitle = `${title} copy`; setSelected(null); setActiveTabId(DRAFT_TAB_ID); setOpenTabs((current) => current.some((tab) => tab.id === DRAFT_TAB_ID) ? current : [...current, { id: DRAFT_TAB_ID, file: null, title: "" }].slice(-12)); titleValueRef.current = copyTitle; bodyValueRef.current = body; setTitle(copyTitle); setBody(body); setMode("source"); lastSaved.current = ""; setSaveState("dirty"); tabBuffersRef.current.set(DRAFT_TAB_ID, { title: copyTitle, body }); }}>Copy to note</button> : null}<button className="soft-button" onClick={create}><Plus size={15}/>{text.newNote}</button><button className="primary-button" disabled={saving || reading || readOnly || !title.trim()} onClick={() => void save()}>{saving ? <LoaderCircle className="spin" size={15}/> : <Save size={15}/>} {saving ? text.saving : text.save}</button></div></header><div ref={editorContentRef} className="note-content-v2" onScrollCapture={(event) => { const target = event.target as HTMLElement; if (selected && target !== event.currentTarget) localStorage.setItem(`mobius.library.scroll.${selected.real_path}.${mode}`, String(target.scrollTop)); }}>{!readOnly && mode !== "preview" ? <NoteSourceEditor documentKey={selected?.real_path ?? DRAFT_TAB_ID} value={body} disabled={reading} placeholder={text.noNotes} wrap={wrapSource} onWrapChange={setWrapSource} onChange={(next) => { bodyValueRef.current = next; setBody(next); setSaveState("dirty"); }}/> : null}{(readOnly || mode !== "source") ? (mediaPreview && mediaPreview.path === selected?.real_path ? (mediaPreview.kind === "image" ? <div className="library-media-preview"><img src={mediaPreview.url} alt={title}/></div> : <iframe className="library-pdf-preview" src={mediaPreview.url} title={title}/>) : /\.txt$/i.test(selected?.real_path ?? "") ? <pre className="plain-text-preview">{previewBody}</pre> : <MarkdownPreview markdown={previewBody} sourcePath={selected?.real_path ?? null} text={text}/>) : null}</div>{selected ? <footer><span>{selected.virtual_path}</span><span className={`note-save-state ${saveState}`}>{readOnly ? (locale === "zh-CN" ? "只读挂载" : "Read-only mount") : saveState === "dirty" ? (locale === "zh-CN" ? "未保存" : "Unsaved changes") : saveState === "error" ? (locale === "zh-CN" ? "保存失败" : "Save failed") : saveState === "saved" ? (locale === "zh-CN" ? "已保存" : "Saved") : text.editable}</span></footer> : null}</section>
    {tabMenu ? <ContextMenu className="note-tab-context-menu-v2" x={tabMenu.x} y={tabMenu.y} onClose={() => setTabMenu(null)} items={[
      { id: "open-source", label: text.openSourceFolder, icon: <FolderOpen size={14}/>, disabled: !tabMenu.tab.file, onSelect: () => { if (tabMenu.tab.file) void desktopApi.revealNoteSource(tabMenu.tab.file.real_path).catch((reason) => onError(String(reason))); } },
      { id: "close-tab", label: text.closeTab, icon: <X size={14}/>, onSelect: () => closeTab(tabMenu.tab.id) },
      { id: "trash-tab", label: text.deleteItem, icon: <Trash2 size={14}/>, danger: true, disabled: !tabMenu.tab.file || !!tabMenu.tab.file?.read_only || !!tabMenu.tab.file?.mount_id, onSelect: () => { if (tabMenu.tab.file) void trashNote(tabMenu.tab.file); } },
    ]}/> : null}
    {libraryMenu ? <ContextMenu x={libraryMenu.x} y={libraryMenu.y} onClose={() => setLibraryMenu(null)} items={libraryMenu.target.type === "note" ? [
      { id: "open-source", label: text.openSourceFolder, icon: <FolderOpen size={14}/>, onSelect: () => { const file = libraryMenu.target.type === "note" ? libraryMenu.target.file : undefined; if (file) void desktopApi.revealNoteSource(file.real_path).catch((reason) => onError(String(reason))); } },
      { id: "trash-note", label: text.deleteItem, icon: <Trash2 size={14}/>, danger: true, disabled: libraryMenu.target.file?.read_only || !!libraryMenu.target.file?.mount_id, onSelect: () => { const file = libraryMenu.target.type === "note" ? libraryMenu.target.file : undefined; if (file) void trashNote(file); } },
    ] : libraryMenu.target.type === "board" ? [
      { id: "open-board", label: text.newCanvas, icon: <Layers2 size={14}/>, onSelect: () => onOpenCanvas?.(libraryMenu.target.type === "board" ? libraryMenu.target.board.id : undefined) },
      { id: "trash-board", label: text.deleteItem, icon: <Trash2 size={14}/>, danger: true, onSelect: () => { if (libraryMenu.target.type === "board") void trashBoard(libraryMenu.target.board); } },
    ] : libraryMenu.target.type === "mount" ? [
      { id: "unmount", label: text.remove, icon: <FolderOpen size={14}/>, danger: true, onSelect: () => { if (libraryMenu.target.type === "mount") void unmount(libraryMenu.target.mount); } },
    ] : libraryMenu.target.type === "trash" ? [
      { id: "restore", label: text.restoreItem, icon: <Undo2 size={14}/>, onSelect: () => { if (libraryMenu.target.type === "trash") void restoreTrash(libraryMenu.target.item); } },
      { id: "purge", label: text.purgeItem, icon: <Trash2 size={14}/>, danger: true, onSelect: () => { if (libraryMenu.target.type === "trash") void purgeTrash(libraryMenu.target.item); } },
    ] : [{ id: "folder-drop", label: text.moveInto, icon: <Folder size={14}/>, disabled: true, onSelect: () => undefined }]} /> : null}
    {externalConflict ? <AccessibleDialog title={locale === "zh-CN" ? "文件在外部发生变化" : "File changed outside Möbius"} closeLabel={text.cancel} onClose={() => setExternalConflict(null)}><div className="mount-dialog-v2"><p>{locale === "zh-CN" ? "保存已停止，未覆盖磁盘上的新版本。你可以重新载入外部版本，或将当前内容另存为 Möbius 私有笔记。" : "Saving stopped without overwriting the newer disk version. Reload it or save your current text as a private Möbius note."}</p><code>{externalConflict.real_path}</code><div className="modal-actions"><button className="soft-button" onClick={() => setExternalConflict(null)}>{locale === "zh-CN" ? "保留编辑内容" : "Keep working copy"}</button><button className="soft-button" onClick={() => void saveConflictedCopy()}>{locale === "zh-CN" ? "另存副本" : "Save a copy"}</button><button className="primary-button" onClick={() => void reloadConflictedDocument()}>{locale === "zh-CN" ? "重新载入" : "Reload from disk"}</button></div></div></AccessibleDialog> : null}
    {mountOpen ? <AccessibleDialog title={text.mount} closeLabel={locale === "zh-CN" ? "关闭对话框" : "Close dialog"} onClose={() => setMountOpen(false)} initialFocusRef={mountPathRef}><div className="mount-dialog-v2"><label className="form-label">{text.path}<div className="folder-picker-input"><input ref={mountPathRef} value={mountPath} onChange={(event) => setMountPath(event.target.value)}/><button className="soft-button" type="button" onClick={() => void chooseFolder()}><FolderOpen size={15}/>{text.choose}</button></div><small>{text.chooseHint}</small></label><label className="form-label">{text.name}<input value={virtualPath} onChange={(event) => setVirtualPath(event.target.value)}/></label><label className="form-label">{locale === "zh-CN" ? "访问权限" : "Access"}<select value={mountAccess} onChange={(event) => setMountAccess(event.target.value as "read_only" | "read_write")}><option value="read_only">{locale === "zh-CN" ? "只读（默认）" : "Read-only (default)"}</option><option value="read_write">{locale === "zh-CN" ? "可写：保存将修改原文件" : "Read-write: saving changes the original file"}</option></select></label><p>{mountAccess === "read_write" ? (locale === "zh-CN" ? "只有明确点击保存才会写入原目录；外部文件已变化时将拒绝覆盖。" : "Only an explicit save writes to the original directory; externally changed files cannot be overwritten.") : text.mountHint}</p><div className="modal-actions"><button className="soft-button" onClick={() => setMountOpen(false)}>{text.cancel}</button><button className="primary-button" onClick={() => void mount()} disabled={!mountPath.trim() || !virtualPath.trim()}>{text.mounted}</button></div></div></AccessibleDialog> : null}
  </div>;
}
