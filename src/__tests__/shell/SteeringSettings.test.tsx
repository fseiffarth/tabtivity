/**
 * Steering through the settings dialog: `,` opens it and stays in steering on
 * its region — ←/→ step the left-hand list's pages, ↑/↓ walk the page's
 * controls, Enter presses (a dropdown option hands the cursor back to its
 * dropdown), `/` hands the caret to the dialog's search, Escape closes an open
 * dropdown and then the dialog. The dialog here is a stand-in with the real
 * one's markup (`settings-dialog`, `settings-navigation-links`,
 * `settings-panel-content`) and its modal frame (`useModalFocus`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { useEffect, useState } from "react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    isFullscreen: vi.fn().mockResolvedValue(false),
    setFullscreen: vi.fn(),
  }),
}));

import { useKeyboard } from "../../hooks/useKeyboard";
import { useModalFocus } from "../../hooks/useModalFocus";
import { Dropdown } from "../../components/common/Dropdown";
import { useKeyboardSteeringStore } from "../../stores/keyboardSteering";
import { useTabsStore } from "../../stores/tabs";
import { useSettingsStore } from "../../stores/settings";
import { useProjectsStore } from "../../stores/projects";
import { steeringKeysFor } from "../../lib/shortcuts/shortcuts";
import { clearRegionCursor, regionCursor } from "../../lib/shortcuts/steeringRegion";

function Dialog({ onClose }: { onClose: () => void }) {
  const ref = useModalFocus(onClose);
  const [page, setPage] = useState<"general" | "layout">("general");
  const [zoom, setZoom] = useState("1");
  return (
    <div ref={ref} tabIndex={-1} role="dialog" aria-modal="true" className="settings-dialog">
      <nav className="settings-navigation">
        <input id="search" type="text" className="settings-navigation-search" />
        <div className="settings-navigation-links">
          {(["general", "layout"] as const).map((p) => (
            <button
              key={p}
              id={`nav-${p}`}
              type="button"
              aria-current={p === page ? "location" : undefined}
              onClick={() => setPage(p)}
            >
              {p}
            </button>
          ))}
        </div>
      </nav>
      <div className="settings-panel-content">
        <div className="settings-title-row">
          <button type="button" className="dialog-close-btn" onClick={onClose}>
            ×
          </button>
        </div>
        {page === "general" ? (
          <>
            <button id="g1" type="button">
              g1
            </button>
            <button id="g2" type="button">
              g2
            </button>
          </>
        ) : (
          <Dropdown
            value={zoom}
            onChange={setZoom}
            options={[
              { value: "1", label: "100%" },
              { value: "1.25", label: "125%" },
            ]}
          />
        )}
      </div>
    </div>
  );
}

function Keyboard() {
  useKeyboard({ onTogglePanels: () => {} });
  return null;
}

/** The settings dialog's owner (`ProjectSwitcher`'s open / close events). */
function SettingsOwner() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const show = () => setOpen(true);
    const hide = () => setOpen(false);
    window.addEventListener("app:open-settings", show);
    window.addEventListener("app:close-settings", hide);
    return () => {
      window.removeEventListener("app:open-settings", show);
      window.removeEventListener("app:close-settings", hide);
    };
  }, []);
  return open ? <Dialog onClose={() => setOpen(false)} /> : null;
}

/** Apart, as in the app: the dialog opening must not re-run the keyboard
 *  hook (which would drop its pending cursor placement). */
function Harness() {
  return (
    <>
      <Keyboard />
      <SettingsOwner />
    </>
  );
}

function press(init: Partial<KeyboardEventInit> & { key: string }) {
  act(() => {
    document.body.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...init }));
  });
}

/** Let the page re-render and the cursor's placement retry (every 50 ms
 *  while the surface mounts) land. */
async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 60));
  });
}

const steering = () => useKeyboardSteeringStore.getState();
const dialog = () => document.querySelector(".settings-dialog");

beforeEach(() => {
  useTabsStore.setState({
    scope: "p",
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
  useKeyboardSteeringStore.getState().exit();
  // jsdom has no layout: give every element a box so the cursor can land.
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    width: 10,
    height: 10,
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 10,
    bottom: 10,
    toJSON: () => ({}),
  });
});

afterEach(() => {
  cleanup();
  clearRegionCursor();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("steering through settings", () => {
  it("opens settings on its region and walks its pages and controls", async () => {
    render(<Harness />);
    press({ key: " ", shiftKey: true });
    press({ key: "," });
    expect(dialog()).not.toBeNull();
    expect(steering()).toMatchObject({ active: true, level: "region", region: "settings", regionReturn: "tabs" });
    await settle();
    // The page's first control — never the dialog's ×.
    expect(regionCursor()?.id).toBe("g1");
    press({ key: "d" });
    expect(regionCursor()?.id).toBe("g2");

    // → opens the next page; the cursor follows onto it.
    press({ key: "f" });
    await settle();
    expect(document.getElementById("nav-layout")?.getAttribute("aria-current")).toBe("location");
    expect(regionCursor()?.classList.contains("dropdown-trigger")).toBe(true);

    // Enter opens the dropdown, ↓ reaches an option, Enter picks it and the
    // cursor returns to the dropdown.
    press({ key: "Enter" });
    await settle();
    press({ key: "ArrowDown" });
    press({ key: "ArrowDown" });
    expect(regionCursor()?.textContent).toBe("125%");
    press({ key: "Enter" });
    await settle();
    expect(document.querySelector(".dropdown-menu")).toBeNull();
    expect(regionCursor()?.classList.contains("dropdown-trigger")).toBe(true);
    expect(regionCursor()?.textContent).toContain("125%");

    // ← wraps back to the first page.
    press({ key: "s" });
    await settle();
    expect(document.getElementById("nav-general")?.getAttribute("aria-current")).toBe("location");
    expect(steering().active).toBe(true);
  });

  it("Escape closes an open dropdown first, then settings, back on the level it came from", async () => {
    render(<Harness />);
    press({ key: " ", shiftKey: true });
    press({ key: "," });
    await settle();
    press({ key: "ArrowRight" });
    await settle();
    press({ key: "Enter" });
    await settle();
    expect(document.querySelector(".dropdown-menu")).not.toBeNull();

    press({ key: "Escape" });
    await settle();
    expect(document.querySelector(".dropdown-menu")).toBeNull();
    expect(dialog()).not.toBeNull();
    expect(steering().region).toBe("settings");

    press({ key: "Escape" });
    await settle();
    expect(dialog()).toBeNull();
    expect(steering()).toMatchObject({ active: true, level: "tabs", region: null });
  });

  it("/ hands the caret to the settings search; the chord over settings comes back to it", async () => {
    render(<Harness />);
    press({ key: " ", shiftKey: true });
    press({ key: "," });
    await settle();
    press({ key: "/" });
    expect(steering().active).toBe(false);
    expect(document.activeElement?.id).toBe("search");

    press({ key: " ", shiftKey: true });
    expect(steering()).toMatchObject({ active: true, level: "region", region: "settings" });
  });

  it("a plain key over settings is the dialog's; steering left elsewhere joins settings opened by the pointer", async () => {
    render(<Harness />);
    act(() => void window.dispatchEvent(new CustomEvent("app:open-settings", { detail: "main" })));
    // Not steering: a plain key over settings is left to the dialog.
    press({ key: "d" });
    expect(steering().active).toBe(false);

    // Steering on some other level while settings is on top walks settings
    // (the key acts there, never behind the dialog).
    act(() => useKeyboardSteeringStore.getState().enter());
    press({ key: "d" });
    expect(steering()).toMatchObject({ active: true, level: "region", region: "settings", regionReturn: "tabs" });
    await settle();
    expect(regionCursor()?.id).toMatch(/^g[12]$/);
  });

  it("the legend lists the page switch only in the settings region", () => {
    const base = {
      level: "region" as const,
      sideRegion: false,
      multiPane: false,
      apps: { mail: false, calendar: false, todo: false },
      statusCounts: { decision: 0, working: 0, done: 0 },
    };
    const has = (settingsRegion: boolean) =>
      steeringKeysFor({ ...base, settingsRegion }).some((k) => k.labelKey === "steering.settingsPage.label");
    expect(has(true)).toBe(true);
    expect(has(false)).toBe(false);
  });
});
