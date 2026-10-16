import { useCallback, useEffect, useRef, useState } from "react";
import {
  assistantErrorCode,
  assistantOptions,
  type AssistantCliOption,
  type AssistantOptions,
} from "../../lib/assistant";
import { usePoll } from "../../lib/usePoll";

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
