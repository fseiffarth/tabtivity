import type { LinkOpenTarget } from "./browser";
import type { PyMainVerdict } from "../lib/terminal/pythonMainCache";
import type { AgentCron } from "../lib/agents/agentCron";
import type { CursorPack } from "../lib/theme/cursorPacks";
import type { TranslationKey } from "../lib/i18n";
import { MOBILE_ACCESS_KEY, MOBILE_HOST_KEY } from "../lib/brand";

export interface GlobalAppEntry {
  exec: string;
  visible: boolean;
  [key: string]: unknown;
}

/**
 * Per-file-type native-viewer preferences (#48). Keys are snake_case to match
 * the Rust `ViewerPref` serde serialization so settings.json round-trips. Keyed
 * by a viewer-type id (see VIEWER_PREF_TYPES in fileUtils).
 */
/**
 * Completion-length mode for local autocomplete (#45 modes), mirroring the Rust
 * `CompletionMode`: how much the model is asked to complete at the caret.
 *  - `"sentence"` — finish the current word/sentence/line (default).
 *  - `"block"` — finish the current code block / paragraph (multi-line).
 *  - `"scope"` — complete the whole enclosing function or scope.
 */
export type AutocompleteMode = "sentence" | "block" | "scope";

/**
 * Category of an editor proofreading issue. Drives the underline colour in the
 * editor overlay; the dictionary spell check only ever reports `"spelling"`.
 *  - `"spelling"` — a misspelled word / typo (red).
 *  - `"grammar"` — a grammar or punctuation mistake (blue).
 *  - `"style"` — a style/wording suggestion (green).
 */
export type GrammarCategory = "spelling" | "grammar" | "style";

/**
 * One proofreading issue returned by the dictionary spell check (`spell_check`),
 * mirroring the Rust `GrammarIssue`. `bad` is the exact offending substring (the frontend
 * locates it in the draft to draw the underline); `line` is its 1-based line in
 * the checked text, used as a disambiguation hint when resolving the range.
 */
export interface GrammarIssue {
  line: number;
  bad: string;
  suggestion: string;
  category: GrammarCategory;
  message: string;
}

export interface ViewerPref {
  /** Whether this native viewer is used at all. Absent/true → render in-app;
   *  false → the type opts out and its files open in the external default app. */
  enabled?: boolean;
  /** Whether Ctrl+Space local autocomplete is enabled for this type (#45). */
  autocomplete?: boolean;
  /** Default completion-length mode for this type (#45 modes). Cycled live
   *  in-editor with Shift+Tab while a suggestion is showing; absent → "sentence". */
  autocomplete_mode?: AutocompleteMode;
  /** Whether the dictionary (Hunspell) spell check is enabled for this type.
   *  Needs no model — deterministic, milliseconds, offline. Default OFF: red
   *  underlines nobody asked for are noise in a code editor. */
  spell_check?: boolean;
  /** Whether the TeX editor typesets the snippet under the pointer and shows it
   *  in a hover card (#tex-hover-preview). Read only for the `"tex"` entry, and
   *  absent means ON — the opposite default to the two toggles above, which are
   *  opt-in because they call a model. */
  hover_preview?: boolean;
  /** Editor font size in px for this type's in-app code editor. Adjusted from
   *  the viewer's A−/A+ controls (or Ctrl +/−/0); unset falls back to 12px. */
  font_size?: number;
}

/**
 * A serializable keyboard chord (Group L / #62). Mirrors the Rust `ChordDescriptor`
 * and `src/lib/shortcuts/shortcuts.ts`'s `ChordDescriptor`. `key` is a normalized
 * `KeyboardEvent.key`; modifier flags default to false when absent.
 */
export interface KeyboardChord {
  key: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  meta?: boolean;
}

/**
 * A user-defined "custom agent" — an arbitrary CLI the user wants offered in the
 * add-tab menu's Agents group alongside the built-in agents (Claude, Codex, …).
 * It is just a launch command: Tabtivity spawns `cmd` (+ `args`, `env`) in the
 * project directory as an `agent` tab. Persisted in `Settings.custom_agents` and
 * added/removed from the "＋ Add agent…" dialog.
 *
 * Unlike a built-in agent it carries no install command and no session-capture
 * machinery. The one optional capability is `resumeArgs`: a "continue the most
 * recent session" flag (e.g. `["--continue"]`) that, when set, promotes the tab
 * to the *cwd-continue* resume tier — it survives a restart and respawns with
 * these args (exactly how Qwen/OpenCode resume). Unset ⇒ launch-only, dropped on
 * restart like Gemini/Aider.
 */
export interface CustomAgent {
  /** Stable id minted at creation; also the persisted map key / React key. */
  id: string;
  /** Display label in the Agents menu. */
  label: string;
  /** Binary/command to spawn. Probed on PATH (or as a file path when it contains
   *  a separator) for the menu's installed/greyed state. */
  cmd: string;
  /** Optional launch args, prepended before any resume args. */
  args?: string[];
  /** Optional environment variables set on the tab's process. */
  env?: Record<string, string>;
  /** Optional "continue last session" flag(s). When non-empty the tab is
   *  restart-resumable (see the interface note). */
  resumeArgs?: string[];
  /** Optional one-line install command (e.g. `npm install -g @scope/pkg`). When
   *  the agent's binary isn't found, the manage dialog offers a one-click button
   *  that runs this in a fresh root terminal tab (Tabtivity's install-via-tab
   *  policy — never a copy-it-yourself step). */
  installCmd?: string;
}

/** The views of the shared file viewer's switcher (`ProjectFilesView`), named
 *  here because the side panel persists its last one in `Settings`. */
export type FilesPanelView =
  | "files"
  | "windows"
  | "git"
  | "agents"
  | "orange"
  | "sessions"
  | "jobs"
  | "remarks"
  | "todo";

export interface Settings {
  /** The file's revision (headless owner plan, H1): every write moves it, and
   * the whole-document `save_settings` fallback is refused when the file moved
   * on since this object was loaded. `patch_settings` never needs it. */
  rev?: number;
  debug?: boolean;
  [MOBILE_HOST_KEY]?: {
    enabled: boolean;
    display_name?: string;
    port?: number;
    serve_origin?: string;
    /** A paired phone may mark read/unread and star. Unset is off. */
    mail_actions?: boolean;
    /** A paired phone may read mail at all. Unset is ON (what pairing always
     * meant); an explicit false hides accounts, folders and bodies. */
    mail_read?: boolean;
    /** A paired phone may send a plain-text reply whose recipient the desktop
     * derives from the original. Unset is off; independent of `mail_actions`. */
    mail_reply?: boolean;
    /** A paired phone may reach the root console's tabs. Unset is off; the
     * sidecar also holds it closed while root-agent writes are not staged
     * behind the fence (`docs/context/root_console.md`, "On the phone"). */
    root_access?: boolean;
    /** A paired phone may browse and read (never change) its Mobile projects'
     * files. Unset is off; read by the sidecar per request. */
    project_files?: boolean;
    /** Quitting Tabtivity leaves the Mobile host running (headless owner). Unset
     * is off; read by the quit path. */
    stay_after_quit?: boolean;
    /** A paired phone may see and open shell tabs. Unset is off (the phone is
     * agents-only); read by the sidecar per catalog load and repeated by the
     * desktop bridge. */
    shell_tabs?: boolean;
    /** A paired phone may list the Ollama models installed here and load or
     * unload them (never download or delete). Unset is on; an explicit false
     * closes the routes. Read by the sidecar per request and repeated by the
     * desktop bridge (`lib/mobileLocalModels`). */
    local_models?: boolean;
  };
  /** Show Tabtivity Mobile's host-connection control in the desktop header. This
   * defaults to on when Mobile itself is enabled; an explicit false hides it. */
  mobile_indicator?: boolean;
  /** Is the header's machine-state cluster (connection, battery, Mobile, VPN,
   * Machines, CPU/RAM/GPU) expanded into the bar? Unset means collapsed to a
   * single summary lamp; anything non-nominal shows itself regardless. */
  header_status_expanded?: boolean;
  /** Default printer per network, keyed by `networkKey()` in
   *  `lib/window/printerNetworkDefaults`. Joining a keyed network makes that
   *  printer the user's default. Unset/empty → nothing is ever switched. */
  printer_network_defaults?: Record<string, { printer: string; label: string }>;
  git_profile_url?: string;
  git_token?: string;
  color_scheme?: string;
  /** UI language for Tabtivity's interface. Unset/unknown falls back to English.
   *  Applied live via `lib/i18n` (`applyLanguage`); the backend round-trips it. */
  language?: "en" | "de" | "es" | "fr" | "it";
  /** App-wide clock: `true` = 24-hour, `false` = 12-hour AM/PM. **Unset is not
   *  `false`** — it means "not chosen", and the clock then follows the OS's
   *  12/24-hour setting (`lib/osClock`), or `language` when the OS has no
   *  opinion. Read through `lib/timeFormat`'s `useUse24h()`, never off
   *  `settings` directly, or the default is what gets missed. */
  time_format_24h?: boolean;
  /** The MAIN window's UI zoom factor (helps on high-DPI/4K monitors). `1` (or
   *  unset) is 100% — the default look; applied as the webview's native zoom.
   *  Clamped to [0.5, 3]. Zoom is **per window**: a detached popout persists its
   *  own zoom on its layout entry (see `DetachedGroup.zoom`), not here. */
  ui_zoom?: number;
  /** Custom accent color (`#rrggbb`) overriding the active theme's `--accent`
   *  across every theme; unset = the theme's own. Applied as inline root CSS
   *  vars by `stores/settings.applyAccent` — the hover/active/pill tokens all
   *  derive from `--accent`, so one override recolors them together. */
  ui_accent?: string;
  /** Corner style override: `"square"` or `"rounded"`; unset = the active
   *  theme's own radius tokens. Applied by `stores/settings.applyCorners`. */
  ui_corners?: CornerStyle;
  /** Custom mouse-cursor pack (`lib/theme/cursorPacks`); unset = the system cursors.
   *  Applied by `stores/settings.applyCursor`, which draws the art from the
   *  LIVE theme — so the pointer follows the theme, the custom accent and the
   *  Theme Customizer's token overrides rather than being a fixed asset.
   *  Round-trips through the backend's `extra` catch-all — no Rust field
   *  needed, like `ui_theme_vars`.
   *
   *  `null`, not `undefined`, is how the pack is switched back OFF: a patch
   *  crosses the IPC as JSON, which drops an `undefined` property outright, so
   *  the key would simply not be in the patch and the stored pack would stand
   *  (`ollama_models_path` clears itself the same way). */
  ui_cursor?: CursorPack | null;
  /** Per-token color overrides from the Theme Customizer, keyed by CSS custom
   *  property (`{"--bg-panel": "#101820"}`). Only the `lib/theme/themeTokens` catalog
   *  names, holding `#rrggbb`/`#rrggbbaa`, are honoured — see
   *  `stores/settings.normalizeThemeVars`, which is what stands between a
   *  hand-edited settings.json and an arbitrary inline-CSS write. Cross-theme
   *  like `ui_accent`, and applied after it, so a hand-picked `--accent-hover`
   *  beats the one derived from the accent. Round-trips through the backend's
   *  `extra` catch-all — no Rust field needed. */
  ui_theme_vars?: Record<string, string>;
  /** Saved looks from the Theme Customizer: the whole appearance — base theme,
   *  accent, per-token overrides and corner style — under a name, so a palette
   *  you built can be put away and brought back instead of being the one thing
   *  the app can hold at a time. Validated on read the way `ui_theme_vars` is
   *  (`stores/settings.normalizeThemePresets`), since a stored preset reaches
   *  the root style the moment it is loaded. Round-trips through the backend's
   *  `extra` catch-all — no Rust field needed. */
  ui_theme_presets?: ThemePreset[];
  /** Calendar: first column of the week — `0` = Sunday, `1` = Monday (default). */
  calendar_week_start?: 0 | 1;
  /** Calendar: the view a fresh calendar tab opens on. Default `"month"`. */
  calendar_default_view?: CalendarViewKind;
  /** **Retired** — the calendar-only 24-hour switch, superseded by the app-wide
   *  `time_format_24h`. Nothing writes it; `lib/timeFormat.ts` reads it once as
   *  a fallback so a user who had set it keeps that clock everywhere. */
  calendar_time_format_24h?: boolean;
  /** Calendar: first/last hour the day and week grids scroll to. Default 8/20. */
  calendar_day_start_hour?: number;
  calendar_day_end_hour?: number;
  /** Calendar: minutes-before reminder pre-filled on a new event. `0` = none. */
  calendar_default_reminder_minutes?: number;
  /** Calendar: put a 📅 button in the header that opens the calendar overlay,
   *  badged with the events left today. Default false. The twin of the header's
   *  mail button, with no experimental gate above it — the calendar is a shipped
   *  feature and reads nothing off the network. */
  calendar_global_app?: boolean;
  /** To-do board: put a ☑ button in the header that opens the global todo board
   *  overlay, badged with what is due today. Default false.
   *
   *  A plain setting rather than an experimental flag, for `calendar_global_app`'s
   *  reasons: the board reads one already-shipped local file (`calendar.json` —
   *  its cards *are* the calendar's tasks) and reaches no network. Its one
   *  network-adjacent half, the urgent-mail rail, is already gated by
   *  `mail_client`, so a second experimental flag would gate the same thing twice
   *  — and `experimental()` additionally means "on in debug", which would put a
   *  third header button in every developer's window unasked. */
  todo_board?: boolean;
  /** Root console: whether Tabtivity serves its own MCP tools to root agents
   *  (`services::root_mcp`). **Default true** — absent means on. Off hands new
   *  root agents no endpoint and refuses the ones already holding the token. */
  root_mcp?: boolean;
  schedule_mcp?: boolean;
  /** Agent-requested pushes (`services::git_push_mcp`). Absent means off. */
  git_push_mcp?: boolean;
  /** The read-only "Ask Tabtivity" help MCP (`tabtivity-help`) in local agent tabs.
   *  **Default true** — absent means on. Switched in the intro wizard. */
  help_mcp?: boolean;
  /** The markup questions MCP (`services::markup_mcp`, `markup_ask`) in local
   *  project-agent tabs. **Default true** — absent means on. */
  markup_mcp?: boolean;
  root_mcp_review?: "all" | "destructive" | "off";
  /** Root console: serve the MCP tools to local-model tabs only. Absent means
   *  off. On, cloud agent CLIs get no endpoint and running ones are refused. */
  root_mcp_local_only?: boolean;
  /** Root console: serve the MCP endpoint's mail tools. Absent means **off** —
   *  switched on separately from `root_mcp`, and above every per-account
   *  `agent_access`. */
  root_mcp_mail?: boolean;
  /** Root console: keep the mail tools to local-model tabs. Absent means off.
   *  On, cloud agent CLIs are neither listed nor served a mail tool and a
   *  contained reader is refused; the rest of the tools are untouched. */
  root_mcp_mail_local_only?: boolean;
  /** Root console: a local-model tab may read the mails shared with agents —
   *  marked messages only, and only while Ollama is loopback. Absent means off. */
  root_mcp_mail_local_read?: boolean;
  /** Side panel: the **Alerts** group in the file viewer — urgent mail, the
   *  calendar entries about to start, and the to-do cards whose due date is here
   *  or past, merged into one time-ordered strip. **Default true.**
   *
   *  A plain setting rather than an experimental flag, for `todo_board`'s
   *  reasons: everything it shows is already on screen somewhere else, it reads
   *  the two stores that already own that data (`calendar.json`'s events and
   *  tasks, the local mail priority index) and it opens no socket of its own.
   *
   *  **This flag IS the group's visibility**, not a preference sitting above a
   *  separate shown/hidden state, and that is what makes the default safe to
   *  invert: the toolbar's 🔔 writes this key, so closing the group persists and
   *  survives a relaunch instead of coming back at the next remount — and this
   *  viewer is mounted many times over at once (the side panel, every Files
   *  tab, every subwindow's docked column, every popout), so a per-surface flag
   *  would have to be dismissed once per surface. The button is deliberately
   *  rendered whether or not the group is on: it is the way back, and gating it
   *  on the same key would make the × a one-way door.
   *
   *  Turning it off is therefore a real off — `useAlertsFeed` returns before
   *  every read, arms no timer and collapses its store selectors to frozen
   *  empties, so a hidden group costs nothing at all.
   *
   *  The mail half is additionally gated by the existing `mail_client`
   *  experimental flag, checked *before* the read (opening the mail store
   *  creates the mail database — the rule `TodoMailRail` already follows). With
   *  mail off the group is not withdrawn: it still shows calendar entries and
   *  to-dos, which are the two sources that cost nothing but a local file. */
  files_alerts?: boolean;
  /** Alerts group: how many days ahead an event/task may be to still show.
   *  Default 7 (`lib/alerts`' `DEFAULT_LOOKAHEAD_DAYS`). A short window is what
   *  keeps the strip an alert rather than an agenda. */
  files_alerts_days?: number;
  /** Alerts group: per-source opt-outs. **All default on when the group is on** —
   *  an absent key means "show it", so an existing settings file never has to be
   *  migrated to see a source, and turning the master switch on gives the
   *  complete picture rather than an empty strip that has to be configured. */
  files_alerts_sources?: { mail?: boolean; events?: boolean; tasks?: boolean };
  /** Alerts group: the `AlertItem.id`s the user muted from a row's 🔕 (newest
   *  last, bounded by `lib/alerts`' `MAX_MUTED_ALERTS`). Here rather than in the
   *  component because the file viewer is mounted many times over at once — a
   *  per-surface mute would have to be repeated once per surface — and because a
   *  mute that came back at the next launch would be a control that doesn't
   *  work. It hides a row and nothing else: the mail stays marked, the card
   *  stays due, and the group's reveal (🔕 N) is how a mute is taken back. */
  files_alerts_muted?: string[];
  /** Mail: the experimental gate for the embedded mail client (`lib/experimental`
   *  — unset means "on in debug mode", which is NOT the same as false).
   *
   *  The ONE mail switch. It turns on the header's ✉ button and the overlay
   *  behind it, which since the mail tab was retired is the whole client; the old
   *  `mail_global_app` sub-toggle is gone, because a switch that hides the only
   *  surface while leaving the feature "on" has nothing to mean. */
  mail_client?: boolean;
  /** Mail: the account the mail overlay opens on. Falls back to the first. */
  mail_default_account?: string;
  /** Mail: minutes between automatic checks. **Unset/0 = never**, which is the
   *  default and the reason the store's "nothing connects on its own" rule still
   *  holds: only an explicit opt-in here starts a timer, and only while the
   *  header's mail button is on (`MailIndicator` owns it). */
  mail_check_interval_min?: number;
  /** Mail: load remote images without asking. **Default false, and it should
   *  stay that way** — loading them tells the sender the message was opened. */
  mail_show_remote_images?: boolean;
  /** Mail: raise an OS notification for new inbox mail. Default true. */
  mail_notify_new?: boolean;
  /** Browser: the experimental gate for the in-app browser (#61). Read through
   *  `lib/experimental` — unset means "on in debug mode", NOT false. */
  web_browser?: boolean;
  /** Browser: where a fresh browser tab opens. **Empty/unset is the built-in
   *  start page, not a remote request** — a home page that fires on every new
   *  tab is an outbound request nobody asked for. */
  browser_home_url?: string;
  /** Browser: non-URL address-bar text becomes this, with `%s` replaced by the
   *  percent-encoded text. Clearable — with no template, text that is not a URL
   *  is refused rather than sent to a third party. */
  browser_search_template?: string;
  /** Browser: where clicked links open (#33). Default `"external"`, chosen
   *  deliberately — the user's real browser has their logins, their extensions
   *  and their password manager, and an experimental in-app engine should not
   *  silently start receiving their links. See `lib/linkTarget`. */
  browser_link_target?: LinkOpenTarget;
  /** Browser: a restored tab loads its page at launch instead of showing the
   *  resume card. **Default false** — restoring N tabs would otherwise be N
   *  automatic outbound requests before the user has looked at the screen. */
  browser_restore_navigate?: boolean;
  /** Browser: whether the hardened **live-page window** may be opened at all.
   *
   *  **Default false, and off in debug mode too** — deliberately not read through
   *  `useExperimental`, which would turn it on for anyone running a debug build.
   *  Reader mode needs no such switch: it runs no JavaScript and its bytes are
   *  sanitized in Rust. A live page runs the real web page, and two of its holes
   *  cannot be closed from app code — it can reach a service on this machine via
   *  any hostname that resolves to loopback, and `ws://` reaches one regardless
   *  because a WebSocket is not a navigation and has no CORS. The backend refuses
   *  `browser_open_live` without this, so the hidden control is the courtesy and
   *  not the boundary. */
  browser_live_pages?: boolean;
  /** The agent Tabtivity picks on its own when a feature needs exactly one and the
   *  user hasn't chosen per-instance — an agent id/cmd from `AGENT_ITEMS`
   *  (`"claude"`, `"codex"`, …). Set from the 🧠 menu's Agents section; every
   *  reader falls back to `"claude"` when unset. */
  default_agent_cmd?: string;
  /** Desktop PDF viewer Mark up prompts (`docs/pdf_markup_rounds_plan.md` §2.8):
   *  the Submit's instruction and the **Make these changes** follow-up;
   *  unset/blank = the defaults. */
  pdf_markup_instruction?: string;
  pdf_markup_apply?: string;
  /** How often a Submit lets the agent stop to ask about the marks, 0 (about
   *  every mark) … 4 (never); unset = the default stop (`DEFAULT_PDF_MARKUP_ASK`). */
  pdf_markup_ask?: number;
  /** A marked PDF that changes on disk loads under the marks on its own;
   *  unset = on, `false` waits for **Reload PDF**. */
  pdf_markup_auto_reload?: boolean;
  /** Subagent mode: each Submit asks the tab's agent to hand the round to a
   *  new subagent (`markupForSubagent`); unset = off. */
  pdf_markup_subagents?: boolean;
  /** **Apply marks directly** (`docs/pdf_markup_direct_apply_plan.md`): a
   *  Submit asks for an `apply` round backed by an undo snapshot; unset = on,
   *  `false` = the agent lists the changes first (**Make these changes**). */
  pdf_markup_direct?: boolean;
  /** Built-in agent registry ids shown without searching in the compact Agents
   *  group of the + tab menu. Set by the 🧠 menu's “+ tab” chips. Unset keeps
   *  the familiar Claude/Codex/Gemini quick picks; an empty array is a deliberate
   *  choice to show agents only after searching. */
  compact_tab_agents?: string[];
  /** Built-in agent registry ids the root console's + menus offer, set by the
   *  🧠 menu's "Root" chips. Opt-in: unset or empty offers none there (root
   *  agents get the root MCP tools). */
  root_agents?: string[];
  /** Agent CLI binaries given the root MCP tools in the root console, set by
   *  the 🧠 menu's "MCP" chips (Root = may run there, MCP = runs there with the
   *  tools). Unset falls back to `root_agents`. Read at spawn by the backend. */
  root_mcp_agents?: string[];
  /** Local (Ollama) model names switched OFF for the root console by the 🧠
   *  menu's "Root" chips. Opt-out: unset means every model is offered there. */
  root_excluded_models?: string[];
  /** Local (Ollama) model names given the root MCP tools by the 🧠 menu's
   *  "MCP" chips. Opt-in: other local-model tabs run with tools off. Read at
   *  spawn by the backend (`services::root_mcp`). */
  ollama_mcp_models?: string[];
  /** Prefix chips per agent command for the side panel's agent composer; unset
   *  falls back to `lib/agents/agentPrefaces`' defaults, `[]` means none. */
  agent_preface_commands?: Record<string, string[]>;
  /** Model names per agent command, typed as that CLI's own `/model <name>`. */
  agent_models?: Record<string, string[]>;
  /** The agent a prompt-chart draft aimed at "New agent tab" launches (the
   *  bare command, `"claude"`); unset falls back to `default_agent_cmd`. Set
   *  from the chart's own toolbar. Rides in the backend's `extra` catch-all. */
  prompt_chart_agent?: string;
  /** The model that new tab is told to use, typed as the agent's own `/model`
   *  ahead of the prompt; unset or empty leaves the agent's default. */
  prompt_chart_model?: string;
  /** User-defined custom agents offered in the add-tab menu's Agents group,
   *  added/removed from the "＋ Add agent…" dialog. Round-trips through the
   *  backend settings `extra` catch-all — no Rust field needed. See CustomAgent. */
  custom_agents?: CustomAgent[];
  /** Built-in agent ids (the `cmd` in `AGENT_ITEMS`, e.g. `"codex"`) the user has
   *  turned off in "Manage Agents" despite being installed — hidden from every
   *  tab-choice menu (add-tab Agents group, Local Model drivers) without
   *  uninstalling the CLI. Round-trips through the backend settings `extra`
   *  catch-all — no Rust field needed. Unset/empty = nothing hidden. */
  disabled_agents?: string[];
  /** The order of the Agents group's rows, which is the order Ctrl+1–9 number
   *  them: row keys (a built-in's command, `"claude"`; a custom agent's
   *  `"custom:<id>"`). Set by Manage CLIs' ↑/↓. Unset = the default agent
   *  first, then menu order (`agentShortcutSlots`); keys it lacks follow the
   *  ones it names. Round-trips through the backend settings `extra`. */
  agent_order?: string[];
  /** The scheduled agent warm-up (Manage CLIs → Scheduled warm-up): at each
   *  configured local time, one short message is sent to that agent (in its
   *  one-shot print mode), so its usage window starts *then* rather than
   *  whenever the first real prompt happens to be typed. A global time list with per-agent
   *  participation and per-agent overrides; read through `lib/agents/agentCron.ts`,
   *  which is also where the semantics of every field live. Round-trips through
   *  the backend settings `extra` catch-all — no Rust field needed, since
   *  nothing in the backend reads it. Unset = nothing scheduled. */
  agent_cron?: AgentCron;
  /** The default local (Ollama) model. Used by any task without its own
   *  per-task assignment in `ollama_roles`, and as the legacy "active model".
   *  Chosen in the 🧠 menu (click a loaded model's name). Unset = none. */
  ollama_model?: string;
  /** Where the Ollama server is, when it is not the default `127.0.0.1:11434` —
   *  a different port (a container publishing 11435, a second server) or, with
   *  {@link ollama_allow_remote_host}, another machine. Accepts `host:port`, a
   *  bare `host`, a bare `:port` or port, and an `http://` prefix; `https://` is
   *  **refused**, because the backend transport is plaintext HTTP/1.0 over a raw
   *  socket and downgrading a URL written as TLS would put prompts in the clear.
   *  There is no UI for it yet — it is edited in `settings.json` (group S #201a,
   *  which made it do something; it was declared and read by nothing for years).
   *  Unset = the default. */
  ollama_host?: string;
  /** Permit {@link ollama_host} to name a machine that is not this one.
   *  **Default false**, and separate from the host itself because the two are
   *  different decisions: another *port* is still local inference, another
   *  *host* means every prompt and every file an agent reads leaves this
   *  machine — the opposite of what the local-model feature is for. Judged on
   *  the literal that was typed, never on what it resolves to. */
  ollama_allow_remote_host?: boolean;
  /** Where Ollama saves the models it downloads — its `OLLAMA_MODELS`
   *  directory. Unset/empty means Ollama's own default (`~/.ollama/models`, or a
   *  system-service dir when one holds models). It reaches only a server Tabtivity
   *  starts itself; a systemd-managed one is pointed at the same folder by the
   *  Settings panel's one-click drop-in (`ollama_models_dir_plan`). */
  ollama_models_path?: string | null;
  /** Per-task local-model assignments (🧠 menu role chips). Maps a task key —
   *  `"autocomplete"`, `"autocomplete_prose"`, `"tabs"` or `"mail"` —
   *  to the model name that should serve it (`autocomplete_prose` covers plain
   *  text, Markdown and TeX, and falls back to `autocomplete`), so several loaded models can run different jobs in parallel.
   *  A task absent here falls back to `ollama_model`, then to any loaded model.
   *  `"mail"` is written by the chip and **read by nothing yet**: the mail task it
   *  names (importance scoring, summaries) is not built. It is offered ahead of
   *  its consumer because the choice is the user's — which model may see their
   *  mail — and is the kind of thing to have answered before the feature runs,
   *  not after; the chip's tooltip says nothing reads it so far. */
  ollama_roles?: Record<string, string>;
  /** Missing provider retains Ollama; prose keeps its existing Ollama role. */
  code_completion_provider?: "ollama" | "copilot";
  /** Experimental entry point; this alone never authorizes cloud context. */
  copilot_completion?: boolean;
  /** Tabtivity-owned consent, bound to both project id and canonical directory. */
  completion_project_policies?: Record<string, {
    directory: string;
    copilot: boolean;
    local_only: boolean;
    [key: string]: unknown;
  }>;
  /** Hunspell dictionary code (e.g. `en_US`) for the editors' dictionary spell
   *  check. Unset means the default — an installed English variant when there
   *  is one. Machine-wide (the language you write in is not per project);
   *  per-type enablement is `ViewerPref.spell_check`. */
  spell_language?: string;
  /** The **Mail AI (local)** global master switch (Group Q, #203–#208) —
   *  "Allow Mail AI features", **default off**. The per-feature toggles now live
   *  **per account** (`MailAiPrefs` in `types/mail`); this one global flag gates
   *  them all. The AI path is loopback-only and stricter than
   *  {@link ollama_allow_remote_host}: nothing about a message ever leaves this
   *  machine. Read in the backend sync (it gates per-account autoclassify) and in
   *  the UI via `lib/mail`'s `mailAiResolvable`. */
  mail_ai_allow?: boolean;
  /** Local models to load into memory when Tabtivity starts (🧠 menu "on start"
   *  chip / Ollama settings). Loading is what makes a model *usable* without a
   *  manual step, so a feature that wants one waiting — mail-importance scoring,
   *  autocomplete — finds it warm at launch. Sequential, in list order. Unset or
   *  empty = nothing is started. Round-trips through the backend's `extra`
   *  catch-all — no Rust field needed. */
  ollama_autoload_models?: string[];
  /** Whether {@link ollama_autoload_models} is honoured while Energy Saver is
   *  active. **Default false**: a resident model holds GPU/CPU memory and Ollama
   *  keeps it warm, which is exactly what Energy Saver exists to stop. When it
   *  suppresses a load the 🧠 menu says so and offers to load it anyway, rather
   *  than leaving the models silently absent. Round-trips through `extra`. */
  ollama_autoload_in_energy_saver?: boolean;
  /** Python Run/Debug arguments (#py), the raw `sys.argv` string typed into the
   *  Run button's right-click popover, keyed by the file's absolute path. Kept
   *  per file (not per tab) so every viewer of the same script shares one set of
   *  args, and here (global settings) so they survive closing the viewer and an
   *  Tabtivity restart. Round-trips through the backend's `extra` catch-all — no Rust
   *  field needed. An entry set to "" means "cleared" and is pruned. */
  python_run_args?: Record<string, string>;
  /** Cached "is this a runnable script" verdicts for `.py` files (#py), keyed by
   *  absolute path — what gates the file tree's ▶ Run button. Each entry carries
   *  the `(size, mtime)` it was computed from, so an edited file is re-read and an
   *  untouched one never is, across viewer reopens and restarts alike. Persisted
   *  here precisely because the check needs the file's *content*: on a remote
   *  listing that is an SFTP round trip per file, which is why it used to be
   *  skipped there (and ▶ wrongly shown on every `.py`). Bounded and pruned by
   *  `lib/terminal/pythonMainCache`. Round-trips through the backend's `extra` catch-all —
   *  no Rust field needed. */
  python_main_scripts?: Record<string, PyMainVerdict>;
  run_scripts_in_background?: boolean;
  /** Show the untested pills throughout the desktop UI. Defaults to off. */
  show_untested_tags?: boolean;
  /** Header resource-monitor row toggles. Each defaults ON (undefined → shown).
   *  Independent of `debug`; the pill is available in every build. */
  show_cpu_usage?: boolean;
  show_ram_usage?: boolean;
  show_gpu_usage?: boolean;
  /** Header clock: show seconds. Off by default (hh:mm only). */
  show_clock_seconds?: boolean;
  /** When true (the default), Claude agent tabs are spawned with `--remote-control`
   *  so the running session can be monitored/steered from the Claude app/web. Only
   *  Claude supports this flag; other agents ignore the setting. */
  agent_remote_control?: boolean;
  /** Round-trip only: the fence used to be switchable. It is the only mode
   *  now (`services::agent_fence`); the backend never reads this. */
  agent_fence?: boolean;
  /** Extra host toolchain/config paths exposed read-only inside the fence.
   * Unset uses the backend defaults; an explicit empty list exposes none. */
  agent_fence_paths?: string[];
  /** Opt-in access to Cargo registry credential files in exposed toolchains. */
  agent_fence_cargo_credentials?: boolean;
  /** Accepted once: agents on a platform with no fence (Windows) run with the
   *  user's full rights. Backend-enforced (`agent_fence::platform_accepted`). */
  agent_fence_platform_accepted?: boolean;
  /** A fenced root-console agent sees every project, box folder and remote
   *  mirror read-only (default off: a widening). The mail `attach` argument
   *  needs it; recorded per root tab at spawn. */
  root_fence_projects_readable?: boolean;
  /** When true (the default), the usage recap opens by itself on the first launch
   *  of each day. Turning it off stops the popup, not the counting — the recap
   *  stays reachable from Settings. */
  daily_stats_recap?: boolean;
  /** UTC date ("YYYY-MM-DD") the recap was last auto-shown, so it opens once a day
   *  rather than once per window. Written by the recap host. */
  daily_stats_last_shown?: string;
  /** EXPERIMENTAL, default OFF. Gives a Python file in the code viewer its Run/Debug
   *  buttons and the breakpoint gutter (#87). Off by default because Run *executes
   *  the file* — one click away from an editor — so it is opt-in. Go-to-definition
   *  is not gated: it reads, it never runs anything. */
  python_run_debug?: boolean;
  /** EXPERIMENTAL, default OFF. The native presenter ("deck",
   *  `docs/deck_presenter_plan.md`): editable object layers over a base PDF, kept
   *  in a `*.eldeck.json` sidecar, plus the animate mode and the fullscreen
   *  presenter. Gated because it is the largest single viewer surface in the app
   *  and still moving — it registers a viewer, a file type, and a fullscreen mode. */
  deck_presenter?: boolean;
  /** EXPERIMENTAL, default OFF. Paint terminals with xterm's WebGL renderer (GPU
   *  glyph atlas — the tier VS Code ships) instead of the canvas renderer. Opt-in
   *  because it rides the GPU/driver path the DMABUF re-test failed on for this
   *  class of machine (flicker, missing content, renderer crash —
   *  `docs/typing_latency_plan.md` Step 4); a terminal whose WebGL fails, at load
   *  or via runtime context loss, demotes itself back to canvas. */
  terminal_webgl?: boolean;
  /** EXPERIMENTAL, default OFF. The markdown relationship graph: adds a "Graph"
   *  mode to the markdown viewer that crawls the viewed document's local-file
   *  links (markdown targets recursively, everything else as a leaf) and renders
   *  them as a clickable navigation map. Purely a frontend gate — the crawl rides
   *  the same confined `read_file_text` every viewer read uses. */
  md_graph?: boolean;
  /** EXPERIMENTAL, default OFF. Project-wide per-file remarks in REMARKS.md. */
  project_remarks?: boolean;
  /** Persistent LOCAL (tmux) sessions (TODO #85): when true (the default on Unix),
   *  a local project's shell/script tabs run inside a tmux session on the machine,
   *  so a long run keeps going if Tabtivity crashes and the tab reattaches on restart.
   *  `undefined`/`true` = on; `false` = off. No effect on Windows (no tmux). */
  persist_local_sessions?: boolean;
  /** When true (the default), remote SSH/OpenVPN connections are made headlessly
   *  in the background (Tabtivity handles the password transiently). When false, they
   *  are launched as interactive terminal tabs in the Tabtivity root scope, so the
   *  password is typed directly into the live terminal and Tabtivity never handles
   *  it. Default ON (headless) preserves existing behaviour. */
  connections_headless?: boolean;
  /** Hosts marked **careful** — "this machine is shared and policed, keep
   *  Tabtivity's background load off it" — keyed by canonical SSH target
   *  (`lib/remote/machineSync`'s `targetKey`, i.e. `user@host:port`), because one login
   *  node is simultaneously a primary `remote`, a worker and a global machine.
   *  The value is the user's EXPLICIT answer; a target absent from the map is
   *  **careful** — the default for every remote machine — which is why this is a
   *  map and not a list: an explicit `false` ("this one is mine") must be
   *  distinguishable from an unanswered host, or the default would keep
   *  re-enabling itself. See `lib/remote/carefulHost.ts`. */
  careful_hosts?: Record<string, boolean>;
  /** Machines tagged **HPC** — a shared cluster login node — keyed by the same
   *  SSH target as `careful_hosts`. Ticked on the login form and shown as a badge
   *  on the machine's row in the Machines menu. Where `careful_hosts` governs how
   *  much Tabtivity *looks at*, this governs what it *does*: a tagged host is careful
   *  regardless, and its disk-usage scan, giant-folder census, background sync +
   *  lockstep loops, silent auto-connect and unannounced login-node compute are
   *  all gated behind it. See `lib/remote/hpc/hpcHost.ts`. */
  hpc_hosts?: Record<string, boolean>;
  /** Path of the stored `.ovpn` config brought up automatically **on launch** —
   *  armed from the header's VPN menu, with no project behind it. Unset/null = no
   *  tunnel starts by itself. Only one config can be armed: a tunnel reroutes the
   *  whole machine, so two would fight over the routing. */
  vpn_auto_connect?: string | null;
  /** The `.ovpn` configs the user asked Tabtivity to remember the credentials of.
   *  No secret here — those live in the OS keychain; this is the *intent*, kept
   *  because a locked keychain answers every read like an empty one, so the
   *  toggle and the connect path would otherwise read "nothing saved" over a
   *  perfectly good saved credential (see `lib/keyring.ts`). */
  vpn_saved_configs?: string[];
  /** When true, the header's OpenVPN indicator is shown. Default OFF — most
   *  projects are local-only, so the machine-wide tunnel control stays hidden
   *  until asked for (the first-run `RemoteFeaturesPrompt`, or Settings). */
  vpn_enabled?: boolean;
  /** When true, the header's global-machines indicator is shown. Default OFF,
   *  same reasoning as `vpn_enabled`. */
  machines_enabled?: boolean;
  /** True once the first-run "Using VPN or remote machines?" prompt has been
   *  shown/answered, so it never re-asks automatically. */
  remote_features_prompted?: boolean;
  /** Energy-saver mode. "off" never throttles; "battery" (the default) throttles
   *  only while running on battery; "always" throttles regardless of power. When
   *  active, Tabtivity pauses the blob auto-spin, collapses idle animations, and
   *  widens always-on UI timers to reduce CPU/battery drain. */
  energy_saver?: "off" | "battery" | "always";
  /** Fast mode: drop the display aids that cost a directory walk, a standing
   *  poll or a per-file read. **Default false.** Read through `lib/agents/fastMode`
   *  (`useFastMode` / `fastModeActive`), which is also where the exact list of
   *  what it withdraws lives — never off this key directly, so the list has one
   *  home and every surface withdraws the same things.
   *
   *  A separate switch from `energy_saver` rather than a fourth value of it:
   *  energy saver widens timers off a *battery reading*, this removes features
   *  off a *standing preference*, and one merged control could not say "plugged
   *  in, still want it lean" — which is the case that asks for this. */
  fast_mode?: boolean;
  /** When true, the side panel is docked open (reflows layout) instead of hover-revealed. */
  side_panel_pinned?: boolean;
  /** Width of the side (files/git/search/sessions) panel in px. Set by dragging the
   *  panel's inner border; unset falls back to the default 280px. */
  side_panel_width?: number;
  /** Which edge the side panel docks against. Unset falls back to "right". Flipped
   *  by the ⇄ button in the panel header; round-trips through the settings `extra`
   *  catch-all, so no backend field is needed. */
  side_panel_edge?: "left" | "right";
  /** Which view of the side panel's file viewer (Files / Git / Apps / Agents /
   *  ± / sessions / jobs / remarks) was last chosen in *any* scope. Restored on
   *  launch, and used only for a scope `side_panel_view_by_project` has no entry
   *  for — the panel remounts on both a project switch and a relaunch, and coming
   *  back to Files every time meant a user living in Git or Agents re-picked it
   *  after each one. A view the current project has no button for (a remote-only
   *  or SLURM-only one) falls back to Files for as long as that is true, without
   *  overwriting what is stored. Rides the settings `extra` catch-all like
   *  `side_panel_edge`, so no backend field is needed. */
  side_panel_view?: FilesPanelView;
  /** The same, but per project — keyed by project id, and by scope name for the
   *  root and box scopes, which have no project id. This is what the panel reads
   *  first: living in Git on one project and in Files on another is the normal
   *  case, and a single global view made every switch re-pick. `side_panel_view`
   *  stays as the seed for a scope not in this map (the last view chosen
   *  anywhere), so a fresh project opens where the user was rather than snapping
   *  back to Files. Rides the settings `extra` catch-all, so no backend field is
   *  needed. */
  side_panel_view_by_project?: Record<string, FilesPanelView>;
  /** Pre-rename spellings of the three keys above, from when the panel was fixed to
   *  the right edge and named for it. Read-only fallbacks: settings.json written by
   *  an older build still carries them, and every read below is
   *  `side_panel_* ?? right_panel_*`. Nothing writes them any more, and they ride in
   *  the backend's `extra` catch-all, so an untouched install keeps its width, pin
   *  state and edge across the upgrade. @deprecated use the `side_panel_*` keys. */
  right_panel_pinned?: boolean;
  /** @deprecated use {@link Settings.side_panel_width}. */
  right_panel_width?: number;
  /** @deprecated use {@link Settings.side_panel_edge}. */
  right_panel_side?: "left" | "right";
  /** Minimum subwindow (split pane) width in px a divider drag may shrink to.
   *  Unset falls back to DEFAULT_MIN_SUBWINDOW_PX. */
  min_subwindow_width?: number;
  /** Minimum subwindow (split pane) height in px a divider drag may shrink to.
   *  Unset falls back to DEFAULT_MIN_SUBWINDOW_PX. */
  min_subwindow_height?: number;
  /** When true, in-app editors debounce-save edits automatically (#47). Default OFF. */
  autosave?: boolean;
  /** When true (the default), the text/TeX editors tint recently typed runs with a
   *  sequential new→old colour trail that fades as you keep typing. Default ON;
   *  only an explicit `false` disables it. */
  change_tint?: boolean;
  /** Per-type native-viewer prefs (#48): opt-in local autocomplete (#45). */
  viewer_prefs?: Record<string, ViewerPref>;
  global_apps?: Record<string, GlobalAppEntry>;
  /** User-chosen program per IDE id for "Open in <IDE>" (`IdeMenuItems`);
   *  an absent id means auto-detect. Written by `set_ide_launcher`. */
  ide_launchers?: Record<string, string>;
  /**
   * User overrides for the rebindable navigation chords (Group L / #62), keyed
   * by `ShortcutAction` id (see `src/lib/shortcuts/shortcuts.ts`). Any action absent here
   * falls back to its built-in default; an empty/missing map preserves the
   * original hard-coded behaviour.
   */
  keyboard_shortcuts?: Record<string, KeyboardChord>;
  /**
   * User overrides for the keys inside keyboard steering mode, keyed by
   * `SteeringAction` id (see `src/lib/shortcuts/steeringBindings.ts`): the
   * action's whole key list, replacing its defaults; `[]` unbinds it.
   */
  steering_keys?: Record<string, string[]>;
  /** Download *source* folders scanned by the side-panel Downloads section
   *  (fast-copy of freshly downloaded files into a project). Machine-wide,
   *  read-only. Unset/empty → the frontend falls back to the OS Downloads dir. */
  download_sources?: string[];
  /** True once the first-run "How to start" welcome has been shown/dismissed, so
   *  it never re-opens automatically. Re-openable manually from Settings. */
  onboarding_seen?: boolean;
  /** Ids of contextual hints (see `src/lib/shortcuts/hints.ts`) the user has seen/dismissed
   *  or implicitly acted on, so each surfaces at most once. */
  hints_seen?: string[];
  /** Master switch for the contextual hint system; default ON when unset. */
  hints_enabled?: boolean;
  /** True once the guided "Take a tour" walkthrough has been completed or
   *  skipped. Cosmetic only (never auto-launches the tour); the tour is always
   *  replayable from the gear menu / Settings. */
  tour_completed?: boolean;
  /** Where the main window was when Tabtivity last ran, so it reopens on the same
   *  monitor in the same place. Written by the debounced save in `AppShell`;
   *  consumed by the backend at startup, never rendered. */
  window_state?: WindowState;
  [key: string]: unknown;
}

/**
 * The main window's geometry in PHYSICAL desktop px — the canonical cross-window
 * space (`src/lib/window/coords.ts`), which is also what `outerPosition`/`outerSize`
 * report and what `setPosition`/`setSize` consume.
 *
 * `x`/`y`/`w`/`h` is the *restore* (non-maximized) rect: while the window is
 * maximized the rect is left alone and only `maximized` flips, so un-maximizing
 * after a restart lands on a real geometry instead of the full monitor.
 *
 * Mirrors `WindowState` in `src-tauri/src/schema/settings.rs`.
 */
export interface WindowState {
  x: number;
  y: number;
  w: number;
  h: number;
  maximized: boolean;
}

export interface OpenVpnSpec {
  /** Absolute path to the local `.ovpn` client config file. */
  config: string;
  /** Auth username for `auth-user-pass` configs (server-side username+password
   *  auth). Persisted (not a secret); the password is still prompted separately. */
  username?: string;
}

/** Verdict of `ssh_probe`: a silent, keychain-read-only reachability + auth check.
 *  `unreachable` distinguishes "this network can't reach the host" from "the host
 *  rejected the credential" — only the former warrants bringing a VPN tunnel up. */
export interface SshProbe {
  ok: boolean;
  unreachable: boolean;
  error: string;
}

/** A previously-used `.ovpn` config copied into Tabtivity's store, offered for
 *  reuse so a config need only be browsed for once. */
export interface StoredVpnConfig {
  /** Absolute path to the stored copy (passed to `openvpn_connect`). */
  path: string;
  /** Friendly display name (the original `.ovpn` file name). */
  name: string;
}

/** A globally connected worker machine (`stores/remote/globalMachines.ts`):
 *  authenticated once via the ordinary login mechanism, with no
 *  `remote_path` — project-free, unlike {@link ComputeHost}. Drag-and-dropped
 *  onto an SSH project to become a `shared_fs` compute host there (a value
 *  copy of this identity, not a reference). */
export interface GlobalMachine {
  id: string;
  user?: string;
  host: string;
  port?: number;
  label?: string;
  /** Opt-in to a silent connect on launch and whenever a VPN tunnel comes up
   *  (the machine-wide twin of a project's `RemoteSpec.auto_connect`). */
  auto_connect?: boolean;
}

/** One machine as it crosses the import/export boundary
 *  (`commands::global_machines::MachineIo`): the connection address + label
 *  only. An exported file carries no `user` and never a password — import
 *  supplies one shared username + password for the whole batch. `user` is an
 *  accepted field on a hand-authored file, so it is optional here. */
export interface MachineImportEntry {
  host: string;
  port?: number;
  label?: string;
  user?: string;
}

/** Which secrets a `.ovpn` config needs from the user (`openvpn_auth_needs`), so
 *  the UI shows exactly the fields that config will be asked for. The two are
 *  independent — a config can need both, and OpenVPN prompts for them separately,
 *  so supplying only one hangs the handshake on the other prompt. The local root
 *  password is a third secret, but polkit/`pkexec` collects that one, not Tabtivity. */
export interface VpnAuthNeeds {
  /** Bare `auth-user-pass`: server-side account auth, so a username is required. */
  username: boolean;
  /** An encrypted private key, whose passphrase OpenVPN asks for separately. */
  keyPassphrase: boolean;
}

/** Whether the config's key passphrase is a *separate* field from its password.
 *  When a config has an encrypted key but no `auth-user-pass` account, the single
 *  password field already *is* the key passphrase (it goes to `--askpass`), so a
 *  second field would be asking for the same secret twice. */
export const needsSeparateKeyPassphrase = (needs: VpnAuthNeeds): boolean =>
  needs.username && needs.keyPassphrase;

/**
 * What a project remembers about its HPC **workspace** and its **home anchor**
 * (`docs/hpc_workspace_plan.md`; backend `schema::project::HpcInfo`).
 *
 * It is persisted rather than re-derived because none of it survives the
 * workspace: the tooling's recovery path (`ws_restore`) is keyed by the workspace
 * *name*, and the host tree that would have named it is exactly what expiry
 * deletes. `logs_dir` additionally rescues **Watch** on an older job — with
 * `--output` routed into the home anchor, `scontrol`'s `<WorkDir>/slurm-<id>.out`
 * fallback points at a file that never existed.
 */
export interface HpcInfo {
  workspace_id?: string;
  workspace_path?: string;
  filesystem?: string;
  anchor_dir?: string;
  /** The anchor as the `$HOME`-relative path it was created from — kept so a
   *  re-anchor (moving to another workspace) passes the rel back instead of
   *  guessing it by chopping segments off the absolute one. */
  anchor_rel?: string;
  logs_dir?: string;
}

export interface RemoteSpec {
  user?: string;
  host: string;
  port?: number;
  remote_path: string;
  /** Optional OpenVPN tunnel brought up before reaching the host. */
  openvpn?: OpenVpnSpec;
  /** Opt-in: connect this project on launch/activation instead of waiting for the
   *  user to bring it up from the pill's connection lamp. Only offered when the
   *  connect can complete with no prompt (saved SSH password, or `key_auth`), and
   *  the connect path re-checks that — it never prompts. */
  auto_connect?: boolean;
  /** Recorded by the backend, not user-set: the last successful connect to this
   *  host used no password at all (key/agent auth). A passwordless host has nothing
   *  in the keychain, so this is the only way the UI can tell it is auto-connectable. */
  key_auth?: boolean;
  /** Display name for this machine, e.g. "gpu-2"; falls back to `host`. Shown
   *  wherever a project's hosts are listed side by side (System Monitor's source
   *  picker, the pill's connection lamps, `hostsForProject`). Distinct from the
   *  *project* name — this labels the machine, not the project. */
  label?: string;
  /** Persistent remote sessions (TODO #85): run this project's remote shell/script
   *  AND remote agent tabs inside a **tmux** session on the host, so a long run (or a
   *  live agent) survives an SSH drop, a laptop sleep, or Tabtivity quitting. **Default
   *  ON** — `undefined`/`true` mean enabled; only an explicit `false` (the pill's
   *  toggle) opts out. An agent tab's tmux persistence composes with its `--resume`
   *  restore (`tmux new-session -A` reattaches the live process, else runs `--resume`).
   *  See `persistSessionsEnabled`. */
  persist_sessions?: boolean;
  /** This spec reaches a **project VM** Tabtivity itself booted
   *  (`docs/vm_projects_plan.md`): host is loopback and port the per-boot QEMU
   *  forward. Written by the backend at creation/boot, never user-set. What a
   *  VM-aware surface (the pill glyph, the spawn guard) dispatches on. */
  vm?: boolean;
}

/** Egress policy for a project VM (`docs/vm_projects_plan.md`): `off` = the
 *  guest reaches nothing; `proxy` (default) = only the allowlisting CONNECT
 *  proxy (agent APIs; denied CONNECTs are logged and surfaced); `open` = full
 *  NAT. The honest caveat the UI states for `proxy`: the agent can still
 *  exfiltrate *to the allowed endpoints* — the proxy narrows the channel, it
 *  cannot close it while a cloud agent runs. */
export type VmEgress = "off" | "proxy" | "open";

/** Per-project VM config (`docs/vm_projects_plan.md`) — the third trust tier:
 *  the whole project inside a locally booted QEMU/KVM VM, reached exclusively
 *  over SSH/SFTP, **no shared filesystem**. Chosen at creation (not a
 *  flip-anytime toggle); mutually exclusive with `sandbox`. */
export interface VmSpec {
  enabled: boolean;
  /** Guest memory in MiB (default 4096). */
  memory_mb?: number;
  /** Guest vCPUs (default 2). */
  cpus?: number;
  /** Overlay disk virtual size in GiB (default 32; qcow2 grows on demand). */
  disk_gb?: number;
  egress?: VmEgress;
  /** Extra allowlisted hosts for `proxy` egress (exact host or ".suffix"). */
  allow_hosts?: string[];
  /** Allow github.com (+ API/raw hosts) through the proxy. Opt-in, default
   *  off — the initial clone uses a *temporary* allow instead. */
  allow_github?: boolean;
  /** This VM is a contained mail reader: its agent tabs are served the root
   *  MCP's mail read tools while the box stays at the default proxy allowlist.
   *  Trusted only from the state-dir record, never the in-folder project.json. */
  mail_reader?: boolean;
}

/** `vm_doctor`'s verdict: can this machine boot project VMs, and if not, why
 *  (actionable, one reason per failed probe). A missing base image is not a
 *  failure — `fetch_command` is the one-click build-tab fetch. */
export interface VmDoctorReport {
  supported: boolean;
  ok: boolean;
  qemu: boolean;
  kvm: boolean;
  qemu_img: boolean;
  iso_tool?: string;
  disk_free_gb?: number;
  base_image_ready: boolean;
  baked_image_ready: boolean;
  reasons: string[];
  fetch_command?: string;
  bake_command?: string;
  /** Missing host *packages* (QEMU, qemu-img, arm64 firmware, a seed tool) as
   *  one install command, so the dialog offers a button that runs it rather
   *  than a sentence to retype. Absent when nothing missing is installable —
   *  a `/dev/kvm` permission problem and a full disk are reasons to read. */
  install_command?: string;
}

/** `vm_status`'s answer — what the pill glyph + VM settings render from. */
export interface VmStatus {
  configured: boolean;
  running: boolean;
  ssh_port?: number;
  egress?: VmEgress;
  blocked: VmBlockedReport;
}

/** Denied CONNECTs through the VM egress proxy — the exfiltration tripwire. */
export interface VmBlockedReport {
  total: number;
  recent: { target: string; at_secs: number }[];
}

/** An extra SSH "worker" machine a project runs experiments on
 *  (`docs/multi_host_remote_plan.md`). Its code is kept one-way in sync from the
 *  canonical source (the primary's local mirror) and its files are read-only —
 *  edits are forbidden, so there is no divergence and no destructive local-loss.
 *  The primary remote (`ProjectEntry.remote`) is unchanged. Extends `RemoteSpec`
 *  (flattened on the backend), so it carries the same user/host/port/remote_path/
 *  openvpn/auto_connect fields. */
export interface ComputeHost extends RemoteSpec {
  /** Stable id (e.g. "h1"); referenced by tab locations, the pool key, and the
   *  fan-out state. The primary is the implicit id `"primary"`. */
  id: string;
  /** Keep this worker's tracked tree synced to the source HEAD (default true). */
  sync_code?: boolean;
  /** Pull this worker's experiment OUTPUTS back only on demand (default false —
   *  outputs stay on the worker). */
  pull_outputs?: boolean;
  /** This machine reaches the project over a **shared filesystem**: it already
   *  sees the primary's project folder at `remote_path`, so Tabtivity copies no code
   *  to it and never runs git on it — shells just `cd` into the shared tree and
   *  run there. The default for a newly added machine (untick "Sync a copy" for
   *  the synced-copy worker instead). Schema default false for back-compat. */
  shared_fs?: boolean;
}

/** Per-project container config (TODO #38). When `enabled`, every terminal and
 *  agent tab of the project execs into ONE session-lived Docker container that
 *  mounts only the project directory (plus minimal agent auth/state paths) at
 *  its identical host path. Absent = run on host. The hardening fields below
 *  are optional overrides; unset means the built-in default (see
 *  `services::sandbox` in the backend). */
/** Which of a project's tabs the container applies to.
 *
 *  `all` is the strict reading and the default (an older spec with no `scope`
 *  key deserializes to it, so no project loses containment on upgrade).
 *  `agents` contains agent tabs only and leaves shells, scripts and the viewer's
 *  Run/Debug tabs on the host — which is what makes a host toolchain (a `.venv`
 *  whose interpreter is a host symlink, conda, pyenv) usable without switching
 *  the container off. Classification is by the command that actually executes;
 *  see `services::sandbox::is_agent_cmd`. */
export type SandboxScope = "all" | "agents";

export interface SandboxSpec {
  enabled: boolean;
  /** Which tabs the container applies to. Unset = `"all"`. */
  scope?: SandboxScope;
  image?: string;
  /** In-repo Dockerfile (relative to the project dir); when set, the container
   *  is built from it (`tabtivity-<id>:latest`) instead of pulling `image`. */
  dockerfile?: string;
  /** `--pids-limit` (fork-bomb guard). Unset = generous built-in default. */
  pids_limit?: number;
  /** Hard memory cap, e.g. "4g" (`--memory`). Unset = unlimited. */
  memory?: string;
  /** CPU cap, e.g. "2" (`--cpus`). Unset = unlimited. */
  cpus?: string;
  /** Docker network, e.g. "none" for no egress (`--network`). Unset = bridge. */
  network?: string;
  /** Read-only root filesystem (`--read-only` + tmpfs /tmp). Default false. */
  readonly_rootfs?: boolean;
  /** Hash of the in-repo Dockerfile/devcontainer image last confirmed (O#143);
   *  opaque to the frontend beyond echoing it back in a `SandboxSourceDecision`. */
  spec_source_hash?: string;
}

/** What an in-repo Dockerfile/devcontainer declares (O#143) — detection only,
 *  reported by `set_project_sandbox`'s `needs_confirmation` outcome. */
export interface DetectedSpecSource {
  kind: "dockerfile" | "devcontainer_image";
  /** The Dockerfile path (relative) or the devcontainer `image` string. */
  value: string;
  /** SHA-256 hex of the deciding content — echo back verbatim in the decision. */
  hash: string;
}

/** The answer to a `needs_confirmation` outcome: `hash` must be the detected
 *  source's `hash` verbatim (a mismatched hash is refused, not applied). */
export interface SandboxSourceDecision {
  hash: string;
  adopt: boolean;
}

export type SandboxToggleOutcome =
  | { outcome: "applied"; spec: SandboxSpec }
  | { outcome: "needs_confirmation"; source: DetectedSpecSource };

export interface RemoteEntry {
  name: string;
  is_dir: boolean;
}

/** Availability of the remote-project capabilities that depend on the platform.
 * Remote projects are SSH/SFTP-native (no FUSE mount), so only password auth and
 * VPN-gated (`openvpn`) hosts need anything beyond a stock `ssh`. */
export interface SshTooling {
  /** Whether non-interactive password auth works without installing anything.
   * Always true on Unix (OpenSSH's `SSH_ASKPASS`); on Windows it needs either
   * OpenSSH ≥ 8.4 (same askpass mechanism) or `sshpass` as the legacy fallback. */
  password_auth: boolean;
  /** `openvpn` + `pkexec` — required only for VPN-gated hosts. */
  openvpn: boolean;
  /** `rsync` on the local machine — enables the SSH-sync bulk fast-path. */
  rsync: boolean;
}

export type GitPushMcpLevel = "off" | "propose" | "apply";
/** The trusted per-project agent-push policy (`services::git_push_mcp`). */
export interface GitPushMcpPolicy {
  level?: GitPushMcpLevel;
  protected?: string[];
  confirmed_url?: string;
}
/** One agent push or release request as the backend reports it (`git_push_mcp_proposals`). */
export interface GitPushProposal {
  id: string;
  session: string;
  tab: string;
  project: string;
  /** A branch push, or a release tag on a pushed tip (`services::git_release`). */
  kind: "push" | "release";
  /** The release tag (`kind === "release"`). */
  tag: string | null;
  branch: string | null;
  remote: string | null;
  url: string | null;
  head: string | null;
  remote_sha: string | null;
  commits: string[];
  diffstat: string;
  note: string;
  needs_url_confirm: boolean;
  created_at: string;
  status: "running" | "pending" | "pushed" | "failed" | "dismissed" | "expired";
  category: string | null;
  message: string;
  output: string;
  preflight_output: string;
  /** The user closed the finished card (`git_push_mcp_clear`). */
  cleared: boolean;
  state: { branch: string | null; head: string | null; remote: string | null; upstream: string | null; url: string | null; remote_sha: string | null; ahead: number; behind: number };
}

/** The git bar's Release dialog state (`git_release_preview`). */
export interface GitReleasePreview {
  suggested: string;
  /** The manifest the version came from; null when counted up from the latest tag. */
  source: string | null;
  branch: string | null;
  head: string | null;
  subject: string | null;
  url: string | null;
  /** Why a release cannot go out right now (push first, tag exists, …). */
  problem: string | null;
  category: string | null;
}

export interface ProjectEntry {
  schedule_mcp?: "off" | "propose" | "apply";
  git_push_mcp?: GitPushMcpPolicy;
  id: string;
  name: string;
  /** "current" | "active" | "inactive" */
  status: string;
  position: number;
  local_file: string;
  directory?: string;
  description?: string;
  remote?: RemoteSpec;
  /** Extra "worker" machines this project runs experiments on
   *  (`docs/multi_host_remote_plan.md`). One-way, read-only; the primary is
   *  `remote`. Mirrored from project.json into the pill list. */
  compute_hosts?: ComputeHost[];
  /** Docker sandbox config; when `enabled`, agent tabs run in a container. */
  sandbox?: SandboxSpec;
  /** Project-VM config (`docs/vm_projects_plan.md`): present iff this project
   *  lives inside a locally booted VM (its `remote` then points at the VM's
   *  forwarded loopback port). Mutually exclusive with `sandbox`. */
  vm?: VmSpec;
  /** The interpreter the code viewer's Run/Debug buttons use (#87). Absent =
   *  auto-detect, which is right for almost every project; pinning it is for the
   *  environments auto-detect cannot see (a conda env, a Poetry venv outside the
   *  tree, a second venv). Set from the pill's "Python interpreter…" dialog. */
  python_interpreter?: string;
  /** Per-project override of the global "Claude remote control" setting
   *  (O#59). `true`/`false` force it on/off for this project's Claude agent
   *  tabs; absent inherits the global setting (`settings.agent_remote_control`,
   *  default ON). Set from the pill's "Remote control" menu item. */
  remote_control?: boolean;
  /** Round-trip only: the per-project fence override of older versions. The
   *  fence is the only mode now and this is never read. */
  agent_fence?: boolean;
  /** Which machine shells launched from this project run on — the persisted
   *  `RunHostPicker` choice (a `TabLocation`: "local" | "remote" | "host:<id>").
   *  Seeds the live `useRunHostPrefStore` on load so the choice survives a
   *  relaunch. Mirrored from project.json's `run_host` into the entry's flattened
   *  `extra`. Absent = the shell default (the primary). */
  run_host?: string;
  /** The HPC workspace this project's tree lives in + its home anchor
   *  (`docs/hpc_workspace_plan.md`). Mirrored from project.json's `hpc`. Absent
   *  for every project that isn't in a workspace. */
  hpc?: HpcInfo;
  /** Per-project git-hosting profile URL that overrides the global one. Mirrored
   *  from project.json into the pill list; the matching token lives in the OS
   *  keyring, never here. See `GitHostingInfo`. */
  git_profile_url?: string;
  /** Hosting provider this project was published to, recorded at publish time.
   *  Absent until published to a remote. */
  git_provider?: GitProvider;
  /** Provider sniffed from the local `origin` host at load time (host-only, no
   *  network). Decorates the pill badge for repos pushed to a host outside
   *  Tabtivity's Publish flow. Transient — never persisted to projects.json. */
  detected_provider?: GitProvider;
  /** Raw `origin` remote URL sniffed alongside `detected_provider`. Shown as the
   *  git address in the project hover. Transient — never persisted. */
  git_origin_url?: string;
  /** User-assigned category tags. Group/color the project in the cloud + pills;
   *  set via the pill / blob-node right-click menu. Stored in the entry's
   *  flattened `extra` (mirrored into project.json). */
  categories?: string[];
  /** Explicit trusted-state opt-in for phone/tablet terminal access. */
  [MOBILE_ACCESS_KEY]?: boolean;
  [key: string]: unknown;
}

/** A row in the Settings "Archived projects" list (from `list_archived_projects`).
 *  Archived projects live under `~/tabtivity/archive/<id>/` until restored or
 *  permanently cleared. */
export interface ArchivedProject {
  id: string;
  name: string;
  /** ISO timestamp the project was archived (stamped at delete time). */
  archived_at: string;
  /** True for remote (SSH) projects — their host tree was never touched. */
  remote: boolean;
}

/** One local mirror branch carrying commits the host baseline lacks. */
export interface UnsyncedBranch {
  name: string;
  count: number;
}

/** Whether permanently deleting an archived remote project would discard
 * local-only mirror history. Computed offline from the archived files. */
export interface UnsyncedReport {
  /** Commits on the mirror's local branches not present on the host baseline. */
  total: number;
  branches: UnsyncedBranch[];
  /** False when there was no host baseline to compare against (the count is then
   * every local commit and should read as "could not verify"). */
  verified: boolean;
}

/* ── Project export / import (docs/context/project_transfer.md) ───────────── */

/** What a `.tabtivityproj` bundle actually carries (Rust `BundleContents`). */
export interface BundleContents {
  dir: boolean;
  state: boolean;
  mirror: boolean;
  gitHistory: boolean;
  /** `node_modules`, `.venv`, `target`, … were left out of the bundle. */
  rebuildableSkipped: boolean;
  files: number;
  bytes: number;
}

/** `preview_project_export` — what an export would carry, with sizes, so the
 *  dialog's toggles have numbers attached. */
export interface ExportPreview {
  projectId: string;
  name: string;
  remote: boolean;
  directory: string | null;
  directoryMissing: boolean;
  mirror: string | null;
  mirrorMissing: boolean;
  files: number;
  bytes: number;
  gitFiles: number;
  gitBytes: number;
  rebuildableFiles: number;
  rebuildableBytes: number;
  tabs: number;
  boxNames: string[];
  suggestedFileName: string;
  /** Machine token (`"vm"`) when this project cannot be exported. */
  blocked?: string;
}

/** `export_project`'s answer. `notes` are machine tokens worded by
 *  `transfer.note.*`. */
export interface ExportReport {
  path: string;
  bytes: number;
  files: number;
  payloadBytes: number;
  remote: boolean;
  notes: string[];
}

/** `project-export` progress event payload. */
export interface ExportProgress {
  projectId: string;
  phase: "start" | "file" | "done";
  done: number;
  total: number;
}

/** `inspect_project_export` — a bundle's manifest, read without unpacking. */
export interface BundleInfo {
  path: string;
  format: number;
  appVersion: string;
  exportedAt: string;
  projectId: string;
  name: string;
  remote: boolean;
  description: string | null;
  gitType: string | null;
  directory: string | null;
  mirror: string | null;
  contents: BundleContents;
  tabs: number;
  boxNames: string[];
  timeDays: number;
  /** A project with the bundle's own id is already registered here, so the
   *  import gets a fresh one (the original stays put). */
  idInUse: boolean;
  /** Name of the project a remote bundle's host+path already belongs to. */
  siteConflict?: string;
  suggestedParent: string;
}

/** `import_project_export`'s answer. */
export interface ImportBundleResult {
  entry: ProjectEntry;
  directory: string;
  mirror?: string | null;
  files: number;
  tabsRestored: number;
  /** Tabs the sanitizer downgraded to a plain shell (unknown command). */
  tabsDowngraded: number;
  newId: boolean;
  boxesJoined: string[];
  boxesMissing: string[];
  notes: string[];
}

/** Supported git-hosting providers for publishing a project's repo. */
export type GitProvider = "github" | "gitlab";

/**
 * Which side a work-remote project publishes from. Not "where the files are":
 * the provider login (`gh auth login`, the tokens in Settings → Git Hosting) is
 * *this* machine's, and a work remote is typically a cluster login node with no
 * provider CLI and no GitHub credentials — while the lockstep mirror is a full
 * local repo holding the same commits. Hence `"local"` is the default;
 * `"remote"` is the opt-in for a host that does have its own `gh`/`glab` login.
 * Ignored for a local project, which has only one side.
 */
export type PublishFrom = "local" | "remote";

/**
 * Per-project git-hosting config as returned by `get_project_git_hosting`. The
 * token is never sent to the renderer — only whether one is stored — and the
 * global values are surfaced so the editor can show what is inherited by default.
 */
export interface GitHostingInfo {
  /** Per-project profile URL override, if set (else inherits `global_profile_url`). */
  profile_url: string | null;
  /** Whether a per-project token is stored in the keyring. */
  has_token: boolean;
  /** Global fallback profile URL (from settings), shown as the inherited default. */
  global_profile_url: string | null;
  /** Whether a global token exists to fall back on. */
  has_global_token: boolean;
}

/**
 * A directed relation between two members of a box ("a change in `source` may
 * influence `target`"). Mirrors the Rust `BoxRelation` (#41 Phase 2: stored).
 */
export interface BoxRelation {
  source: string;
  target: string;
  kind?: string;
  hint?: string;
}

/**
 * A project box — meta-project grouping (#13 + #41). Mirrors the Rust
 * `ProjectBox` (serde-synced snake_case fields), persisted in `boxes.json`.
 */
export interface ProjectBox {
  id: string;
  name: string;
  member_ids: string[];
  position: number;
  /** The backend's revision of this box: carried back on `save_boxes`, which
   * refuses a box that moved on since it was loaded (headless owner plan, H1). */
  rev?: number;
  /** Absolute box-folder path; filled lazily on first open (#41 Phase 2). */
  folder?: string;
  /** Directed inter-project relations (#41 Phase 2 stored, Phase 4 surfaced). */
  relations?: BoxRelation[];
  /** Tabtivity Mobile reach (#31aa): the box's `box:<id>` scope is listed on a
   *  paired phone. Off/absent by default, like a project's switch. */
  [MOBILE_ACCESS_KEY]?: boolean;
  /** User-picked colour (`#rrggbb`); absent = hashed from the id
   *  (`lib/theme/boxColor`). Rides the Rust struct's flattened `extra`. */
  color?: string;
  /** The box has no pill of its own on the header row — only a row in the
   *  scope chip's list. Absent = shown. Rides `extra` too. */
  hide_pill?: boolean;
}

/**
 * The native calendar's model, mirroring `src-tauri/src/schema/calendar.rs`.
 *
 * All timestamps are **local wall-clock**: `"YYYY-MM-DDTHH:MM"` when timed,
 * `"YYYY-MM-DD"` when all-day. Ends are **exclusive** (an all-day event on the
 * 8th ends `"2026-07-09"`). See `src/lib/calendar/calendarTime.ts` for the math.
 */

/** The views a calendar tab can show. */
export type CalendarViewKind =
  | "day"
  | "week"
  | "multiweek"
  | "month"
  | "agenda"
  | "tasks";

/** One named, colored calendar in the sidebar list. */
export interface Calendar {
  id: string;
  name: string;
  /** CSS color its events render in. */
  color: string;
  /** Unchecked in the sidebar → its events drop out of every view. */
  visible: boolean;
  readonly: boolean;
  /**
   * The ICS feed URL this calendar was subscribed from (e.g. TimeTree's
   * calendar-export URL), if any — set on first "Refresh from URL" import and
   * read back to find which calendar a later refresh replaces. Rides the
   * Rust schema's `#[serde(flatten)] extra` map, so an older build reading
   * this file simply doesn't recognize the key rather than failing to parse.
   * Absent for a calendar imported from a local file or created by hand.
   */
  source_url?: string;
  /**
   * The `CalDavAccount.id` this calendar is synced from, and the collection's
   * own URL on that account. Both ride the Rust schema's `extra` flatten, the
   * same way `source_url` does.
   *
   * Deliberately **only the pointer**: the login, the sync cursors and the
   * keychain reference live in `caldav/accounts.json`, not here — this file is
   * read by every calendar tab on mount and exported alongside a calendar, and
   * account plumbing has no business in either (`docs/caldav_plan.md`).
   */
  caldav_account_id?: string;
  caldav_href?: string;
  /**
   * Filled from an `.ics` file (`stores/calendar/importIcs`). Rides `extra`
   * like the keys above; the root agent's read tools show such a calendar's
   * text as external. Absent on calendars imported before the mark existed.
   */
  imported?: boolean;
  /**
   * Reminders for this calendar's events are switched off — no popup, no OS
   * notification (`stores/calendar/alarms`). Rides `extra` like the keys above;
   * absent means on. Independent of `visible`.
   */
  alerts_off?: boolean;
}

/** How often a recurring event repeats. */
export type Freq = "daily" | "weekly" | "monthly" | "yearly";

/** A recurrence rule. `until` and `count` are mutually exclusive ends. */
export interface Rrule {
  freq: Freq;
  /** Repeat every N periods. */
  interval: number;
  /** Weekly only: weekdays to fire on, `0` = Sunday … `6` = Saturday. */
  byweekday?: number[];
  /** Monthly only: day of month (1-31). Absent → the event's own day. */
  bymonthday?: number | null;
  /**
   * Monthly and yearly: the numbered weekdays to fire on — `{ n: 2, day: 2 }` is
   * the 2nd Tuesday, `{ n: -1, day: 5 }` the last Friday. Monthly counts within
   * each month; yearly within the month the event starts in (iCalendar's
   * `FREQ=YEARLY;BYMONTH=11;BYDAY=4TH`). Takes precedence over `bymonthday`.
   */
  bynthweekday?: NthWeekday[];
  /** Inclusive last date (`"YYYY-MM-DD"`) the rule may fire on. */
  until?: string | null;
  /** Total occurrences, counting the first. */
  count?: number | null;
  /**
   * The RRULE value exactly as imported, kept only when the fields above could
   * not hold all of it (an `HOURLY` part, `BYSETPOS` over several days, several
   * `BYMONTHDAY`s…). Export writes it back verbatim while the rule still says
   * what it said on import, so a CalDAV push never replaces the server's rule
   * with Tabtivity's reduced reading of it. Any edit to the rule drops it.
   */
  ics_value?: string | null;
}

/** One numbered weekday of a recurrence: the `n`th (negative: from the end) `day`. */
export interface NthWeekday {
  /** `1`…`5` from the start of the month, `-1`…`-5` from its end. */
  n: number;
  /** `0` = Sunday … `6` = Saturday. */
  day: number;
}

/** A single occurrence edited away from its master ("this event only"). */
export interface EventOverride {
  /** The occurrence's start as the rule generated it — the key. */
  occurrence_start: string;
  start?: string | null;
  end?: string | null;
  title?: string | null;
  location?: string | null;
  notes?: string | null;
}

/** A reminder, fired `minutes_before` the occurrence starts. */
export interface Alarm {
  minutes_before: number;
}

/** `"confirmed"` (default) | `"tentative"` | `"cancelled"`. */
export type EventStatus = "confirmed" | "tentative" | "cancelled";

/** A calendar event. `end` is exclusive. */
export interface CalendarEvent {
  id: string;
  calendar_id: string;
  start: string;
  end: string;
  all_day: boolean;
  title: string;
  location?: string;
  notes?: string;
  /** The video call's join URL (`http(s)` only). Its own field rather than a
   *  convention on `location`, because a Join button must not be a guess about
   *  what a room name means — see `lib/calendar/conference.ts`, which still *derives* one
   *  from `location`/`notes` for the imported invitations that carry it there. */
  conference?: string;
  category?: string;
  status?: EventStatus | "";
  rrule?: Rrule | null;
  /** Occurrence starts deleted from the series. */
  exdates?: string[];
  overrides?: EventOverride[];
  alarms?: Alarm[];
  /** The CalDAV resource this row was synced from, and its ETag. Present only
   *  on rows a CalDAV sync created; they are what the reconciliation matches on,
   *  so nothing else may write them. */
  caldav_href?: string;
  caldav_etag?: string;
  /** The iCalendar `UID` this row arrived with — the calendar object's identity
   *  everywhere outside this app. Empty for a row written here, which serializes
   *  under a stable synthetic uid instead (`lib/calendar/ics.ts`'s `icsUid`). Never
   *  displayed; it exists so a row can go *back* to the server as the object it
   *  came from rather than as a second copy of it. */
  uid?: string;
  /** Set on a row that **is** a single-occurrence override of a repeating series
   *  — the rule-generated slot it replaces (`RECURRENCE-ID`). CalDAV has no
   *  separate occurrence object, so master and overrides arrive as separate rows
   *  sharing one `caldav_href`, and this is what says which is which. An event
   *  authored here keeps its occurrence edits in `overrides` instead; the
   *  serializer writes both shapes the same way. */
  recurrence_id?: string;
}

/** One checklist item inside a task. */
export interface Subtask {
  id: string;
  title: string;
  done: boolean;
}

/** The mail a card was converted from — identifiers plus a snapshot taken at
 *  conversion, never a path. `message_id` is the `MailHeader.id` store key that
 *  `mail_body`/`mail_flag`/`mail_priority_set` take. The subject/from are frozen
 *  so the card still reads after the message is deleted from the server. */
export interface TaskMailLink {
  message_id: string;
  account_id?: string;
  folder_id?: string;
  subject?: string;
  from?: string;
  priority_at_convert?: string;
}

/** The appointment a card was converted from — `TaskMailLink`'s twin, built the
 *  same way and for the same reasons: identifiers plus a snapshot frozen at
 *  conversion, so the card still reads after the event is deleted.
 *
 *  It names an **occurrence**, never a series: `occurrence_start` is what makes
 *  next week's instance of a weekly meeting a card of its own rather than a
 *  duplicate of this week's. */
export interface TaskEventLink {
  event_id: string;
  /** The occurrence's local start stamp (`"YYYY-MM-DDTHH:MM"`). */
  occurrence_start?: string;
  calendar_id?: string;
  title?: string;
  location?: string;
}

/** A project file a card was converted from, plus a frozen remark snapshot. */
export interface TaskFileLink {
  project_id?: string;
  path: string;
  line?: number | null;
  text?: string;
}

/** One column of the todo board. */
export interface TaskColumn {
  id: string;
  name: string;
  position: number;
  /** **The** completion column: dropping a card here completes it. At most one
   *  column carries it; zero is legal and turns the coupling off. */
  done: boolean;
  /** An **archive**: a resting place that outranks the completion coupling, so a
   *  finished card filed here stays instead of snapping back to Done. Nothing
   *  auto-moves a card here, and an unplaced card is never filed here. */
  archived?: boolean;
  /** **The** overdue column: a card whose deadline has passed is *shown* here,
   *  whatever column it is filed in. Display only — see `columnOf`. */
  overdue?: boolean;
  /** **The** today column: a card due today is shown here. `overdue`'s twin. */
  due_today?: boolean;
  /** **The** intake column: where an unplaced card lands and every conversion
   *  files one. Flagged rather than inferred from position, because the board
   *  leads with the date columns and puts the backlog behind Doing. */
  intake?: boolean;
  color?: string;
  /** Advisory WIP cap; `0` = none. Nothing ever refuses a move because of it. */
  limit?: number;
}

/** A to-do (VTODO) — and a card on the todo board. */
export interface CalendarTask {
  id: string;
  calendar_id: string;
  title: string;
  notes?: string;
  due?: string | null;
  start?: string | null;
  /** iCalendar priority: `0` = unset, `1` = highest … `9` = lowest. */
  priority: number;
  /** 0-100; `100` implies done. */
  percent: number;
  completed?: string | null;
  category?: string;
  alarms?: Alarm[];
  /** Board column id. Absent means "never placed" — the backend deliberately
   *  does not backfill one on read, so a card acquires it on its first move. */
  column?: string;
  /** Fractional rank within `column`, ascending. Absent = unranked (sorts last). */
  rank?: number | null;
  tags?: string[];
  subtasks?: Subtask[];
  mail?: TaskMailLink | null;
  /** The appointment this card was converted from. A card carries at most one of
   *  `mail`/`event` — both conversions build the same card, they differ only in
   *  which object they record. */
  event?: TaskEventLink | null;
  /** The file remark this card was converted from. */
  file?: TaskFileLink | null;
  /** `ProjectEntry.id`, or absent. Never validated against `projects.json` — an
   *  unresolvable id still filters and renders as an unknown-project chip. */
  project_id?: string;
  /** Local wall-clock stamp minted at creation (`"YYYY-MM-DDTHH:MM"`). */
  created?: string;
  /** The CalDAV resource this card was synced from, and its ETag. Everything
   *  above from `column` down is Tabtivity's own and is **never** overwritten by a
   *  sync — that is the whole point of matching on the href. */
  caldav_href?: string;
  caldav_etag?: string;
  /** The iCalendar `UID` this card arrived with. See `CalendarEvent.uid`: a
   *  push writes the object back under the identity it came with, never a fresh
   *  one, or the server keeps the old VTODO and files ours beside it. */
  uid?: string;
}

/** One card's target position after a drag, for `todo_move_tasks`. The backend
 *  takes an **index**, not a rank, so the rank algebra lives in one place and a
 *  replayed placement is a no-op. */
export interface TaskPlacement {
  id: string;
  column: string;
  index: number;
  /** Stamp to use if this move completes the card (the frontend owns the clock —
   *  the backend has no local-time source). */
  completed_stamp?: string | null;
}

/** The whole of `calendar.json`. */
export interface CalendarData {
  version: number;
  calendars: Calendar[];
  events: CalendarEvent[];
  tasks: CalendarTask[];
  /** The todo board's columns. **Absent until the board's first write** — a read
   *  never creates one, so a calendar-only user's file never grows board state.
   *  Until then the board renders `DEFAULT_COLUMNS` from `lib/todoBoard`. */
  task_columns?: TaskColumn[];
}

/**
 * One materialized instance of an event on the timeline. A non-recurring event
 * yields exactly one; a recurring one yields many, all sharing `eventId`.
 * `occurrenceStart` is the start the *rule* generated — the stable key used for
 * exdates and overrides, which survives the occurrence being moved.
 */
export interface Occurrence {
  eventId: string;
  occurrenceStart: string;
  start: string;
  end: string;
  allDay: boolean;
  title: string;
  location: string;
  notes: string;
  /** The master's join URL, carried onto every occurrence so a list of
   *  occurrences can offer Join without going back to the event. */
  conference: string;
  category: string;
  status: EventStatus | "";
  calendarId: string;
  /** True when it came from a recurring master (so the UI can offer this/all). */
  recurring: boolean;
  alarms: Alarm[];
}

/**
 * Sanitize a box name into a folder segment. Mirrors the backend
 * `commands::projects::sanitize_name` so the frontend can preview the box-folder
 * path consistently.
 */
export function boxFolderName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export function resolveProjectDirectory(project: ProjectEntry | null | undefined): string {
  if (!project) return "";
  if (project.directory) return project.directory;
  const match = /^(.*)[/\\]project\.json$/i.exec(project.local_file);
  return match?.[1] ?? "";
}

/**
 * Format a remote project's location as `user@host:remote_path` (the `user@`
 * prefix is dropped when no user is set). Port is intentionally omitted — this
 * is an at-a-glance display string, and `host:port:path` would be ambiguous.
 */
export function formatRemoteTarget(remote: RemoteSpec): string {
  return `${remote.user ? `${remote.user}@` : ""}${remote.host}:${remote.remote_path}`;
}

/**
 * The paired local working-copy ("mirror") path for a remote project, read from
 * the flattened `extra["mirror"]` field mirrored onto the entry. Returns null
 * when unset (legacy remote projects created before the mirror was persisted).
 */
export function resolveLocalMirror(project: ProjectEntry | null | undefined): string | null {
  const mirror = project?.mirror;
  return typeof mirror === "string" && mirror.trim() ? mirror : null;
}

/** Corner-style override for the whole app (`Settings.ui_corners`). Unset in
 *  settings = the active theme's own radius tokens. */
export type CornerStyle = "square" | "rounded";

export type Theme =
  | "system"
  | "fancy_dark"
  | "soft_dark"
  | "dark"
  | "light"
  | "fancy_light"
  | "light_lavender";

export const THEMES: { value: Theme; labelKey: TranslationKey }[] = [
  { value: "system", labelKey: "theme.name.system" },
  { value: "fancy_dark", labelKey: "theme.name.fancyDark" },
  { value: "soft_dark", labelKey: "theme.name.softDark" },
  { value: "dark", labelKey: "theme.name.dark" },
  { value: "light", labelKey: "theme.name.light" },
  { value: "fancy_light", labelKey: "theme.name.fancyLight" },
  { value: "light_lavender", labelKey: "theme.name.lightLavender" },
];

/** One saved look from the Theme Customizer (`Settings.ui_theme_presets`).
 *
 *  It stores everything the customizer can change, not just the token map: a
 *  palette built on top of Fancy Dark reads as somebody else's on Plain Light,
 *  so the base theme travels with it, and so do the accent (its own setting)
 *  and the corner style (the same window's knob). Loading one writes all four
 *  settings in a single patch. */
export interface ThemePreset {
  /** Stable id; the list is keyed and addressed by it, never by name. */
  id: string;
  name: string;
  /** The base theme the look sat on. Unset = leave the current one alone. */
  theme?: Theme;
  /** Accent override at save time; unset = the base theme's own accent. */
  accent?: string;
  /** Corner style at save time; unset = the base theme's own radii. */
  corners?: CornerStyle;
  /** Cursor pack at save time; unset = the system cursors. */
  cursor?: CursorPack;
  /** The per-token overrides, in `ui_theme_vars`' shape. */
  vars: Record<string, string>;
  /** Epoch ms the preset was written, for the "saved <date>" line. */
  saved?: number;
}
