import { useEffect, useRef, useState } from "react";
import { ApiError, type TabRow } from "../api";
import { NoAssistantLaunch, openAssistantChat } from "../assistantChat";
import { describeFailure } from "../connection";
import { useT } from "../../../src/lib/i18n";
import { isUntested } from "../../../src/lib/untested";

/**
 * What Home's Tabby FAB opens for the moment the chat takes to come up: the
 * last chat (started again when it has no process) or, with none, a new one on
 * the desktop's default CLI (`openAssistantChat`). Once it is live the App
 * shows it in the Focus chat in place of this screen; Back returns to Home. A
 * failure stays here with what stands in the way and a Retry.
 */
export function TabbyOpen({ id, ready, back }: { id: string; ready: (tab: TabRow) => void; back: () => void }) {
  const t = useT();
  const [failure, setFailure] = useState<string[] | null>(null);
  const [attempt, setAttempt] = useState(0);
  const readyRef = useRef(ready);
  readyRef.current = ready;
  useEffect(() => {
    let alive = true;
    setFailure(null);
    openAssistantChat(id, () => alive).then(
      (tab) => { if (alive) readyRef.current(tab); },
      (reason: unknown) => {
        if (!alive) return;
        if (reason instanceof NoAssistantLaunch) {
          const options = reason.options;
          if (!options) setFailure([t("mobile.assistant.failed")]);
          else if (options.launches.length === 0) setFailure([options.ollama_reachable ? t("mobile.assistant.none") : t("mobile.assistant.ollamaDown")]);
          else setFailure([...new Set(options.launches.map((row) => row.label))].map((label) => t("mobile.assistant.notReady", { label })));
        } else if (reason instanceof ApiError && reason.code === "session_gone") {
          setFailure([t("mobile.assistant.startFailed")]);
        } else {
          setFailure([describeFailure(reason)]);
        }
      },
    );
    return () => { alive = false; };
    // `t` changing must not start the chat again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, attempt]);
  return <main className="screen project-screen tabby-open">
    <header className="project-header">
      <button className="back" onClick={back} aria-label={t("common.back")} title={t("common.back")}>‹</button>
      <div className="terminal-title"><h1>{t("assistant.title")}{isUntested("mobile.assistant") && <small className="untested">{t("mobile.newTab.untested")}</small>}</h1></div>
    </header>
    <section className="tabby-open-body">
      {failure === null
        ? <p className="sheet-note" role="status">{t("mobile.assistant.starting")}</p>
        : <>
          <p className="sheet-note">{t("mobile.assistant.note")}</p>
          {failure.map((line) => <p className="error" role="alert" key={line}>{line}</p>)}
          <button className="primary" onClick={() => setAttempt((count) => count + 1)}>{t("mobile.app.retry")}</button>
        </>}
    </section>
  </main>;
}
