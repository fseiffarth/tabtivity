import { invoke } from "@tauri-apps/api/core";
import type { Settings } from "../types";

/**
 * The chat assistant's shared frontend constants (`docs/assistant_plan.md`).
 * The user-facing name is `BRAND.assistant` / the `{assistant}` placeholder
 * (`lib/brand.ts`); code identifiers say `assistant`, never the name.
 */

/** The scope id of the assistant's tabs: `storage::ASSISTANT_SCOPE` in the
 *  backend, `tabsByScope[ASSISTANT_SCOPE]` here. Not a project and not root
 *  (`ROOT_SCOPE`), so anything that reads "a scope that is not root" as a
 *  project must meet this one first. */
export const ASSISTANT_SCOPE = "assistant";

/**
 * A chat's prompt target. Its record carries no `scheduleTargetId` (the backend
 * refuses a schedule for the scope), yet the Reader's composer sends through
 * the scheduled-input registry as every agent tab's does. So the chat's pane
 * registers its input under this id (`tabTerminalSpawn`'s `promptTargetId`) —
 * derived from the tab key, window-local, never sent to the backend — and the
 * Reader reads the chat with it filled in ({@link withAssistantPromptTarget}).
 */
export function assistantPromptTarget(tabKey: string): string {
  return `${ASSISTANT_SCOPE}:${tabKey}`;
}

/** `tab` with its {@link assistantPromptTarget} as `scheduleTargetId` when it
 *  is a chat of the assistant scope; any other tab unchanged. */
export function withAssistantPromptTarget<T extends { key: string; scheduleTargetId?: string }>(
  scope: string,
  tab: T | undefined,
): T | undefined {
  if (scope !== ASSISTANT_SCOPE || !tab || tab.scheduleTargetId) return tab;
  return { ...tab, scheduleTargetId: assistantPromptTarget(tab.key) };
}

/**
 * What a chat tab is launched as: the tab's persisted `assistant` block and
 * `PtyOptions.assistant` (`services::assistant::AssistantLaunch`). The backend
 * builds the argv from it and from nothing the renderer sends; `cli` is an
 * `AssistantCli` id (`claude`, `codex`, `opencode_local`, `claude_local`),
 * `model` is set for the local CLIs.
 */
export interface AssistantLaunch {
  cli: string;
  model?: string | null;
}

/** A persisted `assistant` block read defensively (the layout is a file on
 *  disk): `cli` a non-empty string, `model` a string or absent. Anything else
 *  is no launch. The backend validates the cli and the model again before it
 *  builds an argv, so this only keeps the type honest. */
export function readAssistantLaunch(raw: unknown): AssistantLaunch | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const { cli, model } = raw as Record<string, unknown>;
  if (typeof cli !== "string" || !cli) return undefined;
  if (model != null && typeof model !== "string") return undefined;
  return model ? { cli, model } : { cli };
}

// ── Commands (`commands/assistant.rs`) ──────────────────────────────────────
//
// Each refuses with the wire code `assistant_off` while the experimental flag
// is off. The assistant service's own refusals come as `"<code>: <text>"`
// (`not_offered`, `model_required`, `bad_model`, `no_lane`, `codex_catalog`, …).

/** The error code of every command while the experimental flag is off. */
export const ASSISTANT_OFF = "assistant_off";

/** The code of a command error: `assistant_off`, `not_offered`, `invalid_url`, … */
export function assistantErrorCode(err: unknown): string {
  const text = String(err);
  const code = /^(?:Error: )?([a-z_]+)(?::|$)/.exec(text);
  return code?.[1] ?? "";
}

/** One CLI the new-chat menu may offer. */
export interface AssistantCliOption {
  /** `claude`, `codex`, `opencode_local` or `claude_local`. */
  id: string;
  label: string;
  /** Runs on a local Ollama model: a chat then needs a `model`. */
  local: boolean;
  installed: boolean;
  /** Cloud CLIs only: the shared login (or an API key) is there. */
  signedIn: boolean | null;
  /** A chat can start now. */
  ready: boolean;
}

/** The web lane's search backend. Never carries the key. */
export interface AssistantSearchState {
  kind: "searxng" | "ollama" | null;
  searxngUrl: string | null;
  /** `null`: the keychain cannot be read right now (the answer is unknown). */
  ollamaKeyStored: boolean | null;
  keyring: "unlocked" | "locked" | "unavailable";
  /** `web_search` has a backend it can use. */
  configured: boolean;
}

export interface AssistantOptions {
  clis: AssistantCliOption[];
  /** Installed Ollama models; empty when Ollama is down. */
  localModels: string[];
  ollamaReachable: boolean;
  defaultCli: string | null;
  defaultModel: string | null;
  search: AssistantSearchState;
}

/** A chat just made: the tab lives in the assistant scope, announced by
 *  `workspace:patch`. */
export interface AssistantNewChat {
  tabId: string;
  /** The tab uid and the CLI session id. */
  uid: string;
  scope: string;
  version: number;
}

export interface AssistantSearchSaved {
  search: AssistantSearchState;
  /** The settings as written, to broadcast like any settings write. */
  settings: Settings;
}

export function assistantOptions(): Promise<AssistantOptions> {
  return invoke<AssistantOptions>("assistant_options");
}

/** `model` is required for a local CLI. */
export function assistantNewChat(cli: string, model?: string | null): Promise<AssistantNewChat> {
  return invoke<AssistantNewChat>("assistant_new_chat", { cli, model: model ?? null });
}

/** `kind`: `searxng` (needs `url`), `ollama` (needs a stored or given `key`) or
 *  `none`. An empty `key` removes the stored one. The key is never returned. */
export function assistantSetSearch(
  kind: "searxng" | "ollama" | "none",
  opts: { url?: string | null; key?: string | null } = {},
): Promise<AssistantSearchSaved> {
  return invoke<AssistantSearchSaved>("assistant_set_search", {
    kind,
    url: opts.url ?? null,
    key: opts.key ?? null,
  });
}
