import { useHostKeyPromptStore } from "../../stores/remote/hostKeyPrompt";
import { envName } from "../brand";

/**
 * First-contact host-key confirmation, from the caller's side.
 *
 * The backend refuses to release a password to a host whose SSH key has never
 * been accepted here, failing with an error that carries `UNKNOWN_HOST_KEY` and
 * the resolved target (`services::ssh_common::guard_first_contact`). Everything
 * needed to recover is *in that error*, so a connect opts in by wrapping itself
 * in `withHostKeyConfirm` — no call site has to know or re-derive which host it
 * was talking to.
 *
 * Deliberately not applied to background/launch paths (auto-connect, sync): those
 * promise never to prompt, so they simply stay disconnected until the user
 * connects by hand and answers this. That is the intended outcome, not a gap.
 */

/** Must match `services::ssh_common::UNKNOWN_HOST_KEY`. */
export const UNKNOWN_HOST_KEY = envName("UNKNOWN_HOST_KEY");

/**
 * The `host:port` an unknown-host-key failure names, or `null` if `e` is any
 * other error. Tolerates the error being a string, an `Error`, or a Tauri
 * rejection value.
 */
export function unknownHostKeyTarget(e: unknown): string | null {
  const text = e instanceof Error ? e.message : String(e);
  const at = text.indexOf(UNKNOWN_HOST_KEY);
  if (at < 0) return null;
  const target = text.slice(at + UNKNOWN_HOST_KEY.length).trim().split(/\s+/)[0];
  return target || null;
}

/**
 * Run `attempt`; if it failed only because the host key has never been accepted,
 * show the fingerprint, and retry once if the user accepts it. Any other failure
 * — and a declined fingerprint — propagates unchanged, so a caller's existing
 * error handling is untouched.
 *
 * `attempt` is invoked at most twice and must therefore be safe to repeat, which
 * every connect call is (the first one authenticated nothing).
 */
export async function withHostKeyConfirm<T>(attempt: () => Promise<T>): Promise<T> {
  try {
    return await attempt();
  } catch (e) {
    const target = unknownHostKeyTarget(e);
    if (!target) throw e;
    const trusted = await useHostKeyPromptStore.getState().request(target);
    // Declining is a decision, not an error to paper over: re-throw the original
    // so the caller's lamp/message reflects that the connect did not happen.
    if (!trusted) throw e;
    return await attempt();
  }
}
