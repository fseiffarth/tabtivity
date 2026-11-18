/**
 * Persistent local sessions per platform (`lib/terminal/localSessions`) and the
 * spawn rule that uses them (`shouldPersistLocalTab`): tmux off Windows; on
 * Windows the experimental session host, agents only, Mobile or not, by the
 * slot's stamp
 * (docs/windows_session_host_plan.md, Defaults 1, 3 and 5).
 */
import { describe, expect, it } from "vitest";
import { localSessionBackendOn, localSessionsAvailable, mayOwnWindowsLocalSession } from "../../lib/terminal/localSessions";
import { shouldPersistLocalTab } from "../../lib/terminal/tmuxSession";
import type { Settings } from "../../types";

const s = (o: Partial<Settings>): Settings => o as Settings;

describe("localSessionsAvailable", () => {
  it("is tmux's answer off Windows: on unless persistent sessions are off", () => {
    for (const os of ["linux", "macos"] as const) {
      expect(localSessionsAvailable(s({}), os)).toBe(true);
      expect(localSessionsAvailable(null, os)).toBe(true);
      expect(localSessionsAvailable(s({ persist_local_sessions: false }), os)).toBe(false);
      // The Windows flag means nothing here.
      expect(localSessionsAvailable(s({ windows_session_host: false }), os)).toBe(true);
      expect(localSessionBackendOn(s({ persist_local_sessions: false }), os)).toBe(true);
    }
  });

  it("needs the session host flag and persistent sessions on Windows", () => {
    expect(localSessionsAvailable(s({}), "windows")).toBe(false);
    expect(localSessionsAvailable(null, "windows")).toBe(false);
    // Debug mode never carries the flag.
    expect(localSessionsAvailable(s({ debug: true }), "windows")).toBe(false);
    expect(localSessionsAvailable(s({ windows_session_host: true }), "windows")).toBe(true);
    expect(localSessionsAvailable(s({ windows_session_host: true, persist_local_sessions: false }), "windows")).toBe(false);
    expect(localSessionsAvailable(s({ windows_session_host: false, persist_local_sessions: true }), "windows")).toBe(false);
  });

  it("reports the backend apart from the persistence switch", () => {
    expect(localSessionBackendOn(s({ windows_session_host: true, persist_local_sessions: false }), "windows")).toBe(true);
    expect(localSessionBackendOn(s({}), "windows")).toBe(false);
  });
});

describe("shouldPersistLocalTab on Windows", () => {
  // `stamped` is the slot's stamp (`PaneSlot`: the host was on when the tab
  // was first drawn); the live setting (`localEnabled`) is not read.
  const win = (kind: string, opts: { scope?: string; local?: boolean; on?: boolean; stamped?: boolean; resumable?: boolean } = {}) =>
    shouldPersistLocalTab(
      kind,
      opts.scope ?? "p1",
      opts.local ?? true,
      opts.on ?? true,
      opts.stamped ?? true,
      opts.resumable ?? true,
      "windows",
    );

  it("gives a restorable agent tab stamped for the host a session", () => {
    expect(win("agent")).toBe(true);
    expect(win("local_agent")).toBe(true);
    expect(win("agent", { scope: "box:b1" })).toBe(true);
  });

  it("follows the stamp, not the live setting, so a change never respawns a drawn tab", () => {
    expect(win("agent", { on: false })).toBe(true);
    expect(win("agent", { on: true, stamped: false })).toBe(false);
  });

  it("never a shell, the root console, a remote tab or a non-restorable agent", () => {
    expect(win("shell")).toBe(false);
    expect(win("shell", { scope: "root" })).toBe(false);
    expect(win("agent", { scope: "root" })).toBe(false);
    expect(win("agent", { local: false })).toBe(false);
    expect(win("agent", { resumable: false })).toBe(false);
    expect(win("files")).toBe(false);
  });

  it("kills key on the tab, whatever the settings say now", () => {
    expect(mayOwnWindowsLocalSession("agent", "p1", true)).toBe(true);
    expect(mayOwnWindowsLocalSession("local_agent", "box:b1", true)).toBe(true);
    expect(mayOwnWindowsLocalSession("agent", "root", true)).toBe(false);
    expect(mayOwnWindowsLocalSession("agent", "p1", false)).toBe(false);
    expect(mayOwnWindowsLocalSession("shell", "p1", true)).toBe(false);
  });

  it("leaves the Unix rule as it was", () => {
    expect(shouldPersistLocalTab("shell", "p1", true, true, false, false, "linux")).toBe(true);
    expect(shouldPersistLocalTab("agent", "p1", true, true, false, true, "linux")).toBe(false);
    expect(shouldPersistLocalTab("agent", "p1", true, true, true, true, "macos")).toBe(true);
  });
});
