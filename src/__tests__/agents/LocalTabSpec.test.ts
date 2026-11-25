import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { localLaunchTabSpec } from "../../lib/agents/localTabSpec";
import { envName } from "../../lib/brand";
import { readerAgent, readerOffered } from "../../lib/agents/agentReader";
import { resumeArgsOf } from "../../stores/tabs/tabKinds";

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

  it("hands a Claude Code tab's key on behind the launcher, never into its saved line", async () => {
    const line = ["launch", "claude", "--model", "qwen3:8b"];
    launches("ollama", line);
    const tab = await localLaunchTabSpec("p-without-mobile", "claude", "Claude Code", "qwen3:8b", "/w");
    expect(tab.sessionId).toBeTruthy();
    expect(tab.args).toEqual([...line, "--", "--session-id", tab.sessionId]);
    expect(tab.env?.[envName("TAB_UID")]).toBe(tab.sessionId);
    expect(tab.localLaunch).toEqual({ driver: "claude", model: "qwen3:8b", args: line });
    // A restore rebuilds the same line from the key, and the Reader reads it as Claude.
    const restored = { ...tab, key: "k" };
    expect(resumeArgsOf(restored)).toEqual(tab.args);
    expect(readerAgent(restored)).toBe("claude");
    expect(readerOffered(restored)).toBe(true);
    // One opened before it had a key reads nothing.
    expect(readerOffered({ ...restored, sessionId: undefined })).toBe(false);
  });

  it("gives a Codex launcher line no key", async () => {
    launches("ollama", ["launch", "codex", "--model", "m"]);
    const tab = await localLaunchTabSpec("p-without-mobile", "codex", "Codex", "m", "/w");
    expect(tab.sessionId).toBeUndefined();
    expect(tab.args).toEqual(["launch", "codex", "--model", "m"]);
    expect(readerOffered(tab)).toBe(false);
  });

  it("leaves another driver session-only outside a Mobile-access scope", async () => {
    launches("pi", ["--model", "m"]);
    const tab = await localLaunchTabSpec("p-without-mobile", "pi", "Pi", "m", "/w");
    expect(tab.sessionId).toBeUndefined();
    expect(tab.localLaunch).toBeUndefined();
    expect(tab.env).toEqual({ [envName("LOCAL_MODEL")]: "m" });
  });
});
