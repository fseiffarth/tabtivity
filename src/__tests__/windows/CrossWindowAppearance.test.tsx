/**
 * A window that is its own runtime (popout, PDF present window, deck audience)
 * follows the main window's whole appearance broadcast — theme, accent / token
 * overrides / corners / cursor, and language — not just the theme.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { listen } from "@tauri-apps/api/event";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(), emit: vi.fn() }));
vi.mock("../../stores/settings", async (importActual) => ({
  ...(await importActual<typeof import("../../stores/settings")>()),
  applyTheme: vi.fn(),
  applyAccent: vi.fn(),
  applyThemeVars: vi.fn(),
  applyCorners: vi.fn(),
  applyCursor: vi.fn(),
}));
vi.mock("../../lib/i18n", async (importActual) => ({
  ...(await importActual<typeof import("../../lib/i18n")>()),
  applyLanguage: vi.fn(),
}));

import { useCrossWindowAppearance } from "../../hooks/useCrossWindowAppearance";
import {
  APPEARANCE_CHANGED_EVENT,
  LANGUAGE_CHANGED_EVENT,
  THEME_CHANGED_EVENT,
  applyAccent,
  applyCorners,
  applyCursor,
  applyTheme,
  applyThemeVars,
} from "../../stores/settings";
import { applyLanguage } from "../../lib/i18n";

const listenMock = vi.mocked(listen);

afterEach(() => vi.clearAllMocks());

describe("useCrossWindowAppearance", () => {
  it("applies theme, appearance and language broadcasts and unlistens on unmount", async () => {
    const handlers = new Map<string, (e: { payload: unknown }) => void>();
    const unlisten = vi.fn();
    listenMock.mockImplementation(async (event, handler) => {
      handlers.set(event as string, handler as never);
      return unlisten;
    });
    const { unmount } = renderHook(() => useCrossWindowAppearance());
    await waitFor(() => expect(handlers.size).toBe(3));

    handlers.get(THEME_CHANGED_EVENT)!({ payload: "dark" });
    expect(applyTheme).toHaveBeenCalledWith("dark");

    handlers.get(APPEARANCE_CHANGED_EVENT)!({
      payload: { accent: "#123456", themeVars: { "--a": "1" }, corners: "sharp", cursor: "pack" },
    });
    expect(applyAccent).toHaveBeenCalledWith("#123456");
    expect(applyThemeVars).toHaveBeenCalledWith({ "--a": "1" });
    expect(applyCorners).toHaveBeenCalledWith("sharp");
    expect(applyCursor).toHaveBeenCalledWith("pack");

    handlers.get(LANGUAGE_CHANGED_EVENT)!({ payload: "de" });
    expect(applyLanguage).toHaveBeenCalledWith("de");

    unmount();
    expect(unlisten).toHaveBeenCalledTimes(3);
  });
});
