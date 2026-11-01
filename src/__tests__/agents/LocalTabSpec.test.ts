import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { localLaunchTabSpec } from "../../lib/agents/localTabSpec";
import { envName } from "../../lib/brand";

function launches(cmd: string, args: string[]) {
  invoke.mockImplementation(async (name: string) => (name === "prepare_local_launch" ? { cmd, args } : undefined));
}

describe("localLaunchTabSpec", () => {
  beforeEach(() => invoke.mockReset());

  it("gives an OpenCode tab a key and its line in every scope, so it resumes", async () => {
    const args = ["--model", "ollama/qwen3:8b"];
    launches("opencode", args);
    const tab = await localLaunchTabSpec("p-without-mobile", "opencode", "OpenCode", "qwen3:8b", "/w");
    expect(tab.sessionId).toBeTruthy();
    expect(tab.env?.[envName("TAB_UID")]).toBe(tab.sessionId);
    expect(tab.localLaunch).toEqual({ driver: "opencode", model: "qwen3:8b", args });
    expect(tab.args).toEqual(args);
  });

  it("leaves another driver session-only outside a Mobile-access scope", async () => {
    launches("pi", ["--model", "m"]);
    const tab = await localLaunchTabSpec("p-without-mobile", "pi", "Pi", "m", "/w");
    expect(tab.sessionId).toBeUndefined();
    expect(tab.localLaunch).toBeUndefined();
    expect(tab.env).toEqual({ [envName("LOCAL_MODEL")]: "m" });
  });
});
