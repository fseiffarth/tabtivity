/**
 * Quick open: the Ctrl/Cmd+P chord, now a door into the command palette on its
 * `#` file filter (`layout/CommandPalette`, which holds the list). Mounted once
 * in AppShell with no props, and mounts the palette with it.
 */
import { useEffect } from "react";
import { useProjectsStore } from "../../stores/projects";
import { IS_MAC } from "../../lib/platform";
import { CommandPalette, OPEN_PALETTE_EVENT } from "../layout/CommandPalette";
import "./QuickOpen.css";

export function QuickOpen() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = IS_MAC ? e.metaKey : e.ctrlKey;
      if (mod && !e.altKey && !e.shiftKey && (e.key === "p" || e.key === "P")) {
        // No active project → leave the event alone.
        if (!useProjectsStore.getState().activeId) return;
        // A focused PDF prints with this chord, which is what Ctrl+P means while
        // you are looking at a document. This listener is on `window` in the
        // CAPTURE phase and stops propagation, so the pane's own handler would
        // never run unless the palette stands aside first. Focus is the whole
        // test: with the palette's chord free again the moment focus leaves the
        // page stack, opening files by name costs one click elsewhere.
        if ((e.target as Element | null)?.closest?.(".file-viewer-pdf-host")) return;
        e.preventDefault();
        e.stopPropagation();
        window.dispatchEvent(new CustomEvent(OPEN_PALETTE_EVENT, { detail: { filter: "#" } }));
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  return <CommandPalette />;
}
