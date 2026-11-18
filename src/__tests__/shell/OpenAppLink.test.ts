import { beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ setActive: vi.fn(), jump: vi.fn(), projects: [{ id: "project-one" }], tabs: [{ key: "tab-one" }] }));
vi.mock("../../stores/projects", () => ({ useProjectsStore: { getState: () => ({ projects: state.projects, setActive: state.setActive }) } }));
vi.mock("../../stores/tabs", () => ({ useTabsStore: { getState: () => ({ scope: "project-one", tabs: state.tabs, tabsByScope: { "project-two": [{ key: "tab-two" }] } }) } }));
vi.mock("../../lib/shortcuts/tabJump", () => ({ jumpToTab: state.jump }));
vi.mock("../../lib/voice/desktopVoice", () => ({ voiceInputOffered: () => false }));
import { openAppLink } from "../../lib/navigation/openAppLink";

beforeEach(() => vi.clearAllMocks());
describe("app link navigation", () => {
  it("reveals the token setting without changing settings", async () => {
    const listener = vi.fn();
    window.addEventListener("app:open-settings", listener);
    try {
      expect(await openAppLink({ kind: "settings", page: "git", setting: "access-token" })).toBe(true);
      expect(listener.mock.calls[0][0].detail).toMatchObject({ panel: "git", reveal: { path: ["Access token"] } });
    } finally { window.removeEventListener("app:open-settings", listener); }
    expect(state.setActive).not.toHaveBeenCalled();
    expect(state.jump).not.toHaveBeenCalled();
  });
  it("rejects missing projects and tabs without navigation", async () => {
    expect(await openAppLink({ kind: "project", id: "missing" })).toBe(false);
    expect(await openAppLink({ kind: "tab", scope: "project-two", id: "tab-one" })).toBe(false);
    expect(state.setActive).not.toHaveBeenCalled();
    expect(state.jump).not.toHaveBeenCalled();
  });
  it("uses existing project and cross-scope tab navigation", async () => {
    expect(await openAppLink({ kind: "project", id: "project-one" })).toBe(true);
    expect(state.setActive).toHaveBeenCalledWith("project-one");
    expect(await openAppLink({ kind: "tab", scope: "project-two", id: "tab-two" })).toBe(true);
    expect(state.jump).toHaveBeenCalledWith("project-two", "tab-two");
  });
  it("rejects unavailable settings pages", async () => {
    expect(await openAppLink({ kind: "settings", page: "unknown" })).toBe(false);
    expect(await openAppLink({ kind: "settings", page: "voice" })).toBe(false);
  });
});
