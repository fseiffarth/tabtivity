import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { UntestedTag } from "./UntestedTag";

type Hint = { owner: Element; text: string };
const DELAY = 550;
const MARGIN = 8;

/** One themed replacement for native title hints, including portaled controls.
 * Only the current title is suppressed; leaving restores it, so existing DOM
 * consumers and assistive technology keep the original title at rest. */
export function TooltipHost() {
  const id = useId();
  const card = useRef<HTMLDivElement>(null);
  const [hint, setHint] = useState<Hint | null>(null);

  useEffect(() => {
    let active: Hint | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let leaveTimer: ReturnType<typeof setTimeout> | undefined;
    let keyboard = true;
    let focused: Element | null = null;
    let described: Element | null = null;
    let named: Element | null = null;
    let name: string | null = null;

    function hide() {
      clearTimeout(timer);
      setHint(null);
      if (described) {
        const refs = (described.getAttribute("aria-describedby") ?? "").split(/\s+/).filter((ref) => ref && ref !== id);
        if (refs.length) described.setAttribute("aria-describedby", refs.join(" "));
        else described.removeAttribute("aria-describedby");
        described = null;
      }
    }

    function release() {
      clearTimeout(leaveTimer);
      observer.disconnect();
      hide();
      // A React render may have changed or removed the title since takeover.
      if (active?.owner.getAttribute("title") === "") {
        active.owner.setAttribute("title", active.text);
      }
      if (named?.getAttribute("aria-label") === name) named.removeAttribute("aria-label");
      named = null;
      name = null;
      active = null;
    }

    function nearest(target: EventTarget | null): Element | null {
      if (!(target instanceof Element) || target.closest("[data-app-tooltip]")) return null;
      // An explicitly empty title blocks inherited hints, as it does natively.
      const owner = target.closest("[title]");
      return owner && (owner === active?.owner || owner.getAttribute("title")?.trim()) ? owner : null;
    }

    function show() {
      if (!active?.owner.isConnected) { release(); return; }
      described = focused && active.owner.contains(focused) ? focused : active.owner;
      const refs = (described.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean);
      if (!refs.includes(id)) refs.push(id);
      described.setAttribute("aria-describedby", refs.join(" "));
      setHint({ ...active });
    }

    const observer = new MutationObserver((records) => {
      if (!active) return;
      if (!active.owner.isConnected) { release(); return; }
      const next = active.owner.getAttribute("title");
      if (next === "") {
        // An external render can deliberately clear an already suppressed title.
        if (records.some((record) => record.target === active?.owner && record.type === "attributes" && record.oldValue === "")) {
          active = null;
          release();
        }
        return;
      }
      if (!next?.trim()) { release(); return; }
      const updated = { owner: active.owner, text: next };
      active = updated;
      active.owner.setAttribute("title", "");
      if (named?.getAttribute("aria-label") === name) {
        name = next;
        named.setAttribute("aria-label", next);
      }
      // Refresh only if the hint is already open; a dismissed hint stays shut.
      setHint((current) => current ? updated : null);
    });

    function enter(owner: Element | null) {
      clearTimeout(leaveTimer);
      if (owner === active?.owner) return;
      release();
      if (!owner) return;
      active = { owner, text: owner.getAttribute("title") ?? "" };
      // Preserve title-derived names on icon-only controls while suppressing it.
      const field = owner instanceof HTMLInputElement || owner instanceof HTMLSelectElement ||
        owner instanceof HTMLTextAreaElement ? owner : null;
      const textName = owner instanceof HTMLInputElement
        ? /^(button|submit|reset)$/.test(owner.type) && owner.value
        : field ? false : owner.textContent?.trim();
      if (owner.matches("button, a, input, select, textarea, [role=button], [role=link]") &&
          !textName && !field?.labels?.length && !owner.hasAttribute("aria-label") &&
          !owner.hasAttribute("aria-labelledby") &&
          !(owner instanceof HTMLInputElement && owner.type === "image" && owner.alt)) {
        named = owner;
        name = active.text;
        owner.setAttribute("aria-label", name);
      }
      owner.setAttribute("title", "");
      observer.observe(owner, { attributes: true, attributeFilter: ["title"], attributeOldValue: true });
      // Detect a removed trigger without polling or scanning inserted trees.
      observer.observe(document.body, { childList: true, subtree: true });
      timer = setTimeout(show, DELAY);
    }

    function over(event: PointerEvent) {
      if (event.pointerType === "touch" || event.buttons) return;
      if (event.target instanceof Element && event.target.closest("[data-app-tooltip]")) {
        clearTimeout(leaveTimer);
        return;
      }
      const owner = nearest(event.target);
      if (owner) enter(owner);
      else if (active) leave();
    }

    function leave() {
      clearTimeout(leaveTimer);
      // Allows crossing the small gap into a long, scrollable hint.
      leaveTimer = setTimeout(() => {
        if (keyboard && focused && active?.owner.contains(focused)) return;
        release();
      }, 100);
    }

    function out(event: PointerEvent) {
      const next = event.relatedTarget;
      if (next instanceof Element && (next.closest("[data-app-tooltip]") || nearest(next) === active?.owner)) return;
      leave();
    }

    function focusIn(event: FocusEvent) {
      focused = event.target instanceof Element ? event.target : null;
      if (keyboard) enter(nearest(focused));
    }

    function focusOut() {
      focused = null;
      if (keyboard) release();
    }

    function down(event: PointerEvent) {
      if (event.target instanceof Node && card.current?.contains(event.target)) return;
      keyboard = false;
      hide();
    }
    function key(event: KeyboardEvent) {
      if (event.key === "Tab") keyboard = true;
      if (event.key === "Escape") hide();
    }
    function scroll(event: Event) {
      if (event.target instanceof Node && card.current?.contains(event.target)) return;
      hide();
    }

    document.addEventListener("pointerover", over, true);
    document.addEventListener("pointerout", out, true);
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("focusin", focusIn, true);
    document.addEventListener("focusout", focusOut, true);
    document.addEventListener("keydown", key, true);
    document.addEventListener("scroll", scroll, true);
    window.addEventListener("blur", release);
    window.addEventListener("resize", hide);
    return () => {
      release();
      document.removeEventListener("pointerover", over, true);
      document.removeEventListener("pointerout", out, true);
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("focusin", focusIn, true);
      document.removeEventListener("focusout", focusOut, true);
      document.removeEventListener("keydown", key, true);
      document.removeEventListener("scroll", scroll, true);
      window.removeEventListener("blur", release);
      window.removeEventListener("resize", hide);
    };
  }, [id]);

  useLayoutEffect(() => {
    const node = card.current;
    if (!hint || !node) return;
    const anchor = hint.owner.getBoundingClientRect();
    const box = node.getBoundingClientRect();
    const width = document.documentElement.clientWidth || window.innerWidth;
    const height = document.documentElement.clientHeight || window.innerHeight;
    const left = Math.max(MARGIN, Math.min(anchor.left + (anchor.width - box.width) / 2, width - box.width - MARGIN));
    const below = anchor.bottom + MARGIN;
    const top = below + box.height <= height - MARGIN ? below : anchor.top - box.height - MARGIN;
    node.style.left = `${left}px`;
    node.style.top = `${Math.max(MARGIN, Math.min(top, height - box.height - MARGIN))}px`;
  }, [hint]);

  return hint ? createPortal(
    <div ref={card} id={id} role="tooltip" className="app-tooltip" data-app-tooltip="">
      <span>{hint.text}</span>
      <UntestedTag id="desktop.tooltips" />
    </div>,
    document.body,
  ) : null;
}
