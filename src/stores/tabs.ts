import { invoke } from "@tauri-apps/api/core";
import { restoredAgentCwd } from "../lib/agents/agentWorktrees";
import { isTabColor, type TabColor } from "../lib/theme/tabColors";
import { normalizeStackName, stackJoinOrder } from "../lib/tabStacks";
import { isTabMark, type TabMark } from "../lib/tabMarks";
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import type { InternalViewer } from "../lib/viewers/fileUtils";
import type { AutocompleteMode } from "../types";
import { forgetPty } from "../lib/agents/promptCount";
import { forgetPromptTrail } from "./agents/promptTrail";
import { BOX_SCOPE_PREFIX, splitPtyId } from "../lib/terminal/ptyId";
import { METRIC, agentMetricLeaf, sub } from "../lib/usageMetrics";
import { useLinkRoutingStore } from "./linkRouting";
import { bumpUsage } from "./usage";
import { translate, useI18nStore } from "../lib/i18n";
import { newTmuxSessionName } from "../lib/terminal/tmuxSession";
import { useRunHostPrefStore } from "./remote/runHostPref";
import { withdrawnTabKinds } from "../lib/experimental";
import { useSettingsStore } from "./settings";
import { getDetachedWindowContext } from "./detachedContext";
import { closePdfPresentWindows } from "../lib/window/closePdfPresent";
import { envName, tabCommand } from "../lib/brand";
import { currentTabCommand } from "../lib/brandMigration";

/** A shell tab, or a remote agent tab (Claude/Codex/…), gets a stable persisted
 *  tmux session name at creation (TODO #85), so a persistent remote run reattaches
 *  after a relaunch instead of forking a second session. For an agent tab this
 *  composes with `--resume`: `tmux new-session -A` reattaches the live agent when the
 *  host session survives, else creates a fresh one that runs the resume. The name is
 *  inert until `shouldPersistTab` decides to pass it, so minting it on a local agent
 *  costs nothing. A local-model tab (`local_agent`) gets one too, with the `agent`
 *  token: in a Mobile-access scope it is tmux-wrapped like any agent
 *  (`shouldPersistLocalTab`), which is how the phone reaches it. Tabs that already carry a name (or an explicit attach), and pane
 *  kinds with no PTY, are left untouched. */
function withTmuxSession(
  tab: Omit<TabEntry, "key">,
  scope: string,
): Omit<TabEntry, "key"> {
  let next = tab;
  if ((next.kind === "agent" || next.kind === "local_agent") && !next.scheduleTargetId) {
    next = { ...next, scheduleTargetId: crypto.randomUUID() };
  }
  if (
    (next.kind === "shell" || next.kind === "agent" || next.kind === "local_agent") &&
    !next.tmuxSession &&
    !next.tmuxAttach
  ) {
    return { ...next, tmuxSession: newTmuxSessionName(scope, next.kind === "shell" ? "shell" : "agent") };
  }
  return next;
}

/** A new SHELL tab launched from a project inherits that project's run-host
 *  preference (the machine chosen in the `RunHostPicker`) as its `location`, so
 *  "pick machine X ⇒ ALL shells run on X" — the "+" → Shell tab, not just a
 *  Python/script Run. Scoped tightly: only a `shell` tab, only when it did NOT
 *  already pin a `location` (a script/tmux/SLURM/git-resolve tab sets its own and
 *  must keep it), and only when the owning scope has a stored preference (a local
 *  project, the root scope, and a box scope have none → unchanged). Baked in at
 *  creation because `effectiveTabLocation`'s per-kind default has no project
 *  context to consult the preference. */
function withRunHostDefault(
  scope: string,
  tab: Omit<TabEntry, "key">,
): Omit<TabEntry, "key"> {
  if (tab.kind !== "shell" || tab.location !== undefined) return tab;
  const pref = useRunHostPrefStore.getState().byProject[scope];
  return pref ? { ...tab, location: pref } : tab;
}

/** A persisted `todoId` as a usable card id, or `undefined`. The layout file is
 *  on disk, so it is capped and must look like the backend's ids. */
export function normalizeTodoId(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9_.@-]{1,128}$/.test(value) ? value : undefined;
}

/**
 * The launch spec for a COPY of `tab` — what "Duplicate" means, kept pure and
 * separate from the store action so it is testable and so the rule lives in one
 * place.
 *
 * The whole job is telling apart what *describes* a tab (its command, args, cwd,
 * locality, browsed folder, viewer position — all copied verbatim, or the copy
 * would open something else) from what *identifies* it. Every identity is
 * re-minted or dropped, because two tabs sharing one are not two tabs:
 *
 * - `sessionId` is an agent's conversation. It is minted fresh AND substituted
 *   wherever the old one was baked in at creation — `--session-id <uuid>` in
 *   `args`, `TABTIVITY_TAB_UID` in `env` (see `buildStaticTabSpec`) — since two
 *   agents launched onto one session id is a collision, not a duplicate.
 * - `tmuxSession` is dropped so `withTmuxSession` mints a new one; keeping it
 *   would make the copy REATTACH to the original's session instead of running.
 * - `tmuxAttach` is dropped for the same reason at the other end: a duplicate of
 *   a tab adopted from the Sessions view is a fresh shell on that host, not a
 *   second window onto the one session.
 * - `hostBoundUid` is dropped because the grant is a file the backend writes
 *   against a specific uid; the caller re-registers one and passes it back in
 *   (a store action cannot await). Without it the copy simply runs inside the
 *   project's container, which is the safe direction (`lib/remote/hostBound.ts`).
 * - `mark` and `todoId` are dropped: the card is the original's, and a copied
 *   Urgent would double what the project pill says needs attention.
 */
export function duplicateSpec(tab: TabEntry): Omit<TabEntry, "key"> {
  const {
    key: _key,
    sessionId,
    tmuxSession: _tmux,
    tmuxAttach: _attach,
    hostBoundUid: _hostBound,
    scheduleTargetId: _scheduleTarget,
    mark: _mark,
    todoId: _todo,
    ...rest
  } = tab;
  if (!sessionId) return rest;
  const nextId = crypto.randomUUID();
  const swap = (v: string) => (v === sessionId ? nextId : v);
  return {
    ...rest,
    sessionId: nextId,
    ...(rest.args ? { args: rest.args.map(swap) } : {}),
    ...(rest.env
      ? {
          env: Object.fromEntries(
            Object.entries(rest.env).map(([k, v]) => [k, swap(v)]),
          ),
        }
      : {}),
  };
}

export type TabKind =
  | "agent"
  | "local_agent"
  | "shell"
  | "files"
  | "projectfiles"
  | "embed"
  | "projects3d"
  | "network"
  | "monitor"
  | "diskusage"
  | "calendar"
  | "browser"
  | "printing"
  | "skillslibrary"
  | "promptchart";

/**
 * SSH-sync Phase 0 — a PTY tab's locality on a REMOTE (SSH) project: does it run
 * locally (in the project's local mirror) or on the host over `ssh -tt`? Only
 * meaningful for `agent`/`shell` tabs (see {@link isLocatableKind}); `local_agent`
 * is always local and non-PTY kinds have no locality. On a LOCAL project the axis
 * is inert (everything is local — the backend gates the ssh-wrap on remoteness).
 * Plan: docs/ssh_sync_plan.md.
 */
export type TabLocation = "local" | "remote" | `host:${string}`;

/** The backend host id a tab location runs on: `"primary"` for the primary remote
 *  (`"remote"`), the worker id for a `host:<id>` location, or `null` for `"local"`
 *  (`docs/multi_host_remote_plan.md` §4.1). Pass to PTY spawn / lamp reads. */
export function remoteHostIdOf(loc: TabLocation | undefined): string | null {
  if (loc === "remote") return "primary";
  if (loc && loc.startsWith("host:")) return loc.slice("host:".length);
  return null; // "local" or unset
}

/** Whether a tab location runs on a remote host (primary or a worker) rather than
 *  the local mirror. */
export function isRemoteLocation(loc: TabLocation | undefined): boolean {
  return remoteHostIdOf(loc) !== null;
}

/** The minimal shape of a worker machine (`ComputeHost`) the locality UI reads —
 *  structural so `tabs.ts` need not import the full project types. */
export interface LocalityHost {
  id: string;
  label?: string;
  host: string;
  sync_code?: boolean;
  shared_fs?: boolean;
}

/** Human-readable name of the machine a tab location runs on — the ONE place the
 *  tab badge, its locality menu, and the hover card agree on wording
 *  (`docs/multi_host_remote_plan.md`). `"local"` → the mirror; `"remote"` → the
 *  primary host (named when known); `host:<id>` → the worker's label/host/id. */
export function localityHostLabel(
  loc: TabLocation | undefined,
  opts: { primaryHost?: string; computeHosts?: LocalityHost[] } = {},
): string {
  const lang = useI18nStore.getState().lang;
  const hostId = remoteHostIdOf(loc);
  if (hostId === null) return translate(lang, "tabLocality.localMirrorItem");
  if (hostId === "primary") {
    return opts.primaryHost
      ? translate(lang, "tabLocality.primaryWithHost", { host: opts.primaryHost })
      : translate(lang, "tabLocality.primary");
  }
  const w = opts.computeHosts?.find((h) => h.id === hostId);
  return w?.label || w?.host || hostId;
}

/** Whether a worker machine can actually RUN a shell/agent tab: it must hold the
 *  code — either it shares the primary's filesystem (`shared_fs`) or it keeps a
 *  synced copy (`sync_code`, default on). A worker with neither has no tree to run
 *  in; sync always stays with the primary, so such a worker is offered disabled.
 *  The primary (`"primary"`/`undefined`) and the local mirror are always runnable. */
export function workerRunnable(h: LocalityHost): boolean {
  return !!h.shared_fs || h.sync_code !== false;
}

/**
 * The scope that belongs to no project: the root control terminal's, and the
 * scope every tab opened outside a project lands in. Its working directory is
 * `~/tabtivity/root` (`root_work_dir`), which the side panel browses as the app's
 * unfiled/scratch area.
 */
export const ROOT_SCOPE = "root";

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
 * Sentinel `cmd` for the Skills Library tab (`docs/skills_plan.md`): browse a
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

/**
 * Synthetic group id for the empty-state placeholder subwindow (rendered by
 * CenterPanel when a scope has no layout yet). It is NOT a real group in the
 * store — a drop onto it creates the first tab (addTab builds the root group).
 */
export const EMPTY_GROUP_ID = "__empty__";

/**
 * Persisted per-tab view state for the in-app file viewers, so reopening a file —
 * or restarting Tabtivity — restores the reader where they left it instead of
 * jumping back to the top/default zoom. All fields optional; each viewer fills
 * the ones it has: scroll offset (text + PDF), zoom `scale` (PDF + image), and
 * pan `offsetX/offsetY` (image). Travels with the embed tab in project.json.
 */
export interface ViewerState {
  scrollTop?: number;
  scrollLeft?: number;
  scale?: number;
  // Whether the persisted PDF `scale` is the fit-to-width baseline rather than a
  // zoom the reader chose (#viewerpos). The viewer persists its scale on every
  // change, so most saved values are just "whatever fit the pane last time" —
  // restoring one of those as an absolute zoom into a pane of a different width
  // is how a PDF came back badly rescaled after a restart, with the resize
  // re-fit disabled for the rest of the session. Absent means "not known to be a
  // deliberate zoom": state written before this flag existed re-fits.
  pdfFitted?: boolean;
  offsetX?: number;
  offsetY?: number;
  // Tab-local editor text size (#48). When set it overrides the per-type
  // `viewer_prefs[type].font_size` default for THIS tab only, so zooming one
  // text/markdown/TeX tab no longer resizes every other viewer of that type;
  // absent means the tab tracks the per-type default. Survives reopen/restart.
  fontSize?: number;
  // Tab-local AI-assist overrides (#45). When set, they override the per-type
  // `viewer_prefs` default for THIS tab only; when absent the editor falls back
  // to the per-type setting. Toggled from the in-tab AI-assist controls.
  autocomplete?: boolean;
  autocompleteMode?: AutocompleteMode;
  spellCheck?: boolean;
  // The TeX editor's hover-preview and beamer switches are NOT here: they are
  // the project's, in `stores/viewers/texViewPref` (a tab of a deck is not where "this
  // is a deck" belongs). Old sessions may still carry `texHoverPreview` /
  // `texBeamer` rows, and `grammarCheck` from the removed local-model grammar
  // check; they are ignored.
  // Debug breakpoints (#py), as 1-based line numbers into the file. Persisted per
  // tab like the reader's scroll position, so the dots survive closing the file
  // and a Tabtivity restart. Remapped as the draft is edited (see useBreakpoints);
  // what is stored is always resolved against the file as last seen.
  breakpoints?: number[];
  // Collapsed nodes of the YAML tree (#yaml), as node ids (document + path). Like
  // the scroll position, folding a big config stays folded across a reopen and a
  // restart. Ids are re-derived from the file on every parse, so an id that no
  // longer resolves is simply inert.
  yamlCollapsed?: string[];
  // The YAML TREE's scroll position (#yaml). Kept apart from `scrollTop` (the
  // Source editor's) because Tree and Source are two views of one file with
  // unrelated pixel heights — one scroll offset can't serve both — so switching
  // Tree↔Source restores each side where it was.
  yamlScrollTop?: number;
  // Collapsed cards of the YAML card grid (#yaml-grid), as node ids — the card
  // view's twin of `yamlCollapsed`, kept apart so folding a card and folding a tree
  // row don't clobber each other. Ids are re-derived on every parse, so a stale one
  // is inert.
  gridCollapsed?: string[];
  // Folded cards of the BibTeX card view, as record ids (`entry:<citation key>`).
  // Kept apart from the YAML views' fold sets for their reason — one file is never
  // both — and persisted because a working bibliography is thousands of entries
  // long, so a fold that came back on the next open would be a control that does
  // nothing. Ids are re-derived on every parse, so a stale one is inert.
  bibCollapsed?: string[];
  // The BibTeX card list's ORDER (file order / first author / year, and its
  // direction). Persisted where the filter and the venue picker deliberately are
  // not: an order hides nothing — every entry is still there, in a different
  // place — so it has none of the "the file looks half empty and nothing says
  // why" failure mode that keeps a filter session-local. It reorders only the
  // view; the file's own order is never rewritten.
  bibSort?: string;
  bibSortDesc?: boolean;
  // The focused ("main") card of the YAML card grid (#yaml-grid), as its node id,
  // for the drill navigation: the grid shows that card's level (its siblings, it
  // highlighted) and its children below. Absent/unmatched = the top overview.
  // Re-derived on every parse, so a stale id is inert (falls back to overview).
  gridFocus?: string;
  // Whether the PDF viewer writes a remark into the file on its own, shortly after
  // it is made (#pdf-notes). Absent means ON — the ordinary behaviour, so only the
  // reader who turned it *off* stores anything, and a tab that predates the feature
  // gets it. Per tab rather than per app because it is a statement about a document
  // ("this one I am commenting on") rather than about the person.
  pdfAutosaveNotes?: boolean;
  // Whether selecting text on a PDF page puts it on the clipboard by itself
  // (#pdf-textselect). Absent means ON: selecting words in a document is almost
  // always the first half of pasting them somewhere, and the second half was a
  // keystroke that had to be remembered on a surface where Ctrl+C had never done
  // anything before. Per tab, `pdfAutosaveNotes`'s reason — a paper being quoted from
  // and one being read are different jobs — and reversible from the bar that appears
  // over a selection, because writing the clipboard is not this viewer's to keep
  // doing if the reader was only pointing at a sentence.
  pdfCopyOnSelect?: boolean;
  // The table viewer's column separator (#40), as the literal character. Absent
  // means "auto" — sniffed from the content on every open. It is persisted only
  // when the reader *overrides* the guess, because that is the case the sniffer
  // got wrong: re-sniffing would just talk them back out of it on the next open.
  delimiter?: string;
  // The table viewer's hidden columns (#40), as indices into the parsed row. They
  // are only meaningful for the separator that produced them — a different one
  // cuts the row into different columns — so the viewer drops them when the
  // delimiter changes rather than hiding whatever now sits at those indices.
  hiddenColumns?: number[];
  // The table viewer's drag-resized column widths (#40), keyed by parsed-column
  // index → total pixel width (padding included). Absent for a column means it
  // keeps its measured `ch` width. Like `hiddenColumns` the indices only mean
  // anything under the separator that produced them, so a delimiter change drops
  // the overrides rather than re-applying them to whatever the new cut lands on.
  columnWidths?: Record<number, number>;
  // The deck editor's slide-overview rail width (px), user-resizable via a drag
  // handle. Like the table's column widths, only ever written on an explicit
  // resize — the default is computed, not persisted, so a deck opened for the
  // first time (or by an older build with no field) gets the current default
  // rather than a stale one baked into the file.
  deckRailWidth?: number;
  // --- TeX workspace (`viewer:"texworkspace"`) --------------------------------
  // These ride the single workspace tab whose `embedPath` is the resolved
  // build root, so its layout survives a reopen/restart like every other viewer's
  // reader state. Each follows the "stale id is inert, re-derived from content"
  // convention (yamlCollapsed/gridFocus): a value that no longer resolves against
  // the freshly parsed structure falls back to the default rather than erroring.
  //
  // The absolute path of the file currently CENTERED in the workspace: a child
  // `.tex` (shown in the TeX editor) or a graphic (shown in the image viewer).
  // Absent — or equal to the root — means the main document is centered.
  // Validated against the parsed structure on read; an unresolved path falls back
  // to the root inertly.
  texActivePath?: string;
  // The left structure sidebar's width in px. Absent uses the default; only
  // written on an explicit resize.
  texSidebarWidth?: number;
  // Whether the left structure sidebar is folded away to its rail. Absent means
  // SHOWN — the sidebar is what makes the tab a workspace rather than an editor,
  // so only the reader who put it away stores anything. Per tab like the width
  // beside it: a two-file note and a forty-file thesis want different amounts of
  // that column, and the rail (never a bare edge) is what keeps the fold
  // reversible from where it happened.
  texSidebarHidden?: boolean;
  // --- TeX compile configuration (`viewer:"tex"` and `viewer:"texworkspace"`) --
  // How this document is BUILT: the engine (`""` / absent = let the backend pick
  // its default), the #54 output folder and the #54 extra engine flags. Persisted
  // per tab because the choice is a property of the document — a thesis whose
  // fonts need `lualatex` needs it every sitting, and re-picking the engine after
  // every relaunch (and after the first compile silently failed under the default
  // one) is the whole reason this is stored rather than session state. In a
  // workspace these ride the single workspace tab, so every pane in it builds the
  // shared main document the same way; a standalone `.tex` tab holds its own.
  // Empty strings are stored as written: `""` is a real choice ("back to the
  // backend default"), not an absent one.
  texEngine?: string;
  texOutDir?: string;
  texExtraFlags?: string;
}

// Detached windows render their tabs from a Tauri-event SEED into local React
// state; those tabs never enter `useTabsStore` (the main window owns the layout
// store — see DetachedApp/jumpToSource). Viewer hooks seed their per-tab state
// (scroll/zoom + the #45 autocomplete/grammar overrides) from
// `useTabsStore`, so in a detached window that probe misses and the editor falls
// back to the per-type default — e.g. a per-tab autocomplete toggle silently
// reverts to off. This per-window registry lets those hooks recover a detached
// tab's seeded `viewerState` by key. Populated by DetachedApp from each seed;
// lives only in the detached window's heap (no-op/empty in the main window).
const detachedViewerState = new Map<string, ViewerState>();

/** Register (or clear, when `vs` is undefined) a detached tab's seeded
 *  `viewerState` so viewer hooks can read it when `useTabsStore` has no entry. */
export function setDetachedViewerState(key: string, vs: ViewerState | undefined): void {
  if (vs) detachedViewerState.set(key, vs);
  else detachedViewerState.delete(key);
}

/** A detached tab's seeded `viewerState`, or undefined. See {@link setDetachedViewerState}. */
export function getDetachedViewerState(key: string): ViewerState | undefined {
  return detachedViewerState.get(key);
}

/**
 * Fallback minimum subwindow (split pane) size in px a divider drag may shrink a
 * pane to, per axis, when `settings.min_subwindow_width/height` is unset. Mirrors
 * the Rust schema note on those fields (schema/settings.rs).
 */
export const DEFAULT_MIN_SUBWINDOW_PX = 120;

export interface TabEntry {
  key: string; // globally-unique within a scope; doubles as PTY id suffix
  // The tab's identity in the scope's SHARED tab set (headless owner plan,
  // H1): minted by the workspace service on the tab's first sync and stable
  // across clients and restarts, unlike `key`, which every restore re-mints.
  // Absent until the first sync answers.
  id?: string;
  // The scope (project id or "root") that owns this tab. Set at addTab /
  // loadFromLayout time so the project→tab binding is EXPLICIT rather than
  // positional. writeScope drops any tab whose scope differs from the map key it
  // is being written under, making a cross-project leak structurally impossible
  // (see #55). Optional for back-compat with tabs built directly in tests.
  scope?: string;
  label: string;
  cmd: string;
  args?: string[];
  env?: Record<string, string>;
  initialInput?: string;
  cwd: string;
  kind: TabKind;
  // For agents that support a deterministic session id (currently Claude, via
  // `--session-id <uuid>`), the UUID Tabtivity minted and launched the agent with.
  // Surfaced on tab hover and intended to later drive session resume.
  sessionId?: string;
  // Stable local-only binding into <state_dir>/agent_tasks.json. It follows the
  // tab through restore/locality/split/detach, but duplication mints a new one.
  // The backend strips it from the project-tree export/adoption path.
  scheduleTargetId?: string;
  // This tab's work is **not** worth outliving it: never tmux-wrapped, however
  // persist-enabled its project is (`lib/terminal/tmuxSession`'s `shouldPersistTab`). Set
  // by the SLURM log tab on an HPC-tagged host — a `tail -F` left running under a
  // tmux daemon on a shared login node after Tabtivity quits is exactly the standing
  // presence the tag forbids, and the tail is one click away in the Jobs view.
  // A real run (`srun --pty`, a training job) is untouched: it is the case tmux
  // persistence exists for. Persisted with the tab, so a restored log tab does
  // not quietly regain a session on the next launch.
  ephemeral?: boolean;
  // Auto-continue (agent tabs only): keep this agent going across its CLI's own
  // rate-limit windows. `AgentContinueHost` reads the agent's usage panel, works
  // out when the soonest window rolls over, and submits one "continue" a minute
  // after it does — then reads the panel again and arms the next one. Persisted,
  // because the whole point is a tab that picks itself up again, including
  // across a relaunch; the ARMED time is not persisted (it is re-read on start,
  // and a stored one would fire off a window that had already turned over).
  autoContinue?: boolean;
  // For a custom agent (see CustomAgent) whose spec carries a "continue last
  // session" flag: the resume args this tab respawns with after a restart. Its
  // presence is what makes such a tab restart-resumable without the cmd being in
  // the static RESUMABLE_AGENTS map (see isResumableAgentTab / loadFromLayout).
  // Persisted, since args are rebuilt from scratch on restore.
  resumeArgs?: string[];
  // Epoch ms this tab was opened in this run (addTab / duplicate). Never
  // persisted: a restored tab relaunches on its continue flag instead, and it
  // is only missing there. Tells a fresh OpenCode tab's own session from the
  // folder's older ones (`services::opencode_store`).
  launchedAt?: number;
  // Runtime only: bumped by `relaunchTabInScope` so the pane respawns its PTY
  // even when the args it respawns with are the ones it already had. Never
  // persisted — a restored tab spawns anyway.
  relaunchSeq?: number;
  // Absolute path of the script this terminal tab was launched to run (Python
  // Run/Debug, or a foreground shell-script run). Lets the activity store pulse
  // the file's run button while the tab is producing output. Busy-gated on read,
  // so a restored non-busy run tab never falsely lights up.
  runFile?: string;
  // For "embed" tabs (a file dragged from the FileTree onto a tab bar): the
  // absolute path of the embedded file and the resolved executable that opens
  // it. Phase 1 opens the file externally; Phase 2 will reparent the app's
  // window into the tab. External-app embeds are NOT persisted (they would
  // relaunch the app on restart) — only in-app `viewer` embeds are restored.
  embedPath?: string;
  embedExec?: string;
  // When set, the embed tab renders the file in-app with a built-in viewer
  // (pdf/image/markdown/text/tex) instead of opening it externally — independent
  // of any external default app. These embeds re-render from `embedPath` on
  // relaunch (see isRestorableEmbedTab). See FileViewerPane.
  viewer?: InternalViewer;
  /** Session-only return path for a new markdown tab opened from a link graph. */
  mdGraphOriginKey?: string;
  // For in-app `viewer` embeds: the reader's last scroll/zoom/pan, so reopening
  // the file (or restarting) restores the position instead of jumping to the top
  // (see ViewerState). Written by the viewer panes, persisted in project.json.
  viewerState?: ViewerState;
  // SSH-sync Phase 0: for `agent`/`shell` tabs on a remote project, whether this
  // tab runs locally (in the mirror) or on the host. Absent → the per-kind
  // default (agents local, shells remote — see effectiveTabLocation). Inert on a
  // local project. Persisted so the choice survives a restart.
  location?: TabLocation;
  // There is deliberately no `agentMode` here. An agent tab launches with the
  // plain CLI command and no permission-mode flag; the mode is the agent's own
  // to set, inside its own TUI. Tabtivity used to carry a per-tab Plan/Auto mode
  // and fold it into `args`, which made every flip a PTY respawn — and made the
  // *tab layout* a second, disagreeing authority record beside whatever the
  // session was actually in. The mode a user sets in-session still survives a
  // restart: `services::agent_session` re-applies the one Claude's own hook
  // recorded onto the `--resume` respawn.
  // For "projectfiles" tabs: the project-relative folder the tree is browsed
  // into. Persisted, so "Open in new tab" on a folder (and the tab's own
  // navigation) survive a restart instead of coming back at the project root.
  folder?: string;
  // For "browser" tabs (#61): the tab's COMMITTED address — the last top-level
  // URL that actually loaded, the analogue of `folder?` on a projectfiles tab.
  // Never the in-flight address-bar text. It is the ONLY thing a browser tab
  // persists: no history, no scroll, no form state, no zoom, no cookies. A URL
  // string is inert, human-readable and reviewable in a diff; a serialized
  // session blob written into `project.json` (a control file that lives inside
  // the project tree) is none of those.
  url?: string;
  // Persistent remote sessions (TODO #85): the STABLE tmux session name this shell
  // tab spawns-or-attaches on the host. Minted once at creation and persisted,
  // because the tab's PTY id (scope:key) is regenerated on restore — so the name
  // must live on the tab to survive a relaunch and let the tab REATTACH rather than
  // start a second session. Passed to the backend as `tmux_session` when the tab
  // actually runs persistently (a remote shell tab of a persist-enabled project);
  // inert otherwise. See `lib/terminal/tmuxSession.ts`, `shouldPersistTab`.
  tmuxSession?: string;
  // When set, this shell tab **attaches** to an existing named tmux session on the
  // host (opened from the Sessions view onto a running, possibly hand-started
  // session) instead of spawning a fresh one. Persisted so it reattaches across a
  // restart. Passed as `tmux_attach`, which takes precedence over `tmuxSession`.
  tmuxAttach?: string;
  // The tab's HOST-BOUND MARKER id (`lib/remote/hostBound.ts`, #150): set on a local-model
  // driver tab, which is the one kind of tab allowed to run on the host when the
  // project's container toggle is on. Minted and registered at creation and
  // persisted here for the same reason `tmuxSession` is — the tab's key and PTY id
  // are regenerated on restore, so nothing else on it survives a relaunch. The
  // grant itself is a file in the state dir; this is only the index into it, which
  // is why a planted value buys nothing.
  hostBoundUid?: string;
  // A user-chosen colour from the closed palette in `lib/theme/tabColors.ts` (#264):
  // set by the tab's right-click menu on the desktop, or the Colour sheet on the
  // phone. Absent (the default) leaves the tab on its KIND colour — `TAB_ACCENT`
  // — which is why this is stored as "no colour" rather than as the kind's hue:
  // re-theming, or a kind gaining a new accent, must still move an uncoloured
  // tab. Persisted, because a colour a user assigned to group their tabs is
  // worthless if it does not survive the relaunch that reopens them; and copied
  // verbatim by `duplicateSpec`, since a colour DESCRIBES a tab rather than
  // identifying it.
  color?: TabColor;
  // The tab group (in this bar) this tab belongs to, by name — see
  // `lib/tabStacks`. Every tab of a bar carrying the same name collapses into
  // one chip that lists them on hover. Absent = an ordinary tab. Persisted (a
  // grouping that a relaunch forgets is no grouping), copied by
  // `duplicateSpec` (a copy lands beside its original), and normalized on the
  // way in from disk, where it is attacker-controlled text.
  stack?: string;
  // Important / Urgent, from the tab's right-click menu (`lib/tabMarks`):
  // shown on the tab and summed up on its project's pill. Persisted, validated
  // on the way in from disk, and dropped by `duplicateSpec` — a copy is a new
  // tab, and doubling the pill's count would overstate what needs attention.
  mark?: TabMark;
  // The to-do board card this tab was linked to by its menu's "Create to-do
  // card" (a `CalendarTask.id`). The link lives here rather than on the card
  // because a tab's key is re-minted on every restore; the card finds its tab
  // by searching for this id. Persisted; dropped by `duplicateSpec` (one card,
  // one tab).
  todoId?: string;
  // The root console's **Host session** (`docs/context/agent_authority.md`):
  // this agent tab runs unfenced, with the user's full rights, in Tabtivity's
  // `host` agent home. Only ever set by the console's own "Host session" menu
  // entry, never a project default, never from the phone. Persisted so the
  // tab comes back after a restart — paused (`hostSessionPaused`), never
  // auto-resumed.
  hostSession?: boolean;
  // Runtime only: a restored Host session waits for an explicit Resume before
  // anything is spawned (see TabPane's HostSessionHold).
  hostSessionPaused?: boolean;
  // Idempotency key of the request that created this tab, for the callers that
  // create one without a click behind them: a Mobile create (a keyed hash — it
  // contains no client token) whose timed-out retry must resolve to this exact
  // saved tab instead of duplicating it, and the agent warm-up cron, whose slot
  // id (`lib/agents/agentCron`'s `agentCronKey`) does the same job for two ticks racing
  // inside the grace window. Named for its first caller; read only by
  // `hydrateThenCreateInScope`, which is what both go through.
  mobileRequestHash?: string;
  // A sign-in tab (`lib/agents/signInLaunch`): the CLI's login command, with no
  // conversation to resume. Saved while it runs so the Mobile catalog lists it
  // and the phone that asked for it can attach (`isSavedWhileLive`); never
  // restored.
  signIn?: boolean;
  // A vendor cloud session (`lib/agents/cloudSessions`): no session id either,
  // and a restore would start a second one. Saved while it runs, like `signIn`.
  cloud?: boolean;
  // A local-model tab driven through another agent CLI (`ollama launch claude
  // --model m`, `codex --oss -m m`, …): the driver, the model and the resolved
  // argv, so the tab restores by relaunching that line (`isRelaunchableLocalTab`).
  // Set only on a tab started in a Mobile-access scope (`lib/agents/localTabSpec`),
  // which is what lets the phone come back to it; the backend re-validates the
  // line on every load and drops one it would not have built.
  localLaunch?: LocalLaunch;
  // A local-model tab's driver (`list_local_drivers` id), wherever it was
  // started: its `cmd` is the launcher (`ollama`), so this is what tells the
  // Reader an OpenCode one apart (`lib/agents/agentReader.localTabDriver`).
  // Never saved; a restored tab has `localLaunch.driver` instead.
  localDriver?: string;
}

/** See `TabEntry.localLaunch`. */
export interface LocalLaunch {
  /** A `list_local_drivers` id (`claude`, `codex`, `opencode`, …). */
  driver: string;
  model: string;
  /** The `prepare_local_launch` args for the tab's `cmd`. */
  args: string[];
}

export type SplitDir = "row" | "column";
// "row"    = children laid out left-to-right, vertical dividers
// "column" = children stacked top-to-bottom, horizontal dividers

export interface SplitNode {
  type: "split";
  id: string;
  dir: SplitDir;
  children: LayoutNode[]; // length >= 2
  sizes: number[]; // fractions in (0,1), sum ~= 1, length === children.length
}

export interface GroupNode {
  type: "group";
  id: string;
  tabKeys: string[]; // order shown in this subwindow's tab bar
  activeKey: string | null; // active tab within this group
  // Per-subwindow right file viewer: when true this group renders a docked
  // file-viewer column (the shared ProjectFilesView, hosted by
  // SubwindowFilesSidebar) on its right edge — in the main window and in a
  // detached popout alike. Persisted with the layout tree so it survives a
  // restart, and carried through detach/attach so a popped-out subwindow keeps
  // its viewer.
  filesOpen?: boolean;
  // The sidebar column's width in px (unset → the component default).
  filesWidth?: number;
  // The browsed folder (project-relative) the docked viewer last showed, so the
  // subwindow reopens where it was left. Lives on the node — like the open flag
  // and width — so it persists with the layout, travels with a detach, and is
  // freed when the group (subwindow) is dropped.
  filesFolder?: string;
}

export type LayoutNode = SplitNode | GroupNode;

/**
 * #42: a detached popout window's last-known OS geometry, in physical pixels.
 * Streamed back from the window and persisted so a popout reopens where the user
 * left it after a restart.
 */
export interface WindowBounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * #42: a tab group that has been popped out of the in-window layout tree into
 * its own detached OS window. The group's tab PAYLOADS stay in `tabsByScope`
 * (so PTYs never unmount and #55 scope-binding still holds) — only its
 * arrangement leaves `layoutByScope` and lives here. `label` is the Tauri window
 * label the backend keyed the detached `WebviewWindow` / `TrackedWindow` under,
 * used to close it on dock-back. v1 detaches exactly one `GroupNode` (not an
 * arbitrary split subtree), keeping the re-attach merge math simple.
 */
export interface DetachedGroup {
  id: string; // the detached popout's identity (window/registry label key)
  // The popout's layout. Usually a single GroupNode, but can be a SplitNode once
  // the user splits panes inside the popout (multi-pane popouts). The root node's
  // id need NOT equal `id` — `id` identifies the OS window, the subtree is its
  // content.
  subtree: LayoutNode;
  label: string; // backend window/registry label
  // Last-known OS geometry of the popout, streamed back by the window. Persisted
  // (via the saved tree) so the popout reopens at the same place/size on restart.
  bounds?: WindowBounds;
  // The popout's OWN UI zoom (per-window, not the global/main-window `ui_zoom`),
  // streamed back over DETACHED_ZOOM. Persisted (via the saved tree) and shipped
  // in the popout's seed so it reopens at the zoom it was left at. Undefined = 100%.
  zoom?: number;
}

/**
 * A tab group that has been HIDDEN from the in-window layout tree. Mechanically
 * this is "detach minus the OS window": the group's node leaves
 * `layoutByScope[scope]` while its tab PAYLOADS stay in `tabsByScope` (so PTYs
 * never unmount — `CenterPanel`'s flat pane layer keeps them mounted but
 * `display:none`, since no live layout node references their keys). The user
 * brings it back from the side-panel Hidden list (`unhideGroup`). Unlike a
 * detached popout there is no OS window and thus no `bounds`/`label` handoff.
 */
export interface HiddenGroup {
  id: string; // the hidden group's identity (the original group's id)
  // The hidden subtree. Usually a single GroupNode, but can be a SplitNode when
  // a multi-pane split was hidden whole.
  subtree: LayoutNode;
  label: string; // debug/label tag, mirrors DetachedGroup.label
}

/**
 * The edit shape a detached window streams back. Defined here (not imported from
 * `detached.ts`) so `tabs.ts` stays free of a circular import; `detached.ts`'s
 * `DetachedEdit` is structurally identical.
 */
export type DropEdge = "left" | "right" | "top" | "bottom" | "center";

export type DetachedEditPayload =
  | { kind: "activate"; key: string }
  | { kind: "rename"; key: string; label: string }
  // A tab colour picked in a popout's own right-click menu (#264). Forwarded
  // like the rename beside it rather than applied locally: a popout's store
  // holds no tabs, and the colour lives on the payload the MAIN window persists.
  | { kind: "setColor"; key: string; color: TabColor | undefined }
  // Join a tab to the named tab group in its bar, or leave it (`undefined`).
  // Forwarded for the same reason as the colour above.
  | { kind: "setStack"; key: string; stack: string | undefined }
  | { kind: "setMark"; key: string; mark: TabMark | undefined }
  | { kind: "setTodo"; key: string; todoId: string | undefined }
  // Multi-host: change where a locatable tab runs; applied to the payload here so
  // the main window's flat pane layer (which owns the popout's PTY) respawns it.
  | { kind: "setLocation"; key: string; location: TabLocation }
  // `user`: the popout's ×/Ctrl+W, which a reopen may take back
  // (`stores/agents/closedAgentTabs`); a sweep or file-follow close leaves it off.
  | { kind: "close"; key: string; user?: boolean }
  | { kind: "reorder"; tabKeys: string[] }
  // Multi-pane popouts: split `key` out into a new pane at `edge` of
  // `targetGroupId` (a group within the popout's subtree). `newGroupId` /
  // `newSplitId` are the ids the POPOUT minted when it applied the split
  // optimistically; the main store adopts them so both windows name the new
  // pane identically. Without them each window's own id counter produced two
  // different ids for one pane, and every later message about that pane from
  // the popout (a drop target it reported, a divider it resized) named a group
  // the main store had never heard of — a file dropped on such a pane fell back
  // to the popout's first pane or did nothing at all.
  | {
      kind: "split";
      key: string;
      targetGroupId: string;
      edge: DropEdge;
      newGroupId?: string;
      newSplitId?: string;
    }
  // Multi-pane popouts: resize the divider between children `dividerIndex`/
  // `dividerIndex+1` of the split `splitId` within the popout's subtree.
  | { kind: "resize"; splitId: string; dividerIndex: number; fraction: number }
  // Multi-pane popouts: move `key` into `targetGroupId` (at `index`, else append),
  // merging it across the popout's groups (collapses an emptied source pane).
  | { kind: "move"; key: string; targetGroupId: string; index?: number }
  // Toggle/resize a popout group's docked file-viewer column (the per-subwindow
  // right file viewer), or record the folder it browsed to. Applied to the group
  // node inside the popout's subtree.
  | { kind: "files"; groupId: string; open?: boolean; width?: number; folder?: string }
  // Group B #231 — pane writes forwarded from a popout's empty store. Each is the
  // popout-side twin of one payload write the main store already knows how to
  // make; the seam in the store actions below emits them instead of touching the
  // popout's own (empty) `tabsByScope`.
  | { kind: "setViewerState"; key: string; patch: ViewerState }
  | { kind: "setTmuxName"; key: string; name: string }
  | { kind: "setFolder"; key: string; folder: string }
  | { kind: "setUrl"; key: string; url: string };

/** Flat tab shape as persisted in project.json's `tab_layout`. */
/**
 * Restore-time knobs for `loadFromLayout`. `agentRoots`: directories besides
 * the scope root a restored agent tab may keep as its cwd — a box scope's
 * member roots (see `restoredAgentCwd`). Absent means the scope root only.
 */
export interface LoadFromLayoutOptions {
  agentRoots?: readonly string[];
}

export interface SavedTabEntry {
  key: string;
  /** The shared-set identity (see `TabEntry.id`); the one field a restore
   * keeps verbatim while it re-mints `key`. */
  id?: string;
  /** The workspace version the tab was created at, as the service stamps it
   * (`createdVersion`). Read only: `adoptSyncOutcome` adds a tab another
   * client created after the version this window knew. Never written here. */
  createdVersion?: number;
  label: string;
  cmd: string;
  cwd: string;
  kind?: TabKind;
  type?: string;
  env?: Record<string, string>;
  sessionId?: string;
  scheduleTargetId?: string;
  // For restorable in-app "embed" tabs (a file dragged from the FileTree onto a
  // tab bar that renders via a built-in `viewer`): the absolute file path and
  // the viewer to re-render it with on restart. Only `viewer` embeds are
  // persisted; external-app embeds are dropped (see isRestorableEmbedTab).
  embedPath?: string;
  embedExec?: string;
  viewer?: InternalViewer;
  // Persisted reader position (scroll/zoom/pan) for in-app viewer embeds.
  viewerState?: ViewerState;
  // SSH-sync Phase 0: persisted per-tab local/remote locality (see TabEntry).
  location?: TabLocation;
  // Persisted browsed folder of a "projectfiles" tab (see TabEntry.folder).
  folder?: string;
  // Persisted committed address of a "browser" tab (see TabEntry.url). This one
  // field is the WHOLE of a browser tab's persistence, and a restored tab does
  // not navigate to it by itself — it comes back on its resume card.
  url?: string;
  // Persisted resume args of a restart-resumable custom agent (see
  // TabEntry.resumeArgs). Re-applied as the launch args on restore.
  resumeArgs?: string[];
  // Persisted stable tmux session name for a shell tab (see TabEntry.tmuxSession).
  tmuxSession?: string;
  // Persisted tmux session this shell tab attaches to (see TabEntry.tmuxAttach).
  tmuxAttach?: string;
  // Persisted "never tmux-wrap this tab" marker (see TabEntry.ephemeral).
  ephemeral?: boolean;
  // Persisted auto-continue switch (see TabEntry.autoContinue).
  autoContinue?: boolean;
  // Persisted host-bound marker id (see TabEntry.hostBoundUid, #150).
  hostBoundUid?: string;
  // Persisted user-chosen tab colour (see TabEntry.color).
  color?: TabColor;
  // Persisted tab-group name (see TabEntry.stack).
  stack?: string;
  // Persisted Important / Urgent mark (see TabEntry.mark).
  mark?: TabMark;
  // Persisted to-do card link (see TabEntry.todoId).
  todoId?: string;
  mobileRequestHash?: string;
  // Sign-in tab marker (see TabEntry.signIn); load drops such a tab.
  signIn?: boolean;
  // Cloud-session marker (see TabEntry.cloud); load drops such a tab.
  cloud?: boolean;
  // Persisted Host session marker (see TabEntry.hostSession).
  hostSession?: boolean;
  // Persisted local-model launch line (see TabEntry.localLaunch).
  localLaunch?: LocalLaunch;
}

/**
 * Project a live `TabEntry` onto the persisted `SavedTabEntry` shape — THE one
 * place the ~20-field persisted tab shape is enumerated. Used by both persist
 * paths (`persistScope`'s debounced save and the project-switch snapshot in
 * `stores/projects.ts`); maintaining the list field-for-field in two places is
 * how `folder`, viewer scroll state and the tmux names each got lost on one
 * path while the other saved them.
 *
 * Field notes (why several of these are here at all):
 *  - `url`: a "browser" tab's COMMITTED address (#61) — this projection is the
 *    only path to disk, and a restored tab shows it on its resume card, never
 *    auto-navigated.
 *  - `resumeArgs`: the launch args that carry it are NOT persisted; it is
 *    re-applied when args are rebuilt in `loadFromLayout`.
 *  - `tmuxSession` / `tmuxAttach`: dropping these mints a fresh session name on
 *    restore and `tmux new-session -A` FORKS a second remote session instead of
 *    reattaching the running one.
 *  - `ephemeral`: without the no-tmux marker a restored SLURM log tab is
 *    re-wrapped in tmux and leaks a `tail -F` daemon on the login node.
 *  - `hostBoundUid` (#150): a restored local-model tab must still resolve to
 *    its registered marker in the state dir.
 */
export function toSavedTabEntry(t: TabEntry): SavedTabEntry {
  return {
    key: t.key,
    id: t.id,
    label: t.label,
    cmd: t.cmd,
    cwd: t.cwd,
    kind: t.kind,
    env: t.env ?? {},
    sessionId: t.sessionId,
    scheduleTargetId: t.scheduleTargetId,
    embedPath: t.embedPath,
    embedExec: t.embedExec,
    viewer: t.viewer,
    viewerState: t.viewerState,
    // SSH-sync Phase 0: the per-tab locality.
    location: t.location,
    // A "projectfiles" tab's browsed folder.
    folder: t.folder,
    url: t.url,
    resumeArgs: t.resumeArgs,
    tmuxSession: t.tmuxSession,
    tmuxAttach: t.tmuxAttach,
    hostBoundUid: t.hostBoundUid,
    mobileRequestHash: t.mobileRequestHash,
    ephemeral: t.ephemeral,
    autoContinue: t.autoContinue,
    color: t.color,
    stack: t.stack,
    mark: t.mark,
    todoId: t.todoId,
    hostSession: t.hostSession || undefined,
    localLaunch: t.localLaunch,
    signIn: t.signIn || undefined,
    cloud: t.cloud || undefined,
  };
}

/** Serialized layout tree as persisted in project.json's `tab_groups`. */
export type SavedLayoutTree =
  | {
      type: "split";
      dir: SplitDir;
      children: SavedLayoutTree[];
      sizes: number[];
      // #42: a MULTI-PANE popout's content is a split, so the detached tag can sit
      // on a split node too — restore re-opens the whole split subtree as one
      // floating popout (see withDetachedDocked / deserializeTree / detachGroup).
      detached?: boolean;
      bounds?: WindowBounds;
      // A detached popout's own per-window zoom (see DetachedGroup.zoom).
      zoom?: number;
      // When true, this split subtree was HIDDEN (parked out of the tiled layout).
      // Persisted as a docked node so its tabs survive, but tagged so restore
      // routes it back into `hiddenGroupsByScope` instead of the live tree.
      // See withHiddenDocked / deserializeTree / loadFromLayout.
      hidden?: boolean;
    }
  | {
      type: "group";
      tabKeys: string[];
      activeKey: string | null;
      // #42: when true, this group was popped out into its own OS window. It is
      // persisted as a normal docked group (so the tabs survive even if respawn
      // is disabled) but tagged so restore can re-open it as a floating popout
      // at `bounds` instead of docking it. See withDetachedDocked / loadFromLayout.
      detached?: boolean;
      bounds?: WindowBounds;
      // A detached popout's own per-window zoom (see DetachedGroup.zoom).
      zoom?: number;
      // When true, this group was HIDDEN (see the split variant's note). Restore
      // moves it into `hiddenGroupsByScope` rather than docking it live.
      hidden?: boolean;
      // Per-subwindow right file viewer (see GroupNode.filesOpen/filesWidth).
      filesOpen?: boolean;
      filesWidth?: number;
      filesFolder?: string;
    };

/**
 * Persist-ready snapshot of a scope's tabs + layout for a project switch,
 * produced by `snapshotScopeForSwitch`. `tabs` are the scope-owned, restorable
 * tab payloads (in tree order); `tabGroups` is the pruned, detached-docked
 * serialized layout tree; `activeTabIndex` indexes the active tab within `tabs`.
 */
export interface ScopeSwitchSnapshot {
  tabs: TabEntry[];
  tabGroups: SavedLayoutTree | null;
  activeTabIndex: number;
  /** The workspace version this window last saw for the scope (see
   * `TabsStore.workspaceVersionByScope`); the switch save's base. */
  workspaceVersion: number | undefined;
}

/** Where `addTab` puts the tab. `seeded`: see `addTab`. `besideActive`: right
 *  of the target group's active tab rather than at the group's end. */
export interface AddTabOpts {
  seeded?: boolean;
  besideActive?: boolean;
}

interface TabsStore {
  scope: string;

  // source of truth for tab payloads
  tabsByScope: Record<string, TabEntry[]>;
  // The workspace version this window last received for a scope (a snapshot
  // or a sync answer) — what its next sync names as its base, so the service
  // can tell what this window changed from what it never saw. Absent for a
  // scope hydrated through a backend that predates the service.
  workspaceVersionByScope: Record<string, number>;
  // arrangement; root is always present once a scope has >=1 tab
  layoutByScope: Record<string, LayoutNode | null>;
  // which group is focused (its active tab is the "globally active" one)
  focusedGroupByScope: Record<string, string | null>;
  // #42: per-scope groups that have been popped out into detached OS windows.
  // Their tab payloads still live in `tabsByScope[scope]`; only their layout
  // node has left `layoutByScope[scope]`.
  detachedGroupsByScope: Record<string, DetachedGroup[]>;
  // Per-scope groups the user has HIDDEN (parked out of the tiled layout while
  // keeping their tabs/PTYs alive — detach minus the OS window). Like the
  // detached map, the payloads stay in `tabsByScope[scope]`; only the layout
  // node lives here. Surfaced by the side-panel Hidden list; restored via
  // `unhideGroup`. Persists across restart via the SavedLayoutTree `hidden` tag.
  hiddenGroupsByScope: Record<string, HiddenGroup[]>;
  // #42: per-scope groups that were detached when the scope was last saved and
  // must be re-opened as floating popouts once the scope's layout is live and its
  // panes (PTYs) have mounted. Populated by loadFromLayout, drained by
  // consumePendingRespawn (driven from CenterPanel after the panes render).
  pendingRespawnByScope: Record<string, RespawnTarget[]>;

  // flat mirrors of the CURRENT scope (kept for ergonomic consumers / tests)
  tabs: TabEntry[];
  layout: LayoutNode | null;
  focusedGroupId: string | null;
  activeKey: string | null; // = active tab of the focused group

  // #62: app-internal fullscreen — when set, CenterPanel renders only this
  // group's body full-bleed (panes stay mounted; this just repositions). Cleared
  // on Escape, when the group vanishes, or by toggling the same group again.
  fullscreenGroupId: string | null;
  toggleFullscreen: (groupId: string | null) => void;

  setScope: (scope: string) => void;

  // focus / activation
  focusGroup: (groupId: string) => void;
  /** `focusGroup` for any scope — the root console arranges the root scope's
   *  subwindows while a project is the active scope. */
  focusGroupInScope: (scope: string, groupId: string) => void;
  setActive: (key: string) => void; // activate tab + focus its group
  setGroupActive: (groupId: string, key: string) => void;
  setGroupActiveInScope: (scope: string, groupId: string, key: string) => void;
  // `setActive` for a scope that is not necessarily the current one: activate the
  // tab within its subwindow and focus that subwindow in THAT scope's own tree,
  // so a caller can aim a click at a project before switching to it (the project
  // pill's status bars). Writing the scope map ahead of the switch is what makes
  // the two one gesture: `setScope` mirrors whatever it finds there, so the tab
  // is already the visible one by the time the project comes up. Returns false
  // when the tab is not in that scope's visible tree — it sits in a hidden
  // subwindow or a detached window — so the caller can still do the part of the
  // jump it can (switching scope) rather than believing it landed.
  revealTabInScope: (scope: string, key: string) => boolean;

  // tab lifecycle
  // `seeded` marks a tab Tabtivity opened by itself rather than one the user asked
  // for (the root scope's default 3D-blob tab). Such a tab must not be counted as
  // a tab the user opened — see `countTabOpen`.
  addTab: (tab: Omit<TabEntry, "key">, opts?: AddTabOpts) => TabEntry; // into focused group
  // Add a tab into a SPECIFIC scope's focused group, regardless of which scope is
  // currently active. Used to surface remote SSH/OpenVPN connections in the root
  // scope without disturbing the active project. When `scope` is the current
  // scope this behaves exactly like `addTab`; otherwise the tab is written into
  // that scope's maps only (the user sees it after switching to it).
  addTabToScope: (
    scope: string,
    tab: Omit<TabEntry, "key">,
    opts?: AddTabOpts,
  ) => TabEntry;
  // Open a second tab like an existing one (the tab context menu's "Duplicate"),
  // landing directly to its RIGHT rather than at the end of the group — a copy
  // that appears eight tabs away doesn't read as a copy. Everything that
  // IDENTIFIES the original rather than describing it is re-minted or dropped
  // (see `duplicateSpec`); `overrides` is for the one such field the store can't
  // mint synchronously, `hostBoundUid` (registering it is a backend round trip).
  duplicateTab: (key: string, overrides?: Partial<TabEntry>) => TabEntry | null;
  ensureTab: (
    tab: Omit<TabEntry, "key">,
    matches: (tab: TabEntry) => boolean,
    opts?: AddTabOpts,
  ) => TabEntry;
  renameTab: (key: string, label: string) => void;
  // The same rename, aimed at a named scope instead of the active one. The
  // Agents view of the file viewer lists `tabsByScope[scope]` for ITS scope,
  // which is not necessarily the scope the tab bar is showing (a Files (Project)
  // tab of one project, a docked subwindow sidebar), and `renameTab` writes to
  // whichever scope is active — so renaming from there needs the scope said out
  // loud. Falls through to `renameTab` when they are the same, keeping the
  // detached-popout forwarding path intact.
  renameTabInScope: (scope: string, key: string, label: string) => void;
  // Paint one tab of the ACTIVE scope with a palette colour, or clear it with
  // `undefined` (see TabEntry.color). Forwards to the main window from a popout
  // exactly as `renameTab` does.
  setTabColor: (key: string, color: TabColor | undefined) => void;
  // The same, aimed at a named scope — what the phone's Colour sheet goes
  // through, since the project it is looking at need not be the one the window
  // is showing. Falls through to `setTabColor` when they are the same scope.
  setTabColorInScope: (scope: string, key: string, color: TabColor | undefined) => void;
  // Put one tab into the named tab group of its bar, or take it out with
  // `undefined` (see TabEntry.stack). A tab joining a group that already has
  // members is moved to sit right after them. Forwards from a popout like the
  // colour above.
  setTabStack: (key: string, stack: string | undefined) => void;
  // Mark one tab Important / Urgent, or clear it with `undefined` (see
  // TabEntry.mark). Writes the scope that owns the tab; forwards from a popout.
  setTabMark: (key: string, mark: TabMark | undefined) => void;
  // Link one tab to a to-do card, or unlink it with `undefined` (see
  // TabEntry.todoId). Same scope and popout rules as `setTabMark`.
  setTabTodo: (key: string, todoId: string | undefined) => void;
  // Turn auto-continue on or off for ONE agent tab in `scope` (see
  // TabEntry.autoContinue). Scoped like the rename above, because the Agents
  // view is rendered for a scope that need not be the active one.
  setAutoContinueInScope: (scope: string, key: string, on: boolean) => void;
  // Let a restored Host session spawn (see TabEntry.hostSessionPaused).
  resumeHostSession: (scope: string, key: string) => void;
  // Move one tab next to another inside `scope`, as the Agents view's drag
  // reorder does. Permutes `tabsByScope[scope]` — the order the "native" sort
  // reads — and, when both tabs sit in the same layout group, that group's
  // `tabKeys` too, so the list and the tab bar keep telling the same story
  // instead of drifting apart. Scoped for the same reason the two above are.
  reorderTabInScope: (
    scope: string,
    key: string,
    anchorKey: string,
    place: "before" | "after",
  ) => void;
  // Rewrite the embedPath (and label) of every in-app "embed" tab in the CURRENT
  // scope whose file was renamed/moved on disk — an exact match (`embedPath ===
  // oldAbs`) or, for a directory rename/move, any tab UNDER it (`embedPath`
  // starts with `oldAbs + "/"`, prefix-swapped to `newAbs`). Payload-only (keys
  // unchanged), so the main CenterPanel re-renders from the store and the updated
  // payloads are what a subsequent reseed ships to any detached popout. On an
  // exact match the label is refreshed to the new basename only when it still
  // equals the old basename (so a user-renamed tab keeps its label). No-op when
  // nothing matches. Delete/rename tab-sync lives in components/files/fileTabSync.
  /**
   * Re-point a project's tabs after it is detached from its SSH host, moving every cwd
   * out of the old remote-project state dir and into the promoted mirror.
   *
   * This is not cosmetic; without it a detach silently breaks every agent tab. While a
   * project is remote its `directory` is the **state dir**
   * (`~/.local/share/tabtivity/remote-projects/<id>/`), and `loadFromLayout` stores exactly
   * that as each tab's `cwd` (agents unconditionally, others via `t.cwd || defaultCwd`).
   * Nothing noticed, because `localTabCwd` overrode it at render time to the real mirror —
   * an override gated on `isRemoteProject`. Detach flips that to false, the override stops
   * firing, and every tab falls back to the stored cwd it never should have had: the state
   * dir. Agents then launch inside `~/.local/share/tabtivity/remote-projects/<id>/` — a
   * directory that detach has just emptied — so Claude asks for permissions there and
   * `--resume` finds no session, because Claude keys its history by cwd and the whole
   * conversation lives under the mirror's path instead.
   *
   * Host-located tabs are converted to local too: their cwd is a path on a machine this
   * project is no longer attached to.
   */
  detachScopeFromRemote: (scope: string, oldDir: string, newDir: string) => void;
  retargetTabs: (oldAbs: string, newAbs: string) => void;
  removeTab: (key: string) => void; // drop; collapse empty groups/splits
  // The same close, aimed at a named scope instead of the active one. The
  // Mobile bridge closes a tab in whichever project the PHONE is looking at,
  // which need not be the one the desktop is showing — and `removeTab` writes
  // to the active scope, so without the scope said out loud a close from the
  // phone would drop a tab out of the project on the user's screen. Closing
  // stays what it is on the desktop (`lib/remote/closeRemoteTab`, which also
  // ends the tab's local tmux session): the pane unmounts and its PTY dies. A tab
  // living in a popout is closed through that window's own teardown, since its
  // pane is mounted there and nothing here would otherwise kill its PTY.
  // Non-current scopes are dropped in memory only; persist at the call site.
  removeTabInScope: (scope: string, key: string) => void;
  closeGroup: (groupId: string) => void; // close a whole subwindow; siblings resize
  // Close EVERY tab/subwindow in a scope (defaults to the current scope),
  // leaving it empty (null layout → the +-placeholder). Each pane unmounts, so
  // its PTY dies. Non-current scopes are cleared in memory only; persist
  // explicitly at the call site if the scope isn't the active project.
  closeAllTabs: (scope?: string) => void;
  /** Remove a loaded scope from memory without changing its saved layout. Used
   *  only after project deactivation has persisted and stopped its runtimes. */
  unloadScope: (scope: string) => Promise<void>;
  updateTabEnv: (key: string, env: Record<string, string>) => void;
  // Persistent sessions (TODO #85): rename a tab's tmux session name after the
  // Sessions view renamed the host session, so the persisted name still matches
  // and the tab reattaches to the renamed session on restart. Updates whichever
  // field the tab uses (`tmuxAttach` for an attach tab, else `tmuxSession`).
  // Scope-explicit (the Sessions view may act on a non-active project).
  setTabTmuxName: (scope: string, key: string, name: string) => void;
  // SSH-sync Phase 0: set a tab's local/remote locality (agent/shell tabs on a
  // remote project). No-op when unchanged. The CenterPanel's localOnly/cwd
  // computation reads the result so the next mount spawns on the chosen side.
  setTabLocation: (key: string, location: TabLocation) => void;
  // Respawn a tab's PTY in place with `args` — same tab, key and position.
  // The caller ends a tmux session the tab owns first, or the respawn would
  // just reattach to it ("Undo clear", `stores/agents/agentClearUndo`).
  relaunchTabInScope: (scope: string, key: string, args: string[]) => void;
  // Swap the built-in viewer an embed tab renders its file with, in place — same
  // tab, same key, same position in the layout. `viewer` is persisted, so a tab
  // saved under a viewer choice the app has since revised comes back under the
  // old one for ever; this is how such a tab is HEALED rather than left beside a
  // freshly opened duplicate (the `tex` → `texworkspace` upgrade in
  // FileViewerPane / openTexWorkspace). No-op when unchanged.
  setTabViewer: (key: string, viewer: InternalViewer) => void;
  // Merge a patch into an embed tab's persisted viewer position (scroll/zoom/
  // pan). The viewer panes call this as the reader scrolls/zooms; the debounced
  // saveLayout effect then flushes it to project.json (see ViewerState).
  setViewerState: (key: string, patch: ViewerState) => void;
  // Record the folder a "projectfiles" tab is browsed into, so it reopens there
  // (see TabEntry.folder). No-op when unchanged.
  setTabFolder: (key: string, folder: string) => void;
  // Record the address a "browser" tab COMMITTED to — the page that actually
  // loaded, never the in-flight address-bar text (see TabEntry.url). No-op when
  // unchanged, so re-loading the same page doesn't churn the layout save.
  setTabUrl: (key: string, url: string) => void;

  // arrangement
  reorderInGroup: (groupId: string, from: number, to: number) => void;
  moveTab: (key: string, targetGroupId: string, index?: number) => void;
  splitWithTab: (key: string, targetGroupId: string, edge: DropEdge) => void;
  // The same two moves on a named scope (the root console arranges the root
  // scope while a project is active). The current-scope pair delegates here.
  moveTabInScope: (scope: string, key: string, targetGroupId: string, index?: number) => void;
  splitWithTabInScope: (scope: string, key: string, targetGroupId: string, edge: DropEdge) => void;
  // Create a brand-new tab in a fresh group split off the target at `edge`
  // (or, for "center", added into the target group). Used by file drops from the
  // side panel to spawn a new subwindow holding the file directly. Returns the
  // created tab, or null if the target group no longer exists.
  splitWithNewTab: (
    tab: Omit<TabEntry, "key">,
    targetGroupId: string,
    edge: DropEdge,
  ) => TabEntry | null;
  resizeSplit: (splitId: string, dividerIndex: number, fraction: number) => void;
  resizeSplitInScope: (scope: string, splitId: string, dividerIndex: number, fraction: number) => void;
  // Merge two adjacent subwindows into one (double-click the divider between
  // them): append every tab of `sourceGroupId` onto `targetGroupId`, then let
  // `writeScope`'s collapse pass drop the emptied source and unwrap the split.
  // PTYs are preserved (tabs move, not close); the survivor keeps its activeKey.
  // No-op if either group is missing or they are the same group.
  mergeGroups: (targetGroupId: string, sourceGroupId: string) => void;
  mergeGroupsInScope: (scope: string, targetGroupId: string, sourceGroupId: string) => void;

  // Per-subwindow right file viewer: open/close a group's docked file-viewer
  // column, and persist its width. Both write the flag onto the group NODE
  // (GroupNode.filesOpen/filesWidth), so the sidebar persists with the layout
  // tree and travels with a detach. No-ops if the group isn't in the current
  // scope's live layout (popout-side toggles arrive via applyDetachedEdit).
  setGroupFiles: (groupId: string, open: boolean) => void;
  setGroupFilesWidth: (groupId: string, width: number) => void;
  // Persist the folder the group's docked viewer last browsed to (see
  // GroupNode.filesFolder). Same node-write path as the flag/width.
  setGroupFilesFolder: (groupId: string, folder: string) => void;
  // The same three writes addressed to a NAMED scope — what the root console
  // needs, since root is not the active scope while it floats over a project
  // (the plain actions above write `s.scope` and would file the console's file
  // viewer onto the project on screen).
  setGroupFilesInScope: (scope: string, groupId: string, open: boolean) => void;
  setGroupFilesWidthInScope: (scope: string, groupId: string, width: number) => void;
  setGroupFilesFolderInScope: (scope: string, groupId: string, folder: string) => void;

  // #42: detach / re-attach a subwindow (group) to/from its own OS window.
  // `detachGroup` removes the group from the in-window tree, records it in
  // `detachedGroupsByScope`, and (unless `skipBackend`) spawns the detached
  // OS window via the `detach_subwindow` command. Refuses to detach the lone
  // group (can't empty the in-window layout) UNLESS `allowLastGroup` is set.
  // Both live callers set it: the restart respawn path, where a popout may be the
  // only group left (its in-window siblings held only non-restorable tabs) yet
  // must still re-open as its own window; and the tab bar's detach grip, because
  // popping the only subwindow onto a second monitor is an ordinary thing to want
  // and refusing it made the gesture a silent no-op. The refusal is kept as the
  // default only so a future caller has to say it means to empty the scope — the
  // resulting state is a valid resting one (`hideGroup` produces the same, and
  // says so). Returns the detached group's label, or null if refused / not found.
  detachGroup: (
    groupId: string,
    opts?: {
      skipBackend?: boolean;
      bounds?: WindowBounds;
      allowLastGroup?: boolean;
      // Restart respawn only: the popout's persisted per-window zoom, recorded on
      // the fresh detached entry so its seed restores it (see RespawnTarget.zoom).
      zoom?: number;
    },
  ) => string | null;
  // Drag-a-tab-to-another-monitor: pop a SINGLE existing tab out of the in-window
  // layout into its own fresh detached OS window at `bounds` (screen px). Unlike
  // detachGroup (which moves a whole subwindow and refuses the lone group), this
  // is per-tab and never refuses: the tab is removed from its current group and
  // seeded into a brand-new single-tab detached group, even if that empties the
  // main center (which then shows the placeholder). Returns the window label, or
  // null if the tab/scope can't be resolved.
  detachTab: (key: string, bounds: WindowBounds) => string | null;
  // Drag-a-file-to-another-monitor: mint a brand-new tab (e.g. an embed/viewer
  // tab for a file dropped outside the window) straight into its own fresh
  // detached OS window at `bounds`, without ever touching the in-window layout.
  // Returns the window label.
  detachNewTab: (tab: Omit<TabEntry, "key">, bounds: WindowBounds) => string;
  // `attachGroup` pops the detached entry, regenerates its ids, re-injects it
  // (adjacent to `targetGroupId`/`edge`, or as root if the tree is empty), and
  // (unless `skipBackend`) closes the detached OS window via `attach_subwindow`.
  attachGroup: (
    detachedId: string,
    opts?: { targetGroupId?: string; edge?: DropEdge; skipBackend?: boolean },
  ) => void;
  // Hide a subwindow (group) from the tiled layout without killing it: strips its
  // node from `layoutByScope`, keeps its tab payloads in `tabsByScope` (PTYs stay
  // mounted-but-hidden), and parks the subtree in `hiddenGroupsByScope`. Unlike
  // `detachGroup` it allows hiding the LAST group (the scope then shows the
  // +-placeholder) and spawns no OS window. No-op if the group isn't found.
  hideGroup: (groupId: string) => void;
  // Restore a hidden group into the live layout (the reverse of `hideGroup`,
  // modeled on `attachGroup`): regenerates the subtree's ids, injects it as a new
  // pane (or as the root if the layout emptied), drops the hidden record, and
  // focuses it. `opts.activeKey` restores it focused on a specific tab (tab-chip
  // click in the Hidden list). No-op if the hidden entry is gone.
  unhideGroup: (hiddenId: string, opts?: { activeKey?: string }) => void;
  // Permanently close a hidden group: drops the hidden record AND its tab
  // payloads from `tabsByScope` (killing the PTYs, mirroring `closeGroup`). Used
  // by the ✕ on a Hidden-list row. No-op if the hidden entry is gone.
  closeHiddenGroup: (hiddenId: string) => void;
  // #42: dock a SINGLE tab out of a popout back into a scope's layout (the
  // per-tab analog of attachGroup, used when one tab — not the whole group — is
  // dragged onto the main window). Inserts the tab at `targetGroupId`/`edge`
  // (center merges, an edge splits) or as a default placement, removes it from
  // the detached group's subtree, and — if that empties the popout — drops the
  // detached record and closes its OS window. The tab payload already lives in
  // `tabsByScope`, so it survives the move. Works for the active scope (live
  // layout) and an inactive one (stored layout). No-op if the tab/group is gone.
  attachDetachedTab: (
    scope: string,
    detachedGroupId: string,
    tabKey: string,
    opts?: { targetGroupId?: string; edge?: DropEdge; skipBackend?: boolean },
  ) => void;
  // #42: dock ONE PANE (an inner group) of a MULTI-pane popout back into a
  // scope's layout — the per-pane analog of attachDetachedTab, fired when a
  // pane's bar grip is dragged onto the main window. Moves the pane's tabs as
  // one group into the layout at `targetGroupId`/`edge` (center merges, an edge
  // splits, default lands as its own pane) and removes the group node from the
  // popout's subtree, leaving the sibling panes floating. If the pane is the
  // popout's ONLY group this IS a whole-popout dock and delegates to
  // attachGroup / dropDetachedGroup (which also close the OS window). The tab
  // payloads already live in `tabsByScope`, so they survive the move. No-op if
  // the popout or pane is gone.
  attachDetachedPane: (
    scope: string,
    detachedGroupId: string,
    paneId: string,
    opts?: { targetGroupId?: string; edge?: DropEdge; skipBackend?: boolean },
  ) => void;
  // #42: pop ONE PANE (an inner group) of a MULTI-pane popout into its OWN brand
  // new detached OS window — the per-pane analog of detachTabToNewWindow, fired
  // when a pane's bar grip is dragged and released in FREE SPACE. Removes the
  // group node from the source popout's subtree and records a fresh detached
  // entry holding just that group at `bounds`, then spawns its OS window. The
  // tab payloads stay in `tabsByScope` (shared). Refuses (returns null) when the
  // popout/pane is gone OR the pane is the popout's only group — the popout
  // already IS that pane's window. Returns the new window label.
  detachPaneToNewWindow: (
    scope: string,
    fromGroupId: string,
    paneId: string,
    bounds: WindowBounds,
  ) => string | null;
  // #42: pop a SINGLE tab OUT of an existing detached popout into its OWN brand
  // new detached OS window (the popout analog of TabBar's `popToNewWindow`),
  // fired when a tab dragged out of a popout is released in FREE SPACE — outside
  // both the main window and the popout. Removes `tabKey` from the source
  // popout's subtree and records a fresh single-tab detached entry at `bounds`,
  // then spawns its OS window. The tab payload stays in `tabsByScope[scope]`
  // (shared), so the new popout self-seeds and the PTY never dies. No-ops
  // (returns null) when the source/tab is gone OR when removing the tab would
  // empty the source popout — a lone-tab popout dragged whole is already its own
  // window, so re-detaching it would be needless churn. Returns the new label.
  detachTabToNewWindow: (
    scope: string,
    fromGroupId: string,
    tabKey: string,
    bounds: WindowBounds,
  ) => string | null;
  // #42 (main → detached): dock a SINGLE existing in-window tab INTO an already
  // open detached popout's group — the inverse of `attachDetachedTab`, fired when
  // a tab dragged out of the main window is released over a popout (so no new OS
  // window opens). Removes the tab from its source group in `scope`'s in-window
  // layout (its payload STAYS in `tabsByScope`, so the PTY never dies: the main
  // keeps the pane mounted-but-hidden and the popout re-attaches to it), appends
  // it to the detached group's subtree, and activates it there. The caller
  // re-seeds the popout so the new tab renders. No-op if the tab or detached
  // group is gone.
  dockTabIntoDetached: (
    scope: string,
    detachedGroupId: string,
    tabKey: string,
    // #42: where inside the popout to place the tab — a specific pane resolved
    // from the cursor (a body edge splits, center/a bar slot merges into that
    // group). Omitted → append to the popout's first pane (legacy behaviour).
    target?: DetachedDockTarget,
  ) => void;
  // #42 (detached → detached): move a SINGLE tab from one open popout INTO another
  // open popout of the SAME scope — fired when a tab dragged out of popout A is
  // released over popout B. Removes `tabKey` from the source popout's subtree
  // (dropping the source record + closing its OS window when it empties, mirroring
  // `attachDetachedTab`) and places it into the destination popout's subtree at
  // `target`. The payload STAYS in `tabsByScope` (shared), so the PTY the MAIN
  // window owns never dies and both popouts re-attach to it after the re-seed.
  // No-op if either popout is gone, the tab is absent from the source, or it is
  // already in the destination.
  moveTabBetweenDetached: (
    scope: string,
    fromGroupId: string,
    toGroupId: string,
    tabKey: string,
    target?: DetachedDockTarget,
    opts?: { skipBackend?: boolean },
  ) => void;
  // #42: apply an edit streamed back from a detached window to the main store's
  // record of that detached group (its subtree node + tab payloads). Keeps the
  // main window — the single persistence owner — in sync with the detached one.
  applyDetachedEdit: (
    scope: string,
    groupId: string,
    edit: DetachedEditPayload,
  ) => void;
  // #42: create a NEW tab inside a detached popout, from its own "+" menu. The
  // main window mints the key + owns the PTY, so this appends the payload to
  // `tabsByScope[scope]` (spawning its pane in the main window's flat pane layer)
  // and inserts the key into `targetGroupId` within the popout's subtree,
  // activating it. Returns the minted key (or null if the popout/group is gone),
  // so the caller can re-seed the popout to render + attach to the new tab.
  addDetachedTab: (
    scope: string,
    detachedGroupId: string,
    tab: Omit<TabEntry, "key">,
    targetGroupId: string,
  ) => string | null;
  // Like `addDetachedTab`, but the new tab carves a NEW pane at `edge` of
  // `targetGroupId` within the popout's subtree instead of appending to it — a
  // file dropped on a body edge inside a detached popout. Mints the key + owns
  // the PTY (main window), so it returns the minted key (or null if the popout /
  // group is gone) for the caller's re-seed. `edge` must be a side, never
  // "center" (that appends → use `addDetachedTab`).
  addDetachedTabSplit: (
    scope: string,
    detachedGroupId: string,
    tab: Omit<TabEntry, "key">,
    targetGroupId: string,
    edge: DropEdge,
  ) => string | null;
  // Multi-pane popouts: split a tab inside a detached popout's own subtree,
  // carving a new pane at `edge` of `targetGroupId` (a group WITHIN the
  // popout's subtree). Mirrors `splitWithTab` but mutates
  // `detachedGroupsByScope[scope][i].subtree` instead of the in-window layout.
  // The caller re-seeds the popout so it re-renders the new split.
  splitDetachedGroup: (
    scope: string,
    detachedGroupId: string,
    key: string,
    targetGroupId: string,
    edge: DropEdge,
  ) => void;
  // #42: dock-back for a group whose scope is NOT active. We re-inject the
  // detached subtree into that scope's STORED layout (`layoutByScope[scope]`,
  // not the live `layout`) so its tabs remain referenced by a layout node and
  // persist normally, then drop the detached record. The detached OS window is
  // closed via `attach_subwindow`. Used by the host's cross-scope
  // `DETACHED_DOCK` path; the active-scope path goes through `attachGroup`.
  dropDetachedGroup: (scope: string, groupId: string, opts?: { skipBackend?: boolean }) => void;
  // Group B #224: a popout that never came up (its OS window failed to build,
  // it timed out waiting for a seed, or it was destroyed behind the store's
  // back — `xkill`, a renderer crash) must not take its tabs with it. Re-dock
  // the record into the scope's layout — the live one when the scope is active
  // (`attachGroup`), the stored one otherwise (`dropDetachedGroup`) — so the
  // tabs are visible again and, crucially, no longer persisted `detached:true`
  // (which would repeat the failure at every launch). No-op without a record.
  // Never invokes the backend: the window is already gone, and the two
  // dock paths' `attach_subwindow` is idempotent anyway.
  recoverDetachedGroup: (scope: string, groupId: string) => void;
  // #42: ask the backend for every popout of `scope` — called by `setScope`
  // right after the scope sync. A live popout makes each call a no-op (X11,
  // Windows, macOS park by hiding, so theirs always are); native Wayland closes
  // an inactive scope's popouts and keeps their records, so this is where they
  // come back, at their saved size. A rebuild docks the record back only after
  // bounded retries have failed (`recoverDetachedGroup`).
  respawnDetachedForScope: (scope: string) => void;
  // #42: WM-close of a popout closes its tabs for good instead of docking them
  // back: kills each tab's PTY (the popout's panes are NOT mounted in the main
  // window and the detached viewer is attach-only, so nothing else tears them
  // down), drops their payloads from `tabsByScope`, and drops the detached
  // record. It does NOT re-inject the subtree into any layout, so the tabs are
  // gone — persist the scope afterwards (persistScope) so disk agrees and they
  // don't restore on next launch. Closes the OS window via `attach_subwindow`.
  closeDetachedGroup: (scope: string, groupId: string) => void;
  // #42: hide a popout into the side-panel "Hidden subwindows" list instead of
  // docking it live or closing it — the detached twin of `hideGroup`. Moves the
  // popout's subtree from `detachedGroupsByScope` into `hiddenGroupsByScope[scope]`
  // (its tab payloads never left `tabsByScope`, so the flat pane layer keeps their
  // PTYs mounted through the move) and closes the OS window via `attach_subwindow`.
  // Restored/closed from the Hidden list exactly like a hidden main-window
  // subwindow (`unhideGroup`/`closeHiddenGroup`), which docks it back into the
  // tiled layout. No-op if the detached entry is gone.
  hideDetachedGroup: (scope: string, groupId: string) => void;
  // #42: record a popout's latest OS geometry (streamed back from the window) so
  // it persists and the popout reopens where the user left it after a restart.
  setDetachedBounds: (scope: string, groupId: string, bounds: WindowBounds) => void;
  // Record a popout's latest per-window zoom (streamed back over DETACHED_ZOOM)
  // so it persists and the popout reopens at that zoom after a restart.
  setDetachedZoom: (scope: string, groupId: string, zoom: number) => void;
  // #42: return and clear the scope's pending respawn targets (groups that were
  // detached at save time). Caller re-opens each via detachGroup once its pane
  // has mounted. Returns [] when there is nothing to respawn.
  consumePendingRespawn: (scope: string) => RespawnTarget[];

  // Struct #3 / Eff #13: produce the persist-ready snapshot of a scope's tabs +
  // layout for a project switch, WITHOUT the caller reaching into the store's
  // internal maps + tree helpers. Encapsulates the #55 ownership filter, the
  // restorable filter, the detached-group re-dock, and the prune-to-kept-keys —
  // the logic projects.ts used to inline by importing serializeTree /
  // pruneSavedTree / withDetachedDocked / allGroups / findGroup and grabbing
  // `getState()` directly. Pure read (no mutation); single tree walk for the
  // active-key resolution.
  snapshotScopeForSwitch: (scope: string) => ScopeSwitchSnapshot;

  // Withdraw every tab of these kinds from EVERY loaded scope — what an
  // experimental flag that owns a tab does when it is switched off (see
  // `lib/experimental`'s EXPERIMENTAL_TAB_KINDS and `lib/experimentalSweep`,
  // which is the only caller). Not a user close: it neither counts as one in the
  // usage stats nor asks anything, because it is the feature being taken away,
  // not a tab being finished with. A tab living inside a detached popout is
  // deliberately left alone here — that window runs its own store and sweeps
  // itself (DetachedApp), and reaching into its subtree from the main window
  // would leave it rendering a tab whose payload had vanished.
  closeTabsOfKinds: (kinds: TabKind[]) => void;

  // persistence
  loadFromLayout: (
    layout: SavedTabEntry[],
    defaultCwd: string,
    targetScope?: string,
    groups?: SavedLayoutTree,
    opts?: LoadFromLayoutOptions,
  ) => void;
  /** Atomically hydrate an inactive scope, deduplicate a Mobile request, add its
   * desktop-built tab spec, and strictly persist the resulting target scope. */
  hydrateThenCreateInScope: (options: {
    scope: string;
    cwd: string;
    localFile: string;
    requestHash: string;
    spec: Omit<TabEntry, "key">;
  }) => Promise<TabEntry>;
  // Persist an explicit scope's tabs+layout (incl. its detached groups) to its
  // project.json. `saveLayout` is the current-scope convenience over this; the
  // detached-close host path uses it to write a parked (non-active) scope, which
  // CenterPanel's current-scope save would otherwise never touch.
  persistScope: (
    scope: string,
    localFile: string,
    options?: { strict?: boolean },
  ) => Promise<void>;
  /** Persistence variant for destructive workflows: failures are fatal instead
   *  of being treated as a non-critical autosave miss. */
  persistScopeStrict: (scope: string, localFile: string) => Promise<void>;
  saveLayout: (localFile: string) => Promise<void>;
}

/**
 * Count a tab open for the usage recap.
 *
 * Deliberately here rather than at the backend's `pty_spawn`: that fires again
 * for every resumable agent tab respawned on relaunch, so counting there would
 * report a fresh "agent tab opened" each morning for tabs opened days ago.
 * `loadFromLayout` builds restored tabs directly and never calls `addTab`, so
 * these entry points see only tabs a person actually opened — with one exception,
 * the root scope's auto-seeded 3D-blob tab, which opts out via `{ seeded: true }`.
 */
function countTabOpen(scope: string, tab: TabEntry) {
  bumpUsage(scope, METRIC.TAB_OPENED);
  const agent = agentMetricLeaf(tab);
  if (agent) bumpUsage(scope, sub(agent.prefix, agent.leaf));
}

let _keyCounter = 0;
function nextKey(prefix: string) {
  return `${prefix}-${++_keyCounter}`;
}

let _nodeCounter = 0;
function nextGroupId() {
  return `g-${++_nodeCounter}`;
}
function nextSplitId() {
  return `s-${++_nodeCounter}`;
}

// ── Pure tree helpers ───────────────────────────────────────────────────────

/** Find a group node by id anywhere in the tree. */
export function findGroup(node: LayoutNode | null, id: string): GroupNode | null {
  if (!node) return null;
  if (node.type === "group") return node.id === id ? node : null;
  for (const child of node.children) {
    const found = findGroup(child, id);
    if (found) return found;
  }
  return null;
}

/** Find a SPLIT node by id anywhere in the tree (#42: a multi-pane popout's root
 *  is a split, so its respawn detaches the whole split subtree by this id). */
export function findSplit(node: LayoutNode | null, id: string): SplitNode | null {
  if (!node || node.type !== "split") return null;
  if (node.id === id) return node;
  for (const child of node.children) {
    const found = findSplit(child, id);
    if (found) return found;
  }
  return null;
}

/** Remove the subtree rooted at `id` (a group OR split) from `node`, collapsing
 *  single-child splits that result. Returns the remaining tree (null if it
 *  empties). Used to pop a whole multi-pane popout out of the in-window layout. */
export function removeNodeById(node: LayoutNode | null, id: string): LayoutNode | null {
  if (!node) return null;
  if (node.id === id) return null;
  if (node.type === "group") return node;
  const kept: LayoutNode[] = [];
  const sizes: number[] = [];
  node.children.forEach((child, i) => {
    const r = removeNodeById(child, id);
    if (r) {
      kept.push(r);
      sizes.push(node.sizes[i] ?? 1);
    }
  });
  if (kept.length === 0) return null;
  if (kept.length === 1) return kept[0];
  const total = sizes.reduce((a, b) => a + b, 0) || 1;
  return { ...node, children: kept, sizes: sizes.map((s) => s / total) };
}

/** Find the group that currently holds `key` (and the key's index in it). */
export function findGroupOfTab(
  node: LayoutNode | null,
  key: string,
): { group: GroupNode; index: number } | null {
  if (!node) return null;
  if (node.type === "group") {
    const index = node.tabKeys.indexOf(key);
    return index >= 0 ? { group: node, index } : null;
  }
  for (const child of node.children) {
    const found = findGroupOfTab(child, key);
    if (found) return found;
  }
  return null;
}

/** All group nodes in document order. */
export function allGroups(node: LayoutNode | null): GroupNode[] {
  if (!node) return [];
  if (node.type === "group") return [node];
  return node.children.flatMap(allGroups);
}

/** Flat list of all tab keys, in stable left-to-right tree order. */
export function orderedTabKeys(node: LayoutNode | null): string[] {
  return allGroups(node).flatMap((g) => g.tabKeys);
}

/** Remove a tab key from whichever group holds it within a subtree, collapsing
 *  an emptied group / lone-child split. Returns the new (possibly null) subtree;
 *  returns the input unchanged if the key isn't present. Used by the detached
 *  subtree mutators, which (post-split) operate on a LayoutNode, not a single
 *  group. */
export function removeKeyFromTree(node: LayoutNode, key: string): LayoutNode | null {
  const found = findGroupOfTab(node, key);
  if (!found) return node;
  const removed = mapGroup(node, found.group.id, (g) => {
    const tabKeys = g.tabKeys.filter((k) => k !== key);
    return {
      ...g,
      tabKeys,
      activeKey: g.activeKey === key ? (tabKeys[0] ?? null) : g.activeKey,
    };
  });
  return collapse(removed);
}

/** Append a tab key to a subtree's FIRST group (depth-first) and activate it
 *  there. Mirrors the single-group append for a tree subtree. */
function appendKeyToTree(node: LayoutNode, key: string): LayoutNode {
  const g = firstGroup(node);
  return mapGroup(node, g.id, (grp) => ({
    ...grp,
    tabKeys: [...grp.tabKeys, key],
    activeKey: key,
  }));
}

/**
 * #42: where to place a NEW key inside a detached popout's subtree when docking a
 * tab/file INTO it from another window. `edge` carves a new pane at that side of
 * the target group (center merges into it); `index` inserts into the target
 * group's bar at that slot. Mirrors the within-popout drop semantics.
 */
export type DetachedDockTarget =
  | { groupId: string; edge: DropEdge }
  | { groupId: string; index: number };

/** Place a NEW key into a subtree at `target` (or the first group when no target,
 *  matching the legacy append). A non-center edge splits off a new pane beside the
 *  target group; center / a bar slot inserts into the target group. Falls back to
 *  an append when the target group is gone. Pure; activates the key. */
function placeKeyInTree(
  node: LayoutNode,
  key: string,
  target?: DetachedDockTarget,
): LayoutNode {
  if (!target || !findGroup(node, target.groupId)) return appendKeyToTree(node, key);
  if ("index" in target) {
    return mapGroup(node, target.groupId, (g) => {
      const at = Math.min(Math.max(target.index, 0), g.tabKeys.length);
      const tabKeys = [...g.tabKeys];
      tabKeys.splice(at, 0, key);
      return { ...g, tabKeys, activeKey: key };
    });
  }
  if (target.edge === "center") {
    return mapGroup(node, target.groupId, (g) => ({
      ...g,
      tabKeys: [...g.tabKeys, key],
      activeKey: key,
    }));
  }
  const newGroup: GroupNode = { type: "group", id: nextGroupId(), tabKeys: [key], activeKey: key };
  const dir: SplitDir = target.edge === "left" || target.edge === "right" ? "row" : "column";
  const before = target.edge === "left" || target.edge === "top";
  return insertAdjacent(node, target.groupId, newGroup, dir, before);
}

/** Move `key` out of its current group into `targetGroupId` at `index` (append
 *  when `index` is undefined), activating it there. Collapses the source group /
 *  lone-child split if the move empties it — so dragging a split pane's only tab
 *  onto the other pane's bar merges the two panes back into one. Pure; used by a
 *  detached popout to merge a tab across its own groups. Returns the input
 *  unchanged when the key isn't present, or null if removal empties the tree
 *  (can't happen for a cross-group move, which always leaves the target).
 *  No-ops (returns the input) when the target is the key's own group — that case
 *  is a within-group reorder, handled elsewhere. */
export function moveKeyInTree(
  node: LayoutNode,
  key: string,
  targetGroupId: string,
  index?: number,
): LayoutNode | null {
  const source = findGroupOfTab(node, key);
  if (!source) return node;
  if (source.group.id === targetGroupId) return node;
  const cleaned = removeKeyFromTree(node, key);
  if (!cleaned) return null;
  // The target survives the removal (it's non-empty); bail if it somehow doesn't.
  if (!findGroup(cleaned, targetGroupId)) return node;
  return mapGroup(cleaned, targetGroupId, (g) => {
    const tabKeys = [...g.tabKeys];
    const at = index == null ? tabKeys.length : Math.min(Math.max(index, 0), tabKeys.length);
    tabKeys.splice(at, 0, key);
    return { ...g, tabKeys, activeKey: key };
  });
}

/** Ids a caller may pre-mint for the nodes a split creates: the new pane's
 *  group, and the split node that wraps it when the target's parent runs the
 *  other axis (unused when the pane just joins an existing split). A detached
 *  popout mints these so the main store's copy of its tree uses the same names —
 *  see `DetachedEditPayload`'s `split`. An id already present in the tree is
 *  ignored (a fresh one is minted instead) so a bad value can't corrupt it. */
export interface SplitNodeIds {
  groupId?: string;
  splitId?: string;
}

/** Does any node in `node` carry `id`? */
function treeHasId(node: LayoutNode, id: string): boolean {
  if (node.id === id) return true;
  return node.type === "split" && node.children.some((c) => treeHasId(c, id));
}

/** Split `key` out of its group into a new pane at `edge` of `targetGroupId`,
 *  within `node`. Pure; mirrors `splitWithTab`'s algorithm but on an arbitrary
 *  subtree so the in-window layout AND a detached popout's subtree share it.
 *  Returns the new subtree, or null if the split is a no-op / invalid. */
export function splitSubtree(
  node: LayoutNode,
  key: string,
  targetGroupId: string,
  edge: DropEdge,
  ids?: SplitNodeIds,
): LayoutNode | null {
  if (edge === "center") return null; // center merges, it isn't a split
  const source = findGroupOfTab(node, key);
  const target = findGroup(node, targetGroupId);
  if (!source || !target) return null;
  // Dropping a group's only tab onto its own edge would remove then re-add it.
  if (source.group.id === targetGroupId && source.group.tabKeys.length === 1) {
    return null;
  }
  const cleaned = removeKeyFromTree(node, key);
  if (!cleaned || !findGroup(cleaned, targetGroupId)) return null;
  const groupId =
    ids?.groupId && !treeHasId(cleaned, ids.groupId) ? ids.groupId : nextGroupId();
  const splitId =
    ids?.splitId && !treeHasId(cleaned, ids.splitId) && ids.splitId !== groupId
      ? ids.splitId
      : undefined;
  const newGroup: GroupNode = {
    type: "group",
    id: groupId,
    tabKeys: [key],
    activeKey: key,
  };
  const dir: SplitDir = edge === "left" || edge === "right" ? "row" : "column";
  const before = edge === "left" || edge === "top";
  return insertAdjacent(cleaned, targetGroupId, newGroup, dir, before, splitId);
}

/** The first group reached by descending `node` (depth-first, left-to-right). */
function firstGroup(node: LayoutNode): GroupNode {
  let cur = node;
  while (cur.type === "split") cur = cur.children[0];
  return cur;
}

/**
 * Collapse a tree bottom-up:
 *  - a split with a single remaining child is replaced by that child;
 *  - empty groups inside a split are dropped (a lone empty root group is kept
 *    so an empty scope still has a root container, but callers may pass null).
 * Returns the new (possibly null) root.
 */
function collapse(node: LayoutNode | null): LayoutNode | null {
  if (!node) return null;
  if (node.type === "group") {
    return node;
  }
  // Recurse, drop emptied groups / null children.
  const children: LayoutNode[] = [];
  const sizes: number[] = [];
  node.children.forEach((child, i) => {
    const c = collapse(child);
    if (!c) return;
    if (c.type === "group" && c.tabKeys.length === 0) return; // drop empty group
    children.push(c);
    sizes.push(node.sizes[i] ?? 1);
  });
  if (children.length === 0) return null;
  if (children.length === 1) return children[0];
  // Renormalize sizes to sum to 1.
  const total = sizes.reduce((a, b) => a + b, 0) || 1;
  return {
    ...node,
    children,
    sizes: sizes.map((s) => s / total),
  };
}

/**
 * Eff #5: prune-to-keys + collapse in a SINGLE bottom-up pass, also collecting
 * every surviving group into `groupsOut` (in document order) so `writeScope`
 * doesn't re-walk the tree to refind its focus / active / fullscreen groups.
 * Replaces the former `pruneLayoutToKeys` → `collapse` → repeated
 * `findGroup`/`allGroups` walks (4–5 traversals per mutation, one pass now).
 *
 * Behaviour matches running prune-to-keys then collapse: a group keeps only keys
 * in `keep` (its active repicked to the first survivor if it was dropped), empty
 * groups are dropped inside splits, single-child splits unwrap to their child,
 * and sibling sizes renormalize. `groupsOut` only ever receives groups that
 * survive into the returned tree.
 */
function pruneCollapseCollect(
  node: LayoutNode | null,
  keep: Set<string>,
  groupsOut: GroupNode[],
): LayoutNode | null {
  if (!node) return null;
  if (node.type === "group") {
    const tabKeys = node.tabKeys.filter((k) => keep.has(k));
    const activeKey =
      node.activeKey && tabKeys.includes(node.activeKey)
        ? node.activeKey
        : (tabKeys[0] ?? null);
    const next: GroupNode = { ...node, tabKeys, activeKey };
    groupsOut.push(next);
    return next;
  }
  const children: LayoutNode[] = [];
  const sizes: number[] = [];
  node.children.forEach((child, i) => {
    // Collect each child's descendants into a scratch list first; only merge it
    // into groupsOut once we know the child survives (isn't an emptied group or
    // a fully-collapsed split) so groupsOut never lists a dropped group.
    const scratch: GroupNode[] = [];
    const c = pruneCollapseCollect(child, keep, scratch);
    if (!c) return;
    if (c.type === "group" && c.tabKeys.length === 0) return; // drop empty group
    children.push(c);
    sizes.push(node.sizes[i] ?? 1);
    for (const g of scratch) groupsOut.push(g);
  });
  if (children.length === 0) return null;
  if (children.length === 1) return children[0];
  const total = sizes.reduce((a, b) => a + b, 0) || 1;
  return { ...node, children, sizes: sizes.map((s) => s / total) };
}

/**
 * Insert `newGroup` adjacent to the group `targetId` in the given direction.
 * `before` controls whether the new group goes before (left/top) or after
 * (right/bottom) the target. The target's slot is split 50/50 with the new
 * group. Returns the new root.
 */
function insertAdjacent(
  root: LayoutNode,
  targetId: string,
  // The node to inject beside the target. Usually a fresh GroupNode, but may be
  // a whole SplitNode (e.g. re-attaching a multi-pane detached popout's subtree).
  newGroup: LayoutNode,
  dir: SplitDir,
  before: boolean,
  // Id for the split node this may have to create (see `SplitNodeIds`).
  splitId?: string,
): LayoutNode {
  // Root itself is the target → wrap into a split.
  if (root.type === "group" && root.id === targetId) {
    return makeSplit(dir, before ? [newGroup, root] : [root, newGroup], splitId);
  }

  function recurse(node: LayoutNode): LayoutNode {
    if (node.type === "group") return node;

    // Is the target a direct group child of this split?
    const childIdx = node.children.findIndex(
      (c) => c.type === "group" && c.id === targetId,
    );
    if (childIdx >= 0) {
      if (node.dir === dir) {
        // Same axis: insert the new group beside the target, splitting the
        // target's size slot 50/50.
        const children = [...node.children];
        const sizes = [...node.sizes];
        const targetSize = sizes[childIdx];
        const half = targetSize / 2;
        const insertAt = before ? childIdx : childIdx + 1;
        children.splice(insertAt, 0, newGroup);
        sizes.splice(childIdx, 1, half, half); // replace target slot with two halves
        // After splice the order of the two halves matches children order at
        // childIdx / childIdx+1; ensure the half list aligns with insertion.
        // We replaced 1 size with [half, half]; if `before`, the new group is
        // the first half — already correct since both halves are equal.
        return { ...node, children, sizes };
      }
      // Different axis: wrap just the target child in a nested split.
      const children = [...node.children];
      const target = children[childIdx] as GroupNode;
      children[childIdx] = makeSplit(
        dir,
        before ? [newGroup, target] : [target, newGroup],
        splitId,
      );
      return { ...node, children };
    }

    // Recurse into split children.
    return { ...node, children: node.children.map(recurse) };
  }

  return recurse(root);
}

function makeSplit(dir: SplitDir, children: LayoutNode[], id?: string): SplitNode {
  const n = children.length;
  return {
    type: "split",
    id: id ?? nextSplitId(),
    dir,
    children,
    sizes: children.map(() => 1 / n),
  };
}

/** Apply a resize to the divider between child i and i+1 of `splitId`. Exported
 *  so a detached popout's subtree can be resized through the same pure path. */
export function applyResize(
  node: LayoutNode,
  splitId: string,
  dividerIndex: number,
  fraction: number,
): LayoutNode {
  if (node.type === "group") return node;
  if (node.id === splitId) {
    if (dividerIndex < 0 || dividerIndex >= node.children.length - 1) {
      return node;
    }
    const sizes = [...node.sizes];
    const pair = sizes[dividerIndex] + sizes[dividerIndex + 1];
    const min = 0.05;
    const left = Math.min(Math.max(fraction, min), pair - min);
    sizes[dividerIndex] = left;
    sizes[dividerIndex + 1] = pair - left;
    return { ...node, sizes };
  }
  return { ...node, children: node.children.map((c) => applyResize(c, splitId, dividerIndex, fraction)) };
}

/**
 * Pure divider-drag math shared by the main window's SplitView and the detached
 * popout (the two used to carry verbatim copies): given the pointer position
 * `pos` within a split container of extent `total` (both along the split axis,
 * px), the new size FRACTION of the child left of divider `dividerIndex`. The
 * pair sum is preserved by the caller (`applyResize` shape); neither side of the
 * dragged pair may shrink below `minPx` — when the pair is too small to fit both
 * minimums it splits evenly.
 */
export function dividerFraction(
  node: SplitNode,
  dividerIndex: number,
  pos: number,
  total: number,
  minPx: number,
): number {
  // Fraction of the whole container up to the pointer.
  const wholeFraction = Math.min(Math.max(pos / total, 0), 1);
  // Sum of sizes before this divider's left child.
  let before = 0;
  for (let i = 0; i < dividerIndex; i++) before += node.sizes[i];
  const pair = node.sizes[dividerIndex] + node.sizes[dividerIndex + 1];
  // Desired size of the left child of the pair = pointer fraction minus the
  // space taken by everything before the pair.
  const leftSize = wholeFraction - before;
  const minFrac = Math.min(minPx / total, pair / 2);
  return Math.min(Math.max(leftSize, minFrac), pair - minFrac);
}

/** Every node id in a tree — groups AND splits. Used by a popout to mint split
 *  ids that cannot collide with what it already renders (#227). */
export function allNodeIds(node: LayoutNode | null): string[] {
  if (!node) return [];
  if (node.type === "group") return [node.id];
  return [node.id, ...node.children.flatMap(allNodeIds)];
}

/** Deep-clone a layout tree, regenerating all group/split ids. */
function regenIds(node: LayoutNode): LayoutNode {
  if (node.type === "group") {
    return { ...node, id: nextGroupId() };
  }
  return {
    ...node,
    id: nextSplitId(),
    children: node.children.map(regenIds),
  };
}

// ── Scope persistence helpers ───────────────────────────────────────────────

/** Persist a scope's tabs+layout+focus into the per-scope maps, mirroring the
 *  flat shortcuts when the scope is the current one. */
function writeScope(
  s: TabsStore,
  scope: string,
  tabs: TabEntry[],
  layout: LayoutNode | null,
  focusedGroupId: string | null,
): Partial<TabsStore> {
  // ── #55 invariant enforcement ───────────────────────────────────────────────
  // 1. Stamp/repair the owning scope on every tab and DROP any tab that already
  //    carries a different scope (a stray cross-project payload). This makes the
  //    project→tab binding explicit, so a leaked tab can never be written under
  //    the wrong scope.
  const ownedTabs = tabs
    .filter((t) => t.scope == null || t.scope === scope)
    .map((t) => (t.scope === scope ? t : { ...t, scope }));
  const ownedKeys = new Set(ownedTabs.map((t) => t.key));
  tabs = ownedTabs;

  // 2. Prune orphan layout keys AND collapse emptied groups/splits in one pass,
  //    collecting the surviving groups so the focus/active/fullscreen resolution
  //    below is index lookups against that list rather than fresh tree walks
  //    (Eff #5). `groups` is in document order, matching `allGroups`.
  const groups: GroupNode[] = [];
  let collapsed = pruneCollapseCollect(layout, ownedKeys, groups);
  // A lone empty root group means the scope has no tabs → drop to null so an
  // emptied scope has no layout (matches an uninitialized scope).
  if (collapsed && collapsed.type === "group" && collapsed.tabKeys.length === 0) {
    collapsed = null;
    groups.length = 0;
  }
  const byId = new Map(groups.map((g) => [g.id, g] as const));
  // If the focused group vanished (collapsed away), refocus the first group.
  let focus = focusedGroupId;
  if (!focus || !byId.has(focus)) {
    focus = groups[0]?.id ?? null;
  }
  const activeKey = focus ? (byId.get(focus)?.activeKey ?? null) : null;
  const isCurrent = s.scope === scope;
  // If the fullscreened group collapsed away (e.g. its subwindow was closed),
  // exit fullscreen so CenterPanel doesn't try to render a vanished group.
  const fullscreenGroupId =
    isCurrent && s.fullscreenGroupId && !byId.has(s.fullscreenGroupId)
      ? null
      : s.fullscreenGroupId;
  return {
    tabsByScope: { ...s.tabsByScope, [scope]: tabs },
    layoutByScope: { ...s.layoutByScope, [scope]: collapsed },
    focusedGroupByScope: { ...s.focusedGroupByScope, [scope]: focus },
    ...(isCurrent
      ? { tabs, layout: collapsed, focusedGroupId: focus, activeKey, fullscreenGroupId }
      : {}),
  };
}

/** Convenience accessor for a scope's mutable state. */
function scopeState(s: TabsStore, scope: string) {
  return {
    tabs: s.tabsByScope[scope] ?? [],
    layout: s.layoutByScope[scope] ?? null,
    focusedGroupId: s.focusedGroupByScope[scope] ?? null,
  };
}

/** Convenience accessor for the current scope's mutable state. */
function currentScopeState(s: TabsStore) {
  return scopeState(s, s.scope);
}

/**
 * The scope holding tab `key`: the active one when it is there, else whichever
 * scope's list carries it. The root console's tabs are the case that needs it —
 * root is not the active scope while the console floats over a project, so a
 * viewer there writing its scroll/zoom or a Files tab its folder through a
 * current-scope action wrote nothing. Keys are minted store-wide, so at most one
 * scope matches; an unknown key answers the active scope (the old no-op).
 */
function scopeOfTab(s: Pick<TabsStore, "scope" | "tabs" | "tabsByScope">, key: string): string {
  if ((s.tabs ?? []).some((t) => t.key === key)) return s.scope;
  for (const [scope, tabs] of Object.entries(s.tabsByScope ?? {})) {
    if (tabs.some((t) => t.key === key)) return scope;
  }
  return s.scope;
}

/** Tab `key` wherever it lives — the read side of {@link scopeOfTab}, for the
 *  viewers that look their own tab up by key (a root-console viewer is not in
 *  `tabs`, the active scope's list). */
export function findTabByKey(
  s: Pick<TabsStore, "scope" | "tabs" | "tabsByScope">,
  key: string,
): TabEntry | undefined {
  const byKey = (t: TabEntry) => t.key === key;
  return (
    (s.tabs ?? []).find(byKey) ??
    Object.values(s.tabsByScope ?? {}).flatMap((tabs) => tabs.filter(byKey))[0]
  );
}

// ── Tree (de)serialization ──────────────────────────────────────────────────

export function serializeTree(node: LayoutNode | null): SavedLayoutTree | null {
  if (!node) return null;
  if (node.type === "group") {
    return {
      type: "group",
      tabKeys: [...node.tabKeys],
      activeKey: node.activeKey,
      // Persist the per-subwindow file viewer (open flag + width + browsed
      // folder) so it comes back on restart.
      ...(node.filesOpen ? { filesOpen: true } : {}),
      ...(node.filesWidth != null ? { filesWidth: node.filesWidth } : {}),
      ...(node.filesFolder ? { filesFolder: node.filesFolder } : {}),
    };
  }
  return {
    type: "split",
    dir: node.dir,
    sizes: [...node.sizes],
    children: node.children
      .map(serializeTree)
      .filter((c): c is SavedLayoutTree => c != null),
  };
}

/** #42: a group restored from the saved tree that was tagged `detached`. */
export interface RespawnTarget {
  id: string; // the FRESH group id minted during deserialize
  bounds?: WindowBounds;
  // The popout's persisted per-window zoom (see DetachedGroup.zoom), carried so
  // the respawn re-detaches it at the zoom it was left at. Undefined = 100%.
  zoom?: number;
}

/**
 * Rebuild a layout tree from a serialized tree, remapping saved tab keys to the
 * freshly-minted keys. Drops keys not in `keyMap`. Returns null if nothing left.
 *
 * #42: when a group node is tagged `detached`, its freshly-minted id (+ bounds)
 * is pushed onto `detachedOut` so the caller can re-open it as a floating popout
 * after the layout is live (loadFromLayout). The node is still built into the
 * tree (docked) so its tabs mount and spawn their PTYs before the re-detach.
 *
 * A `hidden`-tagged node works the same way but pushes its fresh id onto
 * `hiddenOut`; the caller then strips it from the built tree into
 * `hiddenGroupsByScope` (see loadFromLayout).
 */
function deserializeTree(
  saved: SavedLayoutTree,
  keyMap: Map<string, string>,
  detachedOut?: RespawnTarget[],
  hiddenOut?: string[],
): LayoutNode | null {
  if (saved.type === "group") {
    const tabKeys = saved.tabKeys
      .map((k) => keyMap.get(k))
      .filter((k): k is string => k != null);
    if (tabKeys.length === 0) return null;
    const activeKey =
      (saved.activeKey != null ? keyMap.get(saved.activeKey) : null) ??
      tabKeys[0] ??
      null;
    const id = nextGroupId();
    if (saved.detached && detachedOut) {
      detachedOut.push({ id, bounds: saved.bounds, zoom: saved.zoom });
    }
    if (saved.hidden && hiddenOut) {
      hiddenOut.push(id);
    }
    return {
      type: "group",
      id,
      tabKeys,
      activeKey,
      ...(saved.filesOpen ? { filesOpen: true } : {}),
      ...(saved.filesWidth != null ? { filesWidth: saved.filesWidth } : {}),
      ...(saved.filesFolder ? { filesFolder: saved.filesFolder } : {}),
    };
  }
  const children = saved.children
    .map((c) => deserializeTree(c, keyMap, detachedOut, hiddenOut))
    .filter((c): c is LayoutNode => c != null);
  if (children.length === 0) return null;
  if (children.length === 1) {
    // Collapsed to a single child. If this split was a detached (multi-pane)
    // popout, the survivor inherits the respawn so the popout still re-opens.
    if (saved.detached && detachedOut) {
      detachedOut.push({ id: children[0].id, bounds: saved.bounds, zoom: saved.zoom });
    }
    // Likewise inherit a hidden tag so the survivor is parked, not docked live.
    if (saved.hidden && hiddenOut) {
      hiddenOut.push(children[0].id);
    }
    return children[0];
  }
  // Align sizes to surviving children where possible, else even split.
  let sizes: number[];
  if (saved.sizes.length === children.length) {
    const total = saved.sizes.reduce((a, b) => a + b, 0) || 1;
    sizes = saved.sizes.map((x) => x / total);
  } else {
    sizes = children.map(() => 1 / children.length);
  }
  const id = nextSplitId();
  // #42: a tagged split is a multi-pane popout — collect ONE respawn target for
  // the whole subtree (its children aren't individually tagged) so the respawn
  // path re-detaches the entire split as a single floating window.
  if (saved.detached && detachedOut) {
    detachedOut.push({ id, bounds: saved.bounds, zoom: saved.zoom });
  }
  // A hidden split is parked whole by its root id (same one-target logic).
  if (saved.hidden && hiddenOut) {
    hiddenOut.push(id);
  }
  return { type: "split", id, dir: saved.dir, children, sizes };
}

// ── Store ────────────────────────────────────────────────────────────────────

export const useTabsStore = create<TabsStore>((set, get) => ({
  scope: "root",
  tabsByScope: {},
  workspaceVersionByScope: {},
  layoutByScope: {},
  focusedGroupByScope: {},
  detachedGroupsByScope: {},
  hiddenGroupsByScope: {},
  pendingRespawnByScope: {},
  tabs: [],
  layout: null,
  focusedGroupId: null,
  activeKey: null,
  fullscreenGroupId: null,

  toggleFullscreen: (groupId) => {
    set((s) => ({
      fullscreenGroupId: s.fullscreenGroupId === groupId ? null : groupId,
    }));
  },

  setScope: (scope) => {
    // Leaving a `box:<id>` scope flushes its layout: box scopes have no other
    // switch-time save (a project switch writes through `switch_project_runtime`,
    // the root through `projects.setActive`), while the scope change cancels
    // CenterPanel's 300 ms persist debounce — so a tab opened/closed/moved just
    // before leaving the box was never written. Boxes persist under their own id
    // in the state dir with no project.json export, hence localFile "".
    // Scope-addressed and fire-and-forget, like the root flush.
    const prev = get().scope;
    if (prev !== scope && prev.startsWith(BOX_SCOPE_PREFIX)) {
      void get().persistScope(prev, "").catch(() => {});
    }
    // #42: popouts follow the SCOPE, not the project. A popout is an OS window
    // of its own, so nothing about a scope change hides it — the backend parks
    // the outgoing scope's popouts and un-parks the incoming scope's. That park
    // used to ride on `switch_project_runtime` alone, which entering a `box:<id>`
    // scope never performs (`openBox` only sets the scope), so a project's popout
    // kept floating over the box's tabs. Every scope change funnels through here,
    // so this is the one call that covers all of them. Never from a popout's own
    // heap (`getDetachedWindowContext`): its store mirrors ONE group and its idea
    // of "the scope" must not drive which windows the main window shows.
    //
    // Then the incoming scope's popouts are asked for (after the sync, so a
    // Wayland retire of the same label is already known to the backend, which
    // waits it out) — unless the scope moved on meanwhile: its own setScope
    // asks for its own.
    if (prev !== scope && !getDetachedWindowContext()) {
      void invoke("sync_detached_scope", { scope })
        .catch(() => {})
        .then(() => {
          if (get().scope === scope) get().respawnDetachedForScope(scope);
        });
      // A PDF presented fullscreen belongs to a tab of the scope just left;
      // unlike a popout it is closed, not parked (see `closePdfPresent`).
      void closePdfPresentWindows();
    }
    set((s) => {
      const tabs = s.tabsByScope[scope] ?? [];
      const layout = s.layoutByScope[scope] ?? null;
      let focus = s.focusedGroupByScope[scope] ?? null;
      if (!focus || !findGroup(layout, focus)) {
        focus = allGroups(layout)[0]?.id ?? null;
      }
      const activeKey = focus
        ? (findGroup(layout, focus)?.activeKey ?? null)
        : null;
      // Fullscreen is scope-local (its group id belongs to the old scope's tree);
      // drop it on a scope change so a switch never leaves a stale group fullscreen.
      const fullscreenGroupId =
        s.fullscreenGroupId && findGroup(layout, s.fullscreenGroupId)
          ? s.fullscreenGroupId
          : null;
      return { scope, tabs, layout, focusedGroupId: focus, activeKey, fullscreenGroupId };
    });
  },

  focusGroup: (groupId) => get().focusGroupInScope(get().scope, groupId),

  focusGroupInScope: (scope, groupId) => {
    set((s) => {
      const { tabs, layout } = scopeState(s, scope);
      if (!findGroup(layout, groupId)) return {};
      return writeScope(s, scope, tabs, layout, groupId);
    });
  },

  setActive: (key) => {
    // Popout heap (#231): the layout lives in the main window — stream the
    // activation there. The popout's strip re-renders from the reseed.
    const ctx = getDetachedWindowContext();
    if (ctx) {
      ctx.pushEdit({ kind: "activate", key });
      return;
    }
    // A tab of another scope (the root console's, while a project is on screen)
    // is revealed in its own layout; the active scope's focus stays put.
    const owner = scopeOfTab(get(), key);
    if (owner !== get().scope) {
      get().revealTabInScope(owner, key);
      return;
    }
    set((s) => {
      const { tabs, layout } = currentScopeState(s);
      const found = findGroupOfTab(layout, key);
      if (!found || !layout) return {};
      // Set the active tab within its group and focus that group.
      const next = mapGroup(layout, found.group.id, (g) => ({
        ...g,
        activeKey: key,
      }));
      return writeScope(s, s.scope, tabs, next, found.group.id);
    });
  },

  setGroupActive: (groupId, key) => get().setGroupActiveInScope(get().scope, groupId, key),

  setGroupActiveInScope: (scope, groupId, key) => {
    set((s) => {
      const { tabs, layout } = scopeState(s, scope);
      const group = findGroup(layout, groupId);
      if (!group || !group.tabKeys.includes(key) || !layout) return {};
      const next = mapGroup(layout, groupId, (g) => ({ ...g, activeKey: key }));
      return writeScope(s, scope, tabs, next, groupId);
    });
  },

  revealTabInScope: (scope, key) => {
    const layout = get().layoutByScope[scope] ?? null;
    const found = findGroupOfTab(layout, key);
    if (!found || !layout) return false;
    set((s) => {
      const tabs = s.tabsByScope[scope] ?? [];
      const cur = s.layoutByScope[scope] ?? null;
      if (!cur) return {};
      const next = mapGroup(cur, found.group.id, (g) => ({ ...g, activeKey: key }));
      const base = writeScope(s, scope, tabs, next, found.group.id);
      // A fullscreened OTHER subwindow would swallow the jump: the tab is now the
      // active one in a group nothing is rendering, so the click would look like a
      // no-op. Leaving fullscreen shows the tab that was asked for, which is the
      // whole request.
      return s.scope === scope && s.fullscreenGroupId && s.fullscreenGroupId !== found.group.id
        ? { ...base, fullscreenGroupId: null }
        : base;
    });
    return true;
  },

  // The current-scope variant of `addTabToScope`. One implementation: the two
  // were near-identical copies and had already drifted (only this one threaded
  // `seeded` through). In a popout the "current scope" is the popout's own
  // (`ctx.scope`): its heap's `scope` never leaves the store default `"root"`,
  // so every plain `addTab` there — a Ctrl+clicked `\input`, a followed link —
  // used to be shipped as an add-to-ROOT, one fresh copy per click.
  addTab: (tab, opts) =>
    get().addTabToScope(getDetachedWindowContext()?.scope ?? get().scope, tab, opts),

  addTabToScope: (scope, tab, opts) => {
    // Popout heap (#231): this store owns no layout, so a tab minted here would
    // sit in a phantom root group nobody renders. Ship the resolved payload to
    // the main window instead — it mints the key, owns the PTY and reseeds the
    // popout — the same path the popout's own "+" menu takes. A tab bound for
    // ANOTHER scope (an install command's root tab) is added to that scope's
    // layout in the main window. The returned entry is a placeholder: its key
    // is not a real tab, so a follow-up `setActive` on it is a clean no-op.
    const ctx = getDetachedWindowContext();
    if (ctx) {
      if (scope === ctx.scope) {
        ctx.pushEdit({ kind: "add", tab, targetGroupId: ctx.targetGroupId() });
      } else {
        ctx.pushEdit({ kind: "addToScope", scope, tab });
      }
      return { ...tab, key: nextKey(`pending-${tab.kind}`), scope };
    }
    const key = nextKey(tab.kind);
    // Spread first so a stray `key` on the payload can't shadow the minted one.
    const entry: TabEntry = {
      ...withTmuxSession(withRunHostDefault(scope, tab), scope),
      key,
      scope,
      launchedAt: Date.now(),
    };
    if (!opts?.seeded) countTabOpen(scope, entry);
    set((s) => {
      const tabs = s.tabsByScope[scope] ?? [];
      const layout = s.layoutByScope[scope] ?? null;
      const focusedGroupId = s.focusedGroupByScope[scope] ?? null;
      const nextTabs = [...tabs, entry];

      // No layout yet → create a root group containing this tab.
      if (!layout) {
        const root: GroupNode = {
          type: "group",
          id: nextGroupId(),
          tabKeys: [key],
          activeKey: key,
        };
        return writeScope(s, scope, nextTabs, root, root.id);
      }

      // Add into that scope's focused group (fall back to its first group).
      const target =
        (focusedGroupId && findGroup(layout, focusedGroupId)) ||
        allGroups(layout)[0];
      const next = mapGroup(layout, target.id, (g) => {
        const at = opts?.besideActive && g.activeKey ? g.tabKeys.indexOf(g.activeKey) : -1;
        const tabKeys = [...g.tabKeys];
        tabKeys.splice(at >= 0 ? at + 1 : tabKeys.length, 0, key);
        return { ...g, tabKeys, activeKey: key };
      });
      return writeScope(s, scope, nextTabs, next, target.id);
    });
    return entry;
  },

  duplicateTab: (key, overrides) => {
    const { tabs, layout } = currentScopeState(get());
    const source = tabs.find((t) => t.key === key);
    if (!source) return null;
    const found = findGroupOfTab(layout, key);
    if (!found) return null;
    const nextKeyValue = nextKey(source.kind);
    const entry: TabEntry = {
      ...withTmuxSession(
        withRunHostDefault(get().scope, { ...duplicateSpec(source), ...overrides }),
        get().scope,
      ),
      key: nextKeyValue,
      launchedAt: Date.now(),
    };
    countTabOpen(get().scope, entry);
    set((s) => {
      const { tabs: cur, layout: curLayout } = currentScopeState(s);
      // Re-resolve inside the setter: the group (and the source's index in it)
      // may have moved between the read above and this write.
      const at = curLayout ? findGroupOfTab(curLayout, key) : null;
      if (!at || !curLayout) return {};
      const next = mapGroup(curLayout, at.group.id, (g) => {
        const i = g.tabKeys.indexOf(key);
        const tabKeys = [...g.tabKeys];
        tabKeys.splice(i + 1, 0, nextKeyValue);
        return { ...g, tabKeys, activeKey: nextKeyValue };
      });
      return writeScope(s, s.scope, [...cur, entry], next, at.group.id);
    });
    return entry;
  },

  ensureTab: (tab, matches, opts) => {
    const existing = get().tabs.find(matches);
    if (existing) {
      get().setActive(existing.key);
      return existing;
    }
    return get().addTab(tab, opts);
  },

  renameTab: (key, label) => {
    const nextLabel = label.trim();
    if (!nextLabel) return;
    const ctx = getDetachedWindowContext();
    if (ctx) {
      ctx.pushEdit({ kind: "rename", key, label: nextLabel });
      return;
    }
    const owner = scopeOfTab(get(), key);
    if (owner !== get().scope) {
      get().renameTabInScope(owner, key, nextLabel);
      return;
    }
    set((s) => {
      const { tabs, layout, focusedGroupId } = currentScopeState(s);
      const nextTabs = tabs.map((t) =>
        t.key === key ? { ...t, label: nextLabel } : t,
      );
      return writeScope(s, s.scope, nextTabs, layout, focusedGroupId);
    });
  },

  renameTabInScope: (scope, key, label) => {
    const nextLabel = label.trim();
    if (!nextLabel) return;
    if (scope === get().scope) {
      get().renameTab(key, nextLabel);
      return;
    }
    set((s) => {
      const tabs = s.tabsByScope[scope];
      if (!tabs?.some((t) => t.key === key)) return {};
      return writeScope(
        s,
        scope,
        tabs.map((t) => (t.key === key ? { ...t, label: nextLabel } : t)),
        s.layoutByScope[scope] ?? null,
        s.focusedGroupByScope[scope] ?? null,
      );
    });
  },

  setTabColor: (key, color) => {
    const next = isTabColor(color) ? color : undefined;
    const ctx = getDetachedWindowContext();
    if (ctx) {
      ctx.pushEdit({ kind: "setColor", key, color: next });
      return;
    }
    const owner = scopeOfTab(get(), key);
    if (owner !== get().scope) {
      get().setTabColorInScope(owner, key, color);
      return;
    }
    set((s) => {
      const { tabs, layout, focusedGroupId } = currentScopeState(s);
      if (!tabs.some((t) => t.key === key && t.color !== next)) return {};
      return writeScope(
        s,
        s.scope,
        tabs.map((t) => (t.key === key ? { ...t, color: next } : t)),
        layout,
        focusedGroupId,
      );
    });
  },

  setTabStack: (key, stack) => {
    const next = normalizeStackName(stack);
    const ctx = getDetachedWindowContext();
    if (ctx) {
      ctx.pushEdit({ kind: "setStack", key, stack: next });
      return;
    }
    const owner = scopeOfTab(get(), key);
    set((s) => {
      const { tabs, layout, focusedGroupId } = scopeState(s, owner);
      if (!tabs.some((t) => t.key === key && t.stack !== next)) return {};
      const nextTabs = tabs.map((t) => (t.key === key ? { ...t, stack: next } : t));
      let nextLayout = layout;
      const home = next ? findGroupOfTab(layout, key) : null;
      if (next && home && layout) {
        const stackOf = (k: string) => nextTabs.find((t) => t.key === k)?.stack;
        const order = stackJoinOrder(home.group.tabKeys, key, next, stackOf);
        if (order) nextLayout = mapGroup(layout, home.group.id, (g) => ({ ...g, tabKeys: order }));
      }
      return writeScope(s, owner, nextTabs, nextLayout, focusedGroupId);
    });
  },

  setTabMark: (key, mark) => {
    const next = isTabMark(mark) ? mark : undefined;
    const ctx = getDetachedWindowContext();
    if (ctx) {
      ctx.pushEdit({ kind: "setMark", key, mark: next });
      return;
    }
    const owner = scopeOfTab(get(), key);
    set((s) => {
      const { tabs, layout, focusedGroupId } = scopeState(s, owner);
      if (!tabs.some((t) => t.key === key && t.mark !== next)) return {};
      return writeScope(
        s,
        owner,
        tabs.map((t) => (t.key === key ? { ...t, mark: next } : t)),
        layout,
        focusedGroupId,
      );
    });
  },

  setTabTodo: (key, todoId) => {
    const next = normalizeTodoId(todoId);
    const ctx = getDetachedWindowContext();
    if (ctx) {
      ctx.pushEdit({ kind: "setTodo", key, todoId: next });
      return;
    }
    const owner = scopeOfTab(get(), key);
    set((s) => {
      const { tabs, layout, focusedGroupId } = scopeState(s, owner);
      if (!tabs.some((t) => t.key === key && t.todoId !== next)) return {};
      return writeScope(
        s,
        owner,
        tabs.map((t) => (t.key === key ? { ...t, todoId: next } : t)),
        layout,
        focusedGroupId,
      );
    });
  },

  setTabColorInScope: (scope, key, color) => {
    if (scope === get().scope) {
      get().setTabColor(key, color);
      return;
    }
    const next = isTabColor(color) ? color : undefined;
    set((s) => {
      const tabs = s.tabsByScope[scope];
      if (!tabs?.some((t) => t.key === key && t.color !== next)) return {};
      return writeScope(
        s,
        scope,
        tabs.map((t) => (t.key === key ? { ...t, color: next } : t)),
        s.layoutByScope[scope] ?? null,
        s.focusedGroupByScope[scope] ?? null,
      );
    });
  },

  resumeHostSession: (scope, key) => {
    set((s) => {
      const tabs = s.tabsByScope[scope];
      if (!tabs?.some((t) => t.key === key && t.hostSessionPaused)) return {};
      return writeScope(
        s,
        scope,
        tabs.map((t) => (t.key === key ? { ...t, hostSessionPaused: false } : t)),
        s.layoutByScope[scope] ?? null,
        s.focusedGroupByScope[scope] ?? null,
      );
    });
  },

  setAutoContinueInScope: (scope, key, on) => {
    set((s) => {
      const tabs = s.tabsByScope[scope];
      const tab = tabs?.find((t) => t.key === key);
      if (!tabs || !tab || !!tab.autoContinue === on) return {};
      return writeScope(
        s,
        scope,
        // `undefined` rather than `false` when off: the flag is absent on every
        // tab that never had it, and writing an explicit false would put a field
        // on disk for the default.
        tabs.map((t) => (t.key === key ? { ...t, autoContinue: on || undefined } : t)),
        s.layoutByScope[scope] ?? null,
        s.focusedGroupByScope[scope] ?? null,
      );
    });
  },

  reorderTabInScope: (scope, key, anchorKey, place) => {
    if (key === anchorKey) return;
    set((s) => {
      const tabs = s.tabsByScope[scope];
      if (!tabs?.some((t) => t.key === key) || !tabs.some((t) => t.key === anchorKey)) return {};
      // The same splice on both orders: pull the tab out, then drop it beside
      // the anchor as it sits in the shortened list. Doing it that way (rather
      // than computing an index up front) means the two lists — the flat tabs
      // array and the group's tabKeys, which hold different tabs — land the tab
      // on the same side of the anchor without sharing an index space.
      const place1 = <T>(items: T[], keyOf: (item: T) => string): T[] => {
        const from = items.findIndex((item) => keyOf(item) === key);
        if (from < 0) return items;
        const next = [...items];
        const [moved] = next.splice(from, 1);
        const at = next.findIndex((item) => keyOf(item) === anchorKey);
        if (at < 0) return items;
        next.splice(place === "before" ? at : at + 1, 0, moved);
        return next;
      };
      const nextTabs = place1(tabs, (t) => t.key);
      if (nextTabs === tabs) return {};
      // The tab bar only follows when both tabs are in one group: a cross-group
      // drop has no slot to express, so the list reorders and the layout is left
      // exactly as the user arranged it.
      const layout = s.layoutByScope[scope] ?? null;
      const from = findGroupOfTab(layout, key);
      const to = findGroupOfTab(layout, anchorKey);
      const nextLayout =
        layout && from && to && from.group.id === to.group.id
          ? mapGroup(layout, from.group.id, (g) => ({
              ...g,
              tabKeys: place1(g.tabKeys, (k) => k),
            }))
          : layout;
      return writeScope(s, scope, nextTabs, nextLayout, s.focusedGroupByScope[scope] ?? null);
    });
  },

  detachScopeFromRemote: (scope, oldDir, newDir) => {
    set((s) => {
      const tabs = s.tabsByScope[scope] ?? [];
      if (!tabs.length || !oldDir || !newDir || oldDir === newDir) return {};
      let changed = false;
      const nextTabs = tabs.map((t) => {
        const wasRemoteLoc = t.location === "remote";
        const underOld = t.cwd === oldDir || t.cwd.startsWith(`${oldDir}/`);
        if (!wasRemoteLoc && !underOld) return t;
        changed = true;
        return {
          ...t,
          // A tab that ran ON THE HOST has a cwd in the host's filesystem, which means
          // nothing here — it can only land in the promoted mirror root.
          cwd: underOld ? `${newDir}${t.cwd.slice(oldDir.length)}` : newDir,
          // …and it must stop claiming to run on a host this project no longer has.
          location: wasRemoteLoc ? undefined : t.location,
        };
      });
      if (!changed) return {};
      const layout = s.layoutByScope[scope] ?? null;
      const focused = s.focusedGroupByScope[scope] ?? null;
      return writeScope(s, scope, nextTabs, layout, focused);
    });
  },

  retargetTabs: (oldAbs, newAbs) => {
    set((s) => {
      const scope = s.scope;
      const tabs = s.tabsByScope[scope] ?? [];
      const oldBase = oldAbs.slice(oldAbs.lastIndexOf("/") + 1);
      const newBase = newAbs.slice(newAbs.lastIndexOf("/") + 1);
      let changed = false;
      const nextTabs = tabs.map((t) => {
        if (t.kind !== "embed" || !t.embedPath) return t;
        if (t.embedPath === oldAbs) {
          changed = true;
          // Refresh the label to the new basename only when it still shows the
          // old one — don't clobber a tab the user renamed.
          const label = t.label === oldBase ? newBase : t.label;
          return { ...t, embedPath: newAbs, label };
        }
        if (t.embedPath.startsWith(`${oldAbs}/`)) {
          // A tab under a renamed/moved directory: prefix-swap, keep the label.
          changed = true;
          return { ...t, embedPath: `${newAbs}${t.embedPath.slice(oldAbs.length)}` };
        }
        return t;
      });
      if (!changed) return {};
      const patch: Partial<TabsStore> = {
        tabsByScope: { ...s.tabsByScope, [scope]: nextTabs },
      };
      // Keep the flat mirror in sync so the active scope's CenterPanel re-renders.
      patch.tabs = nextTabs;
      return patch;
    });
  },

  removeTab: (key) => {
    // Popout heap (#231): route through the popout's own close (its × path), so
    // closing the last tab closes the window exactly as the button does.
    const ctx = getDetachedWindowContext();
    if (ctx) {
      ctx.closeTab(key);
      return;
    }
    // Another scope's tab (a root-console viewer closing itself) closes there.
    const owner = scopeOfTab(get(), key);
    if (owner !== get().scope) {
      get().removeTabInScope(owner, key);
      return;
    }
    // Discard any session-only link routes that pointed FROM this tab (#50).
    useLinkRoutingStore.getState().purgeForTab(key);
    bumpUsage(get().scope, METRIC.TAB_CLOSED);
    // The PTY is gone; drop its half-typed-prompt state so a recycled id can
    // never inherit it.
    forgetPty(`${get().scope}:${key}`);
    forgetPromptTrail(`${get().scope}:${key}`);
    set((s) => {
      const { tabs, layout, focusedGroupId } = currentScopeState(s);
      const nextTabs = tabs.filter((t) => t.key !== key);
      if (!layout) return writeScope(s, s.scope, nextTabs, null, focusedGroupId);

      const found = findGroupOfTab(layout, key);
      if (!found) {
        return writeScope(s, s.scope, nextTabs, layout, focusedGroupId);
      }
      // Drop the key from its group, repick that group's active tab.
      const next = mapGroup(layout, found.group.id, (g) => {
        const tabKeys = g.tabKeys.filter((k) => k !== key);
        const activeKey =
          g.activeKey === key
            ? (tabKeys[Math.min(found.index, tabKeys.length - 1)] ?? null)
            : g.activeKey;
        return { ...g, tabKeys, activeKey };
      });
      // collapse() in writeScope drops the emptied group + lone splits.
      return writeScope(s, s.scope, nextTabs, next, focusedGroupId);
    });
  },

  removeTabInScope: (scope, key) => {
    // A tab that lives in a popout is not in this scope's in-window layout at
    // all, and its pane is mounted in the detached window — so it is closed the
    // way `closeDetachedGroup` closes one, PTY kill included, whether or not
    // the scope is the active one.
    const detached = (get().detachedGroupsByScope[scope] ?? []).find((entry) =>
      orderedTabKeys(entry.subtree).includes(key),
    );
    if (!detached && scope === get().scope) {
      get().removeTab(key);
      return;
    }
    if (!(get().tabsByScope[scope] ?? []).some((t) => t.key === key)) return;
    if (detached) {
      const tab = (get().tabsByScope[scope] ?? []).find((t) => t.key === key);
      if (tab && isPtyTabKind(tab.kind)) {
        invoke("pty_kill", { id: `${scope}:${key}` }).catch(() => {});
      }
    }
    useLinkRoutingStore.getState().purgeForTab(key);
    bumpUsage(scope, METRIC.TAB_CLOSED);
    forgetPty(`${scope}:${key}`);
    forgetPromptTrail(`${scope}:${key}`);
    const emptiesPopout =
      !!detached && orderedTabKeys(detached.subtree).length === 1;
    set((s) => {
      const tabs = s.tabsByScope[scope] ?? [];
      const nextTabs = tabs.filter((t) => t.key !== key);
      const layout = s.layoutByScope[scope] ?? null;
      const base = writeScope(
        s,
        scope,
        nextTabs,
        layout ? removeKeyFromTree(layout, key) : null,
        s.focusedGroupByScope[scope] ?? null,
      );
      if (!detached) return base;
      // The popout keeps its window while tabs remain in it; emptied, its
      // record goes and the OS window is closed below.
      const remaining = removeKeyFromTree(detached.subtree, key);
      const entries = (s.detachedGroupsByScope[scope] ?? []).flatMap((entry) =>
        entry.id !== detached.id
          ? [entry]
          : remaining
            ? [{ ...entry, subtree: remaining }]
            : [],
      );
      return {
        ...base,
        detachedGroupsByScope: { ...s.detachedGroupsByScope, [scope]: entries },
      };
    });
    // After the record is gone, like `closeDetachedGroup`: a standing record at
    // the moment the backend reports the death reads as a crash to dock back.
    if (emptiesPopout && detached) {
      invoke("attach_subwindow", { registryId: detached.label }).catch(() => {});
    }
  },

  closeGroup: (groupId) => {
    set((s) => {
      const { tabs, layout, focusedGroupId } = currentScopeState(s);
      if (!layout) return {};
      const group = findGroup(layout, groupId);
      if (!group) return {};
      // Drop the whole group's tabs from the flat payload list, then empty the
      // group node. collapse() in writeScope removes the emptied group and
      // renormalizes sibling sizes; the removed tabs' PTYs die as the flat pane
      // layer stops rendering their keys (TerminalView unmount → pty_kill).
      const removing = new Set(group.tabKeys);
      // Discard any session-only link routes from the closing tabs (#50).
      const purge = useLinkRoutingStore.getState().purgeForTab;
      group.tabKeys.forEach((k) => purge(k));
      const nextTabs = tabs.filter((t) => !removing.has(t.key));
      const next = mapGroup(layout, groupId, (g) => ({
        ...g,
        tabKeys: [],
        activeKey: null,
      }));
      return writeScope(s, s.scope, nextTabs, next, focusedGroupId);
    });
  },

  closeAllTabs: (scope) => {
    const target = scope ?? get().scope;
    const before = get();
    const tabs = before.tabsByScope[target] ?? [];
    if (tabs.length === 0) return;
    // Group B #228: a scope being emptied takes its POPOUTS with it, the way
    // `unloadScope` does. Emptying only the payloads left the detached record
    // standing: the main panes unmounted while `isDetachedPtyId` still said
    // "detached", so they skipped `pty_kill` and the shells ran on orphaned; the
    // popout kept rendering keys with no payload; its × was a no-op. So, BEFORE
    // the payloads go: kill each popout tab's PTY explicitly (mirrors
    // `closeDetachedGroup`), close the OS window, and drop the record — then
    // the unmount below sees no record and its own kill is a harmless repeat.
    const detached = before.detachedGroupsByScope[target] ?? [];
    const byKey = new Map(tabs.map((t) => [t.key, t] as const));
    for (const entry of detached) {
      for (const key of orderedTabKeys(entry.subtree)) {
        const tab = byKey.get(key);
        if (tab && isPtyTabKind(tab.kind)) {
          invoke("pty_kill", { id: `${target}:${key}` }).catch(() => {});
        }
      }
      invoke("attach_subwindow", { registryId: entry.label }).catch(() => {});
    }
    // Discard any session-only link routes from the closing tabs (#50), and the
    // half-typed-prompt state a recycled id must never inherit.
    const purge = useLinkRoutingStore.getState().purgeForTab;
    for (const t of tabs) {
      purge(t.key);
      forgetPty(`${target}:${t.key}`);
      forgetPromptTrail(`${target}:${t.key}`);
    }
    set((s) => {
      // Empty the scope entirely: no tabs, no layout, no detached/hidden records
      // (a hidden group's keys would otherwise dangle against dropped payloads).
      // writeScope mirrors the flat shortcuts when target is current; the flat
      // pane layer then unmounts every pane for this scope, killing its PTYs
      // (same path as closeGroup).
      const base = writeScope(s, target, [], null, null);
      const without = <T,>(record: Record<string, T>): Record<string, T> => {
        if (!Object.prototype.hasOwnProperty.call(record, target)) return record;
        const next = { ...record };
        delete next[target];
        return next;
      };
      return {
        ...base,
        detachedGroupsByScope: without(s.detachedGroupsByScope),
        hiddenGroupsByScope: without(s.hiddenGroupsByScope),
        pendingRespawnByScope: without(s.pendingRespawnByScope),
      };
    });
  },

  unloadScope: async (scope) => {
    const state = get();
    const tabs = state.tabsByScope[scope] ?? [];
    const detached = state.detachedGroupsByScope[scope] ?? [];

    const purge = useLinkRoutingStore.getState().purgeForTab;
    for (const tab of tabs) {
      purge(tab.key);
      forgetPty(`${scope}:${tab.key}`);
      forgetPromptTrail(`${scope}:${tab.key}`);
    }

    set((s) => {
      const without = <T,>(record: Record<string, T>): Record<string, T> => {
        if (!Object.prototype.hasOwnProperty.call(record, scope)) return record;
        const next = { ...record };
        delete next[scope];
        return next;
      };
      const current = s.scope === scope;
      return {
        tabsByScope: without(s.tabsByScope),
        layoutByScope: without(s.layoutByScope),
        focusedGroupByScope: without(s.focusedGroupByScope),
        detachedGroupsByScope: without(s.detachedGroupsByScope),
        hiddenGroupsByScope: without(s.hiddenGroupsByScope),
        pendingRespawnByScope: without(s.pendingRespawnByScope),
        ...(current
          ? {
              tabs: [],
              layout: null,
              focusedGroupId: null,
              activeKey: null,
              fullscreenGroupId: null,
            }
          : {}),
      };
    });

    // Close the native popouts AFTER their records are gone: the backend's
    // `Destroyed` hook tells the host about every popout death, and a record
    // still standing at that moment reads as a crash to dock back from (#224).
    // A missing/already-closed window is harmless.
    await Promise.allSettled(
      detached.map((entry) =>
        invoke("attach_subwindow", { registryId: entry.label }),
      ),
    );
  },

  updateTabEnv: (key, env) => {
    set((s) => {
      const owner = scopeOfTab(s, key);
      const { tabs, layout, focusedGroupId } = scopeState(s, owner);
      const nextTabs = tabs.map((t) => (t.key === key ? { ...t, env } : t));
      return writeScope(s, owner, nextTabs, layout, focusedGroupId);
    });
  },

  setTabTmuxName: (scope, key, name) => {
    // Popout heap (#231): the payload lives in the main store; without the
    // forward a renamed session reattached to its OLD name at the next launch.
    const ctx = getDetachedWindowContext();
    if (ctx) {
      ctx.pushEdit({ kind: "setTmuxName", key, name });
      return;
    }
    set((s) => {
      const tabs = s.tabsByScope[scope] ?? [];
      const nextTabs = tabs.map((t) =>
        t.key === key
          ? t.tmuxAttach
            ? { ...t, tmuxAttach: name }
            : { ...t, tmuxSession: name }
          : t,
      );
      const patch: Partial<TabsStore> = {
        tabsByScope: { ...s.tabsByScope, [scope]: nextTabs },
      };
      if (s.scope === scope) patch.tabs = nextTabs;
      return patch;
    });
  },

  setTabLocation: (key, location) => {
    set((s) => {
      const owner = scopeOfTab(s, key);
      const { tabs, layout, focusedGroupId } = scopeState(s, owner);
      let changed = false;
      const nextTabs = tabs.map((t) => {
        if (t.key !== key || t.location === location) return t;
        changed = true;
        return { ...t, location };
      });
      // No-op (stable array) when the value is unchanged, so an idle re-toggle
      // doesn't churn the tabs array / wake the saveLayout debounce.
      if (!changed) return {};
      return writeScope(s, owner, nextTabs, layout, focusedGroupId);
    });
  },

  relaunchTabInScope: (scope, key, args) => {
    set((s) => {
      const { tabs, layout, focusedGroupId } = scopeState(s, scope);
      if (!tabs.some((t) => t.key === key)) return {};
      const nextTabs = tabs.map((t) =>
        t.key === key ? { ...t, args, relaunchSeq: (t.relaunchSeq ?? 0) + 1 } : t,
      );
      return writeScope(s, scope, nextTabs, layout, focusedGroupId);
    });
  },

  setTabViewer: (key, viewer) => {
    set((s) => {
      const owner = scopeOfTab(s, key);
      const { tabs, layout, focusedGroupId } = scopeState(s, owner);
      let changed = false;
      const nextTabs = tabs.map((t) => {
        if (t.key !== key || t.kind !== "embed" || t.viewer === viewer) return t;
        changed = true;
        return { ...t, viewer };
      });
      // Stable array when nothing moved, so a repeated heal attempt does not
      // churn the tabs array / wake the saveLayout debounce.
      if (!changed) return {};
      return writeScope(s, owner, nextTabs, layout, focusedGroupId);
    });
  },

  setViewerState: (key, patch) => {
    // Popout heap (#231): viewer state (scroll/zoom/sort/delimiter/breakpoints)
    // persists on the payload in the MAIN store. Keep the popout's own seed
    // registry current too, so a pane remounting inside the popout before the
    // next reseed still recovers what it just wrote.
    const ctx = getDetachedWindowContext();
    if (ctx) {
      setDetachedViewerState(key, { ...getDetachedViewerState(key), ...patch });
      ctx.pushEdit({ kind: "setViewerState", key, patch });
      return;
    }
    set((s) => {
      const owner = scopeOfTab(s, key);
      const { tabs, layout, focusedGroupId } = scopeState(s, owner);
      const tab = tabs.find((t) => t.key === key);
      if (!tab) return {};
      const merged = { ...tab.viewerState, ...patch };
      // No-op if nothing actually changed, so a redundant write doesn't churn
      // the tabs array (which would re-fire the saveLayout debounce for nothing).
      // Generic shallow compare over the union of keys: the hand-maintained
      // field list this replaces silently DROPPED persistence for every
      // ViewerState field it lagged behind on (yamlCollapsed, gridFocus,
      // delimiter, columnWidths, bibSort, breakpoints, …) — a patch touching
      // only an unlisted field merged, compared equal on the listed ones, and
      // never reached the store. Non-scalar fields (arrays/objects) compare by
      // reference, which is exactly right: viewers hand in a fresh ref
      // precisely when such a field changed.
      const cur = (tab.viewerState ?? {}) as Record<string, unknown>;
      const mergedRec = merged as Record<string, unknown>;
      const changed = [...new Set([...Object.keys(cur), ...Object.keys(mergedRec)])].some(
        (k) => cur[k] !== mergedRec[k],
      );
      if (!changed) {
        return {};
      }
      const nextTabs = tabs.map((t) =>
        t.key === key ? { ...t, viewerState: merged } : t,
      );
      return writeScope(s, owner, nextTabs, layout, focusedGroupId);
    });
  },

  setTabFolder: (key, folder) => {
    // Popout heap (#231/#239): a Files (Project) tab's browsed folder persists
    // on the payload in the main store.
    const ctx = getDetachedWindowContext();
    if (ctx) {
      ctx.pushEdit({ kind: "setFolder", key, folder });
      return;
    }
    set((s) => {
      const owner = scopeOfTab(s, key);
      const { tabs, layout, focusedGroupId } = scopeState(s, owner);
      const tab = tabs.find((t) => t.key === key);
      // No-op when unchanged, so re-listing the same folder doesn't churn the
      // tabs array and wake the saveLayout debounce for nothing.
      if (!tab || (tab.folder ?? "") === folder) return {};
      const nextTabs = tabs.map((t) => (t.key === key ? { ...t, folder } : t));
      return writeScope(s, owner, nextTabs, layout, focusedGroupId);
    });
  },

  setTabUrl: (key, url) => {
    // Popout heap (#239): a browser tab's address persists on the main payload,
    // so a popped-out reader tab restores holding the page it was left on.
    const ctx = getDetachedWindowContext();
    if (ctx) {
      ctx.pushEdit({ kind: "setUrl", key, url });
      return;
    }
    set((s) => {
      const owner = scopeOfTab(s, key);
      const { tabs, layout, focusedGroupId } = scopeState(s, owner);
      const tab = tabs.find((t) => t.key === key);
      // Same no-op rule setTabFolder follows: reloading the same page must not
      // churn the tabs array and wake the saveLayout debounce for nothing.
      if (!tab || (tab.url ?? "") === url) return {};
      const nextTabs = tabs.map((t) => (t.key === key ? { ...t, url } : t));
      return writeScope(s, owner, nextTabs, layout, focusedGroupId);
    });
  },

  reorderInGroup: (groupId, from, to) => {
    set((s) => {
      const { tabs, layout, focusedGroupId } = currentScopeState(s);
      const group = findGroup(layout, groupId);
      if (!group || !layout) return {};
      if (
        from < 0 ||
        from >= group.tabKeys.length ||
        to < 0 ||
        to >= group.tabKeys.length
      ) {
        return {};
      }
      const next = mapGroup(layout, groupId, (g) => {
        const tabKeys = [...g.tabKeys];
        const [moved] = tabKeys.splice(from, 1);
        tabKeys.splice(to, 0, moved);
        return { ...g, tabKeys };
      });
      return writeScope(s, s.scope, tabs, next, focusedGroupId);
    });
  },

  moveTab: (key, targetGroupId, index) =>
    get().moveTabInScope(get().scope, key, targetGroupId, index),

  moveTabInScope: (scope, key, targetGroupId, index) => {
    set((s) => {
      const { tabs, layout } = scopeState(s, scope);
      if (!layout) return {};
      const source = findGroupOfTab(layout, key);
      const target = findGroup(layout, targetGroupId);
      if (!source || !target) return {};

      // Same group → treat as a reorder to `index`.
      if (source.group.id === targetGroupId) {
        const to =
          index == null
            ? source.group.tabKeys.length - 1
            : Math.min(index, source.group.tabKeys.length - 1);
        const next = mapGroup(layout, targetGroupId, (g) => {
          const tabKeys = [...g.tabKeys];
          const [moved] = tabKeys.splice(source.index, 1);
          tabKeys.splice(to, 0, moved);
          return { ...g, tabKeys, activeKey: key };
        });
        return writeScope(s, scope, tabs, next, targetGroupId);
      }

      // Remove from source, then insert into target.
      let next: LayoutNode = mapGroup(layout, source.group.id, (g) => {
        const tabKeys = g.tabKeys.filter((k) => k !== key);
        const activeKey =
          g.activeKey === key ? (tabKeys[0] ?? null) : g.activeKey;
        return { ...g, tabKeys, activeKey };
      });
      next = mapGroup(next, targetGroupId, (g) => {
        const tabKeys = [...g.tabKeys];
        const at = index == null ? tabKeys.length : Math.min(index, tabKeys.length);
        tabKeys.splice(at, 0, key);
        return { ...g, tabKeys, activeKey: key };
      });
      // Source may have emptied → collapse handles it; focus the target.
      return writeScope(s, scope, tabs, next, targetGroupId);
    });
  },

  mergeGroups: (targetGroupId, sourceGroupId) =>
    get().mergeGroupsInScope(get().scope, targetGroupId, sourceGroupId),

  mergeGroupsInScope: (scope, targetGroupId, sourceGroupId) => {
    set((s) => {
      const { tabs, layout } = scopeState(s, scope);
      if (!layout || targetGroupId === sourceGroupId) return {};
      const target = findGroup(layout, targetGroupId);
      const source = findGroup(layout, sourceGroupId);
      if (!target || !source) return {};
      const moved = source.tabKeys;
      // Append source's tabs onto the target (survivor keeps its own activeKey),
      // then empty the source so collapse drops it and unwraps the split.
      let next = mapGroup(layout, targetGroupId, (g) => ({
        ...g,
        tabKeys: [...g.tabKeys, ...moved],
        activeKey: g.activeKey ?? moved[0] ?? null,
      }));
      next = mapGroup(next, sourceGroupId, (g) => ({
        ...g,
        tabKeys: [],
        activeKey: null,
      }));
      return writeScope(s, scope, tabs, next, targetGroupId);
    });
  },

  splitWithTab: (key, targetGroupId, edge) =>
    get().splitWithTabInScope(get().scope, key, targetGroupId, edge),

  splitWithTabInScope: (scope, key, targetGroupId, edge) => {
    if (edge === "center") {
      get().moveTabInScope(scope, key, targetGroupId);
      return;
    }
    set((s) => {
      const { tabs, layout } = scopeState(s, scope);
      if (!layout) return {};
      const source = findGroupOfTab(layout, key);
      const target = findGroup(layout, targetGroupId);
      if (!source || !target) return {};

      // A no-op split: dragging a group's only tab onto its own edge would
      // remove then re-add it; skip if it's the lone tab of the target group.
      if (source.group.id === targetGroupId && source.group.tabKeys.length === 1) {
        return {};
      }

      // 1. Remove from source.
      const removed = mapGroup(layout, source.group.id, (g) => {
        const tabKeys = g.tabKeys.filter((k) => k !== key);
        const activeKey =
          g.activeKey === key ? (tabKeys[0] ?? null) : g.activeKey;
        return { ...g, tabKeys, activeKey };
      });
      // Collapse so an emptied source group disappears before we inject.
      const cleaned = collapse(removed);
      if (!cleaned) return {};

      // The target group survives collapse (it still has tabs); re-find it.
      const stillThere = findGroup(cleaned, targetGroupId);
      if (!stillThere) return {};

      // 2. Build the new group and inject adjacent to the target.
      const newGroup: GroupNode = {
        type: "group",
        id: nextGroupId(),
        tabKeys: [key],
        activeKey: key,
      };
      const dir: SplitDir =
        edge === "left" || edge === "right" ? "row" : "column";
      const before = edge === "left" || edge === "top";
      const next = insertAdjacent(cleaned, targetGroupId, newGroup, dir, before);

      // Focus the freshly-split-off group.
      return writeScope(s, scope, tabs, next, newGroup.id);
    });
  },

  splitWithNewTab: (tab, targetGroupId, edge) => {
    // Popout heap (#231): `openLinkedFile` lands a link in the linking tab's own
    // group through this — forward it as the popout's `add` edit, which carries
    // the same target-group + edge semantics (center appends, a side carves).
    const ctx = getDetachedWindowContext();
    if (ctx) {
      ctx.pushEdit({ kind: "add", tab, targetGroupId, edge });
      return { ...tab, key: nextKey(`pending-${tab.kind}`), scope: ctx.scope };
    }
    const key = nextKey(tab.kind);
    // Spread first so a stray `key` on the payload can't shadow the minted one.
    // Mint a persistent tmux session name like addTab/addTabToScope, so a shell
    // tab created by a split-drag (or a Python run placed via one) is persistence-
    // eligible — otherwise it silently skips the tmux wrap (idempotent: no-op for a
    // tab that already carries a session or is a non-shell kind).
    const entry: TabEntry = { ...withTmuxSession(tab, get().scope), key };
    let created = false;
    set((s) => {
      const { tabs, layout } = currentScopeState(s);
      if (!layout || !findGroup(layout, targetGroupId)) return {};
      const nextTabs = [...tabs, entry];

      // Center → add into the existing target group (no split), mirroring a
      // drop on its tab bar.
      if (edge === "center") {
        const next = mapGroup(layout, targetGroupId, (g) => ({
          ...g,
          tabKeys: [...g.tabKeys, key],
          activeKey: key,
        }));
        created = true;
        return writeScope(s, s.scope, nextTabs, next, targetGroupId);
      }

      // Edge → build a new group holding the tab and inject it adjacent to the
      // target, leaving the target's own tabs untouched.
      const newGroup: GroupNode = {
        type: "group",
        id: nextGroupId(),
        tabKeys: [key],
        activeKey: key,
      };
      const dir: SplitDir = edge === "left" || edge === "right" ? "row" : "column";
      const before = edge === "left" || edge === "top";
      const next = insertAdjacent(layout, targetGroupId, newGroup, dir, before);
      created = true;
      return writeScope(s, s.scope, nextTabs, next, newGroup.id);
    });
    return created ? entry : null;
  },

  resizeSplit: (splitId, dividerIndex, fraction) =>
    get().resizeSplitInScope(get().scope, splitId, dividerIndex, fraction),

  resizeSplitInScope: (scope, splitId, dividerIndex, fraction) => {
    set((s) => {
      const { tabs, layout, focusedGroupId } = scopeState(s, scope);
      if (!layout) return {};
      const next = applyResize(layout, splitId, dividerIndex, fraction);
      return writeScope(s, scope, tabs, next, focusedGroupId);
    });
  },

  setGroupFiles: (groupId, open) => get().setGroupFilesInScope(get().scope, groupId, open),

  setGroupFilesInScope: (scope, groupId, open) => {
    set((s) => {
      const { tabs, layout, focusedGroupId } = scopeState(s, scope);
      if (!layout || !findGroup(layout, groupId)) return {};
      const next = mapGroup(layout, groupId, (g) => ({ ...g, filesOpen: open }));
      return writeScope(s, scope, tabs, next, focusedGroupId);
    });
  },

  setGroupFilesWidth: (groupId, width) => get().setGroupFilesWidthInScope(get().scope, groupId, width),

  setGroupFilesWidthInScope: (scope, groupId, width) => {
    set((s) => {
      const { tabs, layout, focusedGroupId } = scopeState(s, scope);
      if (!layout || !findGroup(layout, groupId)) return {};
      const next = mapGroup(layout, groupId, (g) => ({ ...g, filesWidth: width }));
      return writeScope(s, scope, tabs, next, focusedGroupId);
    });
  },

  setGroupFilesFolder: (groupId, folder) => get().setGroupFilesFolderInScope(get().scope, groupId, folder),

  setGroupFilesFolderInScope: (scope, groupId, folder) => {
    set((s) => {
      const { tabs, layout, focusedGroupId } = scopeState(s, scope);
      const g = layout && findGroup(layout, groupId);
      // No-op when unchanged, so re-listing the same folder doesn't churn the
      // layout and wake the saveLayout debounce for nothing (mirrors setTabFolder).
      if (!g || (g.filesFolder ?? "") === folder) return {};
      const next = mapGroup(layout, groupId, (grp) => ({ ...grp, filesFolder: folder }));
      return writeScope(s, scope, tabs, next, focusedGroupId);
    });
  },

  detachGroup: (groupId, opts) => {
    const scope = get().scope;
    const layout = get().layoutByScope[scope] ?? null;
    // The id is usually a GROUP (live drag-out), but on restart respawn it can be
    // a SPLIT node — a multi-pane popout re-detached as one whole subtree (#42).
    const group = findGroup(layout, groupId);
    const split = group ? null : findSplit(layout, groupId);
    if (!group && !split) return null;
    // Refuse to detach the only group: the in-window layout must keep a body —
    // except on restart respawn (`allowLastGroup`), where the popout legitimately
    // becomes the scope's only window and the main center is left empty.
    if (!opts?.allowLastGroup && allGroups(layout).length <= 1) return null;

    const label = `detached-${scope}-${groupId}`;
    // Snapshot the popout's subtree: a single GroupNode, or the whole split node
    // (multi-pane popout) verbatim — its ids are reused as the popout's content.
    const subtree: LayoutNode = group
      // Spread so per-group extras (the files sidebar's open flag + width)
      // travel with the subtree.
      ? { ...group, tabKeys: [...group.tabKeys] }
      : (split as SplitNode);
    // Group ids that leave the in-window layout (one for a group, several for a
    // split) — used to drop focus if it pointed into the detached subtree.
    const detachedGroupIds = new Set(allGroups(subtree).map((g) => g.id));

    set((s) => {
      const tabs = s.tabsByScope[scope] ?? [];
      const focus = s.focusedGroupByScope[scope] ?? null;
      // Remove the detached subtree from the in-window layout WITHOUT dropping its
      // tab payloads (they stay in tabsByScope — the detached window renders them).
      // A group is emptied in place (collapse drops it); a split subtree is pruned
      // out whole. Mirrors closeGroup's node-empty step, but keeps the payloads.
      const stripped = !layout
        ? null
        : group
          ? mapGroup(layout, groupId, (g) => ({ ...g, tabKeys: [], activeKey: null }))
          : removeNodeById(layout, groupId);
      // Re-pick focus off the detached subtree onto a surviving group.
      const nextFocus = focus && detachedGroupIds.has(focus) ? null : focus;
      const base = writeScope(s, scope, tabs, stripped, nextFocus);
      const existing = s.detachedGroupsByScope[scope] ?? [];
      return {
        ...base,
        detachedGroupsByScope: {
          ...s.detachedGroupsByScope,
          [scope]: [
            ...existing,
            { id: groupId, subtree, label, bounds: opts?.bounds, zoom: opts?.zoom },
          ],
        },
      };
    });

    if (!opts?.skipBackend) {
      // Spawn the detached OS window. The store mutation + IPC live in one
      // action so they can't drift. `bounds` (when restoring a popout on
      // restart) reopens it at its prior place/size. A backend failure (#224)
      // retries while the display/retire state settles. If every attempt fails,
      // the group is re-docked so its tabs remain reachable.
      void openDetachedWindow(scope, groupId);
    }
    return label;
  },

  detachTab: (key, bounds) => {
    const scope = get().scope;
    const layout = get().layoutByScope[scope] ?? null;
    const found = findGroupOfTab(layout, key);
    if (!found) return null;

    const groupId = nextGroupId();
    const label = `detached-${scope}-${groupId}`;
    // The popped tab becomes the sole member of a fresh single-tab group; its
    // payload stays in tabsByScope (the detached subtree now references it).
    const subtree: GroupNode = {
      type: "group",
      id: groupId,
      tabKeys: [key],
      activeKey: key,
    };

    set((s) => {
      const tabs = s.tabsByScope[scope] ?? [];
      const focus = s.focusedGroupByScope[scope] ?? null;
      // Drop the key from its source group, then collapse via writeScope (which
      // keeps the payload in `tabs`). An emptied source group/layout is allowed —
      // the main center falls back to the placeholder subwindow.
      const stripped = layout
        ? mapGroup(layout, found.group.id, (g) => {
            const tabKeys = g.tabKeys.filter((k) => k !== key);
            const activeKey =
              g.activeKey === key
                ? (tabKeys[Math.min(found.index, tabKeys.length - 1)] ?? null)
                : g.activeKey;
            return { ...g, tabKeys, activeKey };
          })
        : null;
      const base = writeScope(s, scope, tabs, stripped, focus);
      const existing = s.detachedGroupsByScope[scope] ?? [];
      return {
        ...base,
        detachedGroupsByScope: {
          ...s.detachedGroupsByScope,
          [scope]: [...existing, { id: groupId, subtree, label, bounds }],
        },
      };
    });

    void openDetachedWindow(scope, groupId);
    return label;
  },

  detachNewTab: (tab, bounds) => {
    const scope = get().scope;
    const key = nextKey(tab.kind);
    const groupId = nextGroupId();
    const label = `detached-${scope}-${groupId}`;
    // Spread first so a stray `key` on the payload can't shadow the minted one;
    // stamp the owning scope (writeScope isn't on this path since the layout is
    // untouched, so do its scope-stamp here). Mint the tmux session name too, so a
    // shell tab detached straight into its own popout stays persistence-eligible.
    const entry: TabEntry = { ...withTmuxSession(tab, scope), key, scope };
    const subtree: GroupNode = {
      type: "group",
      id: groupId,
      tabKeys: [key],
      activeKey: key,
    };

    set((s) => {
      const nextTabs = [...(s.tabsByScope[scope] ?? []), entry];
      const existing = s.detachedGroupsByScope[scope] ?? [];
      return {
        tabsByScope: { ...s.tabsByScope, [scope]: nextTabs },
        detachedGroupsByScope: {
          ...s.detachedGroupsByScope,
          [scope]: [...existing, { id: groupId, subtree, label, bounds }],
        },
        // Mirror the current-scope convenience copy (writeScope normally does
        // this, but this path leaves the layout untouched and skips it).
        ...(s.scope === scope ? { tabs: nextTabs } : {}),
      };
    });

    void openDetachedWindow(scope, groupId);
    return label;
  },

  attachGroup: (detachedId, opts) => {
    const scope = get().scope;
    const entries = get().detachedGroupsByScope[scope] ?? [];
    const entry = entries.find((d) => d.id === detachedId);
    if (!entry) return;

    set((s) => {
      const tabs = s.tabsByScope[scope] ?? [];
      let layout = s.layoutByScope[scope] ?? null;
      // Regenerate the subtree's ids so a docked-then-redetached group never
      // collides with a live node id. The subtree may be a split (multi-pane
      // popout), so keep it a LayoutNode.
      const fresh = regenIds(entry.subtree);
      if (!layout) {
        // The in-window tree emptied while detached → install as the root.
        layout = fresh;
      } else {
        const target =
          (opts?.targetGroupId && findGroup(layout, opts.targetGroupId)) ||
          allGroups(layout)[0];
        if (!target) {
          layout = fresh;
        } else {
          const edge = opts?.edge ?? "right";
          if (edge === "center" && fresh.type === "group") {
            // Merge a single-group popout's tabs into the target group.
            layout = mapGroup(layout, target.id, (g) => ({
              ...g,
              tabKeys: [...g.tabKeys, ...fresh.tabKeys],
              activeKey: fresh.activeKey ?? g.activeKey,
            }));
          } else {
            // Split popout (or a non-center edge): inject the whole subtree
            // adjacent to the target as its own pane(s).
            const e = edge === "center" ? "right" : edge;
            const dir: SplitDir =
              e === "left" || e === "right" ? "row" : "column";
            const before = e === "left" || e === "top";
            layout = insertAdjacent(layout, target.id, fresh, dir, before);
          }
        }
      }
      const remaining = entries.filter((d) => d.id !== detachedId);
      const base = writeScope(s, scope, tabs, layout, firstGroup(fresh).id);
      return {
        ...base,
        detachedGroupsByScope: {
          ...s.detachedGroupsByScope,
          [scope]: remaining,
        },
      };
    });

    if (!opts?.skipBackend) {
      invoke("attach_subwindow", { registryId: entry.label }).catch(() => {});
    }
  },

  hideGroup: (groupId) => {
    const scope = get().scope;
    const layout = get().layoutByScope[scope] ?? null;
    // Mirror detachGroup's node resolution: usually a GROUP, but can be a SPLIT
    // node (a multi-pane subtree hidden whole).
    const group = findGroup(layout, groupId);
    const split = group ? null : findSplit(layout, groupId);
    if (!group && !split) return;
    // Unlike detachGroup we DO allow hiding the only group: hiding everything
    // leaves the scope empty (the +-placeholder), a valid resting state.

    const label = `hidden-${scope}-${groupId}`;
    const subtree: LayoutNode = group
      // Spread so per-group extras (the files sidebar's open flag + width)
      // travel with the subtree.
      ? { ...group, tabKeys: [...group.tabKeys] }
      : (split as SplitNode);
    const hiddenGroupIds = new Set(allGroups(subtree).map((g) => g.id));

    set((s) => {
      const tabs = s.tabsByScope[scope] ?? [];
      const focus = s.focusedGroupByScope[scope] ?? null;
      // Strip the hidden subtree from the live layout WITHOUT dropping its tab
      // payloads (they stay in tabsByScope so the flat pane layer keeps their
      // PTYs mounted, just display:none). Mirrors detachGroup minus the OS window.
      const stripped = !layout
        ? null
        : group
          ? mapGroup(layout, groupId, (g) => ({ ...g, tabKeys: [], activeKey: null }))
          : removeNodeById(layout, groupId);
      const nextFocus = focus && hiddenGroupIds.has(focus) ? null : focus;
      const base = writeScope(s, scope, tabs, stripped, nextFocus);
      const existing = s.hiddenGroupsByScope[scope] ?? [];
      return {
        ...base,
        hiddenGroupsByScope: {
          ...s.hiddenGroupsByScope,
          [scope]: [...existing, { id: groupId, subtree, label }],
        },
      };
    });
  },

  unhideGroup: (hiddenId, opts) => {
    const scope = get().scope;
    const entries = get().hiddenGroupsByScope[scope] ?? [];
    const entry = entries.find((h) => h.id === hiddenId);
    if (!entry) return;

    set((s) => {
      const tabs = s.tabsByScope[scope] ?? [];
      let layout = s.layoutByScope[scope] ?? null;
      // Regenerate ids so a hidden-then-restored group never collides with a live
      // node id (mirrors attachGroup). regenIds rewrites GROUP ids but keeps tab
      // KEYS, so an activeKey maps straight through.
      let fresh = regenIds(entry.subtree);
      if (opts?.activeKey) {
        const target = findGroupOfTab(fresh, opts.activeKey);
        if (target) {
          fresh = mapGroup(fresh, target.group.id, (g) => ({ ...g, activeKey: opts.activeKey! }));
        }
      }
      if (!layout) {
        // The tree emptied while hidden → install the restored subtree as root.
        layout = fresh;
      } else {
        const target = allGroups(layout)[0];
        if (!target) {
          layout = fresh;
        } else {
          // Inject the whole subtree as a new pane to the right of the first group.
          layout = insertAdjacent(layout, target.id, fresh, "row", false);
        }
      }
      const remaining = entries.filter((h) => h.id !== hiddenId);
      const base = writeScope(s, scope, tabs, layout, firstGroup(fresh).id);
      return {
        ...base,
        hiddenGroupsByScope: {
          ...s.hiddenGroupsByScope,
          [scope]: remaining,
        },
      };
    });
  },

  closeHiddenGroup: (hiddenId) => {
    set((s) => {
      const scope = s.scope;
      const entries = s.hiddenGroupsByScope[scope] ?? [];
      const entry = entries.find((h) => h.id === hiddenId);
      if (!entry) return {};
      // Kill the hidden group's tabs for good: drop their payloads (the flat pane
      // layer then unmounts each pane → pty_kill) and purge their link routes,
      // mirroring closeGroup. The subtree may be a split, so collect every key.
      const removing = new Set(orderedTabKeys(entry.subtree));
      const purge = useLinkRoutingStore.getState().purgeForTab;
      removing.forEach((k) => purge(k));
      const nextTabs = (s.tabsByScope[scope] ?? []).filter((t) => !removing.has(t.key));
      const remaining = entries.filter((h) => h.id !== hiddenId);
      const { layout, focusedGroupId } = currentScopeState(s);
      const base = writeScope(s, scope, nextTabs, layout, focusedGroupId);
      return {
        ...base,
        hiddenGroupsByScope: {
          ...s.hiddenGroupsByScope,
          [scope]: remaining,
        },
      };
    });
  },

  attachDetachedTab: (scope, detachedGroupId, tabKey, opts) => {
    const entries = get().detachedGroupsByScope[scope] ?? [];
    const entry = entries.find((d) => d.id === detachedGroupId);
    if (!entry || !orderedTabKeys(entry.subtree).includes(tabKey)) return;

    // The detached popout is emptied by this tab leaving → close the window.
    const willEmpty = orderedTabKeys(entry.subtree).filter((k) => k !== tabKey).length === 0;

    set((s) => {
      // 1. Insert the tab into the destination layout (the docked-into scope's,
      //    which is `scope` whether active or stored). The tab payload already
      //    lives in tabsByScope[scope], so we only place its key.
      let layout = s.layoutByScope[scope] ?? null;
      let destId: string;
      const fresh: GroupNode = {
        type: "group",
        id: nextGroupId(),
        tabKeys: [tabKey],
        activeKey: tabKey,
      };
      if (!layout) {
        layout = fresh; // empty scope → the tab becomes the root group.
        destId = fresh.id;
      } else {
        const target =
          (opts?.targetGroupId && findGroup(layout, opts.targetGroupId)) ||
          allGroups(layout)[0];
        if (!target) {
          layout = fresh;
          destId = fresh.id;
        } else if ((opts?.edge ?? "center") === "center") {
          // Merge into the target group (append + activate).
          layout = mapGroup(layout, target.id, (g) => ({
            ...g,
            tabKeys: [...g.tabKeys, tabKey],
            activeKey: tabKey,
          }));
          destId = target.id;
        } else {
          const edge = opts!.edge as DropEdge;
          const dir: SplitDir =
            edge === "left" || edge === "right" ? "row" : "column";
          const before = edge === "left" || edge === "top";
          layout = insertAdjacent(layout, target.id, fresh, dir, before);
          destId = fresh.id;
        }
      }

      // 2. Drop the tab from the detached subtree, or drop the whole record when
      //    it leaves the popout empty.
      const nextEntries = willEmpty
        ? entries.filter((d) => d.id !== detachedGroupId)
        : entries.map((d) => {
            if (d.id !== detachedGroupId) return d;
            const sub = removeKeyFromTree(d.subtree, tabKey);
            return sub ? { ...d, subtree: sub } : d;
          });

      // 3. Commit the layout (writeScope keeps the payload + updates the live
      //    mirrors for the active scope; it's a no-op on the mirrors otherwise),
      //    focusing the destination group so the docked tab shows.
      const tabs = s.tabsByScope[scope] ?? [];
      const base = writeScope(s, scope, tabs, layout, destId);
      return {
        ...base,
        detachedGroupsByScope: {
          ...s.detachedGroupsByScope,
          [scope]: nextEntries,
        },
      };
    });

    if (willEmpty && !opts?.skipBackend) {
      invoke("attach_subwindow", { registryId: entry.label }).catch(() => {});
    }
  },

  attachDetachedPane: (scope, detachedGroupId, paneId, opts) => {
    const entries = get().detachedGroupsByScope[scope] ?? [];
    const entry = entries.find((d) => d.id === detachedGroupId);
    if (!entry) return;
    const pane = findGroup(entry.subtree, paneId);
    if (!pane) return;

    // The pane is the popout's only group → this IS a whole-popout dock; the
    // whole-group paths also close the OS window.
    const remaining = removeNodeById(entry.subtree, paneId);
    if (!remaining) {
      if (get().scope === scope) get().attachGroup(detachedGroupId, opts);
      else get().dropDetachedGroup(scope, detachedGroupId);
      return;
    }

    set((s) => {
      // 1. Inject the pane into the destination layout as one group (fresh id so
      //    it can never collide with a live node id). Its tab payloads already
      //    live in tabsByScope[scope]; only the keys move.
      let layout = s.layoutByScope[scope] ?? null;
      const fresh: GroupNode = {
        type: "group",
        id: nextGroupId(),
        tabKeys: [...pane.tabKeys],
        activeKey: pane.activeKey ?? pane.tabKeys[0] ?? null,
      };
      let destId = fresh.id;
      if (!layout) {
        layout = fresh; // empty scope → the pane becomes the root group.
      } else {
        const target =
          (opts?.targetGroupId && findGroup(layout, opts.targetGroupId)) ||
          allGroups(layout)[0];
        if (!target) {
          layout = fresh;
        } else if (opts?.edge === "center") {
          // Merge the pane's tabs into the target group.
          layout = mapGroup(layout, target.id, (g) => ({
            ...g,
            tabKeys: [...g.tabKeys, ...pane.tabKeys],
            activeKey: pane.activeKey ?? g.activeKey,
          }));
          destId = target.id;
        } else {
          // Default (no resolved target): land as its own pane on the right —
          // a pane is a subwindow, so it keeps being one (mirrors attachGroup).
          const edge = opts?.edge ?? "right";
          const dir: SplitDir = edge === "left" || edge === "right" ? "row" : "column";
          const before = edge === "left" || edge === "top";
          layout = insertAdjacent(layout, target.id, fresh, dir, before);
        }
      }

      // 2. Drop the pane's group node from the popout's subtree — the sibling
      //    panes stay floating in the popout.
      const nextEntries = (s.detachedGroupsByScope[scope] ?? []).map((d) =>
        d.id === detachedGroupId ? { ...d, subtree: remaining } : d,
      );

      const tabs = s.tabsByScope[scope] ?? [];
      const base = writeScope(s, scope, tabs, layout, destId);
      return {
        ...base,
        detachedGroupsByScope: {
          ...s.detachedGroupsByScope,
          [scope]: nextEntries,
        },
      };
    });
  },

  detachTabToNewWindow: (scope, fromGroupId, tabKey, bounds) => {
    const entries = get().detachedGroupsByScope[scope] ?? [];
    const src = entries.find((d) => d.id === fromGroupId);
    // The source popout (and the tab within it) must still exist.
    if (!src || !orderedTabKeys(src.subtree).includes(tabKey)) return null;
    // A lone-tab popout dragged whole is already its own window — re-detaching it
    // would empty the source and churn for nothing, so refuse that case.
    const remaining = removeKeyFromTree(src.subtree, tabKey);
    if (!remaining || orderedTabKeys(remaining).length === 0) return null;

    const groupId = nextGroupId();
    const label = `detached-${scope}-${groupId}`;
    // The popped tab becomes the sole member of a fresh single-tab group; its
    // payload stays in tabsByScope (shared), so the new popout self-seeds and the
    // PTY never unmounts (mirrors `detachTab`).
    const subtree: GroupNode = {
      type: "group",
      id: groupId,
      tabKeys: [tabKey],
      activeKey: tabKey,
    };

    set((s) => {
      const existing = s.detachedGroupsByScope[scope] ?? [];
      // One atomic update: strip the tab from the source popout's subtree AND
      // append the new detached entry. The payload in `tabsByScope` is untouched.
      const nextEntries = existing.map((d) =>
        d.id === fromGroupId ? { ...d, subtree: remaining } : d,
      );
      return {
        detachedGroupsByScope: {
          ...s.detachedGroupsByScope,
          [scope]: [...nextEntries, { id: groupId, subtree, label, bounds }],
        },
      };
    });

    void openDetachedWindow(scope, groupId);
    return label;
  },

  detachPaneToNewWindow: (scope, fromGroupId, paneId, bounds) => {
    const entries = get().detachedGroupsByScope[scope] ?? [];
    const src = entries.find((d) => d.id === fromGroupId);
    if (!src) return null;
    const pane = findGroup(src.subtree, paneId);
    if (!pane) return null;
    // A lone-pane popout dragged by its grip is already its own window —
    // re-detaching it would empty the source and churn for nothing.
    const remaining = removeNodeById(src.subtree, paneId);
    if (!remaining) return null;

    const groupId = nextGroupId();
    const label = `detached-${scope}-${groupId}`;
    // The pane becomes the whole subtree of a fresh popout; its tab payloads
    // stay in tabsByScope (shared), so the new popout self-seeds and the PTYs
    // never unmount (mirrors detachTabToNewWindow).
    const subtree: GroupNode = {
      type: "group",
      id: groupId,
      tabKeys: [...pane.tabKeys],
      activeKey: pane.activeKey ?? pane.tabKeys[0] ?? null,
    };

    set((s) => {
      const existing = s.detachedGroupsByScope[scope] ?? [];
      // One atomic update: strip the pane from the source popout's subtree AND
      // append the new detached entry. The payloads in `tabsByScope` are untouched.
      const nextEntries = existing.map((d) =>
        d.id === fromGroupId ? { ...d, subtree: remaining } : d,
      );
      return {
        detachedGroupsByScope: {
          ...s.detachedGroupsByScope,
          [scope]: [...nextEntries, { id: groupId, subtree, label, bounds }],
        },
      };
    });

    void openDetachedWindow(scope, groupId);
    return label;
  },

  dockTabIntoDetached: (scope, detachedGroupId, tabKey, target) => {
    const entries = get().detachedGroupsByScope[scope] ?? [];
    const entry = entries.find((d) => d.id === detachedGroupId);
    // Reject a no-op: the tab must exist in this scope and not already be in the
    // target popout.
    if (!entry || orderedTabKeys(entry.subtree).includes(tabKey)) return;

    set((s) => {
      const tabs = s.tabsByScope[scope] ?? [];
      if (!tabs.some((t) => t.key === tabKey)) return {};
      const layout = s.layoutByScope[scope] ?? null;
      const focus = s.focusedGroupByScope[scope] ?? null;
      // 1. Drop the tab from its source in-window group (its payload stays in
      //    `tabs`, so writeScope keeps it and the pane stays mounted-but-hidden).
      //    An emptied source group/layout is fine — the main center falls back to
      //    the placeholder, exactly like `detachTab`.
      const found = findGroupOfTab(layout, tabKey);
      const stripped =
        found && layout
          ? mapGroup(layout, found.group.id, (g) => {
              const tabKeys = g.tabKeys.filter((k) => k !== tabKey);
              const activeKey =
                g.activeKey === tabKey
                  ? (tabKeys[Math.min(found.index, tabKeys.length - 1)] ?? null)
                  : g.activeKey;
              return { ...g, tabKeys, activeKey };
            })
          : layout;
      const base = writeScope(s, scope, tabs, stripped, focus);
      // 2. Place the tab in the detached group's subtree at the resolved pane
      //    target (a body edge splits, center/a slot merges) + activate it there.
      //    No target → append to the first pane (legacy single-pane behaviour).
      const nextEntries = (s.detachedGroupsByScope[scope] ?? []).map((d) =>
        d.id === detachedGroupId
          ? { ...d, subtree: placeKeyInTree(d.subtree, tabKey, target) }
          : d,
      );
      return {
        ...base,
        detachedGroupsByScope: {
          ...s.detachedGroupsByScope,
          [scope]: nextEntries,
        },
      };
    });
  },

  moveTabBetweenDetached: (scope, fromGroupId, toGroupId, tabKey, target, opts) => {
    // A tab can't move onto itself, and both endpoints must exist.
    if (fromGroupId === toGroupId) return;
    const entries = get().detachedGroupsByScope[scope] ?? [];
    const from = entries.find((d) => d.id === fromGroupId);
    const to = entries.find((d) => d.id === toGroupId);
    if (!from || !to) return;
    // The tab must live in the source and NOT already in the destination.
    if (!orderedTabKeys(from.subtree).includes(tabKey)) return;
    if (orderedTabKeys(to.subtree).includes(tabKey)) return;
    // The source popout is emptied by this tab leaving → close its OS window.
    const willEmpty =
      orderedTabKeys(from.subtree).filter((k) => k !== tabKey).length === 0;

    set((s) => {
      const list = s.detachedGroupsByScope[scope] ?? [];
      // One atomic pass: place the key in the destination subtree and strip it
      // from the source. The payload in `tabsByScope` is untouched (shared PTY).
      let next = list.map((d) => {
        if (d.id === toGroupId) {
          return { ...d, subtree: placeKeyInTree(d.subtree, tabKey, target) };
        }
        if (d.id === fromGroupId) {
          const sub = removeKeyFromTree(d.subtree, tabKey);
          return sub ? { ...d, subtree: sub } : d;
        }
        return d;
      });
      // Drop the source record entirely when the tab leaving emptied it.
      if (willEmpty) next = next.filter((d) => d.id !== fromGroupId);
      return {
        detachedGroupsByScope: { ...s.detachedGroupsByScope, [scope]: next },
      };
    });

    // Close the emptied source popout's OS window (frees the registry slot). The
    // destination window is re-seeded by the caller so the moved tab renders.
    if (willEmpty && !opts?.skipBackend) {
      invoke("attach_subwindow", { registryId: from.label }).catch(() => {});
    }
  },

  applyDetachedEdit: (scope, groupId, edit) => {
    set((s) => {
      const entries = s.detachedGroupsByScope[scope] ?? [];
      const idx = entries.findIndex((d) => d.id === groupId);
      if (idx < 0) return {};
      const entry = entries[idx];
      const sub = entry.subtree;
      // A subtree may be a split (multi-pane popout); each edit targets the group
      // that owns `edit.key` (or, for reorder, the group whose tabs it permutes).
      let nextSub: LayoutNode | null = sub;
      let nextTabs = s.tabsByScope[scope] ?? null;
      switch (edit.kind) {
        case "activate": {
          const g = findGroupOfTab(sub, edit.key);
          if (g) {
            nextSub = mapGroup(sub, g.group.id, (grp) => ({ ...grp, activeKey: edit.key }));
          }
          break;
        }
        case "rename": {
          const label = edit.label.trim();
          if (label && nextTabs) {
            nextTabs = nextTabs.map((t) =>
              t.key === edit.key ? { ...t, label } : t,
            );
          }
          break;
        }
        case "setColor": {
          // Validated here as well as at the picker: this edit arrives over the
          // popout channel, and an unknown id must not reach `--tab-accent`.
          const color = isTabColor(edit.color) ? edit.color : undefined;
          if (nextTabs) {
            nextTabs = nextTabs.map((t) =>
              t.key === edit.key && t.color !== color ? { ...t, color } : t,
            );
          }
          break;
        }
        case "setStack": {
          // From the popout channel: normalized here, not trusted as sent.
          const stack = normalizeStackName(edit.stack);
          if (nextTabs) {
            nextTabs = nextTabs.map((t) =>
              t.key === edit.key && t.stack !== stack ? { ...t, stack } : t,
            );
          }
          break;
        }
        case "setMark": {
          // From the popout channel: validated, not trusted as sent.
          const mark = isTabMark(edit.mark) ? edit.mark : undefined;
          if (nextTabs) {
            nextTabs = nextTabs.map((t) =>
              t.key === edit.key && t.mark !== mark ? { ...t, mark } : t,
            );
          }
          break;
        }
        case "setTodo": {
          const todoId = normalizeTodoId(edit.todoId);
          if (nextTabs) {
            nextTabs = nextTabs.map((t) =>
              t.key === edit.key && t.todoId !== todoId ? { ...t, todoId } : t,
            );
          }
          break;
        }
        case "setLocation": {
          // Locality lives on the payload; the popout's pane is owned by THIS
          // (main) window's flat pane layer, so updating it here respawns that
          // pane on the chosen host (same path as the main-window locality badge).
          if (nextTabs) {
            nextTabs = nextTabs.map((t) =>
              t.key === edit.key && t.location !== edit.location
                ? { ...t, location: edit.location }
                : t,
            );
          }
          break;
        }
        case "close": {
          // Only a key still IN this popout's subtree is closed (#238): a
          // `close` that raced a dock — the tab already moved to the main
          // layout or a sibling popout before the popout's reseed landed —
          // must not delete a payload another node now references.
          if (!findGroupOfTab(sub, edit.key)) break;
          nextSub = removeKeyFromTree(sub, edit.key);
          // Drop the closed tab's payload (its pane in the detached window
          // unmounted; the PTY is killed there by the spawning pane's lifetime).
          if (nextTabs) nextTabs = nextTabs.filter((t) => t.key !== edit.key);
          break;
        }
        case "setViewerState": {
          // #231: viewer state written in a popout persists on the main payload,
          // with the same shallow no-op rule `setViewerState` applies locally.
          if (nextTabs) {
            nextTabs = nextTabs.map((t) => {
              if (t.key !== edit.key) return t;
              const merged = { ...t.viewerState, ...edit.patch };
              const cur = (t.viewerState ?? {}) as Record<string, unknown>;
              const mergedRec = merged as Record<string, unknown>;
              const changed = [...new Set([...Object.keys(cur), ...Object.keys(mergedRec)])].some(
                (k) => cur[k] !== mergedRec[k],
              );
              return changed ? { ...t, viewerState: merged } : t;
            });
          }
          break;
        }
        case "setTmuxName": {
          if (nextTabs) {
            nextTabs = nextTabs.map((t) =>
              t.key === edit.key
                ? t.tmuxAttach
                  ? { ...t, tmuxAttach: edit.name }
                  : { ...t, tmuxSession: edit.name }
                : t,
            );
          }
          break;
        }
        case "setFolder": {
          if (nextTabs) {
            nextTabs = nextTabs.map((t) =>
              t.key === edit.key && (t.folder ?? "") !== edit.folder
                ? { ...t, folder: edit.folder }
                : t,
            );
          }
          break;
        }
        case "setUrl": {
          if (nextTabs) {
            nextTabs = nextTabs.map((t) =>
              t.key === edit.key && (t.url ?? "") !== edit.url ? { ...t, url: edit.url } : t,
            );
          }
          break;
        }
        case "reorder": {
          // Find the group whose tab set the reordered list permutes, then
          // reapply that order to it.
          const want = new Set(edit.tabKeys);
          const g = allGroups(sub).find(
            (grp) =>
              grp.tabKeys.length === edit.tabKeys.length &&
              grp.tabKeys.every((k) => want.has(k)),
          );
          if (g) {
            nextSub = mapGroup(sub, g.id, (grp) => ({ ...grp, tabKeys: edit.tabKeys }));
          }
          break;
        }
        case "split":
          // A pane split inside the popout: split the subtree, or no-op if the
          // split is invalid (keeps the popout unchanged). The popout's own ids
          // for the new nodes are adopted so both windows agree on them.
          nextSub =
            splitSubtree(sub, edit.key, edit.targetGroupId, edit.edge, {
              groupId: edit.newGroupId,
              splitId: edit.newSplitId,
            }) ?? sub;
          break;
        case "resize":
          // A divider drag inside a multi-pane popout: adjust the targeted
          // split's child fractions.
          nextSub = applyResize(sub, edit.splitId, edit.dividerIndex, edit.fraction);
          break;
        case "move":
          // Merge a tab across the popout's groups: null (removal emptied the
          // tree — impossible for a cross-group move) leaves the popout unchanged.
          nextSub = moveKeyInTree(sub, edit.key, edit.targetGroupId, edit.index) ?? sub;
          break;
        case "files":
          // The popout toggled/resized a group's docked file-viewer column.
          nextSub = mapGroup(sub, edit.groupId, (grp) => ({
            ...grp,
            ...(edit.open != null ? { filesOpen: edit.open } : {}),
            ...(edit.width != null ? { filesWidth: edit.width } : {}),
            ...(edit.folder != null ? { filesFolder: edit.folder } : {}),
          }));
          break;
      }
      const nextEntries = [...entries];
      // If the detached popout emptied, remove it entirely.
      if (!nextSub || orderedTabKeys(nextSub).length === 0) {
        nextEntries.splice(idx, 1);
      } else {
        nextEntries[idx] = { ...entry, subtree: nextSub };
      }
      const patch: Partial<TabsStore> = {
        detachedGroupsByScope: { ...s.detachedGroupsByScope, [scope]: nextEntries },
      };
      if (nextTabs && nextTabs !== s.tabsByScope[scope]) {
        patch.tabsByScope = { ...s.tabsByScope, [scope]: nextTabs };
        if (s.scope === scope) patch.tabs = nextTabs;
      }
      return patch;
    });
  },

  addDetachedTab: (scope, detachedGroupId, tab, targetGroupId) => {
    let created: string | null = null;
    set((s) => {
      const entries = s.detachedGroupsByScope[scope] ?? [];
      const idx = entries.findIndex((d) => d.id === detachedGroupId);
      if (idx < 0) return {};
      const rec = entries[idx];

      // Dedupe an EMBED viewer already open in THIS popout (a recompiled PDF, a
      // re-opened linked file): refocus it in place rather than stack a second
      // copy — the popout's mirror of `openLinkedFile`'s path dedupe. Non-embed
      // tabs (a Python/shell run) carry no `embedPath` and always add a fresh one.
      if (tab.kind === "embed" && tab.embedPath) {
        const payloads = s.tabsByScope[scope] ?? [];
        const keysInPopout = new Set(allGroups(rec.subtree).flatMap((g) => g.tabKeys));
        const existing = payloads.find(
          (p) =>
            keysInPopout.has(p.key) &&
            p.kind === "embed" &&
            p.viewer === tab.viewer &&
            p.embedPath === tab.embedPath,
        );
        if (existing) {
          created = existing.key;
          const grp = allGroups(rec.subtree).find((g) => g.tabKeys.includes(existing.key));
          if (!grp || grp.activeKey === existing.key) return {}; // already the active tab
          const nextSub = mapGroup(rec.subtree, grp.id, (g) => ({ ...g, activeKey: existing.key }));
          const nextEntries = [...entries];
          nextEntries[idx] = { ...rec, subtree: nextSub };
          return { detachedGroupsByScope: { ...s.detachedGroupsByScope, [scope]: nextEntries } };
        }
      }

      // Spread first so a stray `key` on the payload can't shadow the minted one;
      // stamp the owning scope (this path never touches the in-window layout, so it
      // does writeScope's scope-stamp itself). Mint the tmux session name like the
      // in-window adds, so a Python/shell run STREAMED into a detached popout (its
      // Run button places the tab here, not via addTabToScope) is persistence-
      // eligible instead of silently skipping the tmux wrap — and apply the
      // project's run-host preference the same way (#238: "+ Shell" in a popout
      // used to ignore the machine every other shell was sent to).
      const key = nextKey(tab.kind);
      const entry: TabEntry = {
        ...withTmuxSession(withRunHostDefault(scope, tab), scope),
        key,
        scope,
      };
      countTabOpen(scope, entry);
      // Land the tab in the requested pane; fall back to the popout's first group
      // (a single-pane popout, or a stale target id).
      const target = findGroup(rec.subtree, targetGroupId) ?? allGroups(rec.subtree)[0];
      if (!target) return {};
      const nextSub = mapGroup(rec.subtree, target.id, (g) => ({
        ...g,
        tabKeys: [...g.tabKeys, key],
        activeKey: key,
      }));
      const nextEntries = [...entries];
      nextEntries[idx] = { ...rec, subtree: nextSub };
      // Append the payload so the MAIN window's pane layer mounts + owns the PTY;
      // the detached window attaches to it after the re-seed.
      const nextTabs = [...(s.tabsByScope[scope] ?? []), entry];
      created = key;
      return {
        tabsByScope: { ...s.tabsByScope, [scope]: nextTabs },
        // Mirror the current-scope convenience copy (writeScope normally does
        // this, but this path leaves the in-window layout untouched and skips it).
        ...(s.scope === scope ? { tabs: nextTabs } : {}),
        detachedGroupsByScope: {
          ...s.detachedGroupsByScope,
          [scope]: nextEntries,
        },
      };
    });
    return created;
  },

  addDetachedTabSplit: (scope, detachedGroupId, tab, targetGroupId, edge) => {
    const key = nextKey(tab.kind);
    // Spread first so a stray `key` can't shadow the minted one; stamp the scope
    // (this path never touches the in-window layout, so no writeScope to do it).
    // Mint the tmux session name and the run-host default too (see
    // addDetachedTab) so a shell tab streamed into a popout via a split-drop is
    // persistence-eligible and lands on the project's chosen machine.
    const entry: TabEntry = {
      ...withTmuxSession(withRunHostDefault(scope, tab), scope),
      key,
      scope,
    };
    let created: string | null = null;
    set((s) => {
      const entries = s.detachedGroupsByScope[scope] ?? [];
      const idx = entries.findIndex((d) => d.id === detachedGroupId);
      if (idx < 0) return {};
      const rec = entries[idx];
      // Carve a new pane holding the tab at `edge` of the target group, leaving
      // the target's own tabs untouched — mirrors `splitWithNewTab`'s edge
      // branch, but on the popout's subtree. A stale target id → no split.
      if (!findGroup(rec.subtree, targetGroupId)) return {};
      countTabOpen(scope, entry);
      const newGroup: GroupNode = {
        type: "group",
        id: nextGroupId(),
        tabKeys: [key],
        activeKey: key,
      };
      const dir: SplitDir = edge === "left" || edge === "right" ? "row" : "column";
      const before = edge === "left" || edge === "top";
      const nextSub = insertAdjacent(rec.subtree, targetGroupId, newGroup, dir, before);
      const nextEntries = [...entries];
      nextEntries[idx] = { ...rec, subtree: nextSub };
      // Append the payload so the MAIN window's pane layer mounts + owns the PTY;
      // the detached window attaches to it after the re-seed.
      const nextTabs = [...(s.tabsByScope[scope] ?? []), entry];
      created = key;
      return {
        tabsByScope: { ...s.tabsByScope, [scope]: nextTabs },
        ...(s.scope === scope ? { tabs: nextTabs } : {}),
        detachedGroupsByScope: { ...s.detachedGroupsByScope, [scope]: nextEntries },
      };
    });
    return created;
  },

  splitDetachedGroup: (scope, detachedGroupId, key, targetGroupId, edge) => {
    set((s) => {
      const entries = s.detachedGroupsByScope[scope] ?? [];
      const idx = entries.findIndex((d) => d.id === detachedGroupId);
      if (idx < 0) return {};
      const nextSub = splitSubtree(entries[idx].subtree, key, targetGroupId, edge);
      if (!nextSub) return {};
      const nextEntries = [...entries];
      nextEntries[idx] = { ...entries[idx], subtree: nextSub };
      return {
        detachedGroupsByScope: { ...s.detachedGroupsByScope, [scope]: nextEntries },
      };
    });
  },

  recoverDetachedGroup: (scope, groupId) => {
    const entry = (get().detachedGroupsByScope[scope] ?? []).find((d) => d.id === groupId);
    if (!entry) return;
    if (get().scope === scope) {
      get().attachGroup(groupId, { skipBackend: true });
    } else {
      get().dropDetachedGroup(scope, groupId, { skipBackend: true });
    }
  },

  respawnDetachedForScope: (scope) => {
    if (getDetachedWindowContext()) return;
    for (const entry of get().detachedGroupsByScope[scope] ?? []) {
      void openDetachedWindow(scope, entry.id);
    }
  },

  dropDetachedGroup: (scope, groupId, opts) => {
    const entries = get().detachedGroupsByScope[scope] ?? [];
    const entry = entries.find((d) => d.id === groupId);
    if (!entry) return;

    set((s) => {
      const remaining = (s.detachedGroupsByScope[scope] ?? []).filter(
        (d) => d.id !== groupId,
      );
      // Re-inject the subtree into the inactive scope's STORED layout so its
      // tabs are referenced by a layout node (and thus persist) on next save.
      const fresh = regenIds(entry.subtree);
      const stored = s.layoutByScope[scope] ?? null;
      let nextLayout: LayoutNode;
      if (!stored) {
        nextLayout = fresh;
      } else {
        const target = allGroups(stored)[0];
        nextLayout = target
          ? insertAdjacent(stored, target.id, fresh, "row", false)
          : fresh;
      }
      return {
        layoutByScope: { ...s.layoutByScope, [scope]: nextLayout },
        detachedGroupsByScope: { ...s.detachedGroupsByScope, [scope]: remaining },
      };
    });

    // Close the detached OS window + drop the parkable override / registry entry.
    if (!opts?.skipBackend) {
      invoke("attach_subwindow", { registryId: entry.label }).catch(() => {});
    }
  },

  hideDetachedGroup: (scope, groupId) => {
    const entries = get().detachedGroupsByScope[scope] ?? [];
    const entry = entries.find((d) => d.id === groupId);
    if (!entry) return;

    set((s) => {
      const remaining = (s.detachedGroupsByScope[scope] ?? []).filter(
        (d) => d.id !== groupId,
      );
      const existing = s.hiddenGroupsByScope[scope] ?? [];
      // The popout's tab payloads never left `tabsByScope`, so the flat pane
      // layer keeps their PTYs mounted through the move — only the subtree
      // changes home, from the detached record to the hidden one. Ids are kept
      // as-is (like `hideGroup`); `unhideGroup` regenerates them on restore to
      // avoid colliding with a live node. Mirror the flat tab list is untouched
      // (no tab payload changes here).
      return {
        detachedGroupsByScope: { ...s.detachedGroupsByScope, [scope]: remaining },
        hiddenGroupsByScope: {
          ...s.hiddenGroupsByScope,
          [scope]: [
            ...existing,
            { id: entry.id, subtree: entry.subtree, label: entry.label },
          ],
        },
      };
    });

    // Close the detached OS window + drop the backend registry entry. The host
    // owns this destruction so the record is gone before Destroyed crash
    // recovery inspects it.
    invoke("attach_subwindow", { registryId: entry.label }).catch(() => {});
  },

  closeDetachedGroup: (scope, groupId) => {
    const entries = get().detachedGroupsByScope[scope] ?? [];
    const entry = entries.find((d) => d.id === groupId);
    if (!entry) return;

    const keys = orderedTabKeys(entry.subtree);
    const byKey = new Map((get().tabsByScope[scope] ?? []).map((t) => [t.key, t] as const));
    // Tear down each tab BEFORE the store mutation: discard its session-only
    // link routes (#50) and kill its PTY. Files/embed tabs have no PTY; terminal
    // tabs (shell/agent/local_agent) do, and since the popout's pane isn't
    // mounted in the main window (it left the layout on detach) and the detached
    // viewer is attach-only, nothing else would ever kill it — do it explicitly.
    const purge = useLinkRoutingStore.getState().purgeForTab;
    for (const key of keys) {
      purge(key);
      const tab = byKey.get(key);
      if (tab && isPtyTabKind(tab.kind)) {
        invoke("pty_kill", { id: `${scope}:${key}` }).catch(() => {});
      }
    }

    set((s) => {
      const remaining = (s.detachedGroupsByScope[scope] ?? []).filter(
        (d) => d.id !== groupId,
      );
      const removing = new Set(keys);
      const nextTabs = (s.tabsByScope[scope] ?? []).filter((t) => !removing.has(t.key));
      const patch: Partial<TabsStore> = {
        detachedGroupsByScope: { ...s.detachedGroupsByScope, [scope]: remaining },
        tabsByScope: { ...s.tabsByScope, [scope]: nextTabs },
      };
      // Mirror the flat tab list when this scope is the active one.
      if (s.scope === scope) patch.tabs = nextTabs;
      return patch;
    });

    // Close the detached OS window after the record is gone; the popout does not
    // self-destroy on an ordinary close because that would race crash recovery.
    invoke("attach_subwindow", { registryId: entry.label }).catch(() => {});
  },

  setDetachedBounds: (scope, groupId, bounds) => {
    set((s) => {
      const entries = s.detachedGroupsByScope[scope];
      if (!entries) return {};
      let changed = false;
      const next = entries.map((d) => {
        if (d.id !== groupId) return d;
        if (
          d.bounds &&
          d.bounds.x === bounds.x &&
          d.bounds.y === bounds.y &&
          d.bounds.w === bounds.w &&
          d.bounds.h === bounds.h
        ) {
          return d;
        }
        changed = true;
        return { ...d, bounds };
      });
      if (!changed) return {};
      return { detachedGroupsByScope: { ...s.detachedGroupsByScope, [scope]: next } };
    });
  },

  setDetachedZoom: (scope, groupId, zoom) => {
    set((s) => {
      const entries = s.detachedGroupsByScope[scope];
      if (!entries) return {};
      let changed = false;
      const next = entries.map((d) => {
        if (d.id !== groupId || d.zoom === zoom) return d;
        changed = true;
        return { ...d, zoom };
      });
      if (!changed) return {};
      return { detachedGroupsByScope: { ...s.detachedGroupsByScope, [scope]: next } };
    });
  },

  consumePendingRespawn: (scope) => {
    const pending = get().pendingRespawnByScope[scope] ?? [];
    if (pending.length === 0) return [];
    set((s) => {
      const rest = { ...s.pendingRespawnByScope };
      delete rest[scope];
      return { pendingRespawnByScope: rest };
    });
    return pending;
  },

  snapshotScopeForSwitch: (scope) => {
    const s = get();
    const layout = s.layoutByScope[scope] ?? null;
    // Resolve the active tab key in one walk: prefer the focused group's active
    // key, falling back to the first group's (Eff #13 — projects.ts previously
    // ran findGroup + allGroups separately for this).
    const focus = s.focusedGroupByScope[scope] ?? null;
    const groups = allGroups(layout);
    const focusedGroup = focus ? groups.find((g) => g.id === focus) : undefined;
    const activeKey = focusedGroup?.activeKey ?? groups[0]?.activeKey ?? null;
    // #55 + restorable filter: keep only scope-owned, restorable tabs — in the
    // order `persistScope` sends, or this save would report the flat list's
    // order (which a tab-bar drag never moves) as a reorder.
    const tabs = persistOrder(layout, s.tabsByScope[scope] ?? []).filter(
      (t) => (t.scope == null || t.scope === scope) && (isRestorableTab(t) || isSavedWhileLive(t)),
    );
    const keepKeys = new Set(tabs.map((t) => t.key));
    const activeTabIndex = Math.max(
      0,
      tabs.findIndex((t) => t.key === activeKey),
    );
    // #42: re-dock detached groups into the persisted tree (detach is
    // session-only; a restart restores them docked), merge BEFORE pruning so
    // dropped tabs prune out consistently. Hidden groups are folded in the same
    // way but tagged `hidden` so they restore still-hidden (not docked live).
    const detached = s.detachedGroupsByScope[scope];
    const hidden = s.hiddenGroupsByScope[scope];
    const merged = withHiddenDocked(
      withDetachedDocked(serializeTree(layout), detached),
      hidden,
    );
    const tabGroups = pruneSavedTree(merged, keepKeys);
    return { tabs, tabGroups, activeTabIndex, workspaceVersion: s.workspaceVersionByScope[scope] };
  },

  closeTabsOfKinds: (kinds) => {
    const drop = new Set<TabKind>(kinds);
    if (drop.size === 0) return;
    const state = get();
    // Collect the doomed keys per scope first, so the side effects below (link
    // routes, prompt state) run once and outside `set`.
    const doomedByScope = new Map<string, Set<string>>();
    for (const scope of Object.keys(state.tabsByScope)) {
      // Keys the popouts own — theirs to withdraw, not ours (see the interface).
      const detached = new Set(
        (state.detachedGroupsByScope[scope] ?? []).flatMap((d) => orderedTabKeys(d.subtree)),
      );
      const doomed = (state.tabsByScope[scope] ?? [])
        .filter((t) => drop.has(t.kind) && !detached.has(t.key))
        .map((t) => t.key);
      if (doomed.length > 0) doomedByScope.set(scope, new Set(doomed));
    }
    if (doomedByScope.size === 0) return;
    for (const [scope, keys] of doomedByScope) {
      for (const key of keys) {
        useLinkRoutingStore.getState().purgeForTab(key);
        forgetPty(`${scope}:${key}`);
        forgetPromptTrail(`${scope}:${key}`);
      }
    }
    set((s) => {
      // Fold scope by scope: `writeScope` derives its maps from the state it is
      // handed, so each iteration must see the previous one's result.
      let cur = s;
      for (const [scope, keys] of doomedByScope) {
        const kept = (cur.tabsByScope[scope] ?? []).filter((t) => !keys.has(t.key));
        const keptKeys = new Set(kept.map((t) => t.key));
        // Parked ("hidden subwindows") groups are not in the live layout, so
        // `writeScope`'s prune never sees them; prune their subtrees here and drop
        // an entry emptied by it, or the panel would list a subwindow with nothing
        // in it.
        const hidden = (cur.hiddenGroupsByScope[scope] ?? [])
          .map((h) => ({ ...h, subtree: pruneCollapseCollect(h.subtree, keptKeys, []) }))
          .filter((h): h is HiddenGroup => h.subtree != null);
        cur = {
          ...cur,
          ...writeScope(
            cur,
            scope,
            kept,
            cur.layoutByScope[scope] ?? null,
            cur.focusedGroupByScope[scope] ?? null,
          ),
          hiddenGroupsByScope: { ...cur.hiddenGroupsByScope, [scope]: hidden },
        };
      }
      return cur;
    });
  },

  loadFromLayout: (layout, defaultCwd, targetScope, groups, opts) => {
    const agentRoots = opts?.agentRoots ?? [];
    // A built-in tab an older build saved carries its command under the app's
    // old name (the backend rewrites saved sessions at launch; this covers a
    // layout that reaches the window any other way). The identity while the
    // name is unchanged.
    layout = layout.map((t) => {
      const cmd = t.cmd ? currentTabCommand(t.cmd) : t.cmd;
      return cmd === t.cmd ? t : { ...t, cmd };
    });
    // A retired kind is dropped first and unconditionally. Unlike the withdrawal
    // below this waits for nothing: the kind does not exist any more, and the
    // fall-through for its unrecognized `cmd` is `"shell"` — so a mail tab saved
    // before the tab was retired would come back as a terminal running
    // `__tabtivity_mail__` rather than as nothing at all.
    layout = layout.filter((t) => !RETIRED_TAB_CMDS.has(t.cmd || ""));
    // A tab whose experimental flag is off does not come back (the restore half of
    // `closeTabsOfKinds`; the sweep only reaches scopes already in memory). Reads
    // the settings store directly because this runs outside React — and does
    // nothing at all until settings have loaded, since `withdrawnTabKinds` treats
    // an unknown settings state as "withdraw nothing" rather than as "everything
    // is off", which would drop a restored browser tab in the gap before the
    // first settings read lands. Dropped entries leave their keys out of `keyMap`, which
    // is exactly how `deserializeTree` prunes them from the saved tree.
    const withdrawn = new Set<TabKind>(
      withdrawnTabKinds(useSettingsStore.getState().settings),
    );
    if (withdrawn.size > 0) {
      layout = layout.filter(
        (t) =>
          !withdrawn.has(
            t.kind ?? cmdToKind(t.cmd || (t.type === "files" ? FILES_TAB_CMD : "")),
          ),
      );
    }
    // A tab comes back once: a layout written while two syncs raced holds the
    // same tab twice (see `persistScope`), under two ids and possibly two keys.
    // The first copy stays; the next sync closes the other.
    const seen = new Set<string>();
    layout = layout.filter((t) => {
      const marks = tabIdentity(t);
      if (marks.some((m) => seen.has(m))) return false;
      for (const m of marks) seen.add(m);
      return true;
    });
    // Map saved keys → fresh keys. Saved keys are only unique within the
    // session that wrote them — two projects can persist the same key. Keys
    // double as PTY ids, so always mint a fresh one on restore.
    const keyMap = new Map<string, string>();
    const scope = targetScope ?? get().scope;
    const tabs: TabEntry[] = layout.map((t) => {
      const entry = restoreSavedTab(t, { defaultCwd, scope, agentRoots });
      keyMap.set(t.key, entry.key);
      return entry;
    });

    // Build the layout tree. With `groups` provided, rebuild from the saved
    // tree; otherwise (legacy) put all tabs in a single root group. Groups tagged
    // `detached` are collected here (with their fresh ids) so the caller can
    // re-open them as floating popouts once their panes have mounted.
    let root: LayoutNode | null = null;
    const respawn: RespawnTarget[] = [];
    // Fresh ids of groups/splits tagged `hidden` in the saved tree. They are
    // built into the tree (so their tabs mint payloads/PTYs) then stripped out
    // into `hiddenGroupsByScope` below, so they restore parked, not docked.
    const hiddenIds: string[] = [];
    if (groups) {
      root = deserializeTree(groups, keyMap, respawn, hiddenIds);
    }
    if (!root && tabs.length > 0) {
      root = {
        type: "group",
        id: nextGroupId(),
        tabKeys: tabs.map((t) => t.key),
        activeKey: tabs[0]?.key ?? null,
      };
    }
    // Any tab not placed by the saved tree (e.g. tree out of sync) → append to
    // the first group so no tab is orphaned.
    if (root) {
      const placed = new Set(orderedTabKeys(root));
      const missing = tabs.filter((t) => !placed.has(t.key)).map((t) => t.key);
      if (missing.length > 0) {
        const first = allGroups(root)[0];
        if (first) {
          root = mapGroup(root, first.id, (g) => ({
            ...g,
            tabKeys: [...g.tabKeys, ...missing],
            activeKey: g.activeKey ?? missing[0],
          }));
        }
      }
    }
    root = collapse(root);

    // Extract hidden-tagged subtrees out of the live tree into parked
    // HiddenGroups (the restore-time mirror of `hideGroup`). Snapshot every node
    // first (ids are stable across sibling strips), then remove them so the tabs
    // stay in `tabsByScope` (payloads/PTYs mounted, hidden) but leave the layout.
    const hiddenGroups: HiddenGroup[] = [];
    for (const id of hiddenIds) {
      const g = findGroup(root, id);
      const sp = g ? null : findSplit(root, id);
      if (!g && !sp) continue;
      const subtree: LayoutNode = g
        ? { type: "group", id: g.id, tabKeys: [...g.tabKeys], activeKey: g.activeKey }
        : (sp as SplitNode);
      hiddenGroups.push({ id, subtree, label: `hidden-${targetScope ?? get().scope}-${id}` });
    }
    for (const h of hiddenGroups) {
      root = removeNodeById(root, h.id);
    }

    const focus = allGroups(root)[0]?.id ?? null;

    // Only respawn targets still present in the (possibly pruned/healed) tree: a
    // detached popout whose tabs were all dropped on restore won't exist. A target
    // id may be a GROUP (single-pane popout) or a SPLIT (multi-pane popout), so
    // check both — `allGroups` alone would drop every split target.
    const pending = respawn.filter(
      (r) => findGroup(root, r.id) != null || findSplit(root, r.id) != null,
    );

    set((s) => {
      // Use the explicitly requested scope when provided; this prevents a race
      // where a stale async resolve would write into whatever scope happens to
      // be current at the time the set() callback runs.
      const scope = targetScope ?? s.scope;
      const base = writeScope(s, scope, tabs, root, focus);
      return {
        ...base,
        pendingRespawnByScope:
          pending.length > 0
            ? { ...s.pendingRespawnByScope, [scope]: pending }
            : s.pendingRespawnByScope,
        hiddenGroupsByScope:
          hiddenGroups.length > 0
            ? { ...s.hiddenGroupsByScope, [scope]: hiddenGroups }
            : s.hiddenGroupsByScope,
      };
    });
  },

  hydrateThenCreateInScope: async ({ scope, cwd, localFile, requestHash, spec }) => {
    // A failed backend read propagates (rejecting the request): swallowing it
    // and creating the tab anyway would let `persistScopeStrict` below OVERWRITE
    // the saved layout with just this one tab. `createEmptyScope` marks a scope
    // whose read succeeded but held nothing restorable as hydrated, so that same
    // persist is licensed to write it.
    await hydrateScopeFromDisk(scope, cwd, { createEmptyScope: true });

    const existing = get().tabsByScope[scope]?.find(
      (tab) => tab.mobileRequestHash === requestHash,
    );
    const created = existing ?? get().addTabToScope(scope, { ...spec, mobileRequestHash: requestHash });
    await get().persistScopeStrict(scope, localFile);
    return created;
  },

  persistScope: (scope, localFile, options) =>
    // One sync per scope at a time: a tab this window opened is id-less until
    // its sync answer hands it the id the service minted. A second sync sent
    // before that answer lands carries the tab id-less again, the service
    // mints it a second id, and that answer brings the copy back as a tab
    // another client opened — the tab then shows twice (a tab detached right
    // after opening stayed in the main window). Each queued run reads the
    // store when it starts, so it sends the ids the earlier answer adopted.
    serializeScopeSync(scope, async () => {
      const layout = get().layoutByScope[scope] ?? null;
      const scopeTabs = get().tabsByScope[scope] ?? [];
      // Whether an EMPTY layout may erase what's on disk. Saving empty is destructive —
      // it drops `tab_layout`/`tab_groups` AND overwrites the `.tabtivity` session mirror,
      // taking a resumable agent tab's `sessionId` (the only handle on its conversation)
      // with them. So it must mean "the user closed every tab", and only two things here
      // can distinguish that from a caller with nothing loaded:
      //
      //   hydrated            — the scope has been restored from disk this session. An
      //                         ABSENT key is a scope we know nothing about; its emptiness
      //                         is ignorance, not intent. (A scope whose restore found no
      //                         restorable tabs never creates the key — see CenterPanel.)
      //   scopeTabs.length    — the scope really holds zero tabs. A scope holding tabs that
      //                         all get filtered out below (non-restorable, or belonging to
      //                         another scope) yields an empty list that looks identical to
      //                         a close-all and is nothing of the sort — that is how
      //                         a live project's four tabs were erased on detach.
      //
      // Anything else: the backend keeps what it has. Worst case we persist a layout one
      // save late; the alternative loses conversations.
      const hydrated = Object.prototype.hasOwnProperty.call(get().tabsByScope, scope);
      // The seeded 3D-blob (`projects3d`, root scope only) is Tabtivity's own default
      // tab, never restorable and never persisted — so a root holding only it IS an
      // empty root, and must license a clear or a closed-back-to-default root would
      // resurrect its old tabs on every relaunch. It only ever exists at root, so
      // excluding it changes nothing for a project scope.
      const meaningfulCount = scopeTabs.filter((t) => t.kind !== "projects3d").length;
      const allowClear = hydrated && meaningfulCount === 0;
      // Order the flat tab union by the tree's stable left-to-right order so the
      // persisted `tabs` array and `groups` tree agree.
      const ordered = persistOrder(layout, scopeTabs);
      // Shell/files/network tabs, resumable agent tabs (Claude with a sessionId), and
      // in-app file-viewer embeds are persisted; other agent/embed tabs (including
      // external-app embeds) are dropped here and the saved tree is pruned to
      // match. See isRestorableTab. Defense-in-depth (#55): also drop any tab not
      // owned by this scope so a foreign tab can never be written into this
      // project's file — `localFile` belongs to `scope`'s project.
      const restorable = ordered.filter(
        (t) => (t.scope == null || t.scope === scope) && (isRestorableTab(t) || isSavedWhileLive(t)),
      );
      const keep = new Set(restorable.map((t) => t.key));
      // Persist the session UUIDs of every open tab that has one (currently
      // Claude agents). Resumable agent tabs also carry their sessionId in
      // `tabLayout`; this separate array keeps UUIDs durable redundantly.
      const sessions = ordered
        .filter((t) => t.sessionId)
        .map((t) => ({ sessionId: t.sessionId, cmd: t.cmd, label: t.label }));
      const priorBase = syncBaseByScope.get(scope);
      const sentBase = syncBaseOf(restorable, ordered);
      try {
        // The persisted per-tab shape lives in ONE place (`toSavedTabEntry`), so
        // this save and the project-switch snapshot cannot drift field-by-field.
        const tabLayout = restorable.map(toSavedTabEntry);
        // #42: re-dock detached groups into the persisted tree so disk reflects a
        // restart-as-docked layout (their tabs are already in the flat list above
        // via get().tabs). Prune AFTER merging so dropped (non-restorable) tabs in
        // a detached group are pruned consistently.
        const detached = get().detachedGroupsByScope[scope];
        const merged = withDetachedDocked(serializeTree(layout), detached);
        const groups = pruneSavedTree(merged, keep);
        // The layout is keyed by PROJECT ID now, not by the path to a
        // project.json: it lives in the state dir, because the host reads it back
        // as commands to run and its old home was inside the container's
        // writable mount. `scope` IS the project id — or the literal `"root"`,
        // which now persists too (under `<state_dir>/sessions/root/`), so the
        // root scope's shells/files/viewers survive a relaunch like a project's.
        // `project_key("root")` is `"root"`, and the root scope has no
        // project.json, so `localFile` is empty and the backend simply skips the
        // export copy for it.
        //
        // This is no longer a whole-snapshot save (headless owner plan, H1): the
        // service merges what changed since `baseVersion` — the version this
        // window last received — onto the shared set, so a tab another client
        // opened meanwhile survives, and one it closed stays closed. The answer
        // carries the ids of the tabs this window created.
        const payload = {
          projectId: scope,
          localFile,
          tabs: tabLayout,
          groups,
          sessions,
          allowClear,
        };
        // What is sent is what this window now holds the shared set to be: an
        // edit made while the answer is in flight differs from it and outlives
        // that answer (`adoptSyncOutcome`).
        syncBaseByScope.set(scope, sentBase);
        const outcome = await syncWorkspace({ ...payload, baseVersion: get().workspaceVersionByScope[scope] });
        if (outcome) adoptSyncOutcome(scope, outcome, keep);
      } catch (error) {
        // A save that failed agreed on nothing.
        if (syncBaseByScope.get(scope) === sentBase) {
          if (priorBase) syncBaseByScope.set(scope, priorBase);
          else syncBaseByScope.delete(scope);
        }
        if (options?.strict) throw error;
        // tab layout is non-critical
      }
    }),

  persistScopeStrict: async (scope, localFile) => {
    await get().persistScope(scope, localFile, { strict: true });
  },

  /**
   * Persist the CURRENT scope into `localFile`.
   *
   * Prefer `persistScope(scope, localFile)`. This overload pairs the store's live
   * `scope` with a `localFile` the caller supplies, and those are two independently
   * tracked values: whenever they drift, this writes one project's tabs into another
   * project's file — or, once the per-scope filter has dropped every foreign tab, an
   * empty layout, which used to erase the target's tabs outright. That is exactly how
   * a live project lost four of them on detach (which swaps `local_file` under the store).
   * The backend now refuses an unvouched empty save, so this can no longer destroy
   * anything, but the mismatch is still wrong at the source. No production caller
   * remains — CenterPanel passes its scope explicitly, and `detached.ts` derives
   * `localFile` FROM the scope. Kept for the tests that drive it directly.
   */
  saveLayout: async (localFile) => {
    await get().persistScope(get().scope, localFile);
  },
}));

// A detached window can fail to build while a display is being removed, or
// while Wayland is still retiring its previous window under the same label.
// Keep its layout detached through those failures. Only an exhausted retry may
// dock it back, so a transient OS event cannot rewrite the saved window layout;
// the retries span ~3.5 min because switching to one screen reconfigures the
// outputs in several steps, seconds apart, and a 30 s span still docked popouts
// when a screen was disconnected.
const openingDetachedWindows = new Map<string, Promise<void>>();
const detachedOpenDelays = [0, 300, 900, 1800, 3600, 7200, 15000, ...Array<number>(6).fill(30_000)];

function openDetachedWindow(scope: string, groupId: string): Promise<void> {
  const label = `detached-${scope}-${groupId}`;
  const pending = openingDetachedWindows.get(label);
  if (pending) return pending;
  const task = (async () => {
    for (const delay of detachedOpenDelays) {
      if (delay) await new Promise<void>((resolve) => setTimeout(resolve, delay));
      const entry = (useTabsStore.getState().detachedGroupsByScope[scope] ?? [])
        .find((d) => d.id === groupId);
      if (!entry) return;
      const b = entry.bounds;
      try {
        await invoke("detach_subwindow", {
          projectId: scope,
          groupId,
          x: b?.x ?? null,
          y: b?.y ?? null,
          width: b?.w ?? null,
          height: b?.h ?? null,
        });
        return;
      } catch {
        // The next attempt uses the latest bounds, including a monitor move.
      }
    }
    useTabsStore.getState().recoverDetachedGroup(scope, groupId);
  })().finally(() => {
    openingDetachedWindows.delete(label);
  });
  openingDetachedWindows.set(label, task);
  return task;
}

/**
 * Hydrate a scope from its saved tab session on disk — THE one implementation
 * of "read `load_tab_session`, filter to restorable tabs, `loadFromLayout`".
 * The root restore (CenterPanel), the box restore (`stores/boxes`), the
 * background project restore (`stores/projects`) and the Mobile
 * `hydrateThenCreateInScope` all hydrate through here; the four hand-rolled
 * copies this replaces had already drifted (root/box omitted `resumeArgs` from
 * the restorable probe, so a saved custom-agent tab — restorable only via
 * `resumeArgs?.length` — restored in a project scope and silently vanished in
 * root/box scopes).
 *
 * Returns true when the scope is hydrated — by this call, or concurrently by
 * another path (in-memory state wins; disk is never re-read over it). Returns
 * false when the saved layout held nothing restorable; the scope key is then
 * NOT created (unless `createEmptyScope`), because an absent key is exactly
 * what tells `persistScope` "never hydrated" and keeps a later empty save from
 * erasing the on-disk layout. Callers seed their scope's default tab on false.
 * A failed backend read throws — each caller decides whether that seeds a
 * default or aborts.
 *
 * `defaultCwd` may be a thunk for callers whose fallback cwd is itself an IPC
 * away (the root scope's `root_work_dir`); it is only awaited once restorable
 * tabs are known to exist, and the hydration guard is re-checked after it.
 */
export async function hydrateScopeFromDisk(
  scope: string,
  defaultCwd: string | (() => Promise<string>),
  opts: { createEmptyScope?: boolean } & LoadFromLayoutOptions = {},
): Promise<boolean> {
  const hydrated = () =>
    Object.prototype.hasOwnProperty.call(useTabsStore.getState().tabsByScope, scope);
  if (hydrated()) return true;
  const saved = await loadWorkspaceSnapshot(scope);
  // The ordinary UI (or another request) may have hydrated the same scope while
  // the backend read was in flight. Never overwrite that newer live state.
  if (hydrated()) return true;
  // What this window now knows the scope as; its first sync names it as base.
  if (typeof saved.version === "number") {
    useTabsStore.setState((state) => ({
      workspaceVersionByScope: { ...state.workspaceVersionByScope, [scope]: saved.version as number },
    }));
  }
  const restorable = ((saved.tabLayout as SavedTabEntry[] | undefined) ?? []).filter((tab) =>
    isRestorableTab({
      kind: tab.kind ?? cmdToKind(tab.cmd || (tab.type === "files" ? FILES_TAB_CMD : "")),
      cmd: tab.cmd,
      sessionId: tab.sessionId,
      resumeArgs: tab.resumeArgs,
      viewer: tab.viewer,
      localLaunch: tab.localLaunch,
    }),
  );
  if (restorable.length === 0) {
    if (opts.createEmptyScope) {
      useTabsStore.setState((state) => ({
        tabsByScope: { ...state.tabsByScope, [scope]: [] },
        layoutByScope: { ...state.layoutByScope, [scope]: null },
        focusedGroupByScope: { ...state.focusedGroupByScope, [scope]: null },
      }));
    }
    return false;
  }
  const cwd = typeof defaultCwd === "function" ? await defaultCwd() : defaultCwd;
  if (hydrated()) return true;
  useTabsStore
    .getState()
    .loadFromLayout(restorable, cwd, scope, (saved.tabGroups as SavedLayoutTree | undefined) ?? undefined, {
      agentRoots: opts.agentRoots,
    });
  // The restored tabs are the shared set as this window first agrees on it,
  // in the stored order (restored in that order, so the list holds it).
  const restored = useTabsStore.getState().tabsByScope[scope] ?? [];
  syncBaseByScope.set(scope, syncBaseOf(restored, restored));
  return true;
}

// ── The workspace service (headless owner plan, H1) ─────────────────────────
//
// The scope's tab set is shared with every other client of this state dir
// (a second window, the Mobile sidecar); the backend's `services::workspace`
// merges per client rather than letting the last whole snapshot win. Both
// calls fall back to the pre-service commands when the running backend
// predates them (a dev window hot-reloading `src/` against an older binary),
// so a stale backend costs the merge, never the persistence.

/** What `workspace_sync` answers: the version now on disk and the stored tabs,
 * each carrying its `id` under the `key` this window sent. */
export interface WorkspaceSyncOutcome {
  version: number;
  tabs: SavedTabEntry[];
  ops: { op: string; id?: string }[];
  stale: boolean;
}

export interface WorkspaceSyncPayload {
  projectId: string;
  localFile: string;
  baseVersion?: number;
  tabs: SavedTabEntry[];
  groups: SavedLayoutTree | null;
  sessions: unknown;
  allowClear: boolean;
}

function isUnknownCommand(error: unknown): boolean {
  return /(?:command\b.*\bnot found|unknown command|not allowed)/i.test(String(error));
}

/** Sync a scope through the workspace service, or through the whole-snapshot
 * save on a backend without it (which then answers nothing). */
const scopeSyncTails = new Map<string, Promise<unknown>>();

/** Run `task` once every earlier sync of `scope` has settled (see
 * `persistScope`). An idle scope runs it at once, so the IPC still leaves in
 * the caller's tick. The returned promise rejects only with `task`'s own
 * error; a failed earlier run never blocks a later one. */
function serializeScopeSync(scope: string, task: () => Promise<void>): Promise<void> {
  const prior = scopeSyncTails.get(scope);
  const run = prior ? prior.then(task, task) : task();
  const tail = run.catch(() => {});
  scopeSyncTails.set(scope, tail);
  void tail.then(() => {
    if (scopeSyncTails.get(scope) === tail) scopeSyncTails.delete(scope);
  });
  return run;
}

export async function syncWorkspace(payload: WorkspaceSyncPayload): Promise<WorkspaceSyncOutcome | undefined> {
  try {
    return (await invoke<WorkspaceSyncOutcome | undefined>("workspace_sync", { ...payload })) ?? undefined;
  } catch (error) {
    if (!isUnknownCommand(error)) throw error;
    const { baseVersion: _base, ...legacy } = payload;
    await invoke("save_tab_layout", { ...legacy });
    return undefined;
  }
}

/** A scope's saved session with its workspace version, or the plain session
 * (no version) from a backend without the service. */
async function loadWorkspaceSnapshot(scope: string): Promise<Record<string, unknown>> {
  try {
    return (await invoke<Record<string, unknown>>("workspace_snapshot", { projectId: scope })) ?? {};
  } catch (error) {
    if (!isUnknownCommand(error)) throw error;
    return invoke<Record<string, unknown>>("load_tab_session", { projectId: scope });
  }
}

/** A scope's shared set as this window last sent or took it. */
interface SyncBase {
  /** Label and colour by tab key, as last sent or taken. */
  fields: Map<string, { label: string; color?: TabColor }>;
  /** The tab keys in the shared order as last sent or taken. */
  order: string[];
}

/** Per scope, what this window and the shared set last agreed on (see
 * `adoptSyncOutcome`). Absent for a scope never hydrated or saved: an answer
 * is then taken whole. */
const syncBaseByScope = new Map<string, SyncBase>();

/** Tests reuse tab keys across cases; a real session never does. */
export function _resetSyncBaseForTest(): void {
  syncBaseByScope.clear();
}

function syncBaseOf(fields: readonly TabEntry[], order: readonly TabEntry[]): SyncBase {
  return {
    fields: new Map(fields.map((t) => [t.key, { label: t.label, color: t.color }] as const)),
    order: order.map((t) => t.key),
  };
}

/** The order a scope's tabs are saved in — the shared order as this window
 * states it: its pane tree left to right, then any tab the tree does not
 * place (a popout's, a parked group's) in list order. */
function persistOrder(layout: LayoutNode | null, tabs: readonly TabEntry[]): TabEntry[] {
  const keyOrder = orderedTabKeys(layout);
  const byKey = new Map(tabs.map((t) => [t.key, t] as const));
  const ordered = keyOrder.map((k) => byKey.get(k)).filter((t): t is TabEntry => t != null);
  const placed = new Set(keyOrder);
  for (const t of tabs) {
    if (!placed.has(t.key)) ordered.push(t);
  }
  return ordered;
}

/** `items` with the ones `rank` names put in its order, each into a slot one
 * of them held; the rest keep theirs. The same array when nothing moved. */
function inSharedOrder<T>(items: T[], keyOf: (item: T) => string, rank: ReadonlyMap<string, number>): T[] {
  const ranked = items.filter((item) => rank.has(keyOf(item)));
  const sorted = [...ranked].sort((a, b) => (rank.get(keyOf(a)) ?? 0) - (rank.get(keyOf(b)) ?? 0));
  if (sorted.every((item, i) => item === ranked[i])) return items;
  let next = 0;
  return items.map((item) => (rank.has(keyOf(item)) ? sorted[next++] : item));
}

/** The shared order as this window's panes show it: each pane keeps its own
 * tabs, in the shared order. A move across panes has no slot to land in, as
 * in `reorderTabInScope`, and the owner refuses one
 * (`workspace::reorder_tab_in`), so the panes left to right then read as the
 * shared order again. The same tree when nothing moved. */
function followSharedOrder(node: LayoutNode, rank: ReadonlyMap<string, number>): LayoutNode {
  if (node.type === "group") {
    const tabKeys = inSharedOrder(node.tabKeys, (k) => k, rank);
    return tabKeys === node.tabKeys ? node : { ...node, tabKeys };
  }
  const children = node.children.map((c) => followSharedOrder(c, rank));
  return children.every((c, i) => c === node.children[i]) ? node : { ...node, children };
}

function sameKeys(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((k, i) => k === b[i]);
}

/** The live entry a saved tab restores as — THE one place a `SavedTabEntry`
 * becomes a `TabEntry`: `loadFromLayout` maps every saved tab through it,
 * and `adoptSyncOutcome` a tab another client of this backend created
 * (headless owner plan, H3). Mints a fresh key (keys double as PTY ids and
 * are only unique within the session that wrote them) and keeps the shared
 * `id`; a resumable agent gets its resume args from the static table, never
 * from the file. */
function restoreSavedTab(
  t: SavedTabEntry,
  ctx: { defaultCwd: string; scope: string; agentRoots: readonly string[] },
): TabEntry {
  const kind =
    t.kind ??
    cmdToKind(t.cmd || (t.type === "files" ? FILES_TAB_CMD : ""));
  // Agent tabs start in the current project dir so stale saved cwds don't
  // put the agent in the wrong directory after a project move/rename — with
  // two exceptions, both places the scope *derives* rather than remembers: a
  // cwd under THIS root's `.tabtivity/worktrees/` is a linked worktree the agent
  // was deliberately started in, and a box scope's member root (or a
  // worktree under one) is where its per-member Claude tab was started.
  // Resetting those put the agent in the wrong directory and, on the CLI of
  // the day, made `--resume` come back as a fresh conversation
  // (`restoredAgentCwd`).
  const isAgent = kind === "agent" || kind === "local_agent";
  const freshKey = nextKey(kind);
  // Resumable agent tabs (Claude with a sessionId) respawn with their
  // resume flag so the prior conversation comes back; everyone else starts
  // fresh with no args.
  const tabShape = {
    kind,
    cmd: t.cmd,
    sessionId: t.sessionId,
    scheduleTargetId: isAgent ? (t.scheduleTargetId ?? crypto.randomUUID()) : undefined,
    resumeArgs: t.resumeArgs,
  };
  // A built-in looks its cmd up in the static table; only a custom agent
  // falls back to the resume flag carried on the tab.
  //
  // The table is preferred **whenever it has an entry**, rather than letting a
  // persisted `resumeArgs` win: the layout this is read from lives inside the
  // project tree, i.e. inside a container's writable mount and inside any
  // cloned repo, so a persisted arg vector is attacker-controlled. It used to
  // be handed to `pty_spawn` verbatim, which turned "write a file in my
  // project" into "choose the argv of a host-bound agent CLI". For a built-in
  // the table produces the same args anyway, so preferring it costs nothing.
  // A custom agent's flag is re-derived from `settings.json` by the backend
  // sanitizer (`terminal_service::sanitize_tab_layout`) before it reaches here.
  // A relaunchable local-model tab runs its launch line again: the backend
  // re-validated it against the driver table on load (`localLaunch`).
  const localLaunch =
    kind === "local_agent" && isRelaunchableLocalTab({ kind, localLaunch: t.localLaunch })
      ? t.localLaunch
      : undefined;
  const base =
    isResumableAgentTab(tabShape) && t.sessionId
      ? t.cmd in RESUMABLE_AGENTS
        ? RESUMABLE_AGENTS[t.cmd](t.sessionId)
        : (t.resumeArgs ?? [])
      : localLaunch
        ? [...localLaunch.args]
        : [];
  // No permission-mode flag is folded in here, and a layout written before
  // that toggle was removed carries an `agentMode` this ignores. An agent
  // restores on the plain resume command and picks its mode up where it
  // keeps it: Claude's own hook record, re-applied by the backend's
  // `--resume` rewrite (`services::agent_session`), and for every other
  // agent whatever its CLI does on resume.
  const args = base;
  // Every resumable agent tab's TABTIVITY_TAB_UID is its `sessionId`
  // (`buildStaticTabSpec` sets both from one uuid). The backend binds the
  // agent's turn reports by it, and for Codex and Vibe — whose `sessionId`
  // is Tabtivity's stable *binding* key rather than a CLI argument — resolves
  // the conversation to resume from it. Rebuild it from the durable
  // sessionId rather than read it from `env`: a layout written before the
  // key was persisted, a stale one whose env disagrees, and one adopted from
  // a folder or an import bundle (which carries no `env` at all, gap 17)
  // would otherwise lose the binding. It is not a user-configurable
  // environment override.
  const env = { ...(t.env ?? {}) };
  if (isResumableAgentTab(tabShape) && t.sessionId) {
    env[envName("TAB_UID")] = t.sessionId;
  }
  return {
    key: freshKey,
    // The shared-set identity survives the re-mint: it is how the next
    // sync tells this tab from a new one.
    id: t.id,
    label: t.label,
    cmd: t.cmd,
    args,
    env,
    cwd: isAgent && ctx.defaultCwd ? restoredAgentCwd(t.cwd, ctx.defaultCwd, ctx.agentRoots) : t.cwd || ctx.defaultCwd,
    kind,
    sessionId: t.sessionId,
    // The binding into agent_tasks.json. Kept from the layout when it has one,
    // minted here otherwise (a layout written before schedules existed) — it
    // used to be computed on `tabShape` only and never reach the entry, so a
    // restored agent tab had no target: no ◷ on the desktop, `tab_not_found`
    // on the phone, and the startup orphan sweep deleting every schedule.
    scheduleTargetId: tabShape.scheduleTargetId,
    // A restart-resumable custom agent keeps its resume flag (already folded
    // into `base`/`args` above) so a *second* restart resumes it again.
    resumeArgs: t.resumeArgs,
    // Restored file embed tabs (kind === "embed") carry their durable path
    // and how to open it so the pane rebuilds exactly.
    embedPath: t.embedPath,
    embedExec: t.embedExec,
    viewer: t.viewer,
    viewerState: t.viewerState,
    // SSH-sync Phase 0: restore the persisted per-tab locality.
    location: t.location,
    // A "projectfiles" tab reopens on the folder it was browsed into.
    folder: t.folder,
    // A "browser" tab reopens holding the address it was last on — on its
    // resume card, NOT navigated (see BROWSER_TAB_CMD / isRestorableKind).
    url: t.url,
    // Persistent sessions (TODO #85): keep the stable session name so the
    // reattach targets the SAME host session after a relaunch. Mint one for a
    // shell tab — or a resumable agent tab (only restorable tabs reach here) —
    // persisted before this feature existed (it then reattaches on every
    // subsequent restart).
    tmuxSession:
      t.tmuxSession ??
      ((kind === "shell" || kind === "agent" || kind === "local_agent") && !t.tmuxAttach
        ? newTmuxSessionName(ctx.scope, kind === "shell" ? "shell" : "agent")
        : undefined),
    // A Sessions-view attach tab reattaches to its tmux session on restart.
    tmuxAttach: t.tmuxAttach,
    // Carry the host-bound marker id so a restored local-model tab keeps its
    // exemption. Never minted here: a uid without a registered marker file
    // grants nothing, and minting one on restore would be inventing an
    // authority the user never asked for.
    hostBoundUid: t.hostBoundUid,
    mobileRequestHash: t.mobileRequestHash,
    localLaunch,
    // A Host session never auto-resumes after a restart: it comes back
    // paused and waits for an explicit Resume (only in the root scope,
    // the one place the marker means anything).
    ...(t.hostSession && (ctx.scope) === ROOT_SCOPE
      ? { hostSession: true, hostSessionPaused: true }
      : {}),
    // Restore the no-tmux marker BEFORE anything reads it: the minted name
    // above is harmless on such a tab precisely because `shouldPersistTab`
    // refuses to use it.
    ephemeral: t.ephemeral,
    // A tab that was continuing itself across rate-limit windows keeps doing
    // so after a relaunch. Only the switch comes back: `AgentContinueHost`
    // re-reads the CLI's usage panel and arms a fresh window.
    autoContinue: t.autoContinue,
    // The user's tab colour. Validated against the palette on the way in
    // rather than trusted: this layout is a file on disk, and an id that is
    // not in `TAB_COLORS` would reach `--tab-accent` as raw CSS.
    color: isTabColor(t.color) ? t.color : undefined,
    // Its tab group, likewise from the file: plain text, capped.
    stack: normalizeStackName(t.stack),
    mark: isTabMark(t.mark) ? t.mark : undefined,
      todoId: normalizeTodoId(t.todoId),
    };
}

/** What makes two tabs the same tab: its key, the file a viewer shows, the
 * tmux session a terminal owns, the agent conversation it resumes. A
 * duplicate (`duplicateSpec`) mints a fresh session and conversation, so no
 * two tabs of a scope share any of these on purpose. */
function tabIdentity(t: {
  key?: string;
  kind?: TabKind;
  cmd?: string;
  embedPath?: string;
  tmuxSession?: string;
  sessionId?: string;
}): string[] {
  const marks: string[] = t.key ? [`key:${t.key}`] : [];
  if ((t.kind ?? cmdToKind(t.cmd || "")) === "embed" && t.embedPath) marks.push(`file:${t.embedPath}`);
  if (t.tmuxSession) marks.push(`tmux:${t.tmuxSession}`);
  if (t.sessionId) marks.push(`session:${t.sessionId}`);
  return marks;
}

/** Take a sync answer into the store: the scope's new version; the ids the
 * service minted for the tabs this window created (matched by the `key` it
 * sent); and what another client changed meanwhile — a label or colour the
 * service kept over this window's older copy is adopted, and a tab this
 * window sent (`sentKeys`) that the answer no longer holds was closed
 * elsewhere and leaves the store (the session behind it keeps running, as a
 * close from the phone always meant).
 *
 * "Older copy" is judged against `syncBaseByScope`, what this window last
 * sent or took: a label, colour or order changed here since then is an edit
 * the next save carries, and the answer does not undo it. The answer's order
 * reaches the panes through `followSharedOrder`. An answer older than the
 * version this window already holds hands over its minted ids and nothing
 * else. */
export function adoptSyncOutcome(scope: string, outcome: WorkspaceSyncOutcome, sentKeys?: Set<string>): void {
  const idByKey = new Map<string, string>();
  const byId = new Map<string, SavedTabEntry>();
  for (const tab of outcome.tabs ?? []) {
    if (tab.id && tab.key) idByKey.set(tab.key, tab.id);
    if (tab.id) byId.set(tab.id, tab);
  }
  // Arrays are replaced only when a tab changed: CenterPanel saves 300 ms
  // after any new `tabs` array, so a fresh array from every answer made each
  // save schedule the next one, for as long as the window stayed open.
  const mapTabs = (tabs: TabEntry[], fn: (t: TabEntry) => TabEntry): TabEntry[] => {
    const next = tabs.map(fn);
    return next.some((t, i) => t !== tabs[i]) ? next : tabs;
  };
  const withId = (t: TabEntry): TabEntry => {
    const id = t.id ?? idByKey.get(t.key);
    return id && !t.id ? { ...t, id } : t;
  };
  // An answer older than the version this window already took (a patch
  // landed while it was in flight) is older knowledge: its fields, closes
  // and order would undo that patch, and the version never moves back. Only
  // the ids it minted for this window's new tabs are news.
  if (outcome.version < (useTabsStore.getState().workspaceVersionByScope[scope] ?? 0)) {
    useTabsStore.setState((state) => {
      const held = state.tabsByScope[scope];
      const next = held ? mapTabs(held, withId) : held;
      return held && next !== held
        ? {
            tabsByScope: { ...state.tabsByScope, [scope]: next },
            ...(state.scope === scope ? { tabs: mapTabs(state.tabs, withId) } : {}),
          }
        : {};
    });
    return;
  }
  // A tab another client created after the version this window knew (a
  // phone's ＋ or reopen through the owner, headless owner plan H3) joins the
  // scope's focused group, restored exactly as a hydrate restores it and
  // without stealing the active tab. Bounded by `createdVersion`: a tab this
  // window closed but has not persisted yet is older than its base, so a
  // fetched snapshot cannot bring it back. Only a loaded scope; a scope this
  // window has not hydrated takes the whole snapshot at its hydrate.
  const before = useTabsStore.getState();
  const known = before.workspaceVersionByScope[scope] ?? 0;
  const heldIds = new Set((before.tabsByScope[scope] ?? []).map((t) => t.id).filter((id): id is string => !!id));
  // The answer echoes every tab under the key its sender gave it (the owner
  // keys its own `headless-<uuid>`), so a tab under a key this window holds
  // is this window's own, never an arrival — or it would open twice on the
  // same tmux session. That is a tab still id-less until this answer hands it
  // its minted id (`reconcile` below matches it by key; the `workspace:patch`
  // echo of this window's sync can land before the answer, so the patch path
  // meets it too), or one under a second id from a file written while two
  // syncs raced, before `persistScope` queued them. And one file is one tab:
  // an arriving viewer of a file this scope already shows — in the window or
  // in a popout — is not opened again, nor a second tab on a tmux session or
  // agent conversation one already runs (`tabIdentity`). Whatever is left out
  // here closes at this window's next sync.
  const held = new Set((before.tabsByScope[scope] ?? []).flatMap(tabIdentity));
  // The same gates `loadFromLayout` applies to a hydrate: a built-in tab's
  // command under the app's old name is rewritten first, a retired kind and a
  // kind whose experimental flag is off never come back.
  const withdrawn = new Set<TabKind>(withdrawnTabKinds(useSettingsStore.getState().settings));
  const kindOf = (t: SavedTabEntry): TabKind => t.kind ?? cmdToKind(t.cmd || (t.type === "files" ? FILES_TAB_CMD : ""));
  const arrived = Object.prototype.hasOwnProperty.call(before.tabsByScope, scope)
    ? (outcome.tabs ?? [])
        .map((t) => {
          const cmd = t.cmd ? currentTabCommand(t.cmd) : t.cmd;
          return cmd === t.cmd ? t : { ...t, cmd };
        })
        .filter(
          (t) =>
            !!t.id &&
            !heldIds.has(t.id) &&
            !tabIdentity(t).some((m) => held.has(m)) &&
            (t.createdVersion ?? 0) > known &&
            !RETIRED_TAB_CMDS.has(t.cmd || "") &&
            !withdrawn.has(kindOf(t)) &&
            isRestorableTab({
              kind: kindOf(t),
              cmd: t.cmd,
              sessionId: t.sessionId,
              resumeArgs: t.resumeArgs,
              viewer: t.viewer,
              localLaunch: t.localLaunch,
            }),
        )
    : [];
  if (arrived.length > 0) {
    const entries = arrived.map((t) => restoreSavedTab(t, { defaultCwd: t.cwd, scope, agentRoots: [] }));
    useTabsStore.setState((s) => {
      const tabs = [...(s.tabsByScope[scope] ?? []), ...entries];
      const keys = entries.map((e) => e.key);
      const layout = s.layoutByScope[scope] ?? null;
      const focusedGroupId = s.focusedGroupByScope[scope] ?? null;
      if (!layout) {
        const root: GroupNode = { type: "group", id: nextGroupId(), tabKeys: keys, activeKey: keys[0] };
        return writeScope(s, scope, tabs, root, root.id);
      }
      const target = (focusedGroupId && findGroup(layout, focusedGroupId)) || allGroups(layout)[0];
      const next = mapGroup(layout, target.id, (g) => ({ ...g, tabKeys: [...g.tabKeys, ...keys], activeKey: g.activeKey ?? keys[0] }));
      return writeScope(s, scope, tabs, next, target.id);
    });
  }
  // A label or colour this window changed since it last agreed with the
  // shared set (`syncBaseByScope`) is an edit its next save carries — made
  // while this answer's save was in flight, or not sent yet — and stays; any
  // other field takes the answer, which the window now agrees on.
  const base = syncBaseByScope.get(scope);
  const fields = new Map(base?.fields);
  const reconcile = (t: TabEntry): TabEntry => {
    let next = withId(t);
    const held = next.id ? byId.get(next.id) : undefined;
    if (held) {
      const agreed = base?.fields.get(t.key);
      const color = isTabColor(held.color) ? held.color : undefined;
      const ownLabel = agreed !== undefined && agreed.label !== next.label;
      const ownColor = agreed !== undefined && agreed.color !== next.color;
      if (!ownLabel && held.label !== next.label) next = { ...next, label: held.label };
      if (!ownColor && color !== next.color) next = { ...next, color };
      fields.set(t.key, {
        label: ownLabel ? agreed.label : held.label,
        color: ownColor ? agreed.color : color,
      });
    }
    return next;
  };
  // A tab closed elsewhere leaves through the store's own remover, so its
  // pane and the layout tree follow.
  const closedElsewhere = (useTabsStore.getState().tabsByScope[scope] ?? [])
    .filter((t) => !!t.id && !byId.has(t.id) && !!sentKeys?.has(t.key))
    .map((t) => t.key);
  for (const key of closedElsewhere) useTabsStore.getState().removeTabInScope(scope, key);
  useTabsStore.setState((state) => {
    const held = state.tabsByScope[scope];
    const next = held ? mapTabs(held, reconcile) : held;
    return {
      workspaceVersionByScope: { ...state.workspaceVersionByScope, [scope]: outcome.version },
      ...(held && next !== held
        ? {
            tabsByScope: { ...state.tabsByScope, [scope]: next },
            ...(state.scope === scope ? { tabs: mapTabs(state.tabs, reconcile) } : {}),
          }
        : {}),
    };
  });
  // The order: the answer's, as this window's keys. Unless this window
  // reordered the tabs both know since it last agreed — that order is its
  // next save's — the panes and the list follow it, so that save does not
  // send the tree's older order back as a reorder of its own.
  const after = useTabsStore.getState();
  const tabs = after.tabsByScope[scope] ?? [];
  const keyById = new Map(tabs.filter((t) => !!t.id).map((t) => [t.id, t.key] as const));
  const shared = [...new Set((outcome.tabs ?? []).map((t) => (t.id ? keyById.get(t.id) : undefined)))].filter(
    (k): k is string => !!k,
  );
  const local = persistOrder(after.layoutByScope[scope] ?? null, tabs).map((t) => t.key);
  const among = (keys: readonly string[], set: readonly string[]) => {
    const within = new Set(set);
    return keys.filter((k) => within.has(k));
  };
  const localShared = among(local, shared);
  const ownOrder = !!base && !sameKeys(among(localShared, base.order), among(base.order, localShared));
  if (!ownOrder && !sameKeys(localShared, shared)) {
    const rank = new Map(shared.map((k, i) => [k, i] as const));
    useTabsStore.setState((s) => {
      const layout = s.layoutByScope[scope] ?? null;
      const nextLayout = layout ? followSharedOrder(layout, rank) : layout;
      const held = s.tabsByScope[scope] ?? [];
      const nextTabs = inSharedOrder(held, (t) => t.key, rank);
      if (nextLayout === layout && nextTabs === held) return {};
      return writeScope(s, scope, nextTabs, nextLayout, s.focusedGroupByScope[scope] ?? null);
    });
  }
  syncBaseByScope.set(scope, { fields, order: ownOrder && base ? base.order : shared });
}

/** The `workspace:patch` event's payload (`WORKSPACE_PATCH_EVENT`). */
export interface WorkspacePatch {
  scope: string;
  version: number;
  ops: WorkspaceSyncOutcome["ops"];
}

/** Another client of this backend moved a scope's shared tab set: when the
 * patch is newer than what this window knows and the scope is loaded here,
 * fetch the snapshot and reconcile through `adoptSyncOutcome`, every tab this
 * window holds counting as sent. A window's own sync echoes here too — its
 * answer has usually recorded the version first, and the fetch is idempotent
 * otherwise. A scope this window has not hydrated takes the snapshot at its
 * hydrate. */
export async function applyWorkspacePatch(patch: WorkspacePatch): Promise<void> {
  const known = () => useTabsStore.getState().workspaceVersionByScope[patch.scope] ?? 0;
  const loaded = () => Object.prototype.hasOwnProperty.call(useTabsStore.getState().tabsByScope, patch.scope);
  if (!loaded() || patch.version <= known()) return;
  const saved = await loadWorkspaceSnapshot(patch.scope);
  if (typeof saved.version !== "number" || !loaded() || saved.version <= known()) return;
  const sent = new Set((useTabsStore.getState().tabsByScope[patch.scope] ?? []).map((t) => t.key));
  adoptSyncOutcome(
    patch.scope,
    { version: saved.version, tabs: (saved.tabLayout as SavedTabEntry[] | undefined) ?? [], ops: patch.ops, stale: true },
    sent,
  );
}

/** Re-read a scope's shared tab set because the owner wrote it with no
 * window answering (a `refresh` poke from the Mobile sidecar, headless owner
 * plan H3): when the scope is loaded here and the stored version is newer
 * than this window knows, reconcile through `adoptSyncOutcome` with every
 * held tab counting as sent. */
export async function refreshWorkspaceScope(scope: string): Promise<void> {
  const loaded = () => Object.prototype.hasOwnProperty.call(useTabsStore.getState().tabsByScope, scope);
  if (!loaded()) return;
  const saved = await loadWorkspaceSnapshot(scope);
  const known = useTabsStore.getState().workspaceVersionByScope[scope] ?? 0;
  if (typeof saved.version !== "number" || !loaded() || saved.version <= known) return;
  const sent = new Set((useTabsStore.getState().tabsByScope[scope] ?? []).map((t) => t.key));
  adoptSyncOutcome(
    scope,
    { version: saved.version, tabs: (saved.tabLayout as SavedTabEntry[] | undefined) ?? [], ops: [], stale: true },
    sent,
  );
}

/** Replace the group `groupId` via `fn`, returning a new tree (structural). */
export function mapGroup(
  node: LayoutNode,
  groupId: string,
  fn: (g: GroupNode) => GroupNode,
): LayoutNode {
  if (node.type === "group") {
    return node.id === groupId ? fn(node) : node;
  }
  return {
    ...node,
    children: node.children.map((c) => mapGroup(c, groupId, fn)),
  };
}

// Commands that launch an AI coding agent (mirrors TabBar's AGENT_ITEMS and the
// backend agent registry in commands::agents). Used to classify a tab by its cmd.
const AGENT_CMDS = new Set([
  "claude",
  "codex",
  "gemini",
  "agy",
  "vibe",
  "aider",
  "opencode",
  "cursor-agent",
  "copilot",
  "grok",
  "qwen",
  "openclaw",
  "droid",
]);

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
  if (AGENT_CMDS.has(cmd)) return "agent";
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
 * Agents whose prior session can be resumed, mapping `cmd` → the launch args to
 * relaunch with that session. Two resume styles are wired:
 *
 *  - id-based: Claude (`--resume <id>`), Codex (`codex resume`) and Vibe
 *    (`--resume <id>`) resume a captured session; the backend injects the
 *    latter two from their per-tab hook records.
 *  - cwd "continue last": Qwen, OpenCode, Copilot, Cursor, Gemini, Grok,
 *    Google Antigravity have no caller-supplied launch id, so
 *    Tabtivity re-launches with their "continue the most recent session" flag.
 *    Because each agent tab
 *    launches in the project directory, that most-recent session IS the tab's
 *    prior conversation. These ignore the minted id (it only satisfies the
 *    persistence gate below and is set as TABTIVITY_TAB_UID). Caveat: two tabs of
 *    the same agent in one project both resume that project's single latest
 *    session, so they can't be told apart on restore. Aider stays excluded — it
 *    has no per-session resume (only `--restore-chat-history`).
 */
export const RESUMABLE_AGENTS: Record<string, (id: string) => string[]> = {
  // Claude: `--resume <launch-id>`; the backend upgrades the id to the live one
  // after `/clear`.
  claude: (id) => ["--resume", id],
  // Codex mints its own session id, so the tab's `sessionId` is only the
  // TABTIVITY_TAB_UID key (not a Codex id) → no frontend resume args. The backend
  // reads the hook-recorded live id and injects `codex resume <live-id>` at spawn
  // (terminal::resolve_codex_session).
  codex: () => [],
  // cwd "continue last session" — no captured id needed (see note above).
  qwen: () => ["--continue"],
  opencode: () => ["--continue"],
  copilot: () => ["--continue"],
  "cursor-agent": () => ["--continue"],
  // Grok Build (xAI's own CLI, which replaced the third-party `grok-cli` this
  // registry used to install): `-c/--continue` takes the most recent session
  // of the current directory. Its `--resume <id>` wants Grok's own session id,
  // which a launch cannot supply, so it is continue-last like the others.
  grok: () => ["--continue"],
  // Droid: `--resume` with no id loads the most recent session of the
  // current directory (its `~/.factory/sessions` are filed by cwd).
  droid: () => ["--resume"],
  // Gemini's `--resume` takes "latest" (or an index), not a uuid, so it can only
  // continue the project's most-recent session — not the specific one its launch
  // `--session-id <uuid>` minted. That makes it continue-last like the others.
  gemini: () => ["--resume", "latest"],
  // Antigravity CLI: `-c`/`--continue` resumes the most recent conversation.
  agy: () => ["--continue"],
  // Vibe mints its own ID. The backend replaces this legacy fallback with
  // `--resume <live-id>` once its post-agent hook has recorded a turn.
  vibe: () => ["--continue"],
};

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
 * file-viewer embed.
 */
export function isRestorableTab(
  tab: {
    kind: TabKind;
    cmd: string;
    sessionId?: string;
    resumeArgs?: string[];
    viewer?: TabEntry["viewer"];
    localLaunch?: LocalLaunch;
  },
): boolean {
  return (
    isRestorableKind(tab.kind) ||
    isResumableAgentTab(tab) ||
    isRelaunchableLocalTab(tab) ||
    isRestorableEmbedTab(tab)
  );
}

/**
 * Drop every tab key not in `keep` from a serialized layout tree, collapsing
 * groups/splits that empty out. Returns null when nothing survives. Used when
 * persisting so the on-disk tree never references tabs we won't restore.
 */
export function pruneSavedTree(
  tree: SavedLayoutTree | null,
  keep: Set<string>,
): SavedLayoutTree | null {
  if (!tree) return null;
  if (tree.type === "group") {
    const tabKeys = tree.tabKeys.filter((k) => keep.has(k));
    if (tabKeys.length === 0) return null;
    const activeKey =
      tree.activeKey && tabKeys.includes(tree.activeKey)
        ? tree.activeKey
        : tabKeys[0];
    // #42: carry the detached tag + bounds through pruning. withDetachedDocked
    // sets these so restore re-opens the group as a floating popout; dropping
    // them here would persist the group as a plain docked node and the popout
    // would restore inside the main panel instead.
    return {
      type: "group",
      tabKeys,
      activeKey,
      ...(tree.detached ? { detached: true, bounds: tree.bounds } : {}),
      // Carry the hidden tag through pruning so a hidden group stays parked on
      // restore rather than docking live (mirrors the detached tag).
      ...(tree.hidden ? { hidden: true } : {}),
      // Carry the per-subwindow file viewer through pruning (same rationale).
      ...(tree.filesOpen ? { filesOpen: true } : {}),
      ...(tree.filesWidth != null ? { filesWidth: tree.filesWidth } : {}),
      ...(tree.filesFolder ? { filesFolder: tree.filesFolder } : {}),
    };
  }
  const kept = tree.children
    .map((c, i) => ({ child: pruneSavedTree(c, keep), size: tree.sizes[i] ?? 1 }))
    .filter((e): e is { child: SavedLayoutTree; size: number } => e.child != null);
  if (kept.length === 0) return null;
  // #42: carry a multi-pane popout's detached tag + bounds through pruning, just
  // like the group branch — else the split would persist as a plain docked node
  // and the popout would restore inside the main panel.
  const tag = tree.detached
    ? { detached: true as const, bounds: tree.bounds }
    : tree.hidden
      ? { hidden: true as const }
      : {};
  if (kept.length === 1) {
    // Collapsed to a single surviving child: it inherits the popout's detached
    // tag (so it respawns floating) or the hidden tag (so it stays parked).
    return tree.detached || tree.hidden ? { ...kept[0].child, ...tag } : kept[0].child;
  }
  const total = kept.reduce((a, e) => a + e.size, 0) || 1;
  return {
    type: "split",
    dir: tree.dir,
    children: kept.map((e) => e.child),
    sizes: kept.map((e) => e.size / total),
    ...tag,
  };
}

export function isLocalAgentKind(kind: TabKind): kind is "local_agent" {
  return kind === "local_agent";
}

/**
 * SSH-sync Phase 0: whether a tab kind has a user-toggleable local/remote
 * locality. Only `agent` and `shell` tabs run a PTY that can sit on either side;
 * `local_agent` is fixed-local and the non-PTY kinds
 * (files/embed/projects3d/network)
 * have no locality.
 */
export function isLocatableKind(kind: TabKind): boolean {
  return kind === "agent" || kind === "shell";
}

/**
 * SSH-sync Phase 0: the default locality for a kind on a remote project (product
 * decision 1): **agents default LOCAL** (cwd = the local mirror), **shells
 * default REMOTE** (run remote scripts on the host). `local_agent` and the
 * non-PTY kinds resolve local. See docs/ssh_sync_plan.md.
 */
export function defaultLocationForKind(kind: TabKind): TabLocation {
  return kind === "shell" ? "remote" : "local";
}

/**
 * SSH-sync Phase 0: a tab's effective locality — its explicit `location`, or the
 * per-kind default when unset. `local_agent` is always local regardless of any
 * stored value. Consumed by CenterPanel/DetachedCenterPanel to decide `localOnly`
 * and resolve the local `cwd` (mirror root) for a local-on-remote tab.
 */
export function effectiveTabLocation(
  tab: { kind: TabKind; location?: TabLocation },
  opts?: {
    /** VM tier (`docs/vm_projects_plan.md`): the owning project lives inside
     *  a VM, so locality is PINNED to the VM host — the agents-default-local
     *  rule below is precisely the escape that tier forbids, and any stored
     *  `location: "local"` (e.g. a persisted layout an in-VM agent could have
     *  written) is overridden, never honored. The backend's spawn guard
     *  refuses a local spawn outright as the hard boundary; this keeps the
     *  frontend from ever building one. */
    vmProject?: boolean;
  },
): TabLocation {
  if (opts?.vmProject && !isLocalAgentKind(tab.kind)) return "remote";
  if (isLocalAgentKind(tab.kind)) return "local";
  return tab.location ?? defaultLocationForKind(tab.kind);
}

/**
 * SSH-sync Phase 1: the local working directory a PTY tab should run in when it
 * runs LOCALLY on a REMOTE project. A local-on-remote tab can't cwd into the
 * remote tree, so it runs in the project's local **mirror** — the synced twin.
 * This is the value shown in the tab title (and the path the disconnected file
 * browser lists); the backend resolves the same path authoritatively at spawn
 * (and guarantees it exists).
 *
 * The mirror can be relocated to a custom folder ("Move project…"), so prefer the
 * project's persisted override (`opts.mirror`, from resolveLocalMirror) when set;
 * fall back to the default `<state dir>/mirror` for legacy projects with none.
 * Returns `fallback` (the tab's own cwd) unchanged for a local project or a tab
 * that runs on the host (remote locality).
 */
export function localTabCwd(
  tab: { kind: TabKind; location?: TabLocation },
  opts: { isRemoteProject: boolean; projectDirectory: string; fallback: string; mirror?: string | null },
): string {
  if (!opts.isRemoteProject || effectiveTabLocation(tab) !== "local") {
    return opts.fallback;
  }
  const override = opts.mirror?.trim();
  if (override) return override.replace(/[/\\]+$/, "");
  if (!opts.projectDirectory) return opts.fallback;
  return `${opts.projectDirectory.replace(/[/\\]+$/, "")}/mirror`;
}

/**
 * #42: build the saved layout tree that should be PERSISTED for a scope that has
 * detached groups. Each detached group's serialized subtree is appended to the
 * in-window tree as a sibling (row split) — so `project.json` always reflects "if
 * you restarted now, this group would dock here" and the tabs survive even if
 * respawn is unavailable — but its root group is TAGGED `detached: true` (with its
 * last-known `bounds`). On restore, a tagged group is re-opened as a floating
 * popout at `bounds` rather than docked (see loadFromLayout). With no detached
 * groups it returns the in-window tree unchanged.
 *
 * Pure: takes the serialized in-window tree + the scope's detached groups,
 * returns a serialized tree. Pruning to `keep` is the caller's job.
 */
export function withDetachedDocked(
  inWindow: SavedLayoutTree | null,
  detached: DetachedGroup[] | undefined,
): SavedLayoutTree | null {
  const docked: SavedLayoutTree[] = [];
  for (const d of detached ?? []) {
    const t = serializeTree(d.subtree);
    if (!t) continue;
    // Tag the popout's root (a single GroupNode, or a SplitNode for a multi-pane
    // popout) so restore respawns the WHOLE subtree as one floating window rather
    // than docking it into the main panel. `detachGroup` re-detaches either shape
    // by the tagged node's id (see deserializeTree → pendingRespawn).
    docked.push({ ...t, detached: true, bounds: d.bounds, zoom: d.zoom });
  }
  if (docked.length === 0) return inWindow;
  const all = inWindow ? [inWindow, ...docked] : docked;
  if (all.length === 1) return all[0];
  return {
    type: "split",
    dir: "row",
    children: all,
    sizes: all.map(() => 1 / all.length),
  };
}

/**
 * Fold a scope's HIDDEN groups back into its serialized tree, each tagged
 * `hidden: true`, so a restart persists them (their tabs survive) and restore
 * re-parks them into `hiddenGroupsByScope` rather than docking them live. Mirrors
 * `withDetachedDocked`, minus bounds (a hidden group has no OS window).
 */
export function withHiddenDocked(
  inWindow: SavedLayoutTree | null,
  hidden: HiddenGroup[] | undefined,
): SavedLayoutTree | null {
  const docked: SavedLayoutTree[] = [];
  for (const h of hidden ?? []) {
    const t = serializeTree(h.subtree);
    if (!t) continue;
    docked.push({ ...t, hidden: true });
  }
  if (docked.length === 0) return inWindow;
  const all = inWindow ? [inWindow, ...docked] : docked;
  if (all.length === 1) return all[0];
  return {
    type: "split",
    dir: "row",
    children: all,
    sizes: all.map(() => 1 / all.length),
  };
}

// Re-export the id regeneration helper so consumers / tests that build trees
// manually can mint ids consistently.
export { regenIds as _regenLayoutIds };

/**
 * #42: is the PTY `id` (`<scope>:<tabKey>`) currently owned by a DETACHED group?
 *
 * The main window's `TerminalView` is NOT attach-only, so on unmount it kills its
 * PTY. But detaching a group unmounts that pane in the main window — and we must
 * NOT kill the PTY then, because the detached window's attach-only viewer has
 * just attached to it (killing it leaves the popped-out terminal a dead black
 * pane). `detachGroup` records the group in `detachedGroupsByScope` *before* the
 * unmount commit, so this read sees the detached state at kill time.
 */
export function isDetachedPtyId(id: string): boolean {
  // Through `splitPtyId`, never a hand-rolled cut at the first colon: a box
  // scope is `box:<id>`, so that cut read `box:abc:agent-3` as the scope
  // `"box"`, found no detached groups under it, and let the main window kill a
  // PTY it had just handed to a popout — a detached box tab came up dead.
  const parts = splitPtyId(id);
  if (!parts) return false;
  const groups = useTabsStore.getState().detachedGroupsByScope[parts.scope] ?? [];
  return groups.some((g) => orderedTabKeys(g.subtree).includes(parts.key));
}

// ── Fine-grained per-group selectors (Eff #3/#4/#7 + Struct #3) ───────────────
// These let a TabBar / pane subscribe to JUST its own group instead of the whole
// `layout` + `tabs` slices, which forced a re-render on any tab change anywhere
// and rebuilt a Map of every tab per render. writeScope rebuilds the layout
// immutably along the changed path only (mapGroup), so an unchanged group node
// keeps its reference identity — meaning these selectors return the SAME value
// across an unrelated group's mutation and React bails out of the re-render.
// Modelled on stores/drag/drag.ts's coarse-selector discipline.

/**
 * The current scope's `GroupNode` for `groupId`, or null if it isn't in the live
 * layout. Reference-stable while this group is unchanged, so a subscriber only
 * re-renders when THIS group's node (its tabKeys / activeKey) actually changes.
 */
export function useGroup(groupId: string): GroupNode | null {
  return useTabsStore((s) => findGroup(s.layout, groupId));
}

/**
 * The full tab payloads held by `groupId`, in group order. Subscribes with a
 * shallow array comparison so the bar re-renders only when this group's resolved
 * payloads change — not when another group's tabs (or the `tabsByScope` array
 * identity) churn. Returns [] when the group is absent.
 */
export function useGroupTabs(groupId: string): TabEntry[] {
  return useTabsStore(
    useShallow((s) => {
      const group = findGroup(s.layout, groupId);
      if (!group) return EMPTY_TABS;
      const byKey = new Map(s.tabs.map((t) => [t.key, t] as const));
      return group.tabKeys
        .map((k) => byKey.get(k))
        .filter((t): t is TabEntry => t != null);
    }),
  );
}

// Shared empty sentinel so the no-group path returns a stable reference (an
// inline `[]` would be a fresh array each call and defeat the shallow bail-out).
const EMPTY_TABS: TabEntry[] = [];
