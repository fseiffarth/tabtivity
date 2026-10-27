import { describe, expect, it } from "vitest";

import { orderedClis } from "../../components/assistant/useAssistantOptions";
import type { AssistantCliOption } from "../../lib/assistant";
import type { Settings } from "../../types";

const cli = (id: string, local: boolean): AssistantCliOption => ({
  id,
  label: id,
  local,
  installed: true,
  signedIn: local ? null : true,
  ready: true,
});
// The backend's order.
const CLIS = [cli("claude", false), cli("codex", false), cli("opencode_local", true), cli("claude_local", true)];
const ids = (settings: Partial<Settings> | null) => orderedClis(CLIS, settings as Settings | null).map((c) => c.id);

describe("Tabby's CLI order", () => {
  it("follows the saved agent order by binary, cloud before local for one binary", () => {
    expect(ids({ agent_order: ["opencode", "codex", "claude"] })).toEqual(["opencode_local", "codex", "claude", "claude_local"]);
  });

  it("without a saved order puts the default agent first, then registry order", () => {
    expect(ids({ default_agent_cmd: "codex" })).toEqual(["codex", "claude", "claude_local", "opencode_local"]);
    expect(ids(null)).toEqual(["claude", "claude_local", "codex", "opencode_local"]);
  });
});
