import { useEffect, useState } from "react";

import { readableScreen } from "../../../mobile-web/src/terminal/readableScreen";
import { readAntigravitySteps, sameAntigravitySteps, type AntigravitySteps } from "../../../mobile-web/src/terminal/antigravity";
import { terminalFor, watchTerminal } from "../../lib/terminal/terminalRegistry";

/** A burst of writes is read once, this long after the last one (the Reader's rhythm). */
const SETTLE_MS = 250;
/** Until the pane has built its terminal, look again this often. */
const POLL_MS = 1500;
/** The checklist sits just above the input box, at the bottom of the screen. */
const SCREEN_ROWS = 60;

/**
 * The step checklist Antigravity draws above its input box, read off `ptyId`'s
 * live terminal (`readAntigravitySteps`), or null while none is on screen.
 *
 * Reads only while `enabled` (an Antigravity tab, its pane shown): a pane
 * that is hidden is not parsed on every write, and the first read on show
 * catches it up. Each settled write re-reads the bottom of the screen; a
 * reading that says the same thing keeps the previous object, so nothing
 * redraws for a changed spinner or elapsed time.
 */
export function useScreenSteps(ptyId: string, enabled: boolean): AntigravitySteps | null {
  const [steps, setSteps] = useState<AntigravitySteps | null>(null);

  useEffect(() => {
    if (!enabled) {
      setSteps(null);
      return;
    }
    let settle: ReturnType<typeof setTimeout> | undefined;
    let clock: ReturnType<typeof setInterval> | undefined;
    let subscribed: { term: NonNullable<ReturnType<typeof terminalFor>>; dispose: () => void } | undefined;
    const read = () => {
      settle = undefined;
      const term = terminalFor(ptyId);
      if (!term) {
        subscribed?.dispose();
        subscribed = undefined;
        setSteps(null);
        clock ??= setInterval(read, POLL_MS);
        return;
      }
      if (clock) {
        clearInterval(clock);
        clock = undefined;
      }
      if (subscribed?.term !== term) {
        subscribed?.dispose();
        const writes = term.onWriteParsed(() => { settle ??= setTimeout(read, SETTLE_MS); });
        subscribed = { term, dispose: () => writes.dispose() };
      }
      const next = readAntigravitySteps(readableScreen(term.buffer.active, SCREEN_ROWS).lines);
      setSteps((previous) => (sameAntigravitySteps(previous, next) ? previous : next));
    };
    read();
    const unwatch = watchTerminal(ptyId, read);
    return () => {
      unwatch();
      if (clock) clearInterval(clock);
      if (settle) clearTimeout(settle);
      subscribed?.dispose();
    };
  }, [ptyId, enabled]);

  return enabled ? steps : null;
}
