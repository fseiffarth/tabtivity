/**
 * The phone's keyboard-steering keys, pure: the table by phone level, the
 * resolver, and the helpers that decide which keydowns the engine may look at
 * (the entry chords, the keys that belong to the OS or an IME, the first
 * hardware key). It imports only the desktop's steering table, `keyNames` and
 * i18n types, so no Tauri or store code reaches the phone bundle.
 *
 * A row either names desktop actions (`desktop`), whose keys come from
 * `steeringKeys(action, overrides)` and so follow the desktop's defaults and
 * the user's rebinding, or carries keys of its own (`keys`); a row may do both.
 * Where one action needs different keys or a different label on different
 * levels it has several rows, in resolution order; `phoneActionKeys` collects
 * them. Rules for the entry chords, `repeat` and Alt are in
 * `docs/mobile_steering_plan.md` ("Engine rules").
 */
import type { TranslationKey } from "../../../src/lib/i18n";
import { isLoneModifier, normalizeKey } from "../../../src/lib/shortcuts/keyNames";
import {
  STEERING_SLOT_ACTIONS,
  keyMatches,
  steeringKeyLabel,
  steeringKeys,
  steeringSlotKeys,
  type SteeringAction,
  type SteeringKeyMap,
} from "../../../src/lib/shortcuts/steeringBindings";

/** Phone levels: Home, a project, a tab, a section's screen, a sheet on top. */
export type PhoneLevel = "projects" | "tabs" | "inside" | "section" | "region";

export const PHONE_LEVELS: readonly PhoneLevel[] = ["projects", "tabs", "inside", "section", "region"];

export type PhoneSteeringAction =
  | "up"
  | "down"
  | "back"
  | "open"
  | "latest"
  | "legend"
  | "exit"
  | "jumpBack"
  | "nextDecision"
  | "nextWorking"
  | "nextDone"
  | "mail"
  | "calendar"
  | "todo"
  | "search"
  | "newProject"
  | "openRow"
  | "newTab"
  | "closeTab"
  | "menu"
  | "answer"
  | "type"
  | "confirm";

export interface PhoneBindingDef {
  action: PhoneSteeringAction;
  levels: readonly PhoneLevel[];
  /** The desktop action(s) whose keys this row takes. An array unions them; the nine slots give the digits. */
  desktop?: SteeringAction | readonly SteeringAction[];
  /** Keys of the phone's own, added to the desktop's. */
  keys?: readonly string[];
  labelKey: TranslationKey;
  group: "move" | "act" | "status" | "open" | "mode";
}

const ALL: readonly PhoneLevel[] = PHONE_LEVELS;
const LISTS: readonly PhoneLevel[] = ["projects", "tabs", "section"];
/** Every level a status jump, a section key or the jump back work on (not a sheet). */
const WALKING: readonly PhoneLevel[] = ["projects", "tabs", "inside", "section"];
const SLOTS: readonly SteeringAction[] = STEERING_SLOT_ACTIONS;

/**
 * The table, in resolution order: the first row live on the level whose keys
 * hold the pressed key wins. Defaults come from the desktop table at HEAD (E/D
 * move, S/F back/forward, Space exits); the phone adds Enter, Backspace and
 * Escape.
 */
export const PHONE_STEERING_BINDINGS: readonly PhoneBindingDef[] = [
  { action: "exit", levels: ALL, desktop: "exit", labelKey: "steering.exit.label", group: "mode" },
  // Escape leaves too, except over a sheet, where it is Back.
  { action: "exit", levels: WALKING, keys: ["Escape"], labelKey: "steering.exit.label", group: "mode" },
  { action: "legend", levels: WALKING, desktop: "legend", labelKey: "mobile.steering.key.legend", group: "mode" },
  { action: "up", levels: ["projects", "tabs", "section", "region"], desktop: "up", labelKey: "mobile.steering.key.move", group: "move" },
  { action: "up", levels: ["inside"], desktop: "up", labelKey: "mobile.steering.key.scroll", group: "move" },
  { action: "down", levels: ["projects", "tabs", "section", "region"], desktop: "down", labelKey: "mobile.steering.key.move", group: "move" },
  { action: "down", levels: ["inside"], desktop: "down", labelKey: "mobile.steering.key.scroll", group: "move" },
  { action: "back", levels: ALL, desktop: "left", labelKey: "mobile.steering.key.back", group: "move" },
  // Over a sheet the desktop's Back key (Escape) closes it as well.
  { action: "back", levels: ["region"], desktop: "back", labelKey: "mobile.steering.key.back", group: "move" },
  { action: "open", levels: [...LISTS, "region"], desktop: "right", keys: ["Enter"], labelKey: "mobile.steering.key.open", group: "move" },
  { action: "latest", levels: ["inside"], desktop: "right", labelKey: "mobile.steering.key.latest", group: "act" },
  { action: "confirm", levels: ["region"], desktop: "confirm", labelKey: "mobile.steering.key.confirm", group: "act" },
  { action: "jumpBack", levels: WALKING, keys: ["Backspace"], labelKey: "mobile.steering.key.jumpBack", group: "status" },
  { action: "nextDecision", levels: WALKING, desktop: "nextDecision", labelKey: "steering.nextDecision.label", group: "status" },
  { action: "nextWorking", levels: WALKING, desktop: "nextWorking", labelKey: "steering.nextWorking.label", group: "status" },
  { action: "nextDone", levels: WALKING, desktop: "nextDone", labelKey: "steering.nextDone.label", group: "status" },
  { action: "mail", levels: WALKING, desktop: "mail", labelKey: "steering.mail.label", group: "open" },
  { action: "calendar", levels: WALKING, desktop: "calendar", labelKey: "steering.calendar.label", group: "open" },
  { action: "todo", levels: WALKING, desktop: "todo", labelKey: "steering.todo.label", group: "open" },
  { action: "search", levels: WALKING, desktop: "jumpProject", labelKey: "mobile.steering.key.search", group: "open" },
  { action: "newProject", levels: ["projects"], desktop: "newProject", labelKey: "steering.newProject.label", group: "act" },
  { action: "openRow", levels: ["projects"], desktop: SLOTS, labelKey: "mobile.steering.key.open", group: "open" },
  { action: "newTab", levels: ["tabs"], desktop: ["newShell", "newTabMenu"], labelKey: "mobile.steering.key.new", group: "act" },
  { action: "closeTab", levels: ["tabs"], desktop: "closeTab", labelKey: "mobile.steering.key.close", group: "act" },
  { action: "menu", levels: ["tabs"], desktop: "menu", labelKey: "steering.menu.label", group: "act" },
  { action: "answer", levels: ["inside"], desktop: SLOTS, labelKey: "mobile.steering.key.answer", group: "act" },
  { action: "type", levels: ["inside"], desktop: "agentPrompt", labelKey: "mobile.steering.key.type", group: "act" },
];

/** The actions a held key may repeat: moving and scrolling. Everything else fires once per press. */
export function acceptsRepeat(action: PhoneSteeringAction): boolean {
  return action === "up" || action === "down";
}

/** The keys a row answers to: the desktop actions' keys (user list or default) then its own, each once. */
export function phoneKeys(def: PhoneBindingDef, overrides: SteeringKeyMap | null | undefined): readonly string[] {
  const actions = def.desktop === undefined ? [] : typeof def.desktop === "string" ? [def.desktop] : def.desktop;
  const out: string[] = [];
  for (const key of [...actions.flatMap((a) => steeringKeys(a, overrides)), ...(def.keys ?? [])]) {
    if (!out.some((k) => normalizeKey(k) === normalizeKey(key))) out.push(key);
  }
  return out;
}

/** The rows live on a level, in table order. */
export function phoneBindingsFor(level: PhoneLevel): PhoneBindingDef[] {
  return PHONE_STEERING_BINDINGS.filter((def) => def.levels.includes(level));
}

/** Every key an action answers to on a level, over all its rows there. */
export function phoneActionKeys(
  action: PhoneSteeringAction,
  level: PhoneLevel,
  overrides: SteeringKeyMap | null | undefined,
): readonly string[] {
  const out: string[] = [];
  for (const def of phoneBindingsFor(level)) {
    if (def.action !== action) continue;
    for (const key of phoneKeys(def, overrides)) if (!out.includes(key)) out.push(key);
  }
  return out;
}

/**
 * The action a keydown triggers on `level`, or null. Characters match first,
 * then a digit by its physical key (AZERTY types `&` on the key US calls 1), so
 * a letter bound to one row never loses to a digit another claims by position.
 * Modifiers are not looked at: the engine drops Ctrl, Meta and Alt first, and
 * Shift is read by the status jumps themselves.
 */
export function phoneSteeringActionFor(
  e: Pick<KeyboardEvent, "key" | "code">,
  level: PhoneLevel,
  overrides: SteeringKeyMap | null | undefined,
): PhoneSteeringAction | null {
  const rows = phoneBindingsFor(level);
  for (const def of rows) {
    if (phoneKeys(def, overrides).some((k) => normalizeKey(k) === normalizeKey(e.key))) return def.action;
  }
  for (const def of rows) {
    if (phoneKeys(def, overrides).some((k) => keyMatches(k, e))) return def.action;
  }
  return null;
}

/** The slot number (1-9) a keydown stands for, by character and then by physical key, else null. */
export function phoneDigit(e: Pick<KeyboardEvent, "key" | "code">, overrides: SteeringKeyMap | null | undefined): number | null {
  for (let i = 0; i < SLOTS.length; i++) {
    if (steeringKeys(SLOTS[i], overrides).some((k) => normalizeKey(k) === normalizeKey(e.key))) return i + 1;
  }
  for (let i = 0; i < SLOTS.length; i++) {
    if (steeringKeys(SLOTS[i], overrides).some((k) => keyMatches(k, e))) return i + 1;
  }
  return null;
}

/**
 * Which actions share a key with another action live on the same level (the
 * later row never fires for it). Rows of one action never conflict with each
 * other. Both sides get an entry.
 */
export function findPhoneSteeringConflicts(
  overrides: SteeringKeyMap | null | undefined,
): Map<PhoneSteeringAction, PhoneSteeringAction[]> {
  const out = new Map<PhoneSteeringAction, PhoneSteeringAction[]>();
  const add = (a: PhoneSteeringAction, b: PhoneSteeringAction) => {
    const list = out.get(a) ?? [];
    if (!list.includes(b)) out.set(a, [...list, b]);
  };
  for (const level of PHONE_LEVELS) {
    const rows = phoneBindingsFor(level);
    for (let i = 0; i < rows.length; i++) {
      for (let j = i + 1; j < rows.length; j++) {
        if (rows[i].action === rows[j].action) continue;
        const bKeys = phoneKeys(rows[j], overrides).map(normalizeKey);
        if (!phoneKeys(rows[i], overrides).some((k) => bKeys.includes(normalizeKey(k)))) continue;
        add(rows[i].action, rows[j].action);
        add(rows[j].action, rows[i].action);
      }
    }
  }
  return out;
}

/** The legend text for a row's keys ("E / ↑", "1–9"); never translated, "—" when unbound. */
export function phoneRowKeys(def: PhoneBindingDef, overrides: SteeringKeyMap | null | undefined = null): string {
  if (def.desktop === SLOTS) return steeringSlotKeys(overrides);
  return phoneKeys(def, overrides).map(steeringKeyLabel).join(" / ") || "—";
}

/* ---- keyboard events: what the engine may look at ---- */

/** The parts of a `KeyboardEvent` the helpers below read; every flag may be absent in a test event. */
export type PhoneKeyEvent = Pick<KeyboardEvent, "key" | "code"> &
  Partial<Pick<KeyboardEvent, "shiftKey" | "altKey" | "ctrlKey" | "metaKey" | "repeat" | "isComposing" | "keyCode">>;

/** Space by `code` or by character; macOS-layout keyboards type a no-break space under Alt, and some Android IMEs send an empty `code`. */
export function isSpace(e: Pick<KeyboardEvent, "key" | "code">): boolean {
  return e.code === "Space" || e.key === " " || e.key === " ";
}

const NON_TEXT_INPUTS = new Set(["button", "checkbox", "radio", "range", "file", "color", "image", "reset", "submit"]);

function editableElement(node: unknown): HTMLElement | null {
  if (!(node instanceof HTMLElement)) return null;
  const tag = node.tagName.toLowerCase();
  if (tag === "textarea" || tag === "select") return node;
  if (tag === "input") return NON_TEXT_INPUTS.has((node as HTMLInputElement).type) ? null : node;
  const editable = node.closest("[contenteditable]");
  if (editable instanceof HTMLElement && editable.getAttribute("contenteditable") !== "false") return editable;
  return null;
}

/** The text field a key would type into: the event's target if it is one, else the focused element. The target may be `window` or `document` (tests fire there). */
export function typingField(target: EventTarget | null): HTMLElement | null {
  return editableElement(target) ?? editableElement(typeof document === "undefined" ? null : document.activeElement);
}

/** Whether a text field has the caret, per `typingField`. */
export function isTypingTarget(target: EventTarget | null): boolean {
  return typingField(target) !== null;
}

function fieldIsEmpty(field: HTMLElement): boolean {
  if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) return field.value === "";
  if (field instanceof HTMLSelectElement) return true;
  return (field.textContent ?? "") === "";
}

const OS_KEYS = new Set(["Unidentified", "Process", "Dead"]);

/** An IME step or a dead key: it belongs to the keyboard layer, never to steering. */
function isImeKey(e: PhoneKeyEvent): boolean {
  return !!e.isComposing || e.keyCode === 229 || OS_KEYS.has(e.key);
}

/**
 * Events the engine never looks at: Ctrl and Meta combinations (the OS, the
 * browser, iOS Cmd), any Alt combination except the Alt+Space chord, IME steps,
 * dead keys and lone modifier presses.
 */
export function isIgnoredKey(e: PhoneKeyEvent): boolean {
  if (e.ctrlKey || e.metaKey || isImeKey(e) || isLoneModifier(e.key)) return true;
  return !!e.altKey && !(isSpace(e) && !e.shiftKey);
}

/**
 * Whether a keydown is one of the two chords that toggle the mode. Shift+Space
 * works unless a non-empty text field has the caret (a leading space is never
 * typing, a later one is); Alt+Space works anywhere. Neither accepts a held key.
 */
export function isEntryChord(e: PhoneKeyEvent, target: EventTarget | null): boolean {
  if (e.repeat || e.ctrlKey || e.metaKey || isImeKey(e) || !isSpace(e)) return false;
  if (e.altKey) return !e.shiftKey;
  if (!e.shiftKey) return false;
  const field = typingField(target);
  return field === null || fieldIsEmpty(field);
}

const HARDWARE_ONLY = /^(Arrow(Up|Down|Left|Right)|Escape|Tab|F([1-9]|1\d|2[0-4]))$/;

/**
 * Whether a keydown can only have come from a hardware keyboard, for the
 * one-time tip: its target is not a text field (no on-screen keyboard is up
 * without one), or it carries Alt, or it is a key soft keyboards never send.
 * IME steps and dead keys never count.
 */
export function isHardwareKeydown(e: PhoneKeyEvent, target: EventTarget | null): boolean {
  if (isImeKey(e)) return false;
  return !isTypingTarget(target) || !!e.altKey || HARDWARE_ONLY.test(e.key);
}
