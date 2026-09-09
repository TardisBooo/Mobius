import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowRight, AtSign, BookOpen, CheckCircle2, FolderGit2, GitFork, ScanSearch, ShieldCheck, TerminalSquare, Wrench, X } from "lucide-react";
import { desktopApi } from "./api";
import { useI18n } from "./i18n";
import { MobiusLogo } from "./MobiusLogo";
import type { ApprovedSessionSources, SessionSourceRoot } from "./types";
import "./onboarding.css";
import "./onboarding-v2.css";

type Step = 0 | 1 | 2 | 3 | 4 | 5;

function copy(locale: "zh-CN" | "en") {
  const zh = locale === "zh-CN";
  return {
    steps: zh ? ["为什么", "隐私边界", "会话来源", "继续工作", "交接轨迹", "资料与技能"] : ["Why Möbius", "Privacy", "Sources", "Resume work", "Handoffs", "Library & skills"],
    close: zh ? "关闭首次引导" : "Close first-run guide",
    valueTitle: zh ? "换 Agent，不必丢掉已经走过的路。" : "Switch agents without losing the path you already walked.",
    valueBody: zh ? "莫比乌斯把散落在 Codex、Claude Code、Pi 与 Grok 中的会话，重新按项目目录和 worktree 组织。找回原会话、在真实 PowerShell 中继续，或把完整工作轨迹交给另一个 Agent。" : "Möbius reorganizes sessions from Codex, Claude Code, Pi, and Grok by project directory and worktree. Find the original session, resume it in real PowerShell, or carry its full work trace into another agent.",
    findTitle: zh ? "从项目找到会话" : "Find sessions from the project",
    findBody: zh ? "工程树 → checkout → Agent → session。无需记住会话存在哪个工具。" : "Project tree → checkout → agent → session. You do not need to remember which tool owns the transcript.",
    continueTitle: zh ? "继续，而不是重新解释" : "Continue instead of re-explaining",
    continueBody: zh ? "原生 resume 保留原 Agent；跨 Agent 交接保留消息、工具调用、失败与修正。" : "Native resume keeps the original agent; handoff keeps messages, tool calls, failures, and corrections.",
    localTitle: zh ? "原始会话留在原处。索引只读且可核验。" : "Original sessions stay in place. The index is read-only and auditable.",
    localBody: zh ? "启动与刷新只检查已知 Harness 目录。莫比乌斯不改写历史，不默认搜索其他会话，也不会静默把它们注入当前上下文。" : "Startup and refresh inspect known harness roots only. Möbius never rewrites history, searches other sessions by default, or silently injects them into current context.",
    noAutoTitle: zh ? "默认不增加上下文" : "No context cost by default",
    noAutoBody: zh ? "只有主动复制 @session、运行 Mome 检索或确认交接后，内容才进入提示词并产生 token 消耗。" : "Content enters a prompt, and consumes tokens, only after you copy an @session reference, run Mome recall, or approve a handoff.",
    explicitTitle: zh ? "来源始终可追溯" : "Every source stays traceable",
    explicitBody: zh ? "引用指向精确 session 和消息；交接图保留每一轮来源与目标关系。" : "References identify an exact session and message; the relay graph preserves every source-to-target relationship.",
    sourceTitle: zh ? "确认来源，然后建立本地索引。" : "Review sources, then build the local index.",
    sourceBody: zh ? "莫比乌斯探测常规 Harness 根目录。你可以在会话页添加或移除明确来源；缺少适配的目录不会被全盘扫描。" : "Möbius probes conventional harness roots. Add or remove explicit sources from Sessions; unsupported locations are never discovered by scanning an entire disk.",
    roots: zh ? "已批准的只读来源" : "approved read-only roots",
    candidates: zh ? "发现的候选位置" : "discovered candidates",
    refresh: zh ? "建立或刷新索引" : "Build or refresh index",
    refreshing: zh ? "正在刷新…" : "Refreshing…",
    refreshed: zh ? "索引已刷新" : "Index refreshed",
    sourceEmpty: zh ? "当前未发现来源。稍后可在“会话 → 来源”中选择目录。" : "No source found yet. Choose a folder later from Sessions → Sources.",
    sourceLoading: zh ? "正在读取来源状态…" : "Reading source status…",
    resumeTitle: zh ? "日常动线只有三步。" : "Your everyday flow takes three steps.",
    resumeBody: zh ? "选择项目和 worktree，在会话列表预览内容，再点击“恢复原会话”。莫比乌斯会在该目录打开 PowerShell 并调用原 Agent 的原生 resume；也可以随时新建空白 PowerShell。" : "Choose a project and worktree, preview a session, then select Resume original. Möbius opens PowerShell in that directory and calls the agent's native resume. You can also start a blank PowerShell anytime.",
    handoffTitle: zh ? "换 Agent 时，传递轨迹，不只传摘要。" : "When changing agents, pass the trace, not just a summary.",
    handoffBody: zh ? "选择“交接给其他 Agent”，确认目标、消息范围、工具记录和 token 估算。目标会话在同一目录新建，原记录保持只读；多次交接会串成可查看的关系图。" : "Choose Handoff to another agent, then review the target, message range, tool records, and token estimate. A new target session starts in the same directory, the source stays read-only, and repeated handoffs form a visible relay graph.",
    exactTitle: zh ? "知道来源：精确引用" : "Know the source: exact reference",
    exactBody: zh ? "复制 @session:provider/id/message，粘贴到任何 Agent；内容由你控制。" : "Copy @session:provider/id/message into any agent. You control the payload.",
    recallTitle: zh ? "不知道来源：Mome 检索" : "Do not know the source: Mome recall",
    recallBody: zh ? "输入问题、限定项目与预算，再选择要带入的本地检索片段。" : "Enter a question, project scope, and budget, then select which local results to carry forward.",
    libraryTitle: zh ? "把会话之外的工作也留在同一个地方。" : "Keep the work around your sessions in one place.",
    libraryBody: zh ? "资料库包含 Markdown 笔记、无限画布和只读挂载目录，每一层均可折叠。技能页支持查看、编辑、安装、卸载与版本恢复，并区分全局和项目范围。" : "Library combines Markdown notes, infinite canvases, and read-only folder mounts with collapsible levels. Skills can be inspected, edited, installed, removed, and restored by version at global or project scope.",
    libraryCard: zh ? "资料库" : "Library", libraryCardBody: zh ? "笔记 · 画布 · 挂载 · Markdown 预览" : "Notes · canvas · mounts · Markdown preview",
    skillsCard: zh ? "技能" : "Skills", skillsCardBody: zh ? "全局/项目 · 市场 · 编辑 · 历史版本" : "Global/project · registry · edit · history",
    skip: zh ? "跳过并进入工作区" : "Skip and open workspaces", back: zh ? "返回" : "Back", next: zh ? "下一步" : "Next", enter: zh ? "开始使用莫比乌斯" : "Start using Möbius",
    approved: zh ? "已批准" : "Approved", candidate: zh ? "候选" : "Candidate",
  };
}

export function FirstRunOnboarding({ onClose, onNavigate, onError }: { onClose: () => void; onNavigate: (page: "workspaces" | "sessions") => void; onError: (error: string) => void }) {
  const { locale } = useI18n();
  const text = useMemo(() => copy(locale), [locale]);
  const [step, setStep] = useState<Step>(0);
  const [approved, setApproved] = useState<ApprovedSessionSources>({ version: 1, roots: [] });
  const [suggested, setSuggested] = useState<SessionSourceRoot[]>([]);
  const [loading, setLoading] = useState(false);
  const [scanState, setScanState] = useState<"idle" | "running" | "done">("idle");
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const priorFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    priorFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus(); setLoading(true);
    void Promise.all([desktopApi.listApprovedSessionSources(), desktopApi.listSuggestedSessionSources()]).then(([roots, ideas]) => { setApproved(roots); setSuggested(ideas); }).catch((reason) => onError(String(reason))).finally(() => setLoading(false));
    return () => { if (priorFocus.current?.isConnected) priorFocus.current.focus(); };
  }, [onError]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); onClose(); return; }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const targets = [...dialogRef.current.querySelectorAll<HTMLElement>("button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex='-1'])")];
      if (!targets.length) return;
      const first = targets[0]; const last = targets.at(-1)!;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const scan = async () => { setScanState("running"); try { await desktopApi.refreshSessions(); setScanState("done"); } catch (reason) { onError(String(reason)); setScanState("idle"); } };
  const finish = () => { localStorage.setItem("mobius.onboarding.complete", "1"); onNavigate("workspaces"); onClose(); };
  const sourceRows = approved.roots.length ? approved.roots : suggested;

  return <div className="onboarding-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}>
    <section ref={dialogRef} className="onboarding" role="dialog" aria-modal="true" aria-labelledby="onboarding-title" aria-describedby="onboarding-summary">
      <header className="onboarding-top"><div className="onboarding-brand"><MobiusLogo size={36}/><span><strong>MÖBIUS</strong><small>LOCAL AGENT WORKSPACE</small></span></div><button ref={closeRef} className="onboarding-close" type="button" onClick={onClose} aria-label={text.close}><X size={18}/></button></header>
      <nav className="onboarding-progress" aria-label={`${step + 1} / ${text.steps.length}`}>{text.steps.map((name, index) => <button type="button" key={name} className={index === step ? "active" : index < step ? "done" : ""} onClick={() => setStep(index as Step)} aria-current={index === step ? "step" : undefined}><i>{index < step ? <CheckCircle2 size={13}/> : index + 1}</i><span>{name}</span></button>)}</nav>
      <main className="onboarding-content">
        {step === 0 ? <StepPage signal="WHY MÖBIUS" title={text.valueTitle} body={text.valueBody}><Evidence icon={<FolderGit2/>} title={text.findTitle} body={text.findBody}/><Evidence icon={<TerminalSquare/>} title={text.continueTitle} body={text.continueBody}/></StepPage> : null}
        {step === 1 ? <StepPage signal="LOCAL-FIRST" title={text.localTitle} body={text.localBody}><Evidence icon={<ShieldCheck/>} title={text.noAutoTitle} body={text.noAutoBody}/><Evidence icon={<AtSign/>} title={text.explicitTitle} body={text.explicitBody}/></StepPage> : null}
        {step === 2 ? <StepPage signal="READ-ONLY INDEX" title={text.sourceTitle} body={text.sourceBody}><div className="source-stats"><article><small>{text.roots}</small><strong>{approved.roots.length}</strong><span>{text.approved}</span></article><article><small>{text.candidates}</small><strong>{loading ? "…" : suggested.length}</strong><span>{text.candidate}</span></article></div><div className="onboarding-source-list" aria-live="polite">{loading ? <p>{text.sourceLoading}</p> : sourceRows.length ? sourceRows.slice(0, 4).map((root) => <div key={`${root.agent}:${root.path}`}><b>{root.agent}</b><code>{root.path}</code><span>{approved.roots.length ? text.approved : text.candidate}</span></div>) : <p>{text.sourceEmpty}</p>}</div><button className="onboarding-primary inline-action" type="button" disabled={!approved.roots.length || scanState === "running"} onClick={() => void scan()}><ScanSearch size={17}/>{scanState === "running" ? text.refreshing : scanState === "done" ? text.refreshed : text.refresh}</button></StepPage> : null}
        {step === 3 ? <StepPage signal="WORKSPACE FIRST" title={text.resumeTitle} body={text.resumeBody}><div className="onboarding-flow"><span>{locale === "zh-CN" ? "项目" : "Project"}</span><ArrowRight/><span>worktree</span><ArrowRight/><span>session</span><ArrowRight/><span>PowerShell</span></div><Evidence icon={<TerminalSquare/>} title={locale === "zh-CN" ? "恢复原会话" : "Resume original"} body={locale === "zh-CN" ? "默认选择原 Agent；切换 Agent 是独立动作。" : "The original agent is selected by default; switching agents is a separate action."}/></StepPage> : null}
        {step === 4 ? <StepPage signal="FULL TRAJECTORY" title={text.handoffTitle} body={text.handoffBody}><Evidence icon={<AtSign/>} title={text.exactTitle} body={text.exactBody}/><Evidence icon={<GitFork/>} title={text.recallTitle} body={text.recallBody}/></StepPage> : null}
        {step === 5 ? <StepPage signal="KEEP THE WORK" title={text.libraryTitle} body={text.libraryBody}><div className="onboarding-capabilities"><Evidence icon={<BookOpen/>} title={text.libraryCard} body={text.libraryCardBody}/><Evidence icon={<Wrench/>} title={text.skillsCard} body={text.skillsCardBody}/></div></StepPage> : null}
      </main>
      <footer className="onboarding-footer"><button className="onboarding-text" type="button" onClick={finish}>{text.skip}</button><div>{step > 0 ? <button className="onboarding-secondary" type="button" onClick={() => setStep((step - 1) as Step)}>{text.back}</button> : null}{step < 5 ? <button className="onboarding-primary" type="button" onClick={() => setStep((step + 1) as Step)}>{text.next}<ArrowRight size={16}/></button> : <button className="onboarding-primary" type="button" onClick={finish}>{text.enter}<ArrowRight size={16}/></button>}</div></footer>
    </section>
  </div>;
}

function StepPage({ signal, title, body, children }: { signal: string; title: string; body: string; children: ReactNode }) {
  return <><p className="eyebrow">{signal}</p><h1 id="onboarding-title">{title}</h1><p id="onboarding-summary">{body}</p>{children}</>;
}

function Evidence({ icon, title, body }: { icon: ReactNode; title: string; body: string }) {
  return <div className="onboarding-evidence">{icon}<div><strong>{title}</strong><span>{body}</span></div></div>;
}
