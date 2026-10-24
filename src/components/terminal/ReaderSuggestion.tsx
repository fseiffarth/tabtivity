import { useT } from "../../lib/i18n";
import { UntestedTag } from "../common/UntestedTag";

/**
 * Claude Code's prompt suggestion over the Reader composer, in the `/` menu's
 * look (`ReaderSlashMenu`'s classes). The CLI draws it dimmed in its own box,
 * which the chat hides; picking the row only fills the composer, so the user
 * still sends, edits or ignores it.
 */
export function ReaderSuggestion({ text, onPick }: { text: string; onPick: () => void }) {
  const t = useT();
  return (
    <div className="terminal-reader-slash" role="group" aria-label={t("terminal.reader.suggestion")}>
      <div className="terminal-reader-slash-head">
        {t("terminal.reader.suggestion")} <UntestedTag id="terminal.reader.promptSuggestion" />
      </div>
      <div className="terminal-reader-slash-row">
        {/* The composer keeps the focus: a click must not blur the field it fills. */}
        <button type="button" className="terminal-reader-slash-pick" title={t("terminal.reader.suggestionHint")} onMouseDown={(event) => event.preventDefault()} onClick={onPick}>
          <strong>{text}</strong>
        </button>
      </div>
    </div>
  );
}
