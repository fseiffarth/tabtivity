/**
 * The model of keyboard steering's bar and key caps (`SteeringLegend`): which of
 * the level's keys sit in the docked bar and which are pinned as a cap to the
 * control they fire, and the level ladder. Pure — the DOM half (finding the
 * controls) is `steeringCaps.ts` — so it tests without a layout engine.
 *
 * The rows are the same table the cheat sheet reads (`STEERING_KEYS` through
 * `steeringKeysFor`) and every key shown is the user's binding, so a rebound key
 * moves in the bar and on its cap together. A row whose control cannot be found
 * (the panel is hidden, the tab is no agent's) stays in the bar: a key that
 * works is always listed somewhere.
 */
import type { TranslationKey } from "../i18n";
import type { ReaderViewId } from "../agents/readerSteering";
import type { SteeringBaseLevel, SteeringLevel, SteeringRegion } from "../../stores/keyboardSteering";
import type { SteeringGroup, SteeringKeyDef } from "./shortcuts";
import {
  steeringKeyLabel,
  steeringKeys,
  steeringSlotKeys,
  type SteeringAction,
  type SteeringKeyMap,
} from "./steeringBindings";

/** A control a cap row is pinned to (`steeringCaps.ts` finds each in the DOM). */
export type CapAnchor =
  | "addProject"
  | "mail"
  | "calendar"
  | "todo"
  | "cockpit"
  | "settings"
  | "sidePanel"
  | "panels"
  | "tab"
  | "add"
  | "files"
  | "card"
  | "prompt"
  | "cursor";

/** Where each action's control is. An action not listed lives in the bar. */
const ACTION_ANCHOR: Partial<Record<SteeringAction, CapAnchor>> = {
  newProject: "addProject",
  mail: "mail",
  calendar: "calendar",
  todo: "todo",
  cockpit: "cockpit",
  settings: "settings",
  sidePanel: "sidePanel",
  panels: "panels",
  closeTab: "tab",
  newShell: "add",
  newMonitor: "add",
  newTabMenu: "add",
  files: "files",
  tabCard: "card",
  agentPrompt: "prompt",
  agentPlan: "prompt",
  agentGoal: "prompt",
  agentClear: "prompt",
  press: "cursor",
};

/** Anchors whose key is also listed in the bar: the caps only point at where
 *  the key acts (the bar still carries the region's whole vocabulary). */
const ALSO_IN_BAR: ReadonlySet<CapAnchor> = new Set(["cursor"]);

/** Order of a prompt strip's caps: I L G K reads as the prompt box first. */
const CAP_RANK: Partial<Record<SteeringAction, number>> = {
  agentPrompt: 0,
  agentPlan: 1,
  agentGoal: 2,
  agentClear: 3,
};

/** The anchor a row is pinned to, or null when it belongs in the bar. */
export function anchorOf(row: SteeringKeyDef): CapAnchor | null {
  if (row.agentSlots) return "add";
  // The side panel's own key closes it again (a mode row): the bar's.
  if (row.group === "mode") return null;
  return row.actions.length === 1 ? (ACTION_ANCHOR[row.actions[0]] ?? null) : null;
}

/** One key cap: its text, and the colour class of the group it belongs to. */
export interface BarCap {
  key: string;
  tok: string;
}

/** One entry of the bar: the keys, what they do, and for a status jump the
 *  number of tabs it would reach. */
export interface BarItem {
  id: string;
  group: SteeringGroup;
  caps: string[];
  labelKey: TranslationKey;
  descKey?: TranslationKey;
  /** Names the agents behind a "1–N" entry (hover text). */
  title?: string;
  status?: "decision" | "working" | "done";
  /** The right-hand block of the bar after the divider (leave the mode). */
  leave?: true;
}

/** The caps of one row. A direction pair shows its first keys ("S F", the
 *  arrows being the second column), a Shift row leads with a Shift cap, the
 *  number slots are one cap. `agentKeys` are the bound keys of the agents the
 *  focused pane's digits open. */
export function rowCaps(row: SteeringKeyDef, overrides: SteeringKeyMap | null | undefined, agentKeys?: string[]): string[] {
  if (row.agentSlots) {
    return agentKeys && agentKeys.length > 0 ? [slotRange(agentKeys)] : [];
  }
  if (row.slots) return [steeringSlotKeys(overrides)];
  const keys = row.actions
    .map((a) => steeringKeys(a, overrides)[0])
    .filter((k): k is string => !!k)
    .map(steeringKeyLabel);
  const unique = [...new Set(keys)];
  return row.shift && unique.length > 0 ? ["Shift", ...unique] : unique;
}

/** "1–N" when the slots are the default digits 1..N, else the keys in order. */
export function slotRange(keys: string[]): string {
  if (keys.every((k, i) => k === String(i + 1))) return keys.length === 1 ? "1" : `1–${keys.length}`;
  return keys.join(" ");
}

/** Bar groups, in the order they read left to right; a pinned row that found
 *  no control joins them in its own group, after the act keys. */
const BAR_ORDER: SteeringGroup[] = ["move", "status", "act", "new", "agent", "open"];

export interface BarModel {
  /** The bar's keys, left to right. */
  items: BarItem[];
  /** The cap rows by control, in press order. */
  caps: Map<CapAnchor, { row: SteeringKeyDef; caps: BarCap[] }[]>;
}

/**
 * Splits the level's rows into the bar and the caps. `placed` is the set of
 * controls the DOM half found on screen; `tokFor` maps a group to its colour
 * class. At the subwindow and tab levels the two vertical rows collapse into
 * the ladder's one "up · down" entry.
 */
export function barModel(
  rows: SteeringKeyDef[],
  level: SteeringLevel,
  placed: ReadonlySet<CapAnchor>,
  overrides: SteeringKeyMap | null | undefined,
  agents: { key: string; label: string }[],
  tokFor: (g: SteeringGroup) => string,
): BarModel {
  const agentKeys = agents.map((a) => a.key);
  const items: BarItem[] = [];
  const caps: BarModel["caps"] = new Map();
  const collapse = level === "panes" || level === "tabs";
  let collapsed = false;
  for (const row of rows) {
    const anchor = anchorOf(row);
    const pinned = anchor !== null && placed.has(anchor);
    if (pinned) {
      const list = caps.get(anchor) ?? [];
      const keys = rowCaps(row, overrides, agentKeys);
      if (keys.length > 0) {
        list.push({ row, caps: keys.map((key) => ({ key, tok: tokFor(row.group) })) });
        list.sort((a, b) => (CAP_RANK[a.row.actions[0]] ?? 9) - (CAP_RANK[b.row.actions[0]] ?? 9));
        caps.set(anchor, list);
      }
      if (!ALSO_IN_BAR.has(anchor)) continue;
    }
    if (collapse && isVertical(row)) {
      collapsed = true;
      continue;
    }
    if (row.actions.includes("exit") && row.actions.includes("work")) {
      // Enter works here, Esc exits: two entries, as two keys.
      for (const [action, labelKey] of [
        ["work", "steering.work.label"],
        ["exit", "steering.exit.label"],
      ] as const) {
        const key = steeringKeys(action, overrides)[0];
        if (key) {
          items.push({ id: `${row.labelKey}|${action}`, group: "mode", caps: [steeringKeyLabel(key)], labelKey, descKey: row.descKey, leave: true });
        }
      }
      continue;
    }
    const keys = rowCaps(row, overrides, agentKeys);
    if (keys.length === 0) continue;
    items.push({
      id: `${row.actions.join(",")}|${row.labelKey}`,
      group: row.group,
      caps: keys,
      labelKey: row.agentSlots ? "steering.newAgent.clis" : row.labelKey,
      descKey: row.descKey,
      title: row.agentSlots ? agents.map((a) => `${a.key} ${a.label}`).join(" · ") : undefined,
      status: row.status,
    });
  }
  if (collapsed) {
    const up = steeringKeys("up", overrides)[0];
    const down = steeringKeys("down", overrides)[0];
    const keys = [up, down].filter((k): k is string => !!k).map(steeringKeyLabel);
    if (keys.length > 0) {
      items.unshift({ id: "upDown", group: "move", caps: keys, labelKey: "steering.bar.upDown" });
    }
  }
  const rank = (i: BarItem) => (i.leave ? 100 : i.group === "mode" ? 90 : BAR_ORDER.indexOf(i.group));
  // Array.sort is stable: the table's order holds inside a group.
  items.sort((a, b) => rank(a) - rank(b));
  return { items, caps };
}

function isVertical(row: SteeringKeyDef): boolean {
  return row.group === "move" && row.actions.length === 1 && (row.actions[0] === "up" || row.actions[0] === "down");
}

// ── The ladder ─────────────────────────────────────────────────────────────

export interface Rung {
  id: string;
  labelKey: TranslationKey;
  lit?: boolean;
  /** The keyboard is lent to the box this rung names. */
  lent?: boolean;
}

/** Names of the surfaces a region cursor walks. */
export const REGION_LABEL: Record<SteeringRegion, TranslationKey> = {
  side: "steering.region.side",
  mail: "steering.mail.label",
  calendar: "steering.calendar.label",
  todo: "steering.todo.label",
  addTab: "steering.newTabMenu.label",
  settings: "steering.settings.label",
  header: "steering.region.header",
  chrome: "steering.region.chrome",
  card: "steering.region.card",
  overlay: "steering.region.overlay",
};

const BASE_RUNGS: { id: SteeringBaseLevel; labelKey: TranslationKey }[] = [
  { id: "projects", labelKey: "steering.level.projects" },
  { id: "panes", labelKey: "steering.level.panes" },
  { id: "tabs", labelKey: "steering.level.tabs" },
  { id: "scroll", labelKey: "steering.bar.inside" },
];

/** What the lit "Inside" rung is called: the document, the Reader's chat /
 *  Diffs / Files view, else the terminal. */
function scrollLabel(opts: { document?: boolean; reader?: { view: ReaderViewId } }): TranslationKey {
  if (opts.document) return "steering.level.scrollDocument";
  switch (opts.reader?.view) {
    case "chat":
      return "steering.level.scrollChat";
    case "changes":
      return "steering.level.scrollChanges";
    case "files":
      return "steering.level.scrollFiles";
    default:
      return "steering.level.scroll";
  }
}

/**
 * Projects › Subwindows › Tabs › Inside, the lit rung being where the arrows
 * act. Inside a surface the ladder is cut to the level it was entered from and
 * the surface's name; lent to a box, to that level and the box.
 */
export function ladder(opts: {
  level: SteeringLevel;
  region: SteeringRegion | null;
  regionReturn: SteeringBaseLevel;
  /** Inside a document rather than a terminal. */
  document?: boolean;
  /** The active tab's Reader view, when it draws a strip: Inside names it. */
  reader?: { view: ReaderViewId };
  lent?: TranslationKey;
}): Rung[] {
  const base = (id: SteeringBaseLevel, lit: boolean): Rung => {
    const def = BASE_RUNGS.find((r) => r.id === id)!;
    const labelKey = lit && id === "scroll" ? scrollLabel(opts) : def.labelKey;
    return { id, labelKey, lit };
  };
  if (opts.lent) {
    const from = opts.level === "region" ? opts.regionReturn : opts.level;
    const rungs: Rung[] = [base(from, false)];
    if (opts.level === "region" && opts.region) rungs.push({ id: "region", labelKey: REGION_LABEL[opts.region] });
    rungs.push({ id: "lent", labelKey: opts.lent, lit: true, lent: true });
    return rungs;
  }
  if (opts.level === "region") {
    const rungs: Rung[] = [base(opts.regionReturn, false)];
    if (opts.region) rungs.push({ id: "region", labelKey: REGION_LABEL[opts.region], lit: true });
    return rungs;
  }
  return BASE_RUNGS.map((r) => base(r.id, r.id === opts.level));
}
