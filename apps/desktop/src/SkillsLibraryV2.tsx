import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Braces,
  Check,
  ChevronRight,
  CircleCheck,
  Eye,
  FilePenLine,
  FolderGit2,
  History,
  LoaderCircle,
  PackagePlus,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { desktopApi } from "./api";
import { AccessibleDialog } from "./AccessibleDialog";
import { ContextMenu } from "./ContextMenu";
import "./skills-target.css";
import type {
  ManagedSkillInstall,
  SkillDeployment,
  SkillInfo,
  WorkspaceView,
  SkillHistoryEntry,
} from "./types";

type Locale = "zh-CN" | "en";
type MarketplaceSkill = {
  slug: string;
  name: string;
  owner: string;
  description: string;
  category?: string;
  repositoryUrl?: string;
  pageUrl: string;
  githubStars?: number;
  qualityScore?: number;
  securityScore?: number;
};
function words(locale: Locale) {
  const zh = locale === "zh-CN";
  return {
    marketHint: zh ? "来自 agentskill.sh 的技能目录，可查看质量与安全信号。" : "Discover skills from agentskill.sh with quality and security signals.",
    openMarket: zh ? "打开技能市场" : "Open marketplace",
    remoteSource: zh ? "agentskill.sh 目录" : "agentskill.sh registry",
    zh,
    managedAvailable: zh ? "已有受管副本" : "Managed copy available",
    openManaged: zh ? "打开受管副本" : "Open managed copy",
    sourceReadOnly: zh
      ? "当前是原始来源，保持只读。打开受管副本后可编辑。"
      : "This is the original source and remains read-only. Open its managed copy to edit it.",
    global: zh ? "全局" : "Global",
    project: zh ? "项目" : "Project",
    title: zh ? "技能" : "Skills",
    subtitle: zh
      ? "查看、安装、编辑和卸载受管 SKILL.md 副本。"
      : "View, install, edit and uninstall managed SKILL.md copies.",
    search: zh ? "搜索 SKILL.md" : "Search SKILL.md",
    target: zh ? "安装目标" : "Install target",
    globalTarget: zh ? "全局受管技能" : "Global managed skills",
    projectTarget: zh ? "项目 checkout" : "Project checkout",
    view: zh ? "查看" : "View",
    edit: zh ? "编辑" : "Edit",
    install: zh ? "安装受管副本" : "Install managed copy",
    uninstall: zh ? "卸载受管副本" : "Uninstall managed copy",
    save: zh ? "保存改动" : "Save changes",
    cancel: zh ? "取消" : "Cancel",
    close: zh ? "关闭" : "Close",
    noSkills: zh ? "没有匹配的技能。" : "No matching skills.",
    source: zh ? "来源" : "Source",
    destination: zh ? "目标目录" : "Destination",
    managed: zh ? "受管副本" : "Managed copy",
    external: zh ? "外部来源（只读）" : "External source (read-only)",
    editHint: zh
      ? "为了不意外改动第三方或 Harness 的原始技能，只能编辑由 Möbius 安装的受管副本。"
      : "To avoid changing third-party or Harness originals, only Möbius-managed copies are editable.",
    installHint: zh
      ? "安装会复制到受管目标；原技能保持不变。"
      : "Install creates a managed copy at the target; the original stays unchanged.",
    confirmInstall: zh ? "确认安装技能副本" : "Confirm managed skill install",
    confirmUninstall: zh ? "确认卸载受管副本" : "Confirm managed copy removal",
    uninstallHint: zh
      ? "只会删除 Möbius 记录的受管副本，不会删除原始技能。"
      : "Only the managed copy recorded by Möbius is removed; the original skill is never deleted.",
    editableCopy: zh ? "创建可编辑副本" : "Create editable copy",
    selectProject: zh ? "选择项目 checkout" : "Choose project checkout",
    saved: zh ? "受管技能已保存" : "Managed skill saved",
    installed: zh ? "受管技能副本已安装" : "Managed skill copy installed",
    uninstalled: zh ? "受管技能副本已卸载" : "Managed skill copy uninstalled",
    loading: zh ? "正在加载技能…" : "Loading skills…",
    scope: zh ? "范围" : "Scope",
    status: zh ? "状态" : "Status",
    history: zh ? "版本历史" : "Version history",
    noHistory: zh ? "保存一次编辑后会在这里保留旧版本。" : "Previous versions appear after the first saved edit.",
    restore: zh ? "恢复此版本" : "Restore version",
    restored: zh ? "技能版本已恢复" : "Skill version restored",
    market: zh ? "技能市场" : "Skill market",
    localCatalogue: zh ? "本机已发现目录" : "Discovered local catalogue",
    installedTab: zh ? "已安装" : "Installed",
  };
}
function parent(path: string) {
  return path.replace(/[\\/]SKILL\.md$/i, "");
}
function normalizedPath(path: string) {
  return path
    .replace(/^\\\\\?\\/, "")
    .replace(/[\\/]+/g, "\\")
    .toLocaleLowerCase();
}
function samePath(left: string, right: string) {
  return normalizedPath(left) === normalizedPath(right);
}
function managedDocument(install: ManagedSkillInstall) {
  return `${install.destination.replace(/[\\/]+$/, "")}\\SKILL.md`;
}

async function fetchMarketplaceSkills(query: string): Promise<MarketplaceSkill[]> {
  if (desktopApi.runtime === "desktop") {
    return desktopApi.listMarketplaceSkills(query);
  }
  const params = new URLSearchParams({ page: "1", limit: "36", section: "top", includeTotal: "false" });
  if (query.trim()) params.set("q", query.trim());
  const response = await fetch(`https://agentskill.sh/api/skills?${params.toString()}`, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`agentskill.sh returned ${response.status}`);
  const payload = await response.json() as { data?: Array<Record<string, unknown>> };
  return (payload.data ?? []).map((item) => {
    const owner = String(item.owner ?? item.githubOwner ?? "community");
    const slug = String(item.slug ?? `${owner}/${String(item.name ?? "skill")}`);
    return {
      slug,
      name: String(item.name ?? slug.split("/").pop() ?? "skill"),
      owner,
      description: String(item.description ?? item.seoSummary ?? "Reusable instructions for an AI agent."),
      category: typeof item.category === "string" ? item.category : undefined,
      repositoryUrl: typeof item.repositoryUrl === "string" ? item.repositoryUrl : undefined,
      pageUrl: `https://agentskill.sh/@${slug}`,
      githubStars: typeof item.githubStars === "number" ? item.githubStars : undefined,
      qualityScore: typeof item.contentQualityScore === "number" ? item.contentQualityScore : undefined,
      securityScore: typeof item.securityScore === "number" ? item.securityScore : undefined,
    };
  });
}

export function SkillsLibraryV2({
  workspaces,
  onError,
  onToast,
  locale,
}: {
  workspaces: WorkspaceView[];
  onError: (message: string) => void;
  onToast: (message: string) => void;
  locale: Locale;
}) {
  const text = words(locale);
  const allCheckouts = useMemo(
    () => workspaces.flatMap((workspace) => workspace.checkouts),
    [workspaces],
  );
  const [scope, setScope] = useState<"global" | "project">("global");
  const [catalogueMode, setCatalogueMode] = useState<"market" | "installed">("market");
  const [checkoutId, setCheckoutId] = useState(allCheckouts[0]?.id ?? "");
  const [installTargetId, setInstallTargetId] = useState("global");
  const [items, setItems] = useState<SkillInfo[]>([]);
  const [marketplaceItems, setMarketplaceItems] = useState<MarketplaceSkill[]>([]);
  const [marketInstalling, setMarketInstalling] = useState<string | null>(null);
  const [managed, setManaged] = useState<ManagedSkillInstall[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<SkillInfo | null>(null);
  const [content, setContent] = useState("");
  const [reading, setReading] = useState(false);
  const [editing, setEditing] = useState(false);
  const [deployment, setDeployment] = useState<SkillDeployment | null>(null);
  const [uninstalling, setUninstalling] = useState<ManagedSkillInstall | null>(
    null,
  );
  const [skillMenu, setSkillMenu] = useState<{ x: number; y: number; skill: SkillInfo } | null>(null);
  const reloadRequest = useRef(0);
  const checkout = allCheckouts.find((item) => item.id === checkoutId) ?? null;
  const targetCheckout = installTargetId.startsWith("project:")
    ? (allCheckouts.find(
        (item) => item.id === installTargetId.slice("project:".length),
      ) ?? null)
    : null;
  const target = targetCheckout
    ? `project:${targetCheckout.canonical_path}`
    : "global";
  const reload = useCallback(async () => {
    const requestId = ++reloadRequest.current;
    setLoading(true);
    try {
      const installs = await desktopApi.listManagedSkills();
      if (requestId !== reloadRequest.current) return;
      setManaged(installs);
      if (catalogueMode === "market") {
        const marketplace = await fetchMarketplaceSkills(query);
        if (requestId !== reloadRequest.current) return;
        setMarketplaceItems(marketplace);
        setItems([]);
      } else {
        const skills = scope === "global"
          ? await desktopApi.listSkills("global")
          : checkout
            ? await desktopApi.listCheckoutSkills(checkout.id)
            : [];
        if (requestId !== reloadRequest.current) return;
        setItems(skills);
        setMarketplaceItems([]);
      }
    } catch (reason) {
      if (requestId === reloadRequest.current) onError(String(reason));
    } finally {
      if (requestId === reloadRequest.current) setLoading(false);
    }
  }, [catalogueMode, checkout, onError, query, scope]);
  useEffect(() => {
    void reload();
  }, [reload]);
  useEffect(() => {
    if (scope === "project" && !checkout && allCheckouts[0])
      setCheckoutId(allCheckouts[0].id);
  }, [allCheckouts, checkout, scope]);
  const managedCopy = (skill: SkillInfo) =>
    managed.find((install) =>
      samePath(managedDocument(install), skill.source_path),
    ) ?? null;
  const managedFromSource = (skill: SkillInfo) =>
    managed.find((install) =>
      samePath(install.source_path, skill.source_path),
    ) ?? null;
  const select = async (skill: SkillInfo) => {
    setSelected(skill);
    setEditing(false);
    setReading(true);
    setContent("");
    try {
      setContent(await desktopApi.readSkillContent(skill.source_path));
    } catch (reason) {
      onError(String(reason));
    } finally {
      setReading(false);
    }
  };
  const openManagedCopy = (install: ManagedSkillInstall, source: SkillInfo) => {
    void select({
      ...source,
      id: `managed:${install.id}`,
      source_path: managedDocument(install),
      source_kind: "mobius",
      scope: install.target.startsWith("project:") ? "project" : "global",
      managed: true,
    });
  };
  const previewInstall = async (skill: SkillInfo) => {
    try {
      setDeployment(await desktopApi.previewSkill(skill.source_path, target));
    } catch (reason) {
      onError(String(reason));
    }
  };
  const install = async () => {
    if (!deployment) return;
    try {
      await desktopApi.installManagedSkill(
        deployment.skill.source_path,
        deployment.target,
      );
      setDeployment(null);
      await reload();
      onToast(text.installed);
    } catch (reason) {
      onError(String(reason));
    }
  };
  const installMarketplace = async (skill: MarketplaceSkill) => {
    setMarketInstalling(skill.slug);
    try {
      const content = desktopApi.runtime === "desktop"
        ? await desktopApi.fetchMarketplaceSkill(skill.slug)
        : await (async () => {
            const response = await fetch(`https://agentskill.sh/api/agent/skills/${encodeURIComponent(skill.slug)}/install`, { headers: { Accept: "application/json" } });
            if (!response.ok) throw new Error(`agentskill.sh returned ${response.status}`);
            const payload = await response.json() as { skillMd?: unknown };
            if (typeof payload.skillMd !== "string") throw new Error("Marketplace did not return a SKILL.md document.");
            return payload.skillMd;
          })();
      if (!content.trim()) throw new Error("Marketplace did not return a SKILL.md document.");
      await desktopApi.installMarketplaceSkill(skill.slug, skill.name, content, target);
      setCatalogueMode("installed");
      onToast(text.installed);
    } catch (reason) {
      onError(String(reason));
    } finally {
      setMarketInstalling(null);
    }
  };
  const save = async () => {
    if (!selected) return;
    const install = managedCopy(selected);
    if (!install) return;
    try {
      await desktopApi.writeManagedSkill(install.id, content);
      setEditing(false);
      await reload();
      onToast(text.saved);
    } catch (reason) {
      onError(String(reason));
    }
  };
  const uninstall = async () => {
    if (!uninstalling) return;
    try {
      await desktopApi.uninstallManagedSkill(uninstalling.id);
      if (selected && managedCopy(selected)?.id === uninstalling.id)
        setEditing(false);
      setUninstalling(null);
      await reload();
      onToast(text.uninstalled);
    } catch (reason) {
      onError(String(reason));
    }
  };
  // The Installed view is also the local catalogue: Harness skills already
  // present under the global/project roots must remain visible even when
  // Möbius has not created a managed copy for them yet. Filtering them out
  // made a successful native scan look like an empty directory and prevented
  // users from opening a source and choosing “Create editable copy”.
  const visible = items.filter((skill) => `${skill.name} ${skill.source_kind} ${skill.scope}`
    .toLocaleLowerCase()
    .includes(query.toLocaleLowerCase()));
  return (
    <div className="skills-library-v2">
      <header className="skills-header-v2">
        <div>
          <span>SKILL.md / LOCAL CONTROL</span>
          <h2>{text.title}</h2>
          <p>{catalogueMode === "market" ? text.marketHint : text.subtitle}</p>
        </div>
        <div className="skills-header-controls">
          <div className="skills-segment" aria-label={text.market}>
            <button className={catalogueMode === "market" ? "active" : ""} onClick={() => setCatalogueMode("market")}>{text.market}</button>
            <button className={catalogueMode === "installed" ? "active" : ""} onClick={() => setCatalogueMode("installed")}>{text.installedTab}</button>
          </div>
          <div className="skills-segment">
            <button
              className={scope === "global" ? "active" : ""}
              onClick={() => setScope("global")}
            >
              {text.global}
            </button>
            <button
              className={scope === "project" ? "active" : ""}
              onClick={() => setScope("project")}
            >
              {text.project}
            </button>
          </div>
          {scope === "project" ? (
            <label className="skills-checkout-select">
              <FolderGit2 size={15} />
              <select
                value={checkoutId}
                onChange={(event) => setCheckoutId(event.target.value)}
              >
                {allCheckouts.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.branch ?? candidate.canonical_path}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <label className="skills-search-v2">
            <Search size={16} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={text.search}
            />
          </label>
        </div>
      </header>
      <div className="skills-target-bar">
        <span>{text.target}</span>
        <label className="skills-target-select">
          <select
            aria-label={text.target}
            value={installTargetId}
            onChange={(event) => setInstallTargetId(event.target.value)}
          >
            <option value="global">{text.globalTarget}</option>
            {allCheckouts.map((candidate) => (
              <option key={candidate.id} value={`project:${candidate.id}`}>
                {text.projectTarget}:{" "}
                {candidate.branch ?? candidate.canonical_path}
              </option>
            ))}
          </select>
        </label>
        <code>{target}</code>
        <small>{text.installHint}</small>
      </div>
      <section className="skills-grid-v2">
        {loading ? (
          <div className="skills-loading">
            <LoaderCircle className="spin" size={19} />
            {text.loading}
          </div>
        ) : catalogueMode === "market" && marketplaceItems.length ? (
          marketplaceItems.map((skill) => (
            <article key={skill.slug} className="skill-card-v2 marketplace-card-v2">
              <span className="skill-glyph"><Braces size={19} /></span>
              <div className="skill-card-head"><strong>{skill.name}</strong><small>{skill.owner}{skill.category ? ` · ${skill.category}` : ""}</small></div>
              <p className="marketplace-description-v2">{skill.description}</p>
              <div className="marketplace-metrics-v2"><span>{text.remoteSource}</span>{skill.qualityScore !== undefined ? <span>Quality {skill.qualityScore}/100</span> : null}{skill.securityScore !== undefined ? <span>Security {skill.securityScore}/100</span> : null}</div>
              <footer><button className="soft-button" type="button" disabled={marketInstalling === skill.slug} onClick={() => void installMarketplace(skill)}><PackagePlus size={14}/>{marketInstalling === skill.slug ? text.loading : text.install}</button><button className="soft-button" type="button" onClick={() => { void navigator.clipboard?.writeText(`/learn @${skill.slug}`); onToast(`/learn @${skill.slug}`); }}>Copy /learn</button><a className="soft-button" href={skill.pageUrl} target="_blank" rel="noreferrer">{text.openMarket}</a></footer>
            </article>
          ))
        ) : visible.length ? (
          visible.map((skill) => {
            const copy = managedCopy(skill);
            const sourceInstall = copy ? null : managedFromSource(skill);
            return (
              <article
                key={`${skill.id}-${skill.source_path}`}
                className="skill-card-v2"
                onContextMenu={(event) => { event.preventDefault(); setSkillMenu({ x: event.clientX, y: event.clientY, skill }); }}
              >
                <span className="skill-glyph">
                  <Braces size={19} />
                </span>
                <div className="skill-card-head">
                  <strong>{skill.name}</strong>
                  <small>
                    {skill.source_kind} · {skill.scope}
                  </small>
                </div>
                <code>{skill.source_path}</code>
                <footer>
                  <span
                    className={copy ? "skill-status managed" : "skill-status"}
                  >
                    {copy ? <CircleCheck size={13} /> : <Eye size={13} />}
                    {copy
                      ? text.managed
                      : sourceInstall
                        ? text.managedAvailable
                        : text.external}
                  </span>
                  <button
                    className="soft-button"
                    onClick={() => void select(skill)}
                  >
                    <Eye size={14} />
                    {text.view}
                  </button>
                </footer>
              </article>
            );
          })
        ) : (
          <div className="skills-empty">
            <Braces size={28} />
            <strong>{text.noSkills}</strong>
          </div>
        )}
      </section>
      {skillMenu ? (() => { const copy = managedCopy(skillMenu.skill); return <ContextMenu x={skillMenu.x} y={skillMenu.y} onClose={() => setSkillMenu(null)} items={[
        { id: "view-skill", label: text.view, icon: <Eye size={14}/>, onSelect: () => void select(skillMenu.skill) },
        { id: "edit-skill", label: text.edit, icon: <FilePenLine size={14}/>, disabled: !copy, onSelect: () => { void select(skillMenu.skill).then(() => setEditing(true)); } },
        { id: "preview-install", label: text.install, icon: <PackagePlus size={14}/>, onSelect: () => void previewInstall(skillMenu.skill) },
        { id: "uninstall-skill", label: text.uninstall, icon: <Trash2 size={14}/>, danger: true, disabled: !copy, onSelect: () => { if (copy) setUninstalling(copy); } },
      ]}/>; })() : null}
      {selected ? (
        <SkillDrawer
          skill={selected}
          install={managedCopy(selected)}
          sourceInstall={
            managedCopy(selected) ? null : managedFromSource(selected)
          }
          content={content}
          reading={reading}
          editing={editing}
          onEditing={setEditing}
          onChange={setContent}
          onClose={() => {
            setSelected(null);
            setEditing(false);
          }}
          onSave={() => void save()}
          onPreview={() => void previewInstall(selected)}
          onOpenManaged={(install) => openManagedCopy(install, selected)}
          onUninstall={(install) => setUninstalling(install)}
          onRestored={async () => { await reload(); onToast(text.restored); }}
          text={text}
        />
      ) : null}
      {deployment ? (
        <InstallDialog
          deployment={deployment}
          text={text}
          onClose={() => setDeployment(null)}
          onInstall={() => void install()}
        />
      ) : null}
      {uninstalling ? (
        <UninstallDialog
          install={uninstalling}
          text={text}
          onClose={() => setUninstalling(null)}
          onConfirm={() => void uninstall()}
        />
      ) : null}
    </div>
  );
}

function SkillDrawer({
  skill,
  install,
  sourceInstall,
  content,
  reading,
  editing,
  onEditing,
  onChange,
  onClose,
  onSave,
  onPreview,
  onOpenManaged,
  onUninstall,
  onRestored,
  text,
}: {
  skill: SkillInfo;
  install: ManagedSkillInstall | null;
  sourceInstall: ManagedSkillInstall | null;
  content: string;
  reading: boolean;
  editing: boolean;
  onEditing: (value: boolean) => void;
  onChange: (value: string) => void;
  onClose: () => void;
  onSave: () => void;
  onPreview: () => void;
  onOpenManaged: (install: ManagedSkillInstall) => void;
  onUninstall: (install: ManagedSkillInstall) => void;
  onRestored: () => Promise<void>;
  text: ReturnType<typeof words>;
}) {
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState<SkillHistoryEntry[]>([]);
  const [historyBusy, setHistoryBusy] = useState(false);
  const toggleHistory = async () => {
    if (!install) return;
    const next = !historyOpen; setHistoryOpen(next);
    if (next) { setHistoryBusy(true); try { setHistory(await desktopApi.listManagedSkillHistory(install.id)); } finally { setHistoryBusy(false); } }
  };
  const restore = async (entry: SkillHistoryEntry) => {
    if (!install) return;
    setHistoryBusy(true);
    try { await desktopApi.restoreManagedSkillHistory(install.id, entry.id); await onRestored(); setHistory(await desktopApi.listManagedSkillHistory(install.id)); }
    finally { setHistoryBusy(false); }
  };
  return (
    <aside className="skill-drawer-v2" aria-label={skill.name}>
      <header>
        <div>
          <span>SKILL.md</span>
          <h3>{skill.name}</h3>
        </div>
        <button className="icon-soft" onClick={onClose} aria-label={text.close}>
          <X size={18} />
        </button>
      </header>
      <dl>
        <dt>{text.scope}</dt>
        <dd>{skill.scope}</dd>
        <dt>{text.status}</dt>
        <dd>
          {install
            ? text.managed
            : sourceInstall
              ? text.managedAvailable
              : text.external}
        </dd>
        <dt>{text.source}</dt>
        <dd>
          <code>{skill.source_path}</code>
        </dd>
        {install || sourceInstall ? (
          <>
            <dt>{text.destination}</dt>
            <dd>
              <code>{(install ?? sourceInstall)?.destination}</code>
            </dd>
          </>
        ) : null}
      </dl>
      {reading ? (
        <div className="skill-reading">
          <LoaderCircle className="spin" size={17} />
          {text.loading}
        </div>
      ) : editing ? (
        <textarea
          value={content}
          onChange={(event) => onChange(event.target.value)}
          aria-label={`${skill.name} SKILL.md`}
        />
      ) : (
        <pre>{content || "# SKILL.md"}</pre>
      )}
      <p className="skill-edit-hint">
        {install ? text.editHint : sourceInstall ? text.sourceReadOnly : text.editHint}
      </p>
      {install ? <section className="skill-history-v2"><button className="soft-button" type="button" onClick={() => void toggleHistory()}><History size={14}/>{text.history}</button>{historyOpen ? <div>{historyBusy ? <LoaderCircle className="spin" size={16}/> : history.length ? history.map((entry) => <article key={entry.id}><span><strong>{entry.created_at}</strong><code>{entry.content_hash}</code></span><button className="soft-button" type="button" onClick={() => void restore(entry)}>{text.restore}</button></article>) : <p>{text.noHistory}</p>}</div> : null}</section> : null}
      <footer>
        {install ? (
          <>
            <button
              className="soft-button"
              onClick={() => onUninstall(install)}
            >
              <Trash2 size={14} />
              {text.uninstall}
            </button>
            {editing ? (
              <>
                <button
                  className="soft-button"
                  onClick={() => onEditing(false)}
                >
                  {text.cancel}
                </button>
                <button className="primary-button" onClick={onSave}>
                  <Check size={14} />
                  {text.save}
                </button>
              </>
            ) : (
              <button
                className="primary-button"
                onClick={() => onEditing(true)}
                disabled={reading}
              >
                <FilePenLine size={14} />
                {text.edit}
              </button>
            )}
          </>
        ) : sourceInstall ? (
          <button
            className="primary-button"
            onClick={() => onOpenManaged(sourceInstall)}
          >
            <FilePenLine size={14} />
            {text.openManaged}
          </button>
        ) : (
          <button className="primary-button" onClick={onPreview}>
            <PackagePlus size={14} />
            {text.editableCopy}
          </button>
        )}
      </footer>
    </aside>
  );
}

function InstallDialog({
  deployment,
  text,
  onClose,
  onInstall,
}: {
  deployment: SkillDeployment;
  text: ReturnType<typeof words>;
  onClose: () => void;
  onInstall: () => void;
}) {
  return (
    <Modal title={text.confirmInstall} onClose={onClose}>
      <div className="skill-confirm-v2">
        <strong>{deployment.skill.name}</strong>
        <p>{deployment.reason}</p>
        <code>{deployment.destination}</code>
        <small>{text.installHint}</small>
        <div className="modal-actions">
          <button className="soft-button" onClick={onClose}>
            {text.cancel}
          </button>
          <button
            className="primary-button"
            disabled={!deployment.can_install}
            onClick={onInstall}
          >
            <PackagePlus size={15} />
            {text.install}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function UninstallDialog({
  install,
  text,
  onClose,
  onConfirm,
}: {
  install: ManagedSkillInstall;
  text: ReturnType<typeof words>;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal title={text.confirmUninstall} onClose={onClose}>
      <div className="skill-confirm-v2">
        <p>{text.uninstallHint}</p>
        <code>{install.destination}</code>
        <div className="modal-actions">
          <button className="soft-button" onClick={onClose}>
            {text.cancel}
          </button>
          <button className="danger-button" onClick={onConfirm}>
            <Trash2 size={15} />
            {text.uninstall}
          </button>
        </div>
      </div>
    </Modal>
  );
}

const Modal = AccessibleDialog;
