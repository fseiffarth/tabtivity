/**
 * Onboarding copy names the panel key that works on THIS desktop.
 *
 * It used to say "Super" on every Linux desktop, though on GNOME and KDE the
 * shell owns Super and the binding is F9 (`livePanelToggleKey`). The desktop is
 * a backend probe, so the How-to-start dialog — shown on a fresh install, maybe
 * before that probe lands — must wait for the answer rather than name the
 * wrong key first. The test environment reports Linux.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, cleanup, act } from "@testing-library/react";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import { focusModeTip } from "../../lib/shortcuts/hints";
import { probeSuperKeyOwnership, resetSuperKeyOwnership } from "../../lib/shortcuts/superKey";
import { HowToStart } from "../../components/layout/HowToStart";

const t = (key: string, params?: Record<string, string | number>) =>
  `${key}:${params?.key ?? ""}`;

describe("panel-toggle copy", () => {
  beforeEach(() => {
    cleanup();
    resetSuperKeyOwnership();
    invoke.mockReset();
  });

  it("names F9 where the desktop owns Super (GNOME, KDE)", async () => {
    invoke.mockResolvedValue(true);
    await probeSuperKeyOwnership();
    expect(focusModeTip(t)).toBe("onboarding.focusModeTipOther:F9");
  });

  it("names Super where the desktop leaves it to the window (Cinnamon)", async () => {
    invoke.mockResolvedValue(false);
    await probeSuperKeyOwnership();
    expect(focusModeTip(t)).toBe("onboarding.focusModeTipOther:Super");
  });

  it("How to start names no key before the probe answers, then the live one", async () => {
    let answer: (owned: boolean) => void = () => {};
    // Only the probe is held open; the wizard's other reads (the import
    // question) are simply unavailable here.
    invoke.mockImplementation((cmd: string) =>
      cmd === "desktop_owns_super_key"
        ? new Promise<boolean>((resolve) => {
            answer = resolve;
          })
        : Promise.reject(new Error(`unmocked ${cmd}`)),
    );
    const { container } = render(<HowToStart onClose={() => {}} />);
    expect(container.textContent).not.toContain("Super");
    expect(container.textContent).not.toContain("F9");

    await act(async () => {
      answer(true);
      await probeSuperKeyOwnership();
    });
    expect(container.textContent).toContain("F9");
    expect(container.textContent).not.toContain("Super");
  });

  it("names F9 on Windows whatever the probe says", async () => {
    vi.resetModules();
    vi.doMock("../../lib/platform", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../../lib/platform")>()),
      IS_MAC: false,
      IS_WINDOWS: true,
      IS_LINUX: false,
      PLATFORM: "windows",
    }));
    try {
      const hints = await import("../../lib/shortcuts/hints");
      expect(hints.focusModeTip(t)).toBe("onboarding.focusModeTipOther:F9");
    } finally {
      vi.doUnmock("../../lib/platform");
      vi.resetModules();
    }
  });
});
