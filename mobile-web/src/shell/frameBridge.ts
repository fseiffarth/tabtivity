/**
 * The one line between the home's shell and a framed desktop
 * (`docs/phone_multi_desktop_plan.md`, Phase 3): `postMessage`, checked both
 * ways by `event.source` *and* `event.origin`, never sent with a `*` target.
 *
 * - The shell takes a message only from its own iframe's `contentWindow`, and
 *   only with the listed origin it loaded there (`acceptsFromFrame`).
 * - The framed page talks only to `window.parent`, at the origin it trusts as
 *   the shell's (`shellOrigin`), and takes a message only from that parent at
 *   that origin (`acceptsFromShell`). Nothing goes shell → frame yet.
 *
 * Frame → shell: `ready {name, desktopAvailable}` (the frame loaded, linked,
 * and says its name) and `openPicker` (its switch button was tapped). Both are
 * as harmless as messages get: a desktop's display name the shell would show
 * anyway, and a request to open the shell's own sheet.
 */
import { normalizeOrigin } from "../../../src/lib/linkedDesktops";
import { BRAND } from "../../../src/lib/brand";

/** Marks this app's own messages among whatever else a page may receive. */
export const SHELL_CHANNEL = `${BRAND.slug}-desktop-shell.v1`;

export type FrameToShell =
  | { type: "ready"; name: string | null; desktopAvailable: boolean }
  | { type: "openPicker" };

/**
 * The shell's origin, when this page is framed by one; null at the top or
 * when it cannot be known.
 *
 * `location.ancestorOrigins[0]` — the parent's origin as the browser itself
 * reports it (Chrome, Safari). Where the list is missing (Firefox), the
 * origin of `document.referrer`: the page that put this frame there, which
 * the default `strict-origin-when-cross-origin` policy hands over as an
 * origin. That fallback is weaker — a frame that navigated itself has its own
 * page as referrer, and a `no-referrer` parent sends none — so it only ever
 * fails closed: an own or missing origin means no shell, and since every send
 * names its target origin, a wrong guess is a message the browser drops, never
 * one delivered elsewhere. Who may frame this page at all is the sidecar's
 * `frame-ancestors`, which the browser enforces on every ancestor.
 */
export function shellOrigin(): string | null {
  if (typeof window === "undefined") return null;
  try {
    if (window.parent === window) return null;
    const ancestors = (window.location as Location & { ancestorOrigins?: DOMStringList }).ancestorOrigins;
    let raw: string | null = null;
    if (ancestors !== undefined && ancestors !== null) {
      // Present: authoritative, even empty or opaque ("null") — no fallback.
      raw = ancestors.length > 0 ? ancestors[0] : null;
    } else if (document.referrer) {
      raw = new URL(document.referrer).origin;
    }
    const origin = raw ? normalizeOrigin(raw) : null;
    if (!origin || origin === normalizeOrigin(window.location.origin)) return null;
    return origin;
  } catch {
    return null;
  }
}

/** Whether this page runs inside a shell it can talk to. */
export function isFramed(): boolean {
  return shellOrigin() !== null;
}

/** A frame's message, or null for anything this build does not know. */
export function parseFrameMessage(data: unknown): FrameToShell | null {
  if (!data || typeof data !== "object") return null;
  const record = data as Record<string, unknown>;
  if (record.channel !== SHELL_CHANNEL) return null;
  if (record.type === "openPicker") return { type: "openPicker" };
  if (record.type === "ready") {
    return {
      type: "ready",
      name: typeof record.name === "string" ? record.name : null,
      desktopAvailable: record.desktopAvailable === true,
    };
  }
  return null;
}

/** Frame side: tell the shell. False when there is no shell to tell. */
export function postToShell(message: FrameToShell): boolean {
  const target = shellOrigin();
  if (!target) return false;
  try {
    window.parent.postMessage({ channel: SHELL_CHANNEL, ...message }, target);
    return true;
  } catch {
    return false;
  }
}

/** Frame side: whether `event` came from the shell — the parent window, at
 * the origin trusted as the shell's. */
export function acceptsFromShell(event: MessageEvent): boolean {
  const origin = shellOrigin();
  return origin !== null && event.source === window.parent && event.origin === origin;
}

/** Shell side: whether `event` came from `frame`'s own page at `origin`. */
export function acceptsFromFrame(event: MessageEvent, frame: HTMLIFrameElement, origin: string): boolean {
  const source = frame.contentWindow;
  return source !== null && event.source === source && event.origin === origin;
}

/** Shell side: `frame`'s messages from `origin`, every other one ignored. */
export function listenToFrame(frame: HTMLIFrameElement, origin: string, onMessage: (message: FrameToShell) => void): () => void {
  const listener = (event: MessageEvent) => {
    if (!acceptsFromFrame(event, frame, origin)) return;
    const message = parseFrameMessage(event.data);
    if (message) onMessage(message);
  };
  window.addEventListener("message", listener);
  return () => window.removeEventListener("message", listener);
}
