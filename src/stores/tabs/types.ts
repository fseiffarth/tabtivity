// The tab store's data shapes: live tabs, the layout tree, popouts, and the
// persisted (`project.json`) forms. Types only. Moved out of `stores/tabs.ts`.

import type { TabColor } from "../../lib/theme/tabColors";
import type { TabMark } from "../../lib/tabMarks";
import type { InternalViewer } from "../../lib/viewers/fileUtils";
import type { AutocompleteMode } from "../../types";
import type { LoginTarget } from "../../lib/remote/loginTarget";
import type { AssistantLaunch } from "../../lib/assistant";

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
  // The view state of the workspace's OTHER panes — a child `.tex`, a graphic,
  // a PDF shown in the centre — keyed by absolute path. Each such pane writes
  // under `<tab key>#<path>` (`FileViewerPane`'s `centerFor`); the store keeps
  // it here, on the one workspace tab, so a wake from sleep, a popout dock-back
  // or a released hidden PDF reopens it where the reader left it rather than at
  // the default position. Most recently written last, at most
  // `TEX_PANES_CAP` paths: a long session walks many files, and the oldest
  // drop. A path the structure no longer holds is never shown, so its entry
  // is inert until it ages out. The main document's own pane uses the tab's
  // fields above, not an entry here.
  texPanes?: Record<string, ViewerState>;
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
  // A login terminal (`lib/remote/loginTarget`): the backend runs this ssh/OpenVPN
  // login as the PTY's own program — `cmd`/`args`/`env`/`cwd` are ignored — and
  // only such a PTY, while its login runs, takes a pasted saved credential.
  // Session-only: never persisted (`toSavedTabEntry` leaves it out) and never
  // restored (`isRestorableTab`) — a restored login would raise a pkexec/ssh
  // prompt at launch, and auto-connect never prompts.
  login?: LoginTarget;
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
  // The tab's pick between its CLI's own login and the user's stored API key
  // (`PtyOptions::api_key`): `true` from the ＋ menu's API section, `false`
  // from its plain rows, unset (the phone, scheduled agents, older tabs) for
  // the Manage CLIs switch. Persisted, so a resumed tab keeps its billing;
  // the backend drops it from an adopted or imported layout.
  apiKey?: boolean;
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
  // A Tabby chat's launch (`lib/assistant.AssistantLaunch`): which CLI and
  // model the chat runs. Only a tab of the assistant scope carries it. The
  // backend builds the chat's argv from this block and from nothing else the
  // tab says (`launch_prep::assistant_gate`), so it is the tab's whole spawn
  // recipe; persisted, and kept on a restore only in that scope.
  assistant?: AssistantLaunch;
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
  // Emptied by closing its last tab while `close_subwindow_on_last_tab` is off:
  // the subwindow stays standing, empty with its +, instead of collapsing away.
  // Session-only (never persisted); dropped once a tab lands in the group.
  keepEmpty?: boolean;
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
  /**
   * Native Wayland only, where `x`/`y` mean nothing: the screen the popout was
   * on at the last quit (GDK's logical rect, backend `detached_window_screens`),
   * so a restart respawns it there. Kept across the bounds stream, which never
   * knows it.
   */
  monitor?: ScreenRect;
}

/** A monitor's rect as the backend names it (`MonitorRect`). */
export interface ScreenRect {
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
  // The name the user gave it in the side panel's Hidden list. Unset, the list
  // calls it "Hidden <n>" by its position.
  name?: string;
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
  // Persisted login-or-key pick (see TabEntry.apiKey).
  apiKey?: boolean;
  // Persisted local-model launch line (see TabEntry.localLaunch).
  localLaunch?: LocalLaunch;
  // Persisted Tabby chat launch (see TabEntry.assistant).
  assistant?: AssistantLaunch;
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
      // A hidden subtree's user-given name (HiddenGroup.name).
      hiddenName?: string;
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
      hiddenName?: string;
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
