import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { StayAfterQuitPrompt } from "../../components/mobile/StayAfterQuitPrompt";
import { useSettingsStore } from "../../stores/settings";
import type { Settings } from "../../types";
import { MOBILE_HOST_KEY } from "../../lib/brand";

function setUp() {
  const updateSettings = vi.fn().mockResolvedValue(undefined);
  useSettingsStore.setState({
    settings: { [MOBILE_HOST_KEY]: { enabled: true, port: 9000 } } as Settings,
    loaded: true,
    updateSettings,
  });
  const onClose = vi.fn();
  render(<StayAfterQuitPrompt onClose={onClose} />);
  return { updateSettings, onClose };
}

describe("StayAfterQuitPrompt", () => {
  afterEach(() => useSettingsStore.setState({ settings: null, loaded: false }));

  it("Keep running turns the switch on and keeps the host block's other keys", async () => {
    const { updateSettings, onClose } = setUp();
    await userEvent.setup().click(screen.getByRole("button", { name: "Keep running" }));
    expect(onClose).toHaveBeenCalled();
    expect(updateSettings).toHaveBeenCalledWith({
      [MOBILE_HOST_KEY]: { enabled: true, port: 9000, stay_after_quit: true },
    });
  });

  it("No closes without writing anything", async () => {
    const { updateSettings, onClose } = setUp();
    await userEvent.setup().click(screen.getByRole("button", { name: "No" }));
    expect(onClose).toHaveBeenCalled();
    expect(updateSettings).not.toHaveBeenCalled();
  });
});
