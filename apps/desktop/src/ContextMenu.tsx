import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

export type ContextMenuItem = {
  id: string;
  label: string;
  icon?: ReactNode;
  shortcut?: string;
  disabled?: boolean;
  danger?: boolean;
  onSelect: () => void;
};

type ContextMenuProps = {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
  className?: string;
  returnFocusRef?: RefObject<HTMLElement | null>;
};

/**
 * A small, keyboard-complete context menu shared by library and editor
 * surfaces.  It is rendered in a portal so an overflow/scroll container can
 * never clip it, and its position is clamped after measuring the real menu.
 */
export function ContextMenu({ x, y, items, onClose, className, returnFocusRef }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: x, top: y });
  const enabledItems = items.filter((item) => !item.disabled);

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const rect = menu.getBoundingClientRect();
    const gutter = 8;
    setPosition({
      left: Math.max(gutter, Math.min(x, window.innerWidth - rect.width - gutter)),
      top: Math.max(gutter, Math.min(y, window.innerHeight - rect.height - gutter)),
    });
  }, [x, y, items.length]);

  useEffect(() => {
    const first = menuRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)");
    first?.focus();
    const onPointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (!enabledItems.length) return;
      const active = document.activeElement as HTMLButtonElement | null;
      const index = enabledItems.findIndex((item) => item.id === active?.dataset.menuItem);
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const nextIndex = event.key === "Home"
        ? 0
        : event.key === "End"
          ? enabledItems.length - 1
          : (index + (event.key === "ArrowDown" ? 1 : -1) + enabledItems.length) % enabledItems.length;
      menuRef.current?.querySelector<HTMLButtonElement>(`[data-menu-item="${enabledItems[nextIndex].id}"]`)?.focus();
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
      returnFocusRef?.current?.focus();
    };
  }, [enabledItems, onClose, returnFocusRef]);

  return createPortal(
    <div ref={menuRef} className={`mobius-context-menu${className ? ` ${className}` : ""}`} role="menu" style={{ left: position.left, top: position.top }}>
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="menuitem"
          tabIndex={-1}
          data-menu-item={item.id}
          disabled={item.disabled}
          className={item.danger ? "danger" : undefined}
          onClick={() => {
            if (item.disabled) return;
            item.onSelect();
            onClose();
          }}
        >
          {item.icon ? <span className="mobius-context-menu-icon" aria-hidden="true">{item.icon}</span> : null}
          <span>{item.label}</span>
          {item.shortcut ? <kbd>{item.shortcut}</kbd> : null}
        </button>
      ))}
    </div>,
    document.body,
  );
}
