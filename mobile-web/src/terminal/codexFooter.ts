/**
 * Codex's footer under the input box: `<model> <effort> · <dir>` (0.167+), with
 * the hint row beneath it. Its model is whatever the session runs — a hosted
 * `gpt-5.2-codex medium`, or a local Ollama name with a tag
 * (`nemotron-3.5-bolt:e4b default`) — so it is told by position, not by a
 * list of known families as `statusLine.ts` `MODEL` does. The effort is the
 * word after it; `default` is what Codex prints when none was chosen, and
 * is left unset — it says nothing the chip row should show.
 */

const CODEX_TAB = /codex/iu;

export function isCodexTab(agentLabel?: string): boolean {
  return !!agentLabel && CODEX_TAB.test(agentLabel);
}

const EFFORT = "none|minimal|low|medium|high|x-?high|extra high|max|ultra|default";
/** A model name: one or two words, the first opening on a letter or digit. */
const WITH_EFFORT = new RegExp(`^([A-Za-z0-9][^\\s·•|]*(?: [A-Za-z0-9][^\\s·•|]*)?)\\s+(${EFFORT})$`, "iu");
/** A bare model name, with nothing after it. Plain words (`esc`, `Working`)
 * are no model: it needs a digit, dash, dot, colon or slash, as every real
 * model id has one. */
const BARE = /^[A-Za-z0-9][\w.:/@+-]*$/u;
const MODEL_CHARS = /[\d.:/-]/u;

/** A footer segment that is the model (and effort) — `status.model` and
 * `status.effort` are filled, and `true` returned so the segment is not read
 * as anything else. `first` is the first segment of the footer's first row,
 * the model's place; elsewhere only a segment that names an effort counts. */
export function codexModelSegment(
  segment: string,
  status: { model?: string; effort?: string },
  first: boolean,
): boolean {
  if (status.model) return false;
  const withEffort = WITH_EFFORT.exec(segment);
  if (withEffort && (first || MODEL_CHARS.test(withEffort[1]))) {
    status.model = withEffort[1];
    const effort = withEffort[2].toLowerCase();
    if (effort !== "default") status.effort = effort;
    return true;
  }
  if (first && BARE.test(segment) && MODEL_CHARS.test(segment)) {
    status.model = segment;
    return true;
  }
  return false;
}

/** A directory the footer cut to fit (`/home/dev/proj/…`) is a prefix, not
 * where the session is. */
export function codexPathTruncated(path: string | undefined): boolean {
  return !!path && path.endsWith("…");
}

/** A history row (`■ Conversation interrupted - use /feedback …`, `• …`) under
 * a `› ` that is a past message, not the composer — a locked or interrupted
 * screen has no footer, and a command named in the sentence is no directory. */
export function codexOutputRow(text: string): boolean {
  return /^[■•✗✘]\s/u.test(text);
}
