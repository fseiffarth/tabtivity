import { useEffect, type RefObject } from "react";

const FOCUSABLE = "button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";

/** What Tab may reach inside `root`, in document order. */
function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)];
}

/**
 * Keyboard focus for a sheet laid over a screen (`role="dialog"
 * aria-modal`), as an iPad keyboard or VoiceOver needs it: focus moves into
 * the sheet when it opens — to its first choice, not its ✕, unless something
 * inside took it already (an `autoFocus` field) — Tab and Shift+Tab stay
 * inside it, and focus goes back to what opened it when it closes.
 *
 * What stands beside the sheet (the sheet's backdrop, or the sheet itself,
 * and its siblings: the screen's head and list) is `inert` while it is up,
 * so neither a keyboard nor a screen reader reaches the list behind. Only
 * siblings it made inert are let go again; one already inert stays so.
 *
 * A sheet opened while a text field has the focus changes nothing: the field
 * keeps it, so the phone's on-screen keyboard is not put away.
 */
export function useModalFocus(dialog: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    // What had the focus before the sheet; a field inside it that took the
    // focus on mounting (`autoFocus`) is no opener to go back to.
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const opener = active && !node.contains(active) ? active : null;
    // Opened while typing (a composer, a search box): the phone's keyboard
    // stays up and the field keeps the focus — moving it, or making the
    // field inert, would put the keyboard away under the reader's fingers.
    if (opener?.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])")) return;
    const outer = node.closest<HTMLElement>(".sheet-backdrop") ?? node;
    const quieted = [...(outer.parentElement?.children ?? [])].filter(
      (sibling): sibling is HTMLElement => sibling !== outer && sibling instanceof HTMLElement && !sibling.hasAttribute("inert"),
    );
    for (const sibling of quieted) sibling.setAttribute("inert", "");
    if (!node.contains(document.activeElement)) {
      const items = focusables(node);
      (items.find((item) => !item.classList.contains("sheet-close")) ?? items[0])?.focus({ preventScroll: true });
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const items = focusables(node);
      if (items.length === 0) {
        event.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      const inside = active instanceof Node && node.contains(active);
      if (event.shiftKey ? (!inside || active === first) : (!inside || active === last)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      for (const sibling of quieted) sibling.removeAttribute("inert");
      if (opener?.isConnected && !opener.closest("[inert]")) opener.focus({ preventScroll: true });
    };
  }, [dialog]);
}
