/**
 * #62 / Group L — shared keyboard-shortcut model.
 *
 * One source of truth for the app's chords, every one of them rebindable.
 * Both `useKeyboard.ts` (which acts on them) and the settings panel (which lets
 * the user customise them) import from here, so the default table and the
 * matching logic never drift.
 *
 * A chord is a plain, serializable descriptor (`ChordDescriptor`) stored in
 * `settings.keyboard_shortcuts` keyed by action id; `{ key: "" }` is a chord
 * the user switched off (`UNBOUND`), and `{ key: "Super" }` a lone tap of the
 * Super key (`LONE_SUPER`, the panel toggle's Linux default).
 *
 * `STEERING_KEYS` (bottom) lists the rows the steering legend, cheat sheet and
 * lessons explain; the keys behind them are the rebindable steering bindings
 * in `steeringBindings.ts`.
 */
import { IS_MAC, PLATFORM } from "../platform";
import type { UntestedId } from "../untested";
import { desktopOwnsSuperKey } from "./superKey";
import { zoomChord, type ZoomChord } from "./zoomChord";
import type { TranslationKey } from "../i18n";
import {
  steeringRowKeys,
  steeringSlotKeys,
  type SteeringAction,
  type SteeringKeyMap,
} from "./steeringBindings";

/** A serializable key chord. `key` is a `KeyboardEvent.key` value, normalized:
 *  single letters are lower-cased, named keys ("Tab", "Enter", "ArrowLeft")
 *  are kept verbatim. Modifier booleans default to false when absent. */
export interface ChordDescriptor {
  key: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  meta?: boolean;
}

/** Stable ids for each rebindable navigation action. */
export type ShortcutAction =
  | "toggleFullscreen"
  | "cycleProject"
  | "prevTab"
  | "nextTab"
  | "subwindowUp"
  | "subwindowDown"
  | "cycleTabs"
  | "hideSubwindow"
  | "toggleSubwindowFiles"
  | "closeSubwindow"
  | "closeTab"
  | "closeAllTabs"
  | "reopenClosedTab"
  | "steeringMode"
  | "cycleProjectBack"
  | "cycleBox"
  | "cycleBoxBack"
  | "shortcutHelp"
  | "rootConsole"
  | "projectShell"
  | "newShellTab"
  | "newMonitorTab"
  | AgentTabAction
  | "texUp"
  | "texBack"
  | "texCompile"
  | "osFullscreen"
  | "togglePanels"
  | "exitFullscreen"
  | "zoomIn"
  | "zoomOut"
  | "zoomReset"
  | "terminalCopy"
  | "terminalPaste"
  | "terminalKeySelect"
  | "editorFind"
  | "editorReplace"
  | "editorAutocomplete"
  | "editorUndo"
  | "editorRedo"
  | "editorSave"
  | "editorComment";

/** The agent-tab chords, one per slot of the + menu's numbered agents
 *  (`agentShortcutSlots`): slot 1 is the default agent, 2–9 the others. */
export const AGENT_TAB_ACTIONS = [
  "agentTab1",
  "agentTab2",
  "agentTab3",
  "agentTab4",
  "agentTab5",
  "agentTab6",
  "agentTab7",
  "agentTab8",
  "agentTab9",
] as const;
export type AgentTabAction = (typeof AGENT_TAB_ACTIONS)[number];

/** Section ids for the cheat-sheet/settings grouping (`SHORTCUT_GROUPS`). */
export type ShortcutGroup = "navigation" | "tabs" | "newTab" | "view" | "terminal" | "editor" | "steering" | "tex";

export interface ShortcutDef {
  action: ShortcutAction;
  /** i18n key for the row's description, resolved by the cheat sheet and the
   *  settings panel — the label itself lives in `lib/i18n` like every other
   *  user-facing string. */
  labelKey: TranslationKey;
  /** Which `SHORTCUT_GROUPS` section the action is listed under. */
  group: ShortcutGroup;
  /** The built-in default chord, used whenever the user hasn't rebound it. */
  default: ChordDescriptor;
  /** The pill's id in the untested register (`lib/untested`), which renders
   *  the shared `UntestedTag` beside the row in the settings panel; stamping
   *  that row `tested` retires the pill. */
  untested?: UntestedId;
  /** Where the action is listened for when that is narrower than the whole
   *  window: a focused terminal, or the text editor (the TeX workspace wraps
   *  one). Two actions of different contexts may share a chord. */
  context?: "terminal" | "editor";
  /** The action may be bound to a lone Super tap (`LONE_SUPER`) — captured
   *  on Linux only, where the key can be the focused window's at all. */
  loneSuper?: true;
}

/** The cheat sheet's section order + i18n titles — kept here beside the defs
 *  so a new action must pick its section where the table lives. */
export const SHORTCUT_GROUPS: { id: ShortcutGroup; labelKey: TranslationKey }[] = [
  { id: "navigation", labelKey: "shortcutHelp.group.navigation" },
  { id: "tabs", labelKey: "shortcutHelp.group.tabs" },
  { id: "newTab", labelKey: "shortcutHelp.group.newTab" },
  { id: "view", labelKey: "shortcutHelp.group.view" },
  { id: "terminal", labelKey: "shortcutHelp.group.terminal" },
  { id: "editor", labelKey: "shortcutHelp.group.editor" },
  { id: "steering", labelKey: "shortcutHelp.group.steering" },
  { id: "tex", labelKey: "shortcutHelp.group.tex" },
];

/**
 * The configurable action table, in display order. The defaults mirror the
 * historical hard-coded chords in `useKeyboard` so behaviour is unchanged when
 * `keyboard_shortcuts` is empty.
 */
export const SHORTCUT_DEFS: ShortcutDef[] = [
  {
    action: "toggleFullscreen",
    labelKey: "shortcut.toggleFullscreen",
    group: "tabs",
    default: { key: "Enter", ctrl: true },
  },
  {
    action: "cycleProject",
    labelKey: "shortcut.cycleProject",
    group: "navigation",
    default: { key: "Tab", ctrl: true, shift: true },
  },
  // Ctrl+Shift, not plain Shift: a plain Shift+Arrow is an agent CLI's own
  // chord (Codex uses it for in-terminal selection/navigation), and a pane
  // terminal already hands prevTab/nextTab over via `terminalMayTakeChord` —
  // that handoff must not eat a chord the agent inside wants for itself.
  {
    action: "prevTab",
    labelKey: "shortcut.prevTab",
    group: "tabs",
    default: { key: "ArrowLeft", ctrl: true, shift: true },
    untested: "shortcut.prevTab",
  },
  {
    action: "nextTab",
    labelKey: "shortcut.nextTab",
    group: "tabs",
    default: { key: "ArrowRight", ctrl: true, shift: true },
    untested: "shortcut.nextTab",
  },
  {
    action: "subwindowUp",
    labelKey: "shortcut.subwindowUp",
    group: "navigation",
    default: { key: "ArrowUp", ctrl: true, shift: true },
  },
  {
    action: "subwindowDown",
    labelKey: "shortcut.subwindowDown",
    group: "navigation",
    default: { key: "ArrowDown", ctrl: true, shift: true },
  },
  {
    action: "cycleTabs",
    labelKey: "shortcut.cycleTabs",
    group: "tabs",
    default: { key: "Tab", shift: true },
  },
  {
    action: "hideSubwindow",
    labelKey: "shortcut.hideSubwindow",
    group: "tabs",
    default: { key: "h", ctrl: true, shift: true },
  },
  {
    action: "toggleSubwindowFiles",
    labelKey: "shortcut.toggleSubwindowFiles",
    group: "tabs",
    default: { key: "f", shift: true },
  },
  {
    action: "closeSubwindow",
    labelKey: "shortcut.closeSubwindow",
    group: "tabs",
    default: { key: "w", ctrl: true, shift: true },
  },
  {
    action: "closeTab",
    labelKey: "shortcut.closeTab",
    group: "tabs",
    default: { key: "w", ctrl: true },
  },
  {
    action: "closeAllTabs",
    labelKey: "shortcut.closeAllTabs",
    group: "tabs",
    default: { key: "w", ctrl: true, shift: true, alt: true },
  },
  // The browser's chord for the same act. Agent tabs only: they are the ones
  // whose closing loses something a restart would have brought back.
  {
    action: "reopenClosedTab",
    labelKey: "shortcut.reopenClosedTab",
    group: "tabs",
    default: { key: "t", ctrl: true, shift: true },
    untested: "shortcut.reopenClosedTab",
  },
  // Keyboard steering mode (part 1 of the keyboard-only steering system). The
  // chord toggles the mode; the keys INSIDE it are the steering bindings (`steeringBindings.ts`).
  // Shift+Space: one hand, collides with no default above, and terminals send
  // it as a plain space anyway. It types text, so `useKeyboard` ignores it in
  // the middle of a typing burst (a Shift still held from a capital).
  {
    action: "steeringMode",
    labelKey: "shortcut.steeringMode",
    group: "steering",
    default: { key: " ", shift: true },
    untested: "shortcut.steeringMode",
  },
  // Backward twin of cycleProject. Alt (not Ctrl) distinguishes it from
  // prevTab's Ctrl+Shift+← default.
  {
    action: "cycleProjectBack",
    labelKey: "shortcut.cycleProjectBack",
    group: "navigation",
    default: { key: "ArrowLeft", alt: true, shift: true },
    untested: "shortcut.cycleProjectBack",
  },
  // The boxes' twin of the project cycle: walk the box pills in the leading
  // segment (their row order) and open the next / previous box. Ctrl+Shift+
  // PageUp/Down is what tabbed terminals use to MOVE a tab, which an xterm.js
  // terminal in Tabtivity has no use for, and it is no editor chord either.
  {
    action: "cycleBox",
    labelKey: "shortcut.cycleBox",
    group: "navigation",
    default: { key: "PageDown", ctrl: true, shift: true },
    untested: "shortcut.cycleBox",
  },
  {
    action: "cycleBoxBack",
    labelKey: "shortcut.cycleBoxBack",
    group: "navigation",
    default: { key: "PageUp", ctrl: true, shift: true },
    untested: "shortcut.cycleBoxBack",
  },
  {
    action: "shortcutHelp",
    labelKey: "shortcut.shortcutHelp",
    group: "steering",
    default: { key: "F1" },
    untested: "shortcut.shortcutHelp",
  },
  // The root console (`layout/RootOverlay`): the cross-project management
  // overlay that replaced switching to the root scope. Handled in the same
  // capture-phase listener as the steering chord, for the same reason — it has
  // to work FROM a focused terminal, which is where the hands are. Ctrl+Shift+R
  // is no terminal chord (readline's reverse search is plain Ctrl+R) and the
  // handler's preventDefault keeps WebKit's hard-reload off it.
  {
    action: "rootConsole",
    labelKey: "shortcut.rootConsole",
    group: "navigation",
    default: { key: "r", ctrl: true, shift: true },
    untested: "shortcut.rootConsole",
  },
  // The root console again, with a shell at the active project's root
  // (`openProjectShellInRootConsole`). Same capture-phase handler, same
  // reason. Ctrl+Shift+S is no terminal chord; the editors' Ctrl+S save
  // matches it too, and loses it here (plain Ctrl+S still saves).
  {
    action: "projectShell",
    labelKey: "shortcut.projectShell",
    group: "navigation",
    default: { key: "s", ctrl: true, shift: true },
    untested: "shortcut.projectShell",
  },
  // New tabs in the focused pane of the main window, taken focus and all
  // (`lib/shortcuts/newTabChord`): the + menu's Shell and System Monitor rows,
  // and its agents by number. Same capture-phase handler as the two above, so
  // they work from a focused terminal. Ctrl+Shift+N and +M are no terminal or
  // editor chord here; Ctrl+1–9 shadows only the legacy control codes some
  // terminals put on Ctrl+2–8, and is matched by physical key (`chordMatches`)
  // so it works on layouts whose digit row types symbols. While a mail /
  // calendar / to-do overlay is in front, Ctrl+1–9 dock that slot's root agent
  // in the overlay rather than open a tab hidden under it
  // (`requestOverlayAgent`).
  {
    action: "newShellTab",
    labelKey: "shortcut.newShellTab",
    group: "newTab",
    default: { key: "n", ctrl: true, shift: true },
    untested: "shortcut.newTabChords",
  },
  {
    action: "newMonitorTab",
    labelKey: "shortcut.newMonitorTab",
    group: "newTab",
    default: { key: "m", ctrl: true, shift: true },
    untested: "shortcut.newTabChords",
  },
  ...AGENT_TAB_ACTIONS.map((action, i): ShortcutDef => ({
    action,
    labelKey: `shortcut.${action}`,
    group: "newTab",
    default: { key: String(i + 1), ctrl: true },
    untested: "shortcut.newTabChords",
  })),
  // The window and view keys. These used to be fixed; they are matched before
  // `useKeyboard`'s editable-target guard, so they work from a focused
  // terminal too. The panel toggle's default depends on the desktop (a getter:
  // the desktop is a backend answer that arrives after module load, see
  // `livePanelToggleKey`). The zoom defaults match layout-tolerantly
  // (`zoomFor`) until the user rebinds them.
  {
    action: "osFullscreen",
    labelKey: "fixedKeys.osFullscreen.label",
    group: "view",
    default: { key: "F11" },
    untested: "fixedKeys.osFullscreen.label",
  },
  {
    action: "togglePanels",
    labelKey: "fixedKeys.panels.label",
    group: "view",
    get default(): ChordDescriptor {
      return { key: livePanelToggleKey() };
    },
    loneSuper: true,
  },
  {
    action: "exitFullscreen",
    labelKey: "fixedKeys.exitFullscreen.label",
    group: "view",
    default: { key: "Escape" },
  },
  {
    action: "zoomIn",
    labelKey: "shortcut.zoomIn",
    group: "view",
    default: { key: "+", ctrl: true },
  },
  {
    action: "zoomOut",
    labelKey: "shortcut.zoomOut",
    group: "view",
    default: { key: "-", ctrl: true },
  },
  {
    action: "zoomReset",
    labelKey: "shortcut.zoomReset",
    group: "view",
    default: { key: "0", ctrl: true },
  },
  // A terminal's own keys (`TerminalView`): copy the selection, paste, and
  // keyboard select. Not `useKeyboard`'s — only a focused terminal answers
  // them. At their defaults they match by physical key (`terminalChordFor`),
  // as they always did, so a non-Latin layout still reaches them.
  {
    action: "terminalCopy",
    labelKey: "shortcut.terminalCopy",
    group: "terminal",
    context: "terminal",
    default: { key: "c", ctrl: true, shift: true },
  },
  {
    action: "terminalPaste",
    labelKey: "shortcut.terminalPaste",
    group: "terminal",
    context: "terminal",
    default: { key: "v", ctrl: true, shift: true },
  },
  {
    action: "terminalKeySelect",
    labelKey: "shortcut.terminalKeySelect",
    group: "terminal",
    context: "terminal",
    default: { key: "x", ctrl: true, shift: true },
  },
  // The text editor's own keys (`FileViewerPane`), answered only while it has
  // focus. Redo also answers Ctrl+Shift+Z while at its default
  // (`actionChords`).
  ...(
    [
      ["editorFind", { key: "f", ctrl: true }],
      ["editorReplace", { key: "r", ctrl: true }],
      ["editorAutocomplete", { key: " ", ctrl: true }],
      ["editorUndo", { key: "z", ctrl: true }],
      ["editorRedo", { key: "y", ctrl: true }],
      ["editorSave", { key: "s", ctrl: true }],
      ["editorComment", { key: "c", ctrl: true, shift: true }],
    ] as const
  ).map(
    ([action, chord]): ShortcutDef => ({
      action,
      labelKey: `shortcut.${action}`,
      group: "editor",
      context: "editor",
      default: chord,
    }),
  ),
  // The TeX workspace's two navigation steps (#tex-structure-up). Unlike every
  // chord above these are NOT handled by `useKeyboard`: they only mean anything
  // inside a workspace tab, so the workspace itself listens — on its own root
  // element, which is what scopes them to "the TeX viewer has focus" and lets
  // them work from the editor's textarea, where the global hook's editable-
  // target guard would drop them. Alt+Shift+Arrow collides with no default
  // here (Ctrl+Shift+Arrow is now subwindowUp/subwindowDown's), and the
  // workspace consumes the chord (preventDefault) so the textarea's own
  // paragraph-selection never runs.
  {
    action: "texUp",
    labelKey: "shortcut.texUp",
    group: "tex",
    context: "editor",
    default: { key: "ArrowUp", alt: true, shift: true },
    untested: "shortcut.texUp",
  },
  {
    action: "texBack",
    labelKey: "shortcut.texBack",
    group: "tex",
    context: "editor",
    default: { key: "ArrowDown", alt: true, shift: true },
    untested: "shortcut.texBack",
  },
  // The build itself. Listened for the same way as the two navigation steps
  // above — on the TeX pane's own root, not in `useKeyboard` — because a
  // compile is asked for from inside the editor's textarea, exactly where the
  // global hook's editable-target guard drops a chord. Ctrl+Shift+B is VS
  // Code's "run build task" and collides with nothing else in this table.
  {
    action: "texCompile",
    labelKey: "shortcut.texCompile",
    group: "tex",
    context: "editor",
    default: { key: "b", ctrl: true, shift: true },
    untested: "shortcut.texCompile",
  },
];

/** Lone modifier keys that must be ignored while capturing a chord. */
const MODIFIER_KEYS = new Set([
  "Control",
  "Shift",
  "Alt",
  "Meta",
  "Super",
  "OS",
  "AltGraph",
  "CapsLock",
]);

/** Normalize a `KeyboardEvent.key` for storage/comparison: single printable
 *  letters become lower-case so "W" and "w" match; everything else is kept. */
export function normalizeKey(key: string): string {
  return key.length === 1 ? key.toLowerCase() : key;
}

/** True when the keystroke is only a modifier (Ctrl/Shift/Alt/Meta) — these
 *  must not be captured as a chord on their own. */
export function isLoneModifier(key: string): boolean {
  return MODIFIER_KEYS.has(key);
}

/**
 * Build a `ChordDescriptor` from a real `KeyboardEvent`. Returns `null` for a
 * lone-modifier keypress (caller should keep waiting for a real key). Used by
 * the settings panel's capture input.
 */
export function chordFromEvent(e: KeyboardEvent): ChordDescriptor | null {
  if (isLoneModifier(e.key)) return null;
  const chord: ChordDescriptor = { key: normalizeKey(e.key) };
  if (e.ctrlKey) chord.ctrl = true;
  if (e.shiftKey) chord.shift = true;
  if (e.altKey) chord.alt = true;
  if (e.metaKey) chord.meta = true;
  return chord;
}

/**
 * True when `e` matches `chord` (key normalized).
 *
 * Primary-modifier handling (macOS): the platform-primary modifier is Cmd
 * (metaKey) on macOS and Ctrl elsewhere. The default chord table encodes the
 * primary modifier as `ctrl` (its historical Linux/Windows shape). Rather than
 * fork the whole table, on macOS we treat a chord's primary-modifier
 * requirement — whether it was stored as `ctrl` (a default) or `meta` (a mac
 * user's captured rebind) — as satisfied by EITHER Cmd or Ctrl. So both Cmd+W
 * and Ctrl+W fire on a mac, while a plain key still rejects a stray Cmd press.
 * This collapses ⌘/⌃ into one "primary" on macOS (you can't bind a mac-only
 * Control-vs-Command distinction) — the deliberate, low-risk trade-off the task
 * calls for. Off macOS, modifiers are matched exactly as before.
 */
export function chordMatches(chord: ChordDescriptor, e: ChordKeyEvent): boolean {
  if (!chord.key || chord.key === LONE_SUPER.key) return false;
  if (normalizeKey(e.key) !== normalizeKey(chord.key) && !isDigitKeyOf(chord.key, e)) return false;
  if (e.shiftKey !== !!chord.shift) return false;
  if (e.altKey !== !!chord.alt) return false;
  if (IS_MAC) {
    const wantsPrimary = !!chord.ctrl || !!chord.meta;
    const hasPrimary = e.ctrlKey || e.metaKey;
    return wantsPrimary === hasPrimary;
  }
  return e.ctrlKey === !!chord.ctrl && e.metaKey === !!chord.meta;
}

/** A digit chord also matches by physical key: AZERTY types `&` on the key
 *  US calls `1`, and Shift turns every digit into a symbol, so `e.key` alone
 *  would make Ctrl+1 unreachable there. */
function isDigitKeyOf(key: string, e: ChordKeyEvent): boolean {
  return /^[0-9]$/.test(key) && (e.code === `Digit${key}` || e.code === `Numpad${key}`);
}

/** The fields a chord match reads — a DOM event or a React one both fit. */
export type ChordKeyEvent = Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">;

/** A chord the user switched off: its empty key matches nothing. Stored as a
 *  chord (not `null`) so the backend's typed map still reads it. */
export const UNBOUND: ChordDescriptor = { key: "" };

/** A lone tap of the Super key — no keydown ever matches it; `useKeyboard`
 *  fires it on the key's release when no other key joined the press. */
export const LONE_SUPER: ChordDescriptor = { key: "Super" };

export function isUnbound(chord: ChordDescriptor): boolean {
  return !chord.key;
}

export function isLoneSuper(chord: ChordDescriptor): boolean {
  return chord.key === LONE_SUPER.key && !chord.ctrl && !chord.shift && !chord.alt && !chord.meta;
}

/** Human-readable label for a chord, e.g. "Shift+Ctrl+Tab" — or native mac
 *  glyphs ("⇧⌘Tab") on macOS. On macOS the primary modifier (stored as `ctrl`)
 *  and `meta`/Super both render as ⌘ (deduped), matching what a mac user
 *  actually presses; off macOS the textual labels are unchanged. */
export function chordLabel(chord: ChordDescriptor): string {
  if (isUnbound(chord)) return "—";
  if (IS_MAC) {
    const parts: string[] = [];
    if (chord.alt) parts.push("⌥"); // Option
    if (chord.shift) parts.push("⇧"); // Shift
    if (chord.ctrl || chord.meta) parts.push("⌘"); // primary modifier / Super
    parts.push(prettyKey(chord.key));
    return parts.join(""); // mac convention concatenates the glyphs
  }
  const parts: string[] = [];
  if (chord.ctrl) parts.push("Ctrl");
  if (chord.shift) parts.push("Shift");
  if (chord.alt) parts.push("Alt");
  if (chord.meta) parts.push("Super");
  parts.push(prettyKey(chord.key));
  return parts.join("+");
}

function prettyKey(key: string): string {
  const map: Record<string, string> = {
    ArrowLeft: "←",
    ArrowRight: "→",
    ArrowUp: "↑",
    ArrowDown: "↓",
    " ": "Space",
  };
  if (map[key]) return map[key];
  return key.length === 1 ? key.toUpperCase() : key;
}

/** The stored shortcut map (action id → chord). Partial: any unset action
 *  falls back to its default. Mirrors `Settings["keyboard_shortcuts"]`. */
export type ShortcutMap = Partial<Record<ShortcutAction, ChordDescriptor>>;

/**
 * Resolve the effective chord for an action: the user override if present,
 * otherwise the built-in default. Central so `useKeyboard` and the panel agree.
 */
export function resolveChord(
  action: ShortcutAction,
  overrides: ShortcutMap | undefined | null,
): ChordDescriptor {
  const custom = overrides?.[action];
  if (custom) return custom;
  return SHORTCUT_DEFS.find((d) => d.action === action)!.default;
}

/**
 * Every chord an action answers to: its resolved chord, plus the aliases a
 * default has always carried — F9 beside the panel toggle's lone-Super default
 * (F9 works on every desktop, the lone Super only on some), Ctrl+Shift+Z
 * beside redo's Ctrl+Y. A rebind replaces the lot.
 */
export function actionChords(
  action: ShortcutAction,
  overrides: ShortcutMap | undefined | null,
): ChordDescriptor[] {
  const chord = resolveChord(action, overrides);
  if (overrides?.[action]) return [chord];
  if (action === "togglePanels" && isLoneSuper(chord)) return [chord, { key: "F9" }];
  if (action === "editorRedo") return [chord, { key: "z", ctrl: true, shift: true }];
  return [chord];
}

/** Whether a keydown triggers `action` — `chordMatches` over `actionChords`. */
export function actionMatches(
  action: ShortcutAction,
  overrides: ShortcutMap | undefined | null,
  e: ChordKeyEvent,
): boolean {
  return actionChords(action, overrides).some((c) => chordMatches(c, e));
}

/** True when two chords are the same effective keystroke: key normalized via
 *  `normalizeKey`, modifier booleans coerced with `!!` so an absent flag
 *  equals an explicit `false`. */
export function chordsEqual(a: ChordDescriptor, b: ChordDescriptor): boolean {
  return (
    normalizeKey(a.key) === normalizeKey(b.key) &&
    !!a.ctrl === !!b.ctrl &&
    !!a.shift === !!b.shift &&
    !!a.alt === !!b.alt &&
    !!a.meta === !!b.meta
  );
}

/**
 * Which actions collide: every action whose *effective* chord (override or
 * default, via `resolveChord`) equals another action's, mapped to the actions
 * sharing its chord. Both sides of a collision get an entry so the settings
 * panel can warn on each row; an action with a unique chord is absent. Pure so
 * the panel stays thin and so a unit test can guard the pristine default table
 * (no two defaults may ever collide).
 */
export function findConflicts(
  overrides: ShortcutMap | undefined | null,
): Map<ShortcutAction, ShortcutAction[]> {
  const out = new Map<ShortcutAction, ShortcutAction[]>();
  for (let i = 0; i < SHORTCUT_DEFS.length; i++) {
    for (let j = i + 1; j < SHORTCUT_DEFS.length; j++) {
      const a = SHORTCUT_DEFS[i].action;
      const b = SHORTCUT_DEFS[j].action;
      // A terminal key and an editor key never meet: one focus or the other.
      const ca = SHORTCUT_DEFS[i].context;
      const cb = SHORTCUT_DEFS[j].context;
      if (ca && cb && ca !== cb) continue;
      const bChords = actionChords(b, overrides);
      const clash = actionChords(a, overrides).some(
        (c) => !isUnbound(c) && bChords.some((d) => chordsEqual(c, d)),
      );
      if (!clash) continue;
      out.set(a, [...(out.get(a) ?? []), b]);
      out.set(b, [...(out.get(b) ?? []), a]);
    }
  }
  return out;
}

const TERMINAL_ACTIONS: [ShortcutAction, string][] = [
  ["terminalCopy", "KeyC"],
  ["terminalPaste", "KeyV"],
  ["terminalKeySelect", "KeyX"],
];

/** Which terminal key a keydown is, if any (see the `terminal` group). A
 *  default matches Ctrl+Shift on the physical key; a rebind as any chord. */
export function terminalChordFor(
  e: ChordKeyEvent,
  overrides: ShortcutMap | undefined | null,
): "terminalCopy" | "terminalPaste" | "terminalKeySelect" | null {
  for (const [action, code] of TERMINAL_ACTIONS) {
    const custom = overrides?.[action];
    const hit = custom ? chordMatches(custom, e) : e.ctrlKey && e.shiftKey && e.code === code;
    if (hit) return action as "terminalCopy" | "terminalPaste" | "terminalKeySelect";
  }
  return null;
}

const ZOOM_ACTIONS: [ShortcutAction, ZoomChord][] = [
  ["zoomIn", "in"],
  ["zoomOut", "out"],
  ["zoomReset", "reset"],
];

/**
 * Which zoom step a keydown asks for, if any — the window zoom, an agent
 * pane's font and the editor's text size all read it. A default zoom chord
 * matches the way it always did (`zoomChord`: typed key first, US position as
 * fallback, so German `+`/`-` work); a rebound one matches as any chord does.
 */
export function zoomFor(e: ChordKeyEvent, overrides: ShortcutMap | undefined | null): ZoomChord | null {
  for (const [action, kind] of ZOOM_ACTIONS) {
    const custom = overrides?.[action];
    if (custom ? chordMatches(custom, e) : zoomChord(e) === kind) return kind;
  }
  return null;
}

/** The levels of steering mode (`stores/keyboardSteering`'s `SteeringLevel`,
 *  restated so this table stays free of store imports). */
export type SteeringContext = "projects" | "panes" | "tabs" | "scroll" | "region";

export const STEERING_CONTEXTS: { id: SteeringContext; labelKey: TranslationKey }[] = [
  { id: "projects", labelKey: "steering.level.projects" },
  { id: "panes", labelKey: "steering.level.panes" },
  { id: "tabs", labelKey: "steering.level.tabs" },
  { id: "scroll", labelKey: "steering.level.scrollAny" },
  { id: "region", labelKey: "steering.level.region" },
];

/**
 * When a key is listed beyond its levels:
 *   stepsPanes — the panes level with two or more subwindows (←/→ walk them)
 *   stepsTabs  — the tabs level, or the panes level with one subwindow, where
 *                ←/→ step its tabs instead
 *   sideRegion — the region cursor is in the side panel (←/→ switch its view,
 *                and its opening key leaves it as Back does)
 *   settingsRegion — the region cursor is in the settings dialog (←/→ step
 *                its pages)
 *   headerRegion — the region cursor is on the top bar (←/→ walk it, ↓ drops
 *                a button's menu)
 *   overlayRegion — the region cursor is in a dialog or menu on top (←/→
 *                along a row)
 *   walkRegion — a region whose ↑/↓ walk the cursor (all but the top bar)
 *   tabCard    — a card floats over the active tab's terminal (Undo clear, a
 *                sign-in link, an update notice)
 *   mail / calendar / todo — that header app is switched on
 *   agentClear / agentPlan / agentGoal — the active tab is an agent that takes
 *                /clear, /plan, /goal (`steeringAgent.steeringAgentOffer`)
 *   agentPrompt — the active tab is an agent (the prompt box sends to it)
 *   intoTerminal — where ←/→ step tabs, and the active tab is a terminal
 *                ↓ can scroll (the scroll level)
 *   intoDocument — the same for a tab whose document scrolls
 *   inTerminal / inDocument — the scroll level is in a terminal / a document
 *   popouts    — the active scope has a subwindow popped out into its own
 *                window (J raises it)
 */
export type SteeringCondition =
  | "stepsPanes"
  | "stepsTabs"
  | "sideRegion"
  | "settingsRegion"
  | "headerRegion"
  | "overlayRegion"
  | "walkRegion"
  | "tabCard"
  | "mail"
  | "calendar"
  | "todo"
  | "agentClear"
  | "agentPlan"
  | "agentGoal"
  | "agentPrompt"
  | "intoTerminal"
  | "intoDocument"
  | "inTerminal"
  | "inDocument"
  | "popouts";

/** One row of the steering legend / cheat sheet: the steering actions it
 *  explains (their keys render through `steeringRowLabel`, so a rebind shows
 *  everywhere), plus the short legend label and the longer description. */
export interface SteeringKeyDef {
  /** The actions whose keys the row shows. */
  actions: readonly SteeringAction[];
  /** A direction pair (←/→, ↑/↓): shown column-wise, "S F / ← →". */
  pair?: true;
  /** The row is the nine number slots (`steeringSlotKeys`, "1–9"). */
  slots?: true;
  labelKey: TranslationKey;
  descKey: TranslationKey;
  /** The levels whose legend lists the key. */
  levels: readonly SteeringContext[];
  when?: SteeringCondition;
  /** The legend shows the key family as one "1–N CLIs" entry, N being the
   *  agents the focused pane's 1–9 open (`newTabSlotLabels`). */
  agentSlots?: true;
  /** A status jump: the legend lists it, with its count, only while some tab
   *  is in that state (`lib/shortcuts/statusJump`). */
  status?: "decision" | "working" | "done";
  /** The legend box the row sits in (`STEERING_GROUPS`). */
  group: SteeringGroup;
}

/** What a steering key is for — the legend's boxes. */
export type SteeringGroup = "move" | "new" | "act" | "agent" | "status" | "open" | "mode";

/**
 * The legend's boxes, in display order. Each wears one of the code viewer's
 * syntax-token classes (`.tok-*`, `styles/viewers.css`), so every theme colours
 * the groups with its own editor palette and no theme needs legend rules.
 */
export const STEERING_GROUPS: { id: SteeringGroup; labelKey: TranslationKey; tok: string }[] = [
  { id: "move", labelKey: "steering.group.move", tok: "tok-func" },
  { id: "new", labelKey: "steering.group.new", tok: "tok-string" },
  { id: "act", labelKey: "steering.group.act", tok: "tok-type" },
  { id: "agent", labelKey: "steering.group.agent", tok: "tok-keyword" },
  { id: "status", labelKey: "steering.group.status", tok: "tok-num" },
  { id: "open", labelKey: "steering.group.open", tok: "tok-tag" },
  { id: "mode", labelKey: "steering.group.mode", tok: "tok-comment" },
];

/** What the legend knows about the moment, for `steeringKeysFor`. */
export interface SteeringLegendState {
  level: SteeringContext;
  sideRegion: boolean;
  /** The region cursor is in the settings dialog. */
  settingsRegion?: boolean;
  /** The region cursor is on the top bar. */
  headerRegion?: boolean;
  /** The region cursor is in the dialog or menu on top. */
  overlayRegion?: boolean;
  /** A card floats over the active tab's terminal. */
  tabCard?: boolean;
  multiPane: boolean;
  apps: { mail: boolean; calendar: boolean; todo: boolean };
  /** The active tab is a live terminal (↓ scrolls it). */
  terminal?: boolean;
  /** The active tab shows a document that scrolls (↓ scrolls it). */
  document?: boolean;
  /** The active scope has popped-out subwindows. */
  popouts?: boolean;
  /** The agent keys the active tab takes; unset = none. */
  agent?: { clear: boolean; plan: boolean; goal: boolean; prompt: boolean };
  /** How many tabs, in every scope, need an answer / work / finished unseen. */
  statusCounts: { decision: number; working: number; done: number };
}

function steeringConditionHolds(cond: SteeringCondition, s: SteeringLegendState): boolean {
  switch (cond) {
    case "stepsPanes":
      return s.level === "panes" && s.multiPane;
    case "stepsTabs":
      return s.level === "tabs" || (s.level === "panes" && !s.multiPane);
    case "sideRegion":
      return s.sideRegion;
    case "settingsRegion":
      return !!s.settingsRegion;
    case "headerRegion":
      return !!s.headerRegion;
    case "overlayRegion":
      return !!s.overlayRegion;
    case "walkRegion":
      return !s.headerRegion;
    case "tabCard":
      return !!s.tabCard;
    case "agentClear":
      return !!s.agent?.clear;
    case "agentPlan":
      return !!s.agent?.plan;
    case "agentGoal":
      return !!s.agent?.goal;
    case "agentPrompt":
      return !!s.agent?.prompt;
    case "intoTerminal":
      return !!s.terminal && steeringConditionHolds("stepsTabs", s);
    case "intoDocument":
      return !s.terminal && !!s.document && steeringConditionHolds("stepsTabs", s);
    case "inTerminal":
      return !!s.terminal;
    case "inDocument":
      return !s.terminal;
    case "popouts":
      return !!s.popouts;
    default:
      return s.apps[cond];
  }
}

/** The keys that act right now — the legend's rows, in table order. */
export function steeringKeysFor(s: SteeringLegendState): SteeringKeyDef[] {
  return STEERING_KEYS.filter(
    (k) =>
      k.levels.includes(s.level) &&
      (!k.when || steeringConditionHolds(k.when, s)) &&
      (!k.status || s.statusCounts[k.status] > 0),
  );
}

/** The key text of a steering row, from the user's steering bindings. */
export function steeringRowLabel(row: SteeringKeyDef, overrides: SteeringKeyMap | null | undefined): string {
  return row.slots
    ? steeringSlotKeys(overrides)
    : steeringRowKeys(row.actions, overrides, !!row.pair);
}

/**
 * The panel toggle's default key on THIS desktop right now: the bare Super key
 * where the desktop leaves it to the focused window (a Linux desktop that does
 * not answer it itself), F9 everywhere else — macOS uses Cmd as the chord
 * modifier, Windows gives the Win key to the OS, GNOME and KDE take it for
 * their overview/launcher. Read live because the desktop is a backend answer
 * (see lib/shortcuts/superKey.ts); the key the user actually has, override
 * included, is `livePanelToggleLabel` in `shortcutHint.ts`.
 */
export function livePanelToggleKey(): string {
  return PLATFORM === "linux" && !desktopOwnsSuperKey() ? LONE_SUPER.key : "F9";
}

const PANE_LEVELS: readonly SteeringContext[] = ["panes", "tabs"];
const BASE_LEVELS: readonly SteeringContext[] = ["projects", "panes", "tabs"];
const ALL_LEVELS: readonly SteeringContext[] = ["projects", "panes", "tabs", "scroll", "region"];

/**
 * The in-steering-mode rows, grouped by the level they act on, in display
 * order — the one source of truth for the legend overlay (which shows the
 * current level's, `steeringKeysFor`), the shortcut cheat sheet, and any lesson
 * surface. The keys themselves are the user's steering bindings
 * (`steeringBindings.ts`), which `useKeyboard`'s steering handler resolves too. Digit mapping on the project level: 1 = root scope, 2 =
 * the first project pill (display order) — the same ring `cycleProject` walks.
 * Letters mean one thing per level, so N is a new project up top and a new
 * shell inside a pane.
 */
export const STEERING_KEYS: SteeringKeyDef[] = [
  // Projects.
  { actions: ["left", "right"], pair: true, labelKey: "steering.project.label", descKey: "steering.project.desc", levels: ["projects"], group: "move" },
  { actions: [], slots: true, labelKey: "steering.jump.label", descKey: "steering.jump.desc", levels: ["projects"], group: "move" },
  { actions: ["down"], labelKey: "steering.into.label", descKey: "steering.into.desc", levels: ["projects"], group: "move" },
  { actions: ["up"], labelKey: "steering.header.label", descKey: "steering.header.desc", levels: ["projects"], group: "move" },
  { actions: ["newProject"], labelKey: "steering.newProject.label", descKey: "steering.newProject.desc", levels: ["projects"], group: "new" },
  // Subwindows and their tabs.
  { actions: ["left", "right"], pair: true, labelKey: "steering.focus.label", descKey: "steering.focus.desc", levels: ["panes"], when: "stepsPanes", group: "move" },
  { actions: ["left", "right"], pair: true, labelKey: "steering.tabs.label", descKey: "steering.tabs.desc", levels: PANE_LEVELS, when: "stepsTabs", group: "move" },
  { actions: ["down"], labelKey: "steering.intoTabs.label", descKey: "steering.intoTabs.desc", levels: ["panes"], when: "stepsPanes", group: "move" },
  { actions: ["down"], labelKey: "steering.intoTerminal.label", descKey: "steering.intoTerminal.desc", levels: PANE_LEVELS, when: "intoTerminal", group: "move" },
  { actions: ["down"], labelKey: "steering.intoDocument.label", descKey: "steering.intoDocument.desc", levels: PANE_LEVELS, when: "intoDocument", group: "move" },
  { actions: ["up"], labelKey: "steering.up.label", descKey: "steering.up.desc", levels: PANE_LEVELS, group: "move" },
  { actions: ["newShell"], labelKey: "steering.newShell.label", descKey: "steering.newShell.desc", levels: PANE_LEVELS, group: "new" },
  { actions: ["newMonitor"], labelKey: "steering.newMonitor.label", descKey: "steering.newMonitor.desc", levels: PANE_LEVELS, group: "new" },
  { actions: [], slots: true, labelKey: "steering.newAgent.label", descKey: "steering.newAgent.desc", levels: PANE_LEVELS, agentSlots: true, group: "new" },
  { actions: ["newTabMenu"], labelKey: "steering.newTabMenu.label", descKey: "steering.newTabMenu.desc", levels: PANE_LEVELS, group: "new" },
  { actions: ["files"], labelKey: "steering.files.label", descKey: "steering.files.desc", levels: PANE_LEVELS, group: "act" },
  { actions: ["closeTab"], labelKey: "steering.closeTab.label", descKey: "steering.closeTab.desc", levels: PANE_LEVELS, group: "act" },
  { actions: ["tabCard"], labelKey: "steering.tabCard.label", descKey: "steering.tabCard.desc", levels: PANE_LEVELS, when: "tabCard", group: "act" },
  { actions: ["agentClear"], labelKey: "steering.agentClear.label", descKey: "steering.agentClear.desc", levels: PANE_LEVELS, when: "agentClear", group: "agent" },
  { actions: ["agentPlan"], labelKey: "steering.agentPlan.label", descKey: "steering.agentPlan.desc", levels: PANE_LEVELS, when: "agentPlan", group: "agent" },
  { actions: ["agentGoal"], labelKey: "steering.agentGoal.label", descKey: "steering.agentGoal.desc", levels: PANE_LEVELS, when: "agentGoal", group: "agent" },
  { actions: ["agentPrompt"], labelKey: "steering.agentPrompt.label", descKey: "steering.agentPrompt.desc", levels: [...PANE_LEVELS, "scroll"], when: "agentPrompt", group: "agent" },
  { actions: ["exit", "work"], labelKey: "steering.work.label", descKey: "steering.work.desc", levels: [...PANE_LEVELS, "scroll"], group: "mode" },
  // Inside a terminal or a document (its tab's ↓): Shift scrolls a whole screen.
  { actions: ["left", "right"], pair: true, labelKey: "steering.scroll.label", descKey: "steering.scroll.desc", levels: ["scroll"], when: "inTerminal", group: "move" },
  { actions: ["down"], labelKey: "steering.scrollLive.label", descKey: "steering.scrollLive.desc", levels: ["scroll"], when: "inTerminal", group: "move" },
  { actions: ["up"], labelKey: "steering.scrollOut.label", descKey: "steering.scrollOut.desc", levels: ["scroll"], when: "inTerminal", group: "move" },
  { actions: ["left", "right"], pair: true, labelKey: "steering.scrollDocument.label", descKey: "steering.scrollDocument.desc", levels: ["scroll"], when: "inDocument", group: "move" },
  { actions: ["down"], labelKey: "steering.scrollEnd.label", descKey: "steering.scrollEnd.desc", levels: ["scroll"], when: "inDocument", group: "move" },
  { actions: ["up"], labelKey: "steering.scrollOutDocument.label", descKey: "steering.scrollOutDocument.desc", levels: ["scroll"], when: "inDocument", group: "move" },
  // The region cursor (side panel, header apps, + menu, settings, the top bar,
  // any dialog or menu on top).
  { actions: ["up", "down"], pair: true, labelKey: "steering.move.label", descKey: "steering.move.desc", levels: ["region"], when: "walkRegion", group: "move" },
  { actions: ["left", "right"], pair: true, labelKey: "steering.move.label", descKey: "steering.headerWalk.desc", levels: ["region"], when: "headerRegion", group: "move" },
  { actions: ["down"], labelKey: "steering.headerOpen.label", descKey: "steering.headerOpen.desc", levels: ["region"], when: "headerRegion", group: "act" },
  { actions: ["left", "right"], pair: true, labelKey: "steering.overlayRow.label", descKey: "steering.overlayRow.desc", levels: ["region"], when: "overlayRegion", group: "move" },
  { actions: ["left", "right"], pair: true, labelKey: "steering.sideView.label", descKey: "steering.sideView.desc", levels: ["region"], when: "sideRegion", group: "move" },
  { actions: ["left", "right"], pair: true, labelKey: "steering.settingsPage.label", descKey: "steering.settingsPage.desc", levels: ["region"], when: "settingsRegion", group: "move" },
  { actions: ["press"], labelKey: "steering.press.label", descKey: "steering.press.desc", levels: ["region"], group: "act" },
  { actions: ["search"], labelKey: "steering.search.label", descKey: "steering.search.desc", levels: ["region"], group: "act" },
  { actions: ["menu"], labelKey: "steering.menu.label", descKey: "steering.menu.desc", levels: [...BASE_LEVELS, "region"], group: "act" },
  // Wherever the tab bars are. Shift walks the status jumps backwards.
  { actions: ["mail"], labelKey: "steering.mail.label", descKey: "steering.mail.desc", levels: BASE_LEVELS, when: "mail", group: "open" },
  { actions: ["calendar"], labelKey: "steering.calendar.label", descKey: "steering.calendar.desc", levels: BASE_LEVELS, when: "calendar", group: "open" },
  { actions: ["todo"], labelKey: "steering.todo.label", descKey: "steering.todo.desc", levels: BASE_LEVELS, when: "todo", group: "open" },
  { actions: ["nextDecision"], labelKey: "steering.nextDecision.label", descKey: "steering.nextDecision.desc", levels: BASE_LEVELS, status: "decision", group: "status" },
  { actions: ["nextWorking"], labelKey: "steering.nextWorking.label", descKey: "steering.nextWorking.desc", levels: BASE_LEVELS, status: "working", group: "status" },
  { actions: ["nextDone"], labelKey: "steering.nextDone.label", descKey: "steering.nextDone.desc", levels: BASE_LEVELS, status: "done", group: "status" },
  { actions: ["sidePanel"], labelKey: "steering.sidePanel.label", descKey: "steering.sidePanel.desc", levels: BASE_LEVELS, group: "open" },
  { actions: ["panels"], labelKey: "steering.panels.label", descKey: "steering.panels.desc", levels: BASE_LEVELS, group: "open" },
  { actions: ["settings"], labelKey: "steering.settings.label", descKey: "steering.settings.desc", levels: BASE_LEVELS, group: "open" },
  { actions: ["jumpProject"], labelKey: "steering.jumpProject.label", descKey: "steering.jumpProject.desc", levels: BASE_LEVELS, group: "move" },
  { actions: ["popout"], labelKey: "steering.popout.label", descKey: "steering.popout.desc", levels: BASE_LEVELS, when: "popouts", group: "move" },
  { actions: ["help"], labelKey: "steering.help.label", descKey: "steering.help.desc", levels: ALL_LEVELS, group: "mode" },
  { actions: ["legend"], labelKey: "steering.legend.label", descKey: "steering.legend.desc", levels: ALL_LEVELS, group: "mode" },
  { actions: ["back"], labelKey: "steering.back.label", descKey: "steering.back.desc", levels: ["region"], group: "mode" },
  { actions: ["sidePanel"], labelKey: "steering.sidePanelBack.label", descKey: "steering.sidePanelBack.desc", levels: ["region"], when: "sideRegion", group: "mode" },
  { actions: ["exit"], labelKey: "steering.exit.label", descKey: "steering.exit.desc", levels: ["region"], group: "mode" },
  { actions: ["exit", "work"], labelKey: "steering.exit.label", descKey: "steering.exit.desc", levels: ["projects"], group: "mode" },
];
