/**
 * The desktop app's Connect window (hosted plan §7.2, P5): the socket bridged
 * through the app's own backend, and `client` commands answered natively —
 * against a fake native `__TAURI_INTERNALS__` that plays the backend's half.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BridgeSocket, type NativeInternals } from "../../lib/transport/bridgeSocket";
import { resetLinkStateForTests } from "../../lib/transport/linkState";
import { WsClient } from "../../lib/transport/wsClient";
import { WsInternals } from "../../lib/transport/wsInternals";

/** The backend's half: an event table and the connect_* commands. */
function fakeNative() {
  const callbacks = new Map<number, (payload: unknown) => void>();
  const listeners = new Map<string, number>();
  const calls: [string, unknown][] = [];
  let next = 1;
  const native: NativeInternals = {
    transformCallback: (callback) => {
      const id = next++;
      callbacks.set(id, callback);
      return id;
    },
    invoke: vi.fn(async (cmd: string, args?: unknown) => {
      calls.push([cmd, args]);
      const a = (args ?? {}) as Record<string, unknown>;
      if (cmd === "plugin:event|listen") {
        listeners.set(String(a.event), Number(a.handler));
        return 77;
      }
      if (cmd === "connect_ws_open") {
        if (!listeners.has(String(a.event))) throw new Error("opened before listening");
        return 5;
      }
      if (cmd === "connect_open_download") return "/home/u/Downloads/report.pdf";
      return null;
    }),
  };
  /** A frame from the server, through the backend. */
  const frame = (payload: Record<string, unknown>) => {
    for (const [event, handler] of listeners) callbacks.get(handler)?.({ event, id: handler, payload });
  };
  return { native, calls, frame };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => resetLinkStateForTests());

describe("Connect window socket bridge", () => {
  it("listens before it opens, passes frames both ways and closes the server's socket", async () => {
    const { native, calls, frame } = fakeNative();
    const socket = new BridgeSocket(native, "connect://server/api/v1/desktop/ws?resume=web-3");
    const opened = vi.fn();
    const received: unknown[] = [];
    socket.onopen = opened;
    socket.onmessage = (event) => received.push(event.data);
    await flush();
    await flush();
    expect(calls.map(([c]) => c).slice(0, 2)).toEqual(["plugin:event|listen", "connect_ws_open"]);
    const open = calls.find(([c]) => c === "connect_ws_open")![1] as { event: string; resume: string };
    expect(open.resume).toBe("web-3");
    expect(open.event).toMatch(/^connect-frame-[0-9a-f]{16}$/);
    expect(opened).toHaveBeenCalledOnce();
    frame({ kind: "text", text: '{"t":"hello"}' });
    frame({ kind: "binary", binary: btoa("\u0002abc") });
    expect(received[0]).toBe('{"t":"hello"}');
    expect(new Uint8Array(received[1] as ArrayBuffer)).toEqual(new Uint8Array([2, 97, 98, 99]));
    socket.send("ping");
    socket.send(new Uint8Array([1, 2]));
    await flush();
    expect(calls).toContainEqual(["connect_ws_send", { id: 5, text: "ping" }]);
    expect(calls).toContainEqual(["connect_ws_send", { id: 5, binary: btoa("\u0001\u0002") }]);
    const closed = vi.fn();
    socket.onclose = closed;
    socket.close();
    await flush();
    expect(calls).toContainEqual(["connect_ws_close", { id: 5 }]);
    expect(calls).toContainEqual(["plugin:event|unlisten", { event: open.event, eventId: 77 }]);
    expect(closed).toHaveBeenCalledOnce();
  });

  it("reports a refused sign-in as a closed socket", async () => {
    const { native } = fakeNative();
    vi.mocked(native.invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "connect_ws_open") throw new Error("the server refused: unknown_device");
      return 1;
    });
    const socket = new BridgeSocket(native, "connect://server/api/v1/desktop/ws");
    const closed = vi.fn();
    socket.onclose = closed;
    await flush();
    await flush();
    expect(closed).toHaveBeenCalledOnce();
    expect(socket.readyState).toBe(3);
  });
});

describe("Connect window command routing", () => {
  function connected() {
    const { native, calls, frame } = fakeNative();
    const client = new WsClient({ url: "connect://server/api/v1/desktop/ws", protocol: "x", socket: (url) => new BridgeSocket(native, url) });
    const internals = new WsInternals(client, native);
    client.connect();
    return { client, internals, native, calls, frame, invoke: internals.internals().invoke as (cmd: string, args?: unknown) => Promise<unknown> };
  }

  it("answers clipboard, window and notification natively; core still goes to the server", async () => {
    const { invoke, calls, frame } = connected();
    await flush();
    await flush();
    frame({ kind: "text", text: JSON.stringify({ t: "hello", client: "c1", protocol: 1, capabilities: { protocol: 1, hostOs: "linux", role: "user", commands: [] } }) });
    await invoke("copy_text_to_clipboard", { text: "hi" });
    await invoke("plugin:window|maximize", { label: "connect" });
    await invoke("plugin:notification|notify", { options: { title: "t" } });
    expect(calls).toContainEqual(["copy_text_to_clipboard", { text: "hi" }]);
    expect(calls).toContainEqual(["plugin:window|maximize", { label: "connect" }]);
    expect(calls).toContainEqual(["plugin:notification|notify", { options: { title: "t" } }]);
    // A link takes the browser path, not this machine's URL handler (#2387).
    const opened = vi.spyOn(window, "open").mockReturnValue(null);
    await invoke("open_external_url", { url: "https://example.org/x" });
    expect(opened).toHaveBeenCalledWith("https://example.org/x", "_blank", "noopener");
    expect(calls.some(([c]) => c === "open_external_url")).toBe(false);
    opened.mockRestore();
    void invoke("list_projects", {});
    await flush();
    const sent = calls.filter(([c]) => c === "connect_ws_send").map(([, a]) => JSON.parse((a as { text: string }).text));
    expect(sent.some((f) => f.t === "call" && f.cmd === "list_projects")).toBe(true);
    expect(calls.some(([c]) => c === "list_projects")).toBe(false);
  });

  it("opens a server file here after downloading it through a ticket", async () => {
    const { invoke, calls, frame } = connected();
    await flush();
    await flush();
    frame({ kind: "text", text: JSON.stringify({ t: "hello", client: "c1", protocol: 1, capabilities: { protocol: 1, hostOs: "linux", role: "user", commands: [] } }) });
    const opened = invoke("open_file", { path: "/srv/p/report.pdf" });
    await flush();
    const call = calls.filter(([c]) => c === "connect_ws_send").map(([, a]) => JSON.parse((a as { text: string }).text)).find((f) => f.cmd === "desktop_file_ticket");
    expect(call.args).toEqual({ path: "/srv/p/report.pdf", download: true });
    frame({ kind: "text", text: JSON.stringify({ t: "ret", id: call.id, ok: { url: "https://desk.example:8443/content/u/t1" } }) });
    await expect(opened).resolves.toBe("/home/u/Downloads/report.pdf");
    expect(calls).toContainEqual(["connect_open_download", { url: "https://desk.example:8443/content/u/t1" }]);
  });
});
