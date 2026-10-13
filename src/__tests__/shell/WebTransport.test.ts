/**
 * The browser desktop client's transport (hosted plan §3.5, §11 "the shim
 * against a fake daemon"): the `__TAURI_INTERNALS__` shim over `WsClient`,
 * driven through a fake socket that plays the server's half of the protocol.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DisconnectedError, linkState, resetLinkStateForTests } from "../../lib/transport/linkState";
import { KIND_CALL, KIND_RET, WsClient, type SocketLike } from "../../lib/transport/wsClient";
import { WsInternals } from "../../lib/transport/wsInternals";
import { pausePollersWhileDown, socketUrl } from "../../lib/transport/installWeb";
import { setDialogAdapter } from "../../lib/transport/dialogAdapter";

class FakeSocket implements SocketLike {
  static instances: FakeSocket[] = [];
  readyState = 0;
  binaryType = "";
  onopen: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  sent: (string | Uint8Array)[] = [];
  constructor(public url: string, public protocol: string) {
    FakeSocket.instances.push(this);
  }
  send(data: string | ArrayBuffer | Uint8Array) {
    this.sent.push(typeof data === "string" ? data : data instanceof Uint8Array ? data : new Uint8Array(data));
  }
  close() {
    this.readyState = 3;
    this.onclose?.({});
  }
  // ── the server's half ──
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  hello(client = "web-1") {
    this.onmessage?.({ data: JSON.stringify({ t: "hello", client, protocol: 1, capabilities: { protocol: 1, hostOs: "linux", role: "admin", commands: [] } }) });
  }
  text(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  binaryRet(id: number, bytes: Uint8Array) {
    const frame = new Uint8Array(5 + bytes.byteLength);
    frame[0] = KIND_RET;
    new DataView(frame.buffer).setUint32(1, id);
    frame.set(bytes, 5);
    this.onmessage?.({ data: frame.buffer });
  }
  textFrames(): Record<string, unknown>[] {
    return this.sent.filter((f): f is string => typeof f === "string").map((f) => JSON.parse(f));
  }
}

function connected() {
  const scheduled: Array<() => void> = [];
  const client = new WsClient({
    url: "ws://127.0.0.1:8742/api/v1/desktop/ws",
    protocol: "x-desktop.v1",
    socket: (url, protocol) => new FakeSocket(url, protocol),
    schedule: (fn) => void scheduled.push(fn),
  });
  const internals = new WsInternals(client);
  client.connect();
  const socket = FakeSocket.instances[FakeSocket.instances.length - 1];
  socket.open();
  socket.hello();
  const invoke = internals.internals().invoke as (cmd: string, args?: unknown, options?: unknown) => Promise<unknown>;
  return { client, internals, socket, invoke, scheduled };
}

beforeEach(() => {
  FakeSocket.instances = [];
  resetLinkStateForTests();
});

afterEach(() => {
  setDialogAdapter(null);
});

describe("the browser transport", () => {
  it("offers the subprotocol, waits for hello, and is up", async () => {
    const { client, socket } = connected();
    expect(socket.protocol).toBe("x-desktop.v1");
    expect(client.up).toBe(true);
    expect(client.clientId).toBe("web-1");
    expect(linkState()).toBe("up");
    expect((await client.whenReady()).capabilities.hostOs).toBe("linux");
  });

  it("sends a call frame and resolves or rejects by id", async () => {
    const { socket, invoke } = connected();
    const ok = invoke("agent_is_installed", { id: "claude" });
    const bad = invoke("pty_write", { id: "p", data: new Uint8Array([104, 105]) });
    const [first, second] = socket.textFrames();
    expect(first).toEqual({ t: "call", id: 1, cmd: "agent_is_installed", args: { id: "claude" } });
    // Bytes in arguments travel as arrays, as Tauri's own IPC sends them.
    expect(second.args).toEqual({ id: "p", data: [104, 105] });
    socket.text({ t: "ret", id: 2, err: "no such pty" });
    socket.text({ t: "ret", id: 1, ok: true });
    await expect(ok).resolves.toBe(true);
    await expect(bad).rejects.toBe("no such pty");
  });

  it("refuses client and off commands locally, by the generated class table", async () => {
    const { socket, invoke } = connected();
    await expect(invoke("capture_screenshot", {})).rejects.toMatchObject({ code: "client", command: "capture_screenshot" });
    await expect(invoke("save_settings", {})).rejects.toMatchObject({ code: "off", reason: "whole-document-save" });
    expect(socket.textFrames()).toEqual([]);
    // A client command with a browser form is answered here.
    await expect(invoke("list_recent_downloads", { paths: [] })).resolves.toEqual([]);
  });

  it("subscribes once per event name and delivers to every listener", async () => {
    const { internals, socket, invoke } = connected();
    const seen: unknown[] = [];
    const a = internals.transformCallback((e) => seen.push(["a", (e as { payload: unknown }).payload]), false);
    const b = internals.transformCallback((e) => seen.push(["b", (e as { payload: unknown }).payload]), false);
    await invoke("plugin:event|listen", { event: "workspace:patch", target: { kind: "Any" }, handler: a });
    await invoke("plugin:event|listen", { event: "workspace:patch", target: { kind: "Any" }, handler: b });
    expect(socket.textFrames()).toEqual([{ t: "sub", name: "workspace:patch" }]);
    socket.text({ t: "event", name: "workspace:patch", payload: { v: 2 } });
    expect(seen).toEqual([["a", { v: 2 }], ["b", { v: 2 }]]);
    await invoke("plugin:event|unlisten", { event: "workspace:patch", eventId: a });
    expect(socket.textFrames().filter((f: Record<string, unknown>) => f.t === "unsub")).toEqual([]);
    (internals.eventInternals().unregisterListener as (e: string, id: number) => void)("workspace:patch", b);
    expect(socket.textFrames().filter((f: Record<string, unknown>) => f.t === "unsub")).toEqual([{ t: "unsub", name: "workspace:patch" }]);
    socket.text({ t: "event", name: "workspace:patch", payload: { v: 3 } });
    expect(seen).toHaveLength(2);
  });

  it("a frontend emit reaches this page's listeners and the server", async () => {
    const { internals, socket, invoke } = connected();
    const seen: unknown[] = [];
    const id = internals.transformCallback((e) => seen.push((e as { payload: unknown }).payload), false);
    await invoke("plugin:event|listen", { event: "detached-seed", target: { kind: "Any" }, handler: id });
    await invoke("plugin:event|emit", { event: "detached-seed", payload: { key: 1 } });
    expect(seen).toEqual([{ key: 1 }]);
    const frames = socket.textFrames();
    expect(frames[frames.length - 1]).toEqual({ t: "emit", name: "detached-seed", payload: { key: 1 } });
  });

  it("carries a bytes body as a binary frame and a raw answer back as an ArrayBuffer", async () => {
    const { socket, invoke } = connected();
    const write = invoke("write_file_bytes", new Uint8Array([1, 2, 3]), { headers: { "x-path": "%2Ftmp%2Fa" } });
    const frame = socket.sent[0] as Uint8Array;
    expect(frame[0]).toBe(KIND_CALL);
    const view = new DataView(frame.buffer, frame.byteOffset);
    const id = view.getUint32(1);
    const hlen = view.getUint32(5);
    const header = JSON.parse(new TextDecoder().decode(frame.slice(9, 9 + hlen)));
    expect(header).toEqual({ cmd: "write_file_bytes", headers: { "x-path": "%2Ftmp%2Fa" } });
    expect([...frame.slice(9 + hlen)]).toEqual([1, 2, 3]);
    socket.text({ t: "ret", id, ok: null });
    await expect(write).resolves.toBeNull();

    const read = invoke("read_file_bytes", { path: "/tmp/a", projectId: null });
    const sentFrames = socket.textFrames();
    const readId = (sentFrames[sentFrames.length - 1] as { id: number }).id;
    socket.binaryRet(readId, new Uint8Array([9, 8]));
    const out = (await read) as ArrayBuffer;
    expect(out).toBeInstanceOf(ArrayBuffer);
    expect([...new Uint8Array(out)]).toEqual([9, 8]);
  });

  it("rejects pending and new calls while down, then resumes with its id and its subscriptions", async () => {
    const { client, socket, invoke, scheduled } = connected();
    await invoke("plugin:event|listen", { event: "terminal-output", target: { kind: "Any" }, handler: 1 });
    const pending = invoke("pty_scrollback", { id: "p" });
    socket.close();
    expect(linkState()).toBe("down");
    await expect(pending).rejects.toBeInstanceOf(DisconnectedError);
    await expect(invoke("pty_write", { id: "p", data: [] })).rejects.toMatchObject({ code: "disconnected" });
    expect(client.up).toBe(false);
    // The backoff timer fires: a new socket, asking to resume the old id.
    expect(scheduled).toHaveLength(1);
    scheduled[0]();
    const next = FakeSocket.instances[FakeSocket.instances.length - 1];
    expect(next).not.toBe(socket);
    expect(next.url).toBe("ws://127.0.0.1:8742/api/v1/desktop/ws?resume=web-1");
    expect(linkState()).toBe("connecting");
    next.open();
    next.hello("web-1");
    expect(linkState()).toBe("up");
    expect(next.textFrames()).toEqual([{ t: "sub", name: "terminal-output" }]);
  });

  it("pauses interval pollers while the link is down", () => {
    const { socket, scheduled } = connected();
    vi.useFakeTimers();
    const target = { setInterval: globalThis.setInterval.bind(globalThis) } as unknown as Pick<Window, "setInterval">;
    pausePollersWhileDown(target);
    const ticks = vi.fn();
    target.setInterval(ticks, 100);
    vi.advanceTimersByTime(250);
    expect(ticks).toHaveBeenCalledTimes(2);
    socket.close();
    vi.advanceTimersByTime(300);
    expect(ticks).toHaveBeenCalledTimes(2);
    scheduled[0]();
    const next = FakeSocket.instances[FakeSocket.instances.length - 1];
    next.open();
    next.hello();
    vi.advanceTimersByTime(100);
    expect(ticks).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });

  it("answers the dialog plugin with the pressed button's label, as plugin-dialog expects", async () => {
    const { invoke } = connected();
    const asked: unknown[] = [];
    setDialogAdapter({
      open: () => Promise.resolve(["/srv/a.pdf"]),
      save: () => Promise.resolve("/srv/out.vcf"),
      confirm: (message, options) => {
        asked.push([message, options.okLabel, options.cancelLabel]);
        return Promise.resolve(true);
      },
      message: () => Promise.resolve(),
    });
    await expect(invoke("plugin:dialog|open", { options: { multiple: true } })).resolves.toEqual(["/srv/a.pdf"]);
    await expect(invoke("plugin:dialog|save", { options: {} })).resolves.toBe("/srv/out.vcf");
    // `confirm()` compares the answer with "Ok"; `ask()` with "Yes".
    await expect(invoke("plugin:dialog|message", { message: "Sure?", buttons: "OkCancel" })).resolves.toBe("Ok");
    await expect(invoke("plugin:dialog|message", { message: "Really?", buttons: "YesNo" })).resolves.toBe("Yes");
    await expect(invoke("plugin:dialog|message", { message: "Custom", buttons: { OkCancelCustom: ["Go", "Stay"] } })).resolves.toBe("Go");
    await expect(invoke("plugin:dialog|message", { message: "Note", buttons: "Ok" })).resolves.toBe("Ok");
    expect(asked).toEqual([["Sure?", "Ok", "Cancel"], ["Really?", "Yes", "No"], ["Custom", "Go", "Stay"]]);
  });

  it("answers the window plugin for the one page it is", async () => {
    const { invoke } = connected();
    await expect(invoke("plugin:window|get_all_windows")).resolves.toEqual(["main"]);
    await expect(invoke("plugin:window|is_maximized", { label: "main" })).resolves.toBe(true);
    await expect(invoke("plugin:window|maximize", { label: "main" })).resolves.toBeUndefined();
    const { internals } = connected();
    const metadata = internals.internals().metadata as { currentWindow: { label: string }; currentWebview: { label: string } };
    expect(metadata.currentWindow.label).toBe("main");
    expect(metadata.currentWebview.label).toBe("main");
  });

  it("answers the notification plugin's list calls under the names the installed plugin sends", async () => {
    const { internals, socket } = connected();
    const w = window as unknown as Record<string, unknown>;
    const saved = w.__TAURI_INTERNALS__;
    w.__TAURI_INTERNALS__ = internals.internals();
    try {
      const { active, channels, pending } = await import("@tauri-apps/plugin-notification");
      await expect(channels()).resolves.toEqual([]);
      await expect(pending()).resolves.toEqual([]);
      await expect(active()).resolves.toEqual([]);
    } finally {
      w.__TAURI_INTERNALS__ = saved;
    }
    expect(socket.textFrames()).toEqual([]);
  });

  it("derives the socket URL from the page it was served from", () => {
    expect(socketUrl({ protocol: "http:", host: "127.0.0.1:8742" })).toBe("ws://127.0.0.1:8742/api/v1/desktop/ws");
    expect(socketUrl({ protocol: "https:", host: "desk.example.ts.net" })).toBe("wss://desk.example.ts.net/api/v1/desktop/ws");
  });
});
