import { useT } from "../../lib/i18n";
import { UntestedTag } from "../common/UntestedTag";

/**
 * Who wrote the next-prompt suggestion dimmed in an empty composer: Claude's
 * own (read off its screen), or the local model's, named by the model the
 * backend ran (`services::next_prompt`; "Local model" from a backend that
 * names none). Shown by the Chat composer and steering's prompt box.
 */
export function SuggestionSourceChip({ local, model = "" }: { local: boolean; model?: string }) {
  const t = useT();
  const label = local ? model || t("terminal.reader.suggestionSourceLocal") : t("terminal.reader.suggestionSourceClaude");
  const title = local && model ? t("terminal.reader.suggestionByModel", { model }) : t(local ? "terminal.reader.localSuggestion" : "terminal.reader.suggestion");
  return (
    <span className="terminal-reader-chip suggestion-source-chip" title={title}>
      <span className="suggestion-source-name">{label}</span>
      <UntestedTag id="agents.nextPromptSource" />
    </span>
  );
}
