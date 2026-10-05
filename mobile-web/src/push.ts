import { api } from "./api";
import { appleTouchDevice } from "./platform";

/**
 * Push notifications on this phone: calendar reminders, and agent tabs that
 * wait on an answer or finish a turn.
 *
 * The desktop sees each event once (its reminder engine, its agent-turn
 * edges); the sidecar encrypts it to every subscribed phone that asked for
 * that kind and posts it through the browser vendor's push service (the one
 * path off the tailnet — the service relays ciphertext only). `sw.js` shows
 * it, even with Tabtivity Mobile closed.
 */

/** Which agent turns this phone is told about (`push::AgentNotices`). */
export type AgentNotices = "off" | "questions" | "all";

/** What this phone asks to be told (`push::PushPrefs`). */
export interface PushPrefs {
  /** Whether notices carry names: the event's title, time and place; the
   * agent's project and tab. */
  details: boolean;
  calendar: boolean;
  agents: AgentNotices;
}

/** What the host has on file for this device (`GET /api/v1/push`). */
export interface HostPushState extends PushPrefs {
  vapid_public_key: string;
  subscribed: boolean;
  /** The push service told the host this phone's endpoint is gone. The host
   * sends it nothing, but still answers the choices it made and the endpoint
   * that died, for `refreshPush` to re-subscribe from. Absent from a host
   * that predates lapsed records. */
  lapsed?: boolean;
  endpoint: string | null;
}

/**
 * Whether this browser can receive push at all. iOS offers it only to an app
 * added to the Home Screen, and a plain Safari tab has no `PushManager`.
 */
export type PushSupport = "supported" | "needs-install" | "unsupported";

export function pushSupport(): PushSupport {
  if (typeof window === "undefined" || !("serviceWorker" in navigator) || !("Notification" in window)) {
    return appleTouchDevice() ? "needs-install" : "unsupported";
  }
  if (!("PushManager" in window)) return appleTouchDevice() ? "needs-install" : "unsupported";
  return "supported";
}

export function notificationPermission(): NotificationPermission | "unsupported" {
  return typeof Notification === "undefined" ? "unsupported" : Notification.permission;
}

export function getPushState(): Promise<HostPushState> {
  return api<HostPushState>("/api/v1/push");
}

function decodeKey(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

function sameKey(a: ArrayBuffer | null | undefined, b: Uint8Array): boolean {
  if (!a || a.byteLength !== b.length) return false;
  const view = new Uint8Array(a);
  return view.every((byte, i) => byte === b[i]);
}

/**
 * This browser's subscription under the host's current key, made if missing.
 * One made under another key (the desktop forgot all phones, which rotates it)
 * would never be woken again, so it is replaced rather than reused. So is one
 * whose endpoint is `dead` — the one the push service told the host is gone,
 * which a browser can go on handing out as if it were live.
 */
async function browserSubscription(vapidKey: string, dead?: string | null): Promise<PushSubscription> {
  const registration = await navigator.serviceWorker.ready;
  const key = decodeKey(vapidKey);
  const existing = await registration.pushManager.getSubscription();
  if (existing && existing.endpoint !== dead && sameKey(existing.options.applicationServerKey, key)) return existing;
  if (existing) await existing.unsubscribe().catch(() => false);
  return registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
}

function register(subscription: PushSubscription, prefs: PushPrefs): Promise<HostPushState> {
  const json = subscription.toJSON();
  return api<HostPushState>("/api/v1/push", {
    method: "PUT",
    body: JSON.stringify({
      endpoint: json.endpoint,
      p256dh: json.keys?.p256dh ?? "",
      auth: json.keys?.auth ?? "",
      details: prefs.details,
      calendar: prefs.calendar,
      agents: prefs.agents,
    }),
  });
}

/** Whether `prefs` asks for anything at all; nothing is the same as off. */
export function wantsAny(prefs: Pick<PushPrefs, "calendar" | "agents">): boolean {
  return prefs.calendar || prefs.agents !== "off";
}

/** Turn notifications on (or change what they cover). Must run from a tap:
 * the permission prompt is refused outside a user gesture. */
export async function enablePush(prefs: PushPrefs): Promise<HostPushState> {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error("permission_denied");
  const host = await getPushState();
  return register(await browserSubscription(host.vapid_public_key), prefs);
}

export async function disablePush(): Promise<HostPushState> {
  const state = await api<HostPushState>("/api/v1/push", { method: "DELETE" });
  try {
    const registration = await navigator.serviceWorker.ready;
    await (await registration.pushManager.getSubscription())?.unsubscribe();
  } catch {
    // The host no longer sends to it; a browser subscription left behind is
    // inert and is replaced the next time reminders are switched on.
  }
  return state;
}

/**
 * Keep the host's copy current after a sign-in. Browsers rotate a push
 * endpoint now and then; with nobody signed in to report the new one, the
 * host would go on posting to the dead one. Silent: nothing here prompts, and
 * a phone that never switched reminders on is left alone.
 *
 * A subscription the push service dropped (`lapsed`) comes back here too: the
 * host kept this phone's choices when it stopped posting, and a fresh
 * subscription is registered under them. Before, the host forgot the phone
 * outright and notices stayed off until someone re-enabled them by hand.
 */
export async function refreshPush(): Promise<void> {
  if (pushSupport() !== "supported" || notificationPermission() !== "granted") return;
  const host = await getPushState();
  const lapsed = host.lapsed === true;
  if (!host.subscribed && !lapsed) return;
  const subscription = await browserSubscription(host.vapid_public_key, lapsed ? host.endpoint : undefined);
  if (lapsed || subscription.endpoint !== host.endpoint) await register(subscription, host);
}
