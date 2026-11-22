import { useT } from "../../lib/i18n";

/**
 * The one status line over the composer docked under Diffs or Data
 * (`TerminalReaderView`), drawn only while there is something to say: the
 * agent works (Chat's working line, its time and tokens, how many prompts
 * wait in the CLI's queue, Stop) or asks something (the docked field is
 * locked until it is answered, which happens in Chat). Plain values in, so
 * the Reader decides what it shows.
 */
export function ReaderDockStatus({ kind, line, facts, queued = 0, onStop, onAnswerInChat }: {
  kind: "working" | "question";
  /** Working: the working row's words (`Opus is working…`). */
  line?: string;
  /** Working: elapsed time and tokens, already joined. */
  facts?: string;
  /** Working: prompts sent from here that wait in the CLI's queue. */
  queued?: number;
  /** Working: Stop, when there is a turn of the session's to stop. */
  onStop?: () => void;
  /** Question: switch to Chat, where the question's rows are. */
  onAnswerInChat?: () => void;
}) {
  const t = useT();
  if (kind === "question") {
    return (
      <div className="terminal-reader-dock-status question" role="status">
        <strong>{t("terminal.reader.dockQuestion")}</strong>
        <small>{t("terminal.reader.dockQuestionHint")}</small>
        {onAnswerInChat && (
          <button type="button" className="terminal-reader-chat-resume" onClick={onAnswerInChat}>
            {t("terminal.reader.dockAnswerInChat")}
          </button>
        )}
      </div>
    );
  }
  return (
    <div className="terminal-reader-dock-status" role="status">
      <span className="terminal-reader-working-dots" aria-hidden="true"><i /><i /><i /></span>
      <span className="terminal-reader-dock-line">{line}</span>
      {facts && <small>{facts}</small>}
      {queued > 0 && <small>{t("terminal.reader.dockQueued", { count: queued })}</small>}
      {onStop && (
        <button type="button" className="terminal-reader-stop" onClick={onStop} title={t("terminal.reader.stopHint")}>
          {t("terminal.reader.stop")}
        </button>
      )}
    </div>
  );
}
