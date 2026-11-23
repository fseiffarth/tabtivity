import { useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  NEXT_PROMPT_CLAUDE_SETTLE_MS,
  NEXT_PROMPT_SETTLE_MS,
  useNextPrompt,
  usePromptCompletion,
  useWorkEndKey,
  type NextPromptAnswer,
  type NextPromptPhase,
  type NextPromptShown,
  type PromptCompletionShown,
} from "../../../mobile-web/src/terminal/nextPrompt";
import type { TranscriptEntry } from "../../../mobile-web/src/api";
import { useActivityStore } from "../../stores/activity";
import { useSettingsStore } from "../../stores/settings";
import { useTabsStore, type TabEntry } from "../../stores/tabs";
import { usePaneVisible } from "../files/fileAccess";
import { isClaudeCommand } from "../terminal/terminalControl";
import { readerOffered, readerRequest } from "./agentReader";

/**
 * The desktop's local-model "what's next" suggestion: `useNextPrompt` (the
 * phone's too, `mobile-web/src/terminal/nextPrompt.ts`) asking the backend's
 * `agent_next_prompt` with the tab's identity — the arguments the Reader's
 * `agent_tab_transcript` read names it by, never a model (the backend picks
 * the Suggestions role itself). The Chat composer (`TerminalReaderView`) and
 * steering's prompt box (`SteeringPromptOverlay`) show what it gives in the
 * slot Claude's own suggestion takes, so Tab / → take it unchanged. While a
 * prompt is typed there, `usePromptComplete` asks the same command how it
 * goes on (`complete`, with the draft), drawn dim after the caret
 * (`PromptGhost`).
 */

/** The ended turn of a stored conversation, as a key new for each turn: its
 * last prompt and the answer the conversation ends on. Null while it does not
 * end on an answer (a prompt still unanswered, a subagent at work, a question
 * waiting) or holds nothing. */
export function endedTurnKey(entries: readonly TranscriptEntry[] | undefined): string | null {
  const last = entries?.[entries.length - 1];
  if (!entries || !last || last.kind !== "answer" || last.blocking || last.asking) return null;
  let prompt: TranscriptEntry | undefined;
  for (let i = entries.length - 1; i >= 0 && !prompt; i -= 1) if (entries[i].kind === "prompt") prompt = entries[i];
  return [prompt?.at ?? "", prompt?.text.length ?? 0, last.at ?? "", last.text.length].join("|");
}

/** A local-model agent tab (`local_agent`) is in a turn somewhere in this
 * window: the Ollama a warm-up would feed is answering it. */
export function localAgentWorking(): boolean {
  const { tabsByScope } = useTabsStore.getState();
  const { busyByTab } = useActivityStore.getState();
  return Object.entries(tabsByScope).some(([scope, tabs]) =>
    tabs.some((tab) => tab.kind === "local_agent" && busyByTab[`${scope}:${tab.key}`]));
}

/** The `agent_next_prompt` arguments for `tab`: `agent_tab_transcript`'s
 * identity (`readerRequest`) and the phase. Null for a tab with no session
 * to name. */
export function nextPromptArgs(
  scope: string,
  tab: TabEntry,
  cwd: string | undefined,
  remoteHost: string | null | undefined,
  phase: NextPromptPhase | "complete",
): Record<string, unknown> | null {
  const request = readerRequest(scope, tab, cwd, undefined, 0, undefined, undefined, remoteHost);
  if (!request) return null;
  const { agent, projectId, tabDir, since, sessionId, localModel } = request;
  return { agent, projectId, tabDir, since, sessionId, localModel, remoteHost: remoteHost ?? null, phase };
}

export { useWorkEndKey, type NextPromptShown, type PromptCompletionShown };

export interface LocalNextPromptInput {
  scope: string;
  tab: TabEntry | undefined;
  cwd?: string;
  /** The host a remote project's tab runs on (`hostTabId`). */
  remoteHost?: string | null;
  /** The composer is on screen. `PaneVisibleContext` is honoured as well. */
  visible: boolean;
  working: boolean;
  turnKey: string | null;
  /** Changes on each transcript read that moved: what warm-ups follow. A
   * surface that reads none passes a constant and `warm: false`. */
  progress?: unknown;
  warm?: boolean;
  screenSuggestion: string;
  composerEmpty: boolean;
}

/** The local model's suggestion for `tab`'s ended turn and the model that
 * wrote it (`text` "" when none). */
export function useLocalNextPrompt({ scope, tab, cwd, remoteHost, visible, working, turnKey, progress, warm = true, screenSuggestion, composerEmpty }: LocalNextPromptInput): NextPromptShown {
  const paneVisible = usePaneVisible();
  const ident = useRef({ scope, tab, cwd, remoteHost });
  ident.current = { scope, tab, cwd, remoteHost };
  const offered = readerOffered(tab, !!remoteHost);
  const claude = isClaudeCommand(tab?.cmd);
  const localModel = tab?.kind === "local_agent";
  return useNextPrompt({
    enabled: visible && paneVisible && offered,
    working,
    turnKey,
    progress,
    // A local-model tab's own turn holds the GPU, and so does any other's.
    canWarm: () => warm && !localModel && !localAgentWorking(),
    settleMs: claude ? NEXT_PROMPT_CLAUDE_SETTLE_MS : NEXT_PROMPT_SETTLE_MS,
    screenSuggestion,
    composerEmpty,
    ask: (phase) => {
      const { scope: s, tab: t, cwd: c, remoteHost: host } = ident.current;
      const args = t ? nextPromptArgs(s, t, c, host, phase) : null;
      // Through a resolved promise: a mocked `invoke` that answers nothing
      // still yields a promise.
      return args
        ? Promise.resolve().then(() => invoke<NextPromptAnswer>("agent_next_prompt", args)).catch(() => null)
        : Promise.resolve(null);
    },
  });
}

/** Asks how `draft` goes on for `tab` (`agent_next_prompt`, `complete`):
 * `skipped` while a local-model agent tab is in a turn (its Ollama is
 * answering that), null for a tab with no session to name. */
export function completePromptFor(
  scope: string,
  tab: TabEntry | undefined,
  cwd: string | undefined,
  remoteHost: string | null | undefined,
  draft: string,
): Promise<NextPromptAnswer | null> {
  if (localAgentWorking()) return Promise.resolve({ text: null, status: "skipped" });
  const args = tab ? nextPromptArgs(scope, tab, cwd, remoteHost, "complete") : null;
  return args
    ? Promise.resolve().then(() => invoke<NextPromptAnswer>("agent_next_prompt", { ...args, draft })).catch(() => null)
    : Promise.resolve(null);
}

export interface PromptCompleteInput {
  scope: string;
  tab: TabEntry | undefined;
  cwd?: string;
  remoteHost?: string | null;
  /** The composer is on screen and takes typing. `PaneVisibleContext` and the
   * setting (`prompt_autocomplete`, on unless false) are honoured as well. */
  visible: boolean;
  draft: string;
  /** The caret is at the draft's end, nothing selected. */
  atEnd: boolean;
  /** The suggestion the empty box offers, and who wrote it. */
  seed?: string;
  seedModel?: string;
  seedLocal?: boolean;
}

/** How the prompt being typed for `tab` goes on (`usePromptCompletion`):
 * the local Suggestions model's continuation, or the rest of the offered
 * suggestion while the draft is typed along it. */
export function usePromptComplete({ scope, tab, cwd, remoteHost, visible, draft, atEnd, seed, seedModel, seedLocal }: PromptCompleteInput): PromptCompletionShown {
  const paneVisible = usePaneVisible();
  const on = useSettingsStore((s) => s.settings?.prompt_autocomplete !== false);
  const ident = useRef({ scope, tab, cwd, remoteHost });
  ident.current = { scope, tab, cwd, remoteHost };
  return usePromptCompletion({
    enabled: visible && paneVisible && on && readerOffered(tab, !!remoteHost),
    draft,
    atEnd,
    seed,
    seedModel,
    seedLocal,
    complete: (text) => {
      const { scope: s, tab: t, cwd: c, remoteHost: host } = ident.current;
      return completePromptFor(s, t, c, host, text);
    },
  });
}
