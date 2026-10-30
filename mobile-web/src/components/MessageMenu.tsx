import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useT } from "../../../src/lib/i18n";
import { isUntested } from "../../../src/lib/untested";
import { speechTag } from "../speechLang";
import { currentSpeechId, readMessage, speechOutputSupported, stopSpeaking, subscribeSpeech } from "../speechOutput";
import { useBackLayer } from "../backStack";

/** How long a finger rests before a press is a hold (the new-tab button's,
 * a chat link's). Long enough that a flick of the chat is never a press,
 * short enough to feel like the platform's own hold. */
export const HOLD_MS = 450;
/** A press that wanders this far is a scroll or a selection, not a tap. */
const TAP_SLOP = 12;
/** What inside a bubble answers a tap itself (a link, an inbox picture, a
 * resend button): a tap there is its, not the message menu's. */
const OWN_TAP = "a, button, input, textarea, select, label, [role=button], [role=link], .md-link";

/** The first words of a message, for the sheet's note: which bubble is being
 * acted on, since the sheet covers the chat it came from. */
function preview(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 90 ? `${line.slice(0, 89)}…` : line;
}

/** Some text is selected on the page — a tap that only clears it, or ends
 * a drag that made it, is no ask for the menu. */
function hasSelection(): boolean {
  const selection = window.getSelection();
  return !!selection && !selection.isCollapsed && selection.toString() !== "";
}

/**
 * What can be done with one chat message: copy it or have the phone read it
 * aloud. A prompt and an answer offer the same — the reader's own words are
 * read back as readily as the agent's.
 *
 * It is a sheet rather than buttons beside the bubble: the chat is the whole
 * screen on a phone, and two controls per message crowd it. The bubble holds
 * what was said and nothing else; a tap on it asks what to do with it, and a
 * hold is the phone's own text selection, right in the bubble.
 */
function MessageMenu({ id, text, onEdit, onClose }: { id: string; text: string; onEdit?: () => void; onClose: () => void }) {
  useBackLayer(onClose);
  const t = useT();
  const speaking = useSyncExternalStore(subscribeSpeech, currentSpeechId) === id;
  const [note, setNote] = useState<{ text: string; error?: boolean } | null>(null);
  // A copy says so and then gets out of the way; a failed one stays to be read.
  useEffect(() => {
    if (!note || note.error) return;
    const timer = window.setTimeout(onClose, 900);
    return () => window.clearTimeout(timer);
  }, [note, onClose]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setNote({ text: t("mobile.focus.copied") });
    } catch {
      setNote({ text: t("mobile.focus.copyFailed"), error: true });
    }
  };
  // Reading keeps the sheet open: the row that started the voice is the one
  // that stops it, and the backdrop dismisses it in a tap. An answer of the
  // open session is read on that tab's reading cursor, so the spoken moves
  // go on from it (`speechOutput.ts` `readMessage`).
  const read = () => {
    if (speaking) stopSpeaking();
    else readMessage(id, text, speechTag());
  };
  const title = t("mobile.focus.messageMenu");
  return <div className="sheet-backdrop" role="presentation" onClick={onClose}>
    <section className="option-sheet" role="dialog" aria-modal="true" aria-label={title} onClick={(event) => event.stopPropagation()}>
      <span className="sheet-grip" aria-hidden="true" />
      <header>
        <button className="sheet-close" onClick={onClose} aria-label={t("mobile.focus.messageMenuClose")}>✕</button>
        <h2>{title} {(isUntested("mobile.focus.messageMenu") || isUntested("mobile.focus.tapSelect")) && <small>{t("mobile.focus.untested")}</small>}</h2>
        <span className="sheet-close" aria-hidden="true" />
      </header>
      <p className={note?.error ? "sheet-note error" : "sheet-note"} role={note ? "status" : undefined}>{note ? note.text : preview(text)}</p>
      <ul className="option-list">
        {/* Only a prompt the agent has not taken in yet has one: its words
            wait on the desktop and can still change. */}
        {onEdit && <li>
          <button onClick={() => { onClose(); onEdit(); }}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16v4ZM13 7l4 4" /></svg>
            <span><strong>{t("mobile.focus.editPrompt")}</strong><small>{t("mobile.focus.editPromptHint")}{isUntested("mobile.chat.editHeld") && <> · {t("mobile.focus.untested")}</>}</small></span>
          </button>
        </li>}
        <li>
          <button onClick={copy}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V6a2 2 0 0 1 2-2h8" /></svg>
            <span><strong>{t("mobile.focus.copyMessage")}</strong></span>
          </button>
        </li>
        {speechOutputSupported() && <li>
          <button className={speaking ? "current" : ""} onClick={read}>
            {speaking
              ? <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="1" /></svg>
              : <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 10v4h3l5 4V6l-5 4zM16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11" /></svg>}
            <span><strong>{t(speaking ? "mobile.speech.stop" : "mobile.speech.read")}</strong>{isUntested("mobile.speech.cursor") && <small>{t("mobile.focus.untested")}</small>}</span>
          </button>
        </li>}
      </ul>
    </section>
  </div>;
}

/** The handlers a bubble spreads to open its menu on a tap — and, on a
 * mouse, on a right-click. */
export interface TapHandlers {
  onPointerDown: (event: React.PointerEvent) => void;
  onClick: (event: React.MouseEvent) => void;
  onContextMenu: (event: React.MouseEvent) => void;
}

/**
 * The message menu for a chat: `tap(id, text)` on every bubble, `menu` once
 * beside them. The message is read at the moment of the tap and kept — a
 * shown bubble never changes, and neither does what the menu acts on. `edit`
 * is given for a prompt whose words can still change (a held prompt).
 *
 * A hold is left to the phone: it selects the words under the finger, with
 * the system's own handles and copy bar, so the bubble's text is picked in
 * place. A finger that wanders is scrolling or dragging a selection, and a
 * tap that only clears a selection is just that — neither opens the menu.
 */
export function useMessageMenu(): { tap: (id: string, text: () => string, edit?: () => void) => TapHandlers; menu: React.ReactNode } {
  const [target, setTarget] = useState<{ id: string; text: string; edit?: () => void } | null>(null);
  const down = useRef<{ x: number; y: number; mouse: boolean; selected: boolean } | null>(null);
  const close = useCallback(() => setTarget(null), []);
  const tap = useCallback((id: string, text: () => string, edit?: () => void): TapHandlers => ({
    onPointerDown: (event) => {
      down.current = { x: event.clientX, y: event.clientY, mouse: event.pointerType === "mouse", selected: hasSelection() };
    },
    onClick: (event) => {
      const start = down.current;
      down.current = null;
      if (start && (start.selected || Math.abs(event.clientX - start.x) > TAP_SLOP || Math.abs(event.clientY - start.y) > TAP_SLOP)) return;
      if (hasSelection()) return;
      const own = event.target instanceof Element ? event.target.closest(OWN_TAP) : null;
      if (own && event.currentTarget.contains(own)) return;
      setTarget({ id, text: text(), edit });
    },
    // A touch's long-press `contextmenu` is the phone starting its selection;
    // only a mouse's right-click asks for the menu.
    onContextMenu: (event) => {
      if (!down.current?.mouse) return;
      event.preventDefault();
      down.current = null;
      setTarget({ id, text: text(), edit });
    },
  }), []);
  return { tap, menu: target && <MessageMenu id={target.id} text={target.text} onEdit={target.edit} onClose={close} /> };
}
