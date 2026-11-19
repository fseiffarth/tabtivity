import { describe, it, expect, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

import { hasTokenFor, hostProvider, saveGitHosts, type GitHostEntry } from "../../lib/gitHosts";

const hosts: GitHostEntry[] = [
  { profile_url: "https://github.com/me", origin: "https://github.com", has_token: false },
  { profile_url: "https://gitlab.example.org/me", origin: "https://gitlab.example.org", has_token: true },
];

describe("git hosts", () => {
  it("reads the provider off the profile URL", () => {
    expect(hostProvider("https://gitlab.example.org/me")).toBe("gitlab");
    expect(hostProvider("https://github.com/me")).toBe("github");
    expect(hostProvider("")).toBe("github");
  });

  it("counts a provider as connected only when one of its hosts has a token", () => {
    expect(hasTokenFor(hosts, "gitlab")).toBe(true);
    expect(hasTokenFor(hosts, "github")).toBe(false);
    expect(hasTokenFor(null, "github")).toBe(false);
  });

  it("saves the rows in the backend's camelCase shape and returns its answer", async () => {
    invoke.mockResolvedValueOnce(hosts);
    const saved = await saveGitHosts([{ profileUrl: "https://github.com/me", token: "t", clearToken: false }]);
    expect(invoke).toHaveBeenCalledWith("set_git_hosts", {
      hosts: [{ profileUrl: "https://github.com/me", token: "t", clearToken: false }],
    });
    expect(saved).toEqual(hosts);
  });
});
