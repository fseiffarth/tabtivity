import { useLayoutEffect, useRef } from "react";

const modals: HTMLElement[] = [];
export const hasActiveModal = () => modals.length > 0;
/** The frame on top — the one that owns the keyboard — or null. */
export const topModal = (): HTMLElement | null => modals[modals.length - 1] ?? null;
export const isInActiveModal = (node: Node | null) => !modals.length || (node !== null && modals[modals.length - 1].contains(node));

/** CSS-hidden ancestors matter too (for example the narrow settings navigation). */
export function isVisibleControl(element: HTMLElement): boolean {
  if (element.closest('[hidden], [inert]')) return false;
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden") return false;
  }
  return true;
}
const focusable = 'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

/** Shared modal ownership: only the top frame handles Escape, Tab and focus. */
export function useModalFocus(onDismiss: () => void, enabled = true) {
  const ref = useRef<HTMLDivElement>(null);
  const dismiss = useRef(onDismiss);
  const opener = useRef(document.activeElement);
  useLayoutEffect(() => { dismiss.current = onDismiss; });
  useLayoutEffect(() => {
    const node = ref.current;
    if (!enabled || !node) return;
    const previous = opener.current;
    modals.push(node);
    const items = () => Array.from(node.querySelectorAll<HTMLElement>(focusable))
      .filter((el) => el.tabIndex >= 0 && isVisibleControl(el));
    if (!node.contains(document.activeElement)) (items()[0] ?? node).focus();
    const onFocus = (e: FocusEvent) => {
      if (modals[modals.length - 1] === node && !node.contains(e.target as Node)) (items()[0] ?? node).focus();
    };
    const onKey = (e: KeyboardEvent) => {
      if (modals[modals.length - 1] !== node || e.defaultPrevented) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        dismiss.current();
      } else if (e.key === "Tab") {
        const controls = items();
        const index = controls.indexOf(document.activeElement as HTMLElement);
        if (!controls.length || index < 0 || (e.shiftKey ? index === 0 : index === controls.length - 1)) {
          e.preventDefault();
          (controls[e.shiftKey ? controls.length - 1 : 0] ?? node).focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("focusin", onFocus);
    return () => {
      const wasTop = modals[modals.length - 1] === node;
      modals.splice(modals.indexOf(node), 1);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("focusin", onFocus);
      if (wasTop && previous instanceof HTMLElement && previous.isConnected && (!modals.length || modals[modals.length - 1]?.contains(previous))) previous.focus();
    };
  }, [enabled]);
  return ref;
}
