//! Provider API keys for agent CLIs (`docs/api_chat_plan.md`, Part A).
//!
//! A user who pays per token rather than by subscription gives Tabtivity a
//! provider key once (Manage CLIs → API keys). It lives in the OS keychain
//! under `remote_credentials`' service, account `agent-key:<provider>`, and
//! nowhere else: not in `settings.json`, a session dir, a launcher script, an
//! argv, a log, or the phone API. At spawn it is handed to the CLIs the user
//! switched on (`Settings::agent_api_key_clis`), as the environment variable
//! each CLI already reads ([`CLI_KEYS`]). On Linux and macOS the spawn carries
//! it under an app-named carrier ([`CARRIERS`], the only names in
//! `tmux_local::SECRET_ENV`), which `services::agent_exec` turns into the
//! CLI's variable just before the agent runs (Part C, C1); on Windows (no
//! tmux, no fence) it goes in under the CLI's own name.
//!
//! Rules (decisions 3–7 of the plan):
//!
//! - **Off per CLI by default.** Claude prefers `ANTHROPIC_API_KEY` over its
//!   subscription login once approved, so a stored key reaching every CLI
//!   would silently move the user's billing.
//! - **A value the user set wins** — the variable or any alias of it, in the
//!   spawn's environment or Tabtivity's own ([`Provider::aliases`]).
//! - **Local sessions only.** Remote and container spawns never reach the
//!   injection points; local-model tabs ([`is_local_model`]) and CLI
//!   subcommands (sign-in tabs, `claude auth login`) are skipped here.
//! - **The CLI's own prompts stay the CLI's.** Claude asks once per agent home
//!   whether to use a detected key (default *No*); Gemini needs "Use Gemini API
//!   key" picked in its `/auth`. Nothing here answers or pre-writes those.
//! - **The key is the agent's to read.** Anything the agent runs can print its
//!   environment, and a project's CLI config can point the CLI at another
//!   host. That is stated in the settings help, not solved.
//!
//! Every spawn-time read goes through [`inject_env`], which reads the settings
//! first and the keychain only for a CLI the user switched on.

use std::collections::HashMap;

use serde::Serialize;

/// A provider whose key Tabtivity can hold. One key serves every CLI of its
/// provider.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Provider {
    Anthropic,
    OpenAi,
    Gemini,
    Mistral,
}

impl Provider {
    pub const ALL: [Provider; 4] = [
        Provider::Anthropic,
        Provider::OpenAi,
        Provider::Gemini,
        Provider::Mistral,
    ];

    pub fn id(self) -> &'static str {
        match self {
            Provider::Anthropic => "anthropic",
            Provider::OpenAi => "openai",
            Provider::Gemini => "gemini",
            Provider::Mistral => "mistral",
        }
    }

    pub fn from_id(id: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|p| p.id() == id)
    }

    /// The keychain account under `remote_credentials`' service.
    pub fn account(self) -> String {
        format!("agent-key:{}", self.id())
    }

    /// Other variables that already choose this provider's credential: set by
    /// the user, any of them means nothing is injected for this provider.
    pub fn aliases(self) -> &'static [&'static str] {
        match self {
            Provider::Anthropic => &["ANTHROPIC_AUTH_TOKEN"],
            Provider::OpenAi => &[],
            Provider::Gemini => &["GOOGLE_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"],
            Provider::Mistral => &[],
        }
    }
}

pub const ANTHROPIC_ENV: &str = "ANTHROPIC_API_KEY";
pub const OPENAI_ENV: &str = "OPENAI_API_KEY";
pub const GEMINI_ENV: &str = "GEMINI_API_KEY";
pub const MISTRAL_ENV: &str = "MISTRAL_API_KEY";

/// Every variable a CLI ends up with: [`inject_env`] sets it directly on
/// Windows, `agent_exec` from its carrier elsewhere. Never in
/// `tmux_local::SECRET_ENV` — those slots stay set on the user's own tmux
/// server, where a common name would cost their own sessions the variable.
pub const ENV_VARS: &[&str] = &[ANTHROPIC_ENV, OPENAI_ENV, GEMINI_ENV, MISTRAL_ENV];

// The carriers of [`ENV_VARS`], index for index: `agent_exec::CARRIER_PREFIX`
// and the variable's name (a test holds them to it). `SECRET` in the name
// keeps `brand::Pair::export_both` from twinning one under the old prefix.
pub const ANTHROPIC_CARRIER: &str = crate::app_env!("AGENT_SECRET_ANTHROPIC_API_KEY");
pub const OPENAI_CARRIER: &str = crate::app_env!("AGENT_SECRET_OPENAI_API_KEY");
pub const GEMINI_CARRIER: &str = crate::app_env!("AGENT_SECRET_GEMINI_API_KEY");
pub const MISTRAL_CARRIER: &str = crate::app_env!("AGENT_SECRET_MISTRAL_API_KEY");

/// Every variable [`inject_env`] can set on Linux and macOS.
/// `tmux_local::SECRET_ENV` lists the same consts (a test holds the two
/// together), so none rides a tmux argv.
pub const CARRIERS: &[&str] = &[ANTHROPIC_CARRIER, OPENAI_CARRIER, GEMINI_CARRIER, MISTRAL_CARRIER];

/// Whether a key travels under its carrier: everywhere but Windows.
const CARRY: bool = cfg!(unix);

/// The carrier of `var`, one of [`ENV_VARS`].
fn carrier_of(var: &str) -> &'static str {
    ENV_VARS
        .iter()
        .position(|v| *v == var)
        .map(|i| CARRIERS[i])
        .expect("every injected variable has a carrier")
}

/// Which variable each CLI (by registry id) reads for which provider. Codex is
/// absent on purpose: its interactive TUI documents only `codex login
/// --with-api-key` (`CODEX_API_KEY` is for `exec`), so it is not guessed.
const CLI_KEYS: &[(&str, &[(Provider, &str)])] = &[
    ("claude", &[(Provider::Anthropic, ANTHROPIC_ENV)]),
    ("gemini", &[(Provider::Gemini, GEMINI_ENV)]),
    ("vibe", &[(Provider::Mistral, MISTRAL_ENV)]),
    (
        "opencode",
        &[
            (Provider::Anthropic, ANTHROPIC_ENV),
            (Provider::OpenAi, OPENAI_ENV),
            (Provider::Gemini, GEMINI_ENV),
            (Provider::Mistral, MISTRAL_ENV),
        ],
    ),
];

/// Longest key accepted; every provider's is far shorter.
const MAX_KEY_BYTES: usize = 512;

/// The registry id of the CLI `cmd` runs (a bare name, a path, a `.exe`), or
/// `None` for a command the agent registry does not list (`ollama`, a shell).
pub fn cli_of(cmd: &str) -> Option<&'static str> {
    let bin = cmd.rsplit(['/', '\\']).next().unwrap_or(cmd);
    let bin = bin.strip_suffix(".exe").unwrap_or(bin);
    crate::commands::agents::agent_id_for_bin(bin)
}

/// The `(provider, variable)` pairs of CLI `id`; empty for one not in the table.
fn keys_of(id: &str) -> &'static [(Provider, &'static str)] {
    CLI_KEYS
        .iter()
        .find(|(cli, _)| *cli == id)
        .map(|(_, keys)| *keys)
        .unwrap_or(&[])
}

/// Whether a spawn is a local-model tab: one Tabtivity pointed at Ollama. Those
/// can run the real `vibe` (its own `VIBE_HOME`) or `opencode` binary, so the
/// command alone does not say it; the tab's host-bound marker, the model label
/// the frontend sets on every such tab, or Vibe's model alias do.
pub fn is_local_model(opts: &crate::terminal::PtyOptions) -> bool {
    opts.host_bound_uid.is_some()
        || opts.env.contains_key(crate::app_env!("LOCAL_MODEL"))
        || opts.env.contains_key("VIBE_ACTIVE_MODEL")
}

/// A plausible key: non-empty, no whitespace or control characters, bounded.
/// Not a format check — providers change their shapes.
pub fn key_shape_ok(key: &str) -> bool {
    !key.is_empty()
        && key.len() <= MAX_KEY_BYTES
        && !key.chars().any(|c| c.is_whitespace() || c.is_control())
}

/// Store (`Some`) or remove (`None`) `provider`'s key. A locked or missing
/// keyring refuses with `remote_credentials`' own message; there is no
/// file fallback.
pub fn set_key(provider: Provider, key: Option<&str>) -> Result<(), String> {
    if let Some(key) = key {
        if !key_shape_ok(key) {
            return Err("not a usable API key (empty, too long, or contains spaces)".into());
        }
    }
    crate::services::remote_credentials::set(&provider.account(), key)
}

/// Whether a key is stored for `provider`. Reads "no" while the keyring is
/// locked; ask [`status`]'s `readable` before taking that as a fact.
pub fn has_key(provider: Provider) -> bool {
    get_key(provider).is_some()
}

/// The stored key, bounded at 4 s and never prompting (`remote_credentials::get`).
pub fn get_key(provider: Provider) -> Option<String> {
    crate::services::remote_credentials::get(&provider.account()).filter(|k| key_shape_ok(k))
}

fn settings() -> crate::schema::Settings {
    crate::storage::read_json(&crate::storage::state_dir().join("settings.json")).unwrap_or_default()
}

/// The CLIs the user switched on, from `settings.json` — readable in the
/// `--agent-shim` process too, which has no app state.
pub fn enabled_clis() -> Vec<String> {
    settings().agent_api_key_clis.unwrap_or_default()
}

/// Whether CLI `cmd` is in the table and switched on. Settings only, no
/// keychain.
pub fn applies_to(cmd: &str, settings: &crate::schema::Settings) -> bool {
    cli_of(cmd).is_some_and(|id| {
        !keys_of(id).is_empty()
            && settings
                .agent_api_key_clis
                .as_deref()
                .is_some_and(|on| on.iter().any(|c| c == id))
    })
}

/// Whether a local session of `cmd` would start on a stored key: switched on
/// and one of its providers has a key. Reads the keychain only when switched on.
pub fn keyed(cmd: &str, settings: &crate::schema::Settings) -> bool {
    applies_to(cmd, settings)
        && cli_of(cmd).is_some_and(|id| keys_of(id).iter().any(|(p, _)| has_key(*p)))
}

/// Whether the variable or one of its provider's aliases is set, non-empty,
/// in the spawn's environment or (`ambient`) Tabtivity's own.
fn user_set(
    provider: Provider,
    var: &str,
    env: &HashMap<String, String>,
    ambient: &impl Fn(&str) -> bool,
) -> bool {
    std::iter::once(var)
        .chain(provider.aliases().iter().copied())
        .any(|k| env.get(k).is_some_and(|v| !v.is_empty()) || ambient(k))
}

/// The pure core of [`inject_env`]. Nothing for a local-model tab, a CLI
/// subcommand, or a CLI not in `enabled`; otherwise each of the CLI's
/// variables the user did not set gets `get(provider)` when that has a key —
/// under its carrier with `carry`, else under its own name. Returns the
/// names it set.
#[allow(clippy::too_many_arguments)]
pub(crate) fn inject_env_with(
    cmd: &str,
    subcommand: bool,
    local_model: bool,
    enabled: &[String],
    env: &mut HashMap<String, String>,
    carry: bool,
    ambient: impl Fn(&str) -> bool,
    mut get: impl FnMut(Provider) -> Option<String>,
) -> Vec<&'static str> {
    if local_model || subcommand {
        return Vec::new();
    }
    let Some(id) = cli_of(cmd) else {
        return Vec::new();
    };
    if !enabled.iter().any(|c| c == id) {
        return Vec::new();
    }
    let mut set = Vec::new();
    for &(provider, var) in keys_of(id) {
        if user_set(provider, var, env, &ambient) {
            continue;
        }
        if let Some(key) = get(provider).filter(|k| key_shape_ok(k)) {
            let name = if carry { carrier_of(var) } else { var };
            env.insert(name.to_string(), key);
            set.push(name);
        }
    }
    set
}

/// Give a local agent session of `cmd` its stored keys. `subcommand` is
/// `agent_fence::runs_subcommand` of the CLI's own argv, taken before a fence
/// rewrites it. Settings first, so a spawn of a CLI nobody switched on never
/// touches the keyring.
pub fn inject_env(
    cmd: &str,
    subcommand: bool,
    local_model: bool,
    env: &mut HashMap<String, String>,
) -> Vec<&'static str> {
    if local_model || subcommand || cli_of(cmd).is_none_or(|id| keys_of(id).is_empty()) {
        return Vec::new();
    }
    // Nothing is logged: in the `--agent-shim` process stderr is the user's
    // own terminal.
    inject_env_with(
        cmd,
        subcommand,
        local_model,
        &enabled_clis(),
        env,
        CARRY,
        |k| std::env::var_os(k).is_some_and(|v| !v.is_empty()),
        get_key,
    )
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderStatus {
    pub id: &'static str,
    pub saved: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CliStatus {
    /// The CLI's registry id.
    pub id: &'static str,
    pub enabled: bool,
    /// The provider ids it takes a key for.
    pub providers: Vec<&'static str>,
    /// Switched on and at least one of its providers has a key.
    pub ready: bool,
}

/// What Manage CLIs shows. Never a key.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ApiKeyStatus {
    /// The keyring can be read now. While it cannot, every `saved` reads
    /// false, so the panel says "locked" instead of "not saved".
    pub readable: bool,
    pub providers: Vec<ProviderStatus>,
    pub clis: Vec<CliStatus>,
}

/// [`status`] over a given `saved` answer and switched-on list. Pure.
fn status_with(readable: bool, saved: impl Fn(Provider) -> bool, enabled: &[String]) -> ApiKeyStatus {
    let providers: Vec<ProviderStatus> = Provider::ALL
        .into_iter()
        .map(|p| ProviderStatus { id: p.id(), saved: saved(p) })
        .collect();
    let is_saved = |p: Provider| providers.iter().any(|s| s.id == p.id() && s.saved);
    let clis = CLI_KEYS
        .iter()
        .map(|&(id, keys)| {
            let enabled = enabled.iter().any(|c| c == id);
            CliStatus {
                id,
                enabled,
                providers: keys.iter().map(|(p, _)| p.id()).collect(),
                ready: enabled && keys.iter().any(|(p, _)| is_saved(*p)),
            }
        })
        .collect();
    ApiKeyStatus { readable, providers, clis }
}

/// The CLIs that start on a stored key now: switched on, with a key saved for
/// one of their providers. Reads the keychain only for providers of a
/// switched-on CLI, so with nothing switched on it never touches it.
pub fn ready_clis() -> Vec<&'static str> {
    ready_clis_with(&enabled_clis(), has_key)
}

fn ready_clis_with(enabled: &[String], has: impl Fn(Provider) -> bool) -> Vec<&'static str> {
    let mut known: HashMap<Provider, bool> = HashMap::new();
    CLI_KEYS
        .iter()
        .filter(|(id, _)| enabled.iter().any(|c| c == id))
        .filter(|(_, keys)| keys.iter().any(|(p, _)| *known.entry(*p).or_insert_with(|| has(*p))))
        .map(|(id, _)| *id)
        .collect()
}

pub fn status() -> ApiKeyStatus {
    status_with(
        crate::services::remote_credentials::store_readable(),
        has_key,
        &enabled_clis(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    // Fake test keys, never a real-looking provider shape.
    const FAKE_ANTHROPIC: &str = "sk-test-anthropic-fake";
    const FAKE_GEMINI: &str = "test-gemini-fake";

    fn on(ids: &[&str]) -> Vec<String> {
        ids.iter().map(|s| s.to_string()).collect()
    }

    fn fake(p: Provider) -> Option<String> {
        match p {
            Provider::Anthropic => Some(FAKE_ANTHROPIC.into()),
            Provider::Gemini => Some(FAKE_GEMINI.into()),
            _ => None,
        }
    }

    fn inject(cmd: &str, enabled: &[&str], env: &mut HashMap<String, String>) -> Vec<&'static str> {
        inject_env_with(cmd, false, false, &on(enabled), env, false, |_| false, fake)
    }

    #[test]
    fn only_a_switched_on_cli_gets_its_key() {
        let mut env = HashMap::new();
        assert!(inject("claude", &[], &mut env).is_empty());
        assert!(inject("claude", &["gemini"], &mut env).is_empty());
        assert!(env.is_empty());
        assert_eq!(inject("claude", &["claude"], &mut env), vec![ANTHROPIC_ENV]);
        assert_eq!(env[ANTHROPIC_ENV], FAKE_ANTHROPIC);
    }

    #[test]
    fn a_value_the_user_set_wins_and_so_does_each_alias() {
        for var in [ANTHROPIC_ENV, "ANTHROPIC_AUTH_TOKEN"] {
            let mut env = HashMap::from([(var.to_string(), "mine".to_string())]);
            assert!(inject("claude", &["claude"], &mut env).is_empty(), "{var}");
            assert_eq!(env.get(ANTHROPIC_ENV).map(String::as_str), (var == ANTHROPIC_ENV).then_some("mine"));
        }
        for var in [GEMINI_ENV, "GOOGLE_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"] {
            let mut env = HashMap::from([(var.to_string(), "mine".to_string())]);
            assert!(inject("gemini", &["gemini"], &mut env).is_empty(), "{var}");
        }
        // Tabtivity's own environment counts too.
        let mut env = HashMap::new();
        let set = inject_env_with("claude", false, false, &on(&["claude"]), &mut env, false, |k| k == ANTHROPIC_ENV, fake);
        assert!(set.is_empty() && env.is_empty());
        // An empty value is not a choice.
        let mut env = HashMap::from([(ANTHROPIC_ENV.to_string(), String::new())]);
        assert_eq!(inject("claude", &["claude"], &mut env), vec![ANTHROPIC_ENV]);
    }

    #[test]
    fn no_stored_key_sets_nothing_and_opencode_takes_every_provider_it_has() {
        let mut env = HashMap::new();
        assert!(inject("vibe", &["vibe"], &mut env).is_empty());
        assert!(env.is_empty());
        let set = inject("opencode", &["opencode"], &mut env);
        assert_eq!(set, vec![ANTHROPIC_ENV, GEMINI_ENV]);
        assert!(!env.contains_key(OPENAI_ENV) && !env.contains_key(MISTRAL_ENV));
    }

    #[test]
    fn paths_and_exe_suffixes_name_the_same_cli() {
        for cmd in ["/usr/local/bin/claude", "claude.exe", r"C:\bin\claude.exe"] {
            let mut env = HashMap::new();
            assert_eq!(inject(cmd, &["claude"], &mut env), vec![ANTHROPIC_ENV], "{cmd}");
        }
        assert_eq!(cli_of("ollama"), None);
        let mut env = HashMap::new();
        assert!(inject("ollama", &["claude", "opencode"], &mut env).is_empty());
        // Codex is not in the table, switched on or not.
        assert!(inject("codex", &["codex"], &mut env).is_empty());
    }

    #[test]
    fn local_model_tabs_and_subcommands_get_nothing() {
        let mut env = HashMap::new();
        let all = on(&["claude", "opencode", "vibe"]);
        assert!(inject_env_with("opencode", false, true, &all, &mut env, true, |_| false, fake).is_empty());
        assert!(inject_env_with("claude", true, false, &all, &mut env, true, |_| false, fake).is_empty());
        assert!(env.is_empty());
        let args = vec!["auth".to_string(), "login".to_string()];
        assert!(crate::services::agent_fence::runs_subcommand(&args));
    }

    #[test]
    fn local_model_spawns_are_recognised_by_marker_label_or_alias() {
        let mut opts: crate::terminal::PtyOptions = serde_json::from_value(serde_json::json!({
            "id": "t", "cmd": "opencode", "args": [], "cwd": "/", "cols": 80, "rows": 24
        }))
        .unwrap();
        assert!(!is_local_model(&opts));
        opts.host_bound_uid = Some("u".into());
        assert!(is_local_model(&opts));
        opts.host_bound_uid = None;
        opts.env.insert(crate::app_env!("LOCAL_MODEL").into(), "gemma".into());
        assert!(is_local_model(&opts));
        opts.env.clear();
        opts.env.insert("VIBE_ACTIVE_MODEL".into(), "gemma".into());
        assert!(is_local_model(&opts));
    }

    #[test]
    fn key_shape() {
        assert!(key_shape_ok(FAKE_ANTHROPIC));
        assert!(!key_shape_ok(""));
        assert!(!key_shape_ok("sk-test fake"));
        assert!(!key_shape_ok("sk-test-fake\n"));
        assert!(!key_shape_ok(&"x".repeat(MAX_KEY_BYTES + 1)));
        let mut env = HashMap::new();
        let set = inject_env_with("claude", false, false, &on(&["claude"]), &mut env, true, |_| false, |_| Some("bad key".into()));
        assert!(set.is_empty() && env.is_empty());
    }

    #[test]
    fn carriers_not_common_names_are_the_tmux_secrets() {
        assert_eq!(CARRIERS.len(), ENV_VARS.len());
        for (carrier, var) in CARRIERS.iter().zip(ENV_VARS) {
            assert_eq!(*carrier, crate::services::agent_exec::carrier_name(var));
            assert_eq!(carrier_of(var), *carrier);
            assert!(crate::services::tmux_local::SECRET_ENV.contains(carrier), "{carrier}");
            // The common name stays off the user's tmux server.
            assert!(!crate::services::tmux_local::SECRET_ENV.contains(var), "{var}");
        }
        for (_, keys) in CLI_KEYS {
            for (_, var) in *keys {
                assert!(ENV_VARS.contains(var), "{var}");
            }
        }
    }

    #[test]
    fn a_carried_key_goes_in_under_its_carrier_and_maps_back() {
        let mut env = HashMap::new();
        let set = inject_env_with("opencode", false, false, &on(&["opencode"]), &mut env, true, |_| false, fake);
        assert_eq!(set, vec![ANTHROPIC_CARRIER, GEMINI_CARRIER]);
        assert!(!env.contains_key(ANTHROPIC_ENV) && !env.contains_key(GEMINI_ENV));
        assert_eq!(env[ANTHROPIC_CARRIER], FAKE_ANTHROPIC);
        // `agent_exec` turns it back into the CLI's own variables.
        let m = crate::services::agent_exec::mapping(
            env.iter().map(|(k, v)| (std::ffi::OsStr::new(k), std::ffi::OsStr::new(v))),
        );
        let mut set: Vec<(String, String)> = m
            .set
            .into_iter()
            .map(|(k, v)| (k.into_string().unwrap(), v.into_string().unwrap()))
            .collect();
        set.sort();
        assert_eq!(
            set,
            vec![
                (ANTHROPIC_ENV.to_string(), FAKE_ANTHROPIC.to_string()),
                (GEMINI_ENV.to_string(), FAKE_GEMINI.to_string()),
            ]
        );
        assert_eq!(m.remove.len(), 2);
        // A value the user set under the CLI's name still wins over a carrier.
        let mut env = HashMap::from([(ANTHROPIC_ENV.to_string(), "mine".to_string())]);
        assert!(inject_env_with("claude", false, false, &on(&["claude"]), &mut env, true, |_| false, fake).is_empty());
        assert!(!env.contains_key(ANTHROPIC_CARRIER));
    }

    #[test]
    fn providers_round_trip_their_ids_and_accounts() {
        for p in Provider::ALL {
            assert_eq!(Provider::from_id(p.id()), Some(p));
            assert_eq!(p.account(), format!("agent-key:{}", p.id()));
        }
        assert_eq!(Provider::from_id("copilot"), None);
    }

    #[test]
    fn status_is_ready_only_for_a_switched_on_cli_with_a_key() {
        let s = status_with(true, |p| p == Provider::Anthropic, &on(&["claude", "vibe"]));
        let cli = |id: &str| s.clis.iter().find(|c| c.id == id).unwrap().clone();
        assert!(cli("claude").ready);
        assert!(!cli("vibe").ready, "on, but no Mistral key");
        assert!(!cli("opencode").ready, "has a key, but off");
        assert_eq!(cli("opencode").providers, vec!["anthropic", "openai", "gemini", "mistral"]);
        assert!(s.providers.iter().any(|p| p.id == "anthropic" && p.saved));
        assert!(!s.clis.iter().any(|c| c.id == "codex"));
        let json = serde_json::to_value(&s).unwrap();
        assert!(json.get("readable").is_some() && json["clis"][0].get("ready").is_some());
    }

    #[test]
    fn ready_clis_ask_the_keychain_only_for_switched_on_clis() {
        let asked = std::cell::RefCell::new(Vec::new());
        let has = |p: Provider| {
            asked.borrow_mut().push(p);
            p == Provider::Anthropic
        };
        assert!(ready_clis_with(&[], has).is_empty());
        assert!(asked.borrow().is_empty(), "nothing switched on, nothing read");
        let ready = ready_clis_with(&on(&["claude", "vibe", "opencode"]), has);
        assert_eq!(ready, vec!["claude", "opencode"]);
        // Each provider read at most once.
        let mut seen = asked.borrow().clone();
        let before = seen.len();
        seen.sort_by_key(|p| p.id());
        seen.dedup();
        assert_eq!(seen.len(), before);
    }

    #[test]
    fn applies_to_reads_only_the_settings() {
        let mut settings = crate::schema::Settings::default();
        assert!(!applies_to("claude", &settings));
        settings.agent_api_key_clis = Some(on(&["claude", "codex"]));
        assert!(applies_to("claude", &settings));
        assert!(applies_to("/opt/bin/claude", &settings));
        assert!(!applies_to("codex", &settings), "not in the table");
        assert!(!applies_to("gemini", &settings));
    }
}
