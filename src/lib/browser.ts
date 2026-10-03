/**
 * **The** typed invoke surface for the in-app browser — one wrapper per
 * `browser_*` command, and nothing else in the frontend calls
 * `invoke("browser_*")` directly (the convention `src/lib/mail.ts` established).
 *
 * Four properties of this module are load-bearing rather than stylistic:
 *
 *  1. **No wrapper takes a filesystem path**, because no command does. The only
 *     way bytes reach the disk is {@link browserDownloadDecide}, where the
 *     *backend* raises the OS save dialog. `src/__tests__/browser/BrowserTripwire.test.ts`
 *     asserts this mechanically, so "just add a path here" is a red build.
 *  2. **The reader frame's CSP is the mail client's constant, imported, not
 *     copied.** Two policy strings that are supposed to be identical will drift;
 *     one that is literally the same object cannot. The tripwire test asserts
 *     the identity as well, because a future "small tweak" to the browser's copy
 *     is exactly how a `https:` would get into a fetch directive.
 *  3. **`bodyLooksUnsafe` guards the reader render too.** It is not a second
 *     sanitizer — the backend's `ammonia` pass is what makes the HTML inert —
 *     it is the assertion the render path depends on, and refusing to render is
 *     the honest response to a backend that regressed.
 *  4. **Every wrapper tolerates a missing command.** The backend lands in
 *     parallel with this file, and a build without it must degrade to a clear
 *     message rather than an unhandled rejection. `browserCapabilities` in
 *     particular resolves to a "nothing is supported" answer rather than
 *     throwing, so the pane can render its explanation on minute one.
 *
 * Design rationale: `docs/browser_plan_a.md` (surface), `docs/browser_plan_b.md`
 * §7 (the address bar as a security control) and §8.3 (reader mode).
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { TranslationKey } from "./i18n";
import { MAIL_FRAME_CSP, bodyLooksUnsafe, escapeHtml, stripFormatControls } from "./mail";
import type {
  BlockedNavigation,
  BrowserCapabilities,
  DownloadOutcome,
  DownloadRequest,
  LiveWindowClosed,
  LiveWindowRef,
  LiveWindowState,
  ReaderPage,
  SecurityState,
  UrlVerdict,
} from "../types/browser";

// ── Commands ─────────────────────────────────────────────────────────────────

/** Ask the navigation policy about a URL **before** fetching it. Purely a
 *  question: nothing is requested, nothing is opened. */
export function browserCheckUrl(url: string): Promise<UrlVerdict> {
  return invoke<UrlVerdict>("browser_check_url", { url });
}

/**
 * Fetch a page and return it sanitized. The backend does the request (no
 * cookies, no `Referer`, a generic UA, a size cap and a redirect cap) and runs
 * the mail client's `ammonia` pipeline over the result, so what comes back
 * carries no script, no remote reference and no `href`.
 */
export function browserReaderFetch(url: string): Promise<ReaderPage> {
  return invoke<ReaderPage>("browser_reader_fetch", { url });
}

/**
 * Open a URL in a **separate hardened window** driven by the real engine. This
 * is the only path to a live page, it is only ever called from an explicit user
 * gesture, and it is refused outright when
 * {@link BrowserCapabilities.live_windows_supported} is false.
 */
export function browserOpenLive(url: string): Promise<LiveWindowRef> {
  return invoke<LiveWindowRef>("browser_open_live", { url });
}

export function browserCloseLive(label: string): Promise<void> {
  return invoke("browser_close_live", { label });
}

export function browserListLive(): Promise<LiveWindowRef[]> {
  return invoke<LiveWindowRef[]>("browser_list_live");
}

/**
 * Answer a quarantined download. `accept: true` makes the **backend** raise the
 * OS save dialog with the sanitized name pre-filled; `false` deletes the
 * quarantined bytes. The frontend names no destination in either direction, and
 * a cancelled dialog comes back `{ saved: false }` with nothing written.
 */
export function browserDownloadDecide(
  downloadId: string,
  accept: boolean,
): Promise<DownloadOutcome> {
  return invoke<DownloadOutcome>("browser_download_decide", { downloadId, accept });
}

/** Drop everything the browsing session accumulated. */
export function browserClearData(): Promise<void> {
  return invoke("browser_clear_data");
}

/**
 * What this build can do. **Never inferred from the platform on this side** —
 * Windows is refused in v1, but that is the backend's statement, and a frontend
 * `navigator.platform` check would be a second source of truth that drifts.
 *
 * Resolves rather than rejects when the command is missing, so a frontend built
 * ahead of its backend renders its explanation instead of an error boundary.
 */
export async function browserCapabilities(): Promise<BrowserCapabilities> {
  try {
    return await invoke<BrowserCapabilities>("browser_capabilities");
  } catch (err) {
    return {
      live_windows_supported: false,
      reader_supported: false,
      platform_note: typeof err === "string" ? err : String(err),
    };
  }
}

// ── Events ───────────────────────────────────────────────────────────────────

export function onBrowserLiveState(
  handler: (e: LiveWindowState) => void,
): Promise<UnlistenFn> {
  return listen<LiveWindowState>("browser:live-state", (ev) => handler(ev.payload));
}

export function onBrowserDownloadRequested(
  handler: (e: DownloadRequest) => void,
): Promise<UnlistenFn> {
  return listen<DownloadRequest>("browser:download-requested", (ev) => handler(ev.payload));
}

export function onBrowserBlocked(
  handler: (e: BlockedNavigation) => void,
): Promise<UnlistenFn> {
  return listen<BlockedNavigation>("browser:blocked", (ev) => handler(ev.payload));
}

export function onBrowserLiveClosed(
  handler: (e: LiveWindowClosed) => void,
): Promise<UnlistenFn> {
  return listen<LiveWindowClosed>("browser:live-closed", (ev) => handler(ev.payload));
}

// ── The render surface (pure; no IPC) ────────────────────────────────────────

/**
 * The reader frame's Content-Security-Policy: **the mail client's constant,
 * imported**.
 *
 * Not a copy. The two features render attacker-supplied HTML through the same
 * backend sanitizer into the same kind of script-less frame, so they get the
 * same policy by construction — and a policy that is one shared object cannot
 * drift into two that differ by a `https:` somebody added to "just load the
 * images". Loading remote content is a backend action (a proxy that inlines
 * `data:` URIs) or it does not happen; it is never a relaxation of this string.
 */
export const READER_FRAME_CSP = MAIL_FRAME_CSP;

/** Our own trusted reset inside the reader frame. The page's own CSS cannot
 *  reach these rules — the sanitizer strips `<style>` from the page itself. */
const READER_FRAME_STYLE = `
  :root { color-scheme: light dark; }
  html, body { margin: 0; padding: 0; }
  body {
    font: 14px/1.7 -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    color: #1a1a1a;
    background: #ffffff;
    word-break: break-word;
    overflow-wrap: anywhere;
  }
  .reader-body { padding: 18px 22px; max-width: 46rem; margin: 0 auto; }
  .reader-body img { max-width: 100%; height: auto; }
  .reader-body table { max-width: 100%; border-collapse: collapse; }
  .reader-body pre, .reader-body code {
    white-space: pre-wrap;
    font: 12px/1.55 ui-monospace, Menlo, Consolas, monospace;
  }
  .reader-body pre { background: #f3f3f3; padding: 8px 10px; border-radius: 4px; }
  .reader-body h1, .reader-body h2, .reader-body h3 { line-height: 1.3; }
  .reader-body a { color: #2563eb; text-decoration: underline; cursor: default; }
  blockquote { margin: 0 0 0 10px; padding-left: 10px; border-left: 2px solid #c8c8c8; color: #555; }
`;

/**
 * Assemble the `srcdoc` for a reader page, mirroring `buildMessageSrcdoc` beat
 * for beat — including *why* the CSP is an inline `<meta>` rather than the
 * `csp=` iframe attribute: CSP Embedded Enforcement is a Chromium feature that
 * **WebKitGTK does not implement**, so the attribute would produce a policy that
 * silently does not exist on Linux, which is the worst available failure mode.
 * The meta is the first content in the document, before anything that could
 * load — a CSP meta placed after the first resource-loading element is ignored
 * for that element.
 */
export function buildReaderSrcdoc(page: { html?: string; title?: string }): string {
  const heading = page.title?.trim()
    ? `<h1 class="reader-title">${escapeHtml(stripControls(page.title))}</h1>`
    : "";
  return [
    "<!DOCTYPE html>",
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${READER_FRAME_CSP}">`,
    '<meta name="referrer" content="no-referrer">',
    `<style>${READER_FRAME_STYLE}</style>`,
    `<div class="reader-body" dir="auto">${heading}${page.html ?? ""}</div>`,
  ].join("\n");
}

/**
 * The reader render tripwire — the mail client's, reused verbatim.
 *
 * Re-exported under a browser name so the render path reads honestly, and so a
 * source scan for the call site finds it. Rendering HTML the backend should have
 * made inert would be app-origin XSS in a WebView holding the full Tauri IPC
 * surface, which is the one catastrophic failure this whole design avoids.
 */
export const readerLooksUnsafe = bodyLooksUnsafe;

/**
 * Bidi overrides, isolates and zero-width characters removed from any string a
 * page chose — a tab title reading `example.com — Secure  <RLI>` is a real
 * technique. This is the mail client's `stripFormatControls`, re-exported rather
 * than re-implemented: one character set, one place to fix it.
 */
export const stripControls = stripFormatControls;

/**
 * How a page title becomes a tab label: control characters stripped, collapsed
 * whitespace, capped at 60 characters. Attacker-controlled text, always
 * rendered as a plain text node and never as markup.
 */
export const TAB_TITLE_MAX = 60;

export function titleToTabLabel(title: string): string {
  return stripControls(title).replace(/\s+/g, " ").trim().slice(0, TAB_TITLE_MAX);
}

// ── Reason tokens → words (pure) ─────────────────────────────────────────────

/**
 * A phrase to render, as an i18n key plus its interpolations. Returned rather
 * than a finished string so these helpers stay pure and testable — `t` is a hook
 * and belongs to the component.
 */
export interface Phrase {
  key: TranslationKey;
  vars?: Record<string, string | number>;
}

/**
 * **Every reason token the backend can emit, mapped to a phrase.**
 *
 * The backend deliberately speaks in machine tokens (`app-origin`,
 * `redirect-to-link-local`, `scheme:file`) so the wording can live here, in five
 * languages. The cost of that split is that a token nobody translated reaches
 * the user *as the token* — which is exactly what a security-relevant refusal
 * must not do, because "redirect-to-link-local" tells a user nothing and reads
 * like a crash.
 *
 * The list is therefore a **contract with the Rust side**: `REASON_TOKENS` in
 * `src-core/src/services/web_safety.rs` is the canonical enumeration, a Rust
 * test proves it covers every `BlockReason`/`ConfirmReason` variant, and
 * `src/__tests__/browser/BrowserTripwire.test.ts` reads that array out of the Rust
 * source and fails if any entry is missing here or from `en`. Neither half can
 * move without the other.
 *
 * `scheme:<name>` is handled separately, by prefix — the gate appends the
 * offending scheme to it.
 */
export const REASON_KEYS: Readonly<Record<string, TranslationKey>> = Object.freeze({
  unparsable: "browser.reasonUnparsable",
  "about-internal": "browser.reasonAboutInternal",
  "app-origin": "browser.reasonAppOrigin",
  downgrade: "browser.reasonDowngrade",
  "redirect-loop": "browser.reasonRedirectLoop",
  "no-host": "browser.reasonNoHost",
  loopback: "browser.reasonLoopback",
  "private-network": "browser.reasonPrivateNetwork",
  "link-local": "browser.reasonLinkLocal",
  "internal-name": "browser.reasonInternalName",
  "redirect-to-loopback": "browser.reasonRedirectToLoopback",
  "redirect-to-private-network": "browser.reasonRedirectToPrivateNetwork",
  "redirect-to-link-local": "browser.reasonRedirectToLinkLocal",
  "redirect-to-internal-name": "browser.reasonRedirectToInternalName",
  "download-too-large": "browser.reasonDownloadTooLarge",
});

/** The one prefix token: `scheme:file`, `scheme:javascript`, … */
export const SCHEME_REASON_PREFIX = "scheme:";

/**
 * Turn a backend reason token into words. An unrecognized token degrades to a
 * generic sentence **with the token shown as a detail** rather than in place of
 * one — a user should never be handed a bare identifier, but hiding it entirely
 * would make a bug report impossible.
 */
export function reasonPhrase(reason: string | undefined | null): Phrase {
  const token = (reason ?? "").trim();
  if (!token) return { key: "browser.blockedGeneric" };
  if (token.startsWith(SCHEME_REASON_PREFIX)) {
    return {
      key: "browser.reasonScheme",
      vars: { scheme: token.slice(SCHEME_REASON_PREFIX.length) || "?" },
    };
  }
  const key = REASON_KEYS[token];
  if (key) return { key };
  return { key: "browser.reasonUnknown", vars: { token } };
}

/**
 * Turn a rejected `browser_*` invoke into words.
 *
 * The backend's errors are typed strings, not sentences — `http-status:404`,
 * `unsupported-content-type:application/pdf`, `fetch-failed: connection
 * refused`, `browser-unsupported-platform` — and `browser_open_live` rejects
 * with a bare *reason token*, so this defers to {@link reasonPhrase} first. The
 * fallback keeps the raw text visible as a detail, which is honest for a failure
 * nobody anticipated.
 */
export function errorPhrase(error: string | undefined | null): Phrase {
  const raw = (error ?? "").trim();
  if (!raw) return { key: "browser.errorGeneric", vars: { detail: "" } };
  if (raw === "browser-unsupported-platform") return { key: "browser.errorUnsupported" };
  // Distinct from the platform refusal on purpose: "your operating system cannot
  // do this" and "you have this switched off" are different sentences, and only
  // the second one has an action attached.
  if (raw === "browser-live-pages-disabled") return { key: "browser.errorLiveDisabled" };
  if (raw === "redirect-without-location") return { key: "browser.errorRedirectNoLocation" };
  if (raw === "no such download") return { key: "browser.errorNoSuchDownload" };
  if (raw.startsWith(SCHEME_REASON_PREFIX) || raw in REASON_KEYS) return reasonPhrase(raw);
  const status = /^http-status:(\d+)$/.exec(raw);
  if (status) return { key: "browser.errorHttpStatus", vars: { status: status[1] } };
  const ctype = /^unsupported-content-type:(.*)$/.exec(raw);
  if (ctype) {
    return {
      key: "browser.errorContentType",
      vars: { type: ctype[1].trim() || "?" },
    };
  }
  const fetched = /^fetch-failed:\s*(.*)$/.exec(raw);
  if (fetched) return { key: "browser.errorFetchFailed", vars: { detail: fetched[1] } };
  return { key: "browser.errorGeneric", vars: { detail: raw } };
}

// ── Address-bar formatting (pure) ────────────────────────────────────────────

/**
 * The address bar's parts, split for origin emphasis.
 *
 * `host` is emphasized **whole**, rather than only its registrable domain. That
 * is a deliberate downgrade from `docs/browser_plan_b.md` §7.1 rule 1: bolding
 * the registrable domain needs a Public Suffix List, the list lives in the
 * backend (the `psl` crate), and this contract carries no registrable-domain
 * field. The two-label approximation would bold `co.uk` for
 * `shop.example.co.uk` — worse than not bolding at all, per that same section —
 * so until the backend ships the field, the whole host is emphasized and
 * everything else is muted. Nothing here is ever ellipsis-truncated.
 */
export interface AddressParts {
  scheme: string;
  /** `user@` / `user:pw@`, when present. Its presence is itself the warning. */
  userinfo: string;
  host: string;
  port: string;
  /** Path + query + fragment, muted. */
  rest: string;
  /** The input did not parse as a URL — render it verbatim, emphasize nothing. */
  raw: boolean;
}

/**
 * Split a URL for display. **Parsed, never string-searched**: the whole point of
 * `https://example.com@evil.example/` is that a string search says
 * `example.com` and the parser says `evil.example`, and only one of those is
 * where the click goes.
 */
export function formatAddressParts(url: string): AddressParts {
  const text = (url ?? "").trim();
  if (!text) {
    return { scheme: "", userinfo: "", host: "", port: "", rest: "", raw: true };
  }
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return { scheme: "", userinfo: "", host: "", port: "", rest: text, raw: true };
  }
  const userinfo = parsed.username
    ? `${parsed.username}${parsed.password ? ":" + parsed.password : ""}@`
    : "";
  const rest = `${parsed.pathname === "/" && !parsed.search && !parsed.hash ? "" : parsed.pathname}${parsed.search}${parsed.hash}`;
  return {
    scheme: `${parsed.protocol}//`,
    userinfo,
    host: parsed.hostname,
    port: parsed.port ? `:${parsed.port}` : "",
    rest,
    raw: false,
  };
}

// ── Security chip (pure, renders what it is given) ───────────────────────────

/** The chip's tone. Derived from {@link SecurityState} alone, and an
 *  unrecognized `tls` value degrades to `"unknown"` — never to `"secure"`. */
export type SecurityTone = "secure" | "insecure" | "unknown";

export function securityTone(security: SecurityState | null | undefined): SecurityTone {
  if (!security) return "unknown";
  return security.tls === "secure"
    ? "secure"
    : security.tls === "insecure"
      ? "insecure"
      : "unknown";
}

/** The chip's glyph beside its word; `null` for "secure", which the chip
 *  draws as a lock, and `"warning"` for "insecure", which it draws as a warning icon. Words carry the meaning (Plan B §7.1 rule 7: icons alone
 *  are a solved failure); this is only the ornament beside them. */
export function securityGlyph(tone: SecurityTone): string | null {
  return tone === "secure" ? null : tone === "insecure" ? "warning" : "•";
}

/**
 * Whether the "Open live page" control may be shown at all.
 *
 * A control that will lie is never rendered — the `GifView` / YAML `source only`
 * rule. On a build whose backend refuses live windows (Windows in v1) the pane
 * shows {@link BrowserCapabilities.platform_note} instead, which is an
 * explanation rather than a disabled button nobody can explain.
 */
export function liveControlAvailable(caps: BrowserCapabilities | null): boolean {
  return !!caps?.live_windows_supported;
}

/** A byte count for the download strip. `undefined` means the server declared
 *  none — shown as such, never as `0 B`. */
export function formatDownloadSize(bytes: number | undefined): string | null {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return null;
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
