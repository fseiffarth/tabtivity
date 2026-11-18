import { invoke } from "@tauri-apps/api/core";

import { refreshWorkspaceScope } from "../../stores/tabs";

/**
 * The user's dismissal of the question an agent reported for its own tab
 * (`tab_request_attention`; `docs/context/cockpit_mcp.md`). One narrow host
 * command, a compare-and-swap on the attention id the window drew: the host
 * marks that question dismissed only while it is still the tab's question.
 * Nothing is answered, approved or sent to the agent. Afterwards the scope is
 * re-read so every row and count drops it (a no-op when nothing moved).
 */
export type DismissOutcome = "dismissed" | "unchanged" | "stale" | "error";

export async function dismissAttention(scope: string, tabId: string | undefined, attentionId: string): Promise<DismissOutcome> {
  if (!tabId) return "stale";
  let outcome: DismissOutcome;
  try {
    const answer = await invoke<string>("cockpit_attention_dismiss", { scope, tabId, attentionId });
    outcome = answer === "dismissed" || answer === "unchanged" ? answer : "stale";
  } catch {
    return "error";
  }
  try {
    await refreshWorkspaceScope(scope);
  } catch {
    // The next workspace patch brings it; the write is already committed.
  }
  return outcome;
}
