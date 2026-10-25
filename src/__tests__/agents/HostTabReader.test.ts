import { describe, expect, it } from "vitest";
import { readerOffered, readerRequest } from "../../lib/agents/agentReader";

describe("the Reader of a tab on a remote host", () => {
  const claude = { kind: "agent" as const, cmd: "claude", cwd: "/state", sessionId: "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a" };

  it("is offered for Claude only, whose transcript is copied from the host", () => {
    expect(readerOffered(claude, true)).toBe(true);
    expect(readerOffered({ kind: "agent", cmd: "codex" }, true)).toBe(false);
    expect(readerOffered({ kind: "agent", cmd: "opencode" }, true)).toBe(false);
    expect(readerOffered({ kind: "agent", cmd: "codex" })).toBe(true);
  });

  it("names the host in the read, and none for a tab that runs here", () => {
    expect(readerRequest("p1", claude, "/state", undefined, 60, undefined, undefined, "h1")?.remoteHost).toBe("h1");
    expect(readerRequest("p1", claude, "/state", undefined, 60)?.remoteHost).toBeNull();
  });
});
