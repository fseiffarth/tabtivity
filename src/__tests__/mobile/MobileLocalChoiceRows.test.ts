/**
 * The phone's ＋ sheet lists the local model's agents by the rule the desktop menus
 * use: in a Local models only project OpenCode is hidden while the network is on and
 * offered again with Cut network on (where Pi, Mistral and the other unverified
 * drivers go). The two Rust lists behind the rule are tied in `agent_privacy` tests.
 */
import { describe, expect, it } from "vitest";
import { localChoiceRows } from "../../components/mobile/localChoiceRows";
import type { LocalDriverInfo } from "../../lib/agents/localDrivers";
import type { ProjectEntry } from "../../types";

const driver = (id: string, heavy = false): LocalDriverInfo => ({
  id, label: id, available: true, needs_tools_unsupported: false, heavy_harness: heavy,
});
const drivers = [driver("opencode"), driver("pi"), driver("claude", true), driver("codex", true)];
const project = (agent_privacy?: ProjectEntry["agent_privacy"]) => ({ agent_privacy });
const keys = (p: Parameters<typeof localChoiceRows>[2]) => localChoiceRows(drivers, true, p).map((r) => r.key);

describe("the phone's local rows", () => {
  it("lists every row in a project that is not locked, OpenCode first", () => {
    expect(keys(undefined)).toEqual(["opencode", "pi", "vibe", "claude", "codex"]);
    expect(keys(project())).toEqual(["opencode", "pi", "vibe", "claude", "codex"]);
  });

  it("hides OpenCode in a Local models only project that keeps its network", () => {
    expect(keys(project({ local_models_only: true, cut_network: false }))).toEqual(["pi", "vibe", "claude", "codex"]);
  });

  it("offers OpenCode again with Cut network on, and only what was run with the network cut", () => {
    expect(keys(project({ local_models_only: true, cut_network: true }))).toEqual(["opencode", "claude", "codex"]);
  });

  it("skips Mistral where it is not installed and drivers that are not available", () => {
    const some = [{ ...driver("opencode"), available: false }, driver("pi")];
    expect(localChoiceRows(some, false, undefined).map((r) => r.key)).toEqual(["pi"]);
  });
});
