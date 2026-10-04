use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Read-only host toolchain/config paths restored inside the default-empty home
/// of a fenced local agent.  Secrets such as `.ssh`, `gh`, AWS and gcloud are
/// intentionally absent.
pub const DEFAULT_AGENT_FENCE_PATHS: &[&str] = &[
    "~/.local/bin",
    "~/.local/share/claude",
    "~/.local/share/pnpm",
    "~/.nvm",
    "~/.cargo",
    "~/.rustup",
    "~/anaconda3",
    "~/miniconda3",
    "~/.pyenv",
    "~/.bun",
    "~/go",
    "~/.gitconfig",
    "~/.config/git",
];

/// One entry in `settings["global_apps"]`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GlobalAppEntry {
    pub exec: String,
    pub visible: bool,
    #[serde(flatten)]
    pub extra: HashMap<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AppMobileHostSettings {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub serve_origin: Option<String>,
    /// May a paired phone mark a message read/unread or star it? Default off.
    /// Read by the desktop bridge only; the sidecar never sees mail settings.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mail_actions: Option<bool>,
    /// May a paired phone read mail at all — accounts, folders, message bodies?
    /// Unset is **on**, which is what pairing meant before the switch existed;
    /// `false` turns the whole mail view off. Read by the desktop bridge only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mail_read: Option<bool>,
    /// May a paired phone send a plain-text reply to a message it is reading?
    /// Default off, and independent of `mail_actions`: a flag write and an
    /// outbound mail are different risks and are switched separately.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mail_reply: Option<bool>,
    /// May a paired phone reach the root console's tabs? Default off. Read by
    /// the sidecar per catalog load (`mobile_control::discovery::root_open`,
    /// which also holds the review gate) and repeated by the desktop bridge.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub root_access: Option<bool>,
    /// May a paired phone browse and read (never change) the files of its
    /// Mobile projects? Default off. Read by the sidecar per request
    /// (`mobile_control::files::files_open`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_files: Option<bool>,
    /// Does the Mobile host keep running when Tabtivity quits, so the phone,
    /// scheduled prompts and calendar reminders go on with no window
    /// (`docs/headless_owner_plan.md`)? Default off: a quit stops it. Read by
    /// the quit path (`commands::mobile_control::stop_host_for_exit`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stay_after_quit: Option<bool>,
    /// May a paired phone see and open shell tabs? Default off — Mobile is
    /// agents-only unless this is set. Read by the sidecar per catalog load
    /// (`mobile_control::discovery::shells_open`) and repeated by the desktop
    /// bridge.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shell_tabs: Option<bool>,
    /// May a paired phone list the desktop's Ollama models and load/unload them
    /// (never download or delete)? Unset is **on**; `false` closes the routes.
    /// Read by the sidecar per request
    /// (`mobile_control::local_models::local_models_open`) and repeated by the
    /// desktop bridge.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub local_models: Option<bool>,
}

/// Cloud completion authority lives in Tabtivity's settings, never project.json.
/// Bind consent to a directory as well as the id so moving/repointing a project
/// cannot silently authorize a different tree. Unknown fields round-trip.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct CompletionProjectPolicy {
    pub directory: String,
    #[serde(default)]
    pub copilot: bool,
    #[serde(default)]
    pub local_only: bool,
    #[serde(flatten)]
    pub extra: HashMap<String, Value>,
}

/// `~/.local/share/tabtivity/settings.json`.
///
/// Ollama fields (ollama_host, ollama_model, ollama_autostart) are preserved
/// as optional so existing files round-trip cleanly and the Python app can
/// still roll back. They are not used in Tauri app logic.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Settings {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub debug: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub git_profile_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub git_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color_scheme: Option<String>,
    /// UI language for Tabtivity's interface (`en`/`de`/`es`/`fr`/`it`). Frontend
    /// logic only (`lib/i18n`); the backend just round-trips the value.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    /// App-wide clock: `true` = 24-hour, `false` = 12-hour AM/PM. Frontend logic
    /// only (`src/lib/timeFormat.ts`); the backend just round-trips it.
    ///
    /// **Unset is not `false`** — it means "not chosen", and the frontend then
    /// derives the clock from `language` (English → 12-hour, the other four →
    /// 24-hour). That is why it is an `Option<bool>` rather than a `bool` with a
    /// default: writing `false` on first launch would freeze one hemisphere's
    /// convention onto everyone and make a later language switch unable to
    /// correct it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub time_format_24h: Option<bool>,
    /// Global UI zoom factor for the whole interface (helps on high-DPI/4K
    /// monitors). `1.0` (or unset) is 100% — the current default look. Applied
    /// frontend-side as a CSS `zoom`; the backend only round-trips the value.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ui_zoom: Option<f32>,
    /// Custom accent color (`#rrggbb`) overriding the active theme's `--accent`
    /// across every theme. Unset = the theme's own accent. Frontend logic only
    /// (`stores/settings.applyAccent` — the hover/active/pill tokens all derive
    /// from `--accent`, so one inline var recolors them together); the backend
    /// just round-trips the value.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ui_accent: Option<String>,
    /// Corner style override: `"square"` or `"rounded"`. Unset = the active
    /// theme's own radius tokens (the house square, or soft_dark's rounded).
    /// Frontend logic only (`stores/settings.applyCorners`); the backend just
    /// round-trips the value.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ui_corners: Option<String>,
    /// Calendar: first column of the week — `0` = Sunday, `1` = Monday (default).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub calendar_week_start: Option<u8>,
    /// Calendar: the view a fresh calendar tab opens on
    /// (`day`/`week`/`multiweek`/`month`/`agenda`/`tasks`). Frontend logic only —
    /// the backend just round-trips the value.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub calendar_default_view: Option<String>,
    /// **Retired**, and kept declared only so it can still be read: the
    /// calendar-only 24-hour switch, superseded by the app-wide
    /// `time_format_24h` below. Nothing writes it any more; the frontend reads
    /// it once as a fallback so a user who had set it keeps that clock
    /// everywhere instead of losing it. See `lib/timeFormat.ts`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub calendar_time_format_24h: Option<bool>,
    /// Calendar: first/last hour the day and week grids scroll to.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub calendar_day_start_hour: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub calendar_day_end_hour: Option<u8>,
    /// Calendar: minutes-before reminder pre-filled on a new event. `0` = none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub calendar_default_reminder_minutes: Option<i64>,
    /// Calendar: put a 📅 button in the header that opens the calendar overlay,
    /// badged with the events left today.
    ///
    /// The twin of the header's mail button, with no experimental gate above
    /// it: the calendar is a shipped feature and its store reads one local file,
    /// so there is nothing here to withdraw or to keep off the network.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub calendar_global_app: Option<bool>,
    /// To-do board: put a ☑ button in the header that opens the global todo
    /// board overlay, badged with what is due today.
    ///
    /// A plain setting for `calendar_global_app`'s reasons — the board's cards
    /// *are* `calendar.json`'s tasks, so it reads a shipped local file and
    /// reaches no network; the urgent-mail rail beside it is already gated by
    /// `mail_client`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub todo_board: Option<bool>,
    /// Root console: whether Tabtivity serves its own MCP tools (projects,
    /// calendar, to-do board, the overlays) to root agents at all
    /// (`services::root_mcp`). **Absent means on** — the tools shipped on, so an
    /// existing `settings.json` needs no migration — and a stored `false` is a
    /// deliberate switch-off nothing may normalize back to `None`.
    ///
    /// Off closes both halves: a root agent spawned from then on is handed no
    /// endpoint, and the endpoint refuses the agents that already hold the
    /// token, so the switch takes effect without closing a tab.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub root_mcp: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schedule_mcp: Option<bool>,
    /// Agent-requested pushes (`services::git_push_mcp`, `/mcp/git`). Absent
    /// means off: no local project-agent spawn is wired, and the endpoint
    /// refuses tabs that already hold a token.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub git_push_mcp: Option<bool>,
    /// The read-only help server (`services::help_mcp`) handed to every local
    /// agent tab. **Absent means on**; a stored `false` stops new tabs getting
    /// it and makes `/mcp/help` refuse the tabs that already hold a token.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub help_mcp: Option<bool>,
    /// The markup questions server (`services::markup_mcp`) handed to every
    /// local project-agent tab. **Absent means on**; a stored `false` stops
    /// new tabs getting it and makes `markup_ask` answer `off`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub markup_mcp: Option<bool>,
    /// Root-agent write review: absent/unknown = all, or destructive / off.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub root_mcp_review: Option<String>,
    /// Root console: serve the MCP tools to **local-model tabs only**. Absent
    /// means off (every root agent gets them). On, a cloud agent CLI spawned
    /// from then on is handed no endpoint and the endpoint refuses the ones
    /// already running — what the user's calendar and board hold then never
    /// reaches a hosted model through these tools. Subordinate to `root_mcp`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub root_mcp_local_only: Option<bool>,
    /// Root console: whether the MCP endpoint serves its **mail** tools
    /// (`services::root_mcp_mail`) — drafts to a root agent, reading to a
    /// contained reader. **Absent means off**: mail is switched on separately
    /// from the rest of the tools, never by `root_mcp` alone. Off, no mail tool
    /// is listed, a call to one is refused, and a reader is served nothing;
    /// read per request, so it takes effect without closing a tab.
    /// Subordinate to `root_mcp`, and above every per-account `agent_access`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub root_mcp_mail: Option<bool>,
    /// Root console: keep the **mail** tools to local-model tabs. Absent means
    /// off. On, a cloud agent CLI (Claude, Codex, …) is neither listed nor
    /// served a mail tool, and a contained reader — always a cloud CLI — is
    /// served nothing; a local-model tab keeps its draft tools. The rest of the
    /// tools are untouched: that is `root_mcp_local_only`'s job. Read per
    /// request, like the switches above. Subordinate to `root_mcp_mail`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub root_mcp_mail_local_only: Option<bool>,
    /// Root console: a **local-model tab** may read the mails you shared with
    /// agents (`MailAiPrefs::agent_access` on the account, then a per-message
    /// mark) — marked messages only, whatever the account's scope, and only
    /// while `ollama_host` is loopback. Absent means off: a root tab then
    /// writes drafts and reads nothing. Read per request. Subordinate to
    /// `root_mcp_mail`. Design: `docs/mail_mcp_plan.md` §"Local-model reads".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub root_mcp_mail_local_read: Option<bool>,
    /// Side panel: the opt-in **Alerts** group in the file viewer — urgent
    /// mail, the calendar entries about to start, and the to-do cards whose due
    /// date is here or past, in one time-ordered strip.
    ///
    /// A plain setting for `todo_board`'s reasons (it reads the stores that
    /// already own that data and opens no socket of its own), and **absent means
    /// on** — the group ships shown, so an existing `settings.json` needs no
    /// migration to get it. The key is written only once the user flips it, and
    /// a stored `false` is what a deliberate dismissal looks like; nothing here
    /// may "normalize" that back to `None`, which would silently re-open a group
    /// somebody closed.
    ///
    /// The mail half is gated again by `mail_client`; with it off the group
    /// still shows the calendar and the to-dos.
    ///
    /// The backend only round-trips these three — the feed, the lookahead and
    /// the gating all live in the frontend (`src/lib/alerts.ts`,
    /// `src/components/files/useAlertsFeed.ts`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub files_alerts: Option<bool>,
    /// Alerts group: how many days ahead an event/task may be to still show.
    /// Unset → the frontend's `DEFAULT_LOOKAHEAD_DAYS` (7).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub files_alerts_days: Option<u32>,
    /// Alerts group: per-source opt-outs. Every field is `Option<bool>` and
    /// **absent means on**, so an existing `settings.json` needs no migration to
    /// see a source and the master toggle alone gives the whole picture.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub files_alerts_sources: Option<AlertSources>,
    /// Alerts group: the row ids the user muted (`"{kind}:{sourceId}"`, newest
    /// last, bounded frontend-side by `MAX_MUTED_ALERTS`).
    ///
    /// Round-tripped and never interpreted here — like the three fields above,
    /// what a mute *means* is the frontend's (`src/lib/alerts.ts`). It lives in
    /// settings rather than in the component because the file viewer is mounted
    /// many times over at once and a mute has to hold across all of them, and
    /// across a relaunch.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub files_alerts_muted: Option<Vec<String>>,
    /// Mail: the experimental gate for the embedded mail client
    /// (`src/lib/experimental.ts` — unset falls back to debug mode, so a flag
    /// still moving is invisible to someone *using* Tabtivity and on by default
    /// for someone building it).
    ///
    /// It is the ONE mail switch, and it gates the whole feature: the header's
    /// ✉ button and the overlay behind it, which is the entire client since the
    /// mail *tab* was retired (its store is global, so the tab only ever showed
    /// the same mailbox the overlay does while still belonging to a scope). The
    /// companion `mail_global_app` field went with the tab — while both surfaces
    /// existed it chose whether the header carried one too; with the overlay
    /// alone, a switch that hides it while leaving mail "on" can only produce an
    /// unreachable client. Old `settings.json` files still holding the key are
    /// fine: serde ignores fields this struct no longer declares.
    ///
    /// The `mail_*` commands are deliberately still not refused when it is off —
    /// with no surface there is no caller, and a renderer able to invoke them
    /// could equally flip this setting, so a second gate here would buy nothing
    /// and could only fail independently.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mail_client: Option<bool>,
    /// Mail: which account the mail overlay opens on.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mail_default_account: Option<String>,
    /// Mail: minutes between automatic checks. **Unset or 0 means never**, and
    /// the backend still does not poll — the timer is the frontend's, owned by
    /// the header's mail button (`src/components/header/MailIndicator.tsx`), so
    /// it runs only when the user has turned mail on and picked an interval
    /// here. That default is what keeps the mail store's "nothing
    /// reaches a server without a click" rule true for everyone who has not
    /// explicitly asked otherwise.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mail_check_interval_min: Option<u32>,
    /// Mail: whether to offer remote images at all. **Default false** — loading
    /// them tells the sender the message was opened.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mail_show_remote_images: Option<bool>,
    /// Mail: OS notification on new inbox mail (default on).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mail_notify_new: Option<bool>,
    // ── Local-model mail assistant (Group Q, #203–#208) ─────────────────────
    //
    // The per-feature switches (summarize / autoclassify / formalize / calendar /
    // todo / auto-create) now live **per account** (`schema::mail`'s
    // `MailAiPrefs`), because whether a given mailbox wants summaries, auto-filing
    // and extraction is a per-mailbox decision a single global switch could not
    // express. What stays global here is exactly one thing: a **master switch**.
    /// The global "Allow Mail AI features" master switch. **Default off/absent**,
    /// so nobody inherits a model reading their mail without turning it on. With
    /// it off no Mail AI feature runs anywhere, and the mail toolbar does not even
    /// offer the per-account quick-toggle tags. Read in the backend sync (it gates
    /// per-account `autoclassify`) and everywhere in the UI via `mailAiResolvable`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mail_ai_allow: Option<bool>,
    /// Where the Ollama server is, when it is not the default
    /// `127.0.0.1:11434` — a different port (a container publishing 11435, a
    /// second server) or, with [`Self::ollama_allow_remote_host`] set, another
    /// machine. Accepts `host:port`, a bare `host`, a bare `:port`, and an
    /// `http://` prefix; **`https://` is refused**, because the transport in
    /// `commands::ollama` is plaintext HTTP/1.0 over a raw `TcpStream` and
    /// quietly downgrading a URL the user wrote as TLS would send their prompts
    /// in the clear. Unset means the default, which is what it has always meant.
    ///
    /// It was declared here for years and read by **nothing**, so anyone who
    /// set it had a field that did nothing (group S #201a).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ollama_host: Option<String>,
    /// Permit [`Self::ollama_host`] to name a machine that is not this one.
    /// **Default false**, and it is a second key rather than an implication of
    /// the first because the two are different decisions: a non-default *port*
    /// is still local inference, while a non-loopback *host* means every prompt,
    /// every file an agent reads and every completion leaves this machine —
    /// which is the opposite of what the local-model feature is for. That is a
    /// thing to state, not a side effect of a hostname. The check is on the
    /// literal the user typed (never on what it resolves to), so it says what
    /// they wrote rather than what DNS answered today.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ollama_allow_remote_host: Option<bool>,
    /// Where Ollama saves the models it downloads — its `OLLAMA_MODELS`
    /// directory. `None`/empty means Ollama's own default (`~/.ollama/models`,
    /// or the system-service dir when one holds models).
    ///
    /// It reaches only a server **Tabtivity starts itself** (`ensure_ollama_running`
    /// passes it as `OLLAMA_MODELS`): an already-running or systemd-managed
    /// server keeps whatever location it was launched with, which is why the
    /// Settings panel offers a one-click systemd drop-in
    /// (`ollama_models_dir_plan`) to point *that* server at the same folder. The
    /// path is also folded into the partial-blob scan (`ollama_blob_dirs`) so a
    /// resumable download in the custom dir is still found.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ollama_models_path: Option<String>,
    /// Preserved for Python rollback; not used by the Tauri app.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ollama_model: Option<String>,
    /// Per-task local-model assignments set from the 🧠 menu's role chips. Maps a
    /// task key (`"autocomplete"`, `"autocomplete_prose"`, `"tabs"`,
    /// `"mail"`) to the model name that serves it (`autocomplete_prose` is plain
    /// text/Markdown/TeX, falling back to `autocomplete`), so several loaded models can run different jobs in
    /// parallel. Optional + flat so older settings files round-trip cleanly; a
    /// task absent here falls back to `ollama_model`. Frontend logic only —
    /// persisted here. An open map rather than a struct of known keys, which is
    /// what lets `"mail"` be stored before the mail task that will read it exists:
    /// adding a role is a frontend edit, and this file keeps round-tripping one it
    /// has never heard of.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ollama_roles: Option<HashMap<String, String>>,
    /// Missing/unknown provider retains Ollama. Prose always retains its role.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code_completion_provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub copilot_completion: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completion_project_policies: Option<HashMap<String, CompletionProjectPolicy>>,
    /// Hunspell dictionary code (e.g. `en_US`) for the editors' dictionary
    /// spell check (`services::spell`). Unset means the default — an installed
    /// English variant when there is one, else the first dictionary found.
    /// One machine-wide choice (the language you write in is not per project);
    /// per-type enablement lives in `ViewerPref::spell_check`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spell_language: Option<String>,
    /// Preserved for Python rollback; not used by the Tauri app.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ollama_autostart: Option<bool>,
    /// The agent Tabtivity picks on its own when a feature needs exactly one and
    /// the user hasn't chosen per-instance — an `AgentInfo.id`/`AGENT_ITEMS`
    /// `cmd` such as `"claude"` or `"codex"`. Set from the 🧠 menu's Agents
    /// section (each installed agent's "Default" chip); every reader falls
    /// back to `"claude"` when unset.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_agent_cmd: Option<String>,
    /// The desktop PDF viewer's Mark up prompts (`docs/pdf_markup_rounds_plan.md`
    /// §2.8), the desktop's own as the phone keeps its own: what a Submit tells
    /// the agent after the file references (`None`/blank = `markup::
    /// DEFAULT_INSTRUCTION`), and what **Make these changes** sends once the
    /// agent has listed them (`None`/blank = the viewer's default). Free text
    /// the user typed; the viewer passes the first to `pdf_markup_submit`,
    /// which bounds it like the phone's.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pdf_markup_instruction: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pdf_markup_apply: Option<String>,
    /// Built-in agent registry ids shown before a search in the compact Agents
    /// group of the + tab menu. Chosen through the 🧠 menu's "+ tab" chips.
    /// Unset is interpreted by the frontend as Claude/Codex/Gemini; an empty
    /// list intentionally leaves every agent behind the menu's search field.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compact_tab_agents: Option<Vec<String>>,
    /// Built-in agent registry ids offered in the root console's + menus, set
    /// by the 🧠 menu's "Root" chips. Opt-in: unset or empty offers none there,
    /// since a root agent gets the root MCP tools no project agent has.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub root_agents: Option<Vec<String>>,
    /// Agent CLI binaries given the root MCP tools in the root console, set by
    /// the 🧠 menu's "MCP" chips (Root = may run there, MCP = runs there *with*
    /// the tools). Unset falls back to `root_agents`: before the chip was a
    /// switch, every root agent got the tools. Read at spawn by
    /// `services::root_mcp`, which sees only the binary.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub root_mcp_agents: Option<Vec<String>>,
    /// Local model names switched off for the root console by the 🧠 menu's
    /// "Root" chips. Opt-out: unset means every local model is offered there.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub root_excluded_models: Option<Vec<String>>,
    /// Local model names given the root MCP tools by the 🧠 menu's "MCP" chips.
    /// Opt-in: a local-model (Mistral Vibe) tab otherwise runs with tools off
    /// (`enabled_tools = ["__no_tools__"]`), which is what keeps a
    /// completion-only model working. Read at spawn by `services::root_mcp`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ollama_mcp_models: Option<Vec<String>>,
    /// When true (the default), running a `.sh` from the side panel spawns it
    /// as a detached background process instead of opening a terminal tab.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_scripts_in_background: Option<bool>,
    /// Show the untested pills throughout the desktop UI. Defaults to off.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub show_untested_tags: Option<bool>,
    /// When true (the default), `claude` agent tabs are spawned with
    /// `--remote-control` so the session can be monitored/steered from the Claude
    /// app/web. Only Claude supports the flag; other agents ignore it. Default ON.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_remote_control: Option<bool>,
    /// Kept for round-trip only: the fence used to be switchable here and per
    /// project. It is the only mode now (`services::agent_fence`), so the
    /// value is never read.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_fence: Option<bool>,
    /// Extra host paths exposed read-only inside the agent fence.  Unset uses
    /// [`DEFAULT_AGENT_FENCE_PATHS`]; an explicit empty list exposes none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_fence_paths: Option<Vec<String>>,
    /// Permit reading Cargo registry credential files through exposed toolchain
    /// paths. Default false; independent of agent login and resume credentials.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_fence_cargo_credentials: Option<bool>,
    /// The user has accepted, once, that agents on a platform with no fence
    /// (Windows) run with their full rights. Until written, `pty_spawn` refuses
    /// every local agent there and the frontend asks; the answer outlives the
    /// session because it is a policy about the machine, not one act.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_fence_platform_accepted: Option<bool>,
    /// Let a fenced **root** agent read every project (local directories, box
    /// folders, remote mirrors) read-only. Default off: one poisoned project can
    /// then reach the others through an agent with open network access.
    /// Project scopes are untouched (`agent_fence::root_project_read_only_paths`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub root_fence_projects_readable: Option<bool>,
    /// Prefix chips offered by the side panel's per-tab agent composer, keyed by
    /// agent command (`claude`, `codex`, …). Each entry is one of that CLI's own
    /// slash commands, submitted ahead of the prompt. Unset falls back to the
    /// frontend's per-agent defaults; an explicit empty list means "no chips for
    /// this agent", which is why it is a map of lists rather than one flat list.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_preface_commands: Option<HashMap<String, Vec<String>>>,
    /// Model names offered by that same composer, keyed by agent command. The
    /// pick is typed as the agent's own `/model <name>` — Tabtivity never passes a
    /// model flag at launch. Editable because model names change far faster than
    /// this app ships.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_models: Option<HashMap<String, Vec<String>>>,
    /// When true (the default), the usage recap opens by itself on the first
    /// launch of each day. Turning it off leaves the recap reachable from
    /// Settings — it stops the popup, it does not stop the counting.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub daily_stats_recap: Option<bool>,
    /// UTC date ("YYYY-MM-DD") the recap was last auto-shown, so it opens once a
    /// day rather than on every window. Written by the recap host itself.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub daily_stats_last_shown: Option<String>,
    /// EXPERIMENTAL, default OFF. When true, a Python file in the native code
    /// viewer gets the Run/Debug buttons and the breakpoint gutter (#87). Purely a
    /// frontend gate, and off by default because Run *executes the file*: the
    /// button is one click from an editor, so it is opt-in rather than something a
    /// user discovers by mis-clicking. Go-to-definition is not gated — it reads,
    /// it never runs anything. Nothing in the backend reads this: Run/Debug open an
    /// ordinary terminal tab, which reaches `pty_spawn` like any other.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub python_run_debug: Option<bool>,
    /// EXPERIMENTAL, default OFF. The native presenter ("deck",
    /// `docs/deck_presenter_plan.md`): editable object layers over a base PDF, kept in
    /// a `*.eldeck.json` sidecar, plus the animate mode and the fullscreen presenter.
    /// Purely a frontend gate — a deck is an ordinary text file the existing fs
    /// commands read and write, and its PDF export is built in the webview by pdf-lib,
    /// so nothing in the backend reads this.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deck_presenter: Option<bool>,
    /// EXPERIMENTAL, default OFF. Paint terminals with xterm's WebGL renderer
    /// (GPU glyph atlas) instead of the canvas renderer. Opt-in because it rides
    /// the same GPU/driver path the DMABUF re-test failed on for this class of
    /// machine (flicker, missing content, renderer crash —
    /// `docs/typing_latency_plan.md` Step 4); the frontend demotes a failing
    /// terminal back to canvas on its own. Purely a frontend gate — nothing in
    /// the backend reads it, the renderer is an xterm.js concern.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal_webgl: Option<bool>,
    /// EXPERIMENTAL, default OFF. The markdown relationship graph: a "Graph"
    /// mode on the markdown viewer that crawls the viewed document's local-file
    /// links and renders them as a clickable navigation map. Purely a frontend
    /// gate — the crawl reads files through the same confined `read_file_text`
    /// every viewer read goes through, so nothing in the backend reads this.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub md_graph: Option<bool>,
    /// EXPERIMENTAL, default OFF. Project-wide per-file remarks in REMARKS.md.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_remarks: Option<bool>,
    /// EXPERIMENTAL, default OFF. The in-app browser (TODO J #61,
    /// `docs/browser_plan_{a,b,c}.md`): a JS-free reader tab plus a separate
    /// hardened live-page window. Read via `web_browser()`, which applies the
    /// same unset-means-debug rule every other experimental flag follows.
    ///
    /// It is declared here rather than left to ride in `extra` for the reason
    /// every other flag is: a field that only exists in the catch-all cannot be
    /// read by `Settings::experimental()`, so the backend could never gate on it
    /// even if it wanted to, and a typo in the key would round-trip silently
    /// instead of failing to compile.
    ///
    /// **What the gate does.** Like `mail_client` — and unlike `deck_presenter`,
    /// which only hides buttons on a viewer that keeps working — it withdraws the
    /// whole feature: the two add-tab menu entries, any open browser tab, any live
    /// page window, and any persisted browser tab that would otherwise be restored
    /// (`src/lib/experimentalSweep.ts`). Off means gone; a browser left running
    /// after the switch was thrown would make the switch a lie, and the tab loses
    /// nothing by closing (its one persisted field is the URL).
    ///
    /// The `browser_*` commands are still deliberately NOT refused when it is
    /// off, the same posture the mail commands take: with no tab and no live
    /// window there is no caller, and a renderer able to invoke them could
    /// equally flip this setting, so a second gate could only fail on its own.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub web_browser: Option<bool>,
    /// Browser: where a fresh browser tab opens. Empty/unset is the built-in
    /// start page, **not** a remote request — a home page that fires on every
    /// new tab is an outbound request nobody asked for. Frontend logic only; the
    /// backend round-trips it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub browser_home_url: Option<String>,
    /// Browser: what the address bar does with text that is not a web address —
    /// `%s` is replaced by the percent-encoded input. Clearable, in which case
    /// such text is refused rather than sent to a third party.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub browser_search_template: Option<String>,
    /// Browser: where a clicked link opens (`external` / `in_app` / `ask`,
    /// TODO J #33). Default `external` — the user's real browser holds their
    /// sign-ins, their extensions and their password manager.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub browser_link_target: Option<String>,
    /// Browser: a restored tab loads its page at launch instead of showing the
    /// resume card. **Default false** — restoring N tabs would otherwise be N
    /// automatic outbound requests before the user has looked at the screen.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub browser_restore_navigate: Option<bool>,
    /// Browser: whether the hardened **live-page window** may be opened at all.
    ///
    /// **Default false, and deliberately not an `experimental()` flag** — unlike
    /// every other opt-in here, unset must mean *off in a debug build too*. That
    /// is the whole point: a debug build is what the author runs all day, and
    /// this is the one browser surface whose central security claim does not
    /// hold.
    ///
    /// Reader mode carries no such switch because it needs none: it runs no
    /// JavaScript, owns no webview, and its bytes are sanitized in Rust before
    /// the frontend sees them. A live page is the opposite on every count, and
    /// two of its holes cannot be closed from app code at all — a page can reach
    /// a loopback service by way of any hostname that resolves there (wildcard
    /// DNS resolvers make this free), and `ws://` reaches one regardless because
    /// a WebSocket is not a navigation and has no CORS. Both are disclosed in
    /// `services::browser_engine`'s module header. On a developer's machine the
    /// things listening on loopback are model servers, notebooks, dev servers
    /// and dashboards, which is why this is a separate, explicit switch rather
    /// than a line item inside `web_browser`.
    ///
    /// Read via `browser_live_pages()`; `commands::browser::browser_open_live`
    /// refuses without it, and `browser_capabilities` reports it so the frontend
    /// hides the control rather than offering one that errors.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub browser_live_pages: Option<bool>,
    /// Persistent LOCAL (tmux) sessions (TODO #85): when true (the default on Unix),
    /// a local project's shell/script tabs run inside a tmux session on the machine,
    /// so a long run survives a Tabtivity crash and the tab reattaches on restart.
    /// `None`/`Some(true)` = on; `Some(false)` = off. No effect on Windows (no tmux):
    /// `services::tmux_local` no-ops there. Read via `persist_local_sessions()`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub persist_local_sessions: Option<bool>,
    /// When true (the default), remote SSH/OpenVPN connections are made headlessly
    /// in the background, with Tabtivity handling the password transiently (sshpass /
    /// askpass). When false, those connections are launched as interactive
    /// terminal tabs in the Tabtivity **root** scope so the password is typed directly
    /// into the live terminal and Tabtivity never handles it at all. Default ON
    /// (headless) so existing behaviour is preserved.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connections_headless: Option<bool>,
    /// Whether the local mail store is encrypted at rest
    /// (`docs/mail_encryption_plan.md`).
    ///
    /// **Three states, and the third is the point.** `Some(true)` = on,
    /// `Some(false)` = the user was asked and said no, `None` = never asked. A
    /// plain bool would collapse the last two, and they call for opposite
    /// behaviour: a store that has never been asked about gets encryption turned
    /// on silently *if it is empty* (a new install has nothing to migrate, so
    /// the cost is nil), and gets a one-time prompt if it already holds mail (a
    /// migration rewrites the whole database and is the user's call). Once
    /// answered, neither is asked again.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mail_encrypt_store: Option<bool>,
    /// Hosts marked **careful**: "this machine is shared and policed, so keep
    /// Tabtivity's background load off it." An HPC login node is the case it exists
    /// for — CPU there is watched, its `$HOME` usually sits on a parallel
    /// filesystem whose metadata server a recursive `du` hammers, and its account
    /// database is a shared directory service.
    ///
    /// Keyed by canonical SSH target ([`crate::services::ssh_common::target_key`],
    /// i.e. `user@host:port`) rather than by any host id, because **one physical
    /// login node is simultaneously several records**: a project's primary
    /// `remote`, a `compute_hosts` worker on another project, and a project-free
    /// global machine — three tables, three ids, one machine. A per-record `bool`
    /// would be three values free to disagree about the same host; the SSH target
    /// is the identity `lib/remote/machineSync`'s `sameTarget` already treats as the
    /// bridge between them, so it is the identity used here too.
    ///
    /// The stored value is the user's **explicit** answer. A target *absent* from
    /// the map has not been answered and is treated as **careful** — the default
    /// for every remote machine, since Tabtivity cannot tell whose machine a host is
    /// and the two wrong guesses do not cost the same. Which is why this is a map
    /// to `bool` and not a set of careful hosts: an explicit `false` ("this one is
    /// mine") has to be distinguishable from an unanswered host, or the careful
    /// default would keep turning itself back on.
    ///
    /// Deliberately **not** named for HPC. A departmental shared box wants the
    /// same treatment, and a compute node held through SLURM — HPC by any
    /// definition — does not: you own it outright for the length of the job, and
    /// there monitoring is useful rather than rude.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub careful_hosts: Option<HashMap<String, bool>>,
    /// The machines the user has tagged **HPC** — a shared cluster login node,
    /// ticked on the login form and shown on the machine's row in the Machines
    /// menu (`src/lib/remote/hpc/hpcHost.ts`). Same SSH-target key as [`Self::careful_hosts`],
    /// for the same reason.
    ///
    /// Where `careful_hosts` says how much Tabtivity may *look at*, this says what
    /// Tabtivity may *do*, and it is a strictly stronger statement: a tagged host is
    /// careful whatever `careful_hosts` says (the monitor's Detailed switch cannot
    /// override it), and four further behaviours turn off — the disk-usage scan
    /// and giant-folder census (a recursive `du` over a parallel filesystem's
    /// metadata server), the auto byte-sync and git-lockstep poll loops, silent
    /// auto-connect at launch, and unannounced compute in a login-node shell.
    /// Each of those is something a site's usage rules name, and none of them can
    /// be inferred from the host — `sbatch` on `PATH` says a machine *has* a
    /// scheduler, not that its operators mind. Only the user knows that, so only
    /// the user sets this.
    ///
    /// A set, not a map: unlike careful mode there is no default to distinguish an
    /// answer from, so an absent target simply isn't tagged. Stored as a map to
    /// `bool` anyway so an untagging writes `false` rather than having to delete a
    /// key from a settings blob the frontend saves whole.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hpc_hosts: Option<HashMap<String, bool>>,
    /// Path of the stored `.ovpn` config Tabtivity brings up **on launch**, with no
    /// project behind it. Unset (the default) = no tunnel is started by itself.
    ///
    /// One config, not a list: a tunnel reroutes the whole machine, so arming two
    /// would be arming them to fight over the routing. The frontend re-checks at
    /// launch that the connect can still be made without a prompt and stays down if
    /// it can't (see `lib/remote/vpn/vpnAutoConnect.ts`); the backend only round-trips this.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vpn_auto_connect: Option<String>,
    /// The `.ovpn` configs the user asked Tabtivity to **remember the credentials of**
    /// (the VPN menu's "Save login credentials"). No secret lives here — the secrets
    /// are in the OS keychain; this is only the *intent*, and it exists because the
    /// keychain cannot always be asked.
    ///
    /// A locked Secret Service collection answers every read like an empty one, so
    /// "is a credential saved for this config?" is unanswerable exactly when it
    /// matters most: at launch, before anything has unlocked the keyring. Without
    /// this list the toggle would show *off* over a saved credential and a connect
    /// would drop to the password prompt rather than offering to unlock. Reconciled
    /// against the keychain whenever it *is* readable, so it cannot drift for long.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vpn_saved_configs: Option<Vec<String>>,
    /// Energy-saver mode: "off" | "battery" (default) | "always". When active
    /// (mode "always", or "battery" while discharging) Tabtivity pauses the blob
    /// auto-spin, collapses idle animations, and widens always-on UI timers.
    /// Read entirely on the frontend; kept here only so it round-trips.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub energy_saver: Option<String>,
    /// Fast mode: drop the display aids that cost a walk, a poll or a file read,
    /// so the interface answers faster on a slow disk, a busy machine or a
    /// high-latency remote. **Defaults off** — only an explicit `true` engages it.
    ///
    /// Deliberately a separate switch from `energy_saver`, not a fourth value of
    /// it. Energy saver *widens timers* and pauses animation on a battery
    /// reading; this *removes features* on a standing preference, and the two
    /// compose (fast mode is the stronger of the two wherever both apply). One
    /// merged control could not express "plugged in, still want it lean", which
    /// is the case that asks for this.
    ///
    /// Read entirely on the frontend (`src/lib/agents/fastMode.ts`, which names the
    /// exact list); kept here only so it round-trips.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fast_mode: Option<bool>,
    /// Header resource-monitor row toggles. Each defaults ON when unset so the
    /// pill shows CPU/RAM/GPU by default; flip one off to hide that row. Shown in
    /// every build (independent of `debug`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub show_cpu_usage: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub show_ram_usage: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub show_gpu_usage: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub global_apps: Option<HashMap<String, GlobalAppEntry>>,
    /// User-chosen program per IDE id (`services::ide_detect::IdeId::id`),
    /// consulted before any auto-detection by "Open in <IDE>". Absent or
    /// blank entries mean "detect".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ide_launchers: Option<HashMap<String, String>>,
    /// Minimum subwindow (split pane) width in px a divider drag may shrink a
    /// pane to. Unset falls back to the frontend's DEFAULT_MIN_SUBWINDOW_PX.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_subwindow_width: Option<u32>,
    /// Minimum subwindow (split pane) height in px a divider drag may shrink a
    /// pane to. Unset falls back to the frontend's DEFAULT_MIN_SUBWINDOW_PX.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_subwindow_height: Option<u32>,
    /// When true, the in-app text/TeX/markdown viewers debounce-save edits to
    /// disk automatically (#47). Defaults OFF; the #43 diff-aware reload is its
    /// counterpart for external changes.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub autosave: Option<bool>,
    /// When true (the default), the in-app text/TeX editors tint recently typed
    /// runs with a sequential new→old colour trail that fades as typing
    /// continues. Defaults ON; only an explicit `false` disables it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub change_tint: Option<bool>,
    /// Per-file-type native-viewer preferences (#48), keyed by a type id derived
    /// from `fileUtils` (e.g. "tex", "text", "markdown"). Holds the opt-in
    /// autocomplete toggle (#45). Optional + flat so older settings files
    /// round-trip cleanly.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub viewer_prefs: Option<HashMap<String, ViewerPref>>,
    /// User overrides for the rebindable navigation chords (Group L / #62),
    /// keyed by action id (e.g. "cycleTabs", "closeTab"). Optional + defaulted
    /// so existing settings.json files without it still load; unset actions
    /// fall back to the built-in defaults in the frontend.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub keyboard_shortcuts: Option<HashMap<String, ChordDescriptor>>,
    /// User overrides for the keys INSIDE keyboard steering mode, keyed by
    /// steering action id (e.g. "up", "newShell"): the action's whole key list
    /// (`KeyboardEvent.key` values, at most two), replacing its defaults; an
    /// empty list unbinds it. Unset actions keep the frontend's defaults
    /// (`src/lib/shortcuts/steeringBindings.ts`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub steering_keys: Option<HashMap<String, Vec<String>>>,
    /// Download *source* folders scanned by the side-panel Downloads section
    /// (fast-copy of freshly downloaded files into a project). A machine-wide
    /// list, read-only — Tabtivity never changes any browser's download path.
    /// Unset/empty → the frontend falls back to the user's `~/Downloads`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub download_sources: Option<Vec<String>>,
    /// Where the MAIN window was when Tabtivity last ran, so it reopens on the same
    /// monitor in the same place. Unset (fresh install, or a saved rect no live
    /// monitor can host) → the window opens as `tauri.conf.json` configures it:
    /// maximized, wherever the WM puts it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub window_state: Option<WindowState>,
    /// Private, tailnet-published companion host. Absent means fully disabled.
    // brand-check: allow — a serde key must be a literal; a test pins it to brand::MOBILE_HOST_KEY
    #[serde(default, rename = "tabtivity_mobile_host", skip_serializing_if = "Option::is_none")]
    pub app_mobile_host: Option<AppMobileHostSettings>,
    /// Whether the Tabtivity Mobile host-status control is visible in the desktop
    /// header. Unset means visible whenever the Mobile host is enabled.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mobile_indicator: Option<bool>,
    /// Whether the header's machine-state cluster (connection, battery, Mobile,
    /// OpenVPN, Machines, CPU/RAM/GPU) is expanded into the bar. Unset means
    /// collapsed to one lamp; a member with something wrong to say still shows
    /// itself either way (see `stores/headerStatus`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub header_status_expanded: Option<bool>,
    /// Default printer per network, keyed by the network key the frontend
    /// derives (`wlan:<ssid>`, `lan:<hashed gateway mac>`, `lan`). When the machine
    /// joins a keyed network, the print manager's host makes that printer the
    /// user's default. Unset/empty → nothing is ever switched.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub printer_network_defaults: Option<HashMap<String, PrinterNetworkDefault>>,
    /// The file's revision, moved by every write (headless owner plan, H1).
    /// A whole-document save must carry the revision it loaded, and is
    /// refused when the file moved on since — a second window or the Mobile
    /// sidecar saving in between is never erased. `0` for a file no
    /// revision-aware build has written yet; not serialized then, so an
    /// untouched file keeps its bytes.
    #[serde(default, skip_serializing_if = "rev_is_zero")]
    pub rev: u64,
    #[serde(flatten)]
    pub extra: HashMap<String, Value>,
}

fn rev_is_zero(rev: &u64) -> bool {
    *rev == 0
}

/// Last-known geometry of the MAIN window, in PHYSICAL desktop pixels — the
/// canonical cross-window coordinate space (see `src/lib/window/coords.ts`). Tauri's
/// `outerPosition`/`outerSize`/`set_position`/`set_size` are all physical; only a
/// *builder*'s `.position()`/`.inner_size()` are logical, which is the trap
/// `commands::subwindow::detached_position` exists to document.
///
/// `x`/`y`/`w`/`h` is the *restore* (non-maximized) rect: it is refreshed only
/// while the window is floating. Storing the maximized rect here instead would
/// recreate the bug `WindowControls.tsx` works around — a window whose only known
/// "normal" size is the whole monitor, so un-maximizing appears to do nothing and
/// KWin's edge-snap stays suppressed.
///
/// There is deliberately no `fullscreen` field. Linux must never enter fullscreen
/// (a `_NET_WM_STATE_FULLSCREEN` window is unmovable under KWin — see the note in
/// `lib.rs`'s setup), and macOS is unconditionally fullscreen. Persisting the flag
/// could only ever strand the window.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct WindowState {
    pub x: i32,
    pub y: i32,
    pub w: u32,
    pub h: u32,
    #[serde(default)]
    pub maximized: bool,
}

/// One entry in `settings["keyboard_shortcuts"]` (Group L / #62). A serializable
/// key chord mirroring the frontend `ChordDescriptor`. The modifier flags default
/// to false when absent so the JSON stays compact.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ChordDescriptor {
    pub key: String,
    #[serde(default, skip_serializing_if = "is_false")]
    pub ctrl: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub shift: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub alt: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub meta: bool,
}

#[allow(clippy::trivially_copy_pass_by_ref)]
fn is_false(b: &bool) -> bool {
    !*b
}

/// One entry in `settings["printer_network_defaults"]`.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PrinterNetworkDefault {
    #[serde(default)]
    pub printer: String,
    /// The network's name as it was shown when the default was saved (an SSID,
    /// a gateway address), so the list stays readable while off that network.
    #[serde(default)]
    pub label: String,
    #[serde(flatten)]
    pub extra: HashMap<String, Value>,
}

/// One per-type entry in `settings["viewer_prefs"]` (#48).
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ViewerPref {
    /// Whether this native viewer is used at all. Absent/true renders the type
    /// in-app; false opts it out so its files open in the external default app.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    /// Whether Ctrl+Space local autocomplete is enabled for this type (#45).
    /// Defaults OFF (privacy: no model call unless explicitly turned on).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub autocomplete: Option<bool>,
    /// Default completion-length mode for this type (#45 modes): `"sentence"`
    /// (default), `"block"`, or `"scope"`. Cycled live in-editor with Shift+Tab
    /// while a suggestion is showing; this is just the starting mode. Absent →
    /// `"sentence"`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub autocomplete_mode: Option<String>,
    /// Whether the dictionary (Hunspell) spell check is enabled for this type.
    /// Defaults OFF like its siblings — not for privacy (it calls no model),
    /// but because red underlines nobody asked for are noise in a code editor.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spell_check: Option<bool>,
    /// Whether the TeX editor typesets the snippet under the pointer and shows
    /// it in a hover card (#tex-hover-preview). Only the `"tex"` entry reads it.
    /// Absent means ON — unlike `autocomplete` above, which is
    /// opt-in because it calls a model; this runs the local TeX engine the
    /// viewer is already built around, on a fragment, only after the pointer has
    /// rested. Set `false` to stop hovering from compiling anything.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hover_preview: Option<bool>,
    /// Editor font size in px for this type's in-app code editor. Adjusted from
    /// the viewer's A−/A+ controls (or Ctrl +/−/0). Unset falls back to the
    /// frontend default (12px).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub font_size: Option<f32>,
}

/// `settings["files_alerts_sources"]` — the Alerts group's per-source opt-outs.
///
/// Every field is `Option<bool>` and **absent means on**, which is the whole
/// shape: the master switch (`files_alerts`) is the opt-in, and these only ever
/// take a source *away* once the user has one they do not want. A `bool` with
/// `#[serde(default)]` would default to `false` and hand a freshly-enabled group
/// three switched-off sources, i.e. an empty strip that looks broken.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AlertSources {
    /// Priority-marked mail. Gated *again* by `mail_client` in the frontend, so
    /// leaving this on costs nothing while the mail client is off.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mail: Option<bool>,
    /// Calendar occurrences inside the lookahead window.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub events: Option<bool>,
    /// To-do cards by due date (overdue included).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tasks: Option<bool>,
}

impl Settings {
    pub fn color_scheme(&self) -> &str {
        self.color_scheme.as_deref().unwrap_or("light_lavender")
    }

    /// Whether Claude agent tabs should be spawned with `--remote-control`.
    /// Defaults ON when unset so existing settings files opt in automatically.
    pub fn agent_remote_control(&self) -> bool {
        self.agent_remote_control.unwrap_or(true)
    }

    /// Whether local agent tabs should receive the filesystem fence.  Default
    /// Whether unfenced agents on a fence-less platform were accepted. Off
    /// unless written: silence must never count as consent to full rights.
    pub fn agent_fence_platform_accepted(&self) -> bool {
        self.agent_fence_platform_accepted.unwrap_or(false)
    }

    /// Whether the root fence exposes every project read-only. Off unless
    /// written: it is a widening, and the mail `attach` argument depends on it.
    pub fn root_fence_projects_readable(&self) -> bool {
        self.root_fence_projects_readable.unwrap_or(false)
    }

    /// The configured read-only toolchain/config allowlist, or the documented
    /// defaults when the key has never been written.
    pub fn agent_fence_paths(&self) -> Vec<String> {
        self.agent_fence_paths.clone().unwrap_or_else(|| {
            DEFAULT_AGENT_FENCE_PATHS
                .iter()
                .map(|path| (*path).to_string())
                .collect()
        })
    }

    /// Whether the usage recap auto-opens once a day. Defaults ON when unset, so
    /// an existing install gets the recap without having to find the toggle.
    pub fn daily_stats_recap(&self) -> bool {
        self.daily_stats_recap.unwrap_or(true)
    }

    /// The rule every experimental flag follows (mirrors `src/lib/experimental.ts`):
    /// unset means **debug mode decides**, so someone building Tabtivity gets each new
    /// experiment without re-ticking a list, and everyone else gets none of them. An
    /// explicit value always wins, in both directions — otherwise "turn this off"
    /// would silently fail for exactly the people most likely to hit a broken one.
    fn experimental(&self, flag: Option<bool>) -> bool {
        flag.unwrap_or_else(|| self.debug.unwrap_or(false))
    }

    /// Whether the experimental Python Run/Debug buttons and breakpoint gutter are
    /// offered in the code viewer. Run *executes the file*, so outside debug mode it
    /// is opt-in.
    pub fn python_run_debug(&self) -> bool {
        self.experimental(self.python_run_debug)
    }

    /// Whether the experimental mail client is on — the one gate its overlay
    /// host asks (`src/components/mail/MailOverlay.tsx`).
    pub fn mail_client(&self) -> bool {
        self.experimental(self.mail_client)
    }

    /// Whether the root console's MCP tools are served. On unless switched off.
    pub fn root_mcp(&self) -> bool {
        self.root_mcp.unwrap_or(true)
    }

    /// Whether the help MCP is handed to agent tabs. On unless switched off.
    pub fn help_mcp(&self) -> bool {
        self.help_mcp.unwrap_or(true)
    }

    /// Whether the markup questions MCP is handed to agent tabs. On unless
    /// switched off.
    pub fn markup_mcp(&self) -> bool {
        self.markup_mcp.unwrap_or(true)
    }

    /// The agent CLIs [`Self::root_mcp_agents`] names, with its `root_agents`
    /// fallback applied.
    pub fn root_mcp_agent_list(&self) -> Vec<String> {
        self.root_mcp_agents
            .clone()
            .or_else(|| self.root_agents.clone())
            .unwrap_or_default()
    }

    /// Whether the root MCP endpoint serves its mail tools. Off unless set.
    pub fn root_mcp_mail(&self) -> bool {
        self.root_mcp_mail.unwrap_or(false)
    }

    /// Whether the root MCP mail tools are kept to local-model tabs. Off unless set.
    pub fn root_mcp_mail_local_only(&self) -> bool {
        self.root_mcp_mail_local_only.unwrap_or(false)
    }

    /// Whether a local-model tab may read the marked mails. Off unless set.
    pub fn root_mcp_mail_local_read(&self) -> bool {
        self.root_mcp_mail_local_read.unwrap_or(false)
    }

    /// Whether the root MCP tools are kept to local-model tabs. Off unless set.
    pub fn root_mcp_local_only(&self) -> bool {
        self.root_mcp_local_only.unwrap_or(false)
    }

    /// Whether the experimental native presenter ("deck") is offered — the
    /// `*.eldeck.json` viewer and its fullscreen presenter. Off outside debug mode
    /// while the surface is still moving.
    pub fn deck_presenter(&self) -> bool {
        self.experimental(self.deck_presenter)
    }

    /// Whether the experimental in-app browser is offered (TODO J #61). Off
    /// outside debug mode while the surface is still moving. It gates the add-tab
    /// entry points only — see the field's doc for why the commands themselves
    /// stay reachable.
    pub fn web_browser(&self) -> bool {
        self.experimental(self.web_browser)
    }

    /// Whether the browser's hardened live-page window may be opened.
    ///
    /// `unwrap_or(false)`, **not** `experimental()`: unset means off everywhere,
    /// including a debug build. See the field's doc for why this one surface is
    /// held to a stricter default than the flag that enables the browser itself.
    pub fn browser_live_pages(&self) -> bool {
        self.browser_live_pages.unwrap_or(false)
    }

    /// Whether LOCAL shell/script tabs are wrapped in a persistent tmux session
    /// (TODO #85). Default ON when unset; only an explicit `Some(false)` opts out.
    /// The caller still gates on `tmux_local::tmux_available()` (no tmux / Windows →
    /// no wrap regardless), so this is a preference, not a guarantee.
    pub fn persist_local_sessions(&self) -> bool {
        self.persist_local_sessions.unwrap_or(true)
    }

    /// Whether remote SSH/OpenVPN connections are made headlessly (Tabtivity handles
    /// the password) rather than as interactive root-terminal tabs. Defaults ON
    /// (headless) when unset so existing behaviour is preserved.
    pub fn connections_headless(&self) -> bool {
        self.connections_headless.unwrap_or(true)
    }
}

#[cfg(test)]
mod tests {
    /// The serde key is a literal in the attribute; this ties it to the brand
    /// module so the two cannot drift.
    #[test]
    fn the_mobile_host_key_is_the_brand_constant() {
        let json = format!(r#"{{"{}":{{"enabled":true}}}}"#, crate::brand::MOBILE_HOST_KEY);
        let s: super::Settings = serde_json::from_str(&json).unwrap();
        assert!(s.app_mobile_host.is_some());
        let back = serde_json::to_value(&s).unwrap();
        assert!(back.get(crate::brand::MOBILE_HOST_KEY).is_some());
    }

    /// The old key is NOT read here, and that is deliberate (no serde `alias`):
    /// the migrator's `persisted-names` step renames it in the file before
    /// anything reads it. Should a file still hold it — an older build wrote
    /// the file afterwards — it is carried along untouched, never dropped, and
    /// a file with BOTH keys still parses: with an alias it would fail as a
    /// whole, and every reader falls back to empty defaults on a parse error.
    #[test]
    fn the_old_phone_host_key_is_carried_along_and_never_breaks_the_file() {
        if !crate::brand::PAIR.renamed() {
            return;
        }
        let old = crate::brand::LEGACY_MOBILE_HOST_KEY;
        let new = crate::brand::MOBILE_HOST_KEY;
        let only_old = format!(r#"{{"{old}":{{"enabled":true,"port":8742}},"theme":"dark"}}"#);
        let s: super::Settings = serde_json::from_str(&only_old).unwrap();
        assert!(s.app_mobile_host.is_none());
        let back = serde_json::to_value(&s).unwrap();
        assert_eq!(back[old]["port"], 8742, "an unknown key round-trips");
        assert!(back.get(new).is_none());

        let both = format!(r#"{{"{new}":{{"enabled":true}},"{old}":{{"enabled":false}},"theme":"dark"}}"#);
        let s: super::Settings = serde_json::from_str(&both).expect("both keys parse");
        assert!(s.app_mobile_host.is_some());
        let back = serde_json::to_value(&s).unwrap();
        assert_eq!(back[new]["enabled"], true);
        assert_eq!(back["theme"], "dark");
    }

    use super::Settings;

    /// The experimental rule, backend side (the frontend twin lives in
    /// `src/__tests__/shell/Experimental.test.ts`): unset defers to debug mode, and an
    /// explicit value wins in BOTH directions.
    #[test]
    fn experimental_flags_default_to_debug_mode() {
        let off = Settings::default();
        assert!(!off.python_run_debug());
        assert!(!off.deck_presenter());
        assert!(!off.web_browser());

        let debug = Settings {
            debug: Some(true),
            ..Default::default()
        };
        assert!(debug.python_run_debug());
        assert!(debug.deck_presenter());
        assert!(debug.web_browser());

        let debug_but_off = Settings {
            debug: Some(true),
            python_run_debug: Some(false),
            ..Default::default()
        };
        assert!(!debug_but_off.python_run_debug());

        let opted_in = Settings {
            python_run_debug: Some(true),
            ..Default::default()
        };
        assert!(opted_in.python_run_debug());
    }

    /// The browser's settings must be **named fields**, not `extra` passengers.
    /// A key that only exists in the `#[serde(flatten)]` catch-all round-trips
    /// perfectly and is invisible to `Settings::experimental()` and to every
    /// typed reader — so the backend could never gate on it, and a misspelling
    /// would be a silent no-op rather than a compile error. This test fails if
    /// one is ever removed from the struct and left to ride in `extra`.
    #[test]
    fn the_browser_settings_are_real_fields_and_not_extra_passengers() {
        let json = r#"{
            "web_browser": true,
            "browser_home_url": "https://example.com/",
            "browser_search_template": "https://example.invalid/?q=%s",
            "browser_link_target": "in_app",
            "browser_restore_navigate": true
        }"#;
        let s: Settings = serde_json::from_str(json).expect("settings parse");
        assert_eq!(s.web_browser, Some(true));
        assert_eq!(s.browser_home_url.as_deref(), Some("https://example.com/"));
        assert_eq!(
            s.browser_search_template.as_deref(),
            Some("https://example.invalid/?q=%s")
        );
        assert_eq!(s.browser_link_target.as_deref(), Some("in_app"));
        assert_eq!(s.browser_restore_navigate, Some(true));
        assert!(
            s.extra.is_empty(),
            "a browser setting fell through to `extra`: {:?}",
            s.extra.keys().collect::<Vec<_>>()
        );
        assert!(s.web_browser());

        // And it survives a round trip, so an older file's keys are not dropped.
        let back: Settings =
            serde_json::from_str(&serde_json::to_string(&s).unwrap()).expect("round trip");
        assert_eq!(back.browser_link_target.as_deref(), Some("in_app"));
    }

    /// Fast mode is **absent by default and never inferred**: a fresh
    /// `settings.json` omits the key, and only an explicit `true` engages a mode
    /// that removes features. It is a real named field rather than an `extra`
    /// passenger so the frontend's `Settings` type declares it and a typo in the
    /// key fails the round trip instead of being silently carried along.
    #[test]
    fn fast_mode_defaults_absent_and_is_a_real_field() {
        let raw = serde_json::to_string(&Settings::default()).unwrap();
        assert!(
            !raw.contains("fast_mode"),
            "default settings must omit fast_mode: {raw}"
        );

        let off: Settings = serde_json::from_str(r#"{"fast_mode":false}"#).expect("parse");
        assert_eq!(off.fast_mode, Some(false));
        assert!(
            off.extra.is_empty(),
            "fast_mode fell through to `extra`: {:?}",
            off.extra.keys().collect::<Vec<_>>()
        );

        // An explicit `false` must survive a round trip as `false`, not be
        // normalized back to absent: the two read the same today, but a stored
        // `false` is what a deliberate "I turned this off" looks like.
        let s: Settings = serde_json::from_str(r#"{"fast_mode":true}"#).expect("parse");
        let back: Settings =
            serde_json::from_str(&serde_json::to_string(&s).unwrap()).expect("round trip");
        assert_eq!(back.fast_mode, Some(true));
    }

    /// Local-model mail reads are absent by default (off), a real field the MCP
    /// policy can read, and an explicit `false` survives a round trip.
    #[test]
    fn root_mcp_mail_local_read_defaults_absent_and_is_a_real_field() {
        let raw = serde_json::to_string(&Settings::default()).unwrap();
        assert!(!raw.contains("root_mcp_mail_local_read"), "{raw}");
        assert!(!Settings::default().root_mcp_mail_local_read());
        for (body, want) in [(r#"{"root_mcp_mail_local_read":true}"#, true), (r#"{"root_mcp_mail_local_read":false}"#, false)] {
            let s: Settings = serde_json::from_str(body).expect("parse");
            assert!(s.extra.is_empty(), "fell through to `extra`: {:?}", s.extra.keys().collect::<Vec<_>>());
            assert_eq!(s.root_mcp_mail_local_read(), want);
            let back: Settings = serde_json::from_str(&serde_json::to_string(&s).unwrap()).expect("round trip");
            assert_eq!(back.root_mcp_mail_local_read, Some(want));
        }
    }

    /// The mail tools' local-only companion is absent by default (reads off),
    /// a real field rather than an `extra` passenger — so the MCP policy can
    /// read it — and an explicit `false` survives a round trip as `false`.
    #[test]
    fn root_mcp_mail_local_only_defaults_absent_and_is_a_real_field() {
        let raw = serde_json::to_string(&Settings::default()).unwrap();
        assert!(!raw.contains("root_mcp_mail_local_only"), "{raw}");
        assert!(!Settings::default().root_mcp_mail_local_only());

        for (body, want) in [(r#"{"root_mcp_mail_local_only":true}"#, true), (r#"{"root_mcp_mail_local_only":false}"#, false)] {
            let s: Settings = serde_json::from_str(body).expect("parse");
            assert!(s.extra.is_empty(), "fell through to `extra`: {:?}", s.extra.keys().collect::<Vec<_>>());
            assert_eq!(s.root_mcp_mail_local_only(), want);
            let back: Settings = serde_json::from_str(&serde_json::to_string(&s).unwrap()).expect("round trip");
            assert_eq!(back.root_mcp_mail_local_only, Some(want));
        }
        // Independent of the endpoint-wide switch and of mail itself.
        let s: Settings = serde_json::from_str(r#"{"root_mcp_mail_local_only":true}"#).unwrap();
        assert!(!s.root_mcp_local_only() && !s.root_mcp_mail());
    }

    /// The global Mail AI master switch (Group Q) is **absent by default** — a
    /// fresh `settings.json` omits it, so nobody inherits a feature that runs a
    /// model over their mail without turning it on. It is a real named field (not
    /// an `extra` passenger), so `mail_ai_allow`, read in the backend sync, can be
    /// gated on at all. The per-feature toggles moved to `schema::mail`.
    #[test]
    fn the_mail_ai_master_switch_defaults_absent_and_is_a_real_field() {
        let raw = serde_json::to_string(&Settings::default()).unwrap();
        assert!(
            !raw.contains("mail_ai_allow"),
            "default settings must omit mail_ai_allow: {raw}"
        );

        let s: Settings = serde_json::from_str(r#"{"mail_ai_allow":true}"#).expect("parse");
        assert_eq!(s.mail_ai_allow, Some(true));
        assert!(
            s.extra.is_empty(),
            "mail_ai_allow fell through to `extra`: {:?}",
            s.extra.keys().collect::<Vec<_>>()
        );
    }

    #[test]
    fn agent_fence_defaults_on_with_documented_paths_and_preserves_empty_override() {
        let defaults = Settings::default();
        assert!(!defaults.agent_fence_cargo_credentials.unwrap_or(false));
        let publishing: Settings = serde_json::from_str(r#"{"agent_fence_cargo_credentials":true}"#).unwrap();
        assert_eq!(publishing.agent_fence_cargo_credentials, Some(true));
        assert_eq!(serde_json::to_value(&publishing).unwrap()["agent_fence_cargo_credentials"], true);
        // The root fence's project view: off unless written, and it round-trips.
        assert!(!defaults.root_fence_projects_readable());
        assert!(serde_json::to_value(&defaults).unwrap().get("root_fence_projects_readable").is_none());
        let reading: Settings = serde_json::from_str(r#"{"root_fence_projects_readable":true}"#).unwrap();
        assert!(reading.root_fence_projects_readable());
        assert_eq!(
            defaults.agent_fence_paths(),
            super::DEFAULT_AGENT_FENCE_PATHS
                .iter()
                .map(|path| (*path).to_string())
                .collect::<Vec<_>>()
        );

        let off: Settings =
            serde_json::from_str(r#"{"agent_fence":false,"agent_fence_paths":[]}"#)
                .expect("agent fence settings parse");
        // The old switch round-trips but decides nothing any more.
        assert_eq!(off.agent_fence, Some(false));
        assert!(off.agent_fence_paths().is_empty());
        assert!(off.extra.is_empty());
    }
}

#[cfg(test)]
mod default_rule_tests {
    use super::*;

    /// The "default ON, only an explicit false opts out" trio: tmux for local
    /// tabs, headless connections, and remote control. An older
    /// `settings.json` without the keys keeps today's behaviour.
    #[test]
    fn default_on_switches_read_absent_as_on_and_only_explicit_false_as_off() {
        let absent = Settings::default();
        assert!(absent.persist_local_sessions());
        assert!(absent.connections_headless());
        assert!(absent.agent_remote_control());
        assert!(absent.daily_stats_recap());
        assert_eq!(absent.color_scheme(), "light_lavender");

        let off: Settings = serde_json::from_str(
            r#"{"persist_local_sessions":false,"connections_headless":false,
                "agent_remote_control":false,"daily_stats_recap":false,"color_scheme":"soft_dark"}"#,
        )
        .unwrap();
        assert!(!off.persist_local_sessions());
        assert!(!off.connections_headless());
        assert!(!off.agent_remote_control());
        assert!(!off.daily_stats_recap());
        assert_eq!(off.color_scheme(), "soft_dark");
        assert!(off.extra.is_empty(), "{:?}", off.extra.keys().collect::<Vec<_>>());
    }

    /// Live pages are the one browser surface that stays off in debug mode:
    /// unset means off everywhere, unlike the flag that enables the browser.
    #[test]
    fn browser_live_pages_stay_off_even_in_debug_mode() {
        let debug = Settings {
            debug: Some(true),
            ..Default::default()
        };
        assert!(debug.web_browser());
        assert!(!debug.browser_live_pages());
        let on = Settings {
            browser_live_pages: Some(true),
            ..Default::default()
        };
        assert!(on.browser_live_pages());
    }

    /// `window_state` written before `maximized` existed reads as not
    /// maximized, and there is no `fullscreen` key to strand the window with.
    #[test]
    fn window_state_defaults_maximized_off_and_has_no_fullscreen_key() {
        let w: WindowState = serde_json::from_str(r#"{"x":10,"y":20,"w":800,"h":600}"#).unwrap();
        assert!(!w.maximized);
        let out = serde_json::to_value(w).unwrap();
        assert!(out.get("fullscreen").is_none());
        assert_eq!(out["maximized"], false);
        let s: Settings =
            serde_json::from_str(r#"{"window_state":{"x":0,"y":0,"w":1,"h":1,"maximized":true}}"#)
                .unwrap();
        assert!(s.window_state.unwrap().maximized);
    }

    /// A chord writes only the modifiers that are on, and reads a missing
    /// modifier as off — the JSON stays compact and older files load.
    #[test]
    fn chords_write_only_the_modifiers_that_are_on() {
        let c: ChordDescriptor = serde_json::from_str(r#"{"key":"k","ctrl":true}"#).unwrap();
        assert!(c.ctrl && !c.shift && !c.alt && !c.meta);
        assert_eq!(
            serde_json::to_value(&c).unwrap(),
            serde_json::json!({"key":"k","ctrl":true})
        );
        let plain = ChordDescriptor {
            key: "F9".into(),
            ..Default::default()
        };
        assert_eq!(serde_json::to_value(&plain).unwrap(), serde_json::json!({"key":"F9"}));
    }

    /// The per-type viewer prefs and the alert sources are all tri-state and
    /// write nothing by default — so a fresh install's file carries neither a
    /// spurious `false` (alerts: absent means ON) nor a spurious `true`.
    #[test]
    fn viewer_prefs_and_alert_sources_write_nothing_by_default() {
        assert_eq!(serde_json::to_value(ViewerPref::default()).unwrap(), serde_json::json!({}));
        assert_eq!(serde_json::to_value(AlertSources::default()).unwrap(), serde_json::json!({}));
        let src: AlertSources = serde_json::from_str(r#"{"mail":false}"#).unwrap();
        assert_eq!(src.mail, Some(false));
        assert!(src.events.is_none() && src.tasks.is_none());
        let pref: ViewerPref =
            serde_json::from_str(r#"{"autocomplete":true,"font_size":14.5,"hover_preview":false}"#)
                .unwrap();
        assert_eq!(pref.font_size, Some(14.5));
        assert_eq!(pref.hover_preview, Some(false));
        assert!(pref.spell_check.is_none());
    }

    /// The Mobile host block is off by default, loads from `{}`, and writes
    /// its mail gates only when they have been set.
    #[test]
    fn mobile_host_settings_default_off_and_omit_unset_gates() {
        let m: AppMobileHostSettings = serde_json::from_str("{}").unwrap();
        assert!(!m.enabled);
        assert!(m.mail_actions.is_none() && m.mail_reply.is_none());
        assert_eq!(
            serde_json::to_value(&m).unwrap(),
            serde_json::json!({"enabled": false})
        );
        let s: Settings = serde_json::from_str(
            concat!(r#"{""#, crate::app_slug!(), r#"_mobile_host":{"enabled":true,"port":8443,"mail_reply":true}}"#),
        )
        .unwrap();
        let host = s.app_mobile_host.unwrap();
        assert_eq!(host.port, Some(8443));
        assert_eq!(host.mail_reply, Some(true));
        assert!(host.mail_actions.is_none(), "reply and actions are independent");
    }

    /// The phone's local-model switch: unset stays unset (which means on), and
    /// an explicit `false` survives a read → write.
    #[test]
    fn mobile_host_local_models_switch_round_trips() {
        let key = crate::brand::MOBILE_HOST_KEY;
        let s: Settings = serde_json::from_str(&format!(r#"{{"{key}":{{"enabled":true}}}}"#)).unwrap();
        assert!(s.app_mobile_host.as_ref().unwrap().local_models.is_none());
        let back = serde_json::to_value(&s).unwrap();
        assert!(back[key].get("local_models").is_none(), "absent stays absent");

        let s: Settings = serde_json::from_str(&format!(
            r#"{{"{key}":{{"enabled":true,"local_models":false}}}}"#
        ))
        .unwrap();
        assert_eq!(s.app_mobile_host.as_ref().unwrap().local_models, Some(false));
        let back: Settings = serde_json::from_str(&serde_json::to_string(&s).unwrap()).unwrap();
        assert_eq!(back.app_mobile_host.unwrap().local_models, Some(false));
    }

    /// `global_apps` entries keep foreign keys through `extra`, and a settings
    /// file with keys this build does not know round-trips them untouched.
    #[test]
    fn unknown_settings_keys_survive_a_round_trip() {
        let raw = r#"{"global_apps":{"code":{"exec":"code","visible":true,"icon":"vscode"}},
                      "some_future_setting":{"a":[1,2]}}"#;
        let s: Settings = serde_json::from_str(raw).unwrap();
        assert_eq!(s.global_apps.as_ref().unwrap()["code"].extra["icon"], "vscode");
        assert_eq!(s.extra["some_future_setting"]["a"][1], 2);
        let back: Settings = serde_json::from_str(&serde_json::to_string(&s).unwrap()).unwrap();
        assert_eq!(back.extra["some_future_setting"]["a"][1], 2);
        assert_eq!(back.global_apps.unwrap()["code"].extra["icon"], "vscode");
    }

    /// `ide_launchers` is optional on the way in and absent on the way out
    /// when unset, so a settings file from before it existed is untouched.
    #[test]
    fn ide_launchers_round_trip_and_stay_absent_when_unset() {
        let s: Settings = serde_json::from_str("{}").unwrap();
        assert!(s.ide_launchers.is_none());
        assert!(!serde_json::to_string(&s).unwrap().contains("ide_launchers"));

        let raw = r#"{"ide_launchers":{"pycharm":"/opt/pycharm/bin/pycharm.sh"}}"#;
        let s: Settings = serde_json::from_str(raw).unwrap();
        let back: Settings = serde_json::from_str(&serde_json::to_string(&s).unwrap()).unwrap();
        assert_eq!(back.ide_launchers.unwrap()["pycharm"], "/opt/pycharm/bin/pycharm.sh");
    }
}
