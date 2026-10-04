// Small view preferences the phone keeps for itself: a filter the reader set is
// theirs, not the desktop's, so these never cross the bridge. The desktop board
// has its own `hideDone` in `stores/todo` and deliberately does not persist it
// there — a filter that survives a relaunch is how a card goes missing. On the
// phone the same toggle sits above a one-column list that is re-mounted by every
// tab switch, so "hide done" was being asked for again a dozen times a session.

import { storageKey } from "../../src/lib/brand";

const PREFIX = storageKey("mobile.");

type FlagStorage = Pick<Storage, "getItem" | "setItem">;

/** `projectsAgents` is the Projects section's mode rather than a filter: with it
 * set, that tab opens on the flat cross-project list of agent tabs that are
 * working, waiting or done. It is stored for the same reason as the others —
 * the section is re-mounted by every tab switch and by every trip into a
 * terminal, and re-picking the mode on each return is the whole cost of using
 * it as a triage list. `focusReadAloud` is the Reader speaking each new answer:
 * whoever listens to one session while their hands are busy listens to the
 * next one too. `voiceRemote` sends dictation to the phone's speech service
 * even where the browser could recognize on the device: often the better ear,
 * at the price of the audio leaving the phone — so it is a choice, off unset.
 * `markupAutoReload` loads a PDF the agent changed under the marks as soon as
 * it finishes (`MarkupView`), read with an on fallback. `markupSubagents`
 * has each Submit handed to a new subagent of the tab's agent
 * (`markupForSubagent`), off unset. `markupDirect` is **Apply marks
 * directly** (`markupInstruction.ts`), read with an on fallback. */
export type MobileFlag = "todoHideDone" | "todoHideArchived" | "projectsAgents" | "focusReadAloud" | "voiceRemote" | "markupAutoReload" | "markupSubagents" | "markupDirect";

/**
 * `fallback` is what an unset flag means, and it is a real parameter rather than
 * a hardcoded `false` because "hide archived" ships **on**: an archive is where
 * cards are put to stop looking at them, so the phone that has never been told
 * otherwise should not open on a column of them. Only the two stored strings
 * answer the question — anything else (a cleared store, a hand-edited value)
 * falls back, so an on-by-default flag can never be turned off by accident.
 */
export function readFlag(name: MobileFlag, fallback = false, storage?: FlagStorage): boolean {
  try {
    const stored = (storage ?? localStorage).getItem(`${PREFIX}${name}`);
    return stored === "1" ? true : stored === "0" ? false : fallback;
  } catch {
    // Storage can be unavailable in a private browser; the flag keeps its
    // default for the session.
    return fallback;
  }
}

export function writeFlag(name: MobileFlag, value: boolean, storage?: FlagStorage): void {
  try {
    (storage ?? localStorage).setItem(`${PREFIX}${name}`, value ? "1" : "0");
  } catch {
    // See readFlag.
  }
}

/** A choice among named options, kept the way the flags are. `speechLang` is
 * the language the phone speaks and listens in (`speechLang.ts`), which is a
 * property of this phone and its owner rather than of the session — so it
 * stays here and never crosses the bridge. `agentsSort` is
 * the Agents list's order (`shared/agentSort.ts`); the desktop remembers its
 * own copy of the same choice, since a phone and a laptop are not necessarily
 * looking at the list for the same reason. `projectTabsSort` is the same choice
 * for one project screen's tab list, kept apart from it because the two lists
 * are read for different things: the cross-project Agents list is triage, while
 * a project's own tabs are a place the reader arranges by hand. `mailAccount`
 * is the mail account the Mail tab opens on: an id the desktop handed out,
 * checked against the accounts it lists before it is used. `theme` is the
 * phone's own theme (`theme.ts`), and `desktopTheme` the desktop's as last
 * reported, so a cold open that follows it paints right before the bridge
 * answers. `markupInstruction` is free text rather than a choice — what a
 * Mark up Submit tells the agent (`markupInstruction.ts`) — kept here all the
 * same, since it is just as much this phone's own; `markupAsk` is its
 * asking dial, a digit 0–4. `markupOpen` is the mode
 * a markable PDF opens in (`markupOpen.ts`). */
export type MobileChoice = "agentsSort" | "projectTabsSort" | "speechLang" | "mailAccount" | "theme" | "desktopTheme" | "markupInstruction" | "markupApply" | "markupAsk" | "markupOpen";

export function readChoice<T extends string>(name: MobileChoice, accept: (value: unknown) => value is T, fallback: T, storage?: FlagStorage): T {
  try {
    const stored = (storage ?? localStorage).getItem(`${PREFIX}${name}`);
    return accept(stored) ? stored : fallback;
  } catch {
    return fallback;
  }
}

export function writeChoice(name: MobileChoice, value: string, storage?: FlagStorage): void {
  try {
    (storage ?? localStorage).setItem(`${PREFIX}${name}`, value);
  } catch {
    // See readFlag.
  }
}

/** An ordered list of ids, kept the way the flags are. `projectOrder` is the
 * home list's hand-arranged project order (`projectOrder.ts`): ids in the order
 * the reader dragged them into, which is this phone's own and never the
 * desktop's. It can name projects the list is not showing right now — see
 * `mergeProjectOrder`. */
export type MobileOrder = "projectOrder";

/** `todoCollapsedColumns` is a set rather than an order — the ids of the to-do
 * board's columns the reader has folded shut — and it rides on the same storage
 * because it is the same shape: a short list of ids this phone keeps to itself,
 * of which only membership is ever read back. */
export type MobileIdList = MobileOrder | "todoCollapsedColumns";

/** How many ids one order keeps. A phone that has been used for a year should
 * not carry a list of every project it ever saw, and the ids that matter are
 * the ones near the front: a drag rewrites the block it touched and the tail is
 * what has not been looked at in longest. */
const ORDER_CAP = 200;

/** The stored order, or an empty list — which means "nothing has been placed",
 * and leaves every row in the order the host sent. Anything that is not an
 * array of strings (a hand-edited value, a half-written entry) is read as that
 * same empty list rather than being trusted into the sort. */
export function readOrder(name: MobileIdList, storage?: FlagStorage): string[] {
  try {
    const stored = (storage ?? localStorage).getItem(`${PREFIX}${name}`);
    if (!stored) return [];
    const parsed: unknown = JSON.parse(stored);
    return Array.isArray(parsed) && parsed.every((id): id is string => typeof id === "string") ? parsed : [];
  } catch {
    return [];
  }
}

export function writeOrder(name: MobileIdList, ids: readonly string[], storage?: FlagStorage): void {
  try {
    (storage ?? localStorage).setItem(`${PREFIX}${name}`, JSON.stringify(ids.slice(0, ORDER_CAP)));
  } catch {
    // See readFlag.
  }
}

/** Which output view a terminal opens in: whatever the reader last chose for
 * that *agent* — keyed by the
 * agent behind the tab ("Claude Code", "Codex"; shells share one key), since
 * whether Focus reads a session well is a property of the TUI, not of the
 * tab: a reader who moved their Claude tab to Focus wants the next Claude tab
 * there too, and a shell they keep on Terminal stays there. `null` until they
 * choose: the screen then picks — Focus on an agent tab whose stored session
 * reads, Terminal otherwise. */
export type TerminalViewChoice = "focus" | "terminal";

function viewKey(agent: string): string {
  return `${PREFIX}view.${agent.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-") || "agent"}`;
}

export function readTerminalView(agent: string, storage?: FlagStorage): TerminalViewChoice | null {
  try {
    const stored = (storage ?? localStorage).getItem(viewKey(agent));
    return stored === "focus" || stored === "terminal" ? stored : null;
  } catch {
    return null;
  }
}

export function writeTerminalView(agent: string, view: TerminalViewChoice, storage?: FlagStorage): void {
  try {
    (storage ?? localStorage).setItem(viewKey(agent), view);
  } catch {
    // See readFlag.
  }
}
