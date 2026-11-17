// The release workflow lists the agent CLI releases a build was verified
// against by reading `agent_versions::VERIFIED` as text. These hold that read
// to the real table, so a reshaped table fails here, not in a release.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { cliNotes, registryLabels, verifiedRows } from "./release-cli-notes.mjs";

// vitest runs from the repo root.
const source = (path) => readFileSync(path, "utf8");
const VERSIONS = source("src-tauri/src/services/agent/agent_versions.rs");
const REGISTRY = source("src-tauri/src/services/agent/agent_registry.rs");

describe("release-cli-notes", () => {
  it("reads every VERIFIED row of the real table, with registry labels", () => {
    const rows = verifiedRows(VERSIONS);
    expect(rows.length).toBeGreaterThanOrEqual(3);
    const labels = registryLabels(REGISTRY);
    for (const row of rows) {
      expect(row.version).toMatch(/^\d+(\.\d+)+/);
      expect(row.surface).not.toMatch(/^§/);
      expect(labels.has(row.agent), `${row.agent} has no registry label`).toBe(true);
    }
  });

  it("prints one line per agent and release, through the command the workflow runs", () => {
    const run = spawnSync("node", ["scripts/release-cli-notes.mjs"], { encoding: "utf8" });
    expect(run.status, run.stderr).toBe(0);
    const lines = run.stdout.split("\n").filter((line) => line.startsWith("- "));
    const releases = new Set(verifiedRows(VERSIONS).map((row) => `${row.agent} ${row.version}`));
    expect(lines).toHaveLength(releases.size);
  });

  it("groups surfaces checked at one release and keeps differing releases apart", () => {
    const notes = cliNotes(
      [
        { agent: "codex", version: "0.2.0", surface: "approval rows" },
        { agent: "codex", version: "0.2.0", surface: "/model sheet" },
        { agent: "codex", version: "0.1.0", surface: "writer lock" },
      ],
      new Map([["codex", "Codex"]]),
    );
    expect(notes).toContain("- Codex 0.2.0 — approval rows; /model sheet\n");
    expect(notes).toContain("- Codex 0.1.0 — writer lock\n");
  });

  it("refuses a table it can only partly read instead of shortening the list", () => {
    const table = `const VERIFIED: &[Verified] = &[
    Verified {
        agent: "claude",
        version: "2.1.0",
        surface: "§1.1 — hooks",
    },
    Verified {
        agent: "codex",
        version: VERSION_CONST,
        surface: "§1.2 — lamp",
    },
];`;
    expect(() => verifiedRows(table)).toThrow(/read 1 of 2/);
    expect(() => verifiedRows("const OTHER: &[u8] = &[];")).toThrow(/no VERIFIED table/);
  });
});
