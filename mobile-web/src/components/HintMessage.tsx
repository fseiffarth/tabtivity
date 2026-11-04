import { useEffect, useRef, useState, type RefObject } from "react";
import { useT, type TranslationKey } from "../../../src/lib/i18n";
import { rollHint } from "../../../src/lib/hintChance";
import { isUntested } from "../../../src/lib/untested";
import { readFlag, readHintReads, readHintShown, readTipShownAt, writeFlag, writeHintReads, writeHintShown, writeTipShownAt, type MobileFlag } from "../prefs";

/** Every phone tip: one short thing each. A tip split from a longer one keeps
 * that one's old per-tip flag, so a "never again" on it still holds. */
const HINTS = {
  agentHold: { flag: "hintAgentHold", text: "mobile.project.fabHoldHint" },
  agentDefault: { flag: "hintAgentDefault", text: "mobile.hints.agentDefault" },
  projectFiles: { flag: "hintProjectFiles", text: "mobile.hints.projectFiles" },
  composerAttach: { flag: "hintChatTools", text: "mobile.hints.composerAttach" },
  composerKeys: { flag: "hintChatTools", text: "mobile.hints.composerKeys" },
  composerPlanGoal: { flag: "hintChatTools", text: "mobile.hints.composerPlanGoal" },
  composerClear: { flag: "hintChatTools", text: "mobile.hints.composerClear" },
  composerCommit: { flag: "hintChatTools", text: "mobile.hints.composerCommit" },
  composerMic: { flag: "hintChatTools", text: "mobile.hints.composerMic" },
  tabCard: { flag: "hintTabCard", text: "mobile.hints.tabCard" },
  sendHold: { flag: "hintSendHold", text: "mobile.hints.sendHold" },
  chatMenu: { flag: "hintChatMenu", text: "mobile.hints.chatMenu" },
  sentFiles: { flag: "hintSentFiles", text: "mobile.hints.sentFiles" },
  chatSwipe: { flag: "hintChatSwipe", text: "mobile.hints.chatSwipe" },
  markup: { flag: "hintMarkup", text: "mobile.hints.markup" },
  statusLamp: { flag: "hintStatusLine", text: "mobile.hints.statusLamp" },
  statusModel: { flag: "hintStatusLine", text: "mobile.hints.statusModel" },
  statusMode: { flag: "hintStatusLine", text: "mobile.hints.statusMode" },
  statusWorktree: { flag: "hintStatusLine", text: "mobile.hints.statusWorktree" },
  todoDone: { flag: "hintTodoCards", text: "mobile.hints.todoDone" },
  todoEdit: { flag: "hintTodoCards", text: "mobile.hints.todoEdit" },
  todoMove: { flag: "hintTodoCards", text: "mobile.hints.todoMove" },
  todoFilter: { flag: "hintTodoBoard", text: "mobile.hints.todoFilter" },
  todoColumns: { flag: "hintTodoBoard", text: "mobile.hints.todoColumns" },
  todoAdd: { flag: "hintTodoBoard", text: "mobile.hints.todoAdd" },
  mailBack: { flag: "hintMailMove", text: "mobile.hints.mailBack" },
  mailPickers: { flag: "hintMailMove", text: "mobile.hints.mailPickers" },
  mailWrite: { flag: "hintMailWrite", text: "mobile.hints.mailWrite" },
  calendarViews: { flag: "hintCalendarViews", text: "mobile.hints.calendarViews" },
  calendarDays: { flag: "hintCalendarViews", text: "mobile.hints.calendarDays" },
  calendarEvents: { flag: "hintCalendarManage", text: "mobile.hints.calendarEvents" },
  calendarCalendars: { flag: "hintCalendarManage", text: "mobile.hints.calendarCalendars" },
  calendarReminders: { flag: "hintCalendarManage", text: "mobile.hints.calendarReminders" },
} as const satisfies Record<string, { flag: MobileFlag; text: TranslationKey }>;

export type HintKey = keyof typeof HINTS;

/** Select controls locally so a background screen cannot receive the pointer. */
const TARGETS: Partial<Record<HintKey, string>> = {
  agentHold: ".fab", agentDefault: ".new-tab-default", projectFiles: ".drawer-open",
  composerAttach: ".composer-add", composerKeys: ".composer-keys",
  composerPlanGoal: ".composer-segment", composerClear: ".composer-tool",
  composerCommit: ".composer-commit", composerMic: ".composer-dictate",
  tabCard: ".tab-card-more", sentFiles: ".terminal-gallery", markup: ".terminal-gallery",
  mailBack: ".back", mailPickers: ".mail-mobile-switch", mailWrite: ".mail-mobile-reply textarea",
  sendHold: ".send-icon", chatMenu: ".view-pill", chatSwipe: ".transcript-screen",
  statusLamp: ".fact-action:has(.fact-lamp)",
  statusModel: '[data-phone-hint="model"]', statusMode: '[data-phone-hint="mode"]',
  statusWorktree: ".fact-worktree, .fact-branch",
  todoDone: ".todo-check", todoEdit: ".todo-mobile-actions > button",
  todoMove: ".todo-mobile-actions > select", todoFilter: ".todo-mobile-filters",
  todoColumns: ".todo-column-fold", todoAdd: ".todo-fab",
  calendarViews: '.mobile-calendar-actions[role="group"]', calendarDays: ".mobile-calendar-day",
  calendarEvents: ".mobile-calendar-actions > button:first-child",
  calendarCalendars: ".mobile-calendar-actions > button:nth-child(2)",
  calendarReminders: ".mobile-calendar-actions > button:nth-child(3)",
};

type Pointer = { x: number; y: number; width: number; height: number; fromX: number; fromY: number; toX: number; toY: number };

/** Track layout changes without a painting loop. Decorations never intercept taps. */
function HintPointer({ card, hint }: { card: RefObject<HTMLElement | null>; hint: HintKey }) {
  const [pointer, setPointer] = useState<Pointer | null>(null);
  useEffect(() => {
    const root = card.current?.closest(".screen, .sheet") ?? card.current?.parentElement;
    const selector = TARGETS[hint];
    if (!root || !selector) return;
    const update = () => {
      if (document.hidden) { setPointer(null); return; }
      const a = card.current?.getBoundingClientRect();
      const target = [...root.querySelectorAll<HTMLElement>(selector)].find((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth && el.checkVisibility?.() !== false;
      });
      const b = target?.getBoundingClientRect();
      if (!a || !b || a.bottom <= 0 || a.top >= innerHeight || root.querySelector('[role="dialog"], .focus-menu-backdrop, .sheet-backdrop')) { setPointer(null); return; }
      const below = b.top >= a.bottom;
      const above = b.bottom <= a.top;
      if (!below && !above) { setPointer(null); return; }
      const x = Math.max(a.left + 12, Math.min(b.left + b.width / 2, a.right - 12));
      setPointer({ x: b.left - 3, y: b.top - 3, width: b.width + 6, height: b.height + 6,
        fromX: x, fromY: below ? a.bottom : a.top,
        toX: b.left + b.width / 2, toY: below ? b.top - 3 : b.bottom + 3 });
    };
    update();
    const observer = new MutationObserver(update);
    observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "hidden", "style"] });
    const resize = new ResizeObserver(update);
    resize.observe(root);
    if (card.current) resize.observe(card.current);
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    window.visualViewport?.addEventListener("resize", update);
    document.addEventListener("visibilitychange", update);
    return () => {
      observer.disconnect(); resize.disconnect();
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
      window.visualViewport?.removeEventListener("resize", update);
      document.removeEventListener("visibilitychange", update);
    };
  }, [card, hint]);
  if (!pointer) return null;
  return <svg className="phone-hint-pointer" aria-hidden="true">
    <path d={`M ${pointer.fromX} ${pointer.fromY} L ${pointer.toX} ${pointer.toY}`} />
    <circle cx={pointer.toX} cy={pointer.toY} r="3" />
    <rect className="phone-hint-ring" x={pointer.x} y={pointer.y} width={pointer.width} height={pointer.height} rx="8" />
  </svg>;
}

/** Each tip's draw for this load of the app (`rollHint` against its reads), so
 * a tip that lost it stays away until the next launch instead of being redrawn
 * by every screen it sits on. A tip read this launch is stored as lost. */
const draws = new Map<HintKey, boolean>();

/** Repeat tips wait half an hour. Unseen tips remain discoverable when a
 * different screen has already used the cooldown. */
const TIP_GAP_MS = 30 * 60_000;

/** The latest open tip may return to its screen during the repeat cooldown. */
let holder: HintKey | undefined;

/** Whether `hint` may show: tips are on, its old per-tip flag is not set, the
 * tip is unseen, the half hour is over, or it holds the slot; and it won
 * this launch's draw. A stored time ahead of the clock counts as over. */
function tipShows(hint: HintKey): boolean {
  if (readFlag("hintsOff") || readFlag(HINTS[hint].flag)) return false;
  const since = Date.now() - readTipShownAt();
  if (readHintShown()[hint] !== undefined && hint !== holder && since >= 0 && since < TIP_GAP_MS) return false;
  let drawn = draws.get(hint);
  if (drawn === undefined) {
    drawn = rollHint(readHintReads()[hint] ?? 0);
    draws.set(hint, drawn);
  }
  return drawn;
}

/** `hint` comes up: it takes the half hour, unless it already holds it, and
 * goes to the back of its spot's turns (`HintQueue`). */
function claimTip(hint: HintKey): void {
  if (hint === holder) return;
  holder = hint;
  const now = Date.now();
  writeTipShownAt(now);
  writeHintShown({ ...readHintShown(), [hint]: now });
}

/** The tip is closed (×, Skip, Read or Turn off tips): it stops holding the half
 * hour, so it does not come back before the next one either. */
function releaseTip(hint: HintKey): void {
  if (hint === holder) holder = undefined;
}

/** The Read button: one more read halves the tip's chance of coming back. */
function readTip(hint: HintKey): void {
  const reads = readHintReads();
  writeHintReads({ ...reads, [hint]: (reads[hint] ?? 0) + 1 });
  draws.set(hint, false);
}

/** This device → Tips → Reset tips: every tip back at full chance, the old
 * per-tip "never again" flags and Turn off tips included. */
export function resetTips(): void {
  writeFlag("hintsOff", false);
  writeHintReads(undefined);
  writeHintShown(undefined);
  writeTipShownAt(undefined);
  for (const { flag } of Object.values(HINTS)) writeFlag(flag, false);
  draws.clear();
  holder = undefined;
}

/** × and Skip close for this visit; Read closes too and halves the tip's chance of
 * coming back; Turn off tips silences every tip on this phone until This
 * device → Tips turns them on again, which the card then says in place of the
 * tip. No timer: the reader gets time to read and dismiss the message. Showing
 * a tip starts the repeat cooldown; unseen tips on other screens can still show. */
export function HintMessage({ hint, floating = false, vars, onClose }: { hint: HintKey; floating?: boolean; vars?: Record<string, string>; onClose?: () => void }) {
  const t = useT();
  const card = useRef<HTMLElement>(null);
  const { text } = HINTS[hint];
  const [view, setView] = useState<"tip" | "off" | "hidden">(() => {
    if (!tipShows(hint)) return "hidden";
    claimTip(hint);
    return "tip";
  });
  if (view === "hidden") return null;
  const close = () => { releaseTip(hint); setView("hidden"); onClose?.(); };
  return <aside ref={card} className={`hint-message${floating ? " hint-message-floating" : ""}`} aria-label={t("mobile.hints.title")}>
    {view === "tip" && <HintPointer card={card} hint={hint} />}
    <div className="hint-message-head">
      <strong>{t("mobile.hints.title")}{(isUntested("mobile.hints") || isUntested("mobile.hints.pace") || isUntested("mobile.hints.pointer")) && <span className="untested">{t("mobile.newTab.untested")}</span>}</strong>
      <button onClick={close} aria-label={t("mobile.hints.close")}>×</button>
    </div>
    {view === "off"
      ? <p role={floating ? "status" : undefined}>{t("mobile.hints.offNote")}</p>
      : <>
        <p role={floating ? "status" : undefined}>{t(text, vars)}</p>
        <div className="hint-message-actions">
          {isUntested("mobile.hints.read") && <span className="untested">{t("mobile.newTab.untested")}</span>}
          <button onClick={() => { writeFlag("hintsOff", true); setView("off"); }}>{t("mobile.hints.turnOff")}</button>
          <button onClick={close}>{t("mobile.hints.skip")}</button>
          <button onClick={() => { readTip(hint); close(); }}>{t("mobile.hints.read")}</button>
        </div>
      </>}
  </aside>;
}

/**
 * Several tips sharing one spot, one card at a time: of those that may show on
 * this phone, the one that came up longest ago, never-shown tips first and in
 * `hints` order. A tip that was only closed therefore gives way to the next, and
 * the first in the list is not the only one ever seen. Closing it — ×, Read or
 * Turn off tips — ends the spot for this visit; the next tip never takes its
 * place. Both the order and whether a tip may show are read once per mount, so
 * a tap, or the turn the card itself just took, does not pull it away under the
 * finger.
 */
export function HintQueue({ hints, vars }: { hints: readonly HintKey[]; vars?: Partial<Record<HintKey, Record<string, string>>> }) {
  const [closed, setClosed] = useState(false);
  const [shownAt] = useState(() => readHintShown());
  const shows = useRef(new Map<HintKey, boolean>());
  const mayShow = (hint: HintKey) => {
    let value = shows.current.get(hint);
    if (value === undefined) {
      value = tipShows(hint);
      shows.current.set(hint, value);
    }
    return value;
  };
  const oldestFirst = [...hints].sort((a, b) => (shownAt[a] ?? 0) - (shownAt[b] ?? 0));
  const shown = closed ? undefined : oldestFirst.find(mayShow);
  if (!shown) return null;
  return <HintMessage key={shown} hint={shown} vars={vars?.[shown]} onClose={() => setClosed(true)} />;
}
