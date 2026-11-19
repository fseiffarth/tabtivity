import { describe, expect, it } from "vitest";
import { settingsLinkTarget, settingsLinkTargets, searchSettings } from "../../components/layout/settingsIndex";
import { translate } from "../../lib/i18n";
import { parseAppLink } from "../../lib/navigation/appLinks";

const t = (key: Parameters<typeof translate>[1], params?: Record<string, string | number>) => translate("en", key, params);

describe("settings links", () => {
  it("maps the token destination to the existing token label", () => {
    const target = settingsLinkTarget("git", "access-token", t);
    expect(target?.path).toEqual([t("git.accessToken")]);
    expect(parseAppLink(target?.url)).toEqual({ kind: "settings", page: "git", setting: "access-token" });
  });
  it("publishes unique, parseable destinations for every indexed control", () => {
    const targets = settingsLinkTargets(t);
    expect(new Set(targets.map((target) => target.url)).size).toBe(targets.length);
    for (const target of targets) expect(parseAppLink(target.url)).not.toBeNull();
  });
  it("keeps provider keys distinct and preserves fold reveal paths", () => {
    const providers = settingsLinkTargets(t).filter((target) => target.id?.startsWith("settings.searchProviderKey."));
    expect(providers.length).toBeGreaterThan(1);
    for (const provider of providers) expect(provider.path?.[0]).toBe(t("agents.groupAccounts"));
  });
  it("falls back from an obsolete control to its page but rejects unknown pages", () => {
    expect(settingsLinkTarget("git", "removed-control", t)?.id).toBeUndefined();
    expect(settingsLinkTarget("missing-page", undefined, t)).toBeUndefined();
  });
  it("attaches exact destinations to search hits", () => {
    const hits = searchSettings("access token", t, () => true);
    expect(hits.some((hit) => parseAppLink(hit.url)?.kind === "settings" && hit.path?.includes(t("git.accessToken")))).toBe(true);
  });
});
