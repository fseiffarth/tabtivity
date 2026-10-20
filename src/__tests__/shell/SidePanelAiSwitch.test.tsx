/**
 * The side panel's AI switch (`lib/aiSwitch.ts`, `docs/ai_switch_plan.md`):
 * the ⏻ in the panel chrome writes `ai_off` through `patch_settings` and
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

import { SidePanel } from "../../components/layout/SidePanel";
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
  const button = container.querySelector<HTMLButtonElement>("button.side-panel-ai");
  if (!button) throw new Error("no AI switch in the panel chrome");
  return button;
}

describe("side panel AI switch", () => {
  it("switches AI off and back on through the settings", async () => {
    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(<SidePanel open={true} onHide={() => {}} />));
    });
    const button = powerButton(container);
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(button.classList.contains("off")).toBe(false);

    await act(async () => { fireEvent.click(button); });
    expect(invoke).toHaveBeenCalledWith("patch_settings", expect.objectContaining({ patch: { ai_off: true } }));
    expect(aiIsOff()).toBe(true);
    expect(powerButton(container).getAttribute("aria-pressed")).toBe("true");
    expect(powerButton(container).classList.contains("off")).toBe(true);

    await act(async () => { fireEvent.click(powerButton(container)); });
    expect(invoke).toHaveBeenLastCalledWith("patch_settings", expect.objectContaining({ patch: { ai_off: false } }));
    expect(aiIsOff()).toBe(false);
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
