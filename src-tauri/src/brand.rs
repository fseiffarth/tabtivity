//! The app's name — the ONE backend place it is spelled. Display text, user
//! agents and every name the app puts on disk, in a keyring, on the wire or
//! into another program's config are built from the macros below, so a rename
//! edits this file and its frontend twin `src/lib/brand.ts`, nothing else.
//!
//! Each such name comes as a pair: the current name, built from the current
//! brand, and a `LEGACY_*` twin built from the old brand (the name the app
//! had before it was renamed). Code that *writes* a name uses the
//! current constant; code that must still *find* something an older build
//! wrote uses the `LEGACY_*` one.
//!
//! Three spellings need a literal the compiler cannot derive: a `match`
//! pattern is fine with a constant, but `#[serde(rename = "…")]` and
//! `include_bytes!` paths are not. Those few carry a `brand-check: allow`
//! marker and a test that pins them to the constant here.

/// The name as shown to the user, as a literal: `concat!` needs one, so text
/// that must stay a `&'static str` is written
/// `concat!("Open ", crate::app_name!(), " first")`. Everything else reads
/// [`DISPLAY`].
#[macro_export]
macro_rules! app_name {
    () => {
        "Tabtivity"
    };
}

/// The lowercase form as a literal, for `concat!`. Everything else reads
/// [`SLUG`].
#[macro_export]
macro_rules! app_slug {
    () => {
        "tabtivity"
    };
}

/// The uppercase form as a literal, for `concat!`. Everything else reads
/// [`UPPER`].
#[macro_export]
macro_rules! app_upper {
    () => {
        "TABTIVITY"
    };
}

/// The name of one of the app's environment variables, as a literal:
/// `app_env!("TAB_UID")` is `<UPPER>_TAB_UID`.
#[macro_export]
macro_rules! app_env {
    ($name:literal) => {
        concat!($crate::app_upper!(), "_", $name)
    };
}

/// The command a saved tab of a built-in view carries, as a literal:
/// `app_tab_command!("mail")` is `__<slug>_mail__`.
#[macro_export]
macro_rules! app_tab_command {
    ($view:literal) => {
        concat!("__", $crate::app_slug!(), "_", $view, "__")
    };
}

/// The GitHub repository releases are published from, `<owner>/<name>`. It
/// moves on its own schedule (after the name does), so it is its own literal.
#[macro_export]
macro_rules! app_repo {
    () => {
        "fseiffarth/tabtivity"
    };
}

/// The old display name, as a literal.
#[macro_export]
macro_rules! legacy_name {
    () => {
        "Eldrun"
    };
}

/// The old lowercase form, as a literal.
#[macro_export]
macro_rules! legacy_slug {
    () => {
        "eldrun"
    };
}

/// The old uppercase form, as a literal.
#[macro_export]
macro_rules! legacy_upper {
    () => {
        "ELDRUN"
    };
}

/// The name as shown to the user.
pub const DISPLAY: &str = app_name!();

/// Lowercase form for file names, service names and protocol names.
pub const SLUG: &str = app_slug!();

/// Uppercase form, for markers and environment variables.
pub const UPPER: &str = app_upper!();

/// Prefix of the app's environment variables.
pub const ENV_PREFIX: &str = concat!(app_upper!(), "_");

/// The old display name.
pub const LEGACY_DISPLAY: &str = legacy_name!();

/// The old lowercase form.
pub const LEGACY_SLUG: &str = legacy_slug!();

/// The old uppercase form.
pub const LEGACY_UPPER: &str = legacy_upper!();

/// Prefix of the environment variables older builds exported.
pub const LEGACY_ENV_PREFIX: &str = concat!(legacy_upper!(), "_");

/// `<owner>/<name>` of the GitHub repository releases are published from.
pub const REPO: &str = app_repo!();

/// `<Display>/<version>` — how the app names itself to a server.
pub fn user_agent() -> String {
    format!("{DISPLAY}/{}", env!("CARGO_PKG_VERSION"))
}

/// One brand's three forms. The constants above are [`CURRENT`] and [`LEGACY`]
/// spelled out; a test builds an invented brand to run the migrator and the
/// dual reads with names that differ.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Forms {
    /// The name as shown to the user.
    pub display: &'static str,
    /// Lowercase form.
    pub slug: &'static str,
    /// Uppercase form.
    pub upper: &'static str,
}

impl Forms {
    /// Prefix of this brand's environment variables.
    pub fn env_prefix(&self) -> String {
        format!("{}_", self.upper)
    }

    /// This brand's environment variable `<prefix><name>`.
    pub fn env_name(&self, name: &str) -> String {
        format!("{}_{name}", self.upper)
    }
}

/// The brand this build writes.
pub const CURRENT: Forms = Forms { display: DISPLAY, slug: SLUG, upper: UPPER };

/// The brand older builds wrote.
pub const LEGACY: Forms = Forms { display: LEGACY_DISPLAY, slug: LEGACY_SLUG, upper: LEGACY_UPPER };

/// The current brand and the old one it replaced. Everything that looks a name
/// up twice, and every migration step, takes one of these instead of reading
/// the constants: production passes [`PAIR`], a test an invented pair.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Pair {
    /// What this build writes and looks up first.
    pub cur: Forms,
    /// What older builds wrote.
    pub legacy: Forms,
}

/// The pair this build runs with.
pub const PAIR: Pair = Pair { cur: CURRENT, legacy: LEGACY };

impl Pair {
    /// Whether the name changed at all. While it has not, there is nothing to
    /// migrate and no second place to look.
    pub fn renamed(&self) -> bool {
        self.cur != self.legacy
    }

    /// `name` as this build writes it.
    pub fn cur(&self, name: Name) -> String {
        self.cur.name(name)
    }

    /// `name` as an older build wrote it — `None` when that is the current
    /// spelling, so a dual read written `if let Some(old) = pair.legacy(..)`
    /// never looks twice in the same place.
    pub fn legacy(&self, name: Name) -> Option<String> {
        let old = self.legacy.name(name);
        (old != self.cur.name(name)).then_some(old)
    }

    /// The old environment variable `<old prefix><name>`, or `None` when the
    /// prefix did not change.
    pub fn legacy_env_name(&self, name: &str) -> Option<String> {
        (self.cur.upper != self.legacy.upper).then(|| self.legacy.env_name(name))
    }

    /// The value of the app's environment variable `name`: the current
    /// spelling first, then the old one (counted as a legacy hit). `lookup`
    /// is the environment; an empty value counts as unset.
    pub fn env_in(&self, name: &str, mut lookup: impl FnMut(&str) -> Option<String>) -> Option<String> {
        if let Some(value) = lookup(&self.cur.env_name(name)).filter(|v| !v.is_empty()) {
            return Some(value);
        }
        let value = lookup(&self.legacy_env_name(name)?).filter(|v| !v.is_empty())?;
        legacy_hit(&format!("env:{name}"));
        Some(value)
    }

    /// Bring an environment an older build saved or exported up to date:
    /// each variable under the old prefix moves to the current one, unless
    /// the current one is already set. Returns whether anything moved.
    pub fn adopt_legacy_env(&self, env: &mut std::collections::HashMap<String, String>) -> bool {
        if self.cur.upper == self.legacy.upper {
            return false;
        }
        let old_prefix = self.legacy.env_prefix();
        let old_keys: Vec<String> = env.keys().filter(|k| k.starts_with(&old_prefix)).cloned().collect();
        for old_key in &old_keys {
            let Some(value) = env.remove(old_key) else { continue };
            let name = &old_key[old_prefix.len()..];
            legacy_hit(&format!("env:{name}"));
            env.entry(self.cur.env_name(name)).or_insert(value);
        }
        !old_keys.is_empty()
    }

    /// Export every one of the app's variables in `env` under the old prefix
    /// as well, for a program that still reads the old name (an agent CLI's
    /// hook written by an older build, a user's script). A variable already
    /// set under the old name is left alone.
    ///
    /// A variable that carries a secret is never given a twin: the places
    /// that keep secrets out of an argv or a log know them by their current
    /// names only, and nothing outside the app is meant to read them.
    pub fn export_both(&self, env: &mut std::collections::HashMap<String, String>) {
        if self.cur.upper == self.legacy.upper {
            return;
        }
        let prefix = self.cur.env_prefix();
        const SINGLE_NAMED: [&str; 4] = ["TOKEN", "ASKPASS", "SECRET", "PASSWORD"];
        let single_named = |name: &str| SINGLE_NAMED.iter().any(|word| name.contains(word));
        let twins: Vec<(String, String)> = env
            .iter()
            .filter_map(|(key, value)| {
                let name = key.strip_prefix(&prefix).filter(|name| !single_named(name))?;
                Some((self.legacy.env_name(name), value.clone()))
            })
            .collect();
        for (key, value) in twins {
            env.entry(key).or_insert(value);
        }
    }
}

/// The app's environment variable `name` from the process environment: the
/// current spelling, then the old one. See [`Pair::env_in`].
pub fn env(name: &str) -> Option<String> {
    PAIR.env_in(name, |key| std::env::var(key).ok())
}

/// The app's environment variable `name` as the process has it, set-but-empty
/// included: the current spelling if it is set at all, else the old one.
pub fn env_os(name: &str) -> Option<std::ffi::OsString> {
    if let Some(value) = std::env::var_os(PAIR.cur.env_name(name)) {
        return Some(value);
    }
    let value = std::env::var_os(PAIR.legacy_env_name(name)?)?;
    legacy_hit(&format!("env:{name}"));
    Some(value)
}

/// Count one lookup that found something only under its old name. `id` says
/// which lookup (`"state-dir"`, `"tmux-prefix"`, `"env:TAB_UID"`); the counts
/// land in `<state>/legacy-hits.json` and Settings → Updates shows them. The
/// old-name lookups can be deleted once that file stays empty.
///
/// A lookup can only miss under the current name and hit under the old one
/// when the two differ, so this would never be reached were the brand
/// unchanged; the log refuses to write then anyway.
///
/// This file is also compiled into the build script, so it cannot name the
/// module that keeps the log: the app installs it with
/// [`set_legacy_hit_sink`] first thing, and until then a hit is dropped.
pub fn legacy_hit(id: &str) {
    if let Some(sink) = LEGACY_HIT_SINK.get() {
        sink(id);
    }
}

static LEGACY_HIT_SINK: std::sync::OnceLock<fn(&str)> = std::sync::OnceLock::new();

/// Say where [`legacy_hit`] counts. The first call wins.
pub fn set_legacy_hit_sink(sink: fn(&str)) {
    let _ = LEGACY_HIT_SINK.set(sink);
}

// ── Pinned ids ──────────────────────────────────────────────────────────────
// Inputs of ids that are stored or handed out and can never be recomputed
// under another value. They are literals on purpose: they belong to no brand,
// follow no rename, and are never shown or written anywhere.

/// Hashed with a gateway's MAC into the id a remembered network carries. A
/// different value would forget every remembered network.
pub const PINNED_GATEWAY_ID_CONTEXT: &str = "eldrun-gateway:";
/// Hashed with a subagent's id into the handle the phone sees. A different
/// value would stop matching the handles a phone already holds.
pub const PINNED_SUBAGENT_TOKEN_CONTEXT: &str = "eldrun-subagent:";

/// Declare a current name and its `LEGACY_*` twin from one pattern. `slug`,
/// `name` and `upper` stand for the brand's three forms; every other piece is
/// a literal.
macro_rules! names {
    ($( $(#[$doc:meta])* $cur:ident / $legacy:ident = [$($part:tt),+ $(,)?]; )+) => {
        $(
            $(#[$doc])*
            pub const $cur: &str = concat!($(names!(@cur $part)),+);
            /// The name an older build used for the constant it is the twin of.
            pub const $legacy: &str = concat!($(names!(@legacy $part)),+);
        )+

        /// Every name declared above, as a value: `forms.name(Name::PROJECT_DIR)`
        /// builds it for any brand. The migrator and the dual reads take their
        /// names this way, so a test can run them under an invented brand
        /// while the constants stay what they are.
        #[allow(non_camel_case_types)]
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
        pub enum Name {
            $( $(#[$doc])* $cur, )+
        }

        impl Name {
            /// Every name with its current and its old constant.
            pub const ALL: &'static [(Name, &'static str, &'static str)] =
                &[$( (Name::$cur, $cur, $legacy) ),+];
        }

        impl Forms {
            /// `name` as this brand spells it.
            pub fn name(&self, name: Name) -> String {
                match name {
                    $( Name::$cur => [$(names!(@forms self $part)),+].concat(), )+
                }
            }
        }
    };
    (@cur slug) => { $crate::app_slug!() };
    (@cur name) => { $crate::app_name!() };
    (@cur upper) => { $crate::app_upper!() };
    (@cur $lit:literal) => { $lit };
    (@legacy slug) => { $crate::legacy_slug!() };
    (@legacy name) => { $crate::legacy_name!() };
    (@legacy upper) => { $crate::legacy_upper!() };
    (@legacy $lit:literal) => { $lit };
    (@forms $forms:ident slug) => { $forms.slug };
    (@forms $forms:ident name) => { $forms.display };
    (@forms $forms:ident upper) => { $forms.upper };
    (@forms $forms:ident $lit:literal) => { $lit };
}

names! {
    // ── Folders the app owns ────────────────────────────────────────────────
    /// Leaf of the state dir (`~/.local/share/<this>`, `%APPDATA%\<this>`).
    STATE_DIR_NAME / LEGACY_STATE_DIR_NAME = [slug];
    /// Leaf of the tree in the user's home that holds projects, boxes, the
    /// archive and the root console's folder (`~/<this>`).
    HOME_DIR_NAME / LEGACY_HOME_DIR_NAME = [slug];
    /// The Tauri identifier; the webview's data dir is named after it.
    APP_IDENTIFIER / LEGACY_APP_IDENTIFIER = ["io.github.fseiffarth.", slug];
    /// The built main binary (`target/<profile>/<this>`), also the process
    /// name a window manager reports.
    BIN_NAME / LEGACY_BIN_NAME = [slug];
    /// The frozen dev build's binary, next to its launcher.
    DEV_BIN_NAME / LEGACY_DEV_BIN_NAME = [slug, "-dev"];
    /// The stamp `package-dev.sh` leaves next to the release binary.
    FROZEN_RECORD_NAME / LEGACY_FROZEN_RECORD_NAME = [slug, ".frozen"];
    /// The checkout's launcher script for the frozen dev build.
    DEV_LAUNCHER_SCRIPT / LEGACY_DEV_LAUNCHER_SCRIPT = ["start-", slug, "-dev-build.sh"];
    /// WM_CLASS of the main window.
    WM_CLASS / LEGACY_WM_CLASS = [name];
    /// WM_CLASS of a window parked out of sight.
    WM_CLASS_HIDDEN / LEGACY_WM_CLASS_HIDDEN = [name, "-Hidden"];

    // ── Inside a project folder ─────────────────────────────────────────────
    /// The app's own folder in a project (sessions, inbox, outbox, worktrees).
    PROJECT_DIR / LEGACY_PROJECT_DIR = [".", slug];
    /// The `info/exclude` rule that keeps [`PROJECT_DIR`] out of git.
    PROJECT_DIR_EXCLUDE_RULE / LEGACY_PROJECT_DIR_EXCLUDE_RULE = [".", slug, "/"];
    /// Where files sent from the phone land, relative to the project root.
    INBOX_DIR / LEGACY_INBOX_DIR = [".", slug, "/inbox"];
    /// Where files for the phone are staged, relative to the project root.
    OUTBOX_DIR / LEGACY_OUTBOX_DIR = [".", slug, "/outbox"];
    /// Linked worktrees, relative to the project root.
    WORKTREES_DIR / LEGACY_WORKTREES_DIR = [".", slug, "/worktrees"];
    /// Screenshots folder in a project.
    SCREENSHOTS_DIR / LEGACY_SCREENSHOTS_DIR = [slug, "-screenshots"];
    /// Saved-mail folder in a project.
    EMAILS_DIR / LEGACY_EMAILS_DIR = [slug, "-emails"];
    /// The bundle a worker sync leaves in the remote project.
    WORKER_BUNDLE / LEGACY_WORKER_BUNDLE = [".", slug, "-worker.bundle"];
    /// The bundle a lockstep transfer stages inside `.git`.
    LOCKSTEP_BUNDLE / LEGACY_LOCKSTEP_BUNDLE = [slug, "-lockstep.bundle"];
    /// Manifest of the box links written into a box folder.
    BOX_LINKS_MANIFEST / LEGACY_BOX_LINKS_MANIFEST = [".", slug, "-box-links.json"];
    /// Opening marker of the generated box-links block in agent docs.
    BOX_LINKS_START / LEGACY_BOX_LINKS_START = ["<!-- ", slug, ":box-links:start -->"];
    /// Closing marker of the generated box-links block in agent docs.
    BOX_LINKS_END / LEGACY_BOX_LINKS_END = ["<!-- ", slug, ":box-links:end -->"];

    // ── Project exchange ────────────────────────────────────────────────────
    /// Manifest inside an exported project bundle.
    EXPORT_MANIFEST / LEGACY_EXPORT_MANIFEST = [slug, "-export.json"];
    /// File extension of an exported project bundle (no dot).
    EXPORT_EXTENSION / LEGACY_EXPORT_EXTENSION = [slug, "proj"];

    // ── git ─────────────────────────────────────────────────────────────────
    /// Namespace of the refs the app keeps in a repository.
    GIT_REF_NAMESPACE / LEGACY_GIT_REF_NAMESPACE = ["refs/", slug];
    /// Backups of branches a sync moved (`<this>/<secs>/<branch>`).
    GIT_REF_BACKUP / LEGACY_GIT_REF_BACKUP = ["refs/", slug, "/backup"];
    /// Where each peer's branch tips are tracked.
    GIT_REF_PEER / LEGACY_GIT_REF_PEER = ["refs/", slug, "/peer"];
    /// Where fetched-but-not-adopted refs wait.
    GIT_REF_INCOMING / LEGACY_GIT_REF_INCOMING = ["refs/", slug, "/incoming"];

    // ── Agent homes ─────────────────────────────────────────────────────────
    /// Marks an agent home as seeded.
    AGENT_HOME_MARKER / LEGACY_AGENT_HOME_MARKER = [".", slug, "-home"];
    /// What the global layer last merged into a home.
    AGENT_GLOBAL_MANIFEST / LEGACY_AGENT_GLOBAL_MANIFEST = [".", slug, "-global.json"];
    /// Backups of files the global layer replaced in a home.
    AGENT_GLOBAL_BACKUP_DIR / LEGACY_AGENT_GLOBAL_BACKUP_DIR = [".", slug, "-global-backup"];
    /// The session hook script in `<state>/hooks` (POSIX).
    SESSION_HOOK_SH / LEGACY_SESSION_HOOK_SH = [slug, "_session_start.sh"];
    /// The session hook script in `<state>/hooks` (PowerShell).
    SESSION_HOOK_PS1 / LEGACY_SESSION_HOOK_PS1 = [slug, "_session_start.ps1"];
    /// The agent-hint hook script in `<state>/hooks` (POSIX).
    AGENT_HINT_SH / LEGACY_AGENT_HINT_SH = [slug, "_agent_hint.sh"];
    /// The agent-hint hook script in `<state>/hooks` (PowerShell).
    AGENT_HINT_PS1 / LEGACY_AGENT_HINT_PS1 = [slug, "_agent_hint.ps1"];
    /// The agent-hint instructions file in `<state>/hooks`.
    AGENT_HINT_MD / LEGACY_AGENT_HINT_MD = [slug, "_agent_hint.md"];
    /// Copilot's hint hook file, relative to an agent home.
    COPILOT_HINT_HOOKS / LEGACY_COPILOT_HINT_HOOKS = [".copilot/hooks/", slug, "-hint.json"];
    /// Opening marker of the agent-hint block in a CLI's instructions file.
    AGENT_HINT_START / LEGACY_AGENT_HINT_START = ["<!-- ", slug, ":agent-hint:start -->"];
    /// Closing marker of the agent-hint block in a CLI's instructions file.
    AGENT_HINT_END / LEGACY_AGENT_HINT_END = ["<!-- ", slug, ":agent-hint:end -->"];
    /// Name of the session hook entry in a Vibe config.
    VIBE_SESSION_HOOK / LEGACY_VIBE_SESSION_HOOK = [slug, "-session"];
    /// The CLI an agent runs to put a file in front of the user.
    SEND_CLI / LEGACY_SEND_CLI = [slug, "-send"];

    // ── MCP ─────────────────────────────────────────────────────────────────
    /// The root console's MCP server.
    MCP_SERVER / LEGACY_MCP_SERVER = [slug];
    /// The git-push MCP server.
    MCP_GIT_SERVER / LEGACY_MCP_GIT_SERVER = [slug, "-git"];
    /// The help MCP server.
    MCP_HELP_SERVER / LEGACY_MCP_HELP_SERVER = [slug, "-help"];
    /// The schedule MCP server.
    MCP_SCHEDULE_SERVER / LEGACY_MCP_SCHEDULE_SERVER = [slug, "-schedule"];
    /// Help MCP tool: search.
    HELP_TOOL_SEARCH / LEGACY_HELP_TOOL_SEARCH = [slug, "_help_search"];
    /// Help MCP tool: read.
    HELP_TOOL_READ / LEGACY_HELP_TOOL_READ = [slug, "_help_read"];
    /// Help MCP tool: topics.
    HELP_TOOL_TOPICS / LEGACY_HELP_TOOL_TOPICS = [slug, "_help_topics"];
    /// Help MCP tool: status.
    HELP_TOOL_STATUS / LEGACY_HELP_TOOL_STATUS = [slug, "_help_status"];

    // ── Persisted keys and ids ──────────────────────────────────────────────
    /// Settings key of the phone host's settings.
    MOBILE_HOST_KEY / LEGACY_MOBILE_HOST_KEY = [slug, "_mobile_host"];
    /// Project / box key that opens it to the phone.
    MOBILE_ACCESS_KEY / LEGACY_MOBILE_ACCESS_KEY = [slug, "_mobile_access"];
    /// Project / box key listing the paired phones that may open it (absent:
    /// every phone). New with this name; nothing older wrote it.
    MOBILE_DEVICES_KEY / LEGACY_MOBILE_DEVICES_KEY = [slug, "_mobile_devices"];
    /// What every built-in view's saved tab command starts with.
    TAB_COMMAND_PREFIX / LEGACY_TAB_COMMAND_PREFIX = ["__", slug, "_"];
    /// Id of the app's own row in the time log.
    APP_TIMER_ID / LEGACY_APP_TIMER_ID = ["__", slug, "__"];
    /// Keyring service of the remote (SSH / VPN) passwords.
    KEYRING_REMOTE / LEGACY_KEYRING_REMOTE = [slug, "-remote"];
    /// Keyring service of the git hosting tokens.
    KEYRING_GIT_HOSTING / LEGACY_KEYRING_GIT_HOSTING = [slug, "-git-hosting"];
    /// HKDF salt of the phone's sealed file tokens.
    MOBILE_FILES_SALT / LEGACY_MOBILE_FILES_SALT = [slug, "-mobile-files"];
    /// Root of the mail store's key-derivation labels. A label is a key
    /// input: a store written under one root opens under no other.
    MAIL_LABEL_ROOT / LEGACY_MAIL_LABEL_ROOT = [slug, "/mail/v1/"];
    /// Associated data of the mail store's wrapped master key; a key input
    /// like the labels.
    MAIL_WRAP_AAD / LEGACY_MAIL_WRAP_AAD = [slug, "/mail/v1/master"];

    // ── Phone host ──────────────────────────────────────────────────────────
    /// The phone host's binary (no `.exe`).
    MOBILE_HOST_BIN / LEGACY_MOBILE_HOST_BIN = [slug, "-mobile-host"];
    /// The phone host's binary on Windows.
    MOBILE_HOST_EXE / LEGACY_MOBILE_HOST_EXE = [slug, "-mobile-host.exe"];
    /// The phone host's systemd user unit.
    MOBILE_HOST_UNIT / LEGACY_MOBILE_HOST_UNIT = [slug, "-mobile-host.service"];
    /// The phone host's launchd label.
    MOBILE_HOST_LAUNCHD_LABEL / LEGACY_MOBILE_HOST_LAUNCHD_LABEL = ["io.github.fseiffarth.", slug, ".mobile-host"];
    /// The phone host's value under the Windows `Run` key.
    MOBILE_HOST_RUN_VALUE / LEGACY_MOBILE_HOST_RUN_VALUE = [name, "MobileHost"];
    /// WebSocket subprotocol of a phone terminal.
    TERMINAL_PROTOCOL / LEGACY_TERMINAL_PROTOCOL = [slug, "-terminal.v1"];
    /// The phone session cookie.
    SESSION_COOKIE / LEGACY_SESSION_COOKIE = ["__Host-", slug, "_session"];
    /// Domain-separation prefix of the phone's signed requests.
    MOBILE_AUTH_CONTEXT / LEGACY_MOBILE_AUTH_CONTEXT = [slug, "-mobile-auth-v1"];
    /// Prefix of the admin control pipe on Windows.
    CONTROL_PIPE_PREFIX / LEGACY_CONTROL_PIPE_PREFIX = [slug, "-control-"];

    // ── Sessions, containers, VMs ───────────────────────────────────────────
    /// What every tmux session the app owns starts with.
    TMUX_PREFIX / LEGACY_TMUX_PREFIX = [slug, "-"];
    /// What every container and per-project image the app owns starts with.
    CONTAINER_PREFIX / LEGACY_CONTAINER_PREFIX = [slug, "-"];
    /// The stock sandbox image.
    SANDBOX_IMAGE / LEGACY_SANDBOX_IMAGE = [slug, "-agent-sandbox:latest"];
    /// Docker label (`key=value`) on every container the app owns.
    DOCKER_OWNER_LABEL / LEGACY_DOCKER_OWNER_LABEL = [slug, ".owner=", slug];
    /// Docker label key naming a container's project.
    DOCKER_PROJECT_LABEL / LEGACY_DOCKER_PROJECT_LABEL = [slug, ".project"];
    /// Docker label key holding a container's spec fingerprint.
    DOCKER_SPEC_LABEL / LEGACY_DOCKER_SPEC_LABEL = [slug, ".spec"];
    /// Default libvirt-style name, hostname and key comment of a project VM.
    VM_NAME / LEGACY_VM_NAME = [slug, "-vm"];
    /// The guest user of a project VM.
    VM_USER / LEGACY_VM_USER = [slug];
    /// The project's mount point in a VM guest.
    VM_PROJECT_DIR / LEGACY_VM_PROJECT_DIR = ["/home/", slug, "/project"];
    /// What a VM's cloud-init instance id starts with. cloud-init runs first
    /// boot again when the id changes, so an existing VM must keep its id.
    VM_INSTANCE_ID_PREFIX / LEGACY_VM_INSTANCE_ID_PREFIX = [slug, "-"];
    /// What a VM base image's file name starts with.
    VM_BASE_IMAGE_PREFIX / LEGACY_VM_BASE_IMAGE_PREFIX = [slug, "-base-"];
    /// Ollama systemd drop-in that pins the integrated GPU.
    OLLAMA_IGPU_DROPIN / LEGACY_OLLAMA_IGPU_DROPIN = [slug, "-igpu.conf"];
    /// Ollama systemd drop-in that moves the model store.
    OLLAMA_MODELS_DROPIN / LEGACY_OLLAMA_MODELS_DROPIN = [slug, "-models.conf"];

    // ── Between the window and the backend ──────────────────────────────────
    /// Custom-protocol request header: the file to serve.
    FILE_PATH_HEADER / LEGACY_FILE_PATH_HEADER = ["x-", slug, "-path"];
    /// Custom-protocol request header: the project the file belongs to.
    FILE_PROJECT_HEADER / LEGACY_FILE_PROJECT_HEADER = ["x-", slug, "-project"];
    /// Event: a native file drag ended.
    FILE_DRAG_ENDED_EVENT / LEGACY_FILE_DRAG_ENDED_EVENT = [slug, ":file-drag-ended"];
    /// Event: the phone asked the desktop for something.
    MOBILE_DESKTOP_EVENT / LEGACY_MOBILE_DESKTOP_EVENT = [slug, "-mobile-desktop-request"];
    /// Error prefix: the project must be trusted before this runs.
    TRUST_REQUIRED_PREFIX / LEGACY_TRUST_REQUIRED_PREFIX = [slug, "-trust-required:"];
    /// Error sentinel: native printing is not available here.
    NATIVE_PRINT_UNSUPPORTED / LEGACY_NATIVE_PRINT_UNSUPPORTED = [slug, "-native-print-unsupported"];
}

/// Whether `name` is the app's own folder in a project, under the current
/// name or the one an older build used. For the code that hides or skips
/// that folder (file listings, search, byte-sync): a project that has not
/// been opened since a rename still has it under the old name.
pub fn is_project_dir(name: &str) -> bool {
    name == PROJECT_DIR || name == LEGACY_PROJECT_DIR
}

/// The app's environment variable `<ENV_PREFIX><name>`.
pub fn env_name(name: &str) -> String {
    format!("{ENV_PREFIX}{name}")
}

/// One of the mail store's key-derivation labels under [`MAIL_LABEL_ROOT`].
pub fn mail_label(leaf: &str) -> Vec<u8> {
    format!("{MAIL_LABEL_ROOT}{leaf}").into_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_forms_agree() {
        assert_eq!(SLUG, DISPLAY.to_lowercase());
        assert_eq!(UPPER, SLUG.to_uppercase());
        assert_eq!(ENV_PREFIX, format!("{UPPER}_"));
        assert_eq!(LEGACY_SLUG, LEGACY_DISPLAY.to_lowercase());
        assert_eq!(LEGACY_UPPER, LEGACY_SLUG.to_uppercase());
        assert_eq!(LEGACY_ENV_PREFIX, format!("{LEGACY_UPPER}_"));
    }

    #[test]
    fn the_literal_macros_build_the_same_names() {
        assert_eq!(app_env!("TAB_UID"), env_name("TAB_UID"));
        assert_eq!(app_tab_command!("mail"), format!("{TAB_COMMAND_PREFIX}mail__"));
        assert!(GIT_REF_BACKUP.starts_with(GIT_REF_NAMESPACE));
        assert!(INBOX_DIR.starts_with(PROJECT_DIR));
        assert_eq!(mail_label("field"), format!("{SLUG}/mail/v1/field").into_bytes());
    }

    /// A pair whose name did not change, as every build before the rename ran.
    const UNCHANGED: Pair = Pair { cur: CURRENT, legacy: CURRENT };

    /// The name changed, so every name moved with it: no dual read looks
    /// twice in one place, and nothing this build writes still carries the
    /// old spelling. (Were the brand unchanged, every pair would be equal.)
    #[test]
    fn every_name_moved_with_the_brand() {
        if !PAIR.renamed() {
            for (name, current, legacy) in Name::ALL {
                assert_eq!(current, legacy, "{name:?}");
            }
            assert_eq!(ENV_PREFIX, LEGACY_ENV_PREFIX);
            return;
        }
        for (name, current, legacy) in Name::ALL {
            assert_ne!(current, legacy, "{name:?}");
            assert!(!current.to_lowercase().contains(LEGACY_SLUG), "{name:?} still spells the old name: {current}");
            assert_eq!(PAIR.legacy(*name).as_deref(), Some(*legacy), "{name:?}");
        }
        assert_ne!(ENV_PREFIX, LEGACY_ENV_PREFIX);
        assert_eq!(PAIR.legacy_env_name("TAB_UID"), Some(LEGACY.env_name("TAB_UID")));
    }

    /// An unchanged pair has no old spelling for anything: a dual read
    /// written `if let Some(old) = pair.legacy(..)` then looks once.
    #[test]
    fn an_unchanged_pair_has_no_old_spelling() {
        assert!(!UNCHANGED.renamed());
        for (name, _, _) in Name::ALL {
            assert_eq!(UNCHANGED.legacy(*name), None, "{name:?}");
        }
        assert_eq!(UNCHANGED.legacy_env_name("TAB_UID"), None);
    }

    /// The pinned ids are inputs of ids that are stored or already handed
    /// out. They follow no rename: these are the values, for good.
    #[test]
    fn the_pinned_ids_never_follow_the_name() {
        assert_eq!(PINNED_GATEWAY_ID_CONTEXT, "eldrun-gateway:");
        assert_eq!(PINNED_SUBAGENT_TOKEN_CONTEXT, "eldrun-subagent:");
    }

    /// The old names, spelled out. These are what existing installs have on
    /// disk, in keyrings and in other programs' configs, so a slip in a
    /// pattern above would orphan data; this is the one place they are literal.
    #[test]
    fn legacy_names_are_exactly_what_older_builds_wrote() {
        let expected: &[(&str, &str)] = &[
            (LEGACY_STATE_DIR_NAME, "eldrun"),
            (LEGACY_HOME_DIR_NAME, "eldrun"),
            (LEGACY_APP_IDENTIFIER, "io.github.fseiffarth.eldrun"),
            (LEGACY_BIN_NAME, "eldrun"),
            (LEGACY_DEV_BIN_NAME, "eldrun-dev"),
            (LEGACY_FROZEN_RECORD_NAME, "eldrun.frozen"),
            (LEGACY_DEV_LAUNCHER_SCRIPT, "start-eldrun-dev-build.sh"),
            (LEGACY_WM_CLASS, "Eldrun"),
            (LEGACY_WM_CLASS_HIDDEN, "Eldrun-Hidden"),
            (LEGACY_PROJECT_DIR, ".eldrun"),
            (LEGACY_PROJECT_DIR_EXCLUDE_RULE, ".eldrun/"),
            (LEGACY_INBOX_DIR, ".eldrun/inbox"),
            (LEGACY_OUTBOX_DIR, ".eldrun/outbox"),
            (LEGACY_WORKTREES_DIR, ".eldrun/worktrees"),
            (LEGACY_SCREENSHOTS_DIR, "eldrun-screenshots"),
            (LEGACY_EMAILS_DIR, "eldrun-emails"),
            (LEGACY_WORKER_BUNDLE, ".eldrun-worker.bundle"),
            (LEGACY_LOCKSTEP_BUNDLE, "eldrun-lockstep.bundle"),
            (LEGACY_BOX_LINKS_MANIFEST, ".eldrun-box-links.json"),
            (LEGACY_BOX_LINKS_START, "<!-- eldrun:box-links:start -->"),
            (LEGACY_BOX_LINKS_END, "<!-- eldrun:box-links:end -->"),
            (LEGACY_EXPORT_MANIFEST, "eldrun-export.json"),
            (LEGACY_EXPORT_EXTENSION, "eldrunproj"),
            (LEGACY_GIT_REF_NAMESPACE, "refs/eldrun"),
            (LEGACY_GIT_REF_BACKUP, "refs/eldrun/backup"),
            (LEGACY_GIT_REF_PEER, "refs/eldrun/peer"),
            (LEGACY_GIT_REF_INCOMING, "refs/eldrun/incoming"),
            (LEGACY_AGENT_HOME_MARKER, ".eldrun-home"),
            (LEGACY_AGENT_GLOBAL_MANIFEST, ".eldrun-global.json"),
            (LEGACY_AGENT_GLOBAL_BACKUP_DIR, ".eldrun-global-backup"),
            (LEGACY_SESSION_HOOK_SH, "eldrun_session_start.sh"),
            (LEGACY_SESSION_HOOK_PS1, "eldrun_session_start.ps1"),
            (LEGACY_AGENT_HINT_SH, "eldrun_agent_hint.sh"),
            (LEGACY_AGENT_HINT_PS1, "eldrun_agent_hint.ps1"),
            (LEGACY_AGENT_HINT_MD, "eldrun_agent_hint.md"),
            (LEGACY_COPILOT_HINT_HOOKS, ".copilot/hooks/eldrun-hint.json"),
            (LEGACY_AGENT_HINT_START, "<!-- eldrun:agent-hint:start -->"),
            (LEGACY_AGENT_HINT_END, "<!-- eldrun:agent-hint:end -->"),
            (LEGACY_VIBE_SESSION_HOOK, "eldrun-session"),
            (LEGACY_SEND_CLI, "eldrun-send"),
            (LEGACY_MCP_SERVER, "eldrun"),
            (LEGACY_MCP_GIT_SERVER, "eldrun-git"),
            (LEGACY_MCP_HELP_SERVER, "eldrun-help"),
            (LEGACY_MCP_SCHEDULE_SERVER, "eldrun-schedule"),
            (LEGACY_HELP_TOOL_SEARCH, "eldrun_help_search"),
            (LEGACY_HELP_TOOL_READ, "eldrun_help_read"),
            (LEGACY_HELP_TOOL_TOPICS, "eldrun_help_topics"),
            (LEGACY_HELP_TOOL_STATUS, "eldrun_help_status"),
            (LEGACY_MOBILE_HOST_KEY, "eldrun_mobile_host"),
            (LEGACY_MOBILE_ACCESS_KEY, "eldrun_mobile_access"),
            (LEGACY_TAB_COMMAND_PREFIX, "__eldrun_"),
            (LEGACY_APP_TIMER_ID, "__eldrun__"),
            (LEGACY_KEYRING_REMOTE, "eldrun-remote"),
            (LEGACY_KEYRING_GIT_HOSTING, "eldrun-git-hosting"),
            (LEGACY_MOBILE_FILES_SALT, "eldrun-mobile-files"),
            (LEGACY_MAIL_LABEL_ROOT, "eldrun/mail/v1/"),
            (LEGACY_MAIL_WRAP_AAD, "eldrun/mail/v1/master"),
            (LEGACY_MOBILE_HOST_BIN, "eldrun-mobile-host"),
            (LEGACY_MOBILE_HOST_EXE, "eldrun-mobile-host.exe"),
            (LEGACY_MOBILE_HOST_UNIT, "eldrun-mobile-host.service"),
            (LEGACY_MOBILE_HOST_LAUNCHD_LABEL, "io.github.fseiffarth.eldrun.mobile-host"),
            (LEGACY_MOBILE_HOST_RUN_VALUE, "EldrunMobileHost"),
            (LEGACY_TERMINAL_PROTOCOL, "eldrun-terminal.v1"),
            (LEGACY_SESSION_COOKIE, "__Host-eldrun_session"),
            (LEGACY_MOBILE_AUTH_CONTEXT, "eldrun-mobile-auth-v1"),
            (LEGACY_CONTROL_PIPE_PREFIX, "eldrun-control-"),
            (LEGACY_TMUX_PREFIX, "eldrun-"),
            (LEGACY_CONTAINER_PREFIX, "eldrun-"),
            (LEGACY_SANDBOX_IMAGE, "eldrun-agent-sandbox:latest"),
            (LEGACY_DOCKER_OWNER_LABEL, "eldrun.owner=eldrun"),
            (LEGACY_DOCKER_PROJECT_LABEL, "eldrun.project"),
            (LEGACY_DOCKER_SPEC_LABEL, "eldrun.spec"),
            (LEGACY_VM_NAME, "eldrun-vm"),
            (LEGACY_VM_USER, "eldrun"),
            (LEGACY_VM_PROJECT_DIR, "/home/eldrun/project"),
            (LEGACY_VM_INSTANCE_ID_PREFIX, "eldrun-"),
            (LEGACY_VM_BASE_IMAGE_PREFIX, "eldrun-base-"),
            (LEGACY_OLLAMA_IGPU_DROPIN, "eldrun-igpu.conf"),
            (LEGACY_OLLAMA_MODELS_DROPIN, "eldrun-models.conf"),
            (LEGACY_FILE_PATH_HEADER, "x-eldrun-path"),
            (LEGACY_FILE_PROJECT_HEADER, "x-eldrun-project"),
            (LEGACY_FILE_DRAG_ENDED_EVENT, "eldrun:file-drag-ended"),
            (LEGACY_MOBILE_DESKTOP_EVENT, "eldrun-mobile-desktop-request"),
            (LEGACY_TRUST_REQUIRED_PREFIX, "eldrun-trust-required:"),
            (LEGACY_NATIVE_PRINT_UNSUPPORTED, "eldrun-native-print-unsupported"),
        ];
        for (actual, literal) in expected {
            assert_eq!(actual, literal);
        }
        assert_eq!(LEGACY_ENV_PREFIX, "ELDRUN_");
    }

    /// The runtime spelling of every name is the constant: the migrator and
    /// the dual reads build names from a [`Pair`], the rest of the code reads
    /// the constants, and the two must never drift.
    #[test]
    fn a_name_built_at_runtime_is_its_constant() {
        for (name, current, legacy) in Name::ALL {
            assert_eq!(CURRENT.name(*name), *current, "{name:?}");
            assert_eq!(LEGACY.name(*name), *legacy, "{name:?}");
            assert_eq!(PAIR.cur(*name), *current);
            assert_eq!(PAIR.legacy(*name), (current != legacy).then(|| legacy.to_string()));
        }
        assert_eq!(CURRENT.env_prefix(), ENV_PREFIX);
        assert_eq!(LEGACY.env_prefix(), LEGACY_ENV_PREFIX);
        assert_eq!(CURRENT.env_name("TAB_UID"), env_name("TAB_UID"));
        assert_eq!(PAIR.renamed(), SLUG != LEGACY_SLUG || DISPLAY != LEGACY_DISPLAY || UPPER != LEGACY_UPPER);
    }

    /// An invented current brand over the real old one.
    const RENAMED: Pair = Pair {
        cur: Forms { display: "Newname", slug: "newname", upper: "NEWNAME" },
        legacy: LEGACY,
    };

    fn env_map(pairs: &[(&str, &str)]) -> std::collections::HashMap<String, String> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    #[test]
    fn a_renamed_pair_has_an_old_spelling_for_every_name() {
        assert!(RENAMED.renamed());
        for (name, _, legacy) in Name::ALL {
            assert_eq!(RENAMED.legacy(*name).as_deref(), Some(*legacy), "{name:?}");
            assert_ne!(RENAMED.cur(*name), *legacy, "{name:?}");
        }
        assert_eq!(RENAMED.cur(Name::PROJECT_DIR), ".newname");
        assert_eq!(RENAMED.cur(Name::MOBILE_HOST_RUN_VALUE), "NewnameMobileHost");
        assert_eq!(RENAMED.cur.env_name("TAB_UID"), "NEWNAME_TAB_UID");
        assert_eq!(RENAMED.legacy_env_name("TAB_UID"), Some(LEGACY.env_name("TAB_UID")));
    }

    #[test]
    fn an_environment_variable_is_read_under_the_current_name_then_the_old_one() {
        let env = env_map(&[
            ("NEWNAME_HOME", "/new"),
            (&LEGACY.env_name("HOME"), "/old"),
            (&LEGACY.env_name("STATE_DIR"), "/old-state"),
            ("NEWNAME_EMPTY", ""),
            (&LEGACY.env_name("EMPTY"), "old-value"),
        ]);
        let lookup = |key: &str| env.get(key).cloned();
        assert_eq!(RENAMED.env_in("HOME", lookup), Some("/new".into()));
        assert_eq!(RENAMED.env_in("STATE_DIR", lookup), Some("/old-state".into()));
        // An empty value counts as unset, under either name.
        assert_eq!(RENAMED.env_in("EMPTY", lookup), Some("old-value".into()));
        assert_eq!(RENAMED.env_in("MISSING", lookup), None);
        // The unchanged pair looks once.
        let mut asked = Vec::new();
        assert_eq!(
            UNCHANGED.env_in("MISSING", |key| {
                asked.push(key.to_string());
                None
            }),
            None
        );
        assert_eq!(asked, [env_name("MISSING")]);
        // The running pair asks for the current name, then the old one.
        let mut asked = Vec::new();
        assert_eq!(
            PAIR.env_in("MISSING", |key| {
                asked.push(key.to_string());
                None
            }),
            None
        );
        if PAIR.renamed() {
            assert_eq!(asked, [env_name("MISSING"), LEGACY.env_name("MISSING")]);
        }
    }

    #[test]
    fn a_saved_environment_moves_to_the_current_prefix() {
        let mut env = env_map(&[
            (&LEGACY.env_name("TAB_UID"), "uid-1"),
            (&LEGACY.env_name("LOCAL_MODEL"), "old-model"),
            ("NEWNAME_LOCAL_MODEL", "new-model"),
            ("PATH", "/bin"),
        ]);
        assert!(RENAMED.adopt_legacy_env(&mut env));
        assert_eq!(
            env,
            env_map(&[("NEWNAME_TAB_UID", "uid-1"), ("NEWNAME_LOCAL_MODEL", "new-model"), ("PATH", "/bin")])
        );
        assert!(!RENAMED.adopt_legacy_env(&mut env));

        // Unchanged pair: the map is not touched.
        let mut env = env_map(&[(&env_name("TAB_UID"), "uid-1")]);
        let before = env.clone();
        assert!(!UNCHANGED.adopt_legacy_env(&mut env));
        UNCHANGED.export_both(&mut env);
        assert_eq!(env, before);
    }

    #[test]
    fn both_names_are_exported() {
        let mut env = env_map(&[
            ("NEWNAME_TAB_UID", "uid-1"),
            ("NEWNAME_SCOPE", "root"),
            ("NEWNAME_ROOT_MCP_TOKEN", "s3cret"),
            ("NEWNAME_GIT_TOKEN", "s3cret"),
            ("PATH", "/bin"),
        ]);
        RENAMED.export_both(&mut env);
        assert_eq!(
            env,
            env_map(&[
                ("NEWNAME_TAB_UID", "uid-1"),
                (&LEGACY.env_name("TAB_UID"), "uid-1"),
                ("NEWNAME_SCOPE", "root"),
                (&LEGACY.env_name("SCOPE"), "root"),
                // A secret is exported under its current name only.
                ("NEWNAME_ROOT_MCP_TOKEN", "s3cret"),
                ("NEWNAME_GIT_TOKEN", "s3cret"),
                ("PATH", "/bin"),
            ])
        );
    }

    /// `name = "…"` of the first `[[bin]]` table in the crate's manifest.
    fn manifest_bin_name() -> String {
        let manifest = include_str!("../Cargo.toml");
        let table = manifest.split("[[bin]]").nth(1).expect("Cargo.toml has a [[bin]] table");
        let line = table
            .lines()
            .take_while(|line| !line.starts_with('['))
            .find(|line| line.trim_start().starts_with("name"))
            .expect("the [[bin]] table names the binary");
        line.split('"').nth(1).expect("a quoted name").to_string()
    }

    /// `BIN_NAME` is what the code looks for under `target/<profile>/` and in
    /// a window manager's process list; cargo names the file from the
    /// manifest. The two are written separately, so hold them together.
    #[test]
    fn the_bin_name_is_the_manifests() {
        assert_eq!(manifest_bin_name(), BIN_NAME);
    }

    /// The dev scripts read the name through `scripts/lib/brand.sh`, which
    /// parses this file and the manifest. Source it and hold every value to
    /// the constants here: a script pointed at the wrong binary or folder
    /// fails without an error. Linux only, like the scripts themselves.
    #[cfg(target_os = "linux")]
    #[test]
    fn the_shell_helper_reads_the_same_names() {
        let helper = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../scripts/lib/brand.sh");
        let script = r#"set -eu
. "$1"
printf '%s\n' "$APP_DISPLAY" "$APP_SLUG" "$APP_UPPER" "$APP_ENV_PREFIX" "$APP_BIN_NAME" "$APP_DEV_BIN_NAME" "$APP_SHARE_DIR" "$APP_LEGACY_SLUG" "$APP_LEGACY_ENV_PREFIX"
export "${APP_ENV_PREFIX}PROBE=set"
app_env PROBE; echo
app_env MISSING fallback; echo
app_export OTHER value
app_env OTHER; echo
"#;
        let output = std::process::Command::new("bash")
            .args(["-c", script, "bash"])
            .arg(&helper)
            .env("HOME", "/home/someone")
            .output()
            .expect("bash runs");
        assert!(
            output.status.success(),
            "brand.sh failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let stdout = String::from_utf8_lossy(&output.stdout);
        let lines: Vec<&str> = stdout.lines().collect();
        let share_dir = format!("/home/someone/.local/share/{STATE_DIR_NAME}");
        assert_eq!(
            lines,
            [
                DISPLAY,
                SLUG,
                UPPER,
                ENV_PREFIX,
                BIN_NAME,
                DEV_BIN_NAME,
                share_dir.as_str(),
                LEGACY_SLUG,
                LEGACY_ENV_PREFIX,
                "set",
                "fallback",
                "value",
            ]
        );
    }
}
