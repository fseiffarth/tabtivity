//! Provider API keys for agent CLIs (`docs/api_chat_plan.md`, Parts A and C).
//!
//! A user who pays per token rather than by subscription gives Tabtivity a
//! provider key once (Manage CLIs → API keys). It lives in the OS keychain
//! under `remote_credentials`' service, account `agent-key:<provider>`, and
//! nowhere else: not in `settings.json`, a session dir, a launcher script, an
//! argv, a log, the phone API — or an agent process (Part C, C2).
//!
//! A keyed spawn of a CLI the user switched on (`Settings::agent_api_key_clis`)
//! gets a **proxy token** and the CLI's **base-URL variable** instead
//! ([`CLI_ROUTES`]): `services::api_proxy`, a loopback listener inside
//! Tabtivity, swaps the token for the real key and forwards only to the
//! provider's own API host. On Linux and macOS the token travels under an
//! app-named carrier ([`CARRIERS`], the only names in
//! `tmux_local::SECRET_ENV`), which `services::agent_exec` turns into the CLI's
//! variable just before the agent runs (C1); on Windows (no tmux, no fence) it
//! goes in under the CLI's own name. The base URL is not a secret and rides as
//! a plain variable.
//!
//! Rules:
//!
//! - **Only proxyable CLIs.** A CLI is in [`CLI_ROUTES`] only if an environment
//!   variable points it at the proxy (decision 2 of Part C): Claude
//!   (`ANTHROPIC_BASE_URL`) and Gemini (`GOOGLE_GEMINI_BASE_URL`). Mistral
//!   Vibe documents no such variable; OpenCode's only one is a whole inline
//!   config (`OPENCODE_CONFIG_CONTENT`, which Tabtivity already fills with its
//!   Ollama model list). Neither gets a key.
//! - **Off per CLI by default.** A key reaching a CLI moves its billing.
//! - **A value the user set wins** — the CLI's credential or base-URL
//!   variable, or another name for the same provider's credential, in the
//!   spawn's environment or Tabtivity's own ([`Route::user_names`]).
//! - **Local sessions only.** Remote and container spawns never reach the
//!   injection points; local-model tabs ([`is_local_model`]) and CLI
//!   subcommands (sign-in tabs, `claude auth login`) are skipped here. So is a
//!   CLI typed into a shell tab: the `--agent-shim` process runs no proxy.
//! - **The CLI's own prompts stay the CLI's.** Claude takes
//!   `ANTHROPIC_AUTH_TOKEN` without its "Detected a custom API key" dialog
//!   (verified, 2.1.288); Gemini needs "Use Gemini API key" picked in its
//!   `/auth`. Nothing here answers or pre-writes those.
//!
//! Every spawn-time read goes through [`inject_env`], which reads the settings
//! first and the keychain (through `api_proxy`'s cache) only for a CLI the
//! user switched on.

use std::collections::HashMap;

use serde::Serialize;

/// A provider whose key Tabtivity can hold. One key serves every CLI of its
/// provider.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Provider {
    Anthropic,
    Gemini,
}

impl Provider {
    pub const ALL: [Provider; 2] = [Provider::Anthropic, Provider::Gemini];

    pub fn id(self) -> &'static str {
        match self {
            Provider::Anthropic => "anthropic",
            Provider::Gemini => "gemini",
        }
    }

    pub fn from_id(id: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|p| p.id() == id)
    }

    /// The keychain account under `remote_credentials`' service.
    pub fn account(self) -> String {
        format!("agent-key:{}", self.id())
    }

    /// Every variable that already carries this provider's credential: set by
    /// the user, any of them means nothing is injected for this provider.
    pub fn credential_names(self) -> &'static [&'static str] {
        match self {
            Provider::Anthropic => &["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"],
            Provider::Gemini => &["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"],
        }
    }
}

/// Claude's bearer credential: sent as `Authorization: Bearer`, used at once,
/// no approval dialog (`ANTHROPIC_API_KEY` raises one, default *No*, even
/// against a custom base URL — both checked with 2.1.288).
pub const ANTHROPIC_TOKEN_ENV: &str = "ANTHROPIC_AUTH_TOKEN";
pub const ANTHROPIC_BASE_ENV: &str = "ANTHROPIC_BASE_URL";
/// Gemini CLI's key variable; `@google/genai` sends it as `x-goog-api-key`.
pub const GEMINI_TOKEN_ENV: &str = "GEMINI_API_KEY";
/// geminicli.com configuration reference: "Overrides the default base URL for
/// Gemini API requests (when using `gemini-api-key` authentication)".
pub const GEMINI_BASE_ENV: &str = "GOOGLE_GEMINI_BASE_URL";

/// Every variable a token ends up in: [`inject_env`] sets it directly on
/// Windows, `agent_exec` from its carrier elsewhere (these are
/// `agent_exec::targets`). Never in `tmux_local::SECRET_ENV` — those slots
/// stay set on the user's own tmux server, where a common name would cost
/// their own sessions the variable.
pub const ENV_VARS: &[&str] = &[ANTHROPIC_TOKEN_ENV, GEMINI_TOKEN_ENV];

// The carriers of [`ENV_VARS`], index for index: `agent_exec::CARRIER_PREFIX`
// and the variable's name (a test holds them to it). `SECRET` in the name
// keeps `brand::Pair::export_both` from twinning one under the old prefix.
pub const ANTHROPIC_CARRIER: &str = crate::app_env!("AGENT_SECRET_ANTHROPIC_AUTH_TOKEN");
pub const GEMINI_CARRIER: &str = crate::app_env!("AGENT_SECRET_GEMINI_API_KEY");

/// Every variable [`inject_env`] can set a secret under on Linux and macOS.
/// `tmux_local::SECRET_ENV` lists the same consts (a test holds the two
/// together), so none rides a tmux argv.
pub const CARRIERS: &[&str] = &[ANTHROPIC_CARRIER, GEMINI_CARRIER];

/// Whether a token travels under its carrier: everywhere but Windows.
const CARRY: bool = cfg!(unix);

/// The carrier of `var`, one of [`ENV_VARS`].
fn carrier_of(var: &str) -> &'static str {
    ENV_VARS
        .iter()
        .position(|v| *v == var)
        .map(|i| CARRIERS[i])
        .expect("every injected variable has a carrier")
}

/// How one CLI reaches one provider through the proxy.
#[derive(Debug, Clone, Copy)]
pub struct Route {
    pub provider: Provider,
    /// The variable the CLI sends as its credential: the proxy token goes here.
    pub token_var: &'static str,
    /// The variable that points the CLI at another API base URL: the proxy's.
    pub base_var: &'static str,
}

impl Route {
    /// The names that, set by the user, mean this route is theirs: the
    /// provider's credentials and the CLI's base URL.
    fn user_names(&self) -> impl Iterator<Item = &'static str> {
        self.provider.credential_names().iter().copied().chain(std::iter::once(self.base_var))
    }
}

/// The CLIs (by registry id) that take a key through the proxy. Codex is
/// absent (its TUI documents only `codex login --with-api-key`), and so are
/// Mistral Vibe and OpenCode (no environment variable points them at the
/// proxy; see the module docs).
const CLI_ROUTES: &[(&str, &[Route])] = &[
    (
        "claude",
        &[Route { provider: Provider::Anthropic, token_var: ANTHROPIC_TOKEN_ENV, base_var: ANTHROPIC_BASE_ENV }],
    ),
    (
        "gemini",
        &[Route { provider: Provider::Gemini, token_var: GEMINI_TOKEN_ENV, base_var: GEMINI_BASE_ENV }],
    ),
];

/// The base-URL variable that rides beside token carrier `carrier`, and the
/// provider it points at — for a spawn that has to drop the token again
/// (tmux < 3.2) and must not leave the CLI pointed at a proxy it holds no
/// token for.
pub fn base_of_carrier(carrier: &str) -> Option<(&'static str, Provider)> {
    CLI_ROUTES
        .iter()
        .flat_map(|(_, routes)| routes.iter())
        .find(|r| carrier_of(r.token_var) == carrier)
        .map(|r| (r.base_var, r.provider))
}

/// Longest key accepted; every provider's is far shorter.
const MAX_KEY_BYTES: usize = 512;

/// The registry id of the CLI `cmd` runs (a bare name, a path, a `.exe`), or
/// `None` for a command the agent registry does not list (`ollama`, a shell).
pub fn cli_of(cmd: &str) -> Option<&'static str> {
    let bin = cmd.rsplit(['/', '\\']).next().unwrap_or(cmd);
    let bin = bin.strip_suffix(".exe").unwrap_or(bin);
    crate::commands::agents::agent_id_for_bin(bin)
}

/// The routes of CLI `id`; empty for one not in the table.
fn routes_of(id: &str) -> &'static [Route] {
    CLI_ROUTES
        .iter()
        .find(|(cli, _)| *cli == id)
        .map(|(_, routes)| *routes)
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
    let saved = crate::services::remote_credentials::set(&provider.account(), key);
    // Saved or not, the proxy reads the keychain again at its next use: a
    // removed key stops running keyed tabs at their next request.
    crate::services::api_proxy::forget_key(provider);
    saved
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
        !routes_of(id).is_empty()
            && settings
                .agent_api_key_clis
                .as_deref()
                .is_some_and(|on| on.iter().any(|c| c == id))
    })
}

/// Whether a local session of `cmd` would start on the proxy: switched on, the
/// proxy running in this process, and one of its providers keyed. Reads the
/// keychain (once, then `api_proxy`'s cache) only when switched on.
pub fn keyed(cmd: &str, settings: &crate::schema::Settings) -> bool {
    applies_to(cmd, settings)
        && crate::services::api_proxy::running()
        && cli_of(cmd).is_some_and(|id| {
            routes_of(id).iter().any(|r| crate::services::api_proxy::key_for(r.provider).is_some())
        })
}

/// Whether one of the route's user names is set, non-empty, in the spawn's
/// environment or (`ambient`) Tabtivity's own.
fn user_set(route: &Route, env: &HashMap<String, String>, ambient: &impl Fn(&str) -> bool) -> bool {
    route
        .user_names()
        .any(|k| env.get(k).is_some_and(|v| !v.is_empty()) || ambient(k))
}

/// Where a spawn's grants are bound (`api_proxy::Grant`).
#[derive(Debug, Clone, Copy)]
pub struct Binding<'a> {
    /// The PTY id.
    pub tab: &'a str,
    /// The agent home's scope.
    pub scope: &'a str,
    /// The local tmux session the agent will run in, if any.
    pub tmux: Option<&'a str>,
}

/// The pure core of [`inject_env`]. Nothing for a local-model tab, a CLI
/// subcommand, or a CLI not in `enabled`; otherwise each of the CLI's routes
/// the user did not set gets `grant(provider)` — a proxy token and base URL —
/// when that has one: the token under its carrier with `carry`, else under
/// the CLI's own name, the base URL under the CLI's variable. Returns the
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
    mut grant: impl FnMut(Provider) -> Option<(String, String)>,
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
    for route in routes_of(id) {
        if user_set(route, env, &ambient) {
            continue;
        }
        if let Some((token, base)) = grant(route.provider) {
            let name = if carry { carrier_of(route.token_var) } else { route.token_var };
            env.insert(name.to_string(), token);
            env.insert(route.base_var.to_string(), base);
            set.push(name);
            set.push(route.base_var);
        }
    }
    set
}

/// Point a local agent session of `cmd` at the proxy for its keyed providers.
/// `subcommand` is `agent_fence::runs_subcommand` of the CLI's own argv, taken
/// before a fence rewrites it. Settings first, so a spawn of a CLI nobody
/// switched on never touches the keyring; nothing at all where the proxy is
/// not running (the `--agent-shim` process).
pub fn inject_env(
    cmd: &str,
    subcommand: bool,
    local_model: bool,
    binding: Binding<'_>,
    env: &mut HashMap<String, String>,
) -> Vec<&'static str> {
    if local_model
        || subcommand
        || !crate::services::api_proxy::running()
        || cli_of(cmd).is_none_or(|id| routes_of(id).is_empty())
    {
        return Vec::new();
    }
    // Nothing is logged: in the `--agent-shim` process stderr is the user's
    // own terminal, and a token is a secret too.
    inject_env_with(
        cmd,
        subcommand,
        local_model,
        &enabled_clis(),
        env,
        CARRY,
        |k| std::env::var_os(k).is_some_and(|v| !v.is_empty()),
        |provider| crate::services::api_proxy::issue(provider, binding.scope, binding.tab, binding.tmux),
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
    let clis = CLI_ROUTES
        .iter()
        .map(|&(id, routes)| {
            let enabled = enabled.iter().any(|c| c == id);
            CliStatus {
                id,
                enabled,
                providers: routes.iter().map(|r| r.provider.id()).collect(),
                ready: enabled && routes.iter().any(|r| is_saved(r.provider)),
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
    CLI_ROUTES
        .iter()
        .filter(|(id, _)| enabled.iter().any(|c| c == id))
        .filter(|(_, routes)| routes.iter().any(|r| *known.entry(r.provider).or_insert_with(|| has(r.provider))))
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

    // Fake test tokens, never a real-looking provider shape.
    const FAKE_TOKEN: &str = "test-proxy-token-fake";
    const BASE: &str = "http://127.0.0.1:9/";

    fn on(ids: &[&str]) -> Vec<String> {
        ids.iter().map(|s| s.to_string()).collect()
    }

    /// The proxy's answer for a keyed provider: Anthropic and Gemini both.
    fn proxied(p: Provider) -> Option<(String, String)> {
        Some((format!("{FAKE_TOKEN}-{}", p.id()), format!("{BASE}{}", p.id())))
    }

    fn inject(cmd: &str, enabled: &[&str], env: &mut HashMap<String, String>) -> Vec<&'static str> {
        inject_env_with(cmd, false, false, &on(enabled), env, false, |_| false, proxied)
    }

    #[test]
    fn only_a_switched_on_cli_gets_a_token_and_the_proxy_url() {
        let mut env = HashMap::new();
        assert!(inject("claude", &[], &mut env).is_empty());
        assert!(inject("claude", &["gemini"], &mut env).is_empty());
        assert!(env.is_empty());
        assert_eq!(inject("claude", &["claude"], &mut env), vec![ANTHROPIC_TOKEN_ENV, ANTHROPIC_BASE_ENV]);
        assert_eq!(env[ANTHROPIC_TOKEN_ENV], "test-proxy-token-fake-anthropic");
        assert_eq!(env[ANTHROPIC_BASE_ENV], "http://127.0.0.1:9/anthropic");
        // Never the CLI's API-key name: that one raises Claude's dialog.
        assert!(!env.contains_key("ANTHROPIC_API_KEY"));
        let mut env = HashMap::new();
        assert_eq!(inject("gemini", &["gemini"], &mut env), vec![GEMINI_TOKEN_ENV, GEMINI_BASE_ENV]);
        assert_eq!(env[GEMINI_BASE_ENV], "http://127.0.0.1:9/gemini");
    }

    #[test]
    fn a_value_the_user_set_wins_credential_or_base_url() {
        for var in ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"] {
            let mut env = HashMap::from([(var.to_string(), "mine".to_string())]);
            assert!(inject("claude", &["claude"], &mut env).is_empty(), "{var}");
            assert_eq!(env.len(), 1, "{var}");
        }
        for var in [GEMINI_TOKEN_ENV, "GOOGLE_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", GEMINI_BASE_ENV] {
            let mut env = HashMap::from([(var.to_string(), "mine".to_string())]);
            assert!(inject("gemini", &["gemini"], &mut env).is_empty(), "{var}");
        }
        // Tabtivity's own environment counts too.
        let mut env = HashMap::new();
        let set = inject_env_with("claude", false, false, &on(&["claude"]), &mut env, false, |k| k == ANTHROPIC_BASE_ENV, proxied);
        assert!(set.is_empty() && env.is_empty());
        // An empty value is not a choice.
        let mut env = HashMap::from([(ANTHROPIC_TOKEN_ENV.to_string(), String::new())]);
        assert_eq!(inject("claude", &["claude"], &mut env), vec![ANTHROPIC_TOKEN_ENV, ANTHROPIC_BASE_ENV]);
    }

    #[test]
    fn no_grant_sets_nothing() {
        let mut env = HashMap::new();
        let set = inject_env_with("claude", false, false, &on(&["claude"]), &mut env, true, |_| false, |_| None);
        assert!(set.is_empty() && env.is_empty());
    }

    #[test]
    fn paths_and_exe_suffixes_name_the_same_cli() {
        for cmd in ["/usr/local/bin/claude", "claude.exe", r"C:\bin\claude.exe"] {
            let mut env = HashMap::new();
            assert_eq!(inject(cmd, &["claude"], &mut env), vec![ANTHROPIC_TOKEN_ENV, ANTHROPIC_BASE_ENV], "{cmd}");
        }
        assert_eq!(cli_of("ollama"), None);
        let mut env = HashMap::new();
        assert!(inject("ollama", &["claude", "gemini"], &mut env).is_empty());
        // Not in the table, switched on or not: no variable points them at
        // the proxy.
        for cli in ["codex", "vibe", "opencode"] {
            assert!(inject(cli, &[cli], &mut env).is_empty(), "{cli}");
        }
        assert!(env.is_empty());
    }

    #[test]
    fn local_model_tabs_and_subcommands_get_nothing() {
        let mut env = HashMap::new();
        let all = on(&["claude", "gemini"]);
        assert!(inject_env_with("claude", false, true, &all, &mut env, true, |_| false, proxied).is_empty());
        assert!(inject_env_with("claude", true, false, &all, &mut env, true, |_| false, proxied).is_empty());
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
        assert!(key_shape_ok("sk-test-anthropic-fake"));
        assert!(!key_shape_ok(""));
        assert!(!key_shape_ok("sk-test fake"));
        assert!(!key_shape_ok("sk-test-fake\n"));
        assert!(!key_shape_ok(&"x".repeat(MAX_KEY_BYTES + 1)));
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
        for (_, routes) in CLI_ROUTES {
            for route in *routes {
                assert!(ENV_VARS.contains(&route.token_var), "{}", route.token_var);
                // The base URL is no secret and is no carrier target either.
                assert!(!ENV_VARS.contains(&route.base_var));
            }
        }
    }

    #[test]
    fn a_carried_token_goes_in_under_its_carrier_and_maps_back() {
        let mut env = HashMap::new();
        let set = inject_env_with("claude", false, false, &on(&["claude"]), &mut env, true, |_| false, proxied);
        assert_eq!(set, vec![ANTHROPIC_CARRIER, ANTHROPIC_BASE_ENV]);
        assert!(!env.contains_key(ANTHROPIC_TOKEN_ENV));
        assert_eq!(env[ANTHROPIC_CARRIER], "test-proxy-token-fake-anthropic");
        // The base URL rides plain.
        assert_eq!(env[ANTHROPIC_BASE_ENV], "http://127.0.0.1:9/anthropic");
        // `agent_exec` turns the carrier back into the CLI's own variable.
        let m = crate::services::agent_exec::mapping(
            env.iter().map(|(k, v)| (std::ffi::OsStr::new(k), std::ffi::OsStr::new(v))),
        );
        let set: Vec<(String, String)> = m
            .set
            .into_iter()
            .map(|(k, v)| (k.into_string().unwrap(), v.into_string().unwrap()))
            .collect();
        assert_eq!(set, vec![(ANTHROPIC_TOKEN_ENV.to_string(), "test-proxy-token-fake-anthropic".to_string())]);
        assert_eq!(m.remove.len(), 1);
        // A value the user set under the CLI's name still wins over a carrier.
        let mut env = HashMap::from([("ANTHROPIC_API_KEY".to_string(), "mine".to_string())]);
        assert!(inject_env_with("claude", false, false, &on(&["claude"]), &mut env, true, |_| false, proxied).is_empty());
        assert!(!env.contains_key(ANTHROPIC_CARRIER));
    }

    #[test]
    fn without_a_running_proxy_nothing_is_injected() {
        // The test binary never starts the listener, as the `--agent-shim`
        // process never does.
        assert!(!crate::services::api_proxy::running());
        let mut env = HashMap::new();
        let binding = Binding { tab: "t", scope: "s", tmux: None };
        assert!(inject_env("claude", false, false, binding, &mut env).is_empty());
        assert!(env.is_empty());
    }

    #[test]
    fn providers_round_trip_their_ids_and_accounts() {
        for p in Provider::ALL {
            assert_eq!(Provider::from_id(p.id()), Some(p));
            assert_eq!(p.account(), format!("agent-key:{}", p.id()));
        }
        assert_eq!(Provider::from_id("copilot"), None);
        assert_eq!(Provider::from_id("openai"), None);
        assert_eq!(Provider::from_id("mistral"), None);
    }

    #[test]
    fn status_is_ready_only_for_a_switched_on_cli_with_a_key() {
        let s = status_with(true, |p| p == Provider::Anthropic, &on(&["claude", "gemini"]));
        let cli = |id: &str| s.clis.iter().find(|c| c.id == id).unwrap().clone();
        assert!(cli("claude").ready);
        assert!(!cli("gemini").ready, "on, but no Gemini key");
        assert_eq!(cli("claude").providers, vec!["anthropic"]);
        assert!(s.providers.iter().any(|p| p.id == "anthropic" && p.saved));
        for gone in ["codex", "vibe", "opencode"] {
            assert!(!s.clis.iter().any(|c| c.id == gone), "{gone}");
        }
        assert_eq!(s.providers.len(), 2);
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
        let ready = ready_clis_with(&on(&["claude", "gemini", "vibe"]), has);
        assert_eq!(ready, vec!["claude"]);
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
        settings.agent_api_key_clis = Some(on(&["claude", "codex", "vibe"]));
        assert!(applies_to("claude", &settings));
        assert!(applies_to("/opt/bin/claude", &settings));
        assert!(!applies_to("codex", &settings), "not in the table");
        assert!(!applies_to("vibe", &settings), "dropped: no proxy route");
        assert!(!applies_to("gemini", &settings));
    }
}
