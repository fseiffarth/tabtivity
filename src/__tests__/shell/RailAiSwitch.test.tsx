/**
 * The side panel's AI switch (`lib/aiSwitch.ts`, `docs/ai_switch_plan.md`):
 * the ⏻ on the edge rail writes `ai_off` through `patch_settings` and
 * shows the state it reads back; `whenAiOn` is what an agent tab refused at
 * spawn waits on before it starts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act, fireEvent } from "@testing-library/react";
import type { Settings } from "../../types";

type InvokeArgs = Record<string, unknown> | undefined;
let stored: Partial<Settings> = {};
const invoke = vi.fn((cmd: string, args?: InvokeArgs) => {
  if (cmd === "patch_settings") {
    stored = { ...stored, ...((args?.patch ?? {}) as Partial<Settings>) };
    return Promise.resolve(stored);
  }
  return Promise.resolve(cmd === "git_repo_root" ? null : []);
});
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: InvokeArgs) => invoke(cmd, args),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
  emit: vi.fn().mockResolvedValue(undefined),
}));

import { RailAiSwitch } from "../../components/layout/RailAiSwitch";
import { useProjectsStore } from "../../stores/projects";
import { useBoxesStore } from "../../stores/boxes";
import { useSettingsStore } from "../../stores/settings";
import { useTabsStore, ROOT_SCOPE } from "../../stores/tabs";
import { AI_OFF, aiIsOff, isAiOffRefusal, whenAiOn } from "../../lib/aiSwitch";

beforeEach(() => {
  invoke.mockClear();
  stored = {};
  useProjectsStore.setState({ projects: [], activeId: null, loaded: true, rootDir: "/home/u/root" });
  useBoxesStore.setState({ boxes: [], loaded: true });
  useTabsStore.setState({ scope: ROOT_SCOPE });
  useSettingsStore.setState({ settings: {} as Settings, loaded: true });
});

function powerButton(container: HTMLElement): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>("button.srh-ai");
  if (!button) throw new Error("no AI switch on the edge rail");
  return button;
}

function menuItem(label: string): HTMLButtonElement {
  const item = [...document.querySelectorAll<HTMLButtonElement>(".tab-new-menu-item")].find((b) => b.textContent?.startsWith(label));
  if (!item) throw new Error(`no menu row "${label}"`);
  return item;
}

describe("edge rail AI switch", () => {
  it("switches AI off and back on through the settings", async () => {
    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(<RailAiSwitch />));
    });
    const button = powerButton(container);
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(button.classList.contains("off")).toBe(false);

    await act(async () => { fireEvent.click(button); });
    expect(invoke).not.toHaveBeenCalledWith("patch_settings", expect.anything());
    await act(async () => { fireEvent.click(menuItem("Switch off until I switch it back on")); });
    expect(invoke).toHaveBeenCalledWith("patch_settings", expect.objectContaining({ patch: { ai_off: true, ai_off_until: null } }));
    expect(aiIsOff()).toBe(true);
    expect(powerButton(container).getAttribute("aria-pressed")).toBe("true");
    expect(powerButton(container).classList.contains("off")).toBe(true);

    await act(async () => { fireEvent.click(powerButton(container)); });
    expect(invoke).toHaveBeenLastCalledWith("patch_settings", expect.objectContaining({ patch: { ai_off: false, ai_off_until: null } }));
    expect(aiIsOff()).toBe(false);
  });

  it("switches AI off for a few hours, or for a custom number of them", async () => {
    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(<RailAiSwitch />));
    });
    const before = Date.now();
    await act(async () => { fireEvent.click(powerButton(container)); });
    await act(async () => { fireEvent.click(menuItem("Off for 2 h")); });
    const timed = stored.ai_off_until ?? 0;
    expect(stored.ai_off).toBe(true);
    expect(timed - before).toBeGreaterThanOrEqual(2 * 3_600_000);
    expect(timed - Date.now()).toBeLessThanOrEqual(2 * 3_600_000);
    expect(aiIsOff()).toBe(true);
    expect(powerButton(container).title).toMatch(/^AI is off until /);

    await act(async () => { fireEvent.click(powerButton(container)); });
    expect(stored.ai_off).toBe(false);
    await act(async () => { fireEvent.click(powerButton(container)); });
    await act(async () => { fireEvent.click(menuItem("Custom…")); });
    const hours = document.querySelector<HTMLInputElement>(".menu-form input");
    if (!hours) throw new Error("no hours field");
    await act(async () => { fireEvent.change(hours, { target: { value: "1,5" } }); });
    await act(async () => { fireEvent.keyDown(hours, { key: "Enter" }); });
    expect(stored.ai_off).toBe(true);
    expect((stored.ai_off_until ?? 0) - Date.now()).toBeGreaterThan(89 * 60_000);
    expect((stored.ai_off_until ?? 0) - Date.now()).toBeLessThanOrEqual(90 * 60_000);
  });

  it("is on again once a timed switch runs out, and wakes its waiters", async () => {
    vi.useFakeTimers();
    try {
      useSettingsStore.setState({ settings: { ai_off: true, ai_off_until: Date.now() + 60_000 } as Settings });
      expect(aiIsOff()).toBe(true);
      let resumed: boolean | null = null;
      void whenAiOn(new AbortController().signal).then((on) => { resumed = on; });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(resumed).toBeNull();
      await vi.advanceTimersByTimeAsync(31_000);
      expect(aiIsOff()).toBe(false);
      expect(resumed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("recognises the backend's refusal", () => {
    expect(isAiOffRefusal(AI_OFF)).toBe(true);
    expect(isAiOffRefusal(new Error("boom"))).toBe(false);
  });

  it("holds a waiter until AI is on, and drops an aborted one", async () => {
    useSettingsStore.setState({ settings: { ai_off: true } as Settings });
    let resumed: boolean | null = null;
    void whenAiOn(new AbortController().signal).then((on) => { resumed = on; });
    const gone = new AbortController();
    let dropped: boolean | null = null;
    void whenAiOn(gone.signal).then((on) => { dropped = on; });
    await Promise.resolve();
    expect(resumed).toBeNull();

    gone.abort();
    await Promise.resolve();
    expect(dropped).toBe(false);
    expect(resumed).toBeNull();

    useSettingsStore.setState({ settings: { ai_off: false } as Settings });
    await Promise.resolve();
    expect(resumed).toBe(true);
  });
});
