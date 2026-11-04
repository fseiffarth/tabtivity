import type { TabEntry } from "../../stores/tabs/types";
import { ASSISTANT_SCOPE } from "../assistant";
import { AGENT_CLI_ROWS } from "./agentCliTable";

/**
 * Agent tabs named by their task: a new agent tab opens as its CLI ("Claude",
 * "Codex") and takes the name of its first prompt once one is recorded
 * (`stores/agents/autoTabNames` does the renaming; this module is its pure
 * half).
 *
 * The tab remembers the label Tabtivity gave it (`TabEntry.autoLabel`). A
 * prompt renames it only while `label === autoLabel`, so a name the user set —
 * on the desktop, the phone, a schedule — breaks the match from any route, and
 * nothing touches that tab again. `autoNamed` says its first prompt already
 * named it: the name is set once, not every turn.
 */

/** The longest name a prompt gives a tab, before the ellipsis. */
export const AUTO_TAB_NAME_MAX = 40;

/** A persisted `autoLabel` is read from a layout file on disk: plain text,
 *  capped like a label a user could type. */
const AUTO_LABEL_CAP = 200;

/** Placeholders a CLI writes into the prompt for an attachment, never words
 *  of the task: Claude's `[Image #1]`, `[Pasted text #2 +40 lines]`. */
const ATTACHMENT_RE = /\[(?:Image|Pasted text|Pasted image|File)[^\]]*\]/gi;

/** Launch arguments that resume a conversation: its first prompt is long gone,
 *  so a reopened conversation keeps the name it comes back with. */
const RESUME_FLAGS = new Set(["--resume", "--continue", "-c", "-r"]);

/** The name `prompt` gives a tab, or `null` when it holds no words of a task —
 *  a slash command (`/model`, `/init`) is not one; `/goal <text>` names the
 *  goal. Whitespace collapsed, cut at a word near `AUTO_TAB_NAME_MAX`. */
export function promptTabName(prompt: string): string | null {
  let text = prompt.replace(ATTACHMENT_RE, " ").replace(/\s+/g, " ").trim();
  if (text.startsWith("/")) {
    const goal = /^\/goal\s+(.+)$/i.exec(text);
    if (!goal) return null;
    text = goal[1].trim();
  }
  // Quoting and emphasis marks around the start say nothing in a tab.
  text = text.replace(/^[>*_`"'#\s-]+/, "").trim();
  if (!text) return null;
  const chars = Array.from(text);
  if (chars.length <= AUTO_TAB_NAME_MAX) return text.replace(/[\s.,;:!?]+$/u, "") || text;
  const head = chars.slice(0, AUTO_TAB_NAME_MAX).join("");
  // The head ending exactly at a word keeps that word.
  const space = chars[AUTO_TAB_NAME_MAX] === " " ? head.length : head.lastIndexOf(" ");
  // A word boundary late enough to keep most of the head; else a hard cut.
  const cut = space >= AUTO_TAB_NAME_MAX / 2 ? head.slice(0, space) : head;
  return `${cut.replace(/[\s.,;:!?-]+$/u, "")}…`;
}

/** The name the first prompt of `prompts` (oldest first) that holds a task
 *  gives, or `null` while none does. */
export function firstPromptTabName(prompts: readonly string[]): string | null {
  for (const prompt of prompts) {
    const name = promptTabName(prompt);
    if (name) return name;
  }
  return null;
}

/** Whether `args` resume an existing conversation rather than start one. */
export function isResumeLaunch(args: readonly string[] | undefined): boolean {
  if (!args?.length) return false;
  // Codex and OpenCode take it as a subcommand.
  return args[0] === "resume" || args.some((arg) => RESUME_FLAGS.has(arg));
}

/**
 * `spec` as a tab of `scope` opens: armed for a name from its first prompt
 * when it is a new conversation of an agent. A spec that already carries an
 * `autoLabel` (a closed tab reopened) keeps it. Not armed: a resumed
 * conversation, a sign-in or cloud tab (no task), Tabby's chats, and every
 * other kind of tab.
 *
 * Only a registry CLI: for a custom command or a local-model tab (`ollama`)
 * the tab's own label is what names its CLI to the screen parsers and the
 * phone (`agentModels.agentTabLabel`, `discovery::agent_label_of`), so a task
 * name there would hide which CLI it runs.
 */
export function withAutoLabel<T extends Omit<TabEntry, "key">>(scope: string, spec: T): T {
  if (spec.autoLabel !== undefined) return spec;
  if (spec.kind !== "agent" || !AGENT_CLI_ROWS.some((row) => row.bin === spec.cmd)) return spec;
  if (scope === ASSISTANT_SCOPE || spec.signIn || spec.cloud || spec.login || spec.assistant) return spec;
  if (isResumeLaunch(spec.args) || !spec.label.trim()) return spec;
  return { ...spec, autoLabel: spec.label };
}

/** A persisted `autoLabel` as a usable one, or `undefined`. */
export function normalizeAutoLabel(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= AUTO_LABEL_CAP ? value : undefined;
}

/** Whether a prompt may still rename `tab`: its label is the one Tabtivity
 *  gave it. */
export function holdsAutoLabel(tab: Pick<TabEntry, "label" | "autoLabel">): boolean {
  return tab.autoLabel !== undefined && tab.label === tab.autoLabel;
}
