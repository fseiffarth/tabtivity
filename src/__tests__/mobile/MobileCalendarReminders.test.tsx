/**
 * Push notifications from the phone's Notifications sheet: the phone
 * subscribes its browser under the host's VAPID key and registers what it
 * wants — calendar reminders, agent questions or turns, with or without names.
 * Choosing nothing removes it on both sides. Unsupported browsers say why.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Calendar } from "../../../mobile-web/src/screens/Calendar";
import { BRAND } from "../../lib/brand";

const calendar = { month: "2026-09", week_start: 1, calendars: [], events: [], truncated: false };
/** 65 bytes, base64url: the shape of an uncompressed P-256 key. */
const VAPID = "B" + "A".repeat(86);

const OFF = { subscribed: false, details: false, calendar: false, agents: "off", endpoint: null as string | null };
let host = { vapid_public_key: VAPID, ...OFF };
const writes: { method: string; body?: unknown }[] = [];
const subscribe = vi.fn();
const unsubscribe = vi.fn(async () => true);
const requestPermission = vi.fn(async () => "granted");

beforeEach(() => {
  host = { vapid_public_key: VAPID, ...OFF };
  writes.length = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    if (input === "/api/v1/push") {
      const method = init?.method ?? "GET";
      if (method !== "GET") {
        const body = init?.body ? JSON.parse(String(init.body)) as { endpoint: string; details: boolean; calendar: boolean; agents: string } : undefined;
        writes.push({ method, body });
        host = method === "PUT" && body
          ? { ...host, subscribed: true, details: body.details, calendar: body.calendar, agents: body.agents, endpoint: body.endpoint }
          : { ...host, ...OFF };
      }
      return new Response(JSON.stringify(host), { status: 200 });
    }
    return new Response(JSON.stringify({ calendar }), { status: 200 });
  }));
  const subscription = {
    endpoint: "https://fcm.googleapis.com/fcm/send/phone",
    options: { applicationServerKey: null },
    unsubscribe,
    toJSON: () => ({ endpoint: "https://fcm.googleapis.com/fcm/send/phone", keys: { p256dh: "pk", auth: "au" } }),
  };
  subscribe.mockResolvedValue(subscription);
  const registration = { pushManager: { getSubscription: vi.fn(async () => null), subscribe } };
  Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: { ready: Promise.resolve(registration) } });
  vi.stubGlobal("PushManager", function PushManager() {});
  vi.stubGlobal("Notification", Object.assign(function Notification() {}, { permission: "default", requestPermission }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  subscribe.mockReset();
  requestPermission.mockClear();
  Reflect.deleteProperty(navigator, "serviceWorker");
});

async function openSheet() {
  render(<Calendar />);
  fireEvent.click(await screen.findByRole("button", { name: /^Reminders/ }));
  await screen.findByRole("dialog", { name: "Notifications" });
}

const group = (name: string) => within(screen.getByRole("region", { name }));
const current = (name: string) => group(name).getAllByRole("button").find((b) => b.getAttribute("aria-current") === "true")?.textContent;

describe("Mobile push notifications", () => {
  it("subscribes under the host's key and registers what the phone chose", async () => {
    await openSheet();
    await waitFor(() => expect(current("Calendar reminders")).toBe("Off"));
    expect(current("Agents")).toBe("Off");

    // The details choice is a draft until something is switched on.
    fireEvent.click(group("What a notification shows").getByRole("button", { name: /^Only that something wants you/ }));
    expect(writes).toHaveLength(0);
    fireEvent.click(group("Calendar reminders").getByRole("button", { name: "On" }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(requestPermission).toHaveBeenCalledTimes(1);
    const options = subscribe.mock.calls[0][0] as { userVisibleOnly: boolean; applicationServerKey: Uint8Array };
    expect(options.userVisibleOnly).toBe(true);
    expect(options.applicationServerKey).toHaveLength(65);
    expect(writes[0]).toEqual({
      method: "PUT",
      body: { endpoint: "https://fcm.googleapis.com/fcm/send/phone", p256dh: "pk", auth: "au", details: false, calendar: true, agents: "off" },
    });

    fireEvent.click(await group("Agents").findByRole("button", { name: /^When one needs your answer/ }));
    await waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[1].body).toMatchObject({ calendar: true, agents: "questions", details: false });
    await waitFor(() => expect(current("Agents")).toBe("When one needs your answer"));
  });

  it("choosing nothing turns it off on both sides", async () => {
    host = { ...host, subscribed: true, details: true, calendar: true, agents: "off", endpoint: "https://fcm.googleapis.com/fcm/send/phone" };
    await openSheet();
    await waitFor(() => expect(current("Calendar reminders")).toBe("On"));
    fireEvent.click(group("Calendar reminders").getByRole("button", { name: "Off" }));
    await waitFor(() => expect(writes).toEqual([{ method: "DELETE", body: undefined }]));
  });

  it("names a refused permission instead of subscribing", async () => {
    requestPermission.mockResolvedValueOnce("denied");
    await openSheet();
    fireEvent.click(await group("Agents").findByRole("button", { name: /^Also when one finishes a turn/ }));
    await screen.findByText(new RegExp(String.raw`blocked for ${BRAND.display} Mobile`));
    expect(subscribe).not.toHaveBeenCalled();
    expect(writes).toHaveLength(0);
  });

  it("sends an iPhone browser tab to the Home Screen app", async () => {
    vi.stubGlobal("PushManager", undefined);
    Reflect.deleteProperty(window, "PushManager");
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)");
    await openSheet();
    expect(screen.getByText(/Add to Home Screen/)).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Agents" })).toBeNull();
  });
});
