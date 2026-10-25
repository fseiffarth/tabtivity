/**
 * The ▶ Continue pill on an interrupted agent tab (`TabContinueButton`): shown
 * only while the strip marks the tab ■ interrupted, and one click submits
 * "continue" into that tab through the steering prompt path — without the
 * click reaching the tab underneath (no activation, no drag).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, waitFor } from "@testing-library/react";
import type { TabEntry } from "../../stores/tabs";

const sendSteeringPrompt = vi.fn<(tab: TabEntry, text: string) => Promise<void>>();
vi.mock("../../lib/shortcuts/steeringAgent", () => ({
  sendSteeringPrompt: (tab: TabEntry, text: string) => sendSteeringPrompt(tab, text),
}));

import { TabContinueButton } from "../../components/tabs/TabLocalityBadges";
import { useSettingsStore } from "../../stores/settings";

const agentTab = { key: "t1", kind: "agent", label: "Claude", cmd: "claude", scheduleTargetId: "s1" } as unknown as TabEntry;

function pill(tab: TabEntry, stateClass: string) {
  return render(<TabContinueButton tab={tab} stateClass={stateClass} />).container.querySelector<HTMLButtonElement>(".tab-continue");
}

describe("TabContinueButton", () => {
  beforeEach(() => {
    sendSteeringPrompt.mockReset();
    sendSteeringPrompt.mockResolvedValue(undefined);
    useSettingsStore.setState({ settings: null } as never);
  });

  it("shows only on an agent tab marked interrupted", () => {
    expect(pill(agentTab, " interrupted")).not.toBeNull();
    expect(pill(agentTab, " finished")).toBeNull();
    expect(pill(agentTab, " working")).toBeNull();
    expect(pill(agentTab, "")).toBeNull();
    expect(pill({ ...agentTab, kind: "shell" } as TabEntry, " interrupted")).toBeNull();
    expect(pill({ ...agentTab, scheduleTargetId: undefined } as TabEntry, " interrupted")).toBeNull();
  });

  it("is not offered while AI is off", () => {
    useSettingsStore.setState({ settings: { ai_off: true } } as never);
    expect(pill(agentTab, " interrupted")).toBeNull();
  });

  it("sends continue into the tab without the click reaching the tab", async () => {
    const onTab = vi.fn();
    const { container } = render(
      <div onClick={onTab} onPointerDown={onTab} onMouseDown={onTab}>
        <TabContinueButton tab={agentTab} stateClass=" interrupted" />
      </div>,
    );
    const button = container.querySelector<HTMLButtonElement>(".tab-continue")!;
    fireEvent.pointerDown(button);
    fireEvent.mouseDown(button);
    fireEvent.click(button);
    expect(sendSteeringPrompt).toHaveBeenCalledWith(agentTab, "continue");
    expect(onTab).not.toHaveBeenCalled();
    await waitFor(() => expect(button.disabled).toBe(false));
  });

  it("says why a send failed, and can be clicked again", async () => {
    sendSteeringPrompt.mockRejectedValueOnce(new Error("agent terminal is not ready"));
    const button = pill(agentTab, " interrupted")!;
    fireEvent.click(button);
    await waitFor(() => expect(button.title).toContain("agent terminal is not ready"));
    expect(button.disabled).toBe(false);
  });
});
