import { useLayoutEffect } from "react";

/**
 * Where a list stood when a tab was opened from it. The lists (Home's projects,
 * a project's tab cards) scroll the window, and `App` unmounts them under a
 * terminal, so Back used to land at the top. `App` remembers the offset as the
 * tab opens; the list takes it back once it has rendered its rows again.
 */
const OFFSETS = new Map<string, number>();

/** The list a tab opens from: Home's, or one project's. */
export function listScrollKey(projectId: string | null): string {
  return projectId ? `project:${projectId}` : "home";
}

export function rememberListScroll(key: string): void {
  OFFSETS.set(key, Math.max(0, Math.round(window.scrollY)));
}

/** The remembered offset, once: a second visit starts at the top again. */
export function takeListScroll(key: string): number | null {
  const offset = OFFSETS.get(key);
  OFFSETS.delete(key);
  return offset ?? null;
}

/**
 * Puts the window back where `rememberListScroll(key)` left it, the moment
 * `ready` is true — the rows are in the DOM, so the page is tall enough. A
 * touch or wheel before the retry frames cancels them: the reader's own scroll
 * wins over the restore.
 */
export function useRestoreListScroll(key: string, ready: boolean): void {
  useLayoutEffect(() => {
    if (!ready) return;
    const offset = takeListScroll(key);
    if (offset === null || offset === 0) return;
    window.scrollTo(0, offset);
    // A list that grows after its first paint (cards, thumbnails) clamps the
    // jump; a couple of frames of retrying lets it reach the offset.
    let frames = 0;
    let frame = 0;
    const stop = () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("touchstart", stop);
      window.removeEventListener("wheel", stop);
    };
    const settle = () => {
      if (Math.abs(window.scrollY - offset) <= 2 || ++frames > 8) { stop(); return; }
      window.scrollTo(0, offset);
      frame = requestAnimationFrame(settle);
    };
    window.addEventListener("touchstart", stop, { passive: true });
    window.addEventListener("wheel", stop, { passive: true });
    frame = requestAnimationFrame(settle);
    return stop;
  }, [key, ready]);
}
