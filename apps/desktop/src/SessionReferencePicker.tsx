import { Copy, Link2, LoaderCircle, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AccessibleDialog } from "./AccessibleDialog";
import { desktopApi } from "./api";
import { useI18n } from "./i18n";
import type { AgentKind, Message, SessionSearchHit } from "./types";

function providerName(provider: AgentKind) {
  return provider === "pi" ? "Pi" : provider === "grok" ? "Grok" : provider === "claude" ? "Claude" : "Codex";
}

type ExactSessionIdentity = {
  provider: AgentKind;
  sessionId: string;
};

type ExactReference = ExactSessionIdentity & {
  startOrdinal: number;
  endOrdinal: number;
};

type ParsedQuery = {
  query: string;
  providers: AgentKind[];
  exactSession: ExactSessionIdentity | null;
  exactReference: ExactReference | null;
  referenceError: string | null;
};

const MAX_REFERENCE_MESSAGES = 200;

function preciseReference(source: SessionSearchHit["session"], message: Message, endOrdinal = message.ordinal) {
  const range = endOrdinal > message.ordinal ? `-m${endOrdinal}` : "";
  return `@session:${source.provider}/${source.provider_session_id}#m${message.ordinal}${range}`;
}

function packet(source: SessionSearchHit["session"], message: Message, messages: Message[], endOrdinal = message.ordinal) {
  const contents = messages
    .filter((candidate) => candidate.ordinal >= message.ordinal && candidate.ordinal <= endOrdinal)
    .map((candidate) => `[m${candidate.ordinal} · ${candidate.role}]\n${candidate.content}`)
    .join("\n\n");
  return `${preciseReference(source, message, endOrdinal)}\nHarness: ${providerName(source.provider)}\nSource: ${source.source_path}\n\n${contents || message.content}`;
}

function parseQuery(value: string): ParsedQuery {
  const raw = value.trim();
  const exact = raw.match(/^@session:(codex|claude|pi|grok)\/([^#\s]+)(?:#m(\d+)(?:-m?(\d+))?)?$/i);
  if (!exact) {
    return { query: raw, providers: [], exactSession: null, exactReference: null, referenceError: null };
  }
  const provider = exact[1].toLocaleLowerCase() as AgentKind;
  const sessionId = exact[2];
  const startOrdinal = exact[3] ? Number(exact[3]) : null;
  const requestedEnd = exact[4] ? Number(exact[4]) : null;
  const endOrdinal = startOrdinal === null ? null : Math.max(startOrdinal, requestedEnd ?? startOrdinal);
  const referenceError = startOrdinal !== null && endOrdinal !== null && endOrdinal - startOrdinal >= MAX_REFERENCE_MESSAGES
    ? `A reference can include at most ${MAX_REFERENCE_MESSAGES} messages.`
    : null;
  return {
    query: sessionId,
    providers: [provider],
    exactSession: { provider, sessionId },
    exactReference: startOrdinal === null || endOrdinal === null || referenceError
      ? null
      : { provider, sessionId, startOrdinal, endOrdinal },
    referenceError,
  };
}

/**
 * A target-side picker for a new Harness prompt. Selecting history is
 * copy-only: it never writes, pastes, or injects text into xterm.
 */
export function SessionReferencePicker({ onClose, onError }: { onClose: () => void; onError: (message: string) => void }) {
  const { locale } = useI18n();
  const zh = locale === "zh-CN";
  const [rawQuery, setRawQuery] = useState("");
  const [hits, setHits] = useState<SessionSearchHit[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [messageId, setMessageId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const parsedQuery = useMemo(() => parseQuery(rawQuery), [rawQuery]);

  const search = useCallback(async () => {
    setLoading(true);
    try {
      const next = await desktopApi.querySessions({
        query: parsedQuery.query,
        workspace_id: null,
        checkout_id: null,
        providers: parsedQuery.providers,
        limit: 72,
      });
      const unique = [...new Map(next.map((hit) => [hit.session.id, hit])).values()];
      const exactMatches = parsedQuery.exactSession
        ? unique.filter((hit) => hit.session.provider === parsedQuery.exactSession?.provider && hit.session.provider_session_id === parsedQuery.exactSession?.sessionId)
        : unique;
      setHits(exactMatches);
      setSelectedId((current) => exactMatches.some((hit) => hit.session.id === current) ? current : exactMatches[0]?.session.id ?? null);
    } catch (reason) {
      onError(String(reason));
    } finally {
      setLoading(false);
    }
  }, [onError, parsedQuery]);

  useEffect(() => {
    const timer = window.setTimeout(() => void search(), 100);
    return () => window.clearTimeout(timer);
  }, [search]);

  const selected = useMemo(() => hits.find((hit) => hit.session.id === selectedId) ?? null, [hits, selectedId]);
  const exactReferenceAmbiguous = parsedQuery.exactSession !== null && hits.length > 1;
  const requestedReference = selected
    && parsedQuery.exactReference
    && selected.session.provider === parsedQuery.exactReference.provider
    && selected.session.provider_session_id === parsedQuery.exactReference.sessionId
    ? parsedQuery.exactReference
    : null;

  useEffect(() => {
    if (!selected) {
      setMessages([]);
      setMessageId(null);
      return;
    }
    let active = true;
    void desktopApi.getSessionMessages(selected.session.id).then((next) => {
      if (!active) return;
      setMessages(next);
      const requested = requestedReference
        ? next.find((message) => message.ordinal === requestedReference.startOrdinal)
        : null;
      setMessageId(requested?.id ?? (requestedReference ? null : next.filter((message) => message.role === "user" || message.role === "assistant").at(-1)?.id ?? next.at(-1)?.id ?? null));
    }).catch((reason) => onError(String(reason)));
    return () => { active = false; };
  }, [onError, requestedReference?.endOrdinal, requestedReference?.startOrdinal, selected]);

  const selectedMessage = messages.find((message) => message.id === messageId) ?? null;
  const visibleMessages = useMemo(() => {
    if (!requestedReference) return messages.slice(-24);
    const first = messages.findIndex((message) => message.ordinal === requestedReference.startOrdinal);
    if (first < 0) return messages.slice(-24);
    const last = messages.findIndex((message) => message.ordinal === requestedReference.endOrdinal);
    return messages.slice(Math.max(0, first - 4), Math.min(messages.length, (last < first ? first : last) + 5));
  }, [messages, requestedReference]);
  const requestedRangeAvailable = !parsedQuery.referenceError && (
    !requestedReference || (
      messages.some((message) => message.ordinal === requestedReference.startOrdinal)
      && messages.some((message) => message.ordinal === requestedReference.endOrdinal)
    )
  );
  const selectedRangeEnd = selectedMessage && requestedReference && requestedRangeAvailable && selectedMessage.ordinal === requestedReference.startOrdinal
    ? requestedReference.endOrdinal
    : selectedMessage?.ordinal;
  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2400);
    } catch (reason) {
      onError(String(reason));
    }
  };

  const title = zh ? "引用历史会话" : "Reference a past session";
  const ambiguousText = zh
    ? "该原生会话 ID 在多个已批准来源中重复；精确引用已禁用。请选择一个来源并复制上下文包。"
    : "This native session ID exists in multiple approved sources. Precise reference is disabled; select one source and copy its context package.";
  return <AccessibleDialog title={title} closeLabel={zh ? "关闭" : "Close"} onClose={onClose}>
    <div className="session-reference-picker">
      <p>{zh
        ? "按会话名称、ID 或 @session:provider/id 查找。选择消息后可复制精确引用；如需相关历史，请在会话页显式运行 Mome。本窗口不会写入终端或自动注入内容。"
        : "Search by session name, ID, or @session:provider/id. Choose a message to copy an exact reference; explicitly run Mome in Sessions for related history. This picker never writes to a terminal or injects content."}</p>
      <label className="session-reference-search">
        <Search size={16}/>
        <input autoFocus value={rawQuery} onChange={(event) => setRawQuery(event.target.value)} placeholder={zh ? "会话名称、ID 或 @session:codex/..." : "Session name, ID, or @session:codex/..."}/>
      </label>
      {parsedQuery.referenceError ? <p className="session-reference-error" role="alert">{parsedQuery.referenceError}</p> : null}
      {exactReferenceAmbiguous ? <p className="session-reference-error" role="alert">{ambiguousText}</p> : null}
      <div className="session-reference-columns">
        <section className="session-reference-results" aria-label={zh ? "会话结果" : "Session results"}>
          {loading ? <div className="session-reference-loading"><LoaderCircle className="spin" size={16}/></div>
            : hits.length ? hits.map((hit) => <button type="button" key={hit.session.id} className={hit.session.id === selectedId ? "active" : ""} aria-pressed={hit.session.id === selectedId} onClick={() => setSelectedId(hit.session.id)}>
              <span className={`provider-pill ${hit.session.provider}`}>{providerName(hit.session.provider)}</span>
              <span><strong title={hit.session.title}>{hit.session.title}</strong><small title={hit.session.provider_session_id}>{hit.session.provider_session_id}</small></span>
            </button>)
            : <p>{zh ? "没有可引用的已索引会话。" : "No indexed session can be referenced."}</p>}
        </section>
        <section className="session-reference-messages" aria-label={zh ? "消息选择" : "Message selection"}>
          {selected ? <>
            {requestedReference && !requestedRangeAvailable ? <p>{zh ? "指定的精确消息范围不在本地索引中。" : "The referenced message range is not available in the local index."}</p> : null}
            {visibleMessages.map((message) => <button type="button" key={message.id} className={message.id === messageId ? "active" : ""} aria-pressed={message.id === messageId} onClick={() => setMessageId(message.id)}>
              <header><span>{message.role}</span><small>m{message.ordinal}</small></header>
              <p>{message.content}</p>
            </button>)}
          </> : <p>{zh ? "先选择会话。" : "Choose a session first."}</p>}
        </section>
      </div>
      <div className="modal-actions">
        <span className="session-reference-status">{copied ? (zh ? "已复制；请自行粘贴到目标 Agent。" : "Copied; paste it into the target Agent yourself.") : null}</span>
        <button className="soft-button" type="button" disabled={!selected || !selectedMessage || !requestedRangeAvailable || exactReferenceAmbiguous} title={exactReferenceAmbiguous ? ambiguousText : undefined} onClick={() => selected && selectedMessage && void copy(preciseReference(selected.session, selectedMessage, selectedRangeEnd))}>
          <Link2 size={15}/>{zh ? "复制精确引用" : "Copy precise reference"}
        </button>
        <button className="primary-button" type="button" disabled={!selected || !selectedMessage || !requestedRangeAvailable} onClick={() => selected && selectedMessage && void copy(packet(selected.session, selectedMessage, messages, selectedRangeEnd))}>
          <Copy size={15}/>{zh ? "复制上下文包" : "Copy context package"}
        </button>
      </div>
    </div>
  </AccessibleDialog>;
}
