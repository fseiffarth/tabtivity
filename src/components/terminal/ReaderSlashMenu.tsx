import { useEffect, useRef } from "react";
import { useT } from "../../lib/i18n";
import { UntestedTag } from "../common/UntestedTag";
import type { SlashSuggestion } from "../../../mobile-web/src/slashCommands";

/**
 * The Reader composer's `/` menu — the phone composer's (`slashCommands`), on
 * the desktop: the commands that continue the draft, the ones sent before
 * first. Picking a row only fills the field; the user still sends it, so a
 * stray click never runs `/clear` on a session. `at` is the row ↑/↓ moved to,
 * or null before they were pressed.
 */
export function ReaderSlashMenu({ suggestions, at, onPick, onForget }: {
  suggestions: readonly SlashSuggestion[];
  at: number | null;
  onPick: (suggestion: SlashSuggestion) => void;
  onForget: (line: string) => void;
}) {
  const t = useT();
  const listRef = useRef<HTMLDivElement>(null);

  // Keep the row the arrows reached in view inside the menu's own scroll.
  useEffect(() => {
    if (at === null) return;
    listRef.current?.querySelectorAll<HTMLElement>(".terminal-reader-slash-row")[at]?.scrollIntoView?.({ block: "nearest" });
  }, [at]);

  return (
    <div ref={listRef} className="terminal-reader-slash" role="listbox" aria-label={t("mobile.slash.title")}>
      <div className="terminal-reader-slash-head">
        {t("mobile.slash.title")} <UntestedTag id="terminal.reader.slash" />
      </div>
      {suggestions.map((suggestion, index) => (
        <div
          key={suggestion.line}
          role="option"
          aria-selected={index === at}
          className={`terminal-reader-slash-row${index === at ? " active" : ""}${suggestion.used ? " used" : ""}`}
        >
          {/* The composer keeps the focus: a click must not blur the field it fills. */}
          <button type="button" className="terminal-reader-slash-pick" onMouseDown={(event) => event.preventDefault()} onClick={() => onPick(suggestion)}>
            <strong>{suggestion.line}</strong>
            {suggestion.used
              ? <small>{t("mobile.slash.recent")}{suggestion.description ? ` · ${suggestion.description}` : ""}</small>
              : suggestion.description && <small>{suggestion.description}</small>}
          </button>
          {suggestion.used && (
            <button
              type="button"
              className="terminal-reader-slash-forget"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onForget(suggestion.line)}
              aria-label={t("mobile.slash.forget", { command: suggestion.line })}
              title={t("mobile.slash.forget", { command: suggestion.line })}
            >
              ✕
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
