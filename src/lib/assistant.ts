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
 * Skeleton placeholder, deleted by the step that builds each surface.
 *
 * The untested register (`lib/untested`) fails on a row no source file uses,
 * and the skeleton step registers the ids before their surfaces exist. These
 * entries are the rows' call sites until then: the step that adds the real
 * `UntestedTag` call site (S4b: `assistant.overlay`, `assistant.newChat`,
 * `assistant.search`; S5b: `mobile.assistant`) deletes its entry here, and
 * this constant with the last one.
 */
export const ASSISTANT_PENDING_PILLS = [
  { untested: "assistant.overlay" },
  { untested: "assistant.newChat" },
  { untested: "assistant.search" },
  { untested: "mobile.assistant" },
] as const;

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
