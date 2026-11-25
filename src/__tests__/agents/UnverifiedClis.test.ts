// The unverified-CLI pills (`lib/agents/unverifiedClis`) must say exactly what
// the backend's verification table says: a CLI with a `VERIFIED` row in
// `agent_versions.rs` has been through `verify-cli` and loses its pill; every
// other registry CLI keeps one.
import { describe, expect, it } from "vitest";
// @ts-expect-error node:fs has no type declarations in this project (no @types/node)
import { readFileSync } from "node:fs";
import { AGENT_CLI_ROWS } from "../../lib/agents/agentClis";
import { UNVERIFIED_CLI_IDS, unverifiedCliTag, unverifiedCliTagByLabel } from "../../lib/agents/unverifiedClis";
import { AGENT_ITEMS } from "../../lib/tabs/newTabItems";

function verifiedAgents(): Set<string> {
  const src: string = readFileSync("src-tauri/src/services/agent/agent_versions.rs", "utf8");
  const table = src.slice(src.indexOf("const VERIFIED: &[Verified] = &["));
  const body = table.slice(0, table.indexOf("\n];"));
  return new Set([...body.matchAll(/agent:\s*"([^"]+)"/g)].map((m) => m[1]));
}

describe("unverified CLI pills", () => {
  it("tag exactly the registry CLIs with no VERIFIED row", () => {
    const verified = verifiedAgents();
    expect(verified.size, "the VERIFIED table did not parse").toBeGreaterThan(3);
    const expected = AGENT_CLI_ROWS.map((r) => r.id).filter((id) => !verified.has(id)).sort();
    expect([...UNVERIFIED_CLI_IDS].sort()).toEqual(expected);
  });

  it("gives each CLI its own register id", () => {
    for (const id of UNVERIFIED_CLI_IDS) expect(unverifiedCliTag(id)).toBe(`agents.cli.${id}`);
    expect(unverifiedCliTag("claude")).toBeUndefined();
    expect(unverifiedCliTag("constructor")).toBeUndefined();
  });

  it("reaches the + menu items and the phone's label lookup", () => {
    expect(AGENT_ITEMS.find((i) => i.cmd === "gemini")?.untested).toBe("agents.cli.gemini");
    expect(AGENT_ITEMS.find((i) => i.cmd === "claude")?.untested).toBeUndefined();
    expect(unverifiedCliTagByLabel("Continue.dev")).toBe("agents.cli.continue");
    expect(unverifiedCliTagByLabel("Codex")).toBeUndefined();
  });
});
