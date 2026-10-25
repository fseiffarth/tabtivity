/**
 * The half-typed line of a pane dies with its tab: a PTY id that comes round
 * again must not inherit it, or "/cle" left in the closed tab plus "ar⏎" typed
 * in the next one reads as a `/clear`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/api/event", () => ({ emit: vi.fn(() => Promise.resolve()), listen: vi.fn() }));

import { noteTypedLine } from "../../lib/agents/typedClear";
import { useTabsStore } from "../../stores/tabs";

function seed() {
  useTabsStore.setState({
    scope: "p",
    tabsByScope: {},
    layoutByScope: {},
    detachedGroupsByScope: {},
    focusedGroupByScope: {},
    tabs: [],
    layout: null,
    focusedGroupId: null,
    activeKey: null,
  });
}

describe("typed line", () => {
  beforeEach(seed);

  it("is forgotten when the tab closes (removeTab, removeTabInScope)", () => {
    for (const close of [
      (key: string) => useTabsStore.getState().removeTab(key),
      (key: string) => useTabsStore.getState().removeTabInScope("p", key),
    ]) {
      const tab = useTabsStore.getState().addTab({ cmd: "claude", cwd: "/p", kind: "agent", label: "a" });
      const id = `p:${tab.key}`;
      noteTypedLine(id, "/cle");
      close(tab.key);
      expect(noteTypedLine(id, "ar\r")).toBe(false);
    }
  });

  it("keeps the line across ordinary input, so the check above is meaningful", () => {
    noteTypedLine("p:x", "/cle");
    expect(noteTypedLine("p:x", "ar\r")).toBe(true);
  });

  it("treats a pty id named like an Object.prototype member as a plain id", () => {
    expect(noteTypedLine("toString", "/clear\r")).toBe(true);
    expect(noteTypedLine("__proto__", "/clear\r")).toBe(true);
    expect(noteTypedLine("constructor", "/cle")).toBe(false);
    expect(noteTypedLine("constructor", "ar\r")).toBe(true);
  });
});
