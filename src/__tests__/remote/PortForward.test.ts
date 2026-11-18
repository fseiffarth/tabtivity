import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import {
  forwardAndOpen,
  hostLabelOf,
  parseForwardInput,
  portForwardErrorText,
  resetForwardConfirmations,
} from "../../lib/remote/portForward";
import type { ProjectEntry } from "../../types";

const target = { projectId: "p1", hostId: "primary", remoteHost: "localhost", remotePort: 8888 };
const page = { scheme: "http" as const, pathAndQuery: "/lab?token=abc" };

beforeEach(() => {
  invoke.mockReset();
  resetForwardConfirmations();
});

describe("parseForwardInput", () => {
  it("reads a bare port as the host's loopback and host:port as named", () => {
    expect(parseForwardInput("6006")).toEqual({ remoteHost: "localhost", remotePort: 6006 });
    expect(parseForwardInput(" node042:6006 ")).toEqual({ remoteHost: "node042", remotePort: 6006 });
    expect(parseForwardInput("[::1]:8888")).toEqual({ remoteHost: "::1", remotePort: 8888 });
  });
  it("refuses nonsense, port 0, a too-large port and a leading dash", () => {
    for (const bad of ["", "0", "65536", "abc", "host", "-oProxyCommand=x:22", "a b:1", "host:0", "host:99999"]) {
      expect(parseForwardInput(bad), bad).toBeNull();
    }
  });
});

describe("forwardAndOpen", () => {
  it("asks once per key, forwards, and opens the forwarded page on 127.0.0.1", async () => {
    invoke.mockImplementation((cmd: string) =>
      cmd === "port_forward_open" ? Promise.resolve({ id: "1", localPort: 9001, reused: false }) : Promise.resolve(undefined),
    );
    const confirm = vi.fn().mockResolvedValue(true);
    const notify = vi.fn();
    const first = await forwardAndOpen({ target, page, tabUid: "p1:t1", confirm, notify });
    expect(first).toBe(9001);
    expect(invoke).toHaveBeenCalledWith("port_forward_open", {
      projectId: "p1", hostId: "primary", tabUid: "p1:t1", remoteHost: "localhost", remotePort: 8888,
    });
    expect(invoke).toHaveBeenCalledWith("open_external_url", { url: "http://127.0.0.1:9001/lab?token=abc" });
    await forwardAndOpen({ target, page, tabUid: "p1:t1", confirm, notify });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(notify).not.toHaveBeenCalled();
  });

  it("does nothing when the user declines", async () => {
    const out = await forwardAndOpen({ target, page, tabUid: "t", confirm: () => Promise.resolve(false), notify: vi.fn() });
    expect(out).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("forwards without opening when asked, and says a refusal in words", async () => {
    invoke.mockRejectedValueOnce("port-forward:not-connected");
    const notify = vi.fn();
    const out = await forwardAndOpen({ target, page, tabUid: "t", confirm: () => Promise.resolve(true), notify, open: false });
    expect(out).toBeNull();
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("not connected"));
    expect(invoke).not.toHaveBeenCalledWith("open_external_url", expect.anything());
  });
});

describe("forwardAndOpen: a failed open", () => {
  it("never puts the page's token into the message it shows", async () => {
    invoke.mockImplementation((cmd: string) =>
      cmd === "port_forward_open"
        ? Promise.resolve({ id: "1", localPort: 9001, reused: false })
        : Promise.reject(new Error("failed to open http://127.0.0.1:9001/lab?token=SECRET: no browser")),
    );
    const notify = vi.fn();
    const out = await forwardAndOpen({ target, page, tabUid: "t", confirm: () => Promise.resolve(true), notify });
    expect(out).toBeNull();
    expect(notify).toHaveBeenCalledTimes(1);
    const shown = String(notify.mock.calls[0][0]);
    expect(shown).not.toContain("SECRET");
    expect(shown).not.toContain("127.0.0.1");
    expect(shown).toContain("no browser");
  });
});

describe("portForwardErrorText", () => {
  it("translates the backend tokens and passes anything else through", () => {
    expect(portForwardErrorText("port-forward:unsupported-os")).toContain("Windows");
    expect(portForwardErrorText("port-forward:failed: mux error")).toContain("mux error");
    expect(portForwardErrorText("something else")).toBe("something else");
  });
});

describe("hostLabelOf", () => {
  it("names the primary by its label and a worker by its own", () => {
    const project = {
      id: "p1",
      name: "Proj",
      remote: { host: "login.example.com", label: "cluster-a" },
      compute_hosts: [{ id: "h2", host: "gpu.example.com" }],
    } as unknown as ProjectEntry;
    expect(hostLabelOf(project, "primary")).toBe("cluster-a");
    expect(hostLabelOf(project, "h2")).toBe("gpu.example.com");
    expect(hostLabelOf(undefined, "h9")).toBe("h9");
  });
});
