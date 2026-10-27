import { useCallback, useEffect, useRef, useState } from "react";
import {
  assistantErrorCode,
  assistantOptions,
  type AssistantCliOption,
  type AssistantOptions,
} from "../../lib/assistant";
import { AGENT_CLI_ROWS } from "../../lib/agents/agentClis";
import { effectiveAgentOrder, sortByAgentOrder } from "../../lib/tabs/newTabItems";
import { usePoll } from "../../lib/usePoll";
import type { Settings } from "../../types";

/** How often the options are re-read while a surface that shows them is up.
 *  A sign-in or an Ollama start changes them; nothing else does. */
const OPTIONS_POLL_MS = 15_000;

export interface AssistantOptionsHandle {
  /** `null` until the first answer (or after a refusal). */
  options: AssistantOptions | null;
  /** The last read failed: the wire code, or the raw text. */
  error: string | null;
  /** Read now, outside the cadence (after a sign-in, a saved search). */
  refresh: () => Promise<void>;
}

/**
 * `assistant_options`, read on mount and then on a quiesce-aware cadence
 * (`usePoll`: it stops while the window is blurred or the pane hidden) — and
 * only while `active`, so a closed overlay or an unopened Settings page costs
 * nothing. The caller passes the surface's own visibility as `active`.
 */
export function useAssistantOptions(active: boolean): AssistantOptionsHandle {
  const [options, setOptions] = useState<AssistantOptions | null>(null);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const read = useCallback(async () => {
    try {
      const next = await assistantOptions();
      if (!alive.current) return;
      setOptions(next);
      setError(null);
    } catch (err) {
      if (!alive.current) return;
      setError(assistantErrorCode(err) || String(err));
    }
  }, []);

  usePoll(read, OPTIONS_POLL_MS, { enabled: active });
  return { options, error, refresh: read };
}

/** What stands between a CLI and a first chat, for the cards the overlay shows. */
export type CliBlock = "notInstalled" | "signIn" | "ollamaDown" | "noModel" | null;

export function cliBlock(cli: AssistantCliOption, options: AssistantOptions): CliBlock {
  if (!cli.installed) return "notInstalled";
  if (cli.local) {
    if (!options.ollamaReachable) return "ollamaDown";
    if (options.localModels.length === 0) return "noModel";
    return null;
  }
  return cli.signedIn === false ? "signIn" : null;
}

/** The CLI a new chat preselects: the user's default if it is offered, else
 *  the backend's, else the first one that can start a chat right now. */
export function defaultCliOf(options: AssistantOptions, preferred: string | undefined): AssistantCliOption | undefined {
  const byId = (id: string | null | undefined) => options.clis.find((c) => c.id === id);
  return byId(preferred) ?? byId(options.defaultCli) ?? options.clis.find((c) => cliBlock(c, options) === null) ?? options.clis[0];
}

/** The local model a new chat preselects, from the installed ones only. */
export function defaultModelOf(options: AssistantOptions, preferred: string | undefined): string {
  const models = options.localModels;
  if (preferred && models.includes(preferred)) return preferred;
  if (options.defaultModel && models.includes(options.defaultModel)) return options.defaultModel;
  return models[0] ?? "";
}

/** The agent binary each profile runs (`AssistantCli::bin`). */
const CLI_BIN: Record<string, string> = { claude: "claude", claude_local: "claude", codex: "codex", opencode_local: "opencode" };

/** `clis` in the general agent order — the + menu's (`agent_order`, else the
 *  default agent first, then registry order), by the binary each runs; for one
 *  binary the backend's order stays (cloud before local). */
export function orderedClis(clis: readonly AssistantCliOption[], settings: Settings | null | undefined): AssistantCliOption[] {
  const defaultCmd = settings?.default_agent_cmd || "claude";
  const defaultBin = AGENT_CLI_ROWS.find((row) => row.id === defaultCmd)?.bin ?? defaultCmd;
  const order = effectiveAgentOrder(AGENT_CLI_ROWS.map((row) => row.bin), settings?.agent_order, defaultBin);
  return sortByAgentOrder(clis, (cli) => CLI_BIN[cli.id] ?? cli.id, order);
}
