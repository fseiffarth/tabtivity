/**
 * A `hello` frame without (or with malformed) `capabilities` must not crash
 * the browser client's boot: `installWeb` reads `hello.capabilities.hostOs`
 * right after `whenReady()`, and the old `frame.capabilities!` handed it
 * `undefined`. What is missing falls back to the least the client may assume.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { resetLinkStateForTests } from "../../lib/transport/linkState";
import { helloCapabilities, WsClient, type SocketLike } from "../../lib/transport/wsClient";

class FakeSocket implements SocketLike {
  readyState = 0;
  binaryType = "";
  onopen: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  send() {}
  close() {
    this.readyState = 3;
    this.onclose?.({});
  }
}

function clientWith(frame: unknown) {
  let socket: FakeSocket | null = null;
  const client = new WsClient({
    url: "ws://127.0.0.1:8742/api/v1/desktop/ws",
    protocol: "x-desktop.v1",
    socket: () => (socket = new FakeSocket()),
    schedule: () => {},
  });
  client.connect();
  socket!.readyState = 1;
  socket!.onopen?.({});
  socket!.onmessage?.({ data: JSON.stringify(frame) });
  return client;
}

beforeEach(() => resetLinkStateForTests());

describe("hello capabilities", () => {
  it("a hello without capabilities still makes the client ready, as a user with no host OS", async () => {
    const client = clientWith({ t: "hello", client: "web-1", protocol: 1 });
    const hello = await client.whenReady();
    expect(hello.client).toBe("web-1");
    expect(hello.capabilities).toEqual({ protocol: 1, role: "user", commands: [] });
    // What installWeb reads at boot does not throw.
    expect(hello.capabilities.hostOs).toBeUndefined();
    expect(hello.capabilities.cliInstalls).toBeUndefined();
    client.close();
  });

  it("keeps well-formed capabilities as sent", () => {
    expect(
      helloCapabilities({ protocol: 2, hostOs: "windows", role: "admin", cliInstalls: "admin-helper", commands: [] }, 1),
    ).toEqual({ protocol: 2, hostOs: "windows", role: "admin", cliInstalls: "admin-helper", commands: [] });
  });

  it("never reads an unknown role as admin, and drops unknown values", () => {
    expect(helloCapabilities({ role: "root", hostOs: "beos", commands: "all", cliInstalls: 1 }, 3)).toEqual({
      protocol: 3,
      role: "user",
      commands: [],
    });
    expect(helloCapabilities("nonsense", 1)).toEqual({ protocol: 1, role: "user", commands: [] });
  });
});
