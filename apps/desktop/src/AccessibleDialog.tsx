import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { X } from "lucide-react";

const focusableSelector = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])"
].join(",");

function focusableElements(container: HTMLElement) {
  return [...container.querySelectorAll<HTMLElement>(focusableSelector)].filter((element) => !element.hidden && element.getAttribute("aria-hidden") !== "true");
}

export function AccessibleDialog({ title, closeLabel = "Close", children, onClose, initialFocusRef }: {
  title: ReactNode;
  closeLabel?: string;
  children: ReactNode;
  onClose: () => void;
  initialFocusRef?: RefObject<HTMLElement | null>;
}) {
  const titleId = useId();
  const dialogRef = useRef<HTMLElement | null>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  useEffect(() => {
    previouslyFocused.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    const requestedFocus = dialog?.querySelector<HTMLElement>("[autofocus]");
    const initialFocus = initialFocusRef?.current ?? requestedFocus ?? (dialog ? focusableElements(dialog)[0] : null) ?? dialog;
    initialFocus?.focus();

    return () => {
      const trigger = previouslyFocused.current;
      if (trigger?.isConnected) trigger.focus();
    };
  }, [initialFocusRef]);

  // A destructive dialog action can remove the element that previously held
  // focus. Keep Escape available in that transient state by listening at the
  // document capture phase, rather than relying only on the focused dialog.
  useEffect(() => {
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    document.addEventListener("keydown", closeOnEscape, true);
    return () => document.removeEventListener("keydown", closeOnEscape, true);
  }, [onClose]);

  const trapFocus = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Tab") return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const elements = focusableElements(dialog);
    if (!elements.length) {
      event.preventDefault();
      dialog.focus();
      return;
    }
    const first = elements[0];
    const last = elements.at(-1)!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return <div className="mobius-modal-backdrop" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}>
    <section ref={dialogRef} className="mobius-modal" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onKeyDown={trapFocus} onKeyDownCapture={(event) => { if (event.key === "Escape") { event.preventDefault(); onClose(); } }}>
      <header><h2 id={titleId}>{title}</h2><button className="icon-soft" type="button" onClick={onClose} aria-label={closeLabel}><X size={18}/></button></header>
      <div>{children}</div>
    </section>
  </div>;
}
