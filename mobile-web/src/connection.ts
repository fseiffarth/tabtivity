import { ApiError } from "./api";
import { translate, useI18nStore, type TranslationKey } from "../../src/lib/i18n";

/**
 * Why Tabtivity Mobile could not reach the workspace, at the granularity the
 * *reader* can act on.
 *
 * The screen behind this used to say "Host unavailable" for every one of these
 * and offer a Retry button, which is the least useful thing it could say: the
 * phone being off the tailnet, the sidecar not running, and the desktop app
 * being closed are three different problems with three different fixes, and
 * pressing Retry helps with none of them. They are all distinguishable from
 * here — the difference is whether an HTTP response came back at all, and if
 * one did, whether it came from our own sidecar or from the proxy in front of
 * it — so the app should distinguish them rather than make the user guess.
 */
export type UnavailableReason =
  /** The phone has no network at all. */
  | "phone_offline"
  /** No HTTP response came back, but the phone believes it is online: nothing
   * is answering at the host's address. */
  | "unreachable"
  /** Something accepted the connection but did not answer in time. */
  | "timeout"
  /** An HTTP error that did not come from the sidecar — a proxy (Tailscale
   * serve) reached the desktop and found nothing listening on the port. */
  | "host_down"
  /** The sidecar answered, and said the desktop app is not connected to it. */
  | "desktop_down"
  /** The sidecar's rate limiter is refusing sign-ins. */
  | "busy"
  /** The sidecar rejected the address the app was opened from. */
  | "blocked_origin"
  /** The sidecar answered with something we cannot place. */
  | "server_error"
  /** Not a host problem at all: this browser refused the local key store. */
  | "storage_blocked";

function phoneIsOffline(): boolean {
  // `onLine === true` means only "an interface is up" — it says nothing about
  // whether the tailnet is reachable, so it can only ever prove the negative.
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

/**
 * Place a failed request on the taxonomy above.
 *
 * `api()` reports a transport failure as status 0, which is the whole basis of
 * the first split: status 0 means no server was heard from, so the fault is
 * between the phone and the desktop. Anything else means something answered,
 * and then the question is only who.
 */
export function classifyUnavailable(error: unknown): UnavailableReason {
  if (!(error instanceof ApiError)) return "server_error";
  if (error.status === 0) {
    if (error.code === "timeout") return "timeout";
    return phoneIsOffline() ? "phone_offline" : "unreachable";
  }
  // Checked before the proxy branch below: this is also a 5xx, but it is one
  // our own sidecar sent, and it means the opposite thing.
  if (error.code === "desktop_unavailable") return "desktop_down";
  // The sidecar's own limiter (`auth.rs` `rate_limit`) never answers 429: it
  // reports `too_many_attempts` on the route's usual failure status — 400 for
  // a challenge, 401 for a login — so the code is the only reliable tell. A
  // 429 is still honoured for a proxy in front of it.
  if (error.status === 429 || error.code === "too_many_attempts") return "busy";
  if (error.status === 403 && error.code === "invalid_origin") return "blocked_origin";
  // Every error the sidecar itself sends carries a JSON `error` code, so a
  // bare `request_failed` on a gateway status is the tell that the body came
  // from a proxy instead — i.e. the tailnet reached the machine, but the
  // sidecar behind it is not listening.
  if (error.status >= 502 && error.code === "request_failed") return "host_down";
  return "server_error";
}

export interface UnavailableCopy {
  /** One line naming what is wrong. */
  title: string;
  /** What to actually do about it. */
  hint: string;
}

/**
 * Deliberately names the *suspects* rather than asserting a single cause where
 * the phone cannot tell them apart. "unreachable" is the honest example: from
 * inside the browser, a phone that dropped off the tailnet and a desktop that
 * went to sleep look identical, and claiming either one would send half the
 * readers to fix the wrong machine.
 */
export function describeUnavailable(reason: UnavailableReason): UnavailableCopy {
  const [title, hint] = UNAVAILABLE_KEYS[reason];
  return { title: tr(title), hint: tr(hint) };
}

/** The title and hint of each reason. With Tailscale off, the desktop's 100.x
 * address routes nowhere and the request stalls instead of failing — so a
 * timeout is the usual shape of "off the tailnet", not proof the desktop was
 * reached; its copy says so. */
const UNAVAILABLE_KEYS: Record<UnavailableReason, [TranslationKey, TranslationKey]> = {
  phone_offline: ["mobile.unavailable.phoneOfflineTitle", "mobile.unavailable.phoneOfflineHint"],
  unreachable: ["mobile.unavailable.unreachableTitle", "mobile.unavailable.unreachableHint"],
  timeout: ["mobile.unavailable.timeoutTitle", "mobile.unavailable.timeoutHint"],
  host_down: ["mobile.unavailable.hostDownTitle", "mobile.unavailable.hostDownHint"],
  desktop_down: ["mobile.unavailable.desktopDownTitle", "mobile.unavailable.desktopDownHint"],
  busy: ["mobile.unavailable.busyTitle", "mobile.unavailable.busyHint"],
  blocked_origin: ["mobile.unavailable.blockedOriginTitle", "mobile.unavailable.blockedOriginHint"],
  storage_blocked: ["mobile.unavailable.storageBlockedTitle", "mobile.unavailable.storageBlockedHint"],
  server_error: ["mobile.unavailable.serverErrorTitle", "mobile.unavailable.serverErrorHint"],
};

/** In the language the phone is set to, read when the copy is asked for —
 * these are plain functions called from render, so the next render after a
 * language switch reads the new one. */
function tr(key: TranslationKey): string {
  return translate(useI18nStore.getState().lang, key);
}

/**
 * The raw shape of the failure, for a bug report. Kept next to the human copy
 * because diagnosing the outage this screen exists for came down to exactly
 * these two numbers, and the phone is often the only place they are visible.
 */
export function unavailableDetail(error: unknown): string | undefined {
  if (!(error instanceof ApiError)) return undefined;
  return error.status === 0 ? error.code : `${error.status} ${error.code}`;
}

/**
 * Codes on the wire, prose on the phone. The sidecar and the desktop bridge
 * answer every refusal with one fixed code (`api_error` in `host.rs`, the
 * `code:` of a bridge error, a terminal socket's `closing` reason, the usage
 * sheet's `error`), and this is the one table that turns a code into a
 * sentence. A screen used to render `String(error)`, which put
 * `Error: desktop_unavailable` — or a CLI's stderr with paths in it — in
 * front of the reader; nothing renders a code now, and a code this table does
 * not know reads as the generic line rather than as itself.
 */
const FAILURE_TEXT: Record<string, TranslationKey> = {
  // The terminal socket's `closing` reasons (`pty_bridge.rs`).
  access_revoked: "mobile.failure.accessRevoked",
  session_expired: "mobile.failure.sessionExpired",
  idle_timeout: "mobile.failure.idleTimeout",
  invalid_terminal_control: "mobile.failure.invalidTerminal",
  invalid_terminal_size: "mobile.failure.invalidTerminal",
  input_frame_too_large: "mobile.failure.inputTooLarge",
  resize_failed: "mobile.failure.resizeFailed",
  replaced: "mobile.failure.replaced",
  session_busy: "mobile.failure.sessionBusy",
  session_gone: "mobile.failure.sessionGone",
  // The sidecar's own refusals (`host.rs`).
  desktop_unavailable: "mobile.unavailable.desktopDownTitle",
  launch_pending: "mobile.failure.launchPending",
  catalog_unavailable: "mobile.failure.catalogUnavailable",
  request_failed: "mobile.unavailable.serverErrorTitle",
  malformed_response: "mobile.failure.malformedResponse",
  authentication_required: "mobile.failure.authenticationRequired",
  invalid_origin: "mobile.unavailable.blockedOriginTitle",
  too_many_attempts: "mobile.failure.tooManyAttempts",
  timeout: "mobile.failure.timeout",
  offline: "mobile.failure.offline",
  project_not_found: "mobile.failure.projectNotShared",
  section_hidden: "mobile.failure.sectionHidden",
  project_ineligible: "mobile.failure.projectNotShared",
  tab_not_found: "mobile.failure.tabNotFound",
  shells_off: "mobile.failure.shellsOff",
  // A sign-in address the phone handed back (`sign_in.rs`).
  invalid_callback: "mobile.failure.invalidCallback",
  callback_not_local: "mobile.failure.callbackNotLocal",
  callback_without_code: "mobile.failure.callbackWithoutCode",
  callback_unreachable: "mobile.failure.callbackUnreachable",
  callback_refused: "mobile.failure.callbackRefused",
  callback_timeout: "mobile.failure.callbackTimeout",
  tab_scope_mismatch: "mobile.failure.tabScopeMismatch",
  agent_tab_required: "mobile.failure.agentTabRequired",
  invalid_request: "mobile.failure.invalidRequest",
  invalid_view: "mobile.failure.invalidRequest",
  invalid_month: "mobile.failure.invalidMonth",
  invalid_subagent: "mobile.failure.invalidSubagent",
  invalid_prompt: "mobile.failure.invalidPrompt",
  invalid_label: "mobile.failure.invalidLabel",
  invalid_color: "mobile.failure.invalidColor",
  invalid_anchor: "mobile.failure.invalidAnchor",
  query_too_long: "mobile.failure.queryTooLong",
  file_not_found: "mobile.failure.fileNotFound",
  read_failed: "mobile.failure.readFailed",
  delete_failed: "mobile.failure.deleteFailed",
  reply_too_long: "mobile.failure.replyTooLong",
  empty_reply: "mobile.failure.emptyReply",
  // The desktop bridge's refusals (`MobileBridgeHost.tsx`).
  desktop_error: "mobile.failure.desktopError",
  unknown_request: "mobile.failure.unknownRequest",
  response_too_large: "mobile.failure.responseTooLarge",
  // A write the desktop made whose refreshed list did not come back
  // (`reloadIfApplied` in `api.ts`): never worded as a refusal, so the reader
  // does not send it again.
  applied_response_too_large: "mobile.failure.appliedResponseTooLarge",
  applied_list_too_large: "mobile.failure.appliedListTooLarge",
  applied_reload_failed: "mobile.failure.appliedReloadFailed",
  launch_failed: "mobile.failure.launchFailed",
  unknown_agent: "mobile.failure.unknownAgent",
  unsupported_sign_in: "mobile.failure.unsupportedSignIn",
  unsupported_mode: "mobile.failure.unsupportedMode",
  persist_failed: "mobile.failure.persistFailed",
  calendar_unavailable: "mobile.failure.calendarUnavailable",
  // Reminders on this phone (`push.ts`).
  invalid_push_subscription: "mobile.failure.invalidPushSubscription",
  push_unavailable: "mobile.failure.pushUnavailable",
  permission_denied: "mobile.failure.permissionDenied",
  invalid_event: "mobile.failure.invalidEvent",
  event_not_found: "mobile.failure.eventNotFound",
  invalid_task: "mobile.failure.invalidTask",
  task_not_found: "mobile.failure.taskNotFound",
  invalid_column: "mobile.failure.invalidColumn",
  column_follows_date: "mobile.failure.columnFollowsDate",
  prompt_not_found: "mobile.failure.promptNotFound",
  alert_gone: "mobile.failure.alertGone",
  alert_resolve_failed: "mobile.failure.alertResolveFailed",
  mail_read_disabled: "mobile.failure.mailReadDisabled",
  mail_actions_disabled: "mobile.failure.mailActionsDisabled",
  mail_reply_disabled: "mobile.failure.mailReplyDisabled",
  mail_mark_failed: "mobile.failure.mailMarkFailed",
  mail_reply_failed: "mobile.failure.mailReplyFailed",
  no_reply_address: "mobile.failure.noReplyAddress",
  folder_not_found: "mobile.failure.folderNotFound",
  message_not_found: "mobile.failure.messageNotFound",
  unexpected_mail_view: "mobile.failure.malformedResponse",
  // The usage sheet (`commands::agent_usage`).
  no_usage_readout: "mobile.failure.noUsageReadout",
  cli_not_installed: "mobile.failure.cliNotInstalled",
  cli_failed: "mobile.failure.cliFailed",
  cli_timeout: "mobile.failure.cliTimeout",
  cli_error: "mobile.failure.cliError",
  cli_output_withheld: "mobile.failure.cliOutputWithheld",
};

const GENERIC_FAILURE = FAILURE_TEXT.request_failed;

/** Whether a string is a wire code and not already prose. */
function isCode(value: string): boolean {
  return /^[a-z][a-z0-9_]*$/.test(value);
}

/** The code behind a failure, or `undefined` for something that carries none. */
export function failureCode(source: unknown): string | undefined {
  if (typeof source === "string") return isCode(source) ? source : undefined;
  if (source instanceof ApiError) return source.code;
  if (source instanceof Error) return isCode(source.message) ? source.message : undefined;
  return undefined;
}

/**
 * The one sentence for a failure, whatever shape it arrived in: an `ApiError`
 * from `api()`, a `closing` reason from the terminal socket, a code the usage
 * sheet was given, or a thrown `Error` whose message is a code. A transport
 * or proxy failure is placed by `classifyUnavailable` first, so "the desktop
 * is closed" and "the phone is off the tailnet" keep the titles the splash
 * uses for them.
 */
export function describeFailure(source: unknown): string {
  if (source instanceof ApiError) {
    const reason = classifyUnavailable(source);
    if (reason !== "server_error") return describeUnavailable(reason).title;
  }
  const code = failureCode(source);
  return tr((code && FAILURE_TEXT[code]) || GENERIC_FAILURE);
}

/** Every code the table knows, for the test that checks each reads as prose. */
export function knownFailureCodes(): string[] {
  return Object.keys(FAILURE_TEXT);
}

/**
 * A failure of the phone's own lock (`localLock.ts`), which throws sentences
 * it wrote itself — "Incorrect PIN.", "Too many attempts…" — rather than
 * codes. Those are shown as written; anything else gets the generic line
 * rather than `String(error)`.
 */
export function localFailureText(reason: unknown): string {
  if (reason instanceof Error && reason.message && !isCode(reason.message)) return reason.message;
  return tr("mobile.failure.generic");
}

/**
 * The failures a stuck tunnel on the phone produces. Tailscale's Android app
 * can keep saying "connected" after a network change while it passes none of
 * the browser's traffic (2026-09-28: pings through the tunnel answered, not
 * one request reached the desktop for hours, a phone restart cleared it).
 * Its own off/on switch did not: the phone kept the same disco key through
 * it, so the engine — and the jam — survived, while the restart came back
 * with a new one. Force-stopping the app ends the engine the same way.
 * Nothing in a web page can repair that, so these screens hand the reader the
 * fix.
 */
export function suspectsTunnel(reason: UnavailableReason): boolean {
  return reason === "unreachable" || reason === "timeout";
}

/** What to try, in order, when `suspectsTunnel`: cheapest first, the phone
 * restart never — a force stop clears the jam as well (confirmed 2026-09-30,
 * after an eduroam → home Wi‑Fi switch). Each step names the phone's own
 * settings path in the reader's language. */
export const TUNNEL_STEPS: readonly TranslationKey[] = [
  "mobile.tunnel.step.open",
  "mobile.tunnel.step.forceStop",
  "mobile.tunnel.step.airplane",
  "mobile.tunnel.step.desktop",
];

/** Opens the Tailscale app on Android (Chrome resolves `intent:` links on a
 * tap), falling back to its store page when it is not installed. `null`
 * elsewhere: iOS has no scheme for it. */
export function tailscaleAppLink(userAgent: string = typeof navigator === "undefined" ? "" : navigator.userAgent): string | null {
  if (!/Android/i.test(userAgent)) return null;
  const store = encodeURIComponent("https://play.google.com/store/apps/details?id=com.tailscale.ipn");
  return `intent://#Intent;package=com.tailscale.ipn;S.browser_fallback_url=${store};end`;
}
