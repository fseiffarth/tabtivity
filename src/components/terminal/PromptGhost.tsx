import { useLayoutEffect, useRef, type RefObject } from "react";

/**
 * The dim continuation after the text of a prompt box: how the local model
 * thinks the prompt being typed goes on (`lib/agents/nextPrompt`,
 * `usePromptComplete`), in the Chat composer and steering's prompt box. A
 * textarea draws no second colour, so this is a layer over it that repeats
 * the typed text unseen — same font, padding and width, so it wraps where
 * the box wraps it — and draws `rest` after it. It takes no pointer events
 * and is hidden from assistive tech (the box's own description names the
 * continuation); Tab / → in the box take it.
 *
 * The box's nearest positioned ancestor must be the layer's too (render it
 * as the textarea's sibling). Rendered only while there is a `rest`.
 */
export function PromptGhost({ box, typed, rest }: {
  box: RefObject<HTMLTextAreaElement | null>;
  typed: string;
  rest: string;
}) {
  const layer = useRef<HTMLDivElement>(null);
  const text = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const field = box.current;
    const over = layer.current;
    const lines = text.current;
    if (!field || !over || !lines) return;
    const place = () => {
      const style = getComputedStyle(field);
      // The box's padding box, less its bottom padding: lines scrolled into
      // that strip are the box's to hide (the card composer's chips sit there).
      over.style.left = `${field.offsetLeft + field.clientLeft}px`;
      over.style.top = `${field.offsetTop + field.clientTop}px`;
      over.style.width = `${field.clientWidth}px`;
      over.style.height = `${Math.max(0, field.clientHeight - (parseFloat(style.paddingBottom) || 0))}px`;
      over.style.padding = `${style.paddingTop || "0"} ${style.paddingRight || "0"} 0 ${style.paddingLeft || "0"}`;
      for (const key of ["fontFamily", "fontSize", "fontWeight", "fontStyle", "lineHeight", "letterSpacing", "tabSize", "textAlign"] as const) {
        over.style[key] = style[key];
      }
      lines.style.transform = `translateY(${-field.scrollTop}px)`;
    };
    place();
    field.addEventListener("scroll", place);
    // The box grows with its text after this effect ran (its owner's own
    // layout effect), and with the pane.
    const resized = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(place);
    resized?.observe(field);
    return () => {
      field.removeEventListener("scroll", place);
      resized?.disconnect();
    };
  }, [box, typed, rest]);
  return (
    <div ref={layer} className="prompt-ghost" aria-hidden="true">
      <div ref={text} className="prompt-ghost-text">
        <span className="prompt-ghost-typed">{typed}</span>
        <span className="prompt-ghost-rest" data-testid="prompt-ghost-rest">{rest}</span>
      </div>
    </div>
  );
}
