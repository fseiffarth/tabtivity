/**
 * The one ask after a renderer crash on the GPU path turned GPU compositing off
 * (`services::webkit_gpu`): shown only while the backend's note is there,
 * "Keep it off" is the default, and either answer clears the note.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GpuFallbackHost } from "../../components/common/GpuFallbackHost";
import { useSettingsStore } from "../../stores/settings";
import type { Settings } from "../../types";

const updateSettings = vi.fn(async () => {});

function seed(settings: Partial<Settings>) {
  useSettingsStore.setState({ settings: settings as Settings, updateSettings });
}

describe("GpuFallbackHost", () => {
  beforeEach(() => updateSettings.mockClear());
  afterEach(cleanup);

  it("asks nothing without the backend's note", () => {
    seed({ gpu_compositing: true });
    render(<GpuFallbackHost />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps GPU compositing off by default and clears the note", () => {
    seed({ gpu_compositing: false, gpu_compositing_fallback: "2026-11-24T09:00:38Z" });
    render(<GpuFallbackHost />);
    const keep = screen.getByRole("button", { name: "Keep it off" });
    expect(document.activeElement).toBe(keep);
    fireEvent.click(keep);
    expect(updateSettings).toHaveBeenCalledWith({ gpu_compositing_fallback: null });
  });

  it("turns it back on only when asked to", () => {
    seed({ gpu_compositing: false, gpu_compositing_fallback: "2026-11-24T09:00:38Z" });
    render(<GpuFallbackHost />);
    fireEvent.click(screen.getByRole("button", { name: "Turn GPU compositing back on" }));
    expect(updateSettings).toHaveBeenCalledWith({ gpu_compositing: true, gpu_compositing_fallback: null });
  });
});
