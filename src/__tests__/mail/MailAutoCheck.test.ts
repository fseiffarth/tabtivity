// @ts-expect-error node:fs has no type declarations in this project (no @types/node)
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { backgroundCheckBlocked, isAuthRejection, useMailStore } from "../../stores/mail";
import { BRAND } from "../../lib/brand";

/**
 * The header's unattended mail check (`MailIndicator`'s interval tick and VPN
 * catch-up) must not turn a stale password into a login every few minutes —
 * mail servers answer repeated failed logins from one IP with a block.
 */
describe("backgroundCheckBlocked", () => {
  const rejected =
    `the server rejected the username or password. ${BRAND.display} does not retry automatically, so nothing was sent a second time.`;

  it("pauses after a rejected login", () => {
    expect(backgroundCheckBlocked({ phase: "error", error: rejected })).toBe(true);
  });

  it("keeps checking after any other failure", () => {
    expect(backgroundCheckBlocked({ phase: "error", error: "IMAP login timed out" })).toBe(false);
    expect(backgroundCheckBlocked({ phase: "error" })).toBe(false);
  });

  it("skips a check already in flight, and runs for a fresh or finished account", () => {
    expect(backgroundCheckBlocked({ phase: "start" })).toBe(true);
    expect(backgroundCheckBlocked({ phase: "headers" })).toBe(true);
    expect(backgroundCheckBlocked({ phase: "done" })).toBe(false);
    expect(backgroundCheckBlocked(undefined)).toBe(false);
  });

  it("matches the backend's AuthFailed text, which crosses IPC as a string", () => {
    const engine: string = readFileSync("src-tauri/src/services/mail_engine.rs", "utf8");
    const display = engine.match(/MailError::AuthFailed => write!\(\s*f,\s*(?:concat!\()?"([^"\\]*)/);
    expect(display).not.toBeNull();
    expect(isAuthRejection(display![1])).toBe(true);
  });

  it("saving the account lifts the pause", () => {
    useMailStore.setState({ sync: { a: { phase: "error", error: rejected }, b: { phase: "done" } } });
    useMailStore.getState().clearSyncState("a");
    const { sync } = useMailStore.getState();
    expect(backgroundCheckBlocked(sync.a)).toBe(false);
    expect(sync.b).toEqual({ phase: "done" });
  });
});
