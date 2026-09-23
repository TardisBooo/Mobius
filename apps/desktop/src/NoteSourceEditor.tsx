import { useMemo, useRef, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { markdown } from "@codemirror/lang-markdown";
import { openSearchPanel } from "@codemirror/search";
import { EditorView } from "@codemirror/view";
import { Bold, Code, Heading2, Italic, Link2, List, Search, WrapText } from "lucide-react";

type Props = {
  documentKey: string;
  value: string;
  disabled?: boolean;
  placeholder?: string;
  onChange: (value: string) => void;
  wrap: boolean;
  onWrapChange: (wrap: boolean) => void;
};

export function NoteSourceEditor({ documentKey, value, disabled, placeholder, onChange, wrap, onWrapChange }: Props) {
  const viewRef = useRef<EditorView | null>(null);
  const [cursor, setCursor] = useState({ line: 1, column: 1 });
  const plainText = /\.txt$/i.test(documentKey);
  const extensions = useMemo(() => [
    ...(plainText ? [] : [markdown()]),
    ...(wrap ? [EditorView.lineWrapping] : []),
  ], [plainText, wrap]);
  const apply = (prefix: string, suffix = prefix) => {
    const view = viewRef.current;
    if (!view || disabled) return;
    const { from, to } = view.state.selection.main;
    const selected = view.state.sliceDoc(from, to) || "text";
    view.dispatch({ changes: { from, to, insert: prefix + selected + suffix }, selection: { anchor: from + prefix.length, head: from + prefix.length + selected.length } });
    view.focus();
  };
  return <div className="note-source-editor">
    <div className="note-md-toolbar" role="toolbar" aria-label="Markdown">
      {!plainText ? <>
      <button type="button" disabled={disabled} onClick={() => apply("## ", "")} title="Heading"><Heading2 size={14}/></button>
      <button type="button" disabled={disabled} onClick={() => apply("**")} title="Bold"><Bold size={14}/></button>
      <button type="button" disabled={disabled} onClick={() => apply("_")} title="Italic"><Italic size={14}/></button>
      <button type="button" disabled={disabled} onClick={() => apply("`")} title="Code"><Code size={14}/></button>
      <button type="button" disabled={disabled} onClick={() => apply("[", "](url)")} title="Link"><Link2 size={14}/></button>
      <button type="button" disabled={disabled} onClick={() => apply("- ", "")} title="List"><List size={14}/></button>
      </> : null}
      <button type="button" onClick={() => { if (viewRef.current) openSearchPanel(viewRef.current); }} title="Find and replace" aria-label="Find and replace"><Search size={14}/></button>
      <button type="button" className={wrap ? "active" : ""} onClick={() => onWrapChange(!wrap)} title="Word wrap"><WrapText size={14}/></button>
      <small>{cursor.line}:{cursor.column}</small>
    </div>
    <CodeMirror
      key={documentKey}
      className="note-code-mirror"
      value={value}
      height="100%"
      extensions={extensions}
      theme={document.documentElement.dataset.theme === "dark" ? "dark" : "light"}
      editable={!disabled}
      readOnly={disabled}
      placeholder={placeholder}
      onCreateEditor={(view) => { viewRef.current = view; }}
      onChange={(next) => { if (next !== value) onChange(next); }}
      onUpdate={(update) => {
        if (!update.selectionSet && !update.docChanged) return;
        const head = update.state.selection.main.head;
        const line = update.state.doc.lineAt(head);
        setCursor({ line: line.number, column: head - line.from + 1 });
      }}
    />
  </div>;
}
