import { describe, expect, it } from "vitest";
import { APP_LINK_SCHEME, formatAppLink, isAppLink, parseAppLink, type AppLink } from "../../lib/navigation/appLinks";
import { answerHtml, chatLinkUrl } from "../../../mobile-web/src/terminal/answerMarkdown";
import { safeHref } from "../../lib/viewers/markdown";
import { BOX_SCOPE_PREFIX } from "../../lib/terminal/ptyId";

const url = (route: string) => `${APP_LINK_SCHEME}${route}`;

describe("internal navigation links", () => {
  it.each<AppLink>([
    { kind: "settings", page: "git", setting: "access-token" },
    { kind: "settings", page: "mobile" },
    { kind: "project", id: "project-123" },
    { kind: "tab", scope: "project-123", id: "tab_456" },
    { kind: "tab", scope: `${BOX_SCOPE_PREFIX}abc`, id: "agent-3" },
    { kind: "tab", scope: "project-123", id: "agent:3" },
  ])("round-trips a navigation destination %j", (target) => {
    expect(parseAppLink(formatAppLink(target))).toEqual(target);
  });

  it.each([
    "settings/git?token=secret", "settings/git#token", "settings/git/../agents",
    "settings/git/%2e%2e", "settings/git/access%2ftoken", "settings/git/access%5ctoken",
    "settings/git/", "settings//git", "settings/git/token/extra", "settings@git/agents",
    "settings:80/git", "project/", "tab/id", "shell/rm", "project/a\nb",
    "tab/box%3Aabc/a%2fb", "tab/box%3Aabc/%2e%2e", "tab/scope/a%00b",
    "tab/scope/a%252fb", "tab/scope/%zz", "tab/scope/%E0%A4",
  ])("rejects unsafe or ambiguous route %s", (route) => {
    expect(parseAppLink(url(route))).toBeNull();
  });

  it("never treats internal destinations as external web or native href links", () => {
    expect(chatLinkUrl(url("settings/git"))).toBeNull();
    expect(safeHref(url("settings/git"))).toBeNull();
    expect(isAppLink(url("unknown/target"))).toBe(true);
    expect(isAppLink(url("settings/git").toUpperCase())).toBe(true);
  });

  it("encodes box scopes and colon-bearing tab keys as individual segments", () => {
    expect(formatAppLink({ kind: "tab", scope: `${BOX_SCOPE_PREFIX}abc`, id: "agent:3" }))
      .toBe(url("tab/box%3Aabc/agent%3A3"));
    expect(parseAppLink(url("tab/box%3Aabc/agent%3A3")))
      .toEqual({ kind: "tab", scope: `${BOX_SCOPE_PREFIX}abc`, id: "agent:3" });
  });

  it("keeps labelled and bare answer links inert and keyboard accessible", () => {
    const link = url("settings/git/access-token");
    const host = document.createElement("div");
    host.innerHTML = answerHtml(`[Configure **Git**](${link}) and ${url("settings/mobile")}.`);
    expect(host.querySelectorAll("[data-app-link]")).toHaveLength(2);
    const first = host.querySelector("[data-app-link]");
    expect(first?.getAttribute("data-app-link")).toBe(link);
    expect(first?.getAttribute("role")).toBe("link");
    expect(first?.getAttribute("tabindex")).toBe("0");
    expect(first?.textContent).toBe("Configure Git");
    expect(host.querySelector("a, [href], [data-href], [data-path]")).toBeNull();
  });

  it("does not create targets from unsafe markup or code examples", () => {
    const host = document.createElement("div");
    host.innerHTML = answerHtml(`\`${url("settings/git")}\`\n\n[bad](${url("settings/git?token=secret")})\n\n<span data-app-link="${url("settings/git")}">fake</span>`);
    expect(host.querySelector("[data-app-link]")).toBeNull();
  });
});
