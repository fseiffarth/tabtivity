/**
 * Regression coverage for popout scope/failure, native slider handoff and
 * dedicated cockpit steering through the global capture handler.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { act, cleanup, render } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    isFullscreen: vi.fn().mockResolvedValue(false),
    setFullscreen: vi.fn(),
  }),
}));

import { invoke } from "@tauri-apps/api/core";
import { registerCockpitRoster } from "../../lib/shortcuts/steeringCockpit";
import { useRootOverlayStore } from "../../stores/rootOverlay";
import type { DetachedGroup } from "../../stores/tabs/types";
import { ROOT_SCOPE } from "../../stores/tabs";
import { focusNextPopout } from "../../lib/window/focusPopout";
import { useKeyboard } from "../../hooks/useKeyboard";
import { useKeyboardSteeringStore } from "../../stores/keyboardSteering";
import { useHeaderHoverMenuStore } from "../../stores/headerHoverMenu";
import { useTabsStore } from "../../stores/tabs";
import { useSettingsStore } from "../../stores/settings";
import { useProjectsStore } from "../../stores/projects";
import {
  clearRegionCursor,
  forgetRegionCursors,
  regionCursor,
} from "../../lib/shortcuts/steeringRegion";

/** Apart from what re-renders, as in the app: the hook's effect re-running
 *  would drop its pending timers. */
function Keyboard() {
  useKeyboard({ onTogglePanels: () => {} });
  return null;
}

function press(init: Partial<KeyboardEventInit> & { key: string }) {
  act(() => {
    document.body.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...init }));
  });
}

async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 60));
  });
}

const popout = (label: string): DetachedGroup => ({
  id: label, label, subtree: { type: "group", id: label, tabKeys: [], activeKey: null },
});

const steering = () => useKeyboardSteeringStore.getState();
const on = () => {
  press({ key: " ", shiftKey: true });
  expect(steering().active).toBe(true);
};

beforeEach(() => {
  useRootOverlayStore.setState({ open: false, view: "root" });
  vi.mocked(invoke).mockReset().mockResolvedValue(undefined);
  useTabsStore.setState({
    scope: "p",
    detachedGroupsByScope: {},
    tabsByScope: {},
    layoutByScope: {},
    focusedGroupByScope: {},
    tabs: [],
    layout: null,
    focusedGroupId: null,
    activeKey: null,
    fullscreenGroupId: null,
  });
  useSettingsStore.setState({ settings: null });
  useProjectsStore.setState({ projects: [] });
  useHeaderHoverMenuStore.setState({ openId: null });
  useKeyboardSteeringStore.getState().exit();
  forgetRegionCursors();
  // jsdom has no layout: every element gets a box, its row set by the
  // nearest `data-y` so ↑/↓ can tell the rows apart.
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const y = Number(this.closest<HTMLElement>("[data-y]")?.dataset.y ?? 0);
    return { width: 10, height: 5, x: 0, y, top: y, left: 0, right: 10, bottom: y + 5, toJSON: () => ({}) };
  });
});

afterEach(() => {
  cleanup();
  clearRegionCursor();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});


describe("steering coverage", () => {
  it("keeps steering on failed focus and ignores a successful reply from an older visit", async () => {
    render(<Keyboard />);
    on();
    press({ key: "j" });
    await settle();
    expect(steering().active).toBe(true);
    useTabsStore.setState({ detachedGroupsByScope: { p: [popout("detached-test")] } });
    vi.mocked(invoke).mockResolvedValueOnce(false);
    press({ key: "j" });
    await settle();
    expect(steering().active).toBe(true);
    let finish: (ok: boolean) => void = () => {};
    vi.mocked(invoke).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    press({ key: "j" });
    press({ key: "Escape" });
    on();
    await act(async () => { finish(true); });
    expect(steering().active).toBe(true);
    vi.mocked(invoke).mockResolvedValueOnce(true);
    press({ key: "j" });
    await settle();
    expect(steering().active).toBe(false);
  });

  it("uses Root popouts while Root is shown, and retries a failed first popout", async () => {
    useRootOverlayStore.setState({ open: true, view: "root" });
    useTabsStore.setState({ detachedGroupsByScope: {
      [ROOT_SCOPE]: [popout("root-a"), popout("root-b")], p: [popout("project-a")],
    } });
    vi.mocked(invoke).mockResolvedValueOnce(false).mockResolvedValue(true);
    await focusNextPopout();
    await focusNextPopout();
    expect(vi.mocked(invoke).mock.calls.slice(-2).map((c) => c[1])).toEqual([{ label: "root-a" }, { label: "root-a" }]);
    await focusNextPopout();
    expect(invoke).toHaveBeenLastCalledWith("focus_detached_window", { label: "root-b" });
    useRootOverlayStore.setState({ open: false });
    await focusNextPopout();
    expect(invoke).toHaveBeenLastCalledWith("focus_detached_window", { label: "project-a" });
  });

  it("hands range controls the native keyboard without making them search fields", () => {
    render(<><Keyboard /><div className="modal-backdrop"><input id="dial" type="range" /><input id="search" type="search" /></div></>);
    on();
    expect(regionCursor()?.id).toBe("dial");
    press({ key: "Enter" });
    expect(steering().active).toBe(false);
    expect(document.activeElement?.id).toBe("dial");
    on();
    press({ key: "/" });
    expect(document.activeElement?.id).toBe("search");
  });

  it("enters cockpit, reuses roster actions, walks visible areas and resumes after a dialog", async () => {
    useRootOverlayStore.setState({ open: true, view: "now" });
    const actions = vi.fn();
    const unregister = registerCockpitRoster(actions);
    render(<><Keyboard /><div className="root-console-backdrop modal-backdrop"><div className="root-overlay">
      <div className="root-overlay-bar"><button>view</button></div>
      <div className="cockpit-now-roster"><input type="search" /><div className="cockpit-roster-list"><div role="option" aria-selected="true" data-pty="p:a">agent</div></div></div>
      <div className="cockpit-now-detail"><textarea id="chosen-agent" /></div>
    </div></div></>);
    on();
    expect(steering().region).toBe("cockpit");
    expect(regionCursor()?.getAttribute("data-pty")).toBe("p:a");
    press({ key: "d" });
    expect(actions).toHaveBeenLastCalledWith("cockpitDown", "p:a");
    press({ key: "Enter" });
    expect(actions).toHaveBeenLastCalledWith("cockpitJump", "p:a");
    press({ key: "Tab" });
    expect(regionCursor()?.id).toBe("chosen-agent");
    press({ key: "Enter" });
    expect(document.activeElement?.id).toBe("chosen-agent");
    expect(steering().active).toBe(false);
    on();
    const dialog = document.createElement("div");
    dialog.className = "modal-backdrop";
    dialog.innerHTML = '<button>answer</button>';
    document.body.append(dialog);
    press({ key: "d" });
    expect(steering().region).toBe("overlay");
    dialog.remove();
    press({ key: "d" });
    await settle();
    expect(steering().region).toBe("cockpit");
    unregister();
  });
  it("opens cockpit with U and returns a narrow detail to the visible roster", async () => {
    function Cockpit() {
      const open = useRootOverlayStore((s) => s.open);
      const [detail, setDetail] = useState(true);
      return open && <div className="root-console-backdrop modal-backdrop"><div className="root-overlay">
        {detail ? <div className="cockpit-now-detail"><div className="cockpit-narrow-back"><button onClick={() => setDetail(false)}>back</button></div><textarea /></div>
          : <div className="cockpit-now-roster"><div className="cockpit-roster-list"><div role="option" aria-selected="true">agent</div></div></div>}
      </div></div>;
    }
    render(<><Keyboard /><Cockpit /></>);
    on();
    press({ key: "u" });
    await settle();
    expect(useRootOverlayStore.getState().view).toBe("now");
    expect(steering().region).toBe("cockpit");
    press({ key: "Escape" });
    await settle();
    expect(useRootOverlayStore.getState().open).toBe(true);
    expect(regionCursor()?.getAttribute("role")).toBe("option");
    press({ key: "Escape" });
    expect(useRootOverlayStore.getState().open).toBe(false);
  });

  it("does not end steering when a focus reply arrives after switching scope", async () => {
    render(<Keyboard />);
    useTabsStore.setState({ detachedGroupsByScope: { p: [popout("delayed")] } });
    let finish: (ok: boolean) => void = () => {};
    vi.mocked(invoke).mockImplementation((cmd) => cmd === "focus_detached_window"
      ? new Promise((resolve) => { finish = resolve; }) : Promise.resolve(undefined));
    on();
    press({ key: "j" });
    useTabsStore.setState({ scope: "other" });
    await act(async () => { finish(true); });
    expect(steering().active).toBe(true);
  });

});
