/**
 * #12 (screen 2026-10-15): a browser client's ssh login to a host a non-admin
 * browser account stored is refused until the desktop or an admin allows it.
 * The refusal carries the backend's `SSH_LOGIN_UNAPPROVED` marker so the pane
 * says why in the user's language instead of dumping the raw error.
 */
import { describe, it, expect } from "vitest";
import { BRAND } from "../../lib/brand";
import { loginHostUnapproved, SSH_LOGIN_UNAPPROVED } from "../../lib/remote/loginTarget";

describe("loginHostUnapproved", () => {
  it("mirrors the backend's marker", () => {
    expect(SSH_LOGIN_UNAPPROVED).toBe(`${BRAND.envPrefix}SSH_LOGIN_UNAPPROVED`);
  });

  it("recognises the refusal, as a string or an Error", () => {
    const text = `${BRAND.envPrefix}SSH_LOGIN_UNAPPROVED a browser account stored this host`;
    expect(loginHostUnapproved(text)).toBe(true);
    expect(loginHostUnapproved(new Error(text))).toBe(true);
  });

  it("leaves every other spawn error alone", () => {
    expect(
      loginHostUnapproved("a browser client may open an ssh login only to a host a remote project or machine names"),
    ).toBe(false);
    expect(loginHostUnapproved(undefined)).toBe(false);
  });
});
