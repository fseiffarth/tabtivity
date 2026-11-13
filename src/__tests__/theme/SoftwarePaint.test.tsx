/**
 * The CPU paint path (`lib/window/softwarePaint`): every frame of motion is
 * rasterized on the renderer's one thread, so surfaces land in one paint and a
 * hint, which stays up until dismissed, never loops.
 *
 * The failure this guards is a loop added to a hint, or a rule that stops one and
 * leaves its target unmarked. The real cascade is measured in a WebView, not here;
 * this reads the rules.
 */
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readAppStylesheet } from "../helpers/cssCorpus";

const transport = vi.hoisted(() => ({ server: false, connect: false }));
vi.mock("../../lib/platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/platform")>()),
  IS_LINUX: true,
}));
vi.mock("../../lib/transport/linkState", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/transport/linkState")>()),
  isServerClient: () => transport.server,
  isConnectWindow: () => transport.connect,
}));

import { paintsInSoftware, useSoftwarePaintAttribute } from "../../lib/window/softwarePaint";
import { useSettingsStore } from "../../stores/settings";
import type { Settings } from "../../types";

const css = readAppStylesheet({ exclude: ["reset.css"] }).replace(/\/\*[\s\S]*?\*\//g, "");

const SOFTWARE = ":root[data-software-paint]";
const SAVER = ':root[data-energy-saver="on"]';

/** The declarations of the rule whose selector list names exactly `selector`:
 *  `.hint-bubble` does not find `.hint-bubble::after`. */
function bodyOf(selector: string): string {
  const quoted = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const at = css.search(new RegExp(`${quoted}\\s*[,{]`));
  expect(at, selector).toBeGreaterThan(-1);
  const open = css.indexOf("{", at);
  return css.slice(open + 1, css.indexOf("}", open));
}

describe("paintsInSoftware", () => {
  it("is the WebKitGTK default, and off once GPU compositing is chosen", () => {
    expect(paintsInSoftware(true, undefined)).toBe(true);
    expect(paintsInSoftware(true, false)).toBe(true);
    expect(paintsInSoftware(true, true)).toBe(false);
  });

  it("never holds off WebKitGTK, whatever the setting says", () => {
    expect(paintsInSoftware(false, undefined)).toBe(false);
    expect(paintsInSoftware(false, false)).toBe(false);
  });
});

describe("the data-software-paint attribute", () => {
  function Root() {
    useSoftwarePaintAttribute();
    return null;
  }
  const attribute = () => document.documentElement.dataset.softwarePaint;
  const setGpu = (gpu_compositing: boolean | undefined) =>
    useSettingsStore.setState({ settings: { gpu_compositing } as Settings });

  beforeEach(() => {
    transport.server = false;
    transport.connect = false;
    setGpu(undefined);
  });

  afterEach(() => {
    cleanup();
    delete document.documentElement.dataset.softwarePaint;
    useSettingsStore.setState({ settings: null });
  });

  it("is published in the app window and follows the setting", () => {
    const { rerender } = render(<Root />);
    expect(attribute()).toBe("on");
    act(() => setGpu(true));
    rerender(<Root />);
    expect(attribute()).toBeUndefined();
  });

  it("is not published in a browser client, whose browser has its own GPU", () => {
    transport.server = true;
    render(<Root />);
    expect(attribute()).toBeUndefined();
  });

  // The Connect window is a server client too, but it is still this WebKitGTK.
  it("is published in the Connect window", () => {
    transport.server = true;
    transport.connect = true;
    render(<Root />);
    expect(attribute()).toBe("on");
  });
});

describe("the CPU path's rules", () => {
  it("zeroes both surface durations, on a selector that outranks the theme blocks", () => {
    const tokens = bodyOf(SOFTWARE);
    expect(tokens).toMatch(/--motion-enter: 0ms/);
    expect(tokens).toMatch(/--motion-exit: 0ms/);
  });

  // Each loop stays up as long as nobody acts, so each stops on both attributes.
  it.each([
    ".hint-bubble::after",
    ".hint-target",
    ".tour-target",
    ".tour-hint-btn.nudge",
    ".tab-new-btn.empty-hint",
    ".skeleton-row",
  ])("%s stops looping", (loop) => {
    expect(bodyOf(`${SOFTWARE} ${loop}`)).toMatch(/animation: none/);
    expect(bodyOf(`${SAVER} ${loop}`)).toMatch(/animation: none/);
  });

  // Stopped without a stand-in, the control a hint points at would look like
  // every other control: the rest state must be the pulse's peak.
  it("leaves the hint's target and glow marked at rest", () => {
    const target = bodyOf(`${SOFTWARE} .hint-target`);
    expect(target).toMatch(/background: color-mix\(in srgb, var\(--accent\) 24%/);
    expect(target).toMatch(/box-shadow: inset 0 0 0 1\.5px var\(--accent\)/);
    expect(bodyOf(`${SOFTWARE} .hint-bubble::after`)).toMatch(/opacity: 1/);
    expect(bodyOf(`${SOFTWARE} .tour-target`)).toMatch(/box-shadow: 0 0 0 2px/);
  });

  it.each([".hint-bubble", ".tour-spotlight", ".tour-bubble", ".tour-reward", ".tour-hint"])(
    "%s lands in one paint",
    (surface) => {
      expect(bodyOf(`${SOFTWARE} ${surface}`)).toMatch(/animation: none/);
    },
  );

  // Dropping the entry too would restart it each time the window regains focus.
  it("takes only the pulse off a quiesced banner", () => {
    const banner = bodyOf(`${SAVER} .hint-bubble--banner`);
    expect(banner).toMatch(/animation: hint-banner-in/);
    expect(banner).not.toMatch(/hint-banner-pulse/);
  });

  it("orders the banner's rule before the one-shots, which must win on the CPU path", () => {
    expect(css.indexOf(`${SAVER} .hint-bubble--banner`)).toBeLessThan(css.indexOf(`${SOFTWARE} .hint-bubble,`));
  });
});
