import { createContext, useContext, useMemo, useState, type ReactNode } from "react";

export type Locale = "zh-CN" | "en";
const STORAGE_KEY = "mydesk.locale.v2";

const zh: Record<string, string> = {
  Workspaces: "工作区", Sessions: "会话库", Terminal: "终端", Notes: "笔记", Canvas: "无限画布", Skills: "技能",
  Working: "正在工作", Paused: "暂停工作", "Add workspace": "添加工作区", "New PowerShell": "新建 PowerShell",
  "Refresh sessions": "刷新会话", "Search sessions": "搜索会话内容、架构、踩坑或进度", "No sessions": "还没有匹配的会话",
  "Native resume": "原生恢复", "Hand off": "交给其他 Agent", "Source file": "源文件", Messages: "消息",
  "Mount folder": "挂载目录", "New note": "新建笔记", "No notes": "还没有笔记", "Read only": "只读", "Read write": "可读写",
  "Global skills": "全局技能", "Project skills": "项目技能", Managed: "托管", "Local data online": "本地资料库在线",
  "Indexing providers": "正在索引各 Agent 会话…", "Open terminal": "打开终端", "Session identity": "会话身份",
  "Collapse paused": "折叠暂停区", "Expand paused": "展开暂停区", "All providers": "全部 Agent", "Add node": "添加卡片",
  Save: "保存", "Workspace path": "工作区路径", Cancel: "取消", Confirm: "确认", Close: "关闭", Search: "搜索",
  "Handoff preview": "接力预览", "Target agent": "目标 Agent", "Target worktree": "目标 Worktree", "Take over": "接手", Parallel: "并行",
  "Seal handoff": "封存接力包", "Copy reference": "复制引用", "Select a session": "选择一个会话查看逐条消息",
  "Command input": "命令输入", Send: "发送", Context: "引用", "No terminal": "选择工作区新建 PowerShell，或从会话原生恢复。"
};

type I18nValue = { locale: Locale; setLocale: (locale: Locale) => void; t: (key: string) => string };
const I18nContext = createContext<I18nValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(() => localStorage.getItem(STORAGE_KEY) === "en" ? "en" : "zh-CN");
  const value = useMemo<I18nValue>(() => ({
    locale,
    setLocale(next) { localStorage.setItem(STORAGE_KEY, next); setLocaleState(next); },
    t(key) { return locale === "zh-CN" ? zh[key] ?? key : key; }
  }), [locale]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const context = useContext(I18nContext);
  if (!context) throw new Error("useI18n must be used inside I18nProvider");
  return context;
}
