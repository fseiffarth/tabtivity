import { translate, useI18nStore } from "../../src/lib/i18n";
import type { Mark } from "./markup/layer";

/** One row of the phone's list. `kind` says whether it is a project or a box
 * (#31aa) — a box is a scope of its own on the desktop, always "active" here,
 * and a host older than the field sends none, which reads as a project. */
/** A project's pending git state, the desktop pill's dot: changes not yet added ▸ staged, not committed ▸ committed, not pushed ▸ `.git` missing. Absent when clean. */
export type GitDot = "dirty" | "staged" | "unpushed" | "broken";
export interface ProjectRow { id: string; label: string; status: string; kind?: "project" | "box" | "root"; live_sessions: number; last_activity?: number; /** Root only: staged root-agent proposals awaiting a decision — which is made at the desk, never here. */ pending_reviews?: number; git?: GitDot }
export type AgentStatus = "working" | "question" | "interrupted" | "done";
/** The desktop's own one-line summary of a tab's scheduled prompts: what the
 * Agents view prints under an agent tab, so the project overview says the same
 * thing without opening the sheet. `next` is desktop-local wall clock, and so
 * is each `upcoming` row's `at`: the soonest enabled schedules still to fire,
 * which the card lists above its last prompts (absent from an older host). */
export interface TabSchedules { total: number; enabled: number; next?: string; upcoming?: TabPrompt[] }
/** `agent_model` is the model the tab's session is showing, as the desktop
 * reads it off the pane's own status line — the same words, and the same
 * parse, as the model chip in Focus (`terminal/statusLine`); for a tab whose
 * pane the desktop window does not hold it falls back to the model the tab
 * last answered with, shortened from the transcript's id. `working_at`/
 * `done_at` are desktop wall-clock ms of the tab's last working output and
 * last finished turn. All three are the desktop's own readings and absent
 * while it is closed or before the tab has done either. */
/** One prompt an agent tab was given, as the desktop read it off the agent's
 * own transcript — typed into the terminal, pasted, sent from here or by a
 * schedule alike. `at` is the transcript record's ISO instant, which the phone
 * formats in its own zone; a record that carried none arrives without one, and
 * so does the one line a transcript-less agent leaves on its own screen. */
export interface TabPrompt { text: string; at?: string }
export interface TabRow { id: string; label: string; kind: "shell" | "agent"; agent_label?: string; agent_status?: AgentStatus; agent_model?: string; /** The session is in plan mode / running a `/goal`, as the desktop's PLAN and GOAL tab pills read its status line; absent while off or unknown. */ agent_plan?: boolean; agent_goal?: boolean; /** How many subagents the session has at work right now, as the desktop reads its transcript; absent at zero. */ agent_subagents?: number; working_at?: number; done_at?: number; /** Desktop wall clock (ms) of when the current or last turn began; with `working_at`/`done_at` it says how long the tab has been, or was, at work. */ turn_started_at?: number; schedules?: TabSchedules; prompts?: TabPrompt[]; available: boolean; viewer_busy: boolean; last_activity?: number; /** The tab's colour as a palette id (see `tabColors.ts`); absent when it has none. */ color?: string; /** A sign-in tab (`src/lib/agents/signInLaunch.ts`): it opens on its sign-in sheet. */ sign_in?: boolean; /** The linked worktree an agent tab runs in — its folder's leaf name and branch; absent in the project folder's own checkout. */ worktree?: TabWorktree }
export interface TabWorktree { label: string; branch?: string }
/** `default`: the desktop's default agent (`default_agent_cmd`), the one
 * Mark up starts where no agent tab is open; an older desktop flags none. */
export interface AgentRow { id: string; label: string; modes: ("plan" | "auto")[]; default?: boolean }
/** A place the ＋ can start an agent: a linked worktree by opaque id. The
 * main one has an empty label — it is the project folder. */
export interface WorktreeRow { id: string; label: string; branch?: string; main: boolean }
/** One cloud launch an agent offers; `task` → it needs the task up front. */
export interface CloudLaunchRow { agent_id: string; action: "new" | "open"; task: boolean }
/** One agent the ＋ can open a sign-in tab for. `signed_in` is absent where
 * the desktop cannot tell; `alternate` names the CLI's other way in;
 * `api_key` says it starts on an API key the desktop keeps (then
 * `signed_in` is true — it needs no login); `api_budget_reached` says that
 * key's monthly budget is spent or unset, so a new tab would be refused. */
export interface SignInRow { agent_id: string; signed_in?: boolean; account?: string; alternate?: "console" | "browser"; api_key?: boolean; api_budget_reached?: boolean }
/** The ＋ sheet's local-model group: the model the desktop's "+" drives and
 * the agents it offers for it. `ready` is false until the model is on the GPU
 * (a start then loads it first); `caution` marks an agent built for hosted
 * frontier models, which a local model may answer badly. */
export interface LocalAgentRow { id: string; label: string; caution: boolean }
export interface LocalLaunchRow { model: string; ready: boolean; agents: LocalAgentRow[] }
export interface LaunchOptions { worktrees: WorktreeRow[]; cloud: CloudLaunchRow[]; sign_in: SignInRow[]; local?: LocalLaunchRow }

/** `GET /api/v1/projects/{id}/launch-options` — asked when the ＋ sheet opens.
 * A desktop that predates the route answers 404; that reads as "project folder
 * only, no cloud", which is exactly what such a desktop can start. */
export async function getLaunchOptions(projectId: string, signal?: AbortSignal): Promise<LaunchOptions> {
  try {
    const body = await api<Partial<LaunchOptions>>(`/api/v1/projects/${encodeURIComponent(projectId)}/launch-options`, { signal });
    return { worktrees: body.worktrees ?? [], cloud: body.cloud ?? [], sign_in: body.sign_in ?? [], ...(body.local?.agents?.length ? { local: body.local } : {}) };
  } catch (reason) {
    if (reason instanceof ApiError && reason.status === 404) return { worktrees: [], cloud: [], sign_in: [] };
    throw reason;
  }
}
/** The project folder's checkout: its branch, or the short sha it is detached
 * at, and that branch's upstream as of the last fetch. */
export interface GitHead { branch?: string; short?: string; upstream?: string; ahead: number; behind: number }
/** One worktree of the project's repo. `id` is the ＋ sheet's id for the same
 * worktree ("" when none can be minted); `label` is its folder's leaf name, ""
 * for the current one (the project folder), which the phone names by the
 * project. `git` means something only when `checked`. */
export interface GitWorktreeView { id: string; label: string; branch?: string; short?: string; main: boolean; current: boolean; locked: boolean; missing: boolean; git?: GitDot; checked: boolean; tabs: number }
/** A local branch; `worktree` labels the other worktree that has it checked out. */
export interface GitBranchView { name: string; current: boolean; upstream?: string; ahead: number; behind: number; worktree?: string }
/** `GET /api/v1/projects/{id}/git`. Capped lists; each `*_total` is the full count. */
export interface GitOverview {
  repo: boolean;
  head?: GitHead;
  worktrees: GitWorktreeView[];
  worktrees_total: number;
  branches: GitBranchView[];
  branches_total: number;
  remote_branches: string[];
  remote_total: number;
}

/** The project's git overview, read by the phone host itself (window open or
 * not). A host older than the route answers a bodiless 404 — `{ outdated: true }`. */
export async function getGitOverview(projectId: string, signal?: AbortSignal): Promise<GitOverview | { outdated: true }> {
  try {
    return await api<GitOverview>(`/api/v1/projects/${encodeURIComponent(projectId)}/git`, { signal });
  } catch (reason) {
    if (reason instanceof ApiError && reason.status === 404 && reason.code === "request_failed") return { outdated: true };
    throw reason;
  }
}
/** One agent tab in the cross-project activity list: an ordinary tab row plus
 * the project it lives in, because that list is flat and a tab label on its own
 * does not say where the session is. */
export interface ActivityTab extends TabRow { project_id: string; project_label: string }
export interface ActivityList { tabs: ActivityTab[]; desktop_available: boolean }

/** `GET /api/v1/activity` — every agent tab the desktop reports as working,
 * waiting on a decision, or done, across every project this phone may reach.
 * The desktop classifies; with none open the list is empty rather than wrong. */
export function getActivity(signal?: AbortSignal): Promise<ActivityList> {
  return api<ActivityList>("/api/v1/activity", { signal });
}
export type ScheduleRule =
  | { type: "once"; at: string }
  | { type: "daily"; time: string }
  | { type: "weekdays"; weekdays: number[]; time: string };
export interface ScheduledPrompt {
  id: string;
  enabled: boolean;
  message: string;
  rule: ScheduleRule;
  last?: { occurrence: string; result: "delivered" | "missed" | "failed"; at: string };
}
export interface ScheduledPromptInput { enabled: boolean; message: string; rule: ScheduleRule }
/** `desktop_available: false` on any of these lists means the host answered
 * off its files because no Tabtivity window is open: the data is current but
 * read-only until the desktop is back (headless owner plan, H0). */
export interface ScheduledPromptList { schedules: ScheduledPrompt[]; time_zone: string; next_runs: Record<string, string>; desktop_available?: boolean }
/** A prompt collected for a project without a tab. Ids and timestamps are the
 * desktop's; the phone only ever sends the text. */
export interface ProjectPrompt { id: string; message: string; created_at: string; updated_at: string }
export interface ProjectPromptList { prompts: ProjectPrompt[]; desktop_available?: boolean }
/** An agent tab closed in the project this desktop session, newest first — an
 * opaque id and its label, reopened by `reopenTab`. */
export interface ClosedTabRow { id: string; label: string; agent: string; closed_at: number }
/** `files`: whether the read-only file browser answers for this project
 * (the desktop's switch is on, and it is a project, not a box or root). */
export interface ProjectDetail { project: ProjectRow; tabs: TabRow[]; desktop_available: boolean; agents: AgentRow[]; closed?: ClosedTabRow[]; files?: boolean; /** The phone may open shell tabs (`shell_tabs` on the desktop); absent is off. */ shells?: boolean }
export interface TodoColumn { id: string; name: string; position: number; done: boolean; archived: boolean; intake: boolean; overdue: boolean; due_today: boolean; color?: string }
export interface TodoSubtask { id: string; title: string; done: boolean }
export interface TodoTaskInput {
  title: string;
  notes: string;
  due?: string | null;
  priority: number;
  percent: number;
  column: string;
  calendar_id: string;
  project_id?: string | null;
  tags: string[];
  subtasks: TodoSubtask[];
}
export interface TodoCard extends TodoTaskInput { id: string; done: boolean; rank?: number }
export interface TodoCalendar { id: string; name: string }
export interface TodoProject { id: string; name: string }
export interface TodoBoard {
  columns: TodoColumn[];
  tasks: TodoCard[];
  calendars: TodoCalendar[];
  projects: TodoProject[];
  /** False when the host read the board off its files with no window open. */
  desktop_available?: boolean;
}

/**
 * Mobile hosts from an earlier feature revision omitted empty arrays to save a
 * few bytes. The board UI treats those fields as collections, so normalize a
 * response at the boundary rather than allowing one untagged legacy card to
 * take down the whole screen.
 */
export function normalizeTodoBoard(board: TodoBoard): TodoBoard {
  return {
    ...board,
    // `archived` is the newest of these fields, so a desktop older than it sends
    // a column without one; false is the honest reading — a board that has no
    // archive column has nothing for "hide archived" to hide.
    columns: (board.columns ?? []).map((column) => ({
      ...column,
      archived: column.archived ?? false,
      // `intake` is newer still, and a desktop that does not send one had the
      // board laid out so that the leftmost open column *was* the intake — which
      // is what the callers fall back to when no column carries the flag.
      intake: column.intake ?? false,
      // The date-governed pair. False from an older desktop is the honest
      // reading again: a board that flags neither has no column a deadline
      // decides, so no move into one needs refusing.
      overdue: column.overdue ?? false,
      due_today: column.due_today ?? false,
    })),
    tasks: (board.tasks ?? []).map((task) => ({
      ...task,
      notes: task.notes ?? "",
      tags: task.tags ?? [],
      subtasks: task.subtasks ?? [],
    })),
    calendars: board.calendars ?? [],
    projects: board.projects ?? [],
  };
}
export type MobileAlertKind = "mail" | "event" | "task";
export type MobileAlertSeverity = "overdue" | "now" | "soon" | "upcoming";
/** A bounded snapshot of the desktop Alerts feed. Source ids never cross the
 * mobile boundary: the only two handles a row carries are opaque and named by
 * the desktop — the board card behind a task row, and the row itself, which is
 * what `resolveAlert` presses the ✓ on. What that ✓ *does* stays desktop-side. */
export interface MobileAlertItem {
  kind: MobileAlertKind;
  severity: MobileAlertSeverity;
  title: string;
  detail: string;
  at?: string;
  all_day: boolean;
  minutes_away?: number;
  days_away?: number;
  /** `kind === "task"` only: the board's own opaque card id, so tapping the row
   * can open that card rather than dropping the reader at the whole board. */
  task_id?: string;
  /** The row's opaque handle, the one thing `resolveAlert` needs to press its ✓.
   * It names a row of this feed and nothing behind it — a row the desktop could
   * not mint a handle for simply carries no ✓. */
  alert_id?: string;
}
export interface MobileAlerts { enabled: boolean; items: MobileAlertItem[] }

/** `POST /api/v1/alerts` — the desktop strip's ✓, pressed from the phone.
 *
 * What Done means is the desktop's and stays there: a card is completed into
 * the board's Done column, a mail's local priority mark is cleared, a meeting is
 * muted in the strip. None of the three deletes anything, and the phone names
 * only the row. The answer is the feed as it stands afterwards, so the list the
 * ✓ came from is replaced rather than patched by guesswork. */
export function resolveAlert(alertId: string): Promise<{ alerts: MobileAlerts }> {
  return reloadIfApplied(
    api("/api/v1/alerts", { method: "POST", body: JSON.stringify({ alert_id: alertId }) }),
    () => api("/api/v1/alerts"),
  );
}
/** A bounded, read-only occurrence expanded by the connected desktop. It never
 * carries a calendar/event id, notes, conferencing links, or write capability. */
export interface MobileCalendarEvent {
  id: string;
  calendar_id: string;
  occurrence_start: string;
  start: string;
  end: string;
  all_day: boolean;
  title: string;
  location?: string;
  notes?: string;
  conference?: string;
  category?: string;
  color: string;
  status?: string;
  recurring: boolean;
}
export interface MobileCalendarInfo {
  id: string;
  name: string;
  color: string;
  visible: boolean;
  readonly: boolean;
  /** A subscribed feed. Only the fact crosses; the feed URL, which routinely
   * embeds a private token, stays on the desktop. */
  subscribed?: boolean;
  caldav: boolean;
}
export interface MobileCalendarEventInput {
  calendar_id: string;
  start: string;
  end: string;
  all_day: boolean;
  title: string;
  location: string;
  notes: string;
  conference: string;
  category: string;
  status: string;
}
export type CalendarAction =
  | { type: "create_event"; event: MobileCalendarEventInput }
  | { type: "update_event"; event_id: string; event: MobileCalendarEventInput }
  | { type: "delete_event"; event_id: string }
  | { type: "create_calendar"; name: string; color: string }
  | { type: "update_calendar"; calendar_id: string; name: string; color: string; visible: boolean }
  | { type: "delete_calendar"; calendar_id: string };
export interface MobileCalendar {
  month: string;
  week_start: 0 | 1;
  calendars: MobileCalendarInfo[];
  events: MobileCalendarEvent[];
  truncated: boolean;
  /** False when the host expanded the month off its files with no window open. */
  desktop_available?: boolean;
}
export interface MobileMailFolder { id: string; name: string; kind: string; unread: number; total: number }
export interface MobileMailAccount { id: string; label: string; address: string; folders: MobileMailFolder[] }
export interface MobileMailHeader { id: string; subject: string; sender: { name?: string; address: string }; date: string; seen: boolean; flagged?: boolean; answered?: boolean; has_attachments: boolean; preview: string }
export interface MobileMailAttachment { filename: string; mime: string; size: number }

/** The host reads these display preferences from desktop settings on each
 * probe: the untested pills, the desktop's theme for a phone that follows it,
 * and the sections the desktop keeps this phone out of (absent from an older
 * host: none). */
export function getMobileStatus(): Promise<{ show_untested_tags?: boolean; color_scheme?: string; hidden_sections?: string[] }> {
  return api("/api/v1/status");
}
/** The only flag writes the phone may ask for. Delete and move do not exist here. */
export type MailMarkAction = "seen" | "unseen" | "flag" | "unflag";
/** What the connected desktop lets this phone *do* to mail, beyond reading.
 * Both are desktop settings, default off; the phone hides the controls rather
 * than discovering a refusal. Absent from an older desktop means off. */
export interface MobileMailWrites { actions?: boolean; reply?: boolean }
export type MobileMailView =
  | ({ view: "overview"; accounts: MobileMailAccount[] } & MobileMailWrites)
  | { view: "folder"; folder: MobileMailFolder; messages: MobileMailHeader[]; total: number; offset: number }
  | { view: "message"; message: MobileMailHeader; body: string; truncated: boolean; attachments: MobileMailAttachment[] };

export class ApiError extends Error {
  /** `detail`: the refusal's whole body, for a route whose refusal carries
   * more than its code (Mark up's `undo_conflict` names the files). */
  constructor(public status: number, public code: string, public detail?: unknown) { super(code); }
}

/** Set by the app root. A session slides out after a quiet quarter hour and
 * vanishes when the mobile host restarts. The handler answers whether it
 * renewed the session silently — the device key signs a fresh challenge, no
 * PIN — in which case the request that met the 401 is sent once more; when it
 * could not, the app has already moved to its lock screen. */
let onUnauthorized: (() => Promise<boolean>) | undefined;

export function setUnauthorizedHandler(handler: (() => Promise<boolean>) | undefined): void {
  onUnauthorized = handler;
}

/** Renew the session the way a 401 would, for a caller that met the lapse
 * elsewhere — the terminal socket's `session_expired` close. */
export function recoverSession(): Promise<boolean> {
  return onUnauthorized?.() ?? Promise.resolve(false);
}

/** A stalled socket on bad signal would otherwise hang a screen forever; the
 * splash in particular had no way back. */
const REQUEST_TIMEOUT = 10_000;

/* Deadlines for the routes whose far side may rightly take longer than
 * `REQUEST_TIMEOUT`. Each sits above the whole budget the host can spend
 * before it answers, so the host's own stated failure (`launch_pending`,
 * `mail_fetch_failed`, `callback_timeout`) is what the reader sees — at the
 * default these routes gave up first and said "Your desktop didn't answer"
 * about an action that then completed anyway. The budgets are the sidecar's:
 * `admin::desktop_call` allows 2 s to reach the desktop plus the request's
 * `DesktopRequest::response_timeout` (`protocol.rs`). Change one side and the
 * other must follow; `MobileApiDeadlines.test.ts` pins the relation. */

/** A tab the desktop opens — a create, a reopen, a sign-in tab: 2 s connect +
 * 10 s for the desktop's answer (`response_timeout` default), then up to 5 s
 * of the sidecar polling its catalog for the new row (`created_through_desktop`
 * in `host.rs`, 40 × 125 ms plus the reads themselves). */
export const TAB_CREATE_TIMEOUT = 25_000;
/** Opening a mail message, or flagging one: 2 s connect + 35 s
 * (`response_timeout` for `MailMessage`/`MailMark` — a first open may fetch
 * the body over IMAP). */
export const MAIL_MESSAGE_TIMEOUT = 40_000;
/** Sending a reply: 2 s connect + 65 s (`MailReply` talks to SMTP and IMAP). */
export const MAIL_REPLY_TIMEOUT = 70_000;
/** Handing an agent CLI its sign-in callback: the CLI exchanges the code with
 * its provider before it answers, and the sidecar waits 20 s for that
 * (`sign_in::CALLBACK_TIMEOUT`). */
export const SIGN_IN_CALLBACK_TIMEOUT = 25_000;
/** The pause before a read dropped in transit goes out again. */
const READ_RETRY_DELAY = 400;

/** A deadline, ours or the caller's. `AbortSignal.timeout` rejects the fetch
 * with a `TimeoutError`, not an `AbortError`, so testing the name alone
 * reported every stalled request as `offline` — "is Tailscale on?" for what
 * was a slow answer. The error's shape is still the browser's to choose — a
 * phone reported "warm-up failed after 10000 ms", the deadline to the
 * millisecond, as a failure — so the signal that carried the deadline is
 * asked first: if it fired, this was a stall, whatever the rejection says. */
function aborted(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  return error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError");
}

function withTimeout(signal: AbortSignal | null | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  if (!signal) return timeout;
  if (typeof AbortSignal.any === "function") return AbortSignal.any([signal, timeout]);
  // Pre-Baseline fallback: falling back to the caller's signal alone silently
  // dropped the timeout, reintroducing the forever-hung screen on bad signal.
  const both = new AbortController();
  const abort = () => both.abort();
  if (signal.aborted || timeout.aborted) abort();
  signal.addEventListener("abort", abort);
  timeout.addEventListener("abort", abort);
  return both.signal;
}

/**
 * Put the connection to the host to work, answer unread. The browser keeps the
 * HTTP/2 connection it had before the phone slept, and only finds out that it
 * died by sending on it and waiting out a liveness ping. Sent the moment the
 * app is back in front of the reader, that wait runs while they are still at
 * the fingerprint sheet rather than after it, on the sign-in. `/healthz` is
 * unauthenticated and the service worker leaves it alone.
 */
export function primeConnection(): void {
  const started = performance.now();
  traceConnect("warm-up sent");
  const signal = AbortSignal.timeout(REQUEST_TIMEOUT);
  void fetch("/healthz", { cache: "no-store", signal })
    .then((response) => traceConnect(`warm-up ${response.status} after ${Math.round(performance.now() - started)} ms`))
    .catch((error: unknown) => traceConnect(`warm-up ${aborted(error, signal) ? "timed out" : "failed"} after ${Math.round(performance.now() - started)} ms`));
}

/**
 * Where the time went on the way in: the warm-up, the lock's logout, each
 * sign-in request with its outcome, stamped from the moment the app started
 * or last came to the front. The slow "Connecting…" splash and the failure
 * splash show it, so a slow unlock can be read off the phone instead of
 * guessed at from the desktop.
 */
let traceOrigin = 0;
let trace: string[] = [];
const TRACE_LINES = 24;

export function traceConnect(event: string, restart = false): void {
  const now = performance.now();
  if (restart) {
    traceOrigin = now;
    trace = [];
  }
  trace = [...trace, `${((now - traceOrigin) / 1000).toFixed(1)} s  ${event}`].slice(-TRACE_LINES);
}

export function connectTrace(): readonly string[] {
  return trace;
}

/** `timeoutMs` overrides the default deadline for the routes that need a
 * longer one (`getAgentStatus`, and the constants under `REQUEST_TIMEOUT`);
 * everything else keeps `REQUEST_TIMEOUT`, because a screen with no way back
 * is worse than a failed request. */
export async function api<T>(path: string, init?: RequestInit, timeoutMs = REQUEST_TIMEOUT, retried = false): Promise<T> {
  let signal: AbortSignal | undefined;
  const send = () => {
    signal = withTimeout(init?.signal, timeoutMs);
    return fetch(path, {
      ...init,
      credentials: "same-origin",
      cache: "no-store",
      signal,
      headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    });
  };
  let response: Response;
  try {
    response = await send();
  } catch (error) {
    if (aborted(error, signal)) throw new ApiError(0, "timeout");
    // A read the network dropped before any answer — the browser abandons
    // what is in flight when the phone's network changes, which is what the
    // Tailscale app bringing its tunnel back after a wake looks like — goes
    // out once more. Only a read: a write may have landed before the drop.
    if ((init?.method ?? "GET").toUpperCase() !== "GET" || init?.signal?.aborted) throw new ApiError(0, "offline");
    await new Promise((resolve) => { setTimeout(resolve, READ_RETRY_DELAY); });
    try {
      response = await send();
    } catch (again) {
      throw new ApiError(0, aborted(again, signal) ? "timeout" : "offline");
    }
  }
  let body: { error?: string } | undefined;
  try {
    body = await response.json() as { error?: string };
  } catch {
    body = undefined;
  }
  if (response.status === 401 && !path.startsWith("/api/v1/auth/") && path !== "/api/v1/pair") {
    // Once: a 401 on the retry means the renewed session is refused too.
    if (!retried && await onUnauthorized?.()) return api<T>(path, init, timeoutMs, true);
  }
  if (!response.ok) throw new ApiError(response.status, body?.error ?? "request_failed", body);
  // A truncated body on a 200 used to become `{}` and reach callers as `T`,
  // which then read `undefined.map` and white-screened the whole app.
  if (body === undefined) throw new ApiError(response.status, "malformed_response");
  return body as T;
}

/** The desktop made the change, but the refreshed list it answers a write with
 * was too large to relay (`admin::APPLIED_RESPONSE_TOO_LARGE`). Not a failed
 * write: sending it again would apply it twice. */
const APPLIED_RESPONSE_TOO_LARGE = "applied_response_too_large";

/** Whether a failed write was in fact made — its list just could not be shown.
 * A screen then clears its form exactly as on success, and offers no retry. */
export function wasApplied(reason: unknown): boolean {
  return reason instanceof ApiError && reason.code.startsWith("applied_");
}

/** A write that answers with its refreshed list. When the desktop applied it
 * but could not relay that list, the list is read through `reload` — the
 * ordinary read route, with that route's own fallbacks — and the caller sees a
 * plain success. A reload that fails too still says the change was made
 * (`wasApplied`), with a code of the phone's own for the sentence. */
export async function reloadIfApplied<T>(write: Promise<T>, reload: () => Promise<T>): Promise<T> {
  try {
    return await write;
  } catch (reason) {
    if (!(reason instanceof ApiError) || reason.code !== APPLIED_RESPONSE_TOO_LARGE) throw reason;
    try {
      return await reload();
    } catch (again) {
      const tooLarge = again instanceof ApiError && again.code === "response_too_large";
      throw new ApiError(reason.status, tooLarge ? "applied_list_too_large" : "applied_reload_failed");
    }
  }
}

/** Mirrors the desktop's `protocol::MAX_TAB_LABEL`: the catalog truncates a
 * label to this many characters when it publishes one, so a longer rename would
 * come back as different text than was typed. */
export const MAX_TAB_LABEL = 120;

/** `PUT /api/v1/tabs/{id}` — rename one agent tab. The desktop owns the tab
 * layout, so this is a bridge call and needs desktop Tabtivity to be open. */
export function renameTab(tabId: string, label: string): Promise<{ tab?: TabRow; label?: string }> {
  return api(`/api/v1/tabs/${encodeURIComponent(tabId)}`, { method: "PUT", body: JSON.stringify({ label }) });
}

/** `PUT /api/v1/tabs/{id}/color` — paint one tab, agent or shell, with a colour
 * from the palette, or clear it by passing `null`. Only the palette id crosses;
 * both surfaces resolve it to the same hex (see `tabColors.ts`). Its own route
 * rather than a field on the rename above, because the rename is agent-only
 * while a colour is for any tab the phone lists. A bridge call, so it needs
 * desktop Tabtivity open. */
export function setTabColor(tabId: string, color: string | null): Promise<{ tab?: TabRow; color?: string | null }> {
  return api(`/api/v1/tabs/${encodeURIComponent(tabId)}/color`, { method: "PUT", body: JSON.stringify({ color }) });
}

/** `POST /api/v1/tabs/{id}/prompt` — tell the desktop what the composer just
 * sent to this agent tab, for its prompt history: the words went to tmux over
 * the terminal socket, where the desktop never sees them. Fire-and-forget —
 * the prompt is already on its way, and a lost report costs a list row. */
export function reportSentPrompt(tabId: string, message: string): Promise<unknown> {
  return api(`/api/v1/tabs/${encodeURIComponent(tabId)}/prompt`, { method: "POST", body: JSON.stringify({ message }) });
}

/** `POST /api/v1/tabs/{id}/held` — a prompt sent while the agent works: the
 * desktop holds it and types it at the tab's next safe idle point, so it can
 * still be edited (`editHeldPrompt`). Answers the id to edit it by; refused
 * when there is no desktop window to hold it. */
export async function holdPrompt(tabId: string, message: string): Promise<string> {
  const { id } = await api<{ id: string }>(`/api/v1/tabs/${encodeURIComponent(tabId)}/held`, { method: "POST", body: JSON.stringify({ message }) });
  return id;
}

/** `PUT /api/v1/tabs/{id}/held/{heldId}` — new words for a held prompt.
 * `409 held_gone` once the agent has it, `409 held_busy` while it is typed. */
export function editHeldPrompt(tabId: string, heldId: string, message: string): Promise<unknown> {
  return api(`/api/v1/tabs/${encodeURIComponent(tabId)}/held/${encodeURIComponent(heldId)}`, { method: "PUT", body: JSON.stringify({ message }) });
}

/** `POST /api/v1/tabs/{id}/undo-clear` — take back this agent tab's last
 * `/clear`: the desktop types the resume of the conversation it ended (the
 * session id never comes here). `409 nothing_to_undo` once the session has
 * moved on. A bridge call, so it needs desktop Tabtivity open. */
export function undoClear(tabId: string): Promise<{ undone: boolean }> {
  return api(`/api/v1/tabs/${encodeURIComponent(tabId)}/undo-clear`, { method: "POST" });
}

/** `POST /api/v1/tabs/{id}/sign-in-callback` — the address the phone's
 * browser ended on after an agent's sign-in redirected it to `localhost`,
 * for the desktop to deliver to the CLI waiting there. The sidecar does it
 * itself, so this works with the desktop window closed. */
export function finishSignIn(tabId: string, url: string): Promise<{ delivered: boolean }> {
  return api(`/api/v1/tabs/${encodeURIComponent(tabId)}/sign-in-callback`, { method: "POST", body: JSON.stringify({ url }) }, SIGN_IN_CALLBACK_TIMEOUT);
}

/** `POST /api/v1/tabs/{id}/sign-in` — a sign-in tab for the CLI this agent
 * tab runs, beside it; the desktop picks the login command from the tab's
 * own. `alternate` asks for the CLI's other way in. */
export function openSignInTab(tabId: string, alternate: boolean, idempotencyKey: string): Promise<{ tab: TabRow }> {
  return api(`/api/v1/tabs/${encodeURIComponent(tabId)}/sign-in`, { method: "POST", body: JSON.stringify({ alternate, idempotency_key: idempotencyKey }) }, TAB_CREATE_TIMEOUT);
}

/** Which side of the anchor tab a dragged row lands on — the desktop's own
 * `reorderTabInScope` vocabulary, so both surfaces mean one thing by a drop. */
export type TabPlace = "before" | "after";

/** `PUT /api/v1/tabs/{id}/order` — move one tab next to another inside the same
 * project, the phone's half of the desktop Agents view's drag reorder. Both
 * tabs are named by their opaque ids; the answer is the project's tab ids in
 * the order the desktop now holds them, which is what the list reconciles
 * against after having rearranged itself on the drop. A bridge call, so it
 * needs desktop Tabtivity open. */
export function reorderTab(tabId: string, anchorId: string, place: TabPlace): Promise<{ tabs?: string[] }> {
  return api(`/api/v1/tabs/${encodeURIComponent(tabId)}/order`, {
    method: "PUT",
    body: JSON.stringify({ anchor: anchorId, place }),
  });
}

/** `DELETE /api/v1/tabs/{id}` — close one tab, agent or shell. Closing is the
 * desktop's own ×: the tab leaves the Tabtivity window, and the session behind it
 * keeps running and stays reattachable from the desktop's Sessions view. Like
 * the rename above it is a bridge call, so it needs desktop Tabtivity open. */
export function closeTab(tabId: string): Promise<{ closed: boolean }> {
  return api(`/api/v1/tabs/${encodeURIComponent(tabId)}`, { method: "DELETE" });
}

/** `POST /api/v1/projects/{id}/tabs/reopen` — bring back a closed agent tab
 * (the newest, or the one `closedId` names) on the desktop, resuming its
 * conversation, as the desktop's own "Reopen closed agent tab" does. Answers
 * with the reopened tab's row; `409 nothing_to_reopen` once it is gone. */
export function reopenTab(projectId: string, closedId?: string): Promise<{ tab: TabRow }> {
  return api(`/api/v1/projects/${encodeURIComponent(projectId)}/tabs/reopen`, {
    method: "POST",
    body: JSON.stringify(closedId ? { closed_id: closedId } : {}),
  }, TAB_CREATE_TIMEOUT);
}

const schedulePath = (tabId: string) => `/api/v1/tabs/${encodeURIComponent(tabId)}/schedules`;

export function getSchedules(tabId: string): Promise<ScheduledPromptList> {
  return api(schedulePath(tabId));
}

export function createSchedule(tabId: string, schedule: ScheduledPromptInput): Promise<ScheduledPromptList> {
  return reloadIfApplied(api(schedulePath(tabId), { method: "POST", body: JSON.stringify(schedule) }), () => getSchedules(tabId));
}

export function updateSchedule(tabId: string, scheduleId: string, schedule: ScheduledPromptInput): Promise<ScheduledPromptList> {
  return reloadIfApplied(api(`${schedulePath(tabId)}/${encodeURIComponent(scheduleId)}`, {
    method: "PUT",
    body: JSON.stringify(schedule),
  }), () => getSchedules(tabId));
}

export function deleteSchedule(tabId: string, scheduleId: string): Promise<ScheduledPromptList> {
  return reloadIfApplied(api(`${schedulePath(tabId)}/${encodeURIComponent(scheduleId)}`, { method: "DELETE" }), () => getSchedules(tabId));
}

/** What one agent CLI answered when asked about its own quota. `raw` is the
 * panel as the CLI printed it — the sheet's Terminal half shows exactly that,
 * and `shared/usageReport.ts` is the only thing that parses it. */
export interface AgentUsagePanel { label: string; supported: boolean; raw?: string; error?: string; cached: boolean }
/** Today's counters for the tab's project, at the grain the desktop records
 * them: `prompts` is this agent's, the other three are the project's — every
 * agent tab in it — which is what the sheet's wording says. */
export interface AgentTally { prompts: number; worked_s: number; decisions: number; done: number }
export interface AgentStatusReport {
  state: AgentStatus | "idle";
  label: string;
  agent?: string;
  project: string;
  today: AgentTally;
  usage: AgentUsagePanel;
}

/** Reading the usage panel may run the agent's CLI once on the desktop, which
 * is slower than any other control call — its own deadline, above the desktop's
 * (20s) and the CLI's (15s), so a slow answer arrives rather than being cut. */
const STATUS_TIMEOUT = 30_000;

/** `GET /api/v1/tabs/{id}/status` — the composer's status chip. `refresh` asks
 * the desktop to run the CLI again instead of answering from its short-lived
 * cache; the desktop applies its own floor to that, so holding the button down
 * cannot spawn a process per tap. */
export async function getAgentStatus(tabId: string, refresh = false): Promise<AgentStatusReport> {
  const query = refresh ? "?refresh=1" : "";
  const { report } = await api<{ report: AgentStatusReport }>(
    `/api/v1/tabs/${encodeURIComponent(tabId)}/status${query}`,
    undefined,
    STATUS_TIMEOUT,
  );
  return report;
}

/** A question the agent asked, as answered: its rows, the ones the answer
 * took marked, and the answer itself — absent when it was turned down. */
export interface AskedQuestion {
  header?: string;
  question: string;
  options?: { label: string; description?: string; chosen?: boolean }[];
  answer?: string;
}

/** One turn of an agent tab's stored conversation, as the desktop reads it
 * off the CLI's own transcript (`services::agent_transcript`). An `agent`
 * entry is a subagent the agent spawned: `text` is what it was sent to do,
 * `role` its kind, and `subagent` the handle that reads its own conversation
 * (`getTranscript`) — absent until its CLI has recorded where that lives. */
export interface TranscriptEntry {
  kind: "prompt" | "answer" | "agent";
  text: string;
  at?: string;
  cut?: boolean;
  subagent?: string;
  role?: string;
  /** On an `answer`: the plan the agent put up for approval (Claude's
   * `ExitPlanMode`), set apart from its ordinary answers. */
  plan?: boolean;
  /** On an `answer`: the questions the agent asked (Claude's
   * `AskUserQuestion`), with the answers they got — sent once answered, so
   * the one still waiting is the live screen's. `text` says the same plainly. */
  questions?: AskedQuestion[];
  /** On an `agent`: it has not reported back yet (Claude's spawn call has
   * no result in the transcript). */
  running?: boolean;
  /** On an `agent`: it has reported back (Claude's spawn call has its
   * result, or — sent to the background — its task notification came).
   * Absent where the CLI's record does not say. */
  finished?: boolean;
  /** On an `agent`: it runs in the background (Claude's async launch), at
   * work while the session's own turn may be over. */
  background?: boolean;
  /** Phone-only, never on the wire: a prompt sent from here that the session
   * has not recorded yet (`terminal/pendingPrompts`), by its id — and whether
   * the link failed to deliver it, or is trying again. */
  pending?: number;
  failed?: boolean;
  retrying?: boolean;
  /** Phone-only: a pending prompt the desktop still holds for the agent's
   * next idle point, which the reader can still edit. */
  held?: boolean;
  /** Phone-only: a pending prompt the desktop holds and has not typed yet —
   * it waits at the chat's end, below the agent at work. */
  queued?: boolean;
  /** Phone-only: when a pending prompt left this phone (its bubble's time;
   * `at` on it is only its place). */
  sentAt?: string;
}
export interface SessionTranscript {
  available: boolean;
  /** Why not, when unavailable: `unsupported`, `no_session`, `no_transcript`,
   * `no_subagent`, `read_failed`. */
  reason?: string;
  /** Hand back on the next read to be answered `unchanged`. */
  version?: string;
  unchanged?: boolean;
  entries: TranscriptEntry[];
  /** Earlier turns exist that this answer does not carry. */
  truncated: boolean;
  /** Those earlier turns hold a subagent the answer does not list — what
   * the Subagents index's "+" stands for. */
  agentsEarlier?: boolean;
  /** How many of the session's subagents are at work right now, the ones
   * the answer leaves out included; absent at zero and on a CLI whose record
   * does not say (only Claude's does). */
  runningAgents?: number;
  /** The session's own usage figures, where its transcript records them
   *  (Codex's rollout does; Claude's does not). */
  usage?: SessionUsage;
  /** The model its newest record names, as an API id — a subagent's own. */
  model?: string;
  /** The tokens its newest request carried (context plus answer), the count
   * Claude Code's own subagent row shows — read off a subagent's own file. */
  tokens?: number;
  /** Desktop Reader only (the phone's API strips it): the shell commands the
   * agent is running now — Claude's `Bash` calls still without a result, and
   * background ones still running. */
  shells?: RunningShell[];
}

/** A shell command the agent started and is waiting on. */
export interface RunningShell {
  command: string;
  description?: string;
  at?: string;
  /** The command was cut at the desktop's bound. */
  cut?: boolean;
  /** Sent to the background: it can run on past the turn. */
  background?: boolean;
}

/** One rate-limit window of a stored session: percent used, and the reset in
 *  Unix seconds. */
export interface SessionUsageWindow { used: number; resetsAt?: number }
export interface SessionUsage {
  /** Percent of the context window left. */
  contextLeft?: number;
  session?: SessionUsageWindow;
  week?: SessionUsageWindow;
}

/** `GET /api/v1/tabs/{id}/transcript` — the Focus view's stored-session feed.
 * `version` is what the last answer carried: while the transcript file has
 * not moved the desktop answers `unchanged` and no turns cross the link, which
 * is what makes polling it while the agent works affordable on cellular.
 * `subagent`, the handle on an `agent` entry, reads that subagent's own
 * conversation instead. */
export async function getTranscript(tabId: string, version?: string, limit?: number, signal?: AbortSignal, subagent?: string): Promise<SessionTranscript> {
  const query = new URLSearchParams();
  if (version) query.set("version", version);
  if (limit) query.set("limit", String(limit));
  if (subagent) query.set("subagent", subagent);
  const suffix = query.size > 0 ? `?${query}` : "";
  const { transcript } = await api<{ transcript: SessionTranscript }>(
    `/api/v1/tabs/${encodeURIComponent(tabId)}/transcript${suffix}`,
    { signal },
  );
  return transcript;
}

/** A file the phone dropped into the tab's project inbox. `reference` is
 * project-relative (`.tabtivity/inbox/<file>`) — the one path shape that crosses
 * this boundary, because it carries no host component and is exactly what the
 * agent needs after an `@`. */
export interface InboxAttachment { name: string; reference: string; size: number }
/** Mirrors the desktop's `inbox::MAX_INBOX_FILE`; checked here first so an
 * oversized pick fails before any bytes leave the phone. */
export const MAX_INBOX_FILE = 24 * 1024 * 1024;
/** The `accept` of the fallback `<input>` behind every "a file from this
 * phone" picker (see `pickPhoneFiles`). The wildcards cover every type between
 * them — an unknown file is `application/octet-stream`. */
export const ANY_FILE_ACCEPT = "application/*,text/*,image/*,video/*,audio/*";

type OpenFilePicker = (options: { multiple: boolean }) => Promise<Array<{ getFile(): Promise<File> }>>;

/** Opens the phone's own file picker for "a file from this phone" and hands
 * the picks to `onFiles`. Android Chrome routes every `<input type=file>`
 * through a chooser of the camera plus whichever app takes GET_CONTENT — on
 * many phones only the photo picker, so internal storage and the SD card are
 * out of reach whatever the `accept` says. `showOpenFilePicker` launches the
 * system Files picker (OPEN_DOCUMENT) directly. Where it is missing (iOS,
 * older Chrome) or refuses, `fallback` — an `ANY_FILE_ACCEPT` input — is
 * clicked instead. Must run inside the tap that asked for it. */
export function pickPhoneFiles(fallback: HTMLInputElement | null, onFiles: (files: File[]) => void): void {
  const picker = (window as { showOpenFilePicker?: OpenFilePicker }).showOpenFilePicker;
  if (typeof picker !== "function") {
    fallback?.click();
    return;
  }
  let handles: ReturnType<OpenFilePicker>;
  try {
    handles = picker.call(window, { multiple: true });
  } catch {
    fallback?.click();
    return;
  }
  void handles.then(
    (picked) => Promise.all(picked.map((handle) => handle.getFile())).then(onFiles),
    (error: unknown) => {
      // Backing out of the picker is an AbortError — nothing was asked for.
      if (error instanceof DOMException && error.name === "AbortError") return;
      fallback?.click();
    },
  );
}
/** A photo over a cellular link is not a 10-second request. */
const UPLOAD_TIMEOUT = 120_000;

/** `POST /api/v1/tabs/{id}/inbox` — the raw file as the body, its name in the
 * query (a header cannot carry a non-Latin-1 photo-library name). */
const promptsPath = (projectId: string) => `/api/v1/projects/${encodeURIComponent(projectId)}/prompts`;

export function getPrompts(projectId: string): Promise<ProjectPromptList> {
  return api(promptsPath(projectId));
}

export function createPrompt(projectId: string, message: string): Promise<ProjectPromptList> {
  return reloadIfApplied(api(promptsPath(projectId), { method: "POST", body: JSON.stringify({ message }) }), () => getPrompts(projectId));
}

export function updatePrompt(projectId: string, promptId: string, message: string): Promise<ProjectPromptList> {
  return reloadIfApplied(api(`${promptsPath(projectId)}/${encodeURIComponent(promptId)}`, { method: "PUT", body: JSON.stringify({ message }) }), () => getPrompts(projectId));
}

export function deletePrompt(projectId: string, promptId: string): Promise<ProjectPromptList> {
  return reloadIfApplied(api(`${promptsPath(projectId)}/${encodeURIComponent(promptId)}`, { method: "DELETE" }), () => getPrompts(projectId));
}

/** Send-now: the desktop turns the prompt into a one-time schedule at its own
 * current minute for `tabId`, delivered at that tab's next safe idle point. */
export function sendPrompt(projectId: string, promptId: string, tabId: string): Promise<ProjectPromptList> {
  return reloadIfApplied(api(`${promptsPath(projectId)}/${encodeURIComponent(promptId)}/send`, { method: "POST", body: JSON.stringify({ tab_id: tabId }) }), () => getPrompts(projectId));
}

/** One image the desktop offers the composer: the clipboard's image or a
 * recent file of its screenshot/picture folders. `id` is opaque and `source`
 * a folder *label* — the desktop keeps every path. */
export interface DesktopImage {
  id: string;
  name: string;
  source: string;
  size?: number;
  age_secs?: number;
  width?: number;
  height?: number;
}

/** `GET /api/v1/tabs/{id}/desktop-images` — what the desktop would copy into
 * this tab's project inbox. The desktop may probe its clipboard for this,
 * which is bounded on its side. */
export async function listDesktopImages(tabId: string): Promise<DesktopImage[]> {
  const { images } = await api<{ images: DesktopImage[] }>(`/api/v1/tabs/${encodeURIComponent(tabId)}/desktop-images`);
  return images;
}

/** `POST /api/v1/tabs/{id}/desktop-images` — copy one listed image into the
 * project inbox; answers like the phone's own upload, with the reference. */
export async function attachDesktopImage(tabId: string, imageId: string): Promise<InboxAttachment> {
  const { attachment } = await api<{ attachment: InboxAttachment }>(
    `/api/v1/tabs/${encodeURIComponent(tabId)}/desktop-images`,
    { method: "POST", body: JSON.stringify({ image_id: imageId }) },
    30_000,
  );
  return attachment;
}

/** One picture the agent left for the phone in the project's `.tabtivity/outbox/`
 * (`outbox.rs`) — the mirror of the inbox. `name` is the leaf the desktop
 * validated and the only thing the phone hands back; `kind` is what the
 * bytes say, not the extension; `modified` is unix seconds. */
export interface OutboxFile {
  name: string; kind: string; size: number; modified: number;
  /** `name` without the `YYYYMMDD-HHMMSS-` stamps each send put in front —
   * what it was called when it was sent. Project files have none. */
  original?: string;
  /** Sent by `tabtivity-send` from the tab this listing was read through — the
   * one chat that shows it. Absent otherwise; the gallery lists every file. */
  from_tab?: boolean;
  /** What the file is fetched by when that is not its name: a project file's
   * sealed token (`ProjectFileEntry.token`). Outbox files have none. */
  ref?: string;
  /** An outbox copy's project file — the one `tabtivity-send` copied — sealed
   * as the files drawer rows it. Only while the drawer is switched on, and
   * only for a file it would list: the viewer then reads and marks up that
   * file itself, so its marks are the drawer's (`OutboxViewer`). */
  file_row?: PhoneMarkupFile;
}

/** The name a file is shown, saved and shared as: an outbox leaf without the
 * send stamps the desktop put in front (`outbox::sent_name`), else its name.
 * `name` stays what the phone asks for it by. */
export function sentName(file: OutboxFile): string {
  return file.original || file.name;
}

/** Which door onto one project's outbox a read goes through: the session the
 * files were sent from (the Focus screen), or the project itself (the project
 * screen's shelf, which has no tab to name and outlives every closed one).
 * Both answer the same directory — the outbox belongs to the project. */
export type OutboxScope = { tab: string } | { project: string };

function outboxBase(scope: OutboxScope): string {
  return "tab" in scope
    ? `/api/v1/tabs/${encodeURIComponent(scope.tab)}/outbox`
    : `/api/v1/projects/${encodeURIComponent(scope.project)}/outbox`;
}

/** `GET …/outbox` — the files the desktop put out for the phone, newest
 * first. Read from disk by the sidecar, so it answers with the desktop closed
 * too. */
export async function listOutbox(scope: OutboxScope, signal?: AbortSignal): Promise<OutboxFile[]> {
  const { files } = await api<{ files: OutboxFile[] }>(outboxBase(scope), { signal });
  return files;
}

/** The URL an `<img>` loads one outbox image from — same origin, so the
 * session cookie rides along and the CSP's `img-src 'self'` lets it render. */
export function outboxFileUrl(scope: OutboxScope, name: string, download = false): string {
  return `${outboxBase(scope)}/${encodeURIComponent(name)}${download ? "?download=1" : ""}`;
}

/** Where the full-screen viewer reads a file from: one project's outbox (by
 * its tab or the project), `files` — the project's own tree through the
 * read-only file browser, where a file is fetched by its sealed `ref` — or
 * `inbox`, what the phone sent into a tab's project inbox (by the tab). */
export type ViewerScope = OutboxScope | { files: string } | { inbox: string };

/** The URL a file the phone sent into a tab's project inbox loads from (its
 * leaf, out of the phone's own `@` reference) — same origin, so an `<img>`
 * rides the session cookie as an outbox picture does. */
export function inboxFileUrl(tabId: string, name: string, download = false): string {
  return `/api/v1/tabs/${encodeURIComponent(tabId)}/inbox/${encodeURIComponent(name)}${download ? "?download=1" : ""}`;
}

/** `GET …/inbox?names=` — the files among `names` (inbox leaves) the tab's
 * project inbox holds, typed by their bytes on the desktop, in the order
 * asked; a leaf that is gone is simply missing from the answer. */
export async function describeInbox(tabId: string, names: readonly string[], signal?: AbortSignal): Promise<OutboxFile[]> {
  const query = new URLSearchParams({ names: names.join(",") });
  const { files } = await api<{ files?: OutboxFile[] }>(`/api/v1/tabs/${encodeURIComponent(tabId)}/inbox?${query}`, { signal });
  return Array.isArray(files) ? files : [];
}

/** The URL one file loads from, for whichever door `scope` names. */
export function viewerFileUrl(scope: ViewerScope, file: OutboxFile, download = false): string {
  if ("inbox" in scope) return inboxFileUrl(scope.inbox, file.name, download);
  if ("files" in scope) {
    return `/api/v1/projects/${encodeURIComponent(scope.files)}/files/raw?f=${encodeURIComponent(file.ref ?? "")}${download ? "&download=1" : ""}`;
  }
  return outboxFileUrl(scope, file.name, download);
}

/** Open one of the file URLs above in the browser's own tab (its PDF viewer).
 * From the installed app that tab is a navigation from outside the site, so
 * the `SameSite=Strict` session cookie stays behind and the file answered
 * `authentication_required`; the URL goes out with a short-lived ticket for
 * exactly that file instead (`POST /api/v1/open-ticket`). If none can be had
 * the plain URL still opens — in a browser tab of the site the cookie rides.
 * The installed app on an iPhone or iPad cannot be got back to from there
 * (`openingOutsideStrands`): callers keep the file inside the app instead. */
export async function openOutside(url: string): Promise<void> {
  let target = url;
  try {
    const minted = await api<{ url?: unknown }>("/api/v1/open-ticket", { method: "POST", body: JSON.stringify({ url }) });
    if (typeof minted.url === "string") target = minted.url;
  } catch (error) {
    // A mobile host older than the ticket route knows the path only as a
    // static GET: a bodiless 405 (or 404). The plain URL would only show the
    // browser `authentication_required` there, so say why instead.
    if (error instanceof ApiError && error.code === "request_failed" && (error.status === 404 || error.status === 405)) {
      window.alert(translate(useI18nStore.getState().lang, "mobile.open.hostOutdated"));
      return;
    }
  }
  window.open(target, "_blank", "noopener");
}

/** One row of a project folder (`files.rs`): `token` is a sealed path the
 * phone can only hand back, `kind` is `"dir"` or the media type the file's
 * first bytes announce, `modified` and `created` are unix seconds — `created`
 * missing where the desktop's filesystem keeps no birth time. */
export interface ProjectFileEntry { token: string; name: string; kind: string; size: number; modified: number; created?: number; ignored?: boolean }
export interface ProjectFileListing { entries: ProjectFileEntry[]; truncated: boolean }

/** `GET /api/v1/projects/{id}/files[?dir=<token>]` — one folder of the
 * project, read-only; no `dir` is the project's root. Answers only while the
 * desktop's "Project files on the phone" switch is on (`files_off` else). */
export async function listProjectFiles(projectId: string, dir: string | undefined, signal?: AbortSignal): Promise<ProjectFileListing> {
  const query = dir ? `?dir=${encodeURIComponent(dir)}` : "";
  return api<ProjectFileListing>(`/api/v1/projects/${encodeURIComponent(projectId)}/files${query}`, { signal });
}

/** A file or folder whose name matched a search: its row, and the sealed
 * folders from the project root down to its own (empty at the root) — the
 * drawer's trail to stand in when it is opened. */
export interface ProjectFileHit extends ProjectFileEntry { trail: { token: string; name: string }[] }
export interface ProjectFileSearch { hits: ProjectFileHit[]; truncated: boolean }

/** `GET /api/v1/projects/{id}/files/search?q=<words>` — the project's files
 * and folders whose names hold every word, any case, the closest first. In a
 * git repo what git ignores is not searched. Behind the same switch as the
 * listing. */
export async function searchProjectFiles(projectId: string, query: string, signal?: AbortSignal): Promise<ProjectFileSearch> {
  return api<ProjectFileSearch>(`/api/v1/projects/${encodeURIComponent(projectId)}/files/search?q=${encodeURIComponent(query)}`, { signal });
}

/** Mark up's Reload for a project file opened by its sealed row rather than
 * from the drawer (the Focus banner's question, an outbox copy's origin):
 * its folder (`folder`, the row's token; none at the root) listed again, for
 * the file's fresh token, size and time — `null` when it is gone. */
export function refreshProjectFile(projectId: string, folder: string | undefined): (file: OutboxFile) => Promise<OutboxFile | null> {
  return async (file) => {
    const fresh = await listProjectFiles(projectId, folder);
    const entry = fresh.entries.find((candidate) => candidate.kind !== "dir" && candidate.name === file.name);
    return entry ? { name: entry.name, kind: entry.kind, size: entry.size, modified: entry.modified, ref: entry.token } : null;
  };
}

/** `DELETE …/outbox/{name}` — drop one of those files. The sidecar deletes
 * only a leaf its own listing handed out, and the route carries the
 * exact-origin check every mutating one does; the caller drops the row it
 * asked about rather than waiting for the next poll. */
export async function deleteOutboxFile(scope: OutboxScope, name: string): Promise<void> {
  await api<{ removed: boolean }>(`${outboxBase(scope)}/${encodeURIComponent(name)}`, { method: "DELETE" });
}

/** POSTs a raw file to one of the desktop's drop boxes and returns the status
 * and JSON body, mapping a refusal to the desktop's wire code. */
async function postFile<T>(url: string, file: Blob, retried = false): Promise<[number, T | undefined]> {
  let response: Response;
  const signal = AbortSignal.timeout(UPLOAD_TIMEOUT);
  try {
    response = await fetch(url, {
      method: "POST",
      body: file,
      credentials: "same-origin",
      cache: "no-store",
      signal,
      headers: { "Content-Type": file.type || "application/octet-stream" },
    });
  } catch (error) {
    if (aborted(error, signal)) throw new ApiError(0, "timeout");
    throw new ApiError(0, "offline");
  }
  let body: (T & { error?: string }) | undefined;
  try {
    body = await response.json() as typeof body;
  } catch {
    body = undefined;
  }
  if (response.status === 401 && !retried && await onUnauthorized?.()) return postFile<T>(url, file, true);
  if (!response.ok) throw new ApiError(response.status, body?.error ?? "request_failed", body);
  return [response.status, body];
}

export async function uploadToInbox(tabId: string, file: Blob, name: string): Promise<InboxAttachment> {
  const [status, body] = await postFile<{ attachment?: InboxAttachment }>(
    `/api/v1/tabs/${encodeURIComponent(tabId)}/inbox?name=${encodeURIComponent(name)}`,
    file,
  );
  if (!body?.attachment?.reference) throw new ApiError(status, "malformed_response");
  return body.attachment;
}

/** `POST /api/v1/projects/{id}/inbox` — the project screen's **＋ → Send a
 * file**: the same drop box as `uploadToInbox`, named by the project because
 * that screen has no tab to name. */
export async function uploadToProjectInbox(projectId: string, file: Blob, name: string): Promise<InboxAttachment> {
  const [status, body] = await postFile<{ attachment?: InboxAttachment }>(
    `/api/v1/projects/${encodeURIComponent(projectId)}/inbox?name=${encodeURIComponent(name)}`,
    file,
  );
  if (!body?.attachment?.reference) throw new ApiError(status, "malformed_response");
  return body.attachment;
}

/** Which file a markup submit is about, named the way the phone holds it: a
 * project file's sealed token, or an outbox leaf. */
export type MarkupSource = { files: string } | { outbox: string };
/** One marked page: its displayed size, its marks in that size's units, and
 * its layer PNG's inbox reference (`markup.rs`). */
export interface MarkupPageBody { n: number; size: [number, number]; marks: Mark[]; layer: string }
/** `instruction` is the phone's own wording of what to do with the marks
 * (`markupInstruction.ts`), absent while the desktop's default stands; `ask`
 * its asking dial (0–4), absent at the default stop; `mode` what **Apply
 * marks directly** asks for (absent = `list`). */
export interface MarkupBody { source: MarkupSource; pages: MarkupPageBody[]; picture?: string; instruction?: string; ask?: number; mode?: MarkupMode }
/** `apply`: the agent makes the changes and an undo snapshot backs them;
 * `list`: it lists them first (**Make these changes**). */
export type MarkupMode = "apply" | "list";
/** The prompt to send into the chat, and the marked copy's reference when the
 * desktop could bake one. `mode` is the one the round got — `apply` only with
 * an `undo` snapshot id — and `noUndo` why an asked-for `apply` runs as
 * `list` (`not_git`, `no_git`, `too_big`, `filtered`, `git_failed`, `remote`,
 * `not_pdf`). An older desktop answers neither: a `list` round. */
export interface MarkupAnswer { prompt: string; marked?: string | null; mode?: MarkupMode; undo?: string | null; noUndo?: string | null }
/** A bake of a long PDF takes a while on the desktop (its own deadline is 20 s). */
const MARKUP_TIMEOUT = 60_000;

/** `POST /api/v1/tabs/{id}/markup` — the markup view's **Submit**, after the
 * layer PNGs went up through `uploadToInbox`. */
export async function submitMarkup(tabId: string, body: MarkupBody): Promise<MarkupAnswer> {
  const answer = await api<MarkupAnswer>(
    `/api/v1/tabs/${encodeURIComponent(tabId)}/markup`,
    { method: "POST", body: JSON.stringify(body) },
    MARKUP_TIMEOUT,
  );
  if (typeof answer.prompt !== "string" || !answer.prompt.trim()) throw new ApiError(200, "malformed_response");
  return answer;
}

/** One file an undo puts (or put) back, project-relative. */
export interface MarkupUndoFile { path: string; change: "added" | "modified" | "deleted" | "changed" }
/** What an undo would do (preview) or did: the files, how many more it did
 * not name, and the PDF's fate — back to before, kept as it is (changed
 * since), or not part of it. */
export interface MarkupUndoChanges { files: MarkupUndoFile[]; more: number; pdf: "restored" | "kept" | "none" }

function markupUndoPath(tabId: string, undoId: string): string {
  return `/api/v1/tabs/${encodeURIComponent(tabId)}/markup/undo/${encodeURIComponent(undoId)}`;
}

/** The desktop's snapshot calls share one 30 s budget each
 * (`markup_rounds::OPERATION_BUDGET`); the phone waits past it. */
const MARKUP_UNDO_TIMEOUT = 40_000;

function undoChanges(answer: Partial<MarkupUndoChanges> | null | undefined): MarkupUndoChanges {
  const files = Array.isArray(answer?.files)
    ? answer.files.filter((file): file is MarkupUndoFile => !!file && typeof file.path === "string")
    : [];
  const pdf = answer?.pdf === "restored" || answer?.pdf === "kept" ? answer.pdf : "none";
  return { files, more: typeof answer?.more === "number" ? answer.more : 0, pdf };
}

/** `POST …/markup/undo/{id}/settle` — the round's after-snapshot, each time
 * the round finishes (the last one wins). */
export async function settleMarkupUndo(tabId: string, undoId: string): Promise<void> {
  await api(`${markupUndoPath(tabId, undoId)}/settle`, { method: "POST" }, MARKUP_UNDO_TIMEOUT);
}

/** `GET …/markup/undo/{id}` — what an undo would put back. */
export async function previewMarkupUndo(tabId: string, undoId: string): Promise<MarkupUndoChanges> {
  return undoChanges(await api<Partial<MarkupUndoChanges>>(markupUndoPath(tabId, undoId), undefined, MARKUP_UNDO_TIMEOUT));
}

/** `POST …/markup/undo/{id}` — puts the round's changes back. Refused with
 * `409 undo_conflict` (`markupUndoConflict` reads its files) and nothing
 * changed, `410 undo_gone`, `404 round_not_found`, `500 undo_failed`. */
export async function runMarkupUndo(tabId: string, undoId: string): Promise<MarkupUndoChanges> {
  return undoChanges(await api<Partial<MarkupUndoChanges>>(markupUndoPath(tabId, undoId), { method: "POST" }, MARKUP_UNDO_TIMEOUT));
}

/** An `undo_conflict` refusal's files changed since the round, and how many
 * more; `null` for any other failure. */
export function markupUndoConflict(error: unknown): { files: string[]; more: number } | null {
  if (!(error instanceof ApiError) || error.code !== "undo_conflict") return null;
  const detail = error.detail as { files?: unknown; more?: unknown } | undefined;
  const files = Array.isArray(detail?.files) ? detail.files.filter((file): file is string => typeof file === "string") : [];
  return { files, more: typeof detail?.more === "number" ? detail.more : 0 };
}

/** One question of an agent's markup ask (`markup_ask`,
 * `docs/markup_questions_mcp_plan.md`): 2–6 options, a 1-based `page` and a
 * `quote` of that page's words it is about. */
export interface PhoneMarkupQuestion {
  question: string;
  header?: string;
  options: { label: string; description?: string }[];
  multi_select: boolean;
  page?: number;
  quote?: string;
}
/** An agent's open markup ask: its random id, its questions, and the leaf
 * name of the file it is about (absent: any file). Never a path. */
/** The project file an ask is about, as the files drawer rows it — sealed by
 * the sidecar for the Focus banner (`protocol::MobileMarkupFile`). `place` is
 * its folder trail, `folder` its folder's token (none at the root). */
export interface PhoneMarkupFile { token: string; name: string; kind: string; size: number; modified: number; folder?: string; place: string }
export interface PhoneMarkupAsk { id: string; file_name?: string; file_row?: PhoneMarkupFile; questions: PhoneMarkupQuestion[] }
/** One question's answer: option indices and/or a typed **Other…**. */
export interface PhoneMarkupAnswer { options: number[]; other?: string }

function markupBase(tabId: string): string {
  return `/api/v1/tabs/${encodeURIComponent(tabId)}/markup`;
}

/** `GET /api/v1/tabs/{id}/markup/questions[?source=…]` — the agent tab's
 * open markup question for the file a markup view shows (`source`), or every
 * open one (the Focus banner). `503 desktop_unavailable` with the window
 * closed: there is then no ask to show. A malformed answer reads as none. */
export async function listMarkupQuestions(tabId: string, source?: MarkupSource, signal?: AbortSignal): Promise<PhoneMarkupAsk[]> {
  const query = !source ? "" : `?source=${encodeURIComponent("files" in source ? `files:${source.files}` : `outbox:${source.outbox}`)}`;
  const { asks } = await api<{ asks?: unknown }>(`${markupBase(tabId)}/questions${query}`, { signal });
  if (!Array.isArray(asks)) return [];
  return asks.filter((ask): ask is PhoneMarkupAsk => !!ask && typeof ask === "object"
    && typeof (ask as PhoneMarkupAsk).id === "string" && Array.isArray((ask as PhoneMarkupAsk).questions));
}

/** `POST /api/v1/tabs/{id}/markup/answer` — one answer per question, in
 * order. The desktop builds the prompt and queues it into the tab; `409` with
 * `superseded` / `answered` / `gone` when the ask no longer takes it,
 * `delivery_failed` when it could not be queued (the ask is open again),
 * `not_delivered` when it could not and has closed. */
export function answerMarkupQuestions(tabId: string, askId: string, answers: PhoneMarkupAnswer[]): Promise<unknown> {
  return api(`${markupBase(tabId)}/answer`, { method: "POST", body: JSON.stringify({ ask_id: askId, answers }) });
}

/** `POST /api/v1/tabs/{id}/markup/dismiss` — **Answer in chat instead**. */
export function dismissMarkupQuestions(tabId: string, askId: string): Promise<unknown> {
  return api(`${markupBase(tabId)}/dismiss`, { method: "POST", body: JSON.stringify({ ask_id: askId }) });
}

/** A file the phone sent to the desktop's global inbox: its stored name and
 * size only — it belongs to no project, so there is nothing to reference. */
export interface DesktopInboxFile { name: string; size: number }

/** `POST /api/v1/inbox` — **Send to desktop**: the file lands in the desktop's
 * own inbox (`<state_dir>/inbox/`), not in any project, and the desktop's
 * header lists it. */
export async function uploadToDesktop(file: Blob, name: string): Promise<DesktopInboxFile> {
  const [status, body] = await postFile<{ file?: DesktopInboxFile }>(`/api/v1/inbox?name=${encodeURIComponent(name)}`, file);
  if (!body?.file?.name) throw new ApiError(status, "malformed_response");
  return body.file;
}

/** The desktop's Ollama server as `GET /api/v1/local-models` reports it. */
export type LocalModelServer = "running" | "starting" | "stopped" | "unreachable" | "not_installed";
export type LocalModelState = "idle" | "loading" | "loaded" | "failed";

/** One installed Ollama model on the desktop. The residency fields
 * (`loaded_size`, `vram`, `pinned`, `expires_in`) come only while `loaded`;
 * an absent one is unknown, never zero. */
export interface LocalModelRow {
  name: string;
  size: number;
  parameter_size: string | null;
  quantization: string | null;
  state: LocalModelState;
  loaded_size?: number;
  vram?: number;
  pinned?: boolean;
  expires_in?: number | null;
  /** The model the phone's ＋ "Local model" group drives. */
  for_tabs: boolean;
  /** An Ollama cloud model: listed, never loaded or unloaded. */
  remote: boolean;
}
export interface LocalModelList {
  server: LocalModelServer;
  can_start: boolean;
  start_failed: boolean;
  models: LocalModelRow[];
}
export type LocalModelAction = "load" | "unload" | "start";

const LOCAL_MODEL_SERVERS: readonly string[] = ["running", "starting", "stopped", "unreachable", "not_installed"];
const LOCAL_MODEL_STATES: readonly string[] = ["idle", "loading", "loaded", "failed"];

const finiteNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
const shortText = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

/** The list as the phone draws it, or null for a body that is not one — an
 * older sidecar's catch-all answer must hide the feature, not draw an empty
 * list. Unknown states read as `idle` / `unreachable`, as the sidecar forces. */
export function normalizeLocalModels(body: unknown): LocalModelList | null {
  if (!body || typeof body !== "object") return null;
  const raw = body as Record<string, unknown>;
  if (typeof raw.server !== "string" || !Array.isArray(raw.models)) return null;
  const models: LocalModelRow[] = [];
  for (const entry of raw.models) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    if (typeof row.name !== "string" || !row.name) continue;
    const state = (LOCAL_MODEL_STATES.includes(row.state as string) ? row.state : "idle") as LocalModelState;
    const model: LocalModelRow = {
      name: row.name,
      size: finiteNumber(row.size) ?? 0,
      parameter_size: shortText(row.parameter_size),
      quantization: shortText(row.quantization),
      state,
      for_tabs: row.for_tabs === true,
      remote: row.remote === true,
    };
    if (state === "loaded") {
      model.loaded_size = finiteNumber(row.loaded_size);
      model.vram = finiteNumber(row.vram);
      model.pinned = row.pinned === true;
      model.expires_in = finiteNumber(row.expires_in) ?? null;
    }
    models.push(model);
  }
  const server = (LOCAL_MODEL_SERVERS.includes(raw.server) ? raw.server : "unreachable") as LocalModelServer;
  return { server, can_start: raw.can_start === true && server === "stopped", start_failed: raw.start_failed === true, models };
}

/** The local-models routes wait on the window, which may first ask Ollama
 * about every model (`/api/show`): 2 s connect + the default 10 s
 * `response_timeout`, so the phone holds out past the sidecar's own answer
 * (`MobileApiDeadlines.test.ts`) and reads its `503` rather than guessing. */
export const LOCAL_MODELS_TIMEOUT = 15_000;

async function localModelsBody(write: Promise<unknown>): Promise<LocalModelList> {
  const list = normalizeLocalModels(await write);
  if (!list) throw new ApiError(200, "malformed_response");
  return list;
}

/** `GET /api/v1/local-models` — the Ollama models installed on the desktop.
 * `403 local_models_disabled` with the desktop's switch off, `404` from a
 * sidecar older than the feature, `503 desktop_unavailable` with no window. */
export function getLocalModels(signal?: AbortSignal): Promise<LocalModelList> {
  return localModelsBody(api("/api/v1/local-models", { signal }, LOCAL_MODELS_TIMEOUT));
}

/** `POST /api/v1/local-models` — load or unload one model, or start Ollama.
 * There is no download, update or delete: the sidecar refuses any other
 * action. Answers the fresh list; a load or start then runs on in the
 * desktop window, followed by polling. A write the window made whose list
 * could not be relayed reads the list again (`reloadIfApplied`). */
export function localModelAction(action: LocalModelAction, model?: string): Promise<LocalModelList> {
  const body = action === "start" ? { action } : { action, model };
  return reloadIfApplied(
    localModelsBody(api("/api/v1/local-models", { method: "POST", body: JSON.stringify(body) }, LOCAL_MODELS_TIMEOUT)),
    () => getLocalModels(),
  );
}
