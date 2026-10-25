/**
 * The phone's catalog applies the window's tab-locality rule in Rust
 * (`discovery::tab_is_local`): a remote or VM project lists only the tabs that
 * are local. Both sides read this one table, so the two cannot drift; the Rust
 * twin is `the_tab_locality_rule_matches_the_windows_table`.
 */
import { describe, it, expect } from "vitest";
import { effectiveTabLocation, type TabKind, type TabLocation } from "../../stores/tabs";
import table from "./tabLocality.fixture.json";

describe("tab locality table shared with the phone catalog", () => {
  for (const row of table) {
    const name = `${row.kind} ${row.location ?? "(no location)"}${row.vm ? " in a VM project" : ""}`;
    it(`${name} is ${row.local ? "local" : "not local"}`, () => {
      const tab = { kind: row.kind as TabKind, ...(row.location ? { location: row.location as TabLocation } : {}) };
      expect(effectiveTabLocation(tab, { vmProject: row.vm }) === "local").toBe(row.local);
    });
  }
});
