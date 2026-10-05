/**
 * The gate's **third outcome**, exercised rather than read.
 *
 * `browser_check_url` answers with three states packed into two fields:
 *
 * | gate    | `allowed` | `reason`      |
 * |---------|-----------|---------------|
 * | Allow   | `true`    | `undefined`   |
 * | Confirm | `true`    | `"loopback"` … |
 * | Block   | `false`   | `"app-origin"` … |
 *
 * The middle row is the one worth testing, because the two obvious readings of
 * it are both wrong: treating any `reason` as a block makes a developer's own
 * dev server unreachable, and treating `allowed: true` as a green light fetches
 * a loopback or private address with nobody deciding to — through, possibly, a
 * VPN tunnel Tabtivity is holding into a network the user's real browser cannot
 * see. What must happen is: park it, ask, and only then act.
 *
 * These tests drive the store directly with a faked invoke surface, so they
 * assert the *behaviour* (no fetch happens before the answer) rather than the
 * presence of a code path.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const checkUrl = vi.fn();
const readerFetch = vi.fn();
const openLive = vi.fn();

vi.mock("../../lib/browser", () => ({
  browserCheckUrl: (url: string) => checkUrl(url),
  browserReaderFetch: (url: string) => readerFetch(url),
  browserOpenLive: (url: string) => openLive(url),
  browserCloseLive: vi.fn(() => Promise.resolve()),
  browserClearData: vi.fn(() => Promise.resolve()),
  browserDownloadDecide: vi.fn(() => Promise.resolve({ saved: false })),
  browserListLive: vi.fn(() => Promise.resolve([])),
  browserCapabilities: vi.fn(() =>
    Promise.resolve({ live_windows_supported: true, reader_supported: true }),
  ),
}));

import { useBrowserStore, originKey } from "../../stores/browser";

const PAGE = {
  requested_url: "http://127.0.0.1:3000/",
  final_url: "http://127.0.0.1:3000/",
  display_url: "http://127.0.0.1:3000/",
  title: "Dev",
  html: "<p>ok</p>",
  security: {
    tls: "insecure" as const,
    scheme: "http",
    host_display: "127.0.0.1",
    vpn_active: false,
  },
  truncated: false,
  blocked_remote_assets: 0,
};

function reset() {
  checkUrl.mockReset();
  readerFetch.mockReset();
  openLive.mockReset();
  useBrowserStore.setState({
    byTab: {},
    capabilities: null,
    capabilitiesLoaded: false,
    live: [],
    liveState: {},
    liveBlocked: {},
    download: null,
    downloadNote: null,
    lastActiveKey: null,
  });
}

describe("originKey", () => {
  it("is host and port, and a different port is a different service", () => {
    expect(originKey("http://127.0.0.1:3000/x")).toBe("127.0.0.1:3000");
    expect(originKey("http://127.0.0.1:8080/x")).toBe("127.0.0.1:8080");
    expect(originKey("https://Example.COM/x")).toBe("example.com");
    // Unparseable never matches anything, so it can never grant access.
    expect(originKey("not a url")).toBe("");
  });
});

describe("a Confirm verdict parks the load", () => {
  beforeEach(reset);

  it("does not fetch, and shows the reason as a page state", async () => {
    checkUrl.mockResolvedValue({
      allowed: true,
      reason: "loopback",
      display_url: "http://127.0.0.1:3000/",
      scheme: "http",
      is_loopback: true,
    });
    const store = useBrowserStore.getState();
    store.ensureTab("t1", "", true);
    await store.load("t1", "http://127.0.0.1:3000/");

    const tab = useBrowserStore.getState().byTab.t1;
    expect(readerFetch, "nothing may be requested before the answer").not.toHaveBeenCalled();
    expect(tab.confirm).toEqual({
      url: "http://127.0.0.1:3000/",
      display_url: "http://127.0.0.1:3000/",
      reason: "loopback",
      mode: "reader",
    });
    // It is a question, not a failure: no error, no block, not spinning.
    expect(tab.blocked).toBeNull();
    expect(tab.error).toBeNull();
    expect(tab.loading).toBe(false);
  });

  it("fetches once the answer is yes, and remembers it for that tab only", async () => {
    checkUrl.mockResolvedValue({
      allowed: true,
      reason: "loopback",
      display_url: "http://127.0.0.1:3000/",
      scheme: "http",
      is_loopback: true,
    });
    readerFetch.mockResolvedValue(PAGE);

    const store = useBrowserStore.getState();
    store.ensureTab("t1", "", true);
    store.ensureTab("t2", "", true);
    await store.load("t1", "http://127.0.0.1:3000/");
    expect(readerFetch).not.toHaveBeenCalled();

    await useBrowserStore.getState().acceptConfirm("t1");
    expect(readerFetch).toHaveBeenCalledWith("http://127.0.0.1:3000/");
    let t1 = useBrowserStore.getState().byTab.t1;
    expect(t1.confirm).toBeNull();
    expect(t1.page).toEqual(PAGE);
    expect(t1.approved).toEqual(["127.0.0.1:3000"]);

    // A reload of the same origin in the SAME tab does not ask again.
    readerFetch.mockClear();
    await useBrowserStore.getState().load("t1", "http://127.0.0.1:3000/other");
    expect(readerFetch).toHaveBeenCalledTimes(1);
    t1 = useBrowserStore.getState().byTab.t1;
    expect(t1.confirm).toBeNull();

    // Another tab has granted nothing, so it asks for itself. A grant that
    // spread across tabs would be a trusted-sites list by another name.
    readerFetch.mockClear();
    await useBrowserStore.getState().load("t2", "http://127.0.0.1:3000/");
    expect(readerFetch).not.toHaveBeenCalled();
    expect(useBrowserStore.getState().byTab.t2.confirm?.reason).toBe("loopback");

    // And a different port on the same machine is a different service.
    await useBrowserStore.getState().load("t1", "http://127.0.0.1:9999/");
    expect(useBrowserStore.getState().byTab.t1.confirm?.url).toBe("http://127.0.0.1:9999/");
  });

  it("answering no requests nothing and remembers nothing", async () => {
    checkUrl.mockResolvedValue({
      allowed: true,
      reason: "private-network",
      display_url: "http://192.168.1.1/",
      scheme: "http",
      is_loopback: false,
    });
    const store = useBrowserStore.getState();
    store.ensureTab("t1", "", true);
    await store.load("t1", "http://192.168.1.1/");
    useBrowserStore.getState().cancelConfirm("t1");

    const tab = useBrowserStore.getState().byTab.t1;
    expect(readerFetch).not.toHaveBeenCalled();
    expect(tab.confirm).toBeNull();
    expect(tab.approved).toEqual([]);
  });

  it("a plain public URL is never asked about", async () => {
    checkUrl.mockResolvedValue({
      allowed: true,
      display_url: "https://example.com/",
      scheme: "https",
      is_loopback: false,
    });
    readerFetch.mockResolvedValue({ ...PAGE, final_url: "https://example.com/" });
    const store = useBrowserStore.getState();
    store.ensureTab("t1", "", true);
    await store.load("t1", "https://example.com/");
    expect(useBrowserStore.getState().byTab.t1.confirm).toBeNull();
    expect(readerFetch).toHaveBeenCalledOnce();
  });

  it("a refusal is still a refusal, with no way through it", async () => {
    checkUrl.mockResolvedValue({
      allowed: false,
      reason: "app-origin",
      display_url: "http://localhost:1420/",
      scheme: "http",
      is_loopback: true,
    });
    const store = useBrowserStore.getState();
    store.ensureTab("t1", "", true);
    await store.load("t1", "http://localhost:1420/");
    const tab = useBrowserStore.getState().byTab.t1;
    expect(tab.blocked?.reason).toBe("app-origin");
    expect(tab.confirm, "a block must never offer the confirm path").toBeNull();
    expect(readerFetch).not.toHaveBeenCalled();
  });
});

describe("the live-page control goes through the same gate", () => {
  beforeEach(reset);

  it("asks before opening a live window on a private address", async () => {
    checkUrl.mockResolvedValue({
      allowed: true,
      reason: "loopback",
      display_url: "http://127.0.0.1:3000/",
      scheme: "http",
      is_loopback: true,
    });
    openLive.mockResolvedValue({ label: "browser-0", display_url: "http://127.0.0.1:3000/" });

    const store = useBrowserStore.getState();
    store.ensureTab("t1", "", true);
    const err = await store.requestLive("t1", "http://127.0.0.1:3000/");
    expect(err).toBeNull();
    expect(openLive, "the live path must not skip the question").not.toHaveBeenCalled();
    expect(useBrowserStore.getState().byTab.t1.confirm?.mode).toBe("live");

    await useBrowserStore.getState().acceptConfirm("t1");
    expect(openLive).toHaveBeenCalledWith("http://127.0.0.1:3000/");
    expect(useBrowserStore.getState().live).toEqual([
      { label: "browser-0", display_url: "http://127.0.0.1:3000/" },
    ]);
  });

  it("refuses a blocked URL without opening anything", async () => {
    checkUrl.mockResolvedValue({
      allowed: false,
      reason: "scheme:file",
      display_url: "file:///etc/passwd",
      scheme: "file",
      is_loopback: false,
    });
    const store = useBrowserStore.getState();
    store.ensureTab("t1", "", true);
    await store.requestLive("t1", "file:///etc/passwd");
    expect(openLive).not.toHaveBeenCalled();
    expect(useBrowserStore.getState().byTab.t1.blocked?.reason).toBe("scheme:file");
  });
});

describe("a live window's block never lands on a reader tab", () => {
  beforeEach(reset);

  it("routes by window label, leaving the tab's page alone", () => {
    const store = useBrowserStore.getState();
    store.ensureTab("t1", "https://example.com/", true);
    useBrowserStore.setState((s) => ({
      lastActiveKey: "t1",
      byTab: { ...s.byTab, t1: { ...s.byTab.t1, page: PAGE } },
    }));

    useBrowserStore.getState().applyBlocked({
      display_url: "http://192.168.1.1/",
      reason: "private-network",
      window_label: "browser-0",
    });

    // The reader tab is untouched — it had nothing to do with this.
    expect(useBrowserStore.getState().byTab.t1.blocked).toBeNull();
    expect(useBrowserStore.getState().byTab.t1.page).toEqual(PAGE);
    expect(useBrowserStore.getState().liveBlocked["browser-0"].reason).toBe("private-network");

    // Closing the window drops its notice with it.
    useBrowserStore.getState().applyLiveClosed("browser-0");
    expect(useBrowserStore.getState().liveBlocked["browser-0"]).toBeUndefined();
  });

  it("falls back to the last active tab only when no window is named", () => {
    const store = useBrowserStore.getState();
    store.ensureTab("t1", "", true);
    useBrowserStore.setState({ lastActiveKey: "t1" });
    useBrowserStore.getState().applyBlocked({
      display_url: "https://example.com/",
      reason: "downgrade",
    });
    expect(useBrowserStore.getState().byTab.t1.blocked?.reason).toBe("downgrade");
  });
});
