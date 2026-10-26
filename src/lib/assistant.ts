import { invoke } from "@tauri-apps/api/core";
import type { Settings } from "../types";
import { DEFAULT_AGENT_MODELS } from "./agents/agentPrefaces";
import { readableScreen, type ReadableBufferLike } from "../../mobile-web/src/terminal/readableScreen";
import { mergeSelectRows, readSelectPrompt, type SelectStep } from "../../mobile-web/src/terminal/selectPrompt";

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
  /** Codex: the models its chat can be switched to (its catalog's listed
   *  slugs, the start model first). Empty for every other CLI. */
  models?: string[];
}

/** The model of a Claude chat launched without `--model`: the picker's
 *  "Default" row. Never reaches an argv — `switchAssistantModel` turns it into
 *  a launch with no model. */
export const ASSISTANT_DEFAULT_MODEL = "default";

/** One model a chat can be switched to, as its sheet lists it. */
export interface AssistantModelRow {
  /** What the chat is launched with (`AssistantLaunch.model`), or
   *  {@link ASSISTANT_DEFAULT_MODEL}. */
  id: string;
  label: string;
  description?: string;
}

/** The row a chat's launch runs on now; `undefined` for a launch no row names. */
export function assistantCurrentModel(launch: AssistantLaunch): string | undefined {
  return launch.model ?? (launch.cli === "claude" ? ASSISTANT_DEFAULT_MODEL : undefined);
}

/** The `--model` a row of Claude's picker stands for: `Default (recommended)`
 *  is the default, `Opus 5.5` is `claude-opus-5-5`, a bare `Fable` (older
 *  pickers name the family and put the version in the note) the alias. A row
 *  in any other shape (`Opus (1M context)`) has no name a chat can take. */
export function claudeModelId(label: string): string | null {
  const clean = label.replace(/\s*\u2714\s*$/u, "").trim();
  if (/^default\b/iu.test(clean)) return ASSISTANT_DEFAULT_MODEL;
  const named = /^(opus|sonnet|haiku|fable)(?:\s+(\d+(?:\.\d+)?))?$/iu.exec(clean);
  if (!named) return null;
  const family = named[1].toLowerCase();
  return named[2] ? `claude-${family}-${named[2].replace(".", "-")}` : family;
}

/** Claude's `/model` rows off the screens its probe captured as the picker's
 *  highlight walked down (`assistant_claude_models`), read and pieced
 *  together by the reader the model sheet of every other Claude tab uses
 *  (`readSelectPrompt`, `mergeSelectRows`). The ✔ Claude draws marks the
 *  home's default, not the chat's, so it is dropped. Empty when no screen
 *  holds a picker. */
export function claudeModelRows(screens: readonly (readonly string[])[]): AssistantModelRow[] {
  let step: SelectStep | null = null;
  for (const screen of screens) {
    const buffer: ReadableBufferLike = {
      length: screen.length,
      getLine: (row) => {
        const text = screen[row];
        return text === undefined ? undefined : { length: text.length, translateToString: () => text };
      },
    };
    const picker = readSelectPrompt(readableScreen(buffer, screen.length, { plain: true }).lines, "Claude");
    if (picker) step = mergeSelectRows(step, picker);
  }
  const rows: AssistantModelRow[] = [];
  for (const option of step?.options ?? []) {
    const id = claudeModelId(option.label);
    if (!id || rows.some((row) => row.id === id)) continue;
    const label = option.label.replace(/\s*\u2714\s*$/u, "").trim();
    rows.push(option.description ? { id, label, description: option.description } : { id, label });
  }
  return rows;
}

/**
 * The models a chat on `cli` can run, for the Reader's model chip, the head's
 * model dropdown and the phone's model sheet: a local CLI's installed Ollama
 * models, Claude's own `/model` rows, Codex's catalog. A chat's slash
 * commands are off (`--disable-slash-commands`), so Claude's picker is read
 * in a probe of the assistant's home instead (its aliases when that fails),
 * and a pick restarts the chat on it (`switchAssistantModel`).
 */
export async function assistantModelRows(cli: AssistantCliOption, options: AssistantOptions): Promise<AssistantModelRow[]> {
  const plain = (id: string): AssistantModelRow => ({ id, label: id });
  if (cli.local) return options.localModels.map(plain);
  if (cli.id !== "claude") return (cli.models ?? []).map(plain);
  const screens = await invoke<string[][]>("assistant_claude_models").catch(() => null);
  const rows = Array.isArray(screens) ? claudeModelRows(screens) : [];
  return rows.length > 0 ? rows : (DEFAULT_AGENT_MODELS.claude ?? []).map(plain);
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
