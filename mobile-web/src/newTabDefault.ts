// The project screen's ＋ on a tap: a new tab of one agent, straight away. Which
// agent is this phone's own choice — the ★ in the ＋ sheet — and never the
// desktop's: the desktop's default agent (`default_agent_cmd`, flagged
// `default` in the catalog) is only the fallback until one is starred, so the
// phone never writes the desktop's settings.

import { useCallback, useEffect, useRef } from "react";
import type { AgentRow } from "./api";
import { HOLD_MS } from "./components/MessageMenu";
import { readChoice, writeChoice } from "./prefs";

const anyId = (value: unknown): value is string => typeof value === "string" && value !== "";

/** The agent id this phone starred, or "" for none. */
export function readNewTabAgent(): string {
  return readChoice("newTabAgent", anyId, "");
}

export function writeNewTabAgent(id: string): void {
  writeChoice("newTabAgent", id);
}

/** The agent a tap on ＋ starts: the starred one while the desktop still
 * offers it, else the desktop's default, else the first listed. */
export function newTabAgent(agents: AgentRow[], starred = readNewTabAgent()): AgentRow | undefined {
  return agents.find((agent) => agent.id === starred) ?? agents.find((agent) => agent.default) ?? agents[0];
}

/** A press that wanders this far is a scroll, not a hold. */
const HOLD_SLOP = 12;

/** A button's tap and hold, apart: `onHold` after `HOLD_MS` of a resting
 * finger (or a right-click, or the system's own long-press `contextmenu`),
 * and the click that ends that press is swallowed rather than also tapping. */
export function useTapHold(onTap: () => void, onHold: () => void) {
  const timer = useRef(0);
  const from = useRef<{ x: number; y: number } | null>(null);
  const held = useRef(false);
  const cancel = useCallback(() => {
    window.clearTimeout(timer.current);
    timer.current = 0;
    from.current = null;
  }, []);
  useEffect(() => cancel, [cancel]);
  const hold = () => {
    cancel();
    held.current = true;
    onHold();
  };
  return {
    onPointerDown: (event: React.PointerEvent) => {
      held.current = false;
      if (event.button !== 0) return;
      from.current = { x: event.clientX, y: event.clientY };
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(hold, HOLD_MS);
    },
    onPointerMove: (event: React.PointerEvent) => {
      const start = from.current;
      if (start && (Math.abs(event.clientX - start.x) > HOLD_SLOP || Math.abs(event.clientY - start.y) > HOLD_SLOP)) cancel();
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    onContextMenu: (event: React.MouseEvent) => {
      event.preventDefault();
      // A long-press the timer already answered; a mouse's right-click has no
      // press under way and no click to swallow after it.
      if (held.current) return;
      const pressing = from.current !== null;
      cancel();
      held.current = pressing;
      onHold();
    },
    onClick: () => {
      if (held.current) { held.current = false; return; }
      onTap();
    },
  };
}
