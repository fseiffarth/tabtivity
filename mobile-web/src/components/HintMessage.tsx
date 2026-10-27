import { useRef, useState } from "react";
import { useT, type TranslationKey } from "../../../src/lib/i18n";
import { isUntested } from "../../../src/lib/untested";
import { readFlag, writeFlag, type MobileFlag } from "../prefs";

const HINTS = {
  agentHold: { flag: "hintAgentHold", text: "mobile.project.fabHoldHint" },
  agentDefault: { flag: "hintAgentDefault", text: "mobile.hints.agentDefault" },
  projectFiles: { flag: "hintProjectFiles", text: "mobile.hints.projectFiles" },
  chatTools: { flag: "hintChatTools", text: "mobile.hints.chatTools" },
  tabCard: { flag: "hintTabCard", text: "mobile.hints.tabCard" },
  sendHold: { flag: "hintSendHold", text: "mobile.hints.sendHold" },
  chatMenu: { flag: "hintChatMenu", text: "mobile.hints.chatMenu" },
  sentFiles: { flag: "hintSentFiles", text: "mobile.hints.sentFiles" },
  chatSwipe: { flag: "hintChatSwipe", text: "mobile.hints.chatSwipe" },
  markup: { flag: "hintMarkup", text: "mobile.hints.markup" },
  statusLine: { flag: "hintStatusLine", text: "mobile.hints.statusLine" },
  todoCards: { flag: "hintTodoCards", text: "mobile.hints.todoCards" },
  todoBoard: { flag: "hintTodoBoard", text: "mobile.hints.todoBoard" },
  mailMove: { flag: "hintMailMove", text: "mobile.hints.mailMove" },
  mailWrite: { flag: "hintMailWrite", text: "mobile.hints.mailWrite" },
  calendarViews: { flag: "hintCalendarViews", text: "mobile.hints.calendarViews" },
  calendarManage: { flag: "hintCalendarManage", text: "mobile.hints.calendarManage" },
} as const satisfies Record<string, { flag: MobileFlag; text: TranslationKey }>;

export type HintKey = keyof typeof HINTS;

/** Closing lasts for this visit; only the checkbox remembers it on this phone.
 * No timer: the reader gets time to read and dismiss the message. */
export function HintMessage({ hint, floating = false, vars, onClose }: { hint: HintKey; floating?: boolean; vars?: Record<string, string>; onClose?: () => void }) {
  const t = useT();
  const { flag, text } = HINTS[hint];
  const [hidden, setHidden] = useState(() => readFlag(flag));
  const [neverAgain, setNeverAgain] = useState(false);
  if (hidden) return null;
  return <aside className={`hint-message${floating ? " hint-message-floating" : ""}`} aria-label={t("mobile.hints.title")}>
    <div className="hint-message-head">
      <strong>{t("mobile.hints.title")}{isUntested("mobile.hints") && <span className="untested">{t("mobile.newTab.untested")}</span>}</strong>
      <button onClick={() => { setHidden(true); onClose?.(); }} aria-label={t("mobile.hints.close")}>×</button>
    </div>
    <p role={floating ? "status" : undefined}>{t(text, vars)}</p>
    <label><input type="checkbox" checked={neverAgain} onChange={(event) => {
      setNeverAgain(event.target.checked);
      writeFlag(flag, event.target.checked);
    }} />{t("mobile.hints.neverAgain")}</label>
  </aside>;
}

/**
 * Several tips sharing one spot, one card at a time: the first in `hints` this
 * phone has not turned off. Closing it with × ends the spot for this visit; the
 * next tip never takes its place. A tip's flag is read once per mount, so
 * ticking its checkbox does not pull the card away under the finger.
 */
export function HintQueue({ hints, vars }: { hints: readonly HintKey[]; vars?: Partial<Record<HintKey, Record<string, string>>> }) {
  const [closed, setClosed] = useState(false);
  const off = useRef(new Map<HintKey, boolean>());
  const turnedOff = (hint: HintKey) => {
    let value = off.current.get(hint);
    if (value === undefined) {
      value = readFlag(HINTS[hint].flag);
      off.current.set(hint, value);
    }
    return value;
  };
  const shown = closed ? undefined : hints.find((hint) => !turnedOff(hint));
  if (!shown) return null;
  return <HintMessage key={shown} hint={shown} vars={vars?.[shown]} onClose={() => setClosed(true)} />;
}
