/**
 * Where a URI opens — the one pure decision, plus the one dispatcher that acts
 * on it (TODO group J #33, wired for the in-app browser #61).
 *
 * Two functions with deliberately different natures:
 *
 *  - {@link routeUri} is **pure and total**: a URI plus a context in, a
 *    {@link LinkTarget} out. It touches no store, performs no IPC and never
 *    throws, which is what makes the whole routing table testable in
 *    `src/__tests__/browser/LinkTarget.test.ts` rather than only observable by clicking.
 *  - {@link openRoutedUri} performs the target: a browser tab, `launch_app`,
 *    `open_external_url`, or the mail composer.
 *
 * Two rules in the table are load-bearing rather than conveniences:
 *
 *  1. **A URL Tabtivity itself started is always external.** A git-hosting OAuth
 *     page, a `gh`/`glab` device-login, a release link — the user's session
 *     lives in their real browser, and routing an auth flow into a fresh,
 *     ephemeral profile just means logging in again in the wrong place.
 *  2. **A URL that arrived from untrusted content opens in reader mode, and may
 *     not become a live page in one click.** A mail body, terminal output, an
 *     agent's answer and a viewed file are all content Tabtivity already treats as
 *     hostile when it chooses a destination (`docs/browser_plan_b.md` §8.5).
 *     Reader mode is inert, pre-sanitized HTML with no script, no forms and no
 *     network — the right default for a destination the user did not choose.
 *     A URL the user *typed* is a different act, and may go live.
 *
 * An explicit user gesture beats the setting in both directions — a preference
 * is a default, not a lock.
 */

import { invoke } from "@tauri-apps/api/core";
import type { LinkOpenTarget } from "../types/browser";
import type { GlobalAppEntry } from "../types";

/** Reader = inert sanitized HTML in the tab. Live = a separate hardened window. */
export type BrowserOpenMode = "reader" | "live";

/**
 * Where a URI came from. The distinction that matters is trust: did a **person**
 * name this destination, or did some content name it for them?
 */
export type UriOrigin =
  /** Typed or pasted into the browser's address bar. */
  | "address_bar"
  /** Clicked inside a page the user is already browsing. */
  | "browser"
  /** Clicked in terminal output. */
  | "terminal"
  /** A link in a mail message. */
  | "mail"
  /** A link in an agent's response. */
  | "agent"
  /** A link in the file tree or a file viewer. */
  | "filetree"
  | "viewer"
  /** Tabtivity itself started this URL (OAuth, `gh`/`glab`, a release link). */
  | "app";

/** Origins a person named directly. Only these may offer the live-page control. */
const TRUSTED_ORIGINS: ReadonlySet<UriOrigin> = new Set<UriOrigin>([
  "address_bar",
  "browser",
]);

export function originIsTrusted(origin: UriOrigin): boolean {
  return TRUSTED_ORIGINS.has(origin);
}

export type LinkTarget =
  /** Open a Tabtivity browser tab. `mode` is what it opens as; `allowLive` is
   *  whether it may offer the "Open live page" control at all. */
  | { kind: "in_app"; url: string; mode: BrowserOpenMode; allowLive: boolean }
  /** Launch the user's configured app for a role (`browser`, `mail`, …). */
  | { kind: "global_app"; role: string; url: string }
  /** Hand it to the OS default handler via `open_external_url`. */
  | { kind: "external"; url: string }
  /** Open Tabtivity's own mail composer, pre-addressed. */
  | { kind: "compose"; address: string }
  /** Show the chooser (`browser_link_target: "ask"`). */
  | { kind: "ask"; url: string }
  /** Nothing may open this, and the reason is shown. */
  | { kind: "refuse"; reason: string };

export interface RouteContext {
  /** `settings.browser_link_target`. */
  setting: LinkOpenTarget | undefined;
  /** The `web_browser` experimental flag, read through `useExperimental`. */
  browserEnabled: boolean;
  /** The `mail_client` experimental flag. */
  mailEnabled: boolean;
  /** A user gesture that named the target. Beats the setting. */
  explicit?: "in_app" | "live" | "external";
  origin: UriOrigin;
  /** Whether the user configured a global app for the `browser` role. Without
   *  one, "external" means the OS default handler. */
  browserRoleConfigured?: boolean;
}

/** Tabs, newlines and carriage returns are stripped inside a URL by the WHATWG
 *  parser, so `java\tscript:alert(1)` is a `javascript:` URL. Strip them before
 *  the scheme is read, or the scheme check reads a different string than the
 *  engine would. */
function despace(uri: string): string {
  return uri.replace(/[\t\n\r]/g, "");
}

/** The scheme, lowercased, or `""` when the string names none. Read with a
 *  parser-shaped regex rather than `indexOf(":")`, so `example.com:8080` (a
 *  host and a port) is not mistaken for a scheme. */
function schemeOf(uri: string): string {
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(uri);
  if (!m) return "";
  const rest = uri.slice(m[0].length);
  // `localhost:5173`, `example.com:8080/x` — a numeric "scheme body" is a port.
  if (/^\d/.test(rest)) return "";
  return m[1].toLowerCase();
}

/**
 * The routing decision. Pure, total, and never throws — a malformed URI comes
 * back as `refuse`, not as an exception in a click handler.
 */
export function routeUri(uri: string, ctx: RouteContext): LinkTarget {
  const url = despace((uri ?? "").trim());
  if (!url) return { kind: "refuse", reason: "empty" };
  const scheme = schemeOf(url);

  // 1. Scheme first. Anything that is not web or a known internal handler is
  //    refused here — `open_external_url` refuses non-web URLs independently, so
  //    there are two checks and neither trusts the other.
  if (scheme === "mailto") {
    const address = url.slice("mailto:".length).split("?")[0];
    return ctx.mailEnabled
      ? { kind: "compose", address }
      : { kind: "global_app", role: "mail", url };
  }
  if (scheme === "webcal") return { kind: "global_app", role: "calendar", url };
  if (scheme !== "http" && scheme !== "https") {
    return { kind: "refuse", reason: scheme ? `scheme:${scheme}` : "not_a_url" };
  }

  // 2. Tabtivity's own URLs always go to the user's real browser, where their
  //    session already lives.
  if (ctx.origin === "app") return { kind: "external", url };

  const allowLive = originIsTrusted(ctx.origin);

  // 3. An explicit gesture wins over the setting, in both directions.
  if (ctx.explicit === "external") return { kind: "external", url };
  if (ctx.explicit === "live") {
    return ctx.browserEnabled
      ? { kind: "in_app", url, mode: "live", allowLive: true }
      : { kind: "external", url };
  }
  if (ctx.explicit === "in_app") {
    return ctx.browserEnabled
      ? { kind: "in_app", url, mode: "reader", allowLive }
      : { kind: "external", url };
  }

  // 4. No in-app browser on this build (flag off, or no engine) → external.
  if (!ctx.browserEnabled) return { kind: "external", url };

  // 5. Otherwise the setting decides. Default is "external": the user's real
  //    browser has their logins, their extensions and their password manager,
  //    and an experimental in-app engine should not silently start receiving
  //    their links.
  const setting = ctx.setting ?? "external";
  if (setting === "in_app") return { kind: "in_app", url, mode: "reader", allowLive };
  if (setting === "ask") return { kind: "ask", url };
  return ctx.browserRoleConfigured
    ? { kind: "global_app", role: "browser", url }
    : { kind: "external", url };
}

// ── Address-bar commit semantics (pure) ──────────────────────────────────────

/** What typing something into the address bar and pressing Enter means. */
export type AddressCommit =
  /** Navigate to this absolute `http(s)` URL. */
  | { kind: "url"; url: string }
  /** The text was not a URL; this is the search URL it becomes. */
  | { kind: "search"; url: string }
  /** Nothing was typed. */
  | { kind: "empty" }
  /** Refused: a non-web scheme was typed, or the text is not a URL and there is
   *  no search template configured. */
  | { kind: "refuse"; reason: "scheme" | "not_a_url"; scheme?: string };

/** Looks like a host the user meant as a URL: no whitespace, and either a dotted
 *  name or a bare `localhost` (with an optional port and path). */
function looksLikeHost(text: string): boolean {
  if (/\s/.test(text)) return false;
  const hostPart = text.split(/[/?#]/)[0];
  if (!hostPart) return false;
  if (/^localhost(:\d+)?$/i.test(hostPart)) return true;
  // A dotted label sequence with a non-numeric-only last label, or an IPv4-ish
  // literal. Deliberately loose — the backend's policy is the gate, this only
  // decides whether to prefix a scheme or hand the text to a search engine.
  return /^[a-zA-Z0-9._~%-]+\.[a-zA-Z0-9-]{2,}(:\d+)?$/.test(hostPart);
}

/**
 * The address bar's commit rule (`docs/browser_plan_a.md` §4.2).
 *
 * **A non-`http(s)` scheme typed by hand is never navigated.** `file:`,
 * `data:`, `javascript:` and `blob:` are refused here with a reason, and
 * refused again by the backend's policy — this is the first, independent gate,
 * not the security boundary.
 */
export function parseAddressInput(
  raw: string,
  searchTemplate?: string,
): AddressCommit {
  const text = despace((raw ?? "").trim());
  if (!text) return { kind: "empty" };

  const scheme = schemeOf(text);
  if (scheme === "http" || scheme === "https") {
    try {
      return { kind: "url", url: new URL(text).toString() };
    } catch {
      return { kind: "refuse", reason: "not_a_url" };
    }
  }
  if (scheme) return { kind: "refuse", reason: "scheme", scheme };

  if (looksLikeHost(text)) {
    try {
      return { kind: "url", url: new URL(`https://${text}`).toString() };
    } catch {
      /* fall through to search */
    }
  }

  const template = (searchTemplate ?? "").trim();
  if (template.includes("%s")) {
    return { kind: "search", url: template.replace("%s", encodeURIComponent(text)) };
  }
  return { kind: "refuse", reason: "not_a_url" };
}

// ── The dispatcher (impure) ──────────────────────────────────────────────────

export interface DispatchHooks {
  /** Open a browser tab on `url`. Supplied by the caller because only a host
   *  that owns the tab store can add one — a popout passes none, and the link
   *  falls back to `external` rather than offering an action that goes nowhere
   *  (the rule `FileTree`'s "Open in a new tab" already follows). */
  openBrowserTab?: (url: string, mode: BrowserOpenMode) => void;
  /** Open Tabtivity's mail composer pre-addressed. */
  openComposer?: (address: string) => void;
  /** Show the in-app/external chooser. */
  showChooser?: (url: string) => void;
  /** The configured global apps, for the `global_app` targets. */
  globalApps?: Record<string, GlobalAppEntry>;
  /** Report a refusal to the user. */
  onRefuse?: (reason: string) => void;
}

/** Hand a URL to the OS. `open_external_url` refuses non-`http(s)` itself. */
function openExternal(url: string): void {
  void invoke("open_external_url", { url }).catch(() => {});
}

/**
 * Perform a {@link LinkTarget}. Every failure is swallowed into the caller's
 * `onRefuse` or ignored — a link click must never surface an unhandled
 * rejection, and a missing hook degrades to the external browser rather than to
 * nothing happening.
 */
export function performLinkTarget(target: LinkTarget, hooks: DispatchHooks = {}): void {
  switch (target.kind) {
    case "in_app":
      if (hooks.openBrowserTab) hooks.openBrowserTab(target.url, target.mode);
      else openExternal(target.url);
      return;
    case "compose":
      if (hooks.openComposer) hooks.openComposer(target.address);
      else openExternal(`mailto:${target.address}`);
      return;
    case "ask":
      if (hooks.showChooser) hooks.showChooser(target.url);
      else openExternal(target.url);
      return;
    case "global_app": {
      const exec = hooks.globalApps?.[target.role]?.exec?.trim();
      if (!exec) {
        openExternal(target.url);
        return;
      }
      void invoke("launch_app", {
        exec,
        args: [target.url],
        file: null,
        projectId: null,
        role: target.role,
      }).catch(() => openExternal(target.url));
      return;
    }
    case "external":
      openExternal(target.url);
      return;
    case "refuse":
      hooks.onRefuse?.(target.reason);
      return;
  }
}

/**
 * Join a video call — the one link in the app that must never open in a reader.
 *
 * `explicit: "external"` because a conference URL is not a page to look at: it
 * is the door into a meeting, and the session, the camera permission and the
 * "open in the desktop app" handoff all live in the user's real browser. An
 * inert sanitized copy of Zoom's launch page is a Join button that does not
 * join. The routing is still asked (rather than calling the OS directly), so the
 * scheme gate applies here like everywhere else: `lib/calendar/conference.ts` has already
 * refused anything that is not `http(s)`, and this is the independent second
 * check that a `zoommtg:`-style URL never reaches the OS handler.
 */
export function joinConference(url: string, hooks: DispatchHooks = {}): LinkTarget {
  return openRoutedUri(
    url,
    // Every field but `explicit` is inert on this path — an explicit gesture is
    // resolved before the flags or the setting are read — so they are spelled
    // out as the "no in-app anything" case rather than threaded from the stores.
    {
      setting: undefined,
      browserEnabled: false,
      mailEnabled: false,
      origin: "viewer",
      explicit: "external",
    },
    hooks,
  );
}

/** Route and perform in one call — the shape every #33 call site uses. */
export function openRoutedUri(
  uri: string,
  ctx: RouteContext,
  hooks: DispatchHooks = {},
): LinkTarget {
  const target = routeUri(uri, ctx);
  performLinkTarget(target, hooks);
  return target;
}
