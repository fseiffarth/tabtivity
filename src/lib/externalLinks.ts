/**
 * The one door from the app to the user's browser. No link opens without its
 * exact address on screen and the user's explicit yes:
 *
 *  - {@link openExternalUrl} asks first: the window's `LinkOpenHost` shows the
 *    address in full and opens it only on "Open link". Every button, menu entry
 *    and fallback that hands a URL to the browser comes through here, as do
 *    `target=_blank` links the host catches and the new-window requests the
 *    backend's navigation gate hands back (`services::nav_gate`).
 *    It is the terminal's link confirm lifted out of `TerminalView` (which
 *    now passes its own note), so every window asks the one way.
 *  - {@link openShownUrl} is for the surfaces that *are* that ask: a dialog or
 *    card that already shows this exact URL and whose open button the user just
 *    pressed (the sign-in card, the mail and PDF link dialogs, the browser
 *    pane's address bar).
 *
 * ESLint refuses a bare `invoke("open_external_url", …)` anywhere else.
 */
import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";

export interface LinkAsk {
  id: number;
  url: string;
  /** Where the link came from, in place of the generic line (the terminal's
   *  "A program in this terminal printed it"). */
  note?: string;
}

interface LinkAskState {
  /** Pending asks, oldest first; the host shows the first. */
  asks: LinkAsk[];
}

export const useLinkAsks = create<LinkAskState>(() => ({ asks: [] }));

const waiting = new Map<number, Array<(ok: boolean) => void>>();
let nextId = 1;

/** Ask the user whether to open `url`, showing it in full. An ask for a URL
 *  already waiting joins it rather than stacking a second dialog. */
export function askToOpenUrl(url: string, note?: string): Promise<boolean> {
  return new Promise((resolve) => {
    const same = useLinkAsks.getState().asks.find((a) => a.url === url);
    if (same) {
      waiting.get(same.id)?.push(resolve);
      return;
    }
    const id = nextId++;
    waiting.set(id, [resolve]);
    useLinkAsks.setState((s) => ({ asks: [...s.asks, { id, url, note }] }));
  });
}

/** The host's answer to ask `id`. */
export function answerLinkAsk(id: number, open: boolean): void {
  const resolvers = waiting.get(id) ?? [];
  waiting.delete(id);
  useLinkAsks.setState((s) => ({ asks: s.asks.filter((a) => a.id !== id) }));
  for (const resolve of resolvers) resolve(open);
}

/** Open `url` in the user's browser after they saw its exact address and said
 *  yes. Resolves whether it was opened; rejects only when the OS refused. */
export async function openExternalUrl(url: string, note?: string): Promise<boolean> {
  if (!(await askToOpenUrl(url, note))) return false;
  await invoke("open_external_url", { url });
  return true;
}

/** Open `url` straight away — only from a surface that already shows this
 *  exact URL and whose open button the user just pressed. */
export function openShownUrl(url: string): Promise<void> {
  return invoke("open_external_url", { url });
}

/** The web address an anchor click would leave the app for, or null: an
 *  `http(s)` link off this page's origin that targets a new window (or was
 *  middle-clicked). */
export function externalAnchorUrl(anchor: HTMLAnchorElement, middle: boolean): string | null {
  const target = (anchor.getAttribute("target") ?? "").toLowerCase();
  if (!middle && target !== "_blank") return null;
  let url: URL;
  try {
    url = new URL(anchor.href, window.location.href);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.origin === window.location.origin) return null;
  return url.href;
}
