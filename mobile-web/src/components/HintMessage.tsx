import { useRef, useState } from "react";
import { useT, type TranslationKey } from "../../../src/lib/i18n";
import { rollHint } from "../../../src/lib/hintChance";
import { isUntested } from "../../../src/lib/untested";
import { readFlag, readHintReads, writeFlag, writeHintReads, type MobileFlag } from "../prefs";

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

/** Each tip's draw for this load of the app (`rollHint` against its reads), so
 * a tip that lost it stays away until the next launch instead of being redrawn
 * by every screen it sits on. A tip read this launch is stored as lost. */
const draws = new Map<HintKey, boolean>();

/** Whether `hint` may show: tips are on, its old per-tip flag is not set, and
 * it won this launch's draw. */
function tipShows(hint: HintKey): boolean {
  if (readFlag("hintsOff") || readFlag(HINTS[hint].flag)) return false;
  let drawn = draws.get(hint);
  if (drawn === undefined) {
    drawn = rollHint(readHintReads()[hint] ?? 0);
    draws.set(hint, drawn);
  }
  return drawn;
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
  for (const { flag } of Object.values(HINTS)) writeFlag(flag, false);
  draws.clear();
}

/** × and Skip close for this visit; Read closes too and halves the tip's chance of
 * coming back; Turn off tips silences every tip on this phone until This
 * device → Tips turns them on again, which the card then says in place of the
 * tip. No timer: the reader gets time to read and dismiss the message. */
export function HintMessage({ hint, floating = false, vars, onClose }: { hint: HintKey; floating?: boolean; vars?: Record<string, string>; onClose?: () => void }) {
  const t = useT();
  const { text } = HINTS[hint];
  const [view, setView] = useState<"tip" | "off" | "hidden">(() => tipShows(hint) ? "tip" : "hidden");
  if (view === "hidden") return null;
  const close = () => { setView("hidden"); onClose?.(); };
  return <aside className={`hint-message${floating ? " hint-message-floating" : ""}`} aria-label={t("mobile.hints.title")}>
    <div className="hint-message-head">
      <strong>{t("mobile.hints.title")}{isUntested("mobile.hints") && <span className="untested">{t("mobile.newTab.untested")}</span>}</strong>
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
 * Several tips sharing one spot, one card at a time: the first in `hints` that
 * may show on this phone. Closing it — ×, Read or Turn off tips — ends the spot
 * for this visit; the next tip never takes its place. Whether a tip may show is
 * read once per mount, so a tap does not pull the card away under the finger.
 */
export function HintQueue({ hints, vars }: { hints: readonly HintKey[]; vars?: Partial<Record<HintKey, Record<string, string>>> }) {
  const [closed, setClosed] = useState(false);
  const shows = useRef(new Map<HintKey, boolean>());
  const mayShow = (hint: HintKey) => {
    let value = shows.current.get(hint);
    if (value === undefined) {
      value = tipShows(hint);
      shows.current.set(hint, value);
    }
    return value;
  };
  const shown = closed ? undefined : hints.find(mayShow);
  if (!shown) return null;
  return <HintMessage key={shown} hint={shown} vars={vars?.[shown]} onClose={() => setClosed(true)} />;
}
