/**
 * The metric keys of `usage_stats.json`, and how a tab maps onto them.
 *
 * Mirrors `schema::usage_stats::metric` (src-tauri) — keep the two in step. The
 * key space is namespaced with `.` and deliberately open-ended: the trailing
 * segment of an agent key is the agent's command (`claude`, `codex`) or a local
 * model name (`qwen3:8b`), neither of which is a closed set.
 */

// Type-only, so this stays free of a runtime import cycle: `tabs.ts` imports
// *this* module to count tab opens.
import type { TabKind } from "../stores/tabs";
import { envName } from "./brand";

export const METRIC = {
  /** `autocomplete.accept/dismiss.<mode>.<model>` — one outcome per suggestion. */
  AUTOCOMPLETE_ACCEPT: "autocomplete.accept",
  AUTOCOMPLETE_DISMISS: "autocomplete.dismiss",
  /** `agent.tab.<cmd>` — an agent tab was opened. */
  AGENT_TAB: "agent.tab",
  /** `agent.tab.local.<model>` — a local (Ollama-backed) agent tab was opened. */
  AGENT_TAB_LOCAL: "agent.tab.local",
  /** `agent.active.<cmd>` — distinct agent tabs that received ≥1 prompt that day. */
  AGENT_ACTIVE: "agent.active",
  /** `agent.prompt.<cmd>` — prompts submitted to an agent. */
  AGENT_PROMPT: "agent.prompt",
  /** Seconds agent tabs spent actually working. */
  AGENT_WORKED_S: "agent.worked_s",
  /** Times an agent stopped to ask you a decision. */
  AGENT_DECISION: "agent.decision",
  /** Times an agent finished a turn. */
  AGENT_DONE: "agent.done",
  /** Commands run in a shell tab. */
  SHELL_COMMAND: "shell.command",
  FILE_CREATED: "file.created",
  FILE_MODIFIED: "file.modified",
  FILE_DELETED: "file.deleted",
  TAB_OPENED: "tab.opened",
  TAB_CLOSED: "tab.closed",
  APP_LAUNCHED: "app.launched",
  // `tokens.<kind>.<cli>.<model>` — agent tokens, derived backend-side from the
  // CLIs' own records (`usage_token_stats`), never counted by the frontend.
  // `<model>` is everything after the third `.`: model names contain dots.
  /** Fresh input, not counting cache reads or writes. */
  TOKENS_IN: "tokens.in",
  /** Input written to the prompt cache. */
  TOKENS_CACHE_W: "tokens.cache_w",
  /** Input read back from the prompt cache. */
  TOKENS_CACHE_R: "tokens.cache_r",
  /** Output, thinking/reasoning included. */
  TOKENS_OUT: "tokens.out",
  /** A total with no split — only Codex's SQLite fallback reports one. */
  TOKENS_TOTAL: "tokens.total",
} as const;

/** Compose `agent.prompt` + `claude` → `agent.prompt.claude`. */
export function sub(prefix: string, leaf: string): string {
  return `${prefix}.${leaf}`;
}

/**
 * What an agent tab should be counted as: its agent command for a cloud agent
 * (`claude`), or the model name for a local one (`qwen3:8b`).
 *
 * A `local_agent` tab's model is not a field on the tab — it is carried in the
 * env Tabtivity sets when spawning it (`TABTIVITY_LOCAL_MODEL`, set at both local-model
 * launch routes in `TabBar`/`NewTabMenu`), with `VIBE_ACTIVE_MODEL` as the
 * fallback for the vibe route. Returns `null` for a tab that is not an agent.
 *
 * `kind === "agent"` is itself the test for "this cmd is a known agent" —
 * `cmdToKind` only assigns that kind to a cmd in its `AGENT_CMDS` set — so there
 * is no second registry to keep in step here.
 */
export function agentMetricLeaf(tab: {
  kind: TabKind;
  cmd: string;
  env?: Record<string, string>;
}): { prefix: string; leaf: string } | null {
  if (tab.kind === "local_agent") {
    const model = tab.env?.[envName("LOCAL_MODEL")] || tab.env?.VIBE_ACTIVE_MODEL;
    // A local agent tab with no recorded model would otherwise be filed under an
    // empty key; count it under its driving command instead of inventing one.
    if (model) return { prefix: METRIC.AGENT_TAB_LOCAL, leaf: model };
    return { prefix: METRIC.AGENT_TAB, leaf: tab.cmd };
  }
  if (tab.kind === "agent" && tab.cmd) {
    return { prefix: METRIC.AGENT_TAB, leaf: tab.cmd };
  }
  return null;
}

/**
 * The leaf an agent tab's *prompts* are counted under — the same identity as
 * {@link agentMetricLeaf}, flattened to a single string so `agent.prompt.<leaf>`
 * and `agent.active.<leaf>` line up with the tab counts. A local model's leaf is
 * prefixed `local.` so it stays distinguishable from a cloud agent of the same
 * name.
 */
export function agentPromptLeaf(tab: {
  kind: TabKind;
  cmd: string;
  env?: Record<string, string>;
}): string | null {
  const id = agentMetricLeaf(tab);
  if (!id) return null;
  return id.prefix === METRIC.AGENT_TAB_LOCAL ? `local.${id.leaf}` : id.leaf;
}

/** Human labels for the well-known agent commands; unknown leaves render as-is. */
const AGENT_LABELS: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  gemini: "Google Gemini",
  agy: "Google Antigravity",
  vibe: "Mistral",
  // Kiro's executable was renamed `kiro-cli`; the old leaf stays so
  // counters written before the rename still decode.
  "kiro-cli": "Kiro",
  kiro: "Kiro",
  cline: "Cline",
  aider: "Aider",
  opencode: "OpenCode",
  "cursor-agent": "Cursor",
  copilot: "Copilot",
  grok: "Grok",
  qwen: "Qwen",
  openclaw: "OpenClaw",
  goose: "Goose",
  openhands: "OpenHands",
  pi: "Pi",
  plandex: "Plandex",
  sweagent: "SWE-agent",
  mini: "mini-SWE-agent",
  mentat: "Mentat",
  gpte: "GPT Engineer",
  droid: "Droid",
  auggie: "Auggie",
  kilo: "Kilo Code",
  cn: "Continue.dev",
  junie: "JetBrains Junie",
  codebuddy: "CodeBuddy",
  crush: "Crush",
  amp: "Amp",
  kimi: "Kimi Code",
  qoder: "Qoder",
  muse: "Meta Muse Code",
};

/** Display name for a metric leaf (`claude` → "Claude", `local.qwen3:8b` → "qwen3:8b"). */
export function agentLabel(leaf: string): string {
  if (leaf.startsWith("local.")) return leaf.slice("local.".length);
  return AGENT_LABELS[leaf] ?? leaf;
}
