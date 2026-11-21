import { describe, expect, it } from "vitest";
import { readerOffered, readerReasonKey, readerRequest } from "../../lib/agents/agentReader";

describe("the Reader of a tab on a remote host", () => {
  const claude = { kind: "agent" as const, cmd: "claude", cwd: "/state", sessionId: "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a" };

  it("is offered for the CLIs whose conversation is copied from the host", () => {
    expect(readerOffered(claude, true)).toBe(true);
    expect(readerOffered({ kind: "agent", cmd: "codex" }, true)).toBe(true);
    expect(readerOffered({ kind: "agent", cmd: "codex" })).toBe(true);
    expect(readerOffered({ kind: "agent", cmd: "agy" }, true)).toBe(true);
    expect(readerOffered({ kind: "agent", cmd: "muse" }, true)).toBe(true);
    expect(readerOffered({ kind: "agent", cmd: "copilot" }, true)).toBe(true);
    expect(readerOffered({ kind: "agent", cmd: "opencode" }, true)).toBe(true);
    expect(readerOffered({ kind: "agent", cmd: "vibe" }, true)).toBe(false);
  });

  it("names the host in a Codex tab's read, by its launch id", () => {
    const codex = { ...claude, cmd: "codex" };
    expect(readerRequest("p1", codex, "/state", undefined, 60, undefined, undefined, "h1")).toMatchObject({
      agent: "codex", sessionId: codex.sessionId, remoteHost: "h1",
    });
  });

  it("names the host in the read, and none for a tab that runs here", () => {
    expect(readerRequest("p1", claude, "/state", undefined, 60, undefined, undefined, "h1")?.remoteHost).toBe("h1");
    expect(readerRequest("p1", claude, "/state", undefined, 60)?.remoteHost).toBeNull();
  });

  it("says a host store's first copy is still running", () => {
    expect(readerReasonKey({ available: false, reason: "syncing", entries: [], truncated: false })).toBe("terminal.reader.syncing");
  });
});
