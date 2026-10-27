// Tab kinds: the sentinel commands, `cmdToKind` and the restorability
// predicates. Pure. Moved out of `stores/tabs.ts`.

import type { LoginTarget } from "../../lib/remote/loginTarget";
import { AGENT_BINS, RESUMABLE_AGENTS } from "../../lib/agents/agentClis";
import { tabCommand } from "../../lib/brand";
import type { LocalLaunch, TabEntry, TabKind } from "./types";

export const FILES_TAB_CMD = tabCommand("files");

/**
 * Sentinel `cmd` for the "Files (Project)" tab: the SAME file view the right
 * panel shows (`ProjectFilesPane` → `FileTree`), hosted in a tab — git markers,
 * drag-to-open/move, OS import/export, the remote sync overlay. Distinct from
 * `FILES_TAB_CMD`, which is the separate two-pane `FileBrowser` explorer; both
 * are offered, they are different tools.
 */
export const PROJECT_FILES_TAB_CMD = tabCommand("project_files");

/**
 * Sentinel `cmd` for the 3D project-blob tab (root scope only): a navigable 3D
 * cloud of every project (active + inactive) and box. Carries no PTY — like the
 * files tab it's a pure-frontend pane, identified by this command so cmdToKind
 * can recover its kind from a bare command string.
 */
export const BLOB_TAB_CMD = tabCommand("blob");

/** Sentinel command for the read-only local/SSH host traffic dashboard. */
export const NETWORK_TAB_CMD = tabCommand("network");

/**
 * Sentinel `cmd` for the native htop-like system monitor tab: a read-only,
 * whole-machine process/CPU/memory view. Carries no PTY — like the network pane
 * it's identified by this command so cmdToKind can recover its kind on restore.
 */
export const MONITOR_TAB_CMD = tabCommand("monitor");

/**
 * Sentinel `cmd` for the native disk usage analyzer tab: a baobab-like rings/
 * treemap view of what is filling a folder. Carries no PTY — like the monitor pane
 * it is identified by this command so cmdToKind can recover its kind on restore.
 */
export const DISKUSAGE_TAB_CMD = tabCommand("diskusage");

/**
 * Sentinel `cmd` for the native calendar tab: a local, self-contained month-grid
 * event calendar, offered in every scope (root and each project). The event store
 * is global — one `calendar.json`, one zustand store — so every calendar tab shows
 * the same events regardless of the project it was opened from, and edits in one
 * are seen live by the others. Carries no PTY — like the files pane it's identified
 * by this command so cmdToKind can recover its kind.
 */
export const CALENDAR_TAB_CMD = tabCommand("calendar");

/**
 * Sentinel `cmd` of the **retired** mail tab.
 *
 * Mail was a tab and a header overlay at once, and the tab was the half that did
 * not earn its keep: the mail store is global (one `~/.local/share/tabtivity/mail/`,
 * one zustand store), so a mail tab showed the same mailbox from every scope —
 * i.e. exactly what the header's ✉ button already opens over whatever is on
 * screen, without belonging to a project you then switch away from. The tab kind
 * is gone; `MailPane` lives on, rendered only by `MailOverlayHost`.
 *
 * The constant stays because the *persisted layouts* do: a saved tree written
 * before the removal still carries `kind: "mail"` tabs holding this `cmd`, and
 * without `RETIRED_TAB_CMDS` below, `cmdToKind` would fall through to `"shell"`
 * and restore each one as a terminal trying to run `__tabtivity_mail__`.
 */
export const MAIL_TAB_CMD = tabCommand("mail");

/**
 * Sentinel commands of tab kinds Tabtivity no longer has, dropped unconditionally
 * on restore. Here for the same reason the removed global-app launcher kept a list of
 * retired roles: removing a feature does not remove it from the
 * state already written to disk, and the fall-through for an unrecognized `cmd`
 * is `"shell"` — a spawned terminal, not a no-op.
 *
 * Deliberately NOT `withdrawnTabKinds`: that list is a *setting* (a flag that may
 * come back on), so it is right for it to wait for settings to load. A retired
 * kind is never coming back, so its filter must not be conditional on anything.
 */
export const RETIRED_TAB_CMDS = new Set<string>([MAIL_TAB_CMD]);

/**
 * Sentinel `cmd` for an in-app browser tab (TODO group J #61).
 *
 * Four properties, each of which is why this constant exists rather than a
 * `kind` check scattered around:
 *
 *  - **It carries no PTY.** Like the calendar and mail panes it owns no process
 *    at all, which is exactly why it is identified by this command (so
 *    `cmdToKind` recovers its kind from a bare persisted `cmd`) and why
 *    `isPtyTabKind` deliberately does NOT list it.
 *  - **It is not a singleton.** Each tab holds its own page, so it *stacks*
 *    (`addTab`) the way `diskusage` does rather than focusing an existing one
 *    (`ensureTab`, which mail and the calendar use because their store is
 *    global and a second tab would show the same thing). Two browser tabs never
 *    show the same thing.
 *  - **It is never locatable.** `browser` is absent from `isLocatableKind`, so
 *    the locality badge, the run-host preference and the tmux persistence
 *    helpers can never claim it. The browser is always local: it does not run
 *    on a project's SSH host and does not tunnel through it — which is also why
 *    a *disconnected* remote project's browser tab still works, unlike every
 *    file/git surface in that project.
 *  - **A restored one does not navigate.** It comes back on its resume card,
 *    holding the persisted URL behind a Load button. Restoring six browser tabs
 *    would otherwise be six automatic outbound requests to whatever the user
 *    last had open, before they have looked at the screen — the same rule mail
 *    states ("nothing about a window being reopened is consent to dial out")
 *    and the same bargain diskusage already makes about not replaying its scan.
 */
export const BROWSER_TAB_CMD = tabCommand("browser");

/**
 * Sentinel `cmd` for the native print manager: the machine's printers, their
 * queues, and the handful of verbs a queue is worth opening for.
 *
 * It is what the `print_manager` **global app** slot used to launch an external
 * GUI for, brought in-window the way mail, the calendar and the file manager
 * were before it.
 *
 *  - **It carries no PTY**, like the calendar and mail panes, which is why it is
 *    identified by this command (so `cmdToKind` recovers its kind from a bare
 *    persisted `cmd`) and why `isPtyTabKind` deliberately does not list it.
 *  - **It is a singleton per scope.** Printers belong to the machine, not to a
 *    project, so a second tab would show exactly the same list — hence
 *    `ensureTab` rather than `addTab`, the bargain mail and the calendar make.
 *  - **A restored one reads, it does not act.** Restoring costs one `lpstat`
 *    against the local print system and nothing else: no job is sent, nothing
 *    is cancelled, and the pane polls only while it is on screen.
 */
export const PRINTING_TAB_CMD = tabCommand("printing");

/**
 * Sentinel `cmd` for the Skills Library tab (`docs/done/skills_plan.md`): browse a
 * git-hosted collection of Claude Code skills (plain `<name>/SKILL.md`
 * folders), preview one, and copy it into this project's `.claude/skills/`.
 *
 *  - **It carries no PTY**, like the calendar/printing panes, hence the
 *    sentinel `cmd` so `cmdToKind` recovers its kind on restore.
 *  - **It is a singleton per scope.** The catalog is the same regardless of
 *    which tab opened it, and install/uninstall act on the one project the
 *    scope names — a second tab would show exactly the same thing, hence
 *    `ensureTab` rather than `addTab` (the bargain calendar/printing make).
 *  - **Offered at the root scope too**, which it was not at first: it needs
 *    somewhere to install INTO, and the personal scope (`~/.claude/skills/`,
 *    read by every project on this machine) is exactly that, so the tab has a
 *    job with no project open. The install target is the view's own state; see
 *    `NewTabMenu`/`TabBar`, which carry the entry unconditionally.
 *  - **A restored one re-reads, it does not fetch.** Coming back costs a local
 *    disk read (installed list + whatever catalog was already cached); no
 *    source is cloned/pulled without an explicit Refresh click.
 */
export const SKILLSLIBRARY_TAB_CMD = tabCommand("skillslibrary");

/**
 * Sentinel `cmd` for the Prompt chart tab: the one timeline of a scope's
 * draft, queued, scheduled and sent agent prompts (`agents/PromptChart`). It
 * lived at the bottom of the Agents view of the file viewer, where a chart
 * whose columns are agent tabs was squeezed into a side panel; it is a tab now.
 *
 *  - **It carries no PTY**, like the calendar/printing/skills panes, hence the
 *    sentinel `cmd` so `cmdToKind` recovers its kind on restore.
 *  - **It is a singleton per scope.** The chart is the scope's, not a tab's —
 *    a second one would draw the same columns — hence `ensureTab`.
 *  - **A restored one re-reads, it does not act.** Coming back costs the same
 *    three list reads the pane makes on show; nothing is sent, scheduled or
 *    linked without a click.
 */
export const PROMPTCHART_TAB_CMD = tabCommand("promptchart");

// The built-in agent CLIs (`lib/agents/agentClis`, generated from the backend
// registry in commands::agents): a tab is classified as an agent by its cmd,
// and a resumable one relaunches on `RESUMABLE_AGENTS`.
export function cmdToKind(cmd: string): TabKind {
  if (cmd === FILES_TAB_CMD) return "files";
  if (cmd === PROJECT_FILES_TAB_CMD) return "projectfiles";
  if (cmd === BLOB_TAB_CMD) return "projects3d";
  if (cmd === NETWORK_TAB_CMD) return "network";
  if (cmd === MONITOR_TAB_CMD) return "monitor";
  if (cmd === DISKUSAGE_TAB_CMD) return "diskusage";
  if (cmd === CALENDAR_TAB_CMD) return "calendar";
  if (cmd === BROWSER_TAB_CMD) return "browser";
  if (cmd === PRINTING_TAB_CMD) return "printing";
  if (cmd === SKILLSLIBRARY_TAB_CMD) return "skillslibrary";
  if (cmd === PROMPTCHART_TAB_CMD) return "promptchart";
  if (AGENT_BINS.has(cmd)) return "agent";
  return "shell";
}

/**
 * Whether a tab KIND alone survives a restart. Shell/files/network tabs are
 * restorable by kind; agent / local-agent and embed tabs are not, because the
 * kind alone carries no session to resume. Prefer the tab-level `isRestorableTab` at call
 * sites that have the full tab — a resumable agent tab (Claude with a sessionId)
 * IS restorable even though its kind is not. This kind-only check stays for the
 * places that only have a `TabKind`.
 *
 * Embed tabs are not restorable by kind alone — only in-app `viewer` embeds
 * survive (external-app embeds would relaunch on startup), so restorability for
 * them is decided at the tab level (see isRestorableEmbedTab / isRestorableTab),
 * not here.
 */
export function isRestorableKind(kind: TabKind): boolean {
  return (
    kind === "shell" ||
    kind === "files" ||
    kind === "projectfiles" ||
    kind === "network" ||
    kind === "monitor" ||
    // The tab comes back, but on its home screen — a scan is far too expensive to
    // replay on every launch, so the pane never auto-rescans.
    kind === "diskusage" ||
    kind === "calendar" ||
    // The browser tab comes back, on its resume card — it NEVER re-navigates by
    // itself. Same shape as diskusage above (the tab returns, the expensive work
    // does not replay) and the same rule mail states about dialling out: the
    // persisted URL is rendered as text behind a Load button, and only a click
    // makes a request. See BROWSER_TAB_CMD.
    kind === "browser" ||
    // The print manager holds no session and no process — it re-reads the local
    // print system when it comes back on screen. Restoring it costs one
    // `lpstat`, and nothing it can do to a queue happens without a click.
    kind === "printing" ||
    // Skills Library holds no session either — it re-reads the installed list
    // (and whatever catalog is already cached) when it comes back; no source
    // is cloned/pulled without an explicit Refresh click.
    kind === "skillslibrary" ||
    // The prompt chart is a view over the scope's prompt files and the tabs
    // that are open; it re-reads on show and sends nothing by itself.
    kind === "promptchart"
  );
}

/**
 * Whether a second tab of this kind, in one scope, would show the same thing as
 * the first — so opening it should focus the one that exists instead of stacking
 * a copy. The reason is the same one each sentinel `cmd` above states for itself:
 * the view is the MACHINE's (the system monitor's processes, the print queues) or
 * the SCOPE's (the skills catalog and its install target, the prompt chart's
 * columns, the calendar's global store, the 3D cloud of every project). Nothing
 * a second tab could be pointed at differs.
 *
 * Deliberately NOT here, though they sit in the same menus: `diskusage` (each tab
 * holds its own scan root, and comparing two folders side by side is the point),
 * `browser` (each tab holds its own page) and `network` (its filters, interface
 * pick and rolling graph are the tab's own — the same bargain diskusage makes).
 *
 * `TabBar` spells this rule out one handler at a time, as `ensureTab` calls with
 * a `kind` matcher; the root console (`layout/RootOverlay`) asks here instead,
 * because its "+" resolves a payload through `NewTabMenu` and never sees which
 * handler built it. Adding a singleton kind means adding it in both places.
 */
export function isSingletonTabKind(kind: TabKind): boolean {
  return (
    kind === "monitor" ||
    kind === "printing" ||
    kind === "skillslibrary" ||
    kind === "promptchart" ||
    kind === "calendar" ||
    kind === "projects3d"
  );
}

/** Whether a tab owns a backend PTY. Pure frontend panes must never be sent
 * through terminal spawn/kill/activity paths merely because they are not files. */
export function isPtyTabKind(kind: TabKind): boolean {
  return kind === "agent" || kind === "local_agent" || kind === "shell";
}


/**
 * Whether a tab is a resumable agent: an agent/local-agent tab that minted a
 * session id AND whose `cmd` is in `RESUMABLE_AGENTS`. Such tabs survive a
 * restart (their conversation is resumed); other agent tabs are still dropped.
 */
export function isResumableAgentTab(
  tab: { kind: TabKind; cmd: string; sessionId?: string; resumeArgs?: string[] },
): boolean {
  return (
    (tab.kind === "agent" || tab.kind === "local_agent") &&
    !!tab.sessionId &&
    // Built-in resumable (cmd in the static table) OR a custom agent whose spec
    // supplied a "continue last session" flag (carried on the tab as resumeArgs).
    (tab.cmd in RESUMABLE_AGENTS || !!tab.resumeArgs?.length)
  );
}

/**
 * A tab the session file carries, in its own tmux session, only while it
 * runs: a sign-in tab or a cloud session. The Mobile sidecar lists a scope's
 * tabs from that file and attaches through tmux, so a phone-opened one
 * without either was never attachable — the create timed out as
 * `launch_pending`. Neither is restorable, and every load path keeps
 * restorable tabs only, so it drops out on the next launch.
 */
export function isSavedWhileLive(
  tab: { kind: TabKind; signIn?: boolean; cloud?: boolean; tmuxSession?: string },
): boolean {
  return tab.kind === "agent" && (!!tab.signIn || !!tab.cloud) && !!tab.tmuxSession;
}

/**
 * Whether a tab is a local-model tab that restores by relaunching its launch
 * line (`TabEntry.localLaunch`) — the drivers other than Mistral, which have no
 * session to resume. While its tmux session lives, the restore reattaches the
 * running agent; once that is gone the relaunch is a fresh conversation.
 */
export function isRelaunchableLocalTab(
  tab: { kind: TabKind; localLaunch?: LocalLaunch },
): boolean {
  const launch = tab.localLaunch;
  return (
    tab.kind === "local_agent" &&
    !!launch &&
    typeof launch.driver === "string" &&
    !!launch.driver &&
    typeof launch.model === "string" &&
    !!launch.model &&
    Array.isArray(launch.args) &&
    launch.args.every((arg) => typeof arg === "string")
  );
}

/**
 * Whether a tab is a restorable embed: a file dragged from the FileTree onto a
 * tab bar that renders IN-APP via a built-in `viewer` (pdf/image/markdown/text).
 * These re-render the file from its durable `embedPath` on restart with no side
 * effects. Embed tabs that instead open an EXTERNAL app (`embedExec`, no
 * `viewer`) are NOT restorable — re-creating one would relaunch the external app
 * at startup — so they are dropped like other live-process tabs.
 */
export function isRestorableEmbedTab(
  tab: { kind: TabKind; viewer?: TabEntry["viewer"] },
): boolean {
  return tab.kind === "embed" && !!tab.viewer;
}

/**
 * Tab-level restorability (supersedes bare `isRestorableKind` at call sites that
 * have the full tab): a tab survives a restart if its kind is restorable, it is
 * a resumable agent tab, a relaunchable local-model tab, or an in-app
 * file-viewer embed — and never when it is a login terminal (`TabEntry.login`).
 */
export function isRestorableTab(
  tab: {
    kind: TabKind;
    cmd: string;
    sessionId?: string;
    resumeArgs?: string[];
    viewer?: TabEntry["viewer"];
    localLaunch?: LocalLaunch;
    login?: LoginTarget;
  },
): boolean {
  // A login terminal is a live ssh/OpenVPN prompt, not a place: bringing it back
  // would prompt at launch (and it would come back as a bare shell anyway, since
  // the login itself is never saved).
  if (tab.login) return false;
  return (
    isRestorableKind(tab.kind) ||
    isResumableAgentTab(tab) ||
    isRelaunchableLocalTab(tab) ||
    isRestorableEmbedTab(tab)
  );
}

export function isLocalAgentKind(kind: TabKind): kind is "local_agent" {
  return kind === "local_agent";
}
