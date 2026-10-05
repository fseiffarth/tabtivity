/**
 * The silent push refresh that runs after every sign-in.
 *
 * When a push service declares an endpoint gone (404/410) the host stops
 * posting to it but keeps the phone's choices as a lapsed record. The refresh
 * re-subscribes from that record, without a prompt, when notification
 * permission is still granted. Before, the host deleted the row, answered
 * "not subscribed", and the refresh returned early: notices stayed off until
 * someone re-enabled them by hand.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { refreshPush } from "../../../mobile-web/src/push";
import { BRAND } from "../../lib/brand";

/** 65 bytes, base64url: the shape of an uncompressed P-256 key. */
const VAPID = "B" + "A".repeat(86);
const VAPID_BYTES = Uint8Array.from(atob(VAPID.replace(/-/g, "+").replace(/_/g, "/") + "="), (c) => c.charCodeAt(0));
const DEAD = "https://fcm.googleapis.com/fcm/send/dead";
const FRESH = "https://fcm.googleapis.com/fcm/send/fresh";

type Host = { vapid_public_key: string; subscribed: boolean; lapsed?: boolean; details: boolean; calendar: boolean; agents: string; endpoint: string | null };
let host: Host;
const writes: { method: string; body?: Record<string, unknown> }[] = [];
let existing: ReturnType<typeof subscription> | null;
const subscribe = vi.fn();
const requestPermission = vi.fn(async () => "granted");

function subscription(endpoint: string) {
  return {
    endpoint,
    options: { applicationServerKey: VAPID_BYTES.buffer },
    unsubscribe: vi.fn(async () => true),
    toJSON: () => ({ endpoint, keys: { p256dh: "pk", auth: "au" } }),
  };
}

function setPermission(permission: string) {
  vi.stubGlobal("Notification", Object.assign(function Notification() {}, { permission, requestPermission }));
}

beforeEach(() => {
  writes.length = 0;
  existing = null;
  host = { vapid_public_key: VAPID, subscribed: false, details: false, calendar: false, agents: "off", endpoint: null };
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    if (input !== "/api/v1/push") return new Response("{}", { status: 404 });
    const method = init?.method ?? "GET";
    if (method === "PUT") {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      writes.push({ method, body });
      host = { ...host, subscribed: true, lapsed: false, endpoint: String(body.endpoint) };
    }
    return new Response(JSON.stringify(host), { status: 200 });
  }));
  subscribe.mockImplementation(async () => subscription(FRESH));
  const registration = { pushManager: { getSubscription: vi.fn(async () => existing), subscribe } };
  Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: { ready: Promise.resolve(registration) } });
  vi.stubGlobal("PushManager", function PushManager() {});
  setPermission("granted");
});

afterEach(() => {
  vi.unstubAllGlobals();
  subscribe.mockReset();
  requestPermission.mockClear();
  Reflect.deleteProperty(navigator, "serviceWorker");
});

describe(`${BRAND.display} Mobile push refresh`, () => {
  it("re-subscribes a lapsed phone with the choices the host remembered", async () => {
    host = { ...host, lapsed: true, details: true, calendar: true, agents: "questions", endpoint: DEAD };
    await refreshPush();
    expect(subscribe).toHaveBeenCalledOnce();
    expect(writes).toEqual([{
      method: "PUT",
      body: { endpoint: FRESH, p256dh: "pk", auth: "au", details: true, calendar: true, agents: "questions" },
    }]);
    // Silent: the permission was already granted, so nothing prompts.
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it("replaces a browser subscription that is the endpoint the push service dropped", async () => {
    host = { ...host, lapsed: true, calendar: true, endpoint: DEAD };
    const stale = subscription(DEAD);
    existing = stale;
    await refreshPush();
    expect(stale.unsubscribe).toHaveBeenCalledOnce();
    expect(subscribe).toHaveBeenCalledOnce();
    expect(writes.map((write) => write.body?.endpoint)).toEqual([FRESH]);
  });

  it("registers a browser subscription that already moved on from the dead endpoint", async () => {
    host = { ...host, lapsed: true, calendar: true, endpoint: DEAD };
    existing = subscription(FRESH);
    await refreshPush();
    expect(existing.unsubscribe).not.toHaveBeenCalled();
    expect(subscribe).not.toHaveBeenCalled();
    expect(writes.map((write) => write.body?.endpoint)).toEqual([FRESH]);
  });

  it("leaves a phone that never switched notices on alone", async () => {
    await refreshPush();
    expect(subscribe).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });

  it("does nothing for a lapsed phone whose permission is no longer granted", async () => {
    host = { ...host, lapsed: true, calendar: true, endpoint: DEAD };
    for (const permission of ["default", "denied"]) {
      setPermission(permission);
      await refreshPush();
    }
    expect(fetch).not.toHaveBeenCalled();
    expect(subscribe).not.toHaveBeenCalled();
  });

  it("still only re-registers a live subscription when the browser rotated its endpoint", async () => {
    host = { ...host, subscribed: true, calendar: true, endpoint: FRESH };
    existing = subscription(FRESH);
    await refreshPush();
    expect(writes).toEqual([]);
    existing = subscription("https://fcm.googleapis.com/fcm/send/rotated");
    await refreshPush();
    expect(writes.map((write) => write.body?.endpoint)).toEqual(["https://fcm.googleapis.com/fcm/send/rotated"]);
  });
});
