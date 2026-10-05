/**
 * `routeUri` and `parseAddressInput` — the URI routing table and the address
 * bar's commit rule (TODO group J #33 + #61).
 *
 * Both are pure and total, which is the whole reason they live in
 * `src/lib/linkTarget.ts` rather than inside a click handler: the rule that
 * decides where a link goes is exactly the kind of thing that quietly acquires
 * an exception, and a table test is the cheapest way to notice.
 */
import { describe, it, expect } from "vitest";
import { parseAddressInput, routeUri, type RouteContext } from "../../lib/linkTarget";
import { BRAND } from "../../lib/brand";

const ctx = (over: Partial<RouteContext> = {}): RouteContext => ({
  setting: "external",
  browserEnabled: true,
  mailEnabled: true,
  origin: "terminal",
  ...over,
});

describe("routeUri — schemes", () => {
  it("refuses everything that is not http, https, mailto or webcal", () => {
    for (const uri of [
      "file:///etc/passwd",
      "javascript:alert(1)",
      "JaVaScRiPt:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "blob:https://example.com/uuid",
      "ws://example.com/",
      "ftp://example.com/",
      "smb://host/share",
      "vbscript:msgbox",
      "chrome://settings",
      "moz-extension://x/y",
      "ms-msdt:/id",
      "search-ms:query=x",
      "intent://x#Intent;end",
      `${BRAND.slug}-nonsense://x`,
      "view-source:https://example.com/",
    ]) {
      expect(routeUri(uri, ctx()).kind, uri).toBe("refuse");
    }
  });

  it("sees through tabs and newlines inside a scheme", () => {
    // The WHATWG parser strips these, so the check must too — otherwise the
    // gate reads a different string than the engine would.
    expect(routeUri("java\tscript:alert(1)", ctx()).kind).toBe("refuse");
    expect(routeUri("java\nscript:alert(1)", ctx()).kind).toBe("refuse");
  });

  it("routes mailto: to the internal composer when mail is enabled", () => {
    expect(routeUri("mailto:someone@example.com?subject=hi", ctx())).toEqual({
      kind: "compose",
      address: "someone@example.com",
    });
  });

  it("routes mailto: to the configured mail app when the client is off", () => {
    const target = routeUri("mailto:someone@example.com", ctx({ mailEnabled: false }));
    expect(target).toMatchObject({ kind: "global_app", role: "mail" });
  });

  it("routes webcal: to the calendar app", () => {
    expect(routeUri("webcal://example.com/a.ics", ctx())).toMatchObject({
      kind: "global_app",
      role: "calendar",
    });
  });

  it("refuses an empty string rather than throwing", () => {
    expect(routeUri("", ctx()).kind).toBe("refuse");
    expect(routeUri("   ", ctx()).kind).toBe("refuse");
  });
});

describe("routeUri — the decision order", () => {
  it(`always sends ${BRAND.display}'s own URLs to the external browser`, () => {
    // An auth flow routed into a fresh, ephemeral profile just means logging in
    // again in the wrong place. This wins over the setting AND over a gesture.
    for (const setting of ["in_app", "ask", "external"] as const) {
      expect(routeUri("https://example.com/oauth", ctx({ origin: "app", setting }))).toEqual({
        kind: "external",
        url: "https://example.com/oauth",
      });
    }
    expect(
      routeUri("https://example.com/oauth", { ...ctx({ origin: "app" }), explicit: "in_app" }),
    ).toMatchObject({ kind: "external" });
  });

  it("lets an explicit gesture beat the setting in both directions", () => {
    expect(
      routeUri("https://example.com/", ctx({ setting: "external", explicit: "in_app" })),
    ).toMatchObject({ kind: "in_app", mode: "reader" });
    expect(
      routeUri("https://example.com/", ctx({ setting: "in_app", explicit: "external" })),
    ).toMatchObject({ kind: "external" });
  });

  it("falls back to external when the browser is disabled, gesture or not", () => {
    for (const explicit of [undefined, "in_app", "live"] as const) {
      expect(
        routeUri("https://example.com/", ctx({ browserEnabled: false, setting: "in_app", explicit })),
      ).toMatchObject({ kind: "external" });
    }
  });

  it("defaults to external — the user's own browser has their sign-ins", () => {
    expect(routeUri("https://example.com/", ctx({ setting: undefined }))).toMatchObject({
      kind: "external",
    });
  });

  it("uses the configured browser app when the user set one", () => {
    expect(
      routeUri("https://example.com/", ctx({ setting: "external", browserRoleConfigured: true })),
    ).toMatchObject({ kind: "global_app", role: "browser" });
  });

  it("shows the chooser on 'ask'", () => {
    expect(routeUri("https://example.com/", ctx({ setting: "ask" }))).toEqual({
      kind: "ask",
      url: "https://example.com/",
    });
  });
});

describe("parseAddressInput — the commit rule", () => {
  const SEARCH = "https://duckduckgo.com/?q=%s";

  it("navigates an absolute http(s) URL", () => {
    expect(parseAddressInput("https://example.com/a?b=1", SEARCH)).toEqual({
      kind: "url",
      url: "https://example.com/a?b=1",
    });
  });

  it("prefixes https:// onto a bare host", () => {
    expect(parseAddressInput("example.com", SEARCH)).toEqual({
      kind: "url",
      url: "https://example.com/",
    });
    expect(parseAddressInput("example.com/docs", SEARCH)).toMatchObject({
      kind: "url",
      url: "https://example.com/docs",
    });
  });

  it("treats localhost with a port as a host, not a scheme", () => {
    // `localhost:5173` matches the shape of `scheme:rest`; a numeric body is a
    // port, and reading it as a scheme is how a dev-server address gets refused.
    expect(parseAddressInput("localhost:5173", SEARCH)).toMatchObject({
      kind: "url",
      url: "https://localhost:5173/",
    });
  });

  it("never navigates a non-web scheme typed by hand", () => {
    for (const text of [
      "file:///etc/passwd",
      "javascript:alert(1)",
      "data:text/html,x",
      "blob:https://example.com/u",
    ]) {
      const result = parseAddressInput(text, SEARCH);
      expect(result.kind, text).toBe("refuse");
      if (result.kind === "refuse") expect(result.reason).toBe("scheme");
    }
  });

  it("sends non-URL text to the configured search engine, percent-encoded", () => {
    expect(parseAddressInput("how do i tile a window", SEARCH)).toEqual({
      kind: "search",
      url: "https://duckduckgo.com/?q=how%20do%20i%20tile%20a%20window",
    });
  });

  it("refuses non-URL text when no search engine is configured", () => {
    // The conservative reading of this repo's defaults: with no template, typed
    // text is never sent to a third party.
    const result = parseAddressInput("how do i tile a window", "");
    expect(result).toEqual({ kind: "refuse", reason: "not_a_url" });
  });

  it("reports an empty field as empty rather than as a refusal", () => {
    expect(parseAddressInput("  ", SEARCH)).toEqual({ kind: "empty" });
  });
});
