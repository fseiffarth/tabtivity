// Whether this device writes with a pen (the iPad's Pencil, an S Pen), so the
// chat composer can give handwriting room. The system turns what a pen writes
// over a text field into text by itself (iPad Scribble, Android's stylus
// handwriting) — a one-line field only leaves it no space to write in.
//
// Remembered once a pen has touched or hovered anywhere in the app, and taken
// as known when Mark up already saw one draw (`MarkupView`'s pen flag). A
// convenience only: nothing here is ever prevented, and without storage the
// first pen this session still counts.

import { useEffect, useState } from "react";
import { storageDashKey } from "../../src/lib/brand";

const PEN_KEY = storageDashKey("pen-writing");
/** `MarkupView`'s: set once a pen has drawn on a page. */
const MARKUP_PEN_KEY = storageDashKey("markup-pen");

export function penKnown(): boolean {
  try {
    return localStorage.getItem(PEN_KEY) === "1" || !!localStorage.getItem(MARKUP_PEN_KEY);
  } catch {
    return false;
  }
}

function rememberPen(): void {
  try { localStorage.setItem(PEN_KEY, "1"); } catch { /* a convenience only */ }
}

/** True once a pen is known here; flips the moment one comes near the screen. */
export function usePenWriting(): boolean {
  const [known, setKnown] = useState(penKnown);
  useEffect(() => {
    if (known || typeof window === "undefined" || !("PointerEvent" in window)) return;
    const seen = (event: PointerEvent) => {
      if (event.pointerType !== "pen") return;
      rememberPen();
      setKnown(true);
    };
    // Hover (a Pencil that hovers) and touch both tell; capture, so a control
    // that stops its own events still lets the pen be noticed.
    const options: AddEventListenerOptions = { capture: true, passive: true };
    window.addEventListener("pointerover", seen, options);
    window.addEventListener("pointerdown", seen, options);
    return () => {
      window.removeEventListener("pointerover", seen, options);
      window.removeEventListener("pointerdown", seen, options);
    };
  }, [known]);
  return known;
}
