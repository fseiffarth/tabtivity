// The project screen's ＋ on a tap: a new tab of one agent, straight away. Which
// agent is this phone's own choice — the ★ in the ＋ sheet — and never the
// desktop's: the desktop's default agent (`default_agent_cmd`, flagged
// `default` in the catalog) is only the fallback until one is starred, so the
// phone never writes the desktop's settings. The ★ sits on the sheet's API and
// local-model rows too: the stored value is the agent id, `api:<agent id>` or
// `local:<launch id>`, and a tap starts that row's tab as the row would.

import { useCallback, useEffect, useRef } from "react";
import type { AgentRow } from "./api";
import { HOLD_MS } from "./components/MessageMenu";
import { readChoice, writeChoice } from "./prefs";
import type { NewTabLaunch } from "./screens/NewTabSheet";

const anyId = (value: unknown): value is string => typeof value === "string" && value !== "";

/** The agent id this phone starred, or "" for none. */
export function readNewTabAgent(): string {
  return readChoice("newTabAgent", anyId, "");
}

/** The local row's name as it was starred (the launch id is opaque, and the
 * model it drives is only known to the sheet), for the ＋'s tooltip. */
export function readNewTabLabel(): string {
  return readChoice("newTabLabel", (value): value is string => typeof value === "string", "");
}

export function writeNewTabAgent(id: string, label = ""): void {
  writeChoice("newTabAgent", id);
  writeChoice("newTabLabel", label);
}

/** The stored value of the ★ on an agent's API row / a local-model row. */
export const apiTarget = (agentId: string): string => `api:${agentId}`;
export const localTarget = (launchId: string): string => `local:${launchId}`;

/** What a tap on ＋ starts. `key` is the stored value the sheet stars by. */
export interface NewTabTarget {
  key: string;
  kind: "agent" | "api" | "local";
  /** Absent for a local-model row, which names no catalog agent. */
  agent?: AgentRow;
  launch?: NewTabLaunch;
  /** The name for the tooltip; for `api` the agent's own, which the caller words. */
  label: string;
}

/** The target a tap on ＋ starts: the starred one while the desktop still
 * offers its agent (a local row cannot be checked without the sheet's
 * `launch-options`, so a vanished one fails at create), else the desktop's
 * default, else the first listed. */
export function newTabTarget(agents: AgentRow[], starred = readNewTabAgent(), starredLabel = readNewTabLabel()): NewTabTarget | undefined {
  if (starred.startsWith("local:")) {
    return { key: starred, kind: "local", launch: { local: starred.slice("local:".length) }, label: starredLabel };
  }
  const api = starred.startsWith("api:");
  const id = api ? starred.slice("api:".length) : starred;
  const agent = agents.find((entry) => entry.id === id);
  if (agent && api) return { key: starred, kind: "api", agent, launch: { api_key: true }, label: agent.label };
  const picked = agent && !api ? agent : agents.find((entry) => entry.default) ?? agents[0];
  return picked ? { key: picked.id, kind: "agent", agent: picked, label: picked.label } : undefined;
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
