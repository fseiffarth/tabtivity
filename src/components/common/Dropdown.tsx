import { isInActiveModal } from "../../hooks/useModalFocus";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

export interface DropdownOption {
  value: string;
  label: string;
}

/**
 * The one themed dropdown used across the app. Native <select> popups can't be
 * styled on WebKitGTK (they render a light OS popup), so this is a custom
 * trigger + menu that follows the app theme — a dark, "fancy" dropdown in dark
 * themes. Used for the file-browser sort, the LaTeX engine selector, etc.
 *
 * Closes on outside click / Escape and reflects the selected option with a
 * trailing caret on the trigger. Opens downward; when the menu would run past
 * the window's bottom edge (a picker in the composer strip) and there is more
 * room above, it opens upward instead.
 */
export function Dropdown({
  value,
  options,
  onChange,
  disabled = false,
  title,
  ariaLabel,
  className,
  placeholder,
}: {
  value: string;
  options: DropdownOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  title?: string;
  ariaLabel?: string;
  /** Extra class on the wrapper, e.g. for compact per-context sizing. */
  className?: string;
  /** Shown on the trigger when no option matches `value`. */
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [up, setUp] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open) { setUp(false); return; }
    const menu = ref.current?.querySelector<HTMLElement>(".dropdown-menu");
    const trigger = ref.current?.querySelector<HTMLElement>(".dropdown-trigger");
    if (!menu || !trigger) return;
    const below = window.innerHeight - trigger.getBoundingClientRect().bottom;
    const above = trigger.getBoundingClientRect().top;
    setUp(menu.offsetHeight + 4 > below && above > below);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDocPointer = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (!e.defaultPrevented && e.key === "Escape" && isInActiveModal(ref.current)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        setOpen(false);
        ref.current?.querySelector("button")?.focus();
      }
    };
    document.addEventListener("pointerdown", onDocPointer);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onDocPointer);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const current = options.find((o) => o.value === value);

  return (
    <div
      className={`dropdown${className ? ` ${className}` : ""}`}
      ref={ref}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOpen(false); }}
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
        e.preventDefault();
        if (!open) { if (!disabled) setOpen(true); return; }
        const items = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? []);
        const index = items.indexOf(document.activeElement as HTMLButtonElement);
        const next = e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : (index + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
        items[next]?.focus();
      }}
    >
      <button
        type="button"
        className="dropdown-trigger"
        onClick={() => !disabled && setOpen((v) => !v)}
        disabled={disabled}
        title={title}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        {current ? current.label : (placeholder ?? "")}
        <span className="dropdown-caret">▾</span>
      </button>
      {open && (
        <div className={`context-menu dropdown-menu${up ? " dropdown-menu-up" : ""}`} role="listbox">
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              role="option"
              aria-selected={o.value === value}
              className={o.value === value ? "selected" : ""}
              onClick={() => {
                onChange(o.value);
                setOpen(false);
                ref.current?.querySelector("button")?.focus();
              }}
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
