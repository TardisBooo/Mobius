import { useEffect, useMemo, useState } from "react";
import { FolderOpen, RotateCcw, Save, Settings } from "lucide-react";
import { desktopApi } from "./api";
import type { AppSettings, AppSettingsView } from "./types";

type Locale = "zh-CN" | "en";

function copy(locale: Locale) {
  const zh = locale === "zh-CN";
  return {
    title: zh ? "设置" : "Settings",
    intro: zh
      ? "发布版用这份设置记住数据目录和偏好。环境变量仍可覆盖单次启动；二进制里不写死任何盘符。"
      : "A released build remembers data directories and preferences here. Environment variables still override one process. The binary does not hard-code a drive layout.",
    dataRoot: zh ? "数据根目录" : "Data root",
    artifactsRoot: zh ? "产物目录" : "Artifacts root",
    catalogRoot: zh ? "目录索引" : "Catalog root",
    workspaceRoot: zh ? "默认工作区" : "Default workspace",
    theme: zh ? "主题" : "Theme",
    locale: zh ? "语言" : "Language",
    light: zh ? "浅色" : "Light",
    dark: zh ? "深色" : "Dark",
    browse: zh ? "选择" : "Browse",
    save: zh ? "保存设置" : "Save settings",
    restart: zh ? "重启以应用目录" : "Restart to apply directories",
    saved: zh ? "设置已保存" : "Settings saved",
    file: zh ? "设置文件" : "Settings file",
    notes: zh ? "笔记目录" : "Notes directory",
    database: zh ? "数据库" : "Database",
    source: zh ? "来源" : "Source",
    env: zh ? "环境变量" : "environment",
    settings: zh ? "设置文件" : "settings",
    def: zh ? "默认" : "default",
    hint: zh
      ? "数据根应与当前打开的工作区目录分开。留空则使用本机应用数据目录。"
      : "The data root must stay separate from the open workspace. Leave a field empty to use portable local app data.",
    defaultData: zh ? "默认数据根" : "Default data root",
  };
}

function emptyToNull(value?: string | null) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function sourceLabel(source: string, text: ReturnType<typeof copy>) {
  if (source === "environment" || source === "legacy-environment") return text.env;
  if (source === "settings") return text.settings;
  return text.def;
}

export function SettingsPage({ locale, theme, onTheme, onLocale, onError, onToast }: {
  locale: Locale;
  theme: "light" | "dark";
  onTheme: (theme: "light" | "dark") => void;
  onLocale: (locale: Locale) => void;
  onError: (message: string) => void;
  onToast: (message: string) => void;
}) {
  const text = useMemo(() => copy(locale), [locale]);
  const [view, setView] = useState<AppSettingsView | null>(null);
  const [draft, setDraft] = useState<AppSettings>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void desktopApi.appSettings().then((next) => {
      setView(next);
      setDraft({
        data_root: next.settings.data_root ?? next.data_root,
        artifacts_root: next.settings.artifacts_root ?? next.artifacts_root,
        catalog_root: next.settings.catalog_root ?? next.catalog_root,
        workspace_root: next.settings.workspace_root ?? next.workspace_root,
        theme,
        locale,
      });
    }).catch((reason) => onError(String(reason)));
  }, [locale, onError, theme]);

  const pick = async (key: keyof AppSettings) => {
    const current = typeof draft[key] === "string" ? draft[key] : undefined;
    try {
      const path = await desktopApi.pickDirectory(current);
      if (path) setDraft((value) => ({ ...value, [key]: path }));
    } catch (reason) {
      onError(String(reason));
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      const next = await desktopApi.saveAppSettings({
        data_root: emptyToNull(draft.data_root),
        artifacts_root: emptyToNull(draft.artifacts_root),
        catalog_root: emptyToNull(draft.catalog_root),
        workspace_root: emptyToNull(draft.workspace_root),
        theme,
        locale,
      });
      setView(next);
      onToast(next.restart_required ? text.restart : text.saved);
    } catch (reason) {
      onError(String(reason));
    } finally {
      setSaving(false);
    }
  };

  const restart = async () => {
    try {
      await desktopApi.saveAppSettings({
        data_root: emptyToNull(draft.data_root),
        artifacts_root: emptyToNull(draft.artifacts_root),
        catalog_root: emptyToNull(draft.catalog_root),
        workspace_root: emptyToNull(draft.workspace_root),
        theme,
        locale,
      });
      await desktopApi.restartApp();
    } catch (reason) {
      onError(String(reason));
    }
  };

  const field = (key: keyof AppSettings, label: string, source: string) => (
    <label className="form-label settings-field">{label}
      <div className="folder-picker-input">
        <input value={typeof draft[key] === "string" ? draft[key] as string : ""} onChange={(event) => setDraft((value) => ({ ...value, [key]: event.target.value }))}/>
        <button className="soft-button" type="button" onClick={() => void pick(key)}><FolderOpen size={15}/>{text.browse}</button>
      </div>
      <small>{text.source}: {sourceLabel(source, text)}</small>
    </label>
  );

  return <section className="settings-page">
    <header>
      <p className="eyebrow"><Settings size={14}/>{text.title}</p>
      <h2>{text.title}</h2>
      <p>{text.intro}</p>
    </header>
    {view ? <>
      {field("data_root", text.dataRoot, view.data_root_source)}
      {field("artifacts_root", text.artifactsRoot, view.artifacts_root_source)}
      {field("catalog_root", text.catalogRoot, view.catalog_root_source)}
      {field("workspace_root", text.workspaceRoot, view.workspace_root_source)}
      <p className="settings-hint">{text.hint}</p>
      <div className="settings-row">
        <label className="form-label">{text.theme}
          <select value={theme} onChange={(event) => onTheme(event.target.value === "light" ? "light" : "dark")}>
            <option value="dark">{text.dark}</option>
            <option value="light">{text.light}</option>
          </select>
        </label>
        <label className="form-label">{text.locale}
          <select value={locale} onChange={(event) => onLocale(event.target.value === "en" ? "en" : "zh-CN")}>
            <option value="zh-CN">简体中文</option>
            <option value="en">English</option>
          </select>
        </label>
      </div>
      <dl className="settings-facts">
        <div><dt>{text.file}</dt><dd><code>{view.settings_path}</code></dd></div>
        <div><dt>{text.database}</dt><dd><code>{view.database_path}</code></dd></div>
        <div><dt>{text.notes}</dt><dd><code>{view.notes_dir}</code></dd></div>
        <div><dt>{text.defaultData}</dt><dd><code>{view.default_data_root}</code></dd></div>
      </dl>
      <div className="modal-actions settings-actions">
        <button className="soft-button" type="button" onClick={() => void restart()}><RotateCcw size={15}/>{text.restart}</button>
        <button className="primary-button" type="button" disabled={saving} onClick={() => void save()}><Save size={15}/>{saving ? "…" : text.save}</button>
      </div>
    </> : <p>{locale === "zh-CN" ? "正在读取设置…" : "Reading settings…"}</p>}
  </section>;
}
