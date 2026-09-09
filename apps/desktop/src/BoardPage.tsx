import {
  Background,
  BackgroundVariant,
  Handle,
  NodeResizer,
  Position,
  ReactFlow,
  MarkerType,
  addEdge,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
  type ReactFlowInstance,
  type Viewport
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  ArrowUpRight, ChevronLeft, Copy, ExternalLink, File as FileIcon, FileAudio,
  FileImage, FileText, Film, Frame, Hand, ImageIcon, Layers2,
  Link2, Maximize2, Menu, Minimize2, MoreHorizontal, MousePointer2, Pencil, Plus, Redo2, Save,
  Shapes, StickyNote, Trash2, Type, Undo2, Upload, X, Highlighter, Eraser, MessageSquare
} from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./BoardPage.css";
// Keep the canvas' dynamically-loaded stylesheet on the same visual system as
// the shell. This import intentionally follows its feature CSS so static
// rich-card fallbacks cannot revert to the old warm-paper palette.
import "./retro-futurism.css";
import { desktopApi } from "./api";
import { useI18n } from "./i18n";
import type { BoardDocument, CanvasAssetInfo, LinkPreview as LinkPreviewRecord, NoteFileInfo } from "./types";

type CanvasKind = "sticky" | "text" | "shape" | "section" | "link" | "document" | "session" | "image" | "audio" | "video" | "pdf" | "file" | "board" | "drawing";
type ShapeKind = "rectangle" | "rounded" | "ellipse";
type UrlPreviewKind = LinkPreviewRecord["kind"];
type InkPoint = { x: number; y: number };
type ObjectMenuAnchor = { x: number; y: number };
type CanvasData = {
  kind: CanvasKind; title: string; body?: string; color?: string; shape?: ShapeKind; url?: string; asset?: CanvasAssetInfo;
  document?: { id: string; title: string; virtualPath: string; readOnly: boolean }; childBoardId?: string; sectionId?: string | null;
  points?: InkPoint[]; ink?: "pen" | "highlighter"; previewKind?: UrlPreviewKind; preview?: LinkPreviewRecord;
  onPatch?: (id: string, patch: Partial<CanvasData>) => void; onDelete?: (id: string) => void; onOpenBoard?: (id: string) => void;
  onMenu?: (id: string, anchor: ObjectMenuAnchor) => void; onRefreshPreview?: (id: string, url: string) => void;
};
type CanvasNode = Node<CanvasData>;
type StoredNode = Omit<CanvasNode, "data"> & { data: Omit<CanvasData, "onPatch" | "onDelete" | "onOpenBoard" | "onMenu" | "onRefreshPreview"> };
type Scene = { version: 4; nodes: StoredNode[]; edges: Edge[]; viewport: Viewport; parentId?: string | null };
type Snapshot = Pick<Scene, "nodes" | "edges" | "viewport"> & { title: string };
type Tool = "select" | "hand" | "pen" | "highlighter" | "eraser" | "sticky" | "text" | "shape" | "connector" | "section" | "document" | "session" | "link" | "image" | "video" | "board";

// Browser drag-and-drop still crosses the IPC boundary as a byte array. Keep
// its cap conservative until the native streaming importer lands; reads use
// raw IPC and previews remain demand-loaded below.
const MAX_IMPORT_BYTES = 25 * 1024 * 1024;
const INITIAL_VIEWPORT: Viewport = { x: 0, y: 0, zoom: 1 };
const emptyScene = (): Scene => ({ version: 4, nodes: [], edges: [], viewport: INITIAL_VIEWPORT, parentId: null });

export function BoardPage({ onToast, initialBoardId, onBackToLibrary }: {
  onToast: (message: string) => void;
  initialBoardId?: string;
  onBackToLibrary: () => void;
}) {
  const { locale, t } = useI18n();
  const zh = locale === "zh-CN";
  const [boards, setBoards] = useState<BoardDocument[]>([]);
  const [boardId, setBoardId] = useState<string>(() => crypto.randomUUID());
  const [boardTitle, setBoardTitle] = useState(zh ? "未命名画布" : "Untitled canvas");
  const [parentId, setParentId] = useState<string | null>(null);
  const [nodes, setNodes, rawNodesChange] = useNodesState<CanvasNode>([]);
  const [edges, setEdges, rawEdgesChange] = useEdgesState<Edge>([]);
  const [viewport, setViewport] = useState<Viewport>(INITIAL_VIEWPORT);
  const [instance, setInstance] = useState<ReactFlowInstance<CanvasNode, Edge> | null>(null);
  const [tool, setTool] = useState<Tool>("select");
  const [shape, setShape] = useState<ShapeKind>("rectangle");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [linkDraft, setLinkDraft] = useState<string | null>(null);
  const [documentPickerOpen, setDocumentPickerOpen] = useState(false);
  const [noteFiles, setNoteFiles] = useState<NoteFileInfo[]>([]);
  const [draggingFiles, setDraggingFiles] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [objectMenu, setObjectMenu] = useState<{ id: string; anchor: ObjectMenuAnchor } | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [historyIndex, setHistoryIndex] = useState(0);
  const [redoCount, setRedoCount] = useState(0);
  const history = useRef<Snapshot[]>([]);
  const redoHistory = useRef<Snapshot[]>([]);
  const dragOrigin = useRef(new Map<string, { x: number; y: number }>());
  const inkStroke = useRef<{ kind: "pen" | "highlighter"; points: InkPoint[] } | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const lastPointer = useRef<{ x: number; y: number } | null>(null);
  const autoPlacement = useRef(0);
  const imageInput = useRef<HTMLInputElement>(null);
  const videoInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const previewRequests = useRef(new Set<string>());
  const initialBoardResolved = useRef(false);
  const latestDraft = useRef<BoardDocument | null>(null);

  const label = useCallback((cn: string, en: string) => zh ? cn : en, [zh]);
  const patchNode = useCallback((id: string, patch: Partial<CanvasData>) => {
    recordHistory();
    setNodes((current) => current.map((node) => node.id === id ? { ...node, data: { ...node.data, ...patch } } : node));
    setDirty(true);
  // recordHistory is evaluated only when an editable node commits.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setNodes]);
  const deleteNode = useCallback((id: string) => {
    setNodes((current) => current.filter((node) => node.id !== id));
    setEdges((current) => current.filter((edge) => edge.source !== id && edge.target !== id));
    setSelectedId((current) => current === id ? null : current);
    setDirty(true);
  }, [setEdges, setNodes]);
  const openBoardById = useCallback((id: string) => {
    const found = boards.find((board) => board.id === id);
    if (found) openBoard(found);
    else onToast(label("画布尚未同步，请返回资料库后重新打开。", "Canvas is not synced yet. Return to Library and open it again."));
  // openBoard is declared below and intentionally read at execution time.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boards, label, onToast]);
  const requestLinkPreview = useCallback(async (id: string, rawUrl: string, force = false) => {
    const url = normalizeWebUrl(rawUrl);
    if (!url || (!force && previewRequests.current.has(id))) return;
    // Provider cards already have a deterministic local representation. Do
    // not race an unnecessary metadata round-trip against an explicit play
    // action: a pasted YouTube/X/Vimeo card must stay open once the user has
    // chosen its trusted embed.
    if (!force && fallbackLinkPreview(url, false).provider) return;
    previewRequests.current.add(id);
    const fallback = describeUrl(url);
    try {
      const preview = await desktopApi.fetchLinkPreview(url);
      setNodes((current) => current.map((node) => {
        if (node.id !== id || node.data.url !== url) return node;
        const currentFallback = describeUrl(url);
        return {
          ...node,
          data: {
            ...node.data,
            preview,
            previewKind: preview.kind,
            title: node.data.title === currentFallback.title ? preview.title : node.data.title,
            body: node.data.body === currentFallback.summary ? preview.description : node.data.body
          }
        };
      }));
    } catch {
      const preview = fallbackLinkPreview(url, true);
      setNodes((current) => current.map((node) => node.id === id && node.data.url === url ? {
        ...node,
        data: {
          ...node.data,
          preview,
          previewKind: preview.kind,
          body: node.data.body === fallback.summary ? preview.description : node.data.body
        }
      } : node));
    } finally {
      setDirty(true);
    }
  }, [setNodes]);
  const openObjectMenu = useCallback((id: string, anchor: ObjectMenuAnchor) => {
    const stage = stageRef.current?.getBoundingClientRect();
    if (!stage) return;
    const width = Math.min(252, Math.max(180, stage.width - 24));
    const height = 264;
    const x = Math.min(Math.max(12, anchor.x - stage.left + 8), Math.max(12, stage.width - width - 12));
    const y = Math.min(Math.max(12, anchor.y - stage.top + 8), Math.max(12, stage.height - height - 12));
    setSelectedId(id);
    setObjectMenu({ id, anchor: { x, y } });
  }, []);
  const decorate = useCallback((stored: StoredNode[] | CanvasNode[]) => stored.map((node) => ({
    ...node,
    data: { ...node.data, onPatch: patchNode, onDelete: deleteNode, onOpenBoard: (id: string) => void openBoardById(id), onMenu: openObjectMenu, onRefreshPreview: (id: string, url: string) => void requestLinkPreview(id, url, true) }
  })) as CanvasNode[], [deleteNode, openBoardById, openObjectMenu, patchNode, requestLinkPreview]);
  const serializableNodes = useCallback((source = nodes): StoredNode[] => source.map((node) => ({
    ...node,
    data: { kind: node.data.kind, title: node.data.title, body: node.data.body, color: node.data.color, shape: node.data.shape, url: node.data.url, asset: node.data.asset, document: node.data.document, childBoardId: node.data.childBoardId, sectionId: node.data.sectionId, points: node.data.points, ink: node.data.ink, previewKind: node.data.previewKind, preview: node.data.preview }
  })), [nodes]);
  const snapshot = useCallback((): Snapshot => ({ nodes: serializableNodes(), edges: structuredClone(edges), viewport: structuredClone(viewport), title: boardTitle }), [boardTitle, edges, serializableNodes, viewport]);
  const recordHistory = useCallback(() => {
    const next = [...history.current, snapshot()].slice(-100);
    history.current = next;
    setHistoryIndex(next.length);
    redoHistory.current = [];
    setRedoCount(0);
  }, [snapshot]);
  const resetHistory = useCallback(() => { history.current = []; redoHistory.current = []; setHistoryIndex(0); setRedoCount(0); }, []);
  const applySnapshot = useCallback((next: Snapshot) => {
    setNodes(decorate(next.nodes)); setEdges(structuredClone(next.edges)); setViewport(next.viewport); setBoardTitle(next.title); setDirty(true);
    requestAnimationFrame(() => instance?.setViewport(next.viewport, { duration: 120 }));
  }, [decorate, instance, setEdges, setNodes]);
  const undo = useCallback(() => { const previous = history.current.pop(); if (!previous) return; redoHistory.current.push(snapshot()); setHistoryIndex(history.current.length); setRedoCount(redoHistory.current.length); applySnapshot(previous); }, [applySnapshot, snapshot]);
  const redo = useCallback(() => { const next = redoHistory.current.pop(); if (!next) return; history.current.push(snapshot()); setHistoryIndex(history.current.length); setRedoCount(redoHistory.current.length); applySnapshot(next); }, [applySnapshot, snapshot]);

  const migrateScene = useCallback((data: Record<string, unknown>): Scene => {
    const legacy = data as unknown as { nodes?: StoredNode[]; edges?: Edge[]; viewport?: Viewport; scene?: Scene; parent_id?: string | null; parentId?: string | null };
    const raw = legacy.scene && Array.isArray(legacy.scene.nodes) ? legacy.scene : legacy;
    return { version: 4, nodes: Array.isArray(raw.nodes) ? raw.nodes.map((node) => ({ ...node, data: { ...node.data, kind: migrateKind(node.data.kind), sectionId: node.data.sectionId ?? null } })) : [], edges: Array.isArray(raw.edges) ? raw.edges : [], viewport: raw.viewport && Number.isFinite(raw.viewport.zoom) ? raw.viewport : INITIAL_VIEWPORT, parentId: raw.parentId ?? legacy.parent_id ?? legacy.parentId ?? null };
  }, []);
  const reloadBoards = useCallback(async () => { setLoading(true); try { setBoards(await desktopApi.listBoards()); } catch (error) { onToast(String(error)); } finally { setLoading(false); } }, [onToast]);
  useEffect(() => { void reloadBoards(); }, [reloadBoards]);
  useEffect(() => {
    const sync = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", sync);
    return () => document.removeEventListener("fullscreenchange", sync);
  }, []);
  // Boards created before rich bookmark cards stored only a URL. Hydrate each
  // legacy card once after it enters this board; reopening later uses the
  // persisted metadata and makes no duplicate request.
  useEffect(() => {
    for (const node of nodes) {
      if (node.data.kind === "link" && node.data.url && !node.data.preview) {
        void requestLinkPreview(node.id, node.data.url);
      }
    }
  }, [nodes, requestLinkPreview]);
  const openBoard = useCallback((board: BoardDocument) => {
    const scene = migrateScene(board.data); autoPlacement.current = 0; previewRequests.current.clear(); setBoardId(board.id); setBoardTitle(board.title); setParentId(scene.parentId ?? null); setNodes(decorate(scene.nodes)); setEdges(scene.edges); setViewport(scene.viewport); setDirty(false); setSelectedId(null); setObjectMenu(null); resetHistory();
    requestAnimationFrame(() => instance?.setViewport(scene.viewport, { duration: 160 }));
  }, [decorate, instance, migrateScene, resetHistory, setEdges, setNodes]);
  const createBoard = useCallback((parent: string | null = null) => { const id = crypto.randomUUID(); const title = label("未命名画布", "Untitled canvas"); autoPlacement.current = 0; previewRequests.current.clear(); setBoardId(id); setBoardTitle(title); setParentId(parent); setNodes([]); setEdges([]); setViewport(INITIAL_VIEWPORT); setDirty(false); setSelectedId(null); setObjectMenu(null); resetHistory(); }, [label, resetHistory, setEdges, setNodes]);
  // Navigating from the unified Library either opens the chosen board or
  // creates a clean unsaved board. There is intentionally no second board
  // manager inside the canvas itself.
  useEffect(() => {
    if (loading || initialBoardResolved.current) return;
    initialBoardResolved.current = true;
    const requested = initialBoardId ? boards.find((board) => board.id === initialBoardId) : null;
    if (requested) openBoard(requested);
    else if (!initialBoardId) createBoard();
    else onToast(label("找不到所选画布，已打开新画布。", "The selected canvas was not found; a new canvas is open."));
  }, [boards, createBoard, initialBoardId, label, loading, onToast, openBoard]);
  const save = useCallback(async (quiet = false) => {
    setSaving(true);
    try { const scene: Scene = { version: 4, nodes: serializableNodes(), edges, viewport, parentId }; await desktopApi.saveBoard({ id: boardId, title: boardTitle.trim() || label("未命名画布", "Untitled canvas"), project_slug: null, data: { version: 4, scene }, updated_at: new Date().toISOString() }); setDirty(false); await reloadBoards(); if (!quiet) onToast(label("画布已保存，媒体仅保存本地资产引用。", "Canvas saved; media are stored as local asset references.")); }
    catch (error) { onToast(String(error)); } finally { setSaving(false); }
  }, [boardId, boardTitle, edges, label, onToast, parentId, reloadBoards, serializableNodes, viewport]);

  // Keep a synchronous snapshot for the unmount path. React may remove the
  // canvas immediately when the user changes a rail section; invoking the
  // native save here prevents a last keystroke or drag from being discarded.
  useEffect(() => {
    latestDraft.current = dirty ? { id: boardId, title: boardTitle.trim() || label("未命名画布", "Untitled canvas"), project_slug: null, data: { version: 4, scene: { version: 4, nodes: serializableNodes(), edges, viewport, parentId } }, updated_at: new Date().toISOString() } : null;
  }, [boardId, boardTitle, dirty, edges, label, parentId, serializableNodes, viewport]);
  useEffect(() => () => {
    const draft = latestDraft.current;
    if (draft) void desktopApi.saveBoard(draft);
  }, []);

  useEffect(() => {
    if (!dirty || saving || loading) return;
    const timer = window.setTimeout(() => void save(true), 300);
    return () => window.clearTimeout(timer);
  }, [dirty, loading, save, saving]);

  const selectedSectionId = nodes.find((node) => node.id === selectedId && node.data.kind === "section")?.id ?? null;
  const placement = useCallback((point?: { x: number; y: number }) => {
    if (point) return point;
    const rect = stageRef.current?.getBoundingClientRect();
    const screenPoint = lastPointer.current ?? (rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : { x: window.innerWidth / 2, y: window.innerHeight / 2 });
    const base = instance?.screenToFlowPosition(screenPoint) ?? { x: 120, y: 120 };
    // Consecutive pastes form a predictable, non-overlapping grid rather than
    // stacking at the pointer. The previous second "group" only nudged cards
    // by 64px after six inserts, so imported media could cover notes and link
    // previews. Start at the user's point and then alternate left/right and
    // above/below: the first few cards remain visible around the insertion
    // point instead of marching off the right side of an infinite canvas.
    // A 430×330 cell clears the largest 380×280 media node.
    const ordinal = autoPlacement.current++;
    const columns = 3;
    const column = [0, 1, -1][ordinal % columns];
    const band = Math.floor(ordinal / columns);
    const row = band === 0 ? 0 : Math.ceil(band / 2) * (band % 2 ? 1 : -1);
    return { x: base.x + column * 430, y: base.y + row * 330 };
  }, [instance]);
  const addNode = useCallback((kind: CanvasKind, point?: { x: number; y: number }, extra: Partial<CanvasData> = {}) => {
    recordHistory(); const id = `${kind}-${crypto.randomUUID()}`;
    const data: CanvasData = { kind, title: defaultTitle(kind, zh), body: defaultBody(kind, zh), color: kind === "sticky" ? "amber" : "mist", shape: kind === "shape" ? shape : undefined, sectionId: kind === "section" ? null : selectedSectionId, ...extra, onPatch: patchNode, onDelete: deleteNode, onOpenBoard: (childId) => void openBoardById(childId), onMenu: openObjectMenu, onRefreshPreview: (linkId, url) => void requestLinkPreview(linkId, url, true) };
    const node: CanvasNode = { id, type: nodeTypeFor(kind), position: placement(point), data, style: sizeFor(kind), zIndex: kind === "section" ? -1 : 1 };
    setNodes((current) => kind === "section" ? [node, ...current] : [...current, node]); setSelectedId(id); setDirty(true); return id;
  }, [deleteNode, openBoardById, openObjectMenu, patchNode, placement, recordHistory, requestLinkPreview, selectedSectionId, setNodes, shape, zh]);
  const createNestedBoard = useCallback(async (point?: { x: number; y: number }) => {
    const childId = crypto.randomUUID(); const childTitle = label("子画布", "Nested canvas"); const childScene: Scene = { ...emptyScene(), parentId: boardId };
    try { await desktopApi.saveBoard({ id: childId, title: childTitle, project_slug: null, data: { version: 4, scene: childScene }, updated_at: new Date().toISOString() }); await reloadBoards(); addNode("board", point, { title: childTitle, childBoardId: childId, body: label("双击打开独立子画布", "Double-click to open its own canvas") }); onToast(label("已创建子画布。父画布会在保存时记录入口。", "Nested canvas created. Save this canvas to retain its entry.")); } catch (error) { onToast(String(error)); }
  }, [addNode, boardId, label, onToast, reloadBoards]);
  const addLink = useCallback((raw: string, point?: { x: number; y: number }, title?: string) => {
    const url = normalizeWebUrl(raw);
    if (!url) { onToast(label("请输入有效的 http 或 https 链接。", "Enter a valid http or https URL.")); return false; }
    const preview = describeUrl(url);
    const id = addNode("link", point, {
      title: title?.trim() || preview.title,
      url,
      previewKind: preview.kind,
      body: preview.summary
    });
    void requestLinkPreview(id, url);
    return true;
  }, [addNode, label, onToast, requestLinkPreview]);
  const importFiles = useCallback(async (files: File[], point?: { x: number; y: number }) => {
    let offset = 0;
    for (const file of files) {
      if (!file.size || file.size > MAX_IMPORT_BYTES) {
        onToast(label(`${file.name} 超过 25 MB，未导入。`, `${file.name} exceeds 25 MB and was not imported.`));
        continue;
      }
      try {
        const mime = file.type || inferMimeType(file.name);
        const asset = await desktopApi.importCanvasAsset(file.name, mime, new Uint8Array(await file.arrayBuffer()));
        const kind = localAssetKind(file.name, mime);
        addNode(kind, point ? { x: point.x + offset, y: point.y + offset } : undefined, { title: file.name, asset });
        offset += 28;
      } catch (error) { onToast(String(error)); }
    }
  }, [addNode, label, onToast]);
  const openDocumentPicker = useCallback(async () => { try { setNoteFiles(await desktopApi.listNoteFiles()); setDocumentPickerOpen(true); } catch (error) { onToast(String(error)); } }, [onToast]);
  const connect = useCallback((connection: Connection) => { if (!connection.source || !connection.target) return; recordHistory(); setEdges((current) => addEdge({ ...connection, type: "smoothstep", markerEnd: { type: MarkerType.ArrowClosed, color: "#61836d" }, className: "mobius-connector" }, current)); setDirty(true); setTool("select"); }, [recordHistory, setEdges]);
  const onNodesChange = useCallback((changes: Parameters<typeof rawNodesChange>[0]) => { rawNodesChange(changes); if (changes.some((change) => change.type === "position" || change.type === "dimensions")) setDirty(true); }, [rawNodesChange]);
  const onEdgesChange = useCallback((changes: Parameters<typeof rawEdgesChange>[0]) => { rawEdgesChange(changes); setDirty(true); }, [rawEdgesChange]);
  const onNodeDragStop = useCallback((_: MouseEvent | TouchEvent, moved: CanvasNode) => { const before = dragOrigin.current.get(moved.id); dragOrigin.current.delete(moved.id); if (!before) return; if (moved.data.kind === "section") { const dx = moved.position.x - before.x; const dy = moved.position.y - before.y; if (dx || dy) setNodes((current) => current.map((node) => node.data.sectionId === moved.id ? { ...node, position: { x: node.position.x + dx, y: node.position.y + dy } } : node)); } else { const containing = nodes.find((candidate) => candidate.data.kind === "section" && isInsideSection(moved, candidate)); patchNode(moved.id, { sectionId: containing?.id ?? null }); } setDirty(true); }, [nodes, patchNode, setNodes]);
  const onSelectionChange = useCallback(({ nodes: selected }: { nodes: CanvasNode[] }) => {
    setSelectedId(selected.length === 1 ? selected[0].id : null);
  }, []);
  const deleteSelected = useCallback(() => { const selected = nodes.filter((node) => node.selected).map((node) => node.id); if (!selected.length) return; recordHistory(); setNodes((current) => current.filter((node) => !selected.includes(node.id))); setEdges((current) => current.filter((edge) => !selected.includes(edge.source) && !selected.includes(edge.target))); setSelectedId(null); setDirty(true); }, [nodes, recordHistory, setEdges, setNodes]);
  const cloneSelected = useCallback(async () => { const selected = nodes.filter((node) => node.selected || node.id === selectedId); if (!selected.length) return; const content = JSON.stringify({ type: "mobius-canvas", nodes: serializableNodes(selected), edges: edges.filter((edge) => selected.some((node) => node.id === edge.source) && selected.some((node) => node.id === edge.target)) }); try { await navigator.clipboard.writeText(content); onToast(label("已复制选中对象。", "Selected objects copied.")); } catch { onToast(label("无法访问系统剪贴板。", "System clipboard is unavailable.")); } }, [edges, label, nodes, onToast, selectedId, serializableNodes]);
  const pasteScene = useCallback((raw: string) => { try { const parsed = JSON.parse(raw) as { type?: string; nodes?: StoredNode[]; edges?: Edge[] }; if (parsed.type !== "mobius-canvas" || !parsed.nodes?.length) return false; recordHistory(); const ids = new Map(parsed.nodes.map((node) => [node.id, crypto.randomUUID()])); const pasted = parsed.nodes.map((node) => ({ ...node, id: ids.get(node.id)!, position: { x: node.position.x + 48, y: node.position.y + 48 } })); setNodes((current) => [...current, ...decorate(pasted)]); setEdges((current) => [...current, ...(parsed.edges ?? []).map((edge) => ({ ...edge, id: crypto.randomUUID(), source: ids.get(edge.source)!, target: ids.get(edge.target)! }))]); setDirty(true); return true; } catch { return false; } }, [decorate, recordHistory, setEdges, setNodes]);
  const handleStageKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => { const target = event.target as HTMLElement; if (target.matches("input, textarea, select, video, audio")) return; if (event.key === "Escape") { setObjectMenu(null); setLinkDraft(null); return; } if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") { event.preventDefault(); event.shiftKey ? redo() : undo(); return; } if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "c") { event.preventDefault(); void cloneSelected(); return; } if (event.key === "Delete" || event.key === "Backspace") { event.preventDefault(); deleteSelected(); return; } if (event.key.toLowerCase() === "v") setTool("select"); if (event.key.toLowerCase() === "h") setTool("hand"); if (event.key.toLowerCase() === "n") setTool("sticky"); if (event.key.toLowerCase() === "t") setTool("text"); }, [cloneSelected, deleteSelected, redo, undo]);
  const handlePaste = useCallback((event: React.ClipboardEvent<HTMLDivElement>) => {
    // Canvas paste must never steal IME/input/textarea editing. It only handles
    // clipboard content while the open canvas itself owns focus.
    if (isEditableTarget(event.target)) return;
    const files = clipboardFiles(event.clipboardData);
    if (files.length) { event.preventDefault(); void importFiles(files); return; }
    const text = event.clipboardData.getData("text/plain").trim();
    if (!text) return;
    event.preventDefault();
    if (pasteScene(text)) return;
    const htmlUrl = extractClipboardUrl(event.clipboardData.getData("text/html"));
    if (normalizeWebUrl(text) || htmlUrl) { addLink(htmlUrl ?? text, undefined, htmlUrl ? text : undefined); return; }
    const session = exactSessionReference(text);
    if (session) { addNode("session", undefined, { title: session.title, body: text }); return; }
    // Prose becomes one editable card. This fixes the former no-op behaviour
    // and keeps paste as a single undoable action.
    addNode("text", undefined, { title: firstLine(text), body: text });
    setTool("select");
  }, [addLink, addNode, importFiles, pasteScene]);
  const beginInk = useCallback((event: React.MouseEvent) => {
    if (tool !== "pen" && tool !== "highlighter") return;
    if (!(event.target as Element).closest(".react-flow__pane")) return;
    const point = instance?.screenToFlowPosition({ x: event.clientX, y: event.clientY });
    if (!point) return;
    event.preventDefault();
    inkStroke.current = { kind: tool, points: [point] };
  }, [instance, tool]);
  const extendInk = useCallback((event: React.MouseEvent) => {
    const stroke = inkStroke.current;
    if (!stroke) return;
    const point = instance?.screenToFlowPosition({ x: event.clientX, y: event.clientY });
    if (!point) return;
    const last = stroke.points.at(-1);
    if (!last || Math.hypot(point.x - last.x, point.y - last.y) > 1.5) stroke.points.push(point);
  }, [instance]);
  const finishInk = useCallback(() => {
    const stroke = inkStroke.current;
    inkStroke.current = null;
    if (!stroke || stroke.points.length < 2) return;
    const bounds = inkBounds(stroke.points);
    const padding = stroke.kind === "highlighter" ? 12 : 8;
    recordHistory();
    const node: CanvasNode = {
      id: `drawing-${crypto.randomUUID()}`,
      type: "drawing",
      position: { x: bounds.minX - padding, y: bounds.minY - padding },
      data: { kind: "drawing", title: stroke.kind === "pen" ? "Pen stroke" : "Highlighter", points: stroke.points.map((point) => ({ x: point.x - bounds.minX + padding, y: point.y - bounds.minY + padding })), ink: stroke.kind, sectionId: null },
      style: { width: Math.max(bounds.width + padding * 2, padding * 2 + 1), height: Math.max(bounds.height + padding * 2, padding * 2 + 1) },
      draggable: false,
      connectable: false,
      zIndex: 3
    };
    setNodes((current) => [...current, node]);
    setDirty(true);
  }, [recordHistory, setNodes]);
  const stageClick = useCallback((event: React.MouseEvent) => {
    // React Flow reports .react-flow__pane as the click target, not its wrapper.
    // The prior target === currentTarget guard made placement tools look active
    // while doing nothing.
    setObjectMenu(null);
    if (["select", "hand", "connector", "pen", "highlighter", "eraser"].includes(tool)) return;
    if (!(event.target as Element).closest(".react-flow__pane")) return;
    const point = instance?.screenToFlowPosition({ x: event.clientX, y: event.clientY });
    lastPointer.current = { x: event.clientX, y: event.clientY };
    if (tool === "link") setLinkDraft("");
    else if (tool === "document") void openDocumentPicker();
    else if (tool === "image") imageInput.current?.click();
    else if (tool === "video") videoInput.current?.click();
    else if (tool === "board") void createNestedBoard(point);
    else if (isNodeTool(tool)) addNode(tool, point);
    if (!["link", "document", "image", "video"].includes(tool)) setTool("select");
  }, [addNode, createNestedBoard, instance, openDocumentPicker, tool]);
  const menuNode = nodes.find((node) => node.id === objectMenu?.id) ?? null;
  const focusNode = useCallback((id: string) => { const node = nodes.find((candidate) => candidate.id === id); if (node) { setSelectedId(id); instance?.fitView({ nodes: [node], padding: .55, duration: 180, maxZoom: 1.35 }); } }, [instance, nodes]);
  const moveLayer = useCallback((id: string, direction: "front" | "back") => { recordHistory(); setNodes((current) => current.map((node) => node.id === id ? { ...node, zIndex: direction === "front" ? 10 : -2 } : node)); setDirty(true); }, [recordHistory, setNodes]);
  const breadcrumb = useMemo(() => parentId ? boards.find((board) => board.id === parentId) : null, [boards, parentId]);
  const nodeTypes = useMemo(() => ({ sticky: StickyNode, text: TextNode, shape: ShapeNode, section: SectionNode, link: LinkNode, document: DocumentNode, session: SessionNode, media: MediaNode, board: NestedBoardNode, drawing: DrawingNode }), []);
  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen().catch(() => onToast(label("无法进入全屏模式。", "Fullscreen mode is unavailable.")));
  }, [label, onToast]);

  return <section className="mobius-board page-fill" aria-label={label("无限画布", "Infinite canvas")}>
    <div className="board-topbar"><div className="board-breadcrumb"><button onClick={onBackToLibrary} aria-label={label("返回资料库", "Back to Library")} title={label("返回资料库", "Back to Library")}><ChevronLeft/>{label("资料库", "Library")}</button>{breadcrumb ? <><span>/</span><button onClick={() => openBoardById(breadcrumb.id)}>{breadcrumb.title}</button></> : null}<span>/</span><input value={boardTitle} onChange={(event) => { setBoardTitle(event.target.value); setDirty(true); }} aria-label={label("画布标题", "Canvas title")}/></div><div className="board-top-actions"><span className={dirty ? "board-state dirty" : "board-state"}>{saving ? label("保存中", "Saving") : dirty ? label("待保存", "Unsaved") : label("已保存", "Saved")}</span><button className="board-icon-button" onClick={toggleFullscreen} aria-pressed={isFullscreen} aria-label={label("全屏", "Fullscreen")} title={label("全屏", "Fullscreen")}>{isFullscreen ? <Minimize2/> : <Maximize2/>}</button><button className="board-save" onClick={() => void save()} disabled={saving}><Save/>{t("Save")}</button></div></div>
    <div ref={stageRef} className="board-stage" data-tool={tool} tabIndex={0} onKeyDown={handleStageKeyDown} onPaste={handlePaste} onPointerDownCapture={(event) => {
      lastPointer.current = { x: event.clientX, y: event.clientY };
      if (!isEditableTarget(event.target) && !(event.target as Element).closest("button, a, video, audio, select")) event.currentTarget.focus({ preventScroll: true });
    }} onPointerMoveCapture={(event) => { lastPointer.current = { x: event.clientX, y: event.clientY }; }} onDoubleClick={(event) => { if (tool === "select" && (event.target as Element).closest(".react-flow__pane")) addNode("sticky", instance?.screenToFlowPosition({ x: event.clientX, y: event.clientY })); }} onDragEnter={(event) => { if (event.dataTransfer.types.includes("Files")) setDraggingFiles(true); }} onDragOver={(event) => { if (event.dataTransfer.types.includes("Files") || event.dataTransfer.types.includes("text/uri-list")) { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; } }} onDragLeave={(event) => { if (event.target === event.currentTarget) setDraggingFiles(false); }} onDrop={(event) => {
      const point = instance?.screenToFlowPosition({ x: event.clientX, y: event.clientY });
      const files = Array.from(event.dataTransfer.files);
      const droppedUrl = firstDroppedUrl(event.dataTransfer);
      if (!files.length && !droppedUrl) return;
      event.preventDefault(); setDraggingFiles(false);
      if (files.length) void importFiles(files, point);
      else if (droppedUrl) addLink(droppedUrl, point);
    }}>
      <ReactFlow key={boardId} nodes={nodes} edges={edges} nodeTypes={nodeTypes} onInit={setInstance} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={connect} onNodeDragStart={(_, node) => { recordHistory(); dragOrigin.current.set(node.id, { ...node.position }); }} onNodeDragStop={onNodeDragStop} onNodeClick={(event, node) => { if (!(event.target as Element).closest(".node-more")) setObjectMenu(null); if (tool === "eraser") { event.preventDefault(); recordHistory(); deleteNode(node.id); } }} onNodeContextMenu={(event, node) => { event.preventDefault(); openObjectMenu(node.id, { x: event.clientX, y: event.clientY }); }} onMouseDown={beginInk} onMouseMove={extendInk} onMouseUp={finishInk} onPaneClick={stageClick} onSelectionChange={onSelectionChange} onMoveEnd={(_, next) => { setViewport(next); setDirty(true); }} defaultViewport={viewport} minZoom={.12} maxZoom={2.75} panOnDrag={tool === "hand" ? true : tool === "pen" || tool === "highlighter" ? false : [1, 2]} selectionOnDrag={tool === "select"} multiSelectionKeyCode="Shift" deleteKeyCode={null} nodesDraggable={tool === "select"} nodesConnectable={tool === "connector"} connectOnClick={tool === "connector"} proOptions={{ hideAttribution: true }}><Background variant={BackgroundVariant.Dots} gap={22} size={1} color="rgba(76, 91, 78, .22)"/></ReactFlow>
      {loading ? <div className="board-loading"><span/><p>{label("正在读取画布…", "Loading canvases…")}</p></div> : null}
      {!loading && !nodes.length ? <EmptyCanvas onCreate={(next) => { setTool(next); if (next === "sticky") addNode("sticky"); }} zh={zh}/>: null}
      {draggingFiles ? <div className="board-drop"><Upload/><strong>{label("松开以导入本地资产", "Drop to import local assets")}</strong><small>{label("图片、视频、音频、PDF 或任意文件", "Images, video, audio, PDFs, or files")}</small></div> : null}
      <BoardToolbar tool={tool} shape={shape} zh={zh} onTool={setTool} onShape={setShape} onImage={() => imageInput.current?.click()} onVideo={() => videoInput.current?.click()} onFile={() => fileInput.current?.click()} onUndo={undo} onRedo={redo} canUndo={historyIndex > 0} canRedo={redoCount > 0}/>
      <div className="board-bottom-actions"><button onClick={() => setOutlineOpen((open) => !open)} aria-pressed={outlineOpen}><Menu/>{label("大纲", "Outline")}</button><button onClick={() => instance?.fitView({ padding: .18, duration: 180 })}>{label("适应画布", "Fit canvas")}</button><span>{Math.round((viewport.zoom || 1) * 100)}%</span></div>
      {outlineOpen ? <OutlineOverlay nodes={nodes} zh={zh} onClose={() => setOutlineOpen(false)} onFocus={focusNode}/> : null}
      {menuNode && objectMenu ? <ObjectMenu node={menuNode} anchor={objectMenu.anchor} zh={zh} onClose={() => setObjectMenu(null)} onDelete={() => { recordHistory(); deleteNode(menuNode.id); setObjectMenu(null); }} onCopy={() => void cloneSelected()} onLayer={moveLayer} onOpen={() => menuNode.data.childBoardId && openBoardById(menuNode.data.childBoardId)} onRefresh={() => menuNode.data.url && menuNode.data.onRefreshPreview?.(menuNode.id, menuNode.data.url)}/> : null}
      {linkDraft !== null ? <LinkComposer zh={zh} onClose={() => setLinkDraft(null)} onSubmit={(url) => { if (addLink(url)) setLinkDraft(null); }}/> : null}
      {documentPickerOpen ? <DocumentPicker files={noteFiles} zh={zh} onClose={() => setDocumentPickerOpen(false)} onPick={(file) => { addNode("document", undefined, { title: file.title, document: { id: file.id, title: file.title, virtualPath: file.virtual_path, readOnly: file.read_only }, body: file.virtual_path }); setDocumentPickerOpen(false); }}/> : null}
      <input ref={imageInput} hidden type="file" multiple accept="image/*" onChange={(event) => { void importFiles(Array.from(event.target.files ?? [])); event.target.value = ""; }}/><input ref={videoInput} hidden type="file" multiple accept="video/*" onChange={(event) => { void importFiles(Array.from(event.target.files ?? [])); event.target.value = ""; }}/><input ref={fileInput} hidden type="file" multiple accept="*/*" onChange={(event) => { void importFiles(Array.from(event.target.files ?? [])); event.target.value = ""; }}/>
    </div>
  </section>;
}

function BoardToolbar({ tool, shape, zh, onTool, onShape, onImage, onVideo, onFile, onUndo, onRedo, canUndo, canRedo }: { tool: Tool; shape: ShapeKind; zh: boolean; onTool: (tool: Tool) => void; onShape: (shape: ShapeKind) => void; onImage: () => void; onVideo: () => void; onFile: () => void; onUndo: () => void; onRedo: () => void; canUndo: boolean; canRedo: boolean }) { const label = (cn: string, en: string) => zh ? cn : en; const Button = ({ id, title, children, onClick, disabled }: { id?: Tool; title: string; children: React.ReactNode; onClick?: () => void; disabled?: boolean }) => <button className={id === tool ? "active" : ""} title={title} aria-label={title} disabled={disabled} onClick={() => onClick ? onClick() : id && onTool(id)}>{children}</button>; return <div className="board-toolbar" role="toolbar" aria-label={label("画布工具", "Canvas tools")}><Button id="select" title={label("选择 (V)", "Select (V)")}><MousePointer2/></Button><Button id="hand" title={label("平移 (H)", "Hand (H)")}><Hand/></Button><i/><Button id="pen" title={label("画笔", "Pen")}><Pencil/></Button><Button id="highlighter" title={label("荧光笔", "Highlighter")}><Highlighter/></Button><Button id="eraser" title={label("橡皮擦：点击对象删除", "Eraser: click an object to remove it")}><Eraser/></Button><i/><Button id="sticky" title={label("随笔 (N)", "Sticky note (N)")}><StickyNote/></Button><Button id="text" title={label("文本 (T)", "Text (T)")}><Type/></Button><span className="toolbar-combo"><Button id="shape" title={label("形状", "Shape")}><Shapes/></Button><select value={shape} onChange={(event) => { onShape(event.target.value as ShapeKind); onTool("shape"); }} aria-label={label("形状种类", "Shape type")}><option value="rectangle">▭</option><option value="rounded">▢</option><option value="ellipse">○</option></select></span><Button id="connector" title={label("箭头连线", "Arrow connector")}><Link2/></Button><Button id="section" title={label("分区框", "Frame")}><Frame/></Button><i/><Button id="document" title={label("文档引用", "Document reference")}><FileText/></Button><Button id="session" title={label("会话引用", "Session reference")}><MessageSquare/></Button><Button id="link" title={label("网页链接", "Web link")}><ExternalLink/></Button><Button title={label("图片", "Image")} onClick={onImage}><ImageIcon/></Button><Button title={label("视频", "Video")} onClick={onVideo}><Film/></Button><Button title={label("文件 / PDF / 音频", "File / PDF / audio")} onClick={onFile}><Upload/></Button><Button id="board" title={label("子画布", "Nested canvas")}><Layers2/></Button><i/><Button title={label("撤销", "Undo")} onClick={onUndo} disabled={!canUndo}><Undo2/></Button><Button title={label("重做", "Redo")} onClick={onRedo} disabled={!canRedo}><Redo2/></Button></div>; }
function EmptyCanvas({ onCreate, zh }: { onCreate: (tool: Tool) => void; zh: boolean }) { return <div className="canvas-empty"><div><Layers2/><h2>{zh ? "让工作自然铺开" : "Let work spread naturally"}</h2><p>{zh ? "双击空白处，或从下方工具栏放入第一张随笔。拖入媒体、粘贴链接、框选多个对象；画布只在你需要时显示管理工具。" : "Double-click the open space or place your first sticky below. Drop media, paste a link, or select several objects; management stays out of sight until you need it."}</p><button onClick={() => onCreate("sticky")}><Plus/>{zh ? "添加随笔" : "Add a sticky"}</button></div></div>; }
function OutlineOverlay({ nodes, zh, onClose, onFocus }: { nodes: CanvasNode[]; zh: boolean; onClose: () => void; onFocus: (id: string) => void }) { return <aside className="board-overlay outline-overlay"><header><div><span>{zh ? "大纲" : "Outline"}</span><small>{nodes.length} {zh ? "个对象" : "objects"}</small></div><button onClick={onClose}><X/></button></header><div>{nodes.map((node) => <button key={node.id} onClick={() => { onFocus(node.id); onClose(); }}>{iconForKind(node.data.kind)}<span><strong>{node.data.title || (zh ? "未命名" : "Untitled")}</strong><small>{kindLabel(node.data.kind, zh)}</small></span></button>)}</div></aside>; }
function ObjectMenu({ node, anchor, zh, onClose, onDelete, onCopy, onLayer, onOpen, onRefresh }: { node: CanvasNode; anchor: ObjectMenuAnchor; zh: boolean; onClose: () => void; onDelete: () => void; onCopy: () => void; onLayer: (id: string, direction: "front" | "back") => void; onOpen: () => void; onRefresh: () => void }) {
  const label = (cn: string, en: string) => zh ? cn : en;
  const openOriginal = () => { if (node.data.url) window.open(node.data.url, "_blank", "noopener,noreferrer"); };
  return <aside className="board-object-menu" data-object-menu style={{ left: anchor.x, top: anchor.y }} onPointerDown={(event) => event.stopPropagation()}>
    <header><span>{iconForKind(node.data.kind)}</span><div><strong>{node.data.title || label("未命名对象", "Untitled object")}</strong><small>{kindLabel(node.data.kind, zh)}</small></div><button onClick={onClose} aria-label={label("关闭对象菜单", "Close object menu")}><X/></button></header>
    {node.data.url ? <><button onClick={openOriginal}><ExternalLink/>{label("打开原始链接", "Open original")}</button><button onClick={onRefresh}><Redo2/>{label("刷新预览", "Refresh preview")}</button></> : null}
    <button onClick={() => { void onCopy(); }}><Copy/>{label("复制选中对象", "Copy selection")}</button>
    {node.data.kind === "board" ? <button onClick={onOpen}><ArrowUpRight/>{label("打开子画布", "Open nested canvas")}</button> : null}
    <div><button onClick={() => onLayer(node.id, "front")}>{label("置于最前", "Bring to front")}</button><button onClick={() => onLayer(node.id, "back")}>{label("置于最后", "Send to back")}</button></div>
    <button className="danger" onClick={onDelete}><Trash2/>{label("删除对象", "Delete object")}</button>
  </aside>;
}
function LinkComposer({ zh, onClose, onSubmit }: { zh: boolean; onClose: () => void; onSubmit: (url: string) => void }) { const [url, setUrl] = useState(""); return <form className="board-modal" onSubmit={(event) => { event.preventDefault(); onSubmit(url); }}><header><div><ExternalLink/><strong>{zh ? "添加网页卡片" : "Add web card"}</strong></div><button type="button" onClick={onClose}><X/></button></header><input autoFocus value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://example.com"/><p>{zh ? "粘贴后会提取标题、简介和封面；YouTube/Vimeo 以卡片展示，点击播放才加载受信任嵌入。所有链接均可继续编辑或刷新。" : "Paste to fetch a title, description, and cover. YouTube/Vimeo remain a card until you choose to play the trusted embed; every link stays editable and refreshable."}</p><footer><button type="button" onClick={onClose}>{zh ? "取消" : "Cancel"}</button><button className="primary" type="submit">{zh ? "加入画布" : "Add to canvas"}</button></footer></form>; }
function DocumentPicker({ files, zh, onClose, onPick }: { files: NoteFileInfo[]; zh: boolean; onClose: () => void; onPick: (file: NoteFileInfo) => void }) { return <aside className="board-modal document-picker"><header><div><FileText/><strong>{zh ? "引用资料库文档" : "Reference a library document"}</strong></div><button onClick={onClose}><X/></button></header><p>{zh ? "引用只保存路径和文档标识，不复制文件内容。" : "References save the document identity and path, not a file copy."}</p><div>{files.length ? files.map((file) => <button key={file.id} onClick={() => onPick(file)}><FileText/><span><strong>{file.title}</strong><small>{file.virtual_path}{file.read_only ? ` · ${zh ? "只读" : "Read-only"}` : ""}</small></span></button>) : <p>{zh ? "尚未挂载可引用的文档。请先在资料库挂载目录。" : "No mountable documents yet. Mount a directory in Library first."}</p>}</div></aside>; }
function NodeChrome({ id, data, children, className }: NodeProps<CanvasNode> & { children: React.ReactNode; className: string }) {
  const openMenu = (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    data.onMenu?.(id, { x: event.clientX, y: event.clientY });
  };
  // Capture the context action so nested editable fields and provider previews
  // cannot consume it before the card receives the request.
  return <article className={`mobius-node ${className}`} onContextMenuCapture={openMenu}>
    <NodeResizer minWidth={190} minHeight={96} lineClassName="mobius-resize-line" handleClassName="mobius-resize-handle"/>
    <button className="node-more nodrag" onClick={openMenu} aria-label="Object actions"><MoreHorizontal/></button>{children}<Handle type="target" position={Position.Left}/><Handle type="source" position={Position.Right}/>
  </article>;
}
const StickyNode = memo(function StickyNode(props: NodeProps<CanvasNode>) { const { id, data } = props; return <NodeChrome {...props} className={`sticky-node ${data.color ?? "amber"}`}><BufferedInput value={data.title} onCommit={(title) => data.onPatch?.(id, { title })}/><BufferedTextarea value={data.body ?? ""} onCommit={(body) => data.onPatch?.(id, { body })} placeholder="…"/></NodeChrome>; });
const TextNode = memo(function TextNode(props: NodeProps<CanvasNode>) { const { id, data } = props; return <NodeChrome {...props} className="text-node"><BufferedTextarea value={data.body ?? data.title} onCommit={(body) => data.onPatch?.(id, { title: body.slice(0, 72), body })} placeholder="Start writing…"/></NodeChrome>; });
const ShapeNode = memo(function ShapeNode(props: NodeProps<CanvasNode>) { const { id, data } = props; return <NodeChrome {...props} className={`shape-node ${data.shape ?? "rectangle"}`}><BufferedInput value={data.title} onCommit={(title) => data.onPatch?.(id, { title })}/></NodeChrome>; });
const SectionNode = memo(function SectionNode(props: NodeProps<CanvasNode>) { const { id, data } = props; const openMenu = (event: React.MouseEvent) => { event.preventDefault(); event.stopPropagation(); data.onMenu?.(id, { x: event.clientX, y: event.clientY }); }; return <section className="section-node" onContextMenu={openMenu}><NodeResizer minWidth={360} minHeight={230} lineClassName="mobius-resize-line" handleClassName="mobius-resize-handle"/><header><Frame/><BufferedInput value={data.title} onCommit={(title) => data.onPatch?.(id, { title })}/><button className="node-more nodrag" onClick={openMenu} aria-label="Object actions"><MoreHorizontal/></button></header><p>{data.body}</p></section>; });
const LinkNode = memo(function LinkNode(props: NodeProps<CanvasNode>) {
  const { id, data } = props;
  const [embedOpen, setEmbedOpen] = useState(false);
  const [mediaFailed, setMediaFailed] = useState(false);
  const url = normalizeWebUrl(data.url ?? "");
  const descriptor = describeUrl(url ?? "");
  const preview = data.preview ?? fallbackLinkPreview(url ?? data.url ?? "", false);
  const previewKind = preview.kind;
  const hasVisual = !!preview.image_url && !mediaFailed;
  const canEmbed = !!preview.embed_url;
  const embedLabel = preview.provider === "x" ? "Load post preview" : previewKind === "video" ? "Play embed" : "Load preview";
  const commitUrl = (value: string) => {
    const next = normalizeWebUrl(value);
    if (!next) return;
    const nextDescriptor = describeUrl(next);
    data.onPatch?.(id, { url: next, previewKind: nextDescriptor.kind, preview: undefined });
    setEmbedOpen(false);
    setMediaFailed(false);
    data.onRefreshPreview?.(id, next);
  };
  return <NodeChrome {...props} className={`link-node link-${previewKind}${preview.provider ? ` provider-${preview.provider}` : ""}`}>
    <span className="link-domain"><Link2/>{preview.site_name || descriptor.domain}{previewKind !== "web" ? <em>{previewKind === "image" ? "IMAGE" : "VIDEO"}</em> : data.preview ? null : <em>LOADING</em>}</span>
    <BufferedInput value={data.title} onCommit={(title) => data.onPatch?.(id, { title })} ariaLabel="Card title"/>
    <div className={`link-preview nodrag nowheel ${embedOpen ? "is-embedded" : ""}`} aria-live="polite">
      {embedOpen && canEmbed ? <iframe className="link-embed" src={preview.embed_url ?? undefined} title={data.title} allow="accelerometer; autoplay; clipboard-write; encrypted-media; picture-in-picture; web-share" allowFullScreen/> : null}
      {embedOpen && !canEmbed && previewKind === "video" && url ? <video className="link-direct-video" src={url} controls preload="metadata" onError={() => setMediaFailed(true)}/> : null}
      {!embedOpen && hasVisual ? <img className="link-card-image" src={preview.image_url ?? undefined} alt={data.title} loading="lazy" referrerPolicy="no-referrer" onError={() => setMediaFailed(true)}/> : null}
      {!embedOpen && (!hasVisual || mediaFailed) ? <div className="link-preview-local"><span>{previewKind === "image" ? <FileImage/> : previewKind === "video" ? <Film/> : <ExternalLink/>}</span><strong>{preview.title || descriptor.pathLabel}</strong><small>{data.preview ? preview.description : "Fetching bookmark preview…"}</small></div> : null}
      {!embedOpen && (previewKind === "video" || canEmbed) ? <button className="link-play nodrag nopan" onClick={() => { setMediaFailed(false); setEmbedOpen(true); }}>{previewKind === "video" ? <Film/> : <ExternalLink/>}{canEmbed ? embedLabel : "Load video"}</button> : null}
    </div>
    <BufferedTextarea value={data.body ?? ""} onCommit={(body) => data.onPatch?.(id, { body })} placeholder="Add a note…" className="link-summary"/>
    <footer className="link-footer"><BufferedInput value={data.url ?? ""} onCommit={commitUrl} ariaLabel="Card URL" className="link-url"/><a className="nodrag nopan" href={url ?? undefined} target="_blank" rel="noreferrer" aria-label="Open original"><ExternalLink/></a></footer>
  </NodeChrome>;
});
const DocumentNode = memo(function DocumentNode(props: NodeProps<CanvasNode>) { const { id, data } = props; return <NodeChrome {...props} className="document-node"><FileText/><BufferedInput value={data.title} onCommit={(title) => data.onPatch?.(id, { title })}/><p>{data.document?.virtualPath ?? data.body}</p><small>{data.document?.readOnly ? "Read-only reference" : "Library reference"}</small></NodeChrome>; });
const SessionNode = memo(function SessionNode(props: NodeProps<CanvasNode>) { const { id, data } = props; return <NodeChrome {...props} className="document-node session-node"><MessageSquare/><BufferedInput value={data.title} onCommit={(title) => data.onPatch?.(id, { title })}/><p>{data.body || "Paste a portable @session reference here."}</p><small>Session reference</small></NodeChrome>; });
const NestedBoardNode = memo(function NestedBoardNode(props: NodeProps<CanvasNode>) { const { id, data } = props; return <NodeChrome {...props} className="nested-board-node"><Layers2/><BufferedInput value={data.title} onCommit={(title) => data.onPatch?.(id, { title })}/><p>{data.body}</p><button className="nodrag" onClick={() => data.childBoardId && data.onOpenBoard?.(data.childBoardId)}><ArrowUpRight/>Open</button></NodeChrome>; });
const DrawingNode = memo(function DrawingNode({ data }: NodeProps<CanvasNode>) {
  const points = data.points ?? [];
  if (points.length < 2) return null;
  const maxX = Math.max(...points.map((point) => point.x), 1);
  const maxY = Math.max(...points.map((point) => point.y), 1);
  const path = points.map((point, index) => `${index ? "L" : "M"}${point.x} ${point.y}`).join(" ");
  const highlighter = data.ink === "highlighter";
  return <svg className={`drawing-node ${highlighter ? "highlighter" : "pen"}`} viewBox={`0 0 ${maxX + 1} ${maxY + 1}`} preserveAspectRatio="none" aria-label={data.title} role="img"><path d={path} fill="none" strokeLinecap="round" strokeLinejoin="round" strokeWidth={highlighter ? 14 : 3.5}/></svg>;
});
const MediaNode = memo(function MediaNode(props: NodeProps<CanvasNode>) {
  const { id, data } = props;
  // Opening a board with many files must not allocate every binary blob at
  // once. Image previews start when the card is encountered; video/PDF/audio
  // stay a lightweight poster until a deliberate double-click.
  const [preview, setPreview] = useState(data.kind === "image");
  const url = useCanvasAssetUrl(data.asset, preview);
  const interactive = data.kind === "video" || data.kind === "audio" || data.kind === "pdf";
  return <NodeChrome {...props} className={`media-node ${data.kind}`}><header>{iconForKind(data.kind)}<BufferedInput value={data.title} onCommit={(title) => data.onPatch?.(id, { title })}/><small>{data.asset ? formatAssetSize(data.asset.size) : ""}</small></header><div className="media-content nodrag nowheel" onMouseEnter={() => data.kind === "image" && setPreview(true)} onDoubleClick={() => setPreview(true)}>{url && data.kind === "image" ? <img src={url} alt={data.title} draggable={false} loading="lazy"/> : null}{url && data.kind === "video" ? <video src={url} controls preload="metadata"/> : null}{url && data.kind === "audio" ? <audio src={url} controls preload="metadata"/> : null}{url && data.kind === "pdf" ? <iframe src={url} title={data.title}/> : null}{data.kind === "file" ? <div><FileIcon/><strong>{data.title}</strong><small>{data.asset?.mime_type}</small></div> : null}{!url && data.kind !== "file" ? <button className="media-poster nodrag nopan" onClick={() => setPreview(true)}>{iconForKind(data.kind)}<span>{interactive ? "Open local preview" : "Load local image"}</span></button> : null}</div></NodeChrome>;
});
function BufferedInput({ value, onCommit, className = "", ariaLabel }: { value: string; onCommit: (value: string) => void; className?: string; ariaLabel?: string }) { const [draft, setDraft] = useState(value); useEffect(() => setDraft(value), [value]); return <input className={`nodrag nopan ${className}`} aria-label={ariaLabel} value={draft} onChange={(event) => setDraft(event.target.value)} onBlur={() => { if (draft !== value) onCommit(draft); }}/>; }
function BufferedTextarea({ value, onCommit, placeholder, className = "" }: { value: string; onCommit: (value: string) => void; placeholder?: string; className?: string }) { const [draft, setDraft] = useState(value); useEffect(() => setDraft(value), [value]); return <textarea className={`nodrag nowheel nopan ${className}`} value={draft} onChange={(event) => setDraft(event.target.value)} onBlur={() => { if (draft !== value) onCommit(draft); }} placeholder={placeholder}/>; }
function useCanvasAssetUrl(asset: CanvasAssetInfo | undefined, enabled: boolean): string | null { const [url, setUrl] = useState<string | null>(null); useEffect(() => { let cancelled = false; let next: string | null = null; setUrl(null); if (!asset || !enabled) return; void desktopApi.readCanvasAsset(asset.id).then((bytes) => { if (cancelled) return; const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer; next = URL.createObjectURL(new Blob([buffer], { type: asset.mime_type })); setUrl(next); }).catch(() => undefined); return () => { cancelled = true; if (next) URL.revokeObjectURL(next); }; }, [asset, enabled]); return url; }
function inkBounds(points: InkPoint[]) { const xs = points.map((point) => point.x); const ys = points.map((point) => point.y); const minX = Math.min(...xs); const minY = Math.min(...ys); const maxX = Math.max(...xs); const maxY = Math.max(...ys); return { minX, minY, width: maxX - minX, height: maxY - minY }; }
function isNodeTool(tool: Tool): tool is Exclude<CanvasKind, "drawing" | "audio" | "pdf" | "file"> { return ["sticky", "text", "shape", "section", "session"].includes(tool); }
function defaultTitle(kind: CanvasKind, zh: boolean) { const cn: Record<CanvasKind, string> = { sticky: "随笔", text: "文本", shape: "形状", section: "新分区", link: "网页链接", document: "文档引用", session: "会话引用", image: "图片", audio: "音频", video: "视频", pdf: "PDF", file: "文件", board: "子画布", drawing: "笔迹" }; const en: Record<CanvasKind, string> = { sticky: "Sticky", text: "Text", shape: "Shape", section: "New section", link: "Web link", document: "Document reference", session: "Session reference", image: "Image", audio: "Audio", video: "Video", pdf: "PDF", file: "File", board: "Nested canvas", drawing: "Ink stroke" }; return (zh ? cn : en)[kind]; }
function defaultBody(kind: CanvasKind, zh: boolean) { if (kind === "section") return zh ? "拖动分区会同时移动其成员。" : "Dragging a section moves its members."; if (kind === "sticky") return zh ? "双击或直接写下想法。" : "Double-click or simply write the thought down."; if (kind === "session") return zh ? "粘贴 @session:provider/id#mN 或 #mN-mM 精确引用。" : "Paste an exact @session:provider/id#mN or #mN-mM reference."; return ""; }
function sizeFor(kind: CanvasKind) { if (kind === "section") return { width: 660, height: 420 }; if (kind === "sticky") return { width: 300, height: 210 }; if (kind === "text") return { width: 300, height: 150 }; if (kind === "shape") return { width: 250, height: 150 }; if (kind === "link") return { width: 360, height: 250 }; if (kind === "document" || kind === "session" || kind === "board") return { width: 310, height: 170 }; if (["image", "video", "pdf"].includes(kind)) return { width: 380, height: 280 }; return { width: 320, height: 150 }; }
function nodeTypeFor(kind: CanvasKind) { if (kind === "sticky") return "sticky"; if (kind === "text") return "text"; if (kind === "shape") return "shape"; if (kind === "section") return "section"; if (kind === "link") return "link"; if (kind === "document") return "document"; if (kind === "session") return "session"; if (kind === "board") return "board"; if (kind === "drawing") return "drawing"; return "media"; }
function migrateKind(kind: string): CanvasKind { if (kind === "note") return "sticky"; if (kind === "jot") return "text"; if (kind === "frame") return "section"; return ["sticky", "text", "shape", "section", "link", "document", "session", "image", "audio", "video", "pdf", "file", "board", "drawing"].includes(kind) ? kind as CanvasKind : "file"; }
function isInsideSection(node: CanvasNode, section: CanvasNode) { const width = Number(section.style?.width ?? 660); const height = Number(section.style?.height ?? 420); return node.position.x > section.position.x && node.position.y > section.position.y && node.position.x < section.position.x + width && node.position.y < section.position.y + height; }
function iconForKind(kind: CanvasKind) { if (kind === "image") return <FileImage/>; if (kind === "audio") return <FileAudio/>; if (kind === "video") return <Film/>; if (kind === "pdf" || kind === "document") return <FileText/>; if (kind === "session") return <MessageSquare/>; if (kind === "section") return <Frame/>; if (kind === "link") return <Link2/>; if (kind === "sticky") return <StickyNote/>; if (kind === "text") return <Type/>; if (kind === "shape") return <Shapes/>; if (kind === "drawing") return <Pencil/>; if (kind === "board") return <Layers2/>; return <FileIcon/>; }
function kindLabel(kind: CanvasKind, zh: boolean) { return defaultTitle(kind, zh); }
function formatAssetSize(value: number) { return value < 1024 * 1024 ? `${Math.max(1, Math.round(value / 1024))} KB` : `${(value / 1024 / 1024).toFixed(1)} MB`; }
function normalizeWebUrl(raw: string): string | null {
  try {
    const input = raw.trim();
    const hasScheme = /^https?:\/\//i.test(input);
    if (!input || /\s/.test(input)) return null;
    const parsed = new URL(hasScheme ? input : `https://${input}`);
    const looksLikeHost = parsed.hostname.includes(".") || parsed.hostname === "localhost" || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(parsed.hostname);
    return ["http:", "https:"].includes(parsed.protocol) && parsed.hostname && (hasScheme || looksLikeHost) ? parsed.toString() : null;
  } catch { return null; }
}
function fallbackLinkPreview(raw: string, failed: boolean): LinkPreviewRecord {
  const normalized = normalizeWebUrl(raw);
  if (!normalized) return { kind: "web", site_name: "Link", title: "Web link", description: failed ? "Preview unavailable. Open the original link to view it." : "Fetching bookmark preview…", image_url: null, embed_url: null, provider: null };
  const parsed = new URL(normalized);
  const host = parsed.hostname.replace(/^www\./i, "");
  const pathname = safeDecodePath(parsed.pathname || "/").replace(/\/$/, "") || "/";
  const lowerPath = pathname.toLowerCase();
  const youtubeId = frontendYouTubeId(parsed);
  if (youtubeId) return { kind: "video", site_name: "YouTube", title: "YouTube video", description: "Click play to open the YouTube embed in this canvas.", image_url: `https://i.ytimg.com/vi/${youtubeId}/hqdefault.jpg`, embed_url: `https://www.youtube-nocookie.com/embed/${youtubeId}?rel=0`, provider: "youtube" };
  const vimeoId = frontendVimeoId(parsed);
  if (vimeoId) return { kind: "video", site_name: "Vimeo", title: "Vimeo video", description: "Click play to open the Vimeo embed in this canvas.", image_url: null, embed_url: `https://player.vimeo.com/video/${vimeoId}`, provider: "vimeo" };
  const xPostId = /\/status\/(\d{1,32})/.exec(pathname)?.[1];
  if (/^(?:x|twitter)\.com$/i.test(host) && xPostId) return { kind: "web", site_name: "X", title: `X post · ${xPostId}`, description: "Load the trusted X post preview here, or open the original post.", image_url: null, embed_url: `https://platform.twitter.com/embed/Tweet.html?id=${xPostId}&dnt=true`, provider: "x" };
  const image = /\.(avif|bmp|gif|jpe?g|png|svg|webp)$/i.test(lowerPath);
  const video = /\.(m4v|mov|mp4|ogv|webm)$/i.test(lowerPath);
  const leaf = pathname.split("/").filter(Boolean).at(-1);
  return {
    kind: image ? "image" : video ? "video" : "web",
    site_name: host,
    title: leaf ? `${host} · ${leaf}` : host,
    description: failed ? "Preview unavailable. Open the original link to view it." : image ? "Image link" : video ? "Video link" : "Fetching bookmark preview…",
    image_url: image ? normalized : null,
    embed_url: null,
    provider: null
  };
}
function describeUrl(raw: string): { kind: UrlPreviewKind; domain: string; pathLabel: string; title: string; summary: string } {
  const preview = fallbackLinkPreview(raw, false);
  const normalized = normalizeWebUrl(raw);
  const pathLabel = normalized ? safeDecodePath(new URL(normalized).pathname || "/").split("/").filter(Boolean).at(-1) || preview.site_name : "Web link";
  return { kind: preview.kind, domain: preview.site_name, pathLabel, title: preview.title, summary: preview.description };
}
function frontendYouTubeId(url: URL): string | null {
  const host = url.hostname.replace(/^www\./i, "").toLowerCase();
  const candidate = host === "youtu.be" ? url.pathname.split("/").filter(Boolean)[0] : host === "youtube.com" || host.endsWith(".youtube.com") ? url.pathname.startsWith("/watch") ? url.searchParams.get("v") : url.pathname.split("/").filter(Boolean).slice(1)[0] : null;
  return candidate && /^[A-Za-z0-9_-]{6,32}$/.test(candidate) ? candidate : null;
}
function frontendVimeoId(url: URL): string | null {
  const host = url.hostname.replace(/^www\./i, "").toLowerCase();
  if (host !== "vimeo.com" && !host.endsWith(".vimeo.com")) return null;
  const candidate = url.pathname.split("/").filter(Boolean).find((segment) => /^\d{1,18}$/.test(segment));
  return candidate ?? null;
}
function localAssetKind(fileName: string, mime: string): CanvasKind {
  const normalized = mime.toLowerCase();
  if (normalized.startsWith("image/")) return "image";
  if (normalized.startsWith("video/")) return "video";
  if (normalized.startsWith("audio/")) return "audio";
  if (normalized === "application/pdf" || /\.pdf$/i.test(fileName)) return "pdf";
  return "file";
}
function inferMimeType(fileName: string) {
  const ext = fileName.split(".").at(-1)?.toLowerCase();
  const mime: Record<string, string> = {
    avif: "image/avif", bmp: "image/bmp", gif: "image/gif", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", svg: "image/svg+xml", webp: "image/webp",
    m4v: "video/x-m4v", mov: "video/quicktime", mp4: "video/mp4", ogv: "video/ogg", webm: "video/webm",
    m4a: "audio/mp4", mp3: "audio/mpeg", oga: "audio/ogg", ogg: "audio/ogg", wav: "audio/wav"
  };
  if (ext && mime[ext]) return mime[ext];
  if (/\.pdf$/i.test(fileName)) return "application/pdf";
  if (/\.(md|txt|csv|json|log)$/i.test(fileName)) return "text/plain";
  return "application/octet-stream";
}
function clipboardFiles(clipboard: DataTransfer) {
  const listed = Array.from(clipboard.files);
  if (listed.length) return listed;
  return Array.from(clipboard.items).filter((item) => item.kind === "file").map((item) => item.getAsFile()).filter((file): file is File => !!file);
}
function extractClipboardUrl(html: string): string | null {
  if (!html) return null;
  try { return normalizeWebUrl(new DOMParser().parseFromString(html, "text/html").querySelector("a[href]")?.getAttribute("href") ?? ""); } catch { return null; }
}
function firstDroppedUrl(transfer: DataTransfer): string | null {
  const uriList = transfer.getData("text/uri-list").split(/\r?\n/).find((line) => line && !line.startsWith("#"));
  return normalizeWebUrl(uriList || transfer.getData("text/plain"));
}
function exactSessionReference(value: string): { title: string } | null {
  const match = /^@session:([a-z0-9_-]+)\/([^\s#]+)(?:#m\d+(?:-m\d+)?)?$/i.exec(value.trim());
  return match ? { title: `${match[1]} · ${match[2]}` } : null;
}
function firstLine(value: string) { return value.split(/\r?\n/).find((line) => line.trim())?.trim().slice(0, 72) || "Text"; }
function isEditableTarget(target: EventTarget | null) { return target instanceof Element && !!target.closest("input, textarea, select, [contenteditable='true'], video, audio"); }
function safeDecodePath(value: string) { try { return decodeURIComponent(value); } catch { return value; } }
