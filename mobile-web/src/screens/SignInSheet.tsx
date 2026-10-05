import { useEffect, useState } from "react";
import { useT } from "../../../src/lib/i18n";
import { isUntested } from "../../../src/lib/untested";
import { finishSignIn } from "../api";
import { describeFailure } from "../connection";
import { selectSignature, type SelectOption, type SelectPrompt } from "../terminal/selectPrompt";
import { pastedCallback, type SignIn } from "../terminal/signIn";

type Outcome = { text: string; error?: boolean };

/**
 * Finishes an agent CLI's browser sign-in from the phone (`signIn.ts` reads
 * it off the session). One sheet for every CLI, laid out as numbered steps;
 * what the steps ask follows the flow the link is in:
 *
 *   - device:   one tap copies the code and opens the page; the code is
 *               pasted there and the CLI carries on by itself;
 *   - code:     the page ends on a code; Paste reads it off the clipboard and
 *               types it into the session with Enter, as the CLI's own prompt
 *               asks (a field takes it by hand too);
 *   - callback: the page redirects to a `localhost` address the phone cannot
 *               open; that address, pasted, is delivered to the CLI by the
 *               desktop (`finishSignIn`);
 *   - wait:     nothing: the CLI notices by itself.
 *
 * Either answer is taken in either field — the one that fits is used —
 * because Antigravity both redirects home and asks for a pasted code.
 *
 * `signIn` is the live reading and `done` the session saying it went through:
 * the sheet then says so and offers Done. In a sign-in tab (`signInTab`, the
 * desktop's own login command for this CLI) the sheet is up from the start —
 * waiting for the link, then the steps — and a sign-in that ended without
 * success offers to start again, or the CLI's other way in. A choice the CLI
 * asks before its link (`choice`: Antigravity's "Select login method") is
 * listed while the sheet waits, and a tap answers it in the session.
 */
export function SignInSheet({ tabId, agent, signIn, done = false, ended = false, signInTab = false, alternate, error, choice, connected, onType, onChoose, onRetry, onFinish, onClose }: {
  tabId: string;
  agent: string;
  signIn: SignIn | null;
  /** The session says the sign-in went through. */
  done?: boolean;
  /** The session behind the sheet has ended. */
  ended?: boolean;
  /** This tab exists only to sign in. */
  signInTab?: boolean;
  /** The CLI's other way in, when it has one (`signInLaunch.ts`). */
  alternate?: "console" | "browser";
  /** Why the last retry did not start. */
  error?: string;
  /** A choice the session asks before it prints its link. */
  choice?: SelectPrompt | null;
  connected: boolean;
  /** Types the code into the session and presses Enter; false when it did
   * not leave the phone. */
  onType: (text: string) => boolean;
  /** Answers `choice` with the row tapped; false when it did not leave the
   * phone. */
  onChoose?: (option: SelectOption) => boolean;
  /** Starts the sign-in over in a new sign-in tab (the other way in when
   * `alternate`). */
  onRetry?: (alternate: boolean) => void;
  /** Done in a sign-in tab: the tab has served its purpose. */
  onFinish?: () => void;
  onClose: () => void;
}) {
  const t = useT();
  // The link the sheet opened on, kept while the session repaints; a new
  // link (a retry) replaces it.
  const [shown, setShown] = useState<SignIn | null>(signIn);
  useEffect(() => { if (signIn) setShown(signIn); }, [signIn]);
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [copied, setCopied] = useState<"link" | "code" | null>(null);
  const [opened, setOpened] = useState(false);
  // The row a tap answered `choice` with, while the session has not redrawn:
  // nothing can be tapped twice. A choice still on screen a while later did
  // not take the answer, and is offered again.
  const [chosen, setChosen] = useState<{ signature: string; number: number } | null>(null);
  useEffect(() => {
    if (!chosen) return;
    const retry = window.setTimeout(() => setChosen(null), 4000);
    return () => window.clearTimeout(retry);
  }, [chosen]);
  const choiceSignature = choice ? selectSignature(choice) : "";
  const choiceSent = chosen && chosen.signature === choiceSignature ? chosen.number : undefined;
  const choose = (option: SelectOption) => {
    if (!choice || choiceSent !== undefined || !onChoose) return;
    if (onChoose(option)) setChosen({ signature: choiceSignature, number: option.number });
  };
  // A clipboard the page can read from is a secure origin with the API; the
  // Paste button is offered only then, and the field always.
  const canPaste = typeof navigator !== "undefined" && typeof navigator.clipboard?.readText === "function";

  const copy = (what: "link" | "code", text: string) => {
    // No clipboard (an insecure origin, a refused permission) leaves the
    // button as it was; the link still opens.
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(what);
      window.setTimeout(() => setCopied(null), 1600);
    }).catch(() => undefined);
  };

  const submit = async (value: string) => {
    const text = value.trim();
    if (!text || busy || !shown) return;
    setOutcome(null);
    const callback = pastedCallback(text);
    if (callback) {
      setBusy(true);
      try {
        await finishSignIn(tabId, callback);
        setOutcome({ text: t("mobile.signIn.delivered", { agent }) });
        setAnswer("");
      } catch (cause) {
        setOutcome({ text: describeFailure(cause), error: true });
      } finally {
        setBusy(false);
      }
      return;
    }
    if (shown.flow === "callback") {
      setAnswer(text);
      setOutcome({ text: t("mobile.signIn.needAddress"), error: true });
      return;
    }
    if (!onType(text)) {
      setAnswer(text);
      setOutcome({ text: t("mobile.signIn.notSent"), error: true });
      return;
    }
    setOutcome({ text: t("mobile.signIn.codeSent", { agent }) });
    setAnswer("");
  };

  const paste = async () => {
    let text = "";
    try {
      text = await navigator.clipboard.readText();
    } catch {
      setOutcome({ text: t("mobile.signIn.pasteRefused"), error: true });
      return;
    }
    if (!text.trim()) {
      setOutcome({ text: t("mobile.signIn.pasteEmpty"), error: true });
      return;
    }
    await submit(text);
  };

  const flow = shown?.flow;
  const asks = flow === "code" || flow === "callback";
  const finish = signInTab && onFinish ? onFinish : onClose;

  return <div className="sheet-backdrop" role="presentation" onClick={onClose}>
    <section className="option-sheet sign-in-sheet" role="dialog" aria-modal="true" aria-label={t("mobile.signIn.title", { agent })} onClick={(event) => event.stopPropagation()}>
      <span className="sheet-grip" aria-hidden="true" />
      <header>
        <button className="sheet-close" onClick={onClose} aria-label={t("common.close")}>✕</button>
        <h2>{t("mobile.signIn.title", { agent })}{isUntested("mobile.signIn") && <small>{t("mobile.focus.untested")}</small>}</h2>
        <span className="sheet-close" aria-hidden="true" />
      </header>

      {done ? <div className="sign-in-done" role="status">
        <span className="sign-in-tick" aria-hidden="true">✓</span>
        <strong>{t("mobile.signIn.doneTitle", { agent })}</strong>
        <p className="sheet-note">{t("mobile.signIn.doneNote")}</p>
        <div className="mobile-schedule-actions"><button className="primary" onClick={finish}>{t("mobile.signIn.done")}</button></div>
      </div> : shown ? <>
        <ol className="sign-in-steps">
          <li>
            <span className="sign-in-step" aria-hidden="true">1</span>
            <div>
              {shown.userCode && <div className="sign-in-code">
                <code>{shown.userCode}</code>
                <button onClick={() => copy("code", shown.userCode ?? "")}>{copied === "code" ? t("mobile.signIn.copied") : t("mobile.signIn.copyCode")}</button>
              </div>}
              <div className="sign-in-open">
                <a
                  className={opened ? "button" : "button primary"}
                  href={shown.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => {
                    // Inside the tap, where a clipboard write is allowed: the
                    // page opens with the code ready to paste.
                    if (shown.userCode) copy("code", shown.userCode);
                    setOpened(true);
                  }}
                >
                  <strong>{shown.userCode ? t("mobile.signIn.copyAndOpen") : t("mobile.signIn.openPage")}</strong>
                  <small>{t("mobile.signIn.site", { site: shown.site })}</small>
                </a>
              </div>
            </div>
          </li>
          <li>
            <span className="sign-in-step" aria-hidden="true">2</span>
            <p>{flow === "device" ? t("mobile.signIn.deviceStep", { agent })
              : flow === "code" ? t("mobile.signIn.codeStep")
                : flow === "callback" ? t("mobile.signIn.callbackStep")
                  : t("mobile.signIn.waitStep", { agent })}</p>
          </li>
          {asks && <li>
            <span className="sign-in-step" aria-hidden="true">3</span>
            <form className="mobile-schedule-form sign-in-answer" onSubmit={(event) => { event.preventDefault(); void submit(answer); }}>
              {canPaste && <button type="button" className="primary sign-in-paste" disabled={!connected || busy} onClick={() => void paste()}>
                {busy ? t("mobile.signIn.sending") : flow === "callback" ? t("mobile.signIn.pasteAddress") : t("mobile.signIn.pasteCode")}
              </button>}
              <label>
                {flow === "callback" ? t("mobile.signIn.callbackLabel") : t("mobile.signIn.codeLabel")}
                <input
                  value={answer}
                  onChange={(event) => setAnswer(event.target.value)}
                  autoCapitalize="off"
                  autoCorrect="off"
                  autoComplete="off"
                  spellCheck={false}
                  inputMode={flow === "callback" ? "url" : "text"}
                  placeholder={flow === "callback" ? "http://localhost:…" : ""}
                />
              </label>
              <div className="mobile-schedule-actions">
                <button className={canPaste ? "" : "primary"} type="submit" disabled={!connected || busy || !answer.trim()}>
                  {busy ? t("mobile.signIn.sending") : flow === "callback" ? t("mobile.signIn.finish") : t("mobile.signIn.send", { agent })}
                </button>
              </div>
            </form>
          </li>}
        </ol>
        {outcome && <p className={outcome.error ? "sheet-note error" : "sheet-note"} role={outcome.error ? "alert" : "status"}>{outcome.text}</p>}
        {!signIn && !ended && <p className="sheet-note" role="status">{t("mobile.signIn.gone")}</p>}
        <details className="sign-in-more">
          <summary>{t("mobile.signIn.more")}</summary>
          <p className="sheet-note">{t("mobile.signIn.otherBrowser")}</p>
          <button onClick={() => copy("link", shown.url)}>{copied === "link" ? t("mobile.signIn.copied") : t("mobile.signIn.copyLink")}</button>
        </details>
      </> : !ended && <div className="sign-in-waiting" role="status">
        {signInTab && choice && onChoose ? <>
          <p>{t("mobile.signIn.choiceNote", { agent })}{isUntested("mobile.signIn.choice") && <> · <em>{t("mobile.focus.untested")}</em></>}</p>
          {choice.title && <strong>{choice.title}</strong>}
          <ul className="option-list question-list sign-in-choice">{choice.options.map((option) => <li key={option.number}>
            <button
              className={option.index === choice.current ? "current" : ""}
              aria-current={option.index === choice.current || undefined}
              disabled={!connected || choiceSent !== undefined}
              onClick={() => choose(option)}>
              <span>
                <strong>{option.label}</strong>
                {option.description && <small>{option.description}</small>}
              </span>
              {choiceSent === option.number && <span className="sheet-pending" role="status">{t("mobile.transcript.answering")}</span>}
            </button>
          </li>)}</ul>
          <div className="mobile-schedule-actions"><button onClick={onClose}>{t("mobile.signIn.showSession")}</button></div>
        </> : signInTab ? <>
          <span className="sign-in-spinner" aria-hidden="true" />
          <p>{t("mobile.signIn.starting", { agent })}</p>
          <p className="sheet-note">{t("mobile.signIn.startingNote", { agent })}</p>
          <div className="mobile-schedule-actions"><button onClick={onClose}>{t("mobile.signIn.showSession")}</button></div>
        </> : <p className="sheet-note">{t("mobile.signIn.gone")}</p>}
      </div>}

      {ended && !done && <div className="sign-in-ended" role="alert">
        <p className="sheet-note error">{t("mobile.signIn.ended", { agent })}</p>
        {signInTab && onRetry && <div className="mobile-schedule-actions">
          <button className="primary" onClick={() => onRetry(false)}>{t("mobile.signIn.retry")}</button>
        </div>}
      </div>}
      {error && <p className="sheet-note error" role="alert">{error}</p>}
      {signInTab && onRetry && alternate && !done && <button className="sign-in-alternate" onClick={() => onRetry(true)}>
        {alternate === "console" ? t("mobile.signIn.alternateConsole") : t("mobile.signIn.alternateBrowser")}
      </button>}
    </section>
  </div>;
}
