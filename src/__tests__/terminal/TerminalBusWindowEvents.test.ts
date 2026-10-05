import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ label: "detached-proj-g1" }),
}));

import { streamEventName } from "../../lib/terminal/terminalBus";

/**
 * Tauri evaluates an emit in every webview listening for its name, so a popout
 * on the plain `terminal-output` parsed every chunk the main window streamed.
 * The main window keeps the plain name; a popout listens on its own.
 */
describe("streamEventName", () => {
  afterEach(() => {
    window.history.replaceState(null, "", "/");
  });

  it("keeps the plain name in the main window", () => {
    expect(streamEventName("terminal-output")).toBe("terminal-output");
  });

  it("suffixes the window label in a popout", () => {
    window.history.replaceState(null, "", "/?detached=proj&group=g1");
    expect(streamEventName("terminal-output")).toBe("terminal-output:detached-proj-g1");
    expect(streamEventName("terminal-replay")).toBe("terminal-replay:detached-proj-g1");
  });
});
