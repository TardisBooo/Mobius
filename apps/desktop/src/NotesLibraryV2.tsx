import { type ComponentPropsWithoutRef, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { ChevronDown, ChevronRight, CirclePause, Code2, Eye, FileText, Folder, FolderOpen, FolderPlus, Layers2, LoaderCircle, PanelRight, Plus, Save, Search, Trash2, Undo2, X } from "lucide-react";
import { AccessibleDialog } from "./AccessibleDialog";
import { desktopApi } from "./api";
import { ContextMenu } from "./ContextMenu";
import type { BoardDocument, MountInfo, NoteFileInfo, TrashItem } from "./types";
import "./library-tree.css";

type Locale = "zh-CN" | "en";
type ReadingMode = "source" | "preview" | "split";
type FileTreeNode = { name: string; path: string; children: FileTreeNode[]; files: NoteFileInfo[] };
type NoteTab = { id: string; file: NoteFileInfo | null; title: string };
type TabMenuState = { tab: NoteTab; x: number; y: number } | null;
type LibraryMenuState = {
  x: number;
  y: number;
  target: { type: "folder" | "note"; file?: NoteFileInfo; path: string; label: string } | { type: "board"; board: BoardDocument } | { type: "mount"; mount: MountInfo } | { type: "trash"; item: TrashItem };
} | null;
const DRAFT_TAB_ID = "note:draft";

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

function TreeBranch({ node, selectedId, onSelect, onContextMenu, onMoveNote, depth = 0 }: { node: FileTreeNode; selectedId?: string; onSelect: (file: NoteFileInfo) => void; onContextMenu?: (event: React.MouseEvent, target: { type: "folder" | "note"; file?: NoteFileInfo; path: string; label: string }) => void; onMoveNote?: (sourcePath: string, destinationPath: string) => void; depth?: number }) {
  const [open, setOpen] = useState(true);
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
  return <div className={`${eventTargetClass(destinationPath)} ${dropActive ? "drop-target" : ""}`} onDragEnter={(event) => { if (!event.dataTransfer.types.includes("application/x-mobius-note")) return; dragDepth.current += 1; setDropActive(true); if (!open && (node.children.length || node.files.length)) { dragOpenTimer.current = window.setTimeout(() => setOpen(true), 650); } }} onDragLeave={(event) => { if (!event.dataTransfer.types.includes("application/x-mobius-note")) return; dragDepth.current = Math.max(0, dragDepth.current - 1); if (dragDepth.current === 0) setDropActive(false); if (dragOpenTimer.current !== null) { window.clearTimeout(dragOpenTimer.current); dragOpenTimer.current = null; } }} onDragOver={(event) => { if (event.dataTransfer.types.includes("application/x-mobius-note")) { event.preventDefault(); event.dataTransfer.dropEffect = "move"; } }} onDrop={handleDrop}>
    {node.name ? <button className="library-tree-folder" type="button" style={{ paddingInlineStart: 8 + depth * 14 }} onClick={() => setOpen((value) => !value)} onContextMenu={(event) => { event.preventDefault(); onContextMenu?.(event, { type: "folder", path: node.path, label: node.name }); }} aria-expanded={open}>{open ? <ChevronDown size={14}/> : <ChevronRight size={14}/>}<Folder size={15}/><span>{node.name}</span><small>{node.children.length + node.files.length}</small></button> : null}
    {open ? <div>{node.children.map((child) => <TreeBranch key={child.path} node={child} selectedId={selectedId} onSelect={onSelect} onContextMenu={onContextMenu} onMoveNote={onMoveNote} depth={depth + (node.name ? 1 : 0)}/>)}{node.files.map((file) => <button key={file.id} draggable={!file.read_only} className={selectedId === file.id ? "library-tree-file active" : "library-tree-file"} type="button" style={{ paddingInlineStart: 27 + (depth + (node.name ? 1 : 0)) * 14 }} onClick={() => onSelect(file)} onContextMenu={(event) => { event.preventDefault(); onContextMenu?.(event, { type: "note", file, path: file.real_path, label: file.title }); }} onDragStart={(event) => { if (file.read_only) { event.preventDefault(); return; } event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("application/x-mobius-note", file.real_path); }} title={file.virtual_path}><FileText size={14}/><span>{file.title}</span>{file.read_only ? <CirclePause size={12}/> : null}</button>)}</div> : null}
  </div>;
}

function eventTargetClass(path: string) {
  return path ? "library-tree-node" : "library-tree-node library-tree-root-drop";
}

function samePath(left: string, right: string) {
  const normalize = (value: string) => value.replace(/\\/g, "/").replace(/^\/\/\?\//, "").replace(/\/+$/, "").toLocaleLowerCase();
  return normalize(left) === normalize(right);
}

function TreeSection({ icon, title, count, action, children, defaultOpen = true }: { icon: React.ReactNode; title: string; count: number; action?: React.ReactNode; children: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return <section className="library-tree-section"><header><button type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open}>{open ? <ChevronDown size={14}/> : <ChevronRight size={14}/>} {icon}<strong>{title}</strong><small>{count}</small></button>{action}</header>{open ? <div className="library-tree-children">{children}</div> : null}</section>;
}

function BoardBranch({ board, boards, depth, onOpen, onContextMenu }: { board: BoardDocument; boards: BoardDocument[]; depth: number; onOpen: (id: string) => void; onContextMenu?: (event: React.MouseEvent, board: BoardDocument) => void }) {
  const children = boards.filter((candidate) => ((candidate.data.scene as { parentId?: string | null } | undefined)?.parentId ?? null) === board.id);
  const [open, setOpen] = useState(true);
  return <div className="library-board-branch">
    <div className="library-board-row" style={{ paddingInlineStart: 8 + depth * 14 }}>
      {children.length ? <button className="library-tree-toggle" type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open} aria-label={`${open ? "Collapse" : "Expand"} ${board.title}`}>{open ? <ChevronDown size={14}/> : <ChevronRight size={14}/>}</button> : <span className="library-tree-spacer"/>}
      <button className="library-tree-file" type="button" onClick={() => onOpen(board.id)} onContextMenu={(event) => { event.preventDefault(); onContextMenu?.(event, board); }} title={new Date(board.updated_at).toLocaleString()}><Layers2 size={14}/><span>{board.title}</span></button>
    </div>
    {open ? children.map((child) => <BoardBranch key={child.id} board={child} boards={boards} depth={depth + 1} onOpen={onOpen} onContextMenu={onContextMenu}/>) : null}
  </div>;
}

function MountBranch({ mountInfo, files, selectedId, locale, onSelect, onUnmount, onContextMenu, onMountContextMenu }: { mountInfo: MountInfo; files: NoteFileInfo[]; selectedId?: string; locale: Locale; onSelect: (file: NoteFileInfo) => void; onUnmount: () => void; onContextMenu?: (event: React.MouseEvent, target: { type: "folder" | "note"; file?: NoteFileInfo; path: string; label: string }) => void; onMountContextMenu?: (event: React.MouseEvent, mount: MountInfo) => void }) {
  const [open, setOpen] = useState(true);
  const itemCount = files.length;
  return <section className="library-mount-branch">
    <header className="library-mount-head">
      <button className="library-mount-toggle" type="button" onClick={() => setOpen((value) => !value)} onContextMenu={(event) => { event.preventDefault(); onMountContextMenu?.(event, mountInfo); }} aria-expanded={open} aria-label={`${open ? (locale === "zh-CN" ? "折叠" : "Collapse") : (locale === "zh-CN" ? "展开" : "Expand")} ${mountInfo.virtual_path}`}>{open ? <ChevronDown size={14}/> : <ChevronRight size={14}/>}<FolderOpen size={14}/><span title={mountInfo.real_path}>{mountInfo.virtual_path}</span><small>{itemCount}</small></button>
      <button className="icon-soft" type="button" onClick={onUnmount} title={locale === "zh-CN" ? "取消挂载" : "Unmount"}><X size={12}/></button>
    </header>
    {open ? <TreeBranch node={noteTree(files, mountInfo.virtual_path)} selectedId={selectedId} onSelect={onSelect} onContextMenu={onContextMenu}/> : null}
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

function MarkdownPreview({ markdown, sourcePath, text }: { markdown: string; sourcePath: string | null; text: ReturnType<typeof copy> }) {
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
}

export function NotesLibraryV2({ onError, onToast, locale, onOpenCanvas }: { onError: (message: string) => void; onToast: (message: string) => void; locale: Locale; onOpenCanvas?: (boardId?: string) => void }) {
  const text = copy(locale);
  const [files, setFiles] = useState<NoteFileInfo[]>([]); const [mounts, setMounts] = useState<MountInfo[]>([]); const [boards, setBoards] = useState<BoardDocument[]>([]); const [trash, setTrash] = useState<TrashItem[]>([]); const [selected, setSelected] = useState<NoteFileInfo | null>(null);
  const [title, setTitle] = useState(""); const [body, setBody] = useState(""); const [query, setQuery] = useState(""); const [mode, setMode] = useState<ReadingMode>("source");
  const [mountOpen, setMountOpen] = useState(false); const [mountPath, setMountPath] = useState("D:\\DataVault\\"); const [virtualPath, setVirtualPath] = useState("Reference"); const mountPathRef = useRef<HTMLInputElement>(null);
  const [saving, setSaving] = useState(false); const [reading, setReading] = useState(false); const [saveState, setSaveState] = useState<"idle" | "dirty" | "saved" | "error">("idle"); const lastSaved = useRef(""); const saveInFlight = useRef(false); const titleValueRef = useRef(""); const bodyValueRef = useRef("");
  const [openTabs, setOpenTabs] = useState<NoteTab[]>([]); const [activeTabId, setActiveTabId] = useState<string | null>(null); const [tabMenu, setTabMenu] = useState<TabMenuState>(null); const [libraryMenu, setLibraryMenu] = useState<LibraryMenuState>(null); const [createMenuOpen, setCreateMenuOpen] = useState(false);
  const [navWidth, setNavWidth] = useState(() => { const value = Number(localStorage.getItem("mobius.library.nav-width")); return Number.isFinite(value) && value >= 220 && value <= 480 ? value : 285; });
  const splitterStart = useRef<{ x: number; width: number } | null>(null);
  useEffect(() => { localStorage.setItem("mobius.library.nav-width", String(navWidth)); }, [navWidth]);
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
  const reload = useCallback(async () => { try { const [nextFiles, nextMounts, nextBoards, nextTrash] = await Promise.all([desktopApi.listNoteFiles(), desktopApi.listNoteMounts(), desktopApi.listBoards(), desktopApi.listTrash()]); setFiles(nextFiles); setMounts(nextMounts); setBoards(nextBoards); setTrash(nextTrash); return nextFiles; } catch (reason) { onError(String(reason)); return []; } }, [onError]);
  useEffect(() => { void reload(); }, [reload]);
  const draftKey = `${title}\u0000${body}`;
  const select = useCallback(async (file: NoteFileInfo) => {
    setSelected(file); setActiveTabId(file.id); setOpenTabs((current) => current.some((tab) => tab.id === file.id) ? current : [...current, { id: file.id, file, title: file.title }].slice(-12)); setTitle(file.title); setBody(""); setMode(file.read_only ? "preview" : "source"); setReading(true);
    try { const raw = await desktopApi.readNoteFile(file.real_path); const next = file.read_only ? raw : editableNoteBody(raw, file.title); titleValueRef.current = file.title; bodyValueRef.current = next; setBody(next); lastSaved.current = `${file.title}\u0000${next}`; setSaveState("saved"); } catch (reason) { setSaveState("error"); onError(String(reason)); } finally { setReading(false); }
  }, [onError]);
  const create = useCallback(() => { setSelected(null); setActiveTabId(DRAFT_TAB_ID); setOpenTabs((current) => current.some((tab) => tab.id === DRAFT_TAB_ID) ? current : [...current, { id: DRAFT_TAB_ID, file: null, title: "" }].slice(-12)); titleValueRef.current = ""; bodyValueRef.current = ""; setTitle(""); setBody(""); setMode("source"); lastSaved.current = ""; setSaveState("idle"); }, []);
  const save = useCallback(async (quiet = false) => {
    const savedTitle = titleValueRef.current.trim(); const savedBody = bodyValueRef.current;
    if (!savedTitle || selected?.read_only || saveInFlight.current) return;
    saveInFlight.current = true; setSaving(true);
    try {
      setSaveState("dirty");
      const draft = { title: savedTitle, body: savedBody, project_slug: null, tags: [], source_ids: [] };
      const record = selected ? await desktopApi.updateNoteFile(selected.real_path, draft) : await desktopApi.createNote(draft);
      lastSaved.current = `${savedTitle}\u0000${savedBody}`;
      const nextFiles = await reload(); const updated = record.source_path ? nextFiles.find((file) => file.real_path === record.source_path) : undefined;
      if (updated) { setSelected(updated); setActiveTabId(updated.id); setOpenTabs((current) => current.map((tab) => tab.id === DRAFT_TAB_ID || tab.file?.real_path === updated.real_path ? { id: updated.id, file: updated, title: updated.title } : tab)); }
      setSaveState("saved");
      if (!quiet) onToast(locale === "zh-CN" ? "笔记已保存" : "Note saved");
    } catch (reason) { setSaveState("error"); onError(String(reason)); } finally { saveInFlight.current = false; setSaving(false); }
  }, [locale, onError, onToast, reload, selected]);
  useEffect(() => { if (reading || !title.trim() || selected?.read_only || draftKey === lastSaved.current || saving) return; const timer = window.setTimeout(() => void save(true), 600); return () => window.clearTimeout(timer); }, [draftKey, reading, save, saving, selected?.read_only, title]);
  const chooseFolder = async () => { try { const path = await desktopApi.pickDirectory(mountPath); if (path) setMountPath(path); } catch (reason) { onError(String(reason)); } };
  const mount = async () => { if (!mountPath.trim() || !virtualPath.trim()) return; try { await desktopApi.addNoteMount(mountPath.trim(), virtualPath.trim(), "read_only"); setMountOpen(false); await reload(); onToast(locale === "zh-CN" ? "目录已作为只读资料库挂载" : "Folder mounted read-only"); } catch (reason) { onError(String(reason)); } };
  const unmount = async (mountInfo: MountInfo) => { try { await desktopApi.removeNoteMount(mountInfo.id); if (selected?.mount_id === mountInfo.id) create(); await reload(); onToast(locale === "zh-CN" ? "已取消挂载，原文件未改动" : "Unmounted; original files are unchanged"); } catch (reason) { onError(String(reason)); } };
  const moveNote = async (sourcePath: string, destinationPath: string) => {
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
  };
  const trashNote = async (file: NoteFileInfo) => {
    if (file.read_only || !window.confirm(text.deleteConfirm)) return;
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
  const visible = files.filter((file) => `${file.title} ${file.virtual_path}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())); const visibleBoards = boards.filter((board) => board.title.toLocaleLowerCase().includes(query.toLocaleLowerCase())); const readOnly = !!selected?.read_only;
  const editableFiles = visible.filter((file) => !file.mount_id);
  const boardParent = (board: BoardDocument) => ((board.data.scene as { parentId?: string | null } | undefined)?.parentId ?? null);
  const closeTab = (tabId: string) => {
    const index = openTabs.findIndex((tab) => tab.id === tabId); if (index < 0) return;
    const next = openTabs.filter((tab) => tab.id !== tabId); setOpenTabs(next);
    if (activeTabId !== tabId) return;
    const replacement = next[Math.min(index, Math.max(0, next.length - 1))];
    if (replacement?.file) void select(replacement.file); else create();
  };
  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => { event.preventDefault(); splitterStart.current = { x: event.clientX, width: navWidth }; document.body.style.cursor = "col-resize"; document.body.style.userSelect = "none"; event.currentTarget.setPointerCapture?.(event.pointerId); };
  const keyboardResize = (event: ReactKeyboardEvent<HTMLDivElement>) => { if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return; event.preventDefault(); setNavWidth((value) => Math.max(220, Math.min(480, value + (event.key === "ArrowRight" ? 16 : -16)))); };
  return <div className="notes-library-v2" style={{ "--library-nav-width": `${navWidth}px` } as CSSProperties}>
    <aside className="notes-nav-v2"><header className="library-nav-header"><div><span>LOCAL LIBRARY</span><strong>{text.library}</strong></div><div className="library-create-wrap"><button className="primary-button library-create-button" type="button" aria-haspopup="menu" aria-expanded={createMenuOpen} onClick={() => setCreateMenuOpen((value) => !value)}><Plus size={14}/>{text.createMenu}</button>{createMenuOpen ? <div className="library-create-menu" role="menu"><button type="button" role="menuitem" onClick={() => { setCreateMenuOpen(false); create(); }}><FileText size={15}/><span><strong>{text.newNote}</strong><small>Markdown note</small></span></button>{onOpenCanvas ? <button type="button" role="menuitem" onClick={() => { setCreateMenuOpen(false); onOpenCanvas(); }}><Layers2 size={15}/><span><strong>{text.newCanvas}</strong><small>Infinite canvas</small></span></button> : null}</div> : null}</div></header><label className="notes-search-v2"><Search size={16}/><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={text.search}/></label><div className="library-tree-v2">
      <TreeSection icon={<Layers2 size={15}/>} title={text.canvases} count={visibleBoards.length} action={onOpenCanvas ? <button className="icon-soft" type="button" onClick={() => onOpenCanvas()} title={text.newCanvas}><Plus size={14}/></button> : null}>{visibleBoards.filter((board) => boardParent(board) === null).map((board) => <BoardBranch key={board.id} board={board} boards={visibleBoards} depth={0} onOpen={(id) => onOpenCanvas?.(id)} onContextMenu={(event, board) => setLibraryMenu({ x: event.clientX, y: event.clientY, target: { type: "board", board } })}/>)}{!visibleBoards.length ? <p>{locale === "zh-CN" ? "还没有画布" : "No canvases yet"}</p> : null}</TreeSection>
      <TreeSection icon={<FileText size={15}/>} title={locale === "zh-CN" ? "笔记" : "Notes"} count={editableFiles.length} action={<button className="icon-soft" type="button" onClick={create} title={text.newNote}><Plus size={14}/></button>}><TreeBranch node={noteTree(editableFiles, "MyDesk")} selectedId={selected?.id} onSelect={(file) => void select(file)} onMoveNote={(sourcePath, destinationPath) => void moveNote(sourcePath, destinationPath)} onContextMenu={(event, target) => setLibraryMenu({ x: event.clientX, y: event.clientY, target })}/></TreeSection>
      <TreeSection icon={<FolderPlus size={15}/>} title={locale === "zh-CN" ? "挂载" : "Mounts"} count={mounts.length} action={<button className="icon-soft" type="button" onClick={() => setMountOpen(true)} title={text.mount}><Plus size={14}/></button>}>{mounts.map((mountInfo) => <MountBranch key={mountInfo.id} mountInfo={mountInfo} files={visible.filter((file) => file.mount_id === mountInfo.id)} selectedId={selected?.id} locale={locale} onSelect={(file) => void select(file)} onUnmount={() => void unmount(mountInfo)} onContextMenu={(event, target) => setLibraryMenu({ x: event.clientX, y: event.clientY, target })} onMountContextMenu={(event, mount) => setLibraryMenu({ x: event.clientX, y: event.clientY, target: { type: "mount", mount } })}/>)}</TreeSection>
      <TreeSection icon={<Trash2 size={15}/>} title={text.trash} count={trash.length}>{trash.map((item) => <div key={item.id} className="library-trash-item" onContextMenu={(event) => { event.preventDefault(); setLibraryMenu({ x: event.clientX, y: event.clientY, target: { type: "trash", item } }); }}><Trash2 size={13}/><span title={item.original_path}>{item.title}</span><button className="icon-soft" type="button" onClick={() => void restoreTrash(item)} title={text.restoreItem}><Undo2 size={13}/></button></div>)}</TreeSection>
    </div></aside><div className="notes-library-splitter" role="separator" aria-orientation="vertical" aria-label="Resize library panel" tabIndex={0} onPointerDown={startResize} onKeyDown={keyboardResize}/>
    <section aria-busy={reading} className={`note-editor-v2 mode-${readOnly ? "preview" : mode}`}><div className="note-tabs-v2" role="tablist">{openTabs.map((tab) => { const active = activeTabId === tab.id; const tabTitle = tab.file?.id === selected?.id ? (title || tab.title) : (tab.file?.title || tab.title || text.untitled); return <div className={`note-tab-v2 ${active ? "active" : ""}`} key={tab.id}><button type="button" role="tab" aria-selected={active} onClick={() => { if (tab.file) void select(tab.file); else create(); }}><FileText size={13}/><span>{tabTitle}</span></button><button className="note-tab-close-v2" type="button" aria-label={`Close ${tabTitle}`} onClick={(event) => { event.stopPropagation(); closeTab(tab.id); }}><X size={12}/></button></div>; })}<button className="note-tab-new-v2" type="button" onClick={create} title={text.newNote}><Plus size={14}/></button></div><header><input value={title} onChange={(event) => { titleValueRef.current = event.target.value; setTitle(event.target.value); setSaveState("dirty"); }} readOnly={readOnly || reading} placeholder={text.untitled}/><div className="note-view-switch" role="group" aria-label={text.preview}><button className={mode === "source" ? "active" : ""} disabled={readOnly || reading} onClick={() => setMode("source")} title={text.source}><Code2 size={15}/><span>{text.source}</span></button><button className={mode === "preview" ? "active" : ""} disabled={reading} onClick={() => setMode("preview")} title={text.preview}><Eye size={15}/><span>{text.preview}</span></button><button className={mode === "split" ? "active" : ""} disabled={readOnly || reading} onClick={() => setMode("split")} title={text.split}><PanelRight size={15}/><span>{text.split}</span></button></div><div className="note-actions">{readOnly ? <button className="soft-button" type="button" onClick={() => { const copyTitle = `${title} copy`; setSelected(null); setActiveTabId(DRAFT_TAB_ID); setOpenTabs((current) => current.some((tab) => tab.id === DRAFT_TAB_ID) ? current : [...current, { id: DRAFT_TAB_ID, file: null, title: "" }].slice(-12)); titleValueRef.current = copyTitle; bodyValueRef.current = body; setTitle(copyTitle); setBody(body); setMode("source"); lastSaved.current = ""; setSaveState("dirty"); }}>Copy to note</button> : null}<button className="soft-button" onClick={create}><Plus size={15}/>{text.newNote}</button><button className="primary-button" disabled={saving || reading || readOnly || !title.trim()} onClick={() => void save()}>{saving ? <LoaderCircle className="spin" size={15}/> : <Save size={15}/>} {saving ? text.saving : text.save}</button></div></header><div className="note-content-v2">{!readOnly && mode !== "preview" ? <textarea disabled={reading} value={body} onChange={(event) => { bodyValueRef.current = event.target.value; setBody(event.target.value); setSaveState("dirty"); }} placeholder={text.noNotes}/> : null}{(readOnly || mode !== "source") ? <MarkdownPreview markdown={body} sourcePath={selected?.real_path ?? null} text={text}/> : null}</div>{selected ? <footer><span>{selected.virtual_path}</span><span className={`note-save-state ${saveState}`}>{readOnly ? (locale === "zh-CN" ? "只读挂载" : "Read-only mount") : saveState === "dirty" ? (locale === "zh-CN" ? "未保存" : "Unsaved changes") : saveState === "error" ? (locale === "zh-CN" ? "保存失败" : "Save failed") : saveState === "saved" ? (locale === "zh-CN" ? "已保存" : "Saved") : text.editable}</span></footer> : null}</section>
    {tabMenu ? <ContextMenu className="note-tab-context-menu-v2" x={tabMenu.x} y={tabMenu.y} onClose={() => setTabMenu(null)} items={[
      { id: "open-source", label: text.openSourceFolder, icon: <FolderOpen size={14}/>, disabled: !tabMenu.tab.file, onSelect: () => { if (tabMenu.tab.file) void desktopApi.revealNoteSource(tabMenu.tab.file.real_path).catch((reason) => onError(String(reason))); } },
      { id: "close-tab", label: text.closeTab, icon: <X size={14}/>, onSelect: () => closeTab(tabMenu.tab.id) },
      { id: "trash-tab", label: text.deleteItem, icon: <Trash2 size={14}/>, danger: true, disabled: !tabMenu.tab.file || !!tabMenu.tab.file?.read_only, onSelect: () => { if (tabMenu.tab.file) void trashNote(tabMenu.tab.file); } },
    ]}/> : null}
    {libraryMenu ? <ContextMenu x={libraryMenu.x} y={libraryMenu.y} onClose={() => setLibraryMenu(null)} items={libraryMenu.target.type === "note" ? [
      { id: "open-source", label: text.openSourceFolder, icon: <FolderOpen size={14}/>, onSelect: () => { const file = libraryMenu.target.type === "note" ? libraryMenu.target.file : undefined; if (file) void desktopApi.revealNoteSource(file.real_path).catch((reason) => onError(String(reason))); } },
      { id: "trash-note", label: text.deleteItem, icon: <Trash2 size={14}/>, danger: true, disabled: libraryMenu.target.file?.read_only, onSelect: () => { const file = libraryMenu.target.type === "note" ? libraryMenu.target.file : undefined; if (file) void trashNote(file); } },
    ] : libraryMenu.target.type === "board" ? [
      { id: "open-board", label: text.newCanvas, icon: <Layers2 size={14}/>, onSelect: () => onOpenCanvas?.(libraryMenu.target.type === "board" ? libraryMenu.target.board.id : undefined) },
      { id: "trash-board", label: text.deleteItem, icon: <Trash2 size={14}/>, danger: true, onSelect: () => { if (libraryMenu.target.type === "board") void trashBoard(libraryMenu.target.board); } },
    ] : libraryMenu.target.type === "mount" ? [
      { id: "unmount", label: text.remove, icon: <FolderOpen size={14}/>, danger: true, onSelect: () => { if (libraryMenu.target.type === "mount") void unmount(libraryMenu.target.mount); } },
    ] : libraryMenu.target.type === "trash" ? [
      { id: "restore", label: text.restoreItem, icon: <Undo2 size={14}/>, onSelect: () => { if (libraryMenu.target.type === "trash") void restoreTrash(libraryMenu.target.item); } },
      { id: "purge", label: text.purgeItem, icon: <Trash2 size={14}/>, danger: true, onSelect: () => { if (libraryMenu.target.type === "trash") void purgeTrash(libraryMenu.target.item); } },
    ] : [{ id: "folder-drop", label: text.moveInto, icon: <Folder size={14}/>, disabled: true, onSelect: () => undefined }]} /> : null}
    {mountOpen ? <AccessibleDialog title={text.mount} closeLabel={text.cancel} onClose={() => setMountOpen(false)} initialFocusRef={mountPathRef}><div className="mount-dialog-v2"><label className="form-label">{text.path}<div className="folder-picker-input"><input ref={mountPathRef} value={mountPath} onChange={(event) => setMountPath(event.target.value)}/><button className="soft-button" type="button" onClick={() => void chooseFolder()}><FolderOpen size={15}/>{text.choose}</button></div><small>{text.chooseHint}</small></label><label className="form-label">{text.name}<input value={virtualPath} onChange={(event) => setVirtualPath(event.target.value)}/></label><p>{text.mountHint}</p><div className="modal-actions"><button className="soft-button" onClick={() => setMountOpen(false)}>{text.cancel}</button><button className="primary-button" onClick={() => void mount()} disabled={!mountPath.trim() || !virtualPath.trim()}>{text.mounted}</button></div></div></AccessibleDialog> : null}
  </div>;
}
