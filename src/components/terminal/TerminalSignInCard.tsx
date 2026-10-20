import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useT } from "../../lib/i18n";
import type { SignInRequest } from "../../lib/terminal/terminalUrls";
import { UntestedTag } from "../common/UntestedTag";

/**
 * The card a terminal pane shows while the program in it waits for the user to
 * sign in (`findSignInRequest`): open the link in the real browser, copy it,
 * and — for a flow that ends on a "paste the code" prompt — hand the code back
 * without ever touching the terminal. Written for someone who has never used a
 * CLI: the link an agent prints is cut across rows and cannot be clicked or
 * copied whole by hand.
 *
 * Portaled into the pane's own container (positioned, and owned by xterm), so
 * it sits over the terminal it belongs to and leaves the pane's layout alone.
 * The container's capture-phase mouse handlers skip events from inside it
 * ({@link SIGN_IN_CARD_CLASS}): a double-click here must not paste into the
 * agent.
 */
export const SIGN_IN_CARD_CLASS = "terminal-sign-in";

export function TerminalSignInCard({
  host,
  request,
  onOpen,
  onCopy,
  onSendCode,
  onDismiss,
}: {
  host: HTMLElement;
  request: SignInRequest;
  onOpen: () => void;
  onCopy: () => void;
  onSendCode: (code: string) => void;
  onDismiss: () => void;
}) {
  const t = useT();
  const [code, setCode] = useState("");
  const send = () => {
    const trimmed = code.trim();
    if (trimmed) onSendCode(trimmed);
  };
  return createPortal(
    <div
      className={`hint-bubble ${SIGN_IN_CARD_CLASS}`}
      role="dialog"
      aria-label={t("terminal.signIn.title")}
    >
      <button
        type="button"
        className="hint-bubble-close"
        aria-label={t("terminal.signIn.dismiss")}
        title={t("terminal.signIn.dismiss")}
        onClick={onDismiss}
      >
        ×
      </button>
      <div className="hint-bubble-title">
        {t("terminal.signIn.title")} <UntestedTag id="terminal.signIn.title" />
      </div>
      <div className="hint-bubble-body">
        {t(request.wantsCode ? "terminal.signIn.bodyCode" : "terminal.signIn.body")}
      </div>
      <div className="hint-bubble-actions">
        <button type="button" className="hint-bubble-got-it terminal-sign-in-open" onClick={onOpen}>
          {t("terminal.signIn.open")}
        </button>
        <button type="button" className="hint-bubble-link" onClick={onCopy}>
          {t("terminal.signIn.copy")}
        </button>
      </div>
      {request.wantsCode && (
        <form
          className="terminal-sign-in-code"
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
        >
          <input
            type="text"
            value={code}
            aria-label={t("terminal.signIn.codeLabel")}
            placeholder={t("terminal.signIn.codePlaceholder")}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setCode(e.target.value)}
          />
          <button type="submit" className="hint-bubble-got-it" disabled={!code.trim()}>
            {t("terminal.signIn.send")}
          </button>
        </form>
      )}
    </div>,
    host,
  );
}

/** How long the "signed in" card stays when the program needs nothing more. */
const SIGN_IN_DONE_MS = 8000;

/**
 * The card that follows {@link TerminalSignInCard} once the program says the
 * sign-in went through (`findSignInDone`) — in the Reader the terminal's own
 * "Login successful" is hidden. A program that then waits for Enter gets a
 * Continue that sends it; one that does not lets the card go by itself.
 */
export function TerminalSignInDoneCard({
  host,
  pressEnter,
  onContinue,
  onDismiss,
}: {
  host: HTMLElement;
  pressEnter: boolean;
  onContinue: () => void;
  onDismiss: () => void;
}) {
  const t = useT();
  useEffect(() => {
    if (pressEnter) return;
    const timer = setTimeout(onDismiss, SIGN_IN_DONE_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one timer per card
  }, [pressEnter]);
  return createPortal(
    <div className={`hint-bubble ${SIGN_IN_CARD_CLASS}`} role="status">
      <button
        type="button"
        className="hint-bubble-close"
        aria-label={t("terminal.signIn.dismiss")}
        title={t("terminal.signIn.dismiss")}
        onClick={onDismiss}
      >
        ×
      </button>
      <div className="hint-bubble-title">
        {t("terminal.signIn.doneTitle")} <UntestedTag id="terminal.signIn.done" />
      </div>
      <div className="hint-bubble-body">
        {t(pressEnter ? "terminal.signIn.doneBodyEnter" : "terminal.signIn.doneBody")}
      </div>
      <div className="hint-bubble-actions">
        <button type="button" className="hint-bubble-got-it" onClick={pressEnter ? onContinue : onDismiss}>
          {t(pressEnter ? "terminal.signIn.doneContinue" : "terminal.signIn.doneOk")}
        </button>
      </div>
    </div>,
    host,
  );
}
