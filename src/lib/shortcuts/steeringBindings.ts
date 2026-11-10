/**
 * The rebindable keys INSIDE keyboard steering mode — the sibling of
 * `SHORTCUT_DEFS` for a mode that owns the whole keyboard.
 *
 * Unlike the chords, a steering binding is a bare key (`KeyboardEvent.key`,
 * normalized by `normalizeKey`): the mode swallows every key anyway, so no
 * modifier is needed to keep one apart from typing, and Shift already means
 * something (the status jumps walk backwards with it, and `?` or `+` are
 * shifted on many layouts). Each action holds up to two keys — the home-row
 * letter and its arrow, say — stored in `settings.steering_keys` as the whole
 * list, so a user list replaces the defaults, and an empty list unbinds.
 *
 * A key means one thing per level: N is a new project up top and a new shell
 * inside a pane. Where an action makes sense on both, it keeps its key on both
 * (M C T open mail, calendar and the to-do board from anywhere a tab bar is). `scopes` says where an action acts, which is what the handler
 * resolves against (`steeringActionFor`) and what the conflict check compares.
 *
 * `inside` is the scroll level (Inside a tab) of an agent Reader's Diffs and
 * Files view: its own letters (`viewToggle` …) shadow the panes keys that are
 * dead there, and everything else of `panes` / `mode` still resolves.
 */
import type { TranslationKey } from "../i18n";
import { isLoneModifier, normalizeKey } from "./keyNames";

/** How many keys one steering action can hold. */
export const STEERING_KEYS_PER_ACTION = 2;

/** The nine number slots: project N on the projects level, agent N in a pane. */
export const STEERING_SLOT_ACTIONS = [
  "slot1",
  "slot2",
  "slot3",
  "slot4",
  "slot5",
  "slot6",
  "slot7",
  "slot8",
  "slot9",
] as const;
export type SteeringSlotAction = (typeof STEERING_SLOT_ACTIONS)[number];

export type SteeringAction =
  | "help"
  | "exit"
  | "legend"
  | "up"
  | "down"
  | "left"
  | "right"
  | "work"
  | "back"
  | "press"
  | "search"
  | "confirm"
  | "newProject"
  | "mail"
  | "calendar"
  | "todo"
  | "cockpit"
  | "newShell"
  | "newMonitor"
  | "newTabMenu"
  | "files"
  | "closeTab"
  | "agentPrompt"
  | "nextDecision"
  | "nextWorking"
  | "nextDone"
  | "jumpBack"
  | "sidePanel"
  | "panels"
  | "settings"
  | "jumpProject"
  | "popout"
  | "readerView"
  | "menu"
  | "tabCard"
  | "subagents"
  | "cockpitPanel"
  | "cockpitDown"
  | "cockpitUp"
  | "cockpitJump"
  | "cockpitShow"
  | "cockpitContinue"
  | "cockpitFilter"
  | "viewToggle"
  | "viewMode"
  | "viewOpen"
  | "viewOpenAlt"
  | "viewNew"
  | SteeringSlotAction;

/** Where an action acts. `mode` is every level; `panes` covers the subwindow
 *  and tab levels, which share one handler. `cockpit` is not a steering level
 *  at all: the cockpit roster's own keys (`CockpitRoster`), kept in this table
 *  so they are rebound where the other bare keys are. */
export type SteeringScope = "mode" | "projects" | "panes" | "inside" | "region" | "cockpit";

/** The level steering is on, as the resolver sees it. */
export type SteeringKeyContext = Exclude<SteeringScope, "mode">;

export interface SteeringBindingDef {
  action: SteeringAction;
  labelKey: TranslationKey;
  scopes: readonly SteeringScope[];
  defaults: readonly string[];
}

/** The settings panel's sections, in display order. */
export const STEERING_BINDING_SECTIONS: { scope: SteeringScope; labelKey: TranslationKey }[] = [
  { scope: "mode", labelKey: "steeringKeys.section.mode" },
  { scope: "projects", labelKey: "steering.level.projects" },
  { scope: "panes", labelKey: "steeringKeys.section.panes" },
  { scope: "inside", labelKey: "steeringKeys.section.inside" },
  { scope: "region", labelKey: "steering.level.region" },
  { scope: "cockpit", labelKey: "cockpit.title" },
];

const TAB_BAR: readonly SteeringScope[] = ["projects", "panes"];

/**
 * The table, in resolution order: the first action whose scope fits the level
 * and whose keys hold the pressed key wins. The mode-wide keys come first, as
 * the handler always checked them first.
 */
export const STEERING_BINDINGS: SteeringBindingDef[] = [
  { action: "help", labelKey: "steering.help.label", scopes: ["mode"], defaults: ["?"] },
  // Esc leaves on the tab-bar levels; inside a region it backs out instead
  // (`back`), so leaving from there is Esc twice.
  { action: "exit", labelKey: "steering.exit.label", scopes: TAB_BAR, defaults: ["Escape"] },
  { action: "legend", labelKey: "steering.legend.label", scopes: ["mode"], defaults: ["h"] },
  { action: "up", labelKey: "steeringKeys.up", scopes: ["mode"], defaults: ["e", "ArrowUp"] },
  { action: "down", labelKey: "steeringKeys.down", scopes: ["mode"], defaults: ["d", "ArrowDown"] },
  { action: "left", labelKey: "steeringKeys.left", scopes: ["mode"], defaults: ["s", "ArrowLeft"] },
  { action: "right", labelKey: "steeringKeys.right", scopes: ["mode"], defaults: ["f", "ArrowRight"] },
  { action: "work", labelKey: "steering.work.label", scopes: TAB_BAR, defaults: ["Enter"] },
  { action: "newProject", labelKey: "steering.newProject.label", scopes: ["projects"], defaults: ["n"] },
  { action: "mail", labelKey: "steering.mail.label", scopes: TAB_BAR, defaults: ["m"] },
  { action: "calendar", labelKey: "steering.calendar.label", scopes: TAB_BAR, defaults: ["c"] },
  { action: "todo", labelKey: "steering.todo.label", scopes: TAB_BAR, defaults: ["t"] },
  // U: no tab-bar level had it (the cockpit's own letters were all taken).
  { action: "cockpit", labelKey: "steering.cockpit.label", scopes: TAB_BAR, defaults: ["u"] },
  { action: "newShell", labelKey: "steering.newShell.label", scopes: ["panes"], defaults: ["n"] },
  { action: "newMonitor", labelKey: "steering.newMonitor.label", scopes: ["panes"], defaults: ["o"] },
  { action: "newTabMenu", labelKey: "steering.newTabMenu.label", scopes: ["panes"], defaults: ["+", "="] },
  { action: "files", labelKey: "steering.files.label", scopes: ["panes"], defaults: ["v"] },
  { action: "closeTab", labelKey: "steering.closeTab.label", scopes: ["panes"], defaults: ["w"] },
  { action: "tabCard", labelKey: "steering.tabCard.label", scopes: ["panes"], defaults: ["a"] },
  // G: the agent tab's Subagents list (A, its card, was taken).
  { action: "subagents", labelKey: "steering.subagents.label", scopes: ["panes"], defaults: ["g"] },
  { action: "agentPrompt", labelKey: "steering.agentPrompt.label", scopes: ["panes"], defaults: [" "] },
  { action: "nextDecision", labelKey: "steering.nextDecision.label", scopes: TAB_BAR, defaults: ["q"] },
  { action: "nextWorking", labelKey: "steering.nextWorking.label", scopes: TAB_BAR, defaults: ["r"] },
  { action: "nextDone", labelKey: "steering.nextDone.label", scopes: TAB_BAR, defaults: ["x"] },
  // Back to the tab the status jumps above left (`statusJump.afterStatusJump`).
  { action: "jumpBack", labelKey: "steering.jumpBack.label", scopes: TAB_BAR, defaults: ["Backspace"] },
  { action: "sidePanel", labelKey: "steering.sidePanel.label", scopes: TAB_BAR, defaults: ["b"] },
  { action: "panels", labelKey: "steering.panels.label", scopes: TAB_BAR, defaults: ["p"] },
  { action: "settings", labelKey: "steering.settings.label", scopes: TAB_BAR, defaults: [","] },
  { action: "jumpProject", labelKey: "steering.jumpProject.label", scopes: TAB_BAR, defaults: ["/"] },
  { action: "popout", labelKey: "steering.popout.label", scopes: TAB_BAR, defaults: ["j"] },
  // The agent tab's Reader view (Chat / Diffs / Files / Terminal), one step on;
  // with Shift the other way. Live on the tabs and Inside, not in the projects.
  { action: "readerView", labelKey: "steering.readerView.label", scopes: ["panes"], defaults: ["Tab"] },
  ...STEERING_SLOT_ACTIONS.map(
    (action, i): SteeringBindingDef => ({
      action,
      labelKey: `steeringKeys.${action}`,
      scopes: TAB_BAR,
      defaults: [String(i + 1)],
    }),
  ),
  // Inside a Reader view (Diffs, Files): generic names, each view says what the
  // key does to it (`readerSteering`'s inside targets). They shadow the panes
  // keys of the same letter only on the scroll level, where those are dead.
  { action: "viewToggle", labelKey: "steering.viewToggle.label", scopes: ["inside"], defaults: ["z"] },
  { action: "viewMode", labelKey: "steering.viewMode.label", scopes: ["inside"], defaults: ["u"] },
  { action: "viewOpen", labelKey: "steering.viewOpen.label", scopes: ["inside"], defaults: ["o"] },
  { action: "viewOpenAlt", labelKey: "steering.viewOpenAlt.label", scopes: ["inside"], defaults: ["v"] },
  { action: "viewNew", labelKey: "steering.viewNew.label", scopes: ["inside"], defaults: ["n"] },
  { action: "back", labelKey: "steering.back.label", scopes: ["region"], defaults: ["Escape"] },
  { action: "press", labelKey: "steering.press.label", scopes: ["region"], defaults: ["Enter"] },
  { action: "search", labelKey: "steering.search.label", scopes: ["region"], defaults: ["/"] },
  // The yes of steering's own "are you sure" (W's close, K's clear).
  { action: "confirm", labelKey: "steering.confirm.label", scopes: ["region"], defaults: ["y"] },
  // The right-click menu of what steering points at: the active project, the
  // active tab, the control under the region cursor.
  { action: "menu", labelKey: "steering.menu.label", scopes: ["mode"], defaults: [".", "ContextMenu"] },
  // Cockpit roster actions also serve the dedicated steering region.
  { action: "cockpitPanel", labelKey: "cockpit.keys.panel", scopes: ["cockpit"], defaults: ["Tab"] },
  { action: "cockpitDown", labelKey: "cockpit.keys.down", scopes: ["cockpit"], defaults: ["j", "ArrowDown"] },
  { action: "cockpitUp", labelKey: "cockpit.keys.up", scopes: ["cockpit"], defaults: ["k", "ArrowUp"] },
  { action: "cockpitJump", labelKey: "cockpit.keys.jump", scopes: ["cockpit"], defaults: ["Enter"] },
  { action: "cockpitShow", labelKey: "cockpit.keys.show", scopes: ["cockpit"], defaults: [" ", "ArrowRight"] },
  { action: "cockpitContinue", labelKey: "cockpit.keys.continue", scopes: ["cockpit"], defaults: ["c"] },
  { action: "cockpitFilter", labelKey: "cockpit.keys.filter", scopes: ["cockpit"], defaults: ["/"] },
];

/** The stored overrides (action id → its whole key list). Mirrors
 *  `Settings["steering_keys"]`. */
export type SteeringKeyMap = Partial<Record<SteeringAction, string[]>>;

const DEF_BY_ACTION = new Map(STEERING_BINDINGS.map((d) => [d.action, d]));

/** The keys an action answers to: the user's list if set (empty = unbound),
 *  else its defaults. */
export function steeringKeys(action: SteeringAction, overrides: SteeringKeyMap | null | undefined): readonly string[] {
  return overrides?.[action] ?? DEF_BY_ACTION.get(action)?.defaults ?? [];
}

function scopeFits(scopes: readonly SteeringScope[], context: SteeringKeyContext): boolean {
  if (scopes.includes("mode") || scopes.includes(context) || (context === "cockpit" && scopes.includes("region"))) return true;
  // Inside a tab the panes keys still resolve (Work here, the prompt, the view
  // cycle, a dead letter that is swallowed) under the `inside` ones.
  return context === "inside" && scopes.includes("panes");
}

/** The defs that can answer on `context`, in resolution order: Inside, the
 *  `inside` letters first, then the rest in table order. */
function defsFor(context: SteeringKeyContext): SteeringBindingDef[] {
  const fits = STEERING_BINDINGS.filter((def) => scopeFits(def.scopes, context));
  if (context === "cockpit") return [...fits.filter((d) => d.scopes.includes("cockpit")), ...fits.filter((d) => !d.scopes.includes("cockpit"))];
  if (context !== "inside") return fits;
  return [...fits.filter((d) => d.scopes.includes("inside")), ...fits.filter((d) => !d.scopes.includes("inside"))];
}

/** Whether a keydown is `key`: by character, and a digit also by physical key
 *  — AZERTY types `&` on the key US calls 1, the same fallback `chordMatches`
 *  gives the digit chords. */
export function keyMatches(key: string, e: Pick<KeyboardEvent, "key" | "code">): boolean {
  if (normalizeKey(e.key) === normalizeKey(key)) return true;
  return /^[0-9]$/.test(key) && (e.code === `Digit${key}` || e.code === `Numpad${key}`);
}

/** Whether a keydown is one of `action`'s keys, whatever level it is live on. */
export function steeringKeyIs(
  e: Pick<KeyboardEvent, "key" | "code">,
  action: SteeringAction,
  overrides: SteeringKeyMap | null | undefined,
): boolean {
  return steeringKeys(action, overrides).some((k) => keyMatches(k, e));
}

/**
 * The action a keydown triggers on `context`, or null when nothing is bound
 * there. Modifiers are ignored (see the file comment); Shift is read by the
 * status jumps themselves.
 */
export function steeringActionFor(
  e: Pick<KeyboardEvent, "key" | "code">,
  context: SteeringKeyContext,
  overrides: SteeringKeyMap | null | undefined,
): SteeringAction | null {
  // Character matches first, so a letter bound to one action never loses to a
  // digit another action claims by physical position.
  const defs = defsFor(context);
  for (const def of defs) {
    if (steeringKeys(def.action, overrides).some((k) => normalizeKey(k) === normalizeKey(e.key))) return def.action;
  }
  for (const def of defs) {
    if (steeringKeys(def.action, overrides).some((k) => keyMatches(k, e))) return def.action;
  }
  return null;
}

/** The slot number (1–9) of a slot action, else null. */
export function steeringSlot(action: SteeringAction | null): number | null {
  const i = action ? (STEERING_SLOT_ACTIONS as readonly string[]).indexOf(action) : -1;
  return i < 0 ? null : i + 1;
}

/** The `panes` actions that still act Inside a tab. Every other `panes` key is
 *  dead there (swallowed), so an `inside` key may share its letter. */
const LIVE_INSIDE: ReadonlySet<SteeringAction> = new Set<SteeringAction>([
  "work",
  "exit",
  "agentPrompt",
  "readerView",
  ...STEERING_SLOT_ACTIONS,
]);

/** Whether two actions can both be live on one level. */
function defsMeet(a: SteeringBindingDef, b: SteeringBindingDef): boolean {
  // Cockpit keys shadow region activation/search and mode movement while
  // the cursor is in the roster. Other cockpit/mode overlaps are conflicts.
  if (a.scopes.includes("cockpit") !== b.scopes.includes("cockpit")) {
    const other = a.scopes.includes("cockpit") ? b : a;
    return other.scopes.includes("mode") && !["up", "down", "left", "right"].includes(other.action);
  }
  if (a.scopes.includes("mode") || b.scopes.includes("mode")) return true;
  // `inside` meets `inside`, and a `panes` key only where that is live Inside.
  const aIn = a.scopes.includes("inside");
  const bIn = b.scopes.includes("inside");
  if (aIn !== bIn) {
    const other = aIn ? b : a;
    if (!other.scopes.includes("panes")) return false;
    return LIVE_INSIDE.has(other.action);
  }
  return a.scopes.some((s) => b.scopes.includes(s));
}

/**
 * Which actions share a key with another action live on the same level — the
 * later one in `STEERING_BINDINGS` never fires for that key. Both sides get an
 * entry, as `findConflicts` does for the chords.
 */
export function findSteeringConflicts(
  overrides: SteeringKeyMap | null | undefined,
): Map<SteeringAction, SteeringAction[]> {
  const out = new Map<SteeringAction, SteeringAction[]>();
  for (let i = 0; i < STEERING_BINDINGS.length; i++) {
    for (let j = i + 1; j < STEERING_BINDINGS.length; j++) {
      const a = STEERING_BINDINGS[i];
      const b = STEERING_BINDINGS[j];
      if (!defsMeet(a, b)) continue;
      const bKeys = steeringKeys(b.action, overrides).map(normalizeKey);
      if (!steeringKeys(a.action, overrides).some((k) => bKeys.includes(normalizeKey(k)))) continue;
      out.set(a.action, [...(out.get(a.action) ?? []), b.action]);
      out.set(b.action, [...(out.get(b.action) ?? []), a.action]);
    }
  }
  return out;
}

/** Display form of one steering key: glyphs for the arrows, words for the
 *  keys that print nothing, upper case for letters. Never translated. */
export function steeringKeyLabel(key: string): string {
  const map: Record<string, string> = {
    ArrowLeft: "←",
    ArrowRight: "→",
    ArrowUp: "↑",
    ArrowDown: "↓",
    " ": "Space",
    Escape: "Esc",
    ContextMenu: "Menu",
  };
  if (map[key]) return map[key];
  return key.length === 1 ? key.toUpperCase() : key;
}

/**
 * The key text for a legend / cheat-sheet row acting through `actions`.
 * A `pair` (a direction pair, ←/→) reads column-wise — "S F / ← →", each
 * action's first keys, then its second — anything else lists every key once,
 * "Space / Enter / Esc". Unbound actions contribute nothing; a row with no key
 * at all reads "—".
 */
export function steeringRowKeys(
  actions: readonly SteeringAction[],
  overrides: SteeringKeyMap | null | undefined,
  pair = false,
): string {
  const lists = actions.map((a) => steeringKeys(a, overrides).map(steeringKeyLabel));
  let text: string;
  if (pair) {
    const cols: string[] = [];
    for (let i = 0; i < STEERING_KEYS_PER_ACTION; i++) {
      const col = lists.map((l) => l[i]).filter((k): k is string => !!k);
      if (col.length > 0) cols.push(col.join(" "));
    }
    text = cols.join(" / ");
  } else {
    text = [...new Set(lists.flat())].join(" / ");
  }
  return text || "—";
}

/** The slots' key text: "1–9" while they are the digits, else each slot's
 *  first key in order. */
export function steeringSlotKeys(overrides: SteeringKeyMap | null | undefined): string {
  const firsts = STEERING_SLOT_ACTIONS.map((a) => steeringKeys(a, overrides)[0]);
  if (firsts.every((k, i) => k === String(i + 1))) return "1–9";
  return firsts.map((k) => (k ? steeringKeyLabel(k) : "—")).join(" ");
}

/** The key to show for slot `n` (1-based) in the legend: its first key. */
export function steeringSlotKey(n: number, overrides: SteeringKeyMap | null | undefined): string | null {
  const action = STEERING_SLOT_ACTIONS[n - 1];
  const k = action ? steeringKeys(action, overrides)[0] : undefined;
  return k ? steeringKeyLabel(k) : null;
}

/** The key a steering capture stores for a keydown, or null for a lone
 *  modifier (the caller keeps waiting). */
export function steeringKeyFromEvent(e: Pick<KeyboardEvent, "key">): string | null {
  return isLoneModifier(e.key) ? null : normalizeKey(e.key);
}
