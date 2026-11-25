import { AGENT_CLI_ROWS } from "./agentClis";
import type { UntestedId } from "../untested";

/**
 * The built-in CLIs nobody has run `verify-cli` against: no row in the
 * backend's `agent_versions::VERIFIED` (`docs/third_party_update_checklist.md`).
 * Each wears its own untested pill on its "+" menu row, its Manage CLIs card
 * and its phone new-tab row, so stamping one CLI tested clears only that one.
 *
 * Keyed by registry id. A CLI that gets its first VERIFIED row leaves this
 * table (and its register row) in the same change —
 * `src/__tests__/agents/UnverifiedClis.test.ts` fails until it does.
 */
const UNVERIFIED: Readonly<Record<string, { untested: UntestedId }>> = {
  gemini: { untested: "agents.cli.gemini" },
  kiro: { untested: "agents.cli.kiro" },
  cline: { untested: "agents.cli.cline" },
  aider: { untested: "agents.cli.aider" },
  droid: { untested: "agents.cli.droid" },
  grok: { untested: "agents.cli.grok" },
  qwen: { untested: "agents.cli.qwen" },
  openclaw: { untested: "agents.cli.openclaw" },
  auggie: { untested: "agents.cli.auggie" },
  kilo: { untested: "agents.cli.kilo" },
  continue: { untested: "agents.cli.continue" },
  junie: { untested: "agents.cli.junie" },
  codebuddy: { untested: "agents.cli.codebuddy" },
  goose: { untested: "agents.cli.goose" },
  pi: { untested: "agents.cli.pi" },
  plandex: { untested: "agents.cli.plandex" },
  "swe-agent": { untested: "agents.cli.swe-agent" },
  "mini-swe-agent": { untested: "agents.cli.mini-swe-agent" },
  crush: { untested: "agents.cli.crush" },
  amp: { untested: "agents.cli.amp" },
  kimi: { untested: "agents.cli.kimi" },
  qoder: { untested: "agents.cli.qoder" },
};

/** The registry ids in the table, for its consistency test. */
export const UNVERIFIED_CLI_IDS: readonly string[] = Object.keys(UNVERIFIED);

/** The pill id of a built-in CLI by registry id; `undefined` once verified. */
export function unverifiedCliTag(id: string): UntestedId | undefined {
  return Object.prototype.hasOwnProperty.call(UNVERIFIED, id) ? UNVERIFIED[id].untested : undefined;
}

/** The same by the label the registry gives it — the phone's agent rows carry
 *  an opaque id and the label only (`mobile_control` keeps raw ids off it). */
export function unverifiedCliTagByLabel(label: string): UntestedId | undefined {
  const row = AGENT_CLI_ROWS.find((r) => r.label === label);
  return row ? unverifiedCliTag(row.id) : undefined;
}
