import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Bold, Code, Heading2, Italic, Link2, List, WrapText } from "lucide-react";

type Props = {
  documentKey: string;
  value: string;
  disabled?: boolean;
  placeholder?: string;
  onChange: (value: string) => void;
  wrap: boolean;
  onWrapChange: (wrap: boolean) => void;
};

function wrapSelection(host: HTMLTextAreaElement, prefix: string, suffix = prefix) {
  const start = host.selectionStart;
  const end = host.selectionEnd;
  const selected = host.value.slice(start, end) || "text";
  const next = host.value.slice(0, start) + prefix + selected + suffix + host.value.slice(end);
  const caret = start + prefix.length;
  host.value = next;
  host.selectionStart = caret;
  host.selectionEnd = caret + selected.length;
  return next;
}

export function NoteSourceEditor({ documentKey, value, disabled, placeholder, onChange, wrap, onWrapChange }: Props) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const loadedKey = useRef<string | null>(null);
  const [cursor, setCursor] = useState({ line: 1, column: 1 });

  useEffect(() => {
    const host = ref.current;
    if (!host) return;
    if (loadedKey.current === documentKey) {
      if (document.activeElement !== host && host.value !== value) host.value = value;
      return;
    }
    loadedKey.current = documentKey;
    host.value = value;
    host.selectionStart = 0;
    host.selectionEnd = 0;
    setCursor({ line: 1, column: 1 });
  }, [documentKey, value]);

  const emit = (host: HTMLTextAreaElement) => {
    const before = host.value.slice(0, host.selectionStart);
    const line = before.split(/\n/).length;
    const column = before.length - before.lastIndexOf("\n");
    setCursor({ line, column });
    onChange(host.value);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    const host = event.currentTarget;
    if (event.key !== "Tab" || event.ctrlKey || event.metaKey || event.altKey) return;
    event.preventDefault();
    const start = host.selectionStart;
    const end = host.selectionEnd;
    if (event.shiftKey) {
      const lineStart = host.value.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
      if (host.value.slice(lineStart, lineStart + 2) === "  ") {
        host.value = host.value.slice(0, lineStart) + host.value.slice(lineStart + 2);
        host.selectionStart = Math.max(lineStart, start - 2);
        host.selectionEnd = Math.max(lineStart, end - 2);
      }
    } else {
      host.value = host.value.slice(0, start) + "  " + host.value.slice(end);
      host.selectionStart = start + 2;
      host.selectionEnd = start + 2;
    }
    emit(host);
  };

  const apply = (prefix: string, suffix?: string) => {
    const host = ref.current;
    if (!host || disabled) return;
    wrapSelection(host, prefix, suffix);
    host.focus();
    emit(host);
  };

  return <div className="note-source-editor">
    <div className="note-md-toolbar" role="toolbar" aria-label="Markdown">
      <button type="button" disabled={disabled} onClick={() => apply("## ", "")} title="Heading"><Heading2 size={14}/></button>
      <button type="button" disabled={disabled} onClick={() => apply("**")} title="Bold"><Bold size={14}/></button>
      <button type="button" disabled={disabled} onClick={() => apply("_")} title="Italic"><Italic size={14}/></button>
      <button type="button" disabled={disabled} onClick={() => apply("`")} title="Code"><Code size={14}/></button>
      <button type="button" disabled={disabled} onClick={() => apply("[", "](url)")} title="Link"><Link2 size={14}/></button>
      <button type="button" disabled={disabled} onClick={() => apply("- ", "")} title="List"><List size={14}/></button>
      <button type="button" className={wrap ? "active" : ""} onClick={() => onWrapChange(!wrap)} title="Word wrap"><WrapText size={14}/></button>
      <small>{cursor.line}:{cursor.column}</small>
    </div>
    <textarea
      ref={ref}
      disabled={disabled}
      placeholder={placeholder}
      spellCheck={false}
      wrap={wrap ? "soft" : "off"}
      onKeyDown={onKeyDown}
      onInput={(event) => emit(event.currentTarget)}
      onSelect={(event) => emit(event.currentTarget)}
    />
  </div>;
}
