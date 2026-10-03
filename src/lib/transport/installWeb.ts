/**
 * The browser desktop client's bootstrap half (hosted plan §7.1), called by
 * `src/main-web.tsx` before any app module loads: opens the one socket to the
 * server this page was served by, installs the `__TAURI_INTERNALS__` shim over
 * it, marks the page as a server client, and pauses the app's pollers while
 * the link is down.
 *
 * Nothing here imports React or an app store: the host OS the app decides by
 * (`lib/platform.ts`) is read at that module's load from what the server's
 * `hello` said, so the hello must have arrived before the app's module graph
 * is pulled in — `main-web.tsx` awaits `whenReady()` for exactly that.
 */
import { NAMES } from "../brand";
import { linkState, markCliInstallsByAdmin, markServerClient, setLinkState } from "./linkState";
import { WsClient, type Hello } from "./wsClient";
import { installWsInternals, type WsInternals } from "./wsInternals";

/** Where `platform.ts` finds the server's OS before the app loads. */
export const HOST_OS_GLOBAL = "__APP_HOST_OS__";

export interface WebTransport {
  client: WsClient;
  internals: WsInternals;
  ready: Promise<Hello>;
}

/** The socket URL for the page this bundle was served from. */
export function socketUrl(location: { protocol: string; host: string }): string {
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${location.host}/api/v1/desktop/ws`;
}

export function installWebTransport(): WebTransport {
  markServerClient();
  setLinkState("connecting");
  const client = new WsClient({ url: socketUrl(window.location), protocol: NAMES.desktopProtocol });
  const internals = installWsInternals(client);
  pausePollersWhileDown();
  client.connect();
  const ready = client.whenReady().then((hello) => {
    (window as unknown as Record<string, unknown>)[HOST_OS_GLOBAL] = hello.capabilities.hostOs;
    markCliInstallsByAdmin(hello.capabilities.cliInstalls === "admin-helper");
    return hello;
  });
  return { client, internals, ready };
}

/**
 * Plan §3.5: "a global pause also stops the 83 `setInterval` pollers, so they
 * go quiet instead of each raising an error." Every interval the app sets is
 * wrapped so its callback is skipped while the link is down; the timer keeps
 * ticking and resumes on its own when the link is back. Intervals set before
 * this ran (none: it runs first) and the transport's own timers (setTimeout)
 * are untouched.
 */
export function pausePollersWhileDown(target: Pick<Window, "setInterval"> = window): void {
  const native = target.setInterval.bind(target) as typeof setInterval;
  const paused = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
    if (typeof handler !== "function") return native(handler, timeout, ...args);
    return native(
      (...callArgs: unknown[]) => {
        if (linkState() === "down") return;
        (handler as (...a: unknown[]) => void)(...callArgs);
      },
      timeout,
      ...args,
    );
  }) as typeof setInterval;
  (target as { setInterval: typeof setInterval }).setInterval = paused;
}
