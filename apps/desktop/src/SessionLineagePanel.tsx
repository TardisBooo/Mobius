import { useEffect, useMemo, useState } from "react";
import { ReactFlow, Background, Controls, useNodesState, type Node, type Edge } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { desktopApi } from "./api";
import type { AgentKind, LineageManifest, Message, RelayGraph, TerminalInfo, WorkspaceView } from "./types";
import "./session-lineage.css";
import { ContextMenu } from "./ContextMenu";
import { AccessibleDialog } from "./AccessibleDialog";

export function SessionLineagePanel({ graph, locale, onOpenSession, workspace, openTerminal }: {
  graph: RelayGraph; locale: "zh-CN" | "en"; onOpenSession: (id: string) => void;
  workspace: WorkspaceView; openTerminal: (terminal: TerminalInfo) => void;
}) {
  const zh = locale === "zh-CN";
  const [lineage, setLineage] = useState<LineageManifest | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [error, setError] = useState("");
  const [mode, setMode] = useState<"graph" | "list">("graph");
  const [query, setQuery] = useState("");
  const [displayNodes, setDisplayNodes, onNodesChange] = useNodesState<Node>([]);
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  const [sources, setSources] = useState<string[]>([]);
  const [review, setReview] = useState<Awaited<ReturnType<typeof desktopApi.prepareHandoffGraph>> | null>(null);
  const [reviewSources, setReviewSources] = useState<string[]>([]);
  const [target, setTarget] = useState<AgentKind>("codex");
  const [checkoutId, setCheckoutId] = useState(workspace.checkouts[0]?.id ?? "");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [aliasDraft, setAliasDraft] = useState("");
  const toggleSource = (id: string) => setSources(current => current.includes(id) ? current.filter(s => s !== id) : [...current, id]);
  const prepare = async () => {
    setBusy(true); setConfirmed(false); setError("");
    try { const entries = [...sources]; setReview(await desktopApi.prepareHandoffGraph(entries)); setReviewSources(entries); }
    catch (reason) { setError(String(reason)); } finally { setBusy(false); }
  };
  const launch = async () => {
    const checkout = workspace.checkouts.find(c => c.id === checkoutId);
    if (!review || !confirmed || !checkout || !reviewSources.length) return;
    setBusy(true); setError("");
    try {
      openTerminal(await desktopApi.startAgentHandoff(target, checkout.canonical_path, "Reference-only session handoff", {
        sourceSessionId: reviewSources[0], sourceMessageId: "", checkoutId: checkout.id, workspaceId: workspace.workspace.id,
      }, review.id)); setReview(null);
    } catch (reason) { setError(String(reason)); } finally { setBusy(false); }
  };
  const ids = [...new Set(graph.edges.flatMap(e => [e.source_session_id, ...(e.target_session_id ? [e.target_session_id] : [])]))];
  const key = JSON.stringify(ids.sort());
  useEffect(() => {
    let active = true; setError(""); setLineage(null); setSelected(null); setSources([]); setDisplayNodes([]);
    if (ids.length) void desktopApi.sessionLineage(ids).then(value => { if (active) setLineage(value); })
      .catch(reason => { if (active) setError(String(reason)); });
    return () => { active = false; };
  }, [key]);
  useEffect(() => {
    let active = true; setMessages([]);
    if (selected) void desktopApi.getSessionMessages(selected).then(value => {
      if (active) setMessages(value.filter(m => m.role === "user" || m.role === "assistant").slice(-2));
    }).catch(reason => { if (active) setError(String(reason)); });
    return () => { active = false; };
  }, [selected]);
  const ancestors = useMemo(() => {
    const found = new Set<string>(); const pending = selected ? [selected] : [];
    while (pending.length) {
      const id = pending.pop()!; if (found.has(id)) continue; found.add(id);
      for (const edge of lineage?.edges ?? []) if (edge.target === id) pending.push(edge.source);
    }
    return found;
  }, [lineage, selected]);
  const { nodes, edges } = useMemo(() => {
    if (!lineage) return { nodes: [] as Node[], edges: [] as Edge[] };
    const depth = new Map(lineage.nodes.map(n => [n.session_id, 0]));
    // The core has validated a DAG. Relax depth until stable, independent of dates.
    for (let pass = 0; pass < lineage.nodes.length; pass++) {
      let changed = false;
      for (const edge of lineage.edges) {
        const next = (depth.get(edge.source) ?? 0) + 1;
        if (next > (depth.get(edge.target) ?? 0)) { depth.set(edge.target, next); changed = true; }
      }
      if (!changed) break;
    }
    const rows = new Map<number, number>();
    return {
      nodes: [...lineage.nodes].sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? "")).map(n => {
        const column = depth.get(n.session_id) ?? 0; const row = rows.get(column) ?? 0; rows.set(column, row + 1);
        const match = !query || `${n.title} ${n.harness} ${n.native_id}`.toLowerCase().includes(query.toLowerCase());
        return { id: n.session_id, position: { x: column * 310, y: row * 185 },
          selected: selected === n.session_id, className: `lineage-node ${ancestors.has(n.session_id) ? "ancestor" : ""} ${match ? "" : "dimmed"}`,
          data: { label: <div><span>{n.harness?.toUpperCase() ?? "?"} · {n.updated_at ? new Date(n.updated_at).toLocaleString(locale) : (zh ? "时间未知" : "Time unknown")}</span>
            <strong>{n.title || n.native_id || n.session_id}</strong><code>{n.native_id ?? n.session_id}</code>
            <small>{n.source_status === "available" ? (zh ? "来源可定位" : "Source located") : n.source_status}</small></div> },
          sourcePosition: "right", targetPosition: "left",
        } as Node;
      }),
      edges: lineage.edges.map(e => ({ ...e, label: zh ? "交接" : "handoff", animated: false,
        style: { stroke: ancestors.has(e.source) && ancestors.has(e.target) ? "var(--m-accent)" : "var(--m-muted)" } })),
    };
  }, [lineage, selected, query, ancestors, zh, locale]);
  useEffect(() => {
    setDisplayNodes(current => nodes.map(node => {
      const existing = current.find(n => n.id === node.id);
      return existing ? { ...node, position: existing.position, measured: existing.measured } : node;
    }));
  }, [nodes, setDisplayNodes]);
  const detail = lineage?.nodes.find(n => n.session_id === selected);
  useEffect(() => { setAliasDraft(detail?.title ?? ""); }, [detail?.session_id, detail?.title]);
  const saveAlias = async () => {
    if (!detail || !aliasDraft.trim()) return;
    try {
      await desktopApi.setSessionAlias(detail.session_id, aliasDraft);
      setLineage(current => current ? { ...current, nodes: current.nodes.map(n => n.session_id === detail.session_id ? { ...n, title: aliasDraft.trim() } : n) } : current);
    } catch (reason) { setError(String(reason)); }
  };
  if (!ids.length) return <div className="relay-graph-empty">{zh ? "尚无交接关系；在会话中发起交接后将显示在这里。" : "No handoffs yet. Start a session handoff to record its lineage."}</div>;
  return <section className="session-lineage-panel">
    <header><strong>{zh ? "会话交接图谱" : "Session lineage"}</strong>
      <input className="lineage-search" aria-label={zh ? "定位节点" : "Find a node"} value={query} onChange={e => setQuery(e.target.value)} placeholder={zh ? "标题 / Harness / ID" : "Title / Harness / ID"}/>
      <button className="soft-button" aria-pressed={mode === "graph"} onClick={() => setMode("graph")}>{zh ? "图谱" : "Graph"}</button>
      <button className="soft-button" aria-pressed={mode === "list"} onClick={() => setMode("list")}>{zh ? "列表" : "List"}</button></header>
    <div><button className="soft-button" disabled={!sources.length || busy} onClick={() => void prepare()}>{zh ? `交接选中来源 (${sources.length})` : `Hand off selected sources (${sources.length})`}</button><small> {zh ? "Shift+点击可多选；多个来源会合并其祖先引用，不总结正文。" : "Shift-click to select multiple sources. Merge combines ancestor references, not summaries."}</small></div>
    <p>{zh ? "点击节点高亮祖先，双击查看会话。横向表示交接层级，不代表耗时。搜索仅淡化节点，不改变交接范围。" : "Select to highlight ancestors; double-click to inspect. Horizontal position means inheritance depth, not elapsed time. Search dims nodes without changing ancestry."}</p>
    {error && <p role="alert">{error}</p>}
    {!lineage && !error && <p role="status">{zh ? "正在定位来源…" : "Resolving sources…"}</p>}
    <div className="lineage-layout"><div className="lineage-stage">
      {mode === "graph" ? <ReactFlow key={key} nodes={displayNodes} edges={edges} fitView nodesConnectable={false} deleteKeyCode={null}
        onNodesChange={onNodesChange}
        onNodeClick={(event, node) => { setSelected(node.id); if (event.shiftKey) toggleSource(node.id); }} onNodeDoubleClick={(_, node) => onOpenSession(node.id)}
        onNodeContextMenu={(event, node) => { event.preventDefault(); setSelected(node.id); setMenu({ x: event.clientX, y: event.clientY, id: node.id }); }}
        minZoom={0.1} maxZoom={2}><Background/><Controls showInteractive={false}/></ReactFlow> :
        <div className="lineage-list">{lineage?.nodes.map(n => <div key={n.session_id}><input type="checkbox" aria-label={`${zh ? "选择来源" : "Select source"}: ${n.native_id}`} checked={sources.includes(n.session_id)} onChange={() => toggleSource(n.session_id)}/><button className="soft-button" aria-pressed={selected === n.session_id} onClick={() => setSelected(n.session_id)}>{n.harness} · {n.title ?? n.native_id}<small>{n.updated_at}</small></button></div>)}</div>}
    </div><aside className="lineage-detail" aria-label={zh ? "节点详情" : "Node details"}>
      {detail ? <><strong>{detail.title ?? detail.native_id}</strong>
        <label className="lineage-alias">{zh ? "显示名称（仅 Möbius）" : "Display name (Mobius only)"}<input className="lineage-search" maxLength={200} value={aliasDraft} onChange={e => setAliasDraft(e.target.value)}/></label>
        <button className="soft-button" disabled={!aliasDraft.trim() || aliasDraft.trim() === detail.title} onClick={() => void saveAlias()}>{zh ? "保存名称" : "Save name"}</button>
        <dl><dt>Harness</dt><dd>{detail.harness}</dd><dt>Session ID</dt><dd>{detail.native_id}</dd><dt>{zh ? "创建" : "Created"}</dt><dd>{detail.created_at ?? "—"}</dd><dt>{zh ? "更新" : "Updated"}</dt><dd>{detail.updated_at ?? "—"}</dd><dt>Checkout</dt><dd>{detail.checkout_id ?? "—"}</dd><dt>{zh ? "来源" : "Source"}</dt><dd>{detail.source_path ?? detail.source_status}</dd></dl>
        <strong>{zh ? "最近已索引片段（非完整性保证）" : "Latest indexed excerpts (coverage not guaranteed)"}</strong>
        {messages.map(m => <blockquote key={m.id}><small>{m.role} · {m.timestamp ?? "—"}</small><p>{m.content.slice(0, 600)}{m.content.length > 600 ? "…" : ""}</p></blockquote>)}
        <button className="soft-button" onClick={() => onOpenSession(detail.session_id)}>{zh ? "查看会话" : "Inspect session"}</button>
        <button className="soft-button" aria-pressed={sources.includes(detail.session_id)} onClick={() => toggleSource(detail.session_id)}>{sources.includes(detail.session_id) ? (zh ? "移出交接来源" : "Remove from handoff sources") : (zh ? "加入交接来源" : "Add to handoff sources")}</button>
        <button className="soft-button" onClick={() => { void navigator.clipboard.writeText(`@session:${detail.harness}/${detail.native_id}`).catch(reason => setError(String(reason))); }}>{zh ? "复制引用" : "Copy reference"}</button></> : <p>{zh ? "选择节点查看身份、时间和对话片段。" : "Select a node to inspect its identity, timestamps and excerpts."}</p>}
    </aside></div>
    {graph.edges.some(e => !e.target_session_id) && <p role="status">{zh ? "部分交接尚未识别到真实目标会话；未将其画成已完成关系。" : "Some handoffs have no verified target identity yet; they are not shown as completed edges."}</p>}
    {menu && <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)} items={[
      { id: "inspect", label: zh ? "查看会话" : "Inspect session", onSelect: () => onOpenSession(menu.id) },
      { id: "copy", label: zh ? "复制会话 ID" : "Copy session ID", onSelect: () => { void navigator.clipboard.writeText(menu.id).catch(reason => setError(String(reason))); } },
      { id: "ancestors", label: zh ? "高亮祖先" : "Highlight ancestors", onSelect: () => setSelected(menu.id) },
      { id: "source", label: zh ? "切换交接来源选择" : "Toggle handoff source", onSelect: () => toggleSource(menu.id) },
    ]}/>}
    {review && <AccessibleDialog title={zh ? "确认图谱交接" : "Review graph handoff"} closeLabel={zh ? "关闭" : "Close"} onClose={() => { if (!busy) setReview(null); }}>
      <div className="lineage-handoff-review"><p>{zh ? "仅传递以下图谱与来源引用。原生会话保持不变。" : "Only this graph and its source references are passed. Native sessions remain unchanged."}</p>
        <label>Harness<select value={target} disabled={busy} onChange={e => { setTarget(e.target.value as AgentKind); setConfirmed(false); }}>{["codex", "claude", "pi", "grok"].map(h => <option key={h} value={h}>{h}</option>)}</select></label>
        <label>{zh ? "目标工作目录" : "Target working directory"}<select value={checkoutId} disabled={busy} onChange={e => { setCheckoutId(e.target.value); setConfirmed(false); }}>{workspace.checkouts.map(c => <option key={c.id} value={c.id}>{c.branch ?? c.kind} · {c.canonical_path}</option>)}</select></label>
        <pre>{review.preview}</pre><label><input type="checkbox" checked={confirmed} disabled={busy} onChange={e => setConfirmed(e.target.checked)}/>{zh ? "确认以上来源与目标，并新建目标会话。" : "Approve these sources and target, and create a new target session."}</label>
        {error && <p role="alert">{error}</p>}<button className="primary-button" disabled={!confirmed || busy} onClick={() => void launch()}>{busy ? (zh ? "启动中…" : "Starting…") : (zh ? "新建会话并交接" : "Create session and hand off")}</button>
      </div></AccessibleDialog>}
  </section>;
}
