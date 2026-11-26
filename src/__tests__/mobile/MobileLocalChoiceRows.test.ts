/**
 * The phone's ＋ sheet lists the local model's agents by the rule the desktop menus
 * use: in a Local models only project OpenCode is offered while the network is on only
 * where the host can cut its own sandbox's network (Linux), and with Cut network on
 * (where Pi, Mistral and the other unverified drivers go). The two Rust lists behind
 * the rule are tied in `agent_privacy` tests.
 */
import { describe, expect, it, vi } from "vitest";

const host = vi.hoisted(() => ({ linux: true }));
vi.mock("../../lib/platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/platform")>()),
  get IS_HOST_LINUX() {
    return host.linux;
  },
}));
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

  it("offers OpenCode in a Local models only project that keeps its network only where the host can cut", () => {
    const locked = project({ local_models_only: true, cut_network: false });
    expect(keys(locked)).toEqual(["opencode", "pi", "vibe", "claude", "codex"]);
    host.linux = false;
    try {
      expect(keys(locked)).toEqual(["pi", "vibe", "claude", "codex"]);
    } finally {
      host.linux = true;
    }
  });

  it("offers OpenCode again with Cut network on, and only what was run with the network cut", () => {
    expect(keys(project({ local_models_only: true, cut_network: true }))).toEqual(["opencode", "claude", "codex"]);
  });

  it("skips Mistral where it is not installed and drivers that are not available", () => {
    const some = [{ ...driver("opencode"), available: false }, driver("pi")];
    expect(localChoiceRows(some, false, undefined).map((r) => r.key)).toEqual(["pi"]);
  });
});
