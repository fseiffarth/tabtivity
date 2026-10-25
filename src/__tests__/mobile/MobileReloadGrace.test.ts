import { beforeEach, describe, expect, it } from "vitest";
import { clearConnectGrace, clearConnectReload, isConnectReload, noteConnectGrace, noteUnlockedLeave, RELOAD_GRACE_MS, takeConnectGrace, takeConnectReload, takeReloadGrace } from "../../../mobile-web/src/reloadGrace";
import { BRAND, storageKey } from "../../lib/brand";

const T = 1_000_000;

describe(`${BRAND.display} Mobile reload grace`, () => {
  beforeEach(() => sessionStorage.clear());

  it("lets a reload moments after an unlocked page was left skip the lock, once", () => {
    noteUnlockedLeave(T, sessionStorage);
    expect(takeReloadGrace(T + 1_500, sessionStorage, "reload", false)).toBe(true);
    expect(takeReloadGrace(T + 1_600, sessionStorage, "reload", false)).toBe(false);
  });

  it("asks on a launch, a history return, or a page the browser discarded", () => {
    for (const [type, discarded] of [["navigate", false], ["back_forward", false], [undefined, false], ["reload", true]] as const) {
      noteUnlockedLeave(T, sessionStorage);
      expect(takeReloadGrace(T + 1_000, sessionStorage, type, discarded)).toBe(false);
      // Consumed even when refused, so a later reload cannot reuse it.
      expect(takeReloadGrace(T + 1_100, sessionStorage, "reload", false)).toBe(false);
    }
  });

  it("asks once the page has been gone longer than the grace", () => {
    noteUnlockedLeave(T, sessionStorage);
    expect(takeReloadGrace(T + RELOAD_GRACE_MS + 1, sessionStorage, "reload", false)).toBe(false);
  });

  it("asks without a stamp, with a malformed one, or one from the future", () => {
    expect(takeReloadGrace(T, sessionStorage, "reload", false)).toBe(false);
    sessionStorage.setItem(storageKey("mobile.reloadGrace"), "1");
    expect(takeReloadGrace(T, sessionStorage, "reload", false)).toBe(false);
    sessionStorage.setItem(storageKey("mobile.reloadGrace"), "yes");
    expect(takeReloadGrace(T, sessionStorage, "reload", false)).toBe(false);
    noteUnlockedLeave(T + 5_000, sessionStorage);
    expect(takeReloadGrace(T, sessionStorage, "reload", false)).toBe(false);
  });
});

describe(`${BRAND.display} Mobile failed-connect reload`, () => {
  beforeEach(() => sessionStorage.clear());

  it("hands out one reload per failure streak", () => {
    expect(isConnectReload(sessionStorage)).toBe(false);
    expect(takeConnectReload(sessionStorage)).toBe(true);
    // The reloaded page knows it is one, and fails to the splash next time.
    expect(isConnectReload(sessionStorage)).toBe(true);
    expect(takeConnectReload(sessionStorage)).toBe(false);
    // A connect that works earns the next streak its reload.
    clearConnectReload(sessionStorage);
    expect(takeConnectReload(sessionStorage)).toBe(true);
  });

  it("never reloads when the mark cannot be kept", () => {
    expect(takeConnectReload(null)).toBe(false);
    const blocked = { getItem: () => null, setItem: () => { throw new Error("blocked"); }, removeItem: () => undefined };
    expect(takeConnectReload(blocked)).toBe(false);
  });

  it("keeps an unlock a failed connect wasted across any next page in the window, once", () => {
    localStorage.clear();
    noteConnectGrace(T, localStorage);
    expect(takeConnectGrace(180_000, T + 120_000, localStorage)).toBe(true);
    expect(takeConnectGrace(180_000, T + 120_001, localStorage)).toBe(false);

    noteConnectGrace(T, localStorage);
    expect(takeConnectGrace(180_000, T + 180_001, localStorage)).toBe(false);
    // Consumed even when refused, so a later open cannot reuse it.
    expect(localStorage.length).toBe(0);

    noteConnectGrace(T, localStorage);
    clearConnectGrace(localStorage);
    expect(takeConnectGrace(180_000, T + 1, localStorage)).toBe(false);
    // A clock set back is not "seconds ago".
    noteConnectGrace(T, localStorage);
    expect(takeConnectGrace(180_000, T - 1, localStorage)).toBe(false);
  });
});
