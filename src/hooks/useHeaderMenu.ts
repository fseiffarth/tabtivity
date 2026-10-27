import { isVisibleControl } from "./useModalFocus";
import { useEffect, useLayoutEffect, useRef, type FocusEvent, type KeyboardEvent } from "react";
import { headerMenuCloseDelay, useHeaderHoverMenuStore } from "../stores/headerHoverMenu";

/** Shared hover grace and keyboard navigation for header action menus. */
export function useHeaderMenu(id: string) {
  const open = useHeaderHoverMenuStore((s) => s.openId === id);
  const ref = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const pendingFocus = useRef(false);
  const trigger = () => ref.current?.querySelector<HTMLButtonElement>(":scope > button");
  const actions = () => Array.from(ref.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []).filter((el) => el !== trigger() && !el.closest('[role="dialog"], [data-header-menu-interactive]') && isVisibleControl(el));
  const reveal = () => {
    clearTimeout(timer.current);
    useHeaderHoverMenuStore.getState().open(id);
  };
  const close = () => useHeaderHoverMenuStore.getState().close(id);
  const scheduleClose = (e?: { clientY: number }) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      if (!ref.current?.contains(document.activeElement)) close();
    }, headerMenuCloseDelay(e));
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  useLayoutEffect(() => {
    // Actions are arrow-navigated. Leaving only the trigger in the Tab order
    // lets the browser move straight out without removing the focused node early.
    if (open) actions().forEach((action) => { action.tabIndex = -1; });
    if (open && pendingFocus.current) {
      pendingFocus.current = false;
      actions()[0]?.focus();
    }
  });
  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) useHeaderHoverMenuStore.getState().close(id);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [id, open]);
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.defaultPrevented) return;
    if (e.key === "Tab") { e.stopPropagation(); return; }
    if (open && e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
      trigger()?.focus();
      return;
    }
    if ((e.target as HTMLElement).matches("input, textarea, select")) return;
    const onTrigger = e.target === trigger();
    if (onTrigger && ["ArrowDown", "Enter", " "].includes(e.key)) {
      e.preventDefault();
      e.stopPropagation();
      if (open) actions()[0]?.focus();
      else { pendingFocus.current = true; reveal(); }
    } else if (open && ["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
      e.preventDefault();
      e.stopPropagation();
      const entries = actions();
      const index = entries.indexOf(document.activeElement as HTMLButtonElement);
      const next = e.key === "Home" ? 0 : e.key === "End" ? entries.length - 1 : (index + (e.key === "ArrowDown" ? 1 : -1) + entries.length) % entries.length;
      entries[next]?.focus();
    }
  };
  return { open, ref, reveal, scheduleClose, onKeyDown, onBlur: (e: FocusEvent) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) close();
  } };
}
