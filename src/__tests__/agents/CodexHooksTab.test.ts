/**
 * The one-click fix for Codex's hook trust gate.
 *
 * Codex refuses to run Tabtivity's SessionStart hook until the user enables it in
 * Codex's own `/hooks` list, and until then Codex tabs resume off a heuristic
 * fallback rather than the exact recorded session. Per Tabtivity's install-via-tab
 * policy, the remedy must be a click that *opens Codex on that list* — never a
 * command handed to the user to run themselves. See lib/agents/codexHooks.ts.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));

import { codexHookNeedsTrust, openCodexHooksTab } from "../../lib/agents/codexHooks";
import { useTabsStore } from "../../stores/tabs";
import { useProjectsStore } from "../../stores/projects";
import { BRAND, envName } from "../../lib/brand";

describe("codexHookNeedsTrust", () => {
  it("flags only the states in which Codex won't run the hook", () => {
    expect(codexHookNeedsTrust("untrusted")).toBe(true);
    expect(codexHookNeedsTrust("disabled")).toBe(true);
    // Working, Codex not installed, or not probed yet → nothing to nag about.
    expect(codexHookNeedsTrust("enabled")).toBe(false);
    expect(codexHookNeedsTrust("no_codex")).toBe(false);
    expect(codexHookNeedsTrust("not_registered")).toBe(false);
    expect(codexHookNeedsTrust(null)).toBe(false);
  });
});

describe("openCodexHooksTab", () => {
  beforeEach(() => {
    useTabsStore.setState({ tabsByScope: {} });
    useProjectsStore.setState({ rootDir: `/home/u/${BRAND.slug}/root`, activeId: "p1" });
  });

  it("opens a real Codex tab in the root scope, already on /hooks", () => {
    openCodexHooksTab();

    // Root scope: the hook is machine-global (~/.codex/config.toml), not a
    // per-project setting — and the user's active project stays put.
    const root = useTabsStore.getState().tabsByScope["root"] ?? [];
    expect(root).toHaveLength(1);
    expect(useProjectsStore.getState().activeId).toBe("p1");

    const tab = root[0];
    expect(tab.cmd).toBe("codex");
    expect(tab.kind).toBe("agent");
    expect(tab.cwd).toBe(`/home/u/${BRAND.slug}/root`);
    // TerminalView types + submits this once Codex is up, so the user lands in
    // the hooks list rather than being told to type it.
    expect(tab.initialInput).toBe("/hooks");
  });

  it("is an ordinary tracked Codex tab, not a special case", () => {
    openCodexHooksTab();
    const tab = (useTabsStore.getState().tabsByScope["root"] ?? [])[0];

    // Built through buildStaticTabSpec, so it mints a session key like any other
    // Codex tab: it is itself resumable, and the binder can follow it.
    expect(tab.sessionId).toBeTruthy();
    expect(tab.env?.[envName("TAB_UID")]).toBe(tab.sessionId);
    // Codex mints its own session id, so nothing is passed on the command line.
    expect(tab.args ?? []).toEqual([]);
  });

  it("points the user at where it opened it", () => {
    openCodexHooksTab();
    expect(useProjectsStore.getState().switchToast).toMatch(/root terminal/i);
  });
});
