/**
 * The empty subwindow's starts: each makes the request its chord makes, the
 * keys are the live ones, and the last agent closed here comes back from a line.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const { reopen } = vi.hoisted(() => ({ reopen: vi.fn() }));
vi.mock("../../stores/agents/closedAgentTabs", () => ({
  useClosedAgentTabs: (scope: string) =>
    scope === "with-last" ? [{ id: "c1", tab: { label: "Claude refactor" } }] : [],
  reopenClosedAgentTab: reopen,
}));

import { StartHere } from "../../components/layout/StartHere";
import { NEW_TAB_SHORTCUT_EVENT, type NewTabShortcutDetail } from "../../lib/shortcuts/newTabChord";
import { useSettingsStore } from "../../stores/settings";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function capture(accept: boolean) {
  const requests: NewTabShortcutDetail["request"][] = [];
  const onRequest = (event: Event) => {
    requests.push((event as CustomEvent<NewTabShortcutDetail>).detail.request);
    if (accept) event.preventDefault();
  };
  window.addEventListener(NEW_TAB_SHORTCUT_EVENT, onRequest);
  return { requests, stop: () => window.removeEventListener(NEW_TAB_SHORTCUT_EVENT, onRequest) };
}

describe("StartHere", () => {
  it("opens the first agent, or the + menu when no agent is behind it", () => {
    const bar = capture(false);
    render(<StartHere scope="p" groupId="g" />);
    fireEvent.click(screen.getByRole("button", { name: /New agent/ }));
    expect(bar.requests).toEqual([{ kind: "agent", slot: 0 }, { kind: "menu" }]);
    bar.stop();
  });

  it("opens a shell through the same request as its chord", () => {
    const bar = capture(true);
    render(<StartHere scope="p" groupId="g" />);
    fireEvent.click(screen.getByRole("button", { name: /New shell/ }));
    expect(bar.requests).toEqual([{ kind: "shell" }]);
    bar.stop();
  });

  it("opens the palette on the file filter", () => {
    const onOpen = vi.fn();
    window.addEventListener("app:open-palette", onOpen);
    render(<StartHere scope="p" groupId="g" />);
    fireEvent.click(screen.getByRole("button", { name: /Open a file/ }));
    expect((onOpen.mock.calls[0][0] as CustomEvent).detail).toEqual({ filter: "#" });
    window.removeEventListener("app:open-palette", onOpen);
  });

  it("shows a rebound key, and none for an unbound one", () => {
    useSettingsStore.setState({
      settings: { keyboard_shortcuts: { newShellTab: { key: "" } } } as never,
    } as never);
    render(<StartHere scope="p" groupId="g" />);
    expect(screen.getByRole("button", { name: /New shell/ }).querySelector("kbd")).toBeNull();
  });

  it("offers the last agent closed here, and only then", () => {
    render(<StartHere scope="with-last" groupId="g" />);
    fireEvent.click(screen.getByRole("button", { name: /Last time here: Claude refactor/ }));
    expect(reopen).toHaveBeenCalledWith("with-last", "c1");
    cleanup();
    render(<StartHere scope="p" groupId="g" />);
    expect(screen.queryByRole("button", { name: /Last time here/ })).toBeNull();
  });
});
