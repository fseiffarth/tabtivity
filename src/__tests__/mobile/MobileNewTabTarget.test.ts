/**
 * The ＋'s tap starts what the sheet's ★ chose: an agent, an agent on the API
 * key, or a local-model row — and falls back to the desktop's default when the
 * starred agent is gone.
 */
import { describe, expect, it } from "vitest";

import { apiTarget, localTarget, newTabTarget } from "../../../mobile-web/src/newTabDefault";

const agents = [
  { id: "claude", label: "Claude", modes: [] },
  { id: "codex", label: "Codex", modes: [], default: true },
];

describe("newTabTarget", () => {
  it("starts the starred agent plainly", () => {
    expect(newTabTarget(agents, "claude", "")).toMatchObject({ key: "claude", kind: "agent", agent: agents[0] });
    expect(newTabTarget(agents, "claude", "")?.launch).toBeUndefined();
  });

  it("starts a starred API row on the key", () => {
    expect(newTabTarget(agents, apiTarget("claude"), "")).toMatchObject({
      key: "api:claude",
      kind: "api",
      agent: agents[0],
      launch: { api_key: true },
    });
  });

  it("starts a starred local row by its launch id and keeps the stored name", () => {
    expect(newTabTarget(agents, localTarget("abc"), "Claude · llama3")).toEqual({
      key: "local:abc",
      kind: "local",
      launch: { local: "abc" },
      label: "Claude · llama3",
    });
  });

  it("falls back to the desktop's default when the starred agent is gone", () => {
    expect(newTabTarget(agents, "gone", "")?.agent).toBe(agents[1]);
    expect(newTabTarget(agents, apiTarget("gone"), "")).toMatchObject({ key: "codex", kind: "agent" });
    expect(newTabTarget([], "claude", "")).toBeUndefined();
  });
});
