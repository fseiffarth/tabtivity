import { describe, expect, it } from "vitest";
import { lastPrompt, promptLines, promptsFromTranscript } from "../../../mobile-web/src/agentPrompts";
import type { TabRow } from "../../../mobile-web/src/api";
import { BRAND } from "../../lib/brand";

const tab = (over: Partial<TabRow>): TabRow => ({
  id: "t", label: "claude", kind: "agent", available: true, viewer_busy: false,
  prompts: [{ text: "first", at: "2026-09-19T10:00:00Z" }, { text: "second", at: "2026-09-19T11:00:00Z" }],
  ...over,
});

describe(`${BRAND.display} Mobile last prompts on a tab card`, () => {
  it("lists the newest first", () => {
    expect(promptLines(tab({ agent_label: "Codex" })).map((p) => p.text)).toEqual(["second", "first"]);
    expect(lastPrompt(tab({ agent_label: "Codex" }))?.text).toBe("second");
  });

  it(`knows OpenCode's list is only what ${BRAND.display} sent`, () => {
    expect(promptsFromTranscript(tab({ label: "build", agent_label: "OpenCode" }))).toBe(false);
    expect(promptsFromTranscript(tab({ label: "opencode 2" }))).toBe(false);
    expect(promptsFromTranscript(tab({ agent_label: "Claude Code" }))).toBe(true);
    // Whatever the desktop sends is shown: for OpenCode that is the history.
    expect(promptLines(tab({ agent_label: "OpenCode" })).map((p) => p.text)).toEqual(["second", "first"]);
  });
});
