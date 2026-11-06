import { describe, expect, it } from "vitest";
import { isLoopbackHostname, routeLink, tabLocality, type TabLocality } from "../../lib/terminal/linkRoute";

const remote: TabLocality = { kind: "remote", projectId: "p1", hostId: "primary" };

describe("routeLink", () => {
  it("opens every link of a local tab as before", () => {
    expect(routeLink("http://localhost:8888/lab", { kind: "local" })).toBe("external");
    expect(routeLink("https://example.com/", { kind: "local" })).toBe("external");
  });

  it("forwards a loopback link of a remote tab to that host, with the port and the page", () => {
    expect(routeLink("http://localhost:8888/lab?token=abc", remote)).toEqual({
      forward: { projectId: "p1", hostId: "primary", remoteHost: "localhost", remotePort: 8888, scheme: "http", pathAndQuery: "/lab?token=abc" },
    });
    expect(routeLink("http://0.0.0.0:6006/", { kind: "remote", projectId: "p1", hostId: "h2" })).toMatchObject({
      forward: { hostId: "h2", remoteHost: "127.0.0.1", remotePort: 6006 },
    });
  });

  it("forwards a node name with a port from the login host", () => {
    expect(routeLink("http://node042:8888/lab", remote)).toMatchObject({ forward: { remoteHost: "node042", remotePort: 8888 } });
  });

  it("never opens this machine's port for a loopback link, even one with no port", () => {
    expect(routeLink("http://localhost/", remote)).toMatchObject({ forward: { remotePort: 80 } });
    expect(routeLink("http://localhost:8888/", { kind: "container" })).toBe("unsupported");
    expect(routeLink("http://127.0.0.1:8888/", { kind: "unknown" })).toBe("unsupported");
  });

  it("never opens this machine's port for a loopback spelling the clean parse does not take", () => {
    const spellings = [
      "http://localhost.:8888/",
      "http://LOCALHOST.:8888/lab?token=x",
      "http://app.localhost:8888/",
      "http://localhost.localdomain:8888/",
      "http://user:pw@localhost:8888/",
      "http://user@127.0.0.1:8888/",
      "http://[::ffff:127.0.0.1]:8888/",
      "http://[::ffff:7f00:1]:8888/",
      "http://[::ffff:0.0.0.0]:8888/",
      "http://local%68ost.:8888/",
    ];
    for (const url of spellings) {
      expect(routeLink(url, remote), url).toBe("unsupported");
      expect(routeLink(url, { kind: "container" }), url).toBe("unsupported");
      expect(routeLink(url, { kind: "unknown" }), url).toBe("unsupported");
      expect(routeLink(url, { kind: "local" }), url).toBe("external");
    }
    // A name that only looks like a loopback stays an ordinary link.
    expect(routeLink("https://notlocalhost.example.com/", remote)).toBe("external");
    expect(routeLink("https://localhost.example.com:8443/", remote)).toBe("external");
  });

  it("isLoopbackHostname: the loopback in every spelling, and nothing else", () => {
    for (const yes of ["localhost", "localhost.", "[::1]", "::", "127.1.2.3", "0.0.0.0", "a.localhost"]) {
      expect(isLoopbackHostname(yes), yes).toBe(true);
    }
    for (const no of ["example.com", "localhost.example.com", "192.0.2.1", "[2001:db8::1]", "node042", "mylocalhost"]) {
      expect(isLoopbackHostname(no), no).toBe(false);
    }
  });

  it("opens a public link of a remote or container tab in the browser", () => {
    expect(routeLink("https://example.com/docs", remote)).toBe("external");
    expect(routeLink("https://example.com:8443/", remote)).toBe("external");
    expect(routeLink("http://node042/", remote)).toBe("external");
    expect(routeLink("https://example.com/", { kind: "container" })).toBe("external");
    expect(routeLink("mailto:a@example.com", remote)).toBe("external");
  });

  it("opens everything externally when the tab's locality is missing, never guessing", () => {
    expect(routeLink("http://localhost:8888/", undefined)).toBe("external");
  });
});

describe("tabLocality", () => {
  const base = {
    projectId: "p1",
    localOnly: false,
    sandbox: false,
    remoteHostId: "primary" as string | null,
    login: false,
    hostSession: false,
    project: { remote: true, workerIds: ["h2"] },
  };

  it("is remote for a non-local tab of a remote project, on the asked host or the primary", () => {
    expect(tabLocality(base)).toEqual({ kind: "remote", projectId: "p1", hostId: "primary" });
    expect(tabLocality({ ...base, remoteHostId: "h2" })).toEqual({ kind: "remote", projectId: "p1", hostId: "h2" });
    // A worker that no longer resolves falls back to the primary, like the backend's spawn.
    expect(tabLocality({ ...base, remoteHostId: "gone" })).toEqual({ kind: "remote", projectId: "p1", hostId: "primary" });
    expect(tabLocality({ ...base, remoteHostId: null })).toEqual({ kind: "remote", projectId: "p1", hostId: "primary" });
  });

  it("is local for a local project, a local-only tab and a tab with no project", () => {
    // A shell tab of a local project carries remoteHostId "primary" too.
    expect(tabLocality({ ...base, project: { remote: false, workerIds: [] } })).toEqual({ kind: "local" });
    expect(tabLocality({ ...base, localOnly: true })).toEqual({ kind: "local" });
    expect(tabLocality({ ...base, projectId: null })).toEqual({ kind: "local" });
    expect(tabLocality({ ...base, projectId: "box:b1", project: null })).toEqual({ kind: "local" });
    expect(tabLocality({ ...base, projectId: "assistant", project: null })).toEqual({ kind: "local" });
    expect(tabLocality({ ...base, login: true })).toEqual({ kind: "local" });
    expect(tabLocality({ ...base, hostSession: true })).toEqual({ kind: "local" });
  });

  it("is a container for a sandbox tab, and unknown when the project is not loaded", () => {
    expect(tabLocality({ ...base, sandbox: true, project: { remote: false, workerIds: [] } })).toEqual({ kind: "container" });
    expect(tabLocality({ ...base, project: null })).toEqual({ kind: "unknown" });
    // A local-only tab in a sandbox project is still on this machine.
    expect(tabLocality({ ...base, sandbox: true, localOnly: true })).toEqual({ kind: "local" });
  });
});
