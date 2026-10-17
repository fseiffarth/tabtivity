import { useEffect, useRef, type MutableRefObject } from "react";
import { fileMtime, usePaneVisible } from "../components/embed/fileAccess";
import { startPoll } from "./usePoll";

/** The viewers' disk-reload cadence (#43), ~1.5 s — widened ×3 while the
 *  window is unfocused or Energy Saver is on (`saverInterval`). */
export const DISK_RELOAD_POLL_MS = 1500;

export interface DiskReloadPollOptions {
  /** The caller's own gate: the first read has landed, a build is not
   *  rewriting the file, a talk is not running. Default true. */
  enabled?: boolean;
  /** Read the baseline mtime itself whenever `path`/`scope` change, visible or
   *  not (default true), so it pairs with the bytes the caller's load read; a
   *  poll that finds no baseline (that read failed or is still in flight)
   *  adopts the one it saw instead of reporting a change. `false`: the caller
   *  records the baseline in the returned ref with the bytes it read, and no
   *  change is reported until it has. */
  seed?: boolean;
  /** Check at once whenever the poll (re)starts — the catch-up for a change
   *  made while the pane was hidden or the gate off. Default true. Read when
   *  the poll starts, so changing it alone does not restart the poll. */
  immediate?: boolean;
  /** The baseline ref to use instead of one of the hook's own, for a caller
   *  whose code above the hook call writes it (its load, its own saves). */
  baseline?: MutableRefObject<number | null>;
}

/**
 * The file viewers' one "has this file changed on disk?" poll: stats `path`
 * every {@link DISK_RELOAD_POLL_MS} and calls `onChange` when its mtime moves
 * off the baseline (either way — a pull that kept the host's older mtime is a
 * change too), after moving the baseline to it.
 *
 * Built on `startPoll` (`lib/usePoll`): one stat at a time, never back to back
 * behind a slow remote; stops while the pane is hidden (`PaneVisibleContext`
 * — every tab of every scope stays mounted, and each stat is an SFTP round
 * trip on a remote project) or the window is hidden, and checks at once when
 * shown again. While the window is merely unfocused it widens instead of
 * stopping (`onBlur: "widen"`): a viewer left open on a second screen as a
 * live preview of a file edited in another app must still follow it.
 *
 * Returns the baseline ref: a caller that writes the file itself, or reloads
 * by another route (a compile's reload request), stores the mtime it read
 * afterwards there, so its own write never trips `onChange`. `onChange` is
 * read through a ref — a new closure every render does not restart the poll.
 */
export function useDiskReloadPoll(
  path: string | null | undefined,
  scope: string | null,
  onChange: (mtime: number) => void,
  options: DiskReloadPollOptions = {},
): MutableRefObject<number | null> {
  const { enabled = true, immediate = true } = options;
  const seed = options.seed ?? true;
  const ownBaseline = useRef<number | null>(null);
  const baseline = options.baseline ?? ownBaseline;
  const paneVisible = usePaneVisible();
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const immediateRef = useRef(immediate);
  immediateRef.current = immediate;

  useEffect(() => {
    if (!seed) return;
    baseline.current = null;
    if (!path) return;
    let cancelled = false;
    fileMtime(path, scope)
      .then((m) => {
        if (!cancelled) baseline.current = m;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [path, scope, seed, baseline]);

  const active = enabled && paneVisible && !!path;
  useEffect(() => {
    if (!active || !path) return;
    const poll = startPoll(
      async (run) => {
        let m: number;
        try {
          m = await fileMtime(path, scope);
        } catch {
          return; // Mid-write, gone for now, or a dead session: the next tick asks again.
        }
        if (run.stopped) return;
        const known = baseline.current;
        if (known == null) {
          if (seed) baseline.current = m;
          return;
        }
        if (m === known) return;
        baseline.current = m;
        onChangeRef.current(m);
      },
      DISK_RELOAD_POLL_MS,
      { onBlur: "widen", immediate: immediateRef.current },
    );
    return poll.stop;
  }, [active, path, scope, seed, baseline]);

  return baseline;
}
