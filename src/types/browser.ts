/**
 * Wire types for the in-app browser (TODO group J #61) — the FROZEN CONTRACT
 * between the Rust backend (`src-tauri/src/commands/browser.rs`) and the React
 * frontend (`src/lib/browser.ts`, `src/stores/browser.ts`,
 * `src/components/browser/`).
 *
 * The architecture this contract encodes is **not** the one Plan A first
 * proposed. Plan C proved that an in-pane embedded child webview is
 * structurally impossible under WebKitGTK (`set_bounds` is a no-op for a
 * GtkBox-packed child), so there is no `browser_view_*` surface, no native view
 * composited over the pane, and therefore no suppression refcount and no
 * live-view LRU. What exists instead is two things:
 *
 *  1. **Reader mode** — the backend fetches the page, sanitizes it with the very
 *     same `ammonia` pipeline the mail client uses, and hands back inert HTML.
 *     It renders in the ordinary webview inside a script-less `<iframe sandbox="">`,
 *     exactly as a mail body does, so a browser tab is an ordinary DOM pane with
 *     no compositing surprises.
 *  2. **A separate hardened live window** — a real engine, in its own OS window,
 *     spawned by the backend on an explicit user gesture. The frontend renders
 *     the *control* and the consent UI; it never renders the page.
 *
 * Three rules make this file load-bearing rather than decorative:
 *
 * 1. **No command in this contract takes a filesystem path.** Downloads cross
 *    the boundary only through `browser_download_decide`, which raises the
 *    native OS save dialog *inside Rust*. A page that controls the bytes, the
 *    filename and the MIME type still has no IPC verb that names a path.
 * 2. Field names are snake_case because they are serde-serialized Rust structs
 *    verbatim — the convention `src/types/mail.ts` already follows (no
 *    `#[serde(rename_all = "camelCase")]` on any mail struct). **Command
 *    arguments**, by contrast, are camelCase, because Tauri converts an
 *    `invoke` argument name to snake_case on the Rust side (see
 *    `src/lib/mail.ts`'s `{ accountId, folderId }`).
 * 3. `SecurityState` is rendered **verbatim**. The frontend computes no security
 *    conclusion of its own; a value it does not recognize degrades to the
 *    unknown/insecure reading, never to "secure".
 *
 * Design rationale: `docs/browser_plan_a.md` (surface/integration),
 * `docs/browser_plan_b.md` (threat model, reader pipeline, address bar rules),
 * `docs/browser_plan_c.md` (engine feasibility, and why the pane is not a view).
 */

/**
 * What the backend's navigation policy makes of a URL, **before** anything is
 * fetched. The address bar performs its own shape checks first, but this is the
 * gate: `allowed: false` means no fetch happens, whatever the field says.
 */
export interface UrlVerdict {
  allowed: boolean;
  /** Why it was refused, in words, when `allowed` is false. */
  reason?: string;
  /**
   * The URL as it should be *shown* — punycode decoded, userinfo stripped,
   * decimal/octal/hex IP literals normalized. Never re-derive this in TS by
   * string search; a display that disagrees with the parser is the attack.
   */
  display_url: string;
  /** Set when the host has an `xn--` label: the ASCII form, shown beside the
   *  Unicode one. Never the Unicode form alone. */
  punycode_warning?: string;
  /** Lowercased scheme, e.g. `"https"`. */
  scheme: string;
  /** Loopback / private / link-local — the intranet class, which the UI names
   *  in words rather than showing a bare address. */
  is_loopback: boolean;
}

/** How the connection is secured. Rendered verbatim; the frontend computes none
 *  of it. `"unknown"` is a real state (a page that never loaded), not a bug. */
export interface SecurityState {
  tls: "secure" | "insecure" | "unknown";
  scheme: string;
  /** The host as shown to the user, after IDNA normalization. */
  host_display: string;
  punycode_warning?: string;
  /** True while an OpenVPN tunnel is up: browser traffic goes through it, like
   *  every other program on the machine (`docs/browser_plan_b.md` §9.2). */
  vpn_active: boolean;
}

/**
 * One fetched-and-sanitized page. `html` has already been through the backend's
 * `ammonia` pipeline and carries no script, no remote reference and no `href` —
 * it renders in a `sandbox=""` iframe and nowhere else.
 */
export interface ReaderPage {
  /** What the user asked for. */
  requested_url: string;
  /** Where the fetch actually landed after redirects. These differ more often
   *  than people expect, and the difference is worth showing. */
  final_url: string;
  /** The display form of `final_url` (see {@link UrlVerdict.display_url}). */
  display_url: string;
  title: string;
  /** Sanitized in Rust before it ever crosses IPC. */
  html: string;
  security: SecurityState;
  /** The page hit a size/element cap and was cut short. */
  truncated: boolean;
  /** How many remote references (images, styles, fonts) were dropped. Drives an
   *  informational banner — there is no control to unblock them, because there
   *  is no proxy behind one. */
  blocked_remote_assets: number;
}

/** A live (real engine) window the backend owns. `label` is the Tauri window
 *  label; it is an opaque handle here and is never used to build a path. */
export interface LiveWindowRef {
  label: string;
  display_url: string;
}

/** Payload of the `browser:live-state` event. */
export interface LiveWindowState {
  label: string;
  display_url: string;
  title: string;
  security: SecurityState;
  loading: boolean;
}

/**
 * Payload of `browser:download-requested`: a download the engine wants to make,
 * quarantined in the backend and **refused by default**. Nothing reaches the
 * user's filesystem until {@link DownloadOutcome} says the user said yes in an
 * OS-native save dialog the backend raised.
 */
export interface DownloadRequest {
  download_id: string;
  /** Already sanitized by the backend (path separators, `..`, bidi controls and
   *  reserved device names removed). Still rendered as a plain text node. */
  file_name: string;
  mime_type?: string;
  size_bytes?: number;
  /** The sniffed bytes disagree with the name or the declared type — the single
   *  strongest signal a download is hostile. Shown as a persistent warning. */
  sniff_mismatch: boolean;
}

/** What `browser_download_decide` actually did. `saved: false` with no
 *  `file_name` means the user cancelled and nothing was written. */
export interface DownloadOutcome {
  saved: boolean;
  file_name?: string;
}

/**
 * Payload of `browser:blocked` — the navigation policy refused a URL.
 *
 * `reason` is a **machine token**, never a sentence: `app-origin`,
 * `scheme:file`, `redirect-to-link-local`, `loopback`… The wording lives in
 * `src/lib/i18n.ts` in five languages, reached through
 * {@link import("../lib/browser").reasonPhrase}. Rendering `reason` directly is
 * how `redirect-to-link-local` ends up on a user's screen; the canonical token
 * list is `services::web_safety::REASON_TOKENS` and
 * `src/__tests__/browser/BrowserTripwire.test.ts` fails if the two sides drift.
 *
 * `window_label` names the live-page window a refusal happened in. Every emitter
 * of this event is a live window, so without it the frontend could only guess
 * which surface to blame — and the guess would wrongly wipe an unrelated reader
 * tab's page.
 */
export interface BlockedNavigation {
  display_url: string;
  reason: string;
  window_label?: string;
}

/** Payload of `browser:live-closed`. */
export interface LiveWindowClosed {
  label: string;
}

/**
 * What this build can actually do, **asked of the backend at runtime**.
 *
 * The frontend must never hardcode a platform check: Windows is refused in v1
 * (`docs/browser_plan_b.md` §5.2 — WebView2's permission default is *ask*, with
 * a dialog Tabtivity did not write, the same call `services::sandbox` already makes
 * for Docker on Windows), but that is the backend's statement to make, and it
 * may change without this file changing. `platform_note` is the explanation to
 * show in place of the live-page control — a plain, non-alarming sentence.
 */
export interface BrowserCapabilities {
  live_windows_supported: boolean;
  reader_supported: boolean;
  platform_note?: string;
}

/** Where a clicked/typed URL should open (`settings.browser_link_target`). */
export type LinkOpenTarget = "external" | "in_app" | "ask";
