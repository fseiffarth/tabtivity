//! Provider API keys for agent CLIs (`docs/api_chat_plan.md`, Parts A and C).
//!
//! A user who pays per token rather than by subscription gives Tabtivity a
//! provider key once (Manage CLIs → API keys). It lives in the OS keychain
//! under `remote_credentials`' service, account `agent-key:<provider>` (an
//! Anthropic key that is not scoped to a workspace keeps the one its requests
//! name beside it, `agent-key:anthropic:workspace`), and nowhere else: not in `settings.json`, a session dir, a launcher script, an
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
//! - **Only proxyable CLIs.** A CLI is in [`CLI_ROUTES`] only if the spawn
//!   alone can point it at the proxy (decision 2 of Part C): Claude
//!   (`ANTHROPIC_BASE_URL`), Gemini (`GOOGLE_GEMINI_BASE_URL`), Codex
//!   (launch-only custom provider, `OPENAI_BASE_URL`) and OpenCode (all three
//!   providers, in its inline config `OPENCODE_CONFIG_CONTENT` merged over
//!   the Ollama models Tabtivity puts there, the token read from the
//!   environment: [`route_opencode`]). Mistral Vibe documents no such
//!   variable and gets no key.
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
    OpenAi,
}

impl Provider {
    pub const ALL: [Provider; 3] = [Provider::Anthropic, Provider::Gemini, Provider::OpenAi];

    pub fn id(self) -> &'static str {
        match self {
            Provider::Anthropic => "anthropic",
            Provider::Gemini => "gemini",
            Provider::OpenAi => "openai",
        }
    }

    pub fn from_id(id: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|p| p.id() == id)
    }

    /// The keychain account under `remote_credentials`' service.
    pub fn account(self) -> String {
        format!("agent-key:{}", self.id())
    }

    /// The keychain account of the workspace an Anthropic key that is not
    /// scoped to one names on every request (`anthropic-workspace-id`),
    /// chosen when the key was saved. Kept and removed with the key.
    pub fn workspace_account(self) -> String {
        format!("agent-key:{}:workspace", self.id())
    }

    /// Every variable that already carries this provider's credential: set by
    /// the user, any of them means nothing is injected for this provider.
    pub fn credential_names(self) -> &'static [&'static str] {
        match self {
            Provider::Anthropic => &["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"],
            Provider::Gemini => &["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"],
            Provider::OpenAi => &["OPENAI_API_KEY", "CODEX_API_KEY"],
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
pub const OPENAI_TOKEN_ENV: &str = "OPENAI_API_KEY";
pub const OPENAI_BASE_ENV: &str = "OPENAI_BASE_URL";

/// Every variable a token ends up in: [`inject_env`] sets it directly on
/// Windows, `agent_exec` from its carrier elsewhere (these are
/// `agent_exec::targets`). Never in `tmux_local::SECRET_ENV` — those slots
/// stay set on the user's own tmux server, where a common name would cost
/// their own sessions the variable.
pub const ENV_VARS: &[&str] = &[ANTHROPIC_TOKEN_ENV, GEMINI_TOKEN_ENV, OPENAI_TOKEN_ENV];

// The carriers of [`ENV_VARS`], index for index: `agent_exec::CARRIER_PREFIX`
// and the variable's name (a test holds them to it). `SECRET` in the name
// keeps `brand::Pair::export_both` from twinning one under the old prefix.
pub const ANTHROPIC_CARRIER: &str = crate::app_env!("AGENT_SECRET_ANTHROPIC_AUTH_TOKEN");
pub const GEMINI_CARRIER: &str = crate::app_env!("AGENT_SECRET_GEMINI_API_KEY");
pub const OPENAI_CARRIER: &str = crate::app_env!("AGENT_SECRET_OPENAI_API_KEY");

/// Every variable [`inject_env`] can set a secret under on Linux and macOS.
/// `tmux_local::SECRET_ENV` lists the same consts (a test holds the two
/// together), so none rides a tmux argv.
pub const CARRIERS: &[&str] = &[ANTHROPIC_CARRIER, GEMINI_CARRIER, OPENAI_CARRIER];

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

/// The CLIs (by registry id) that take a key through the proxy. Codex also
/// gets a launch-only custom provider so a stored ChatGPT login cannot win.
const CLI_ROUTES: &[(&str, &[Route])] = &[
    (
        "claude",
        &[Route { provider: Provider::Anthropic, token_var: ANTHROPIC_TOKEN_ENV, base_var: ANTHROPIC_BASE_ENV }],
    ),
    (
        "gemini",
        &[Route { provider: Provider::Gemini, token_var: GEMINI_TOKEN_ENV, base_var: GEMINI_BASE_ENV }],
    ),
    (
        "codex",
        &[Route { provider: Provider::OpenAi, token_var: OPENAI_TOKEN_ENV, base_var: OPENAI_BASE_ENV }],
    ),
    // The same variables as the CLIs above, so a user's own key or base URL
    // for a provider still wins; OpenCode reads the base URLs and tokens off
    // its inline config ([`route_opencode`]), not these names.
    (
        "opencode",
        &[
            Route { provider: Provider::Anthropic, token_var: ANTHROPIC_TOKEN_ENV, base_var: ANTHROPIC_BASE_ENV },
            Route { provider: Provider::Gemini, token_var: GEMINI_TOKEN_ENV, base_var: GEMINI_BASE_ENV },
            Route { provider: Provider::OpenAi, token_var: OPENAI_TOKEN_ENV, base_var: OPENAI_BASE_ENV },
        ],
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
    crate::services::agent_registry::agent_id_for_bin(bin)
}

/// Whether the proxy serves CLI `id` (registry id) at all — what an API key,
/// the user's own or a server administrator's, can run (#2389).
pub fn proxies(id: &str) -> bool {
    !routes_of(id).is_empty()
}

/// Every variable that carries a provider credential, by any provider: a
/// value under one of these never rides an argv (`sandbox`'s `docker exec`).
pub fn credential_names() -> impl Iterator<Item = &'static str> {
    Provider::ALL.into_iter().flat_map(|p| p.credential_names().iter().copied())
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

/// Whether `id` looks like an Anthropic workspace id (`wrkspc_` and an
/// alphanumeric tail): the only thing ever sent as `anthropic-workspace-id`.
pub fn workspace_shape_ok(id: &str) -> bool {
    id.strip_prefix("wrkspc_")
        .is_some_and(|tail| !tail.is_empty() && tail.len() <= 64 && tail.chars().all(|c| c.is_ascii_alphanumeric()))
}

/// Store (`Some`) or remove (`None`) `provider`'s key, with the workspace it
/// names on every request (`Some` only for a key that is not scoped to one;
/// a stored workspace without one is removed). A locked or missing keyring
/// refuses with `remote_credentials`' own message; there is no file
/// fallback.
pub fn set_key(provider: Provider, key: Option<&str>, workspace: Option<&str>) -> Result<(), String> {
    if let Some(key) = key {
        if !key_shape_ok(key) {
            return Err("not a usable API key (empty, too long, or contains spaces)".into());
        }
    }
    if workspace.is_some_and(|w| !workspace_shape_ok(w)) {
        return Err("not a workspace id (it starts with wrkspc_)".into());
    }
    let saved = crate::services::remote_credentials::set(&provider.account(), key).and_then(|()| {
        crate::services::remote_credentials::set(&provider.workspace_account(), workspace.filter(|_| key.is_some()))
    });
    // Saved or not, the proxy reads the keychain again at its next use: a
    // removed key stops running keyed tabs at their next request.
    crate::services::api_proxy::forget_key(provider);
    // What OpenCode's picker hides was the old key's: list the new one's.
    crate::services::opencode_models::forget(provider);
    if saved.is_ok() && key.is_some() {
        crate::services::opencode_models::refresh(vec![provider]);
    }
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

/// The workspace stored beside `provider`'s key ([`set_key`]), if any.
pub fn get_workspace(provider: Provider) -> Option<String> {
    if provider != Provider::Anthropic {
        return None;
    }
    crate::services::remote_credentials::get(&provider.workspace_account()).filter(|w| workspace_shape_ok(w))
}

fn settings() -> crate::schema::Settings {
    crate::storage::read_json(&crate::storage::settings_path()).unwrap_or_default()
}

/// The CLIs the user switched on, from `settings.json` — readable in the
/// `--agent-shim` process too, which has no app state.
pub fn enabled_clis() -> Vec<String> {
    settings().agent_api_key_clis.unwrap_or_default()
}

/// `enabled` (the switched-on CLIs) as one spawn of `cmd` sees it: the tab's
/// own pick (`PtyOptions::api_key`, the ＋ menu's API section or a plain row)
/// puts its CLI in or takes it out; `None` leaves the switch to decide.
fn with_pick(mut enabled: Vec<String>, cmd: &str, pick: Option<bool>) -> Vec<String> {
    if let (Some(id), Some(on)) = (cli_of(cmd), pick) {
        enabled.retain(|c| c != id);
        if on {
            enabled.push(id.to_string());
        }
    }
    enabled
}

/// Whether CLI `cmd` is in the table and takes the key on this spawn: the
/// tab's `pick` when it made one, else switched on. Settings only, no
/// keychain.
pub fn applies_to(cmd: &str, pick: Option<bool>, settings: &crate::schema::Settings) -> bool {
    cli_of(cmd).is_some_and(|id| {
        !routes_of(id).is_empty()
            && with_pick(settings.agent_api_key_clis.clone().unwrap_or_default(), cmd, pick)
                .iter()
                .any(|c| c == id)
    })
}

/// Whether a local session of `cmd` would start on the proxy: picked or
/// switched on ([`applies_to`]), the proxy running in this process, and one of
/// its providers keyed. Reads the keychain (once, then `api_proxy`'s cache)
/// only when it applies.
pub fn keyed(cmd: &str, pick: Option<bool>, settings: &crate::schema::Settings) -> bool {
    applies_to(cmd, pick, settings)
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
/// subcommand, or a CLI neither in `enabled` nor on a server administrator's
/// key (`admin`, the CLI id `server::agent_keys::admin_for_spawn` passed);
/// otherwise each of the CLI's routes the user did not set gets
/// `grant(provider)` — a proxy token and base URL — when that has one: the
/// token under its carrier with `carry`, else under the CLI's own name, the
/// base URL under the CLI's variable. Returns the names it set.
#[allow(clippy::too_many_arguments)]
pub(crate) fn inject_env_with(
    cmd: &str,
    subcommand: bool,
    local_model: bool,
    enabled: &[String],
    admin: Option<&'static str>,
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
    if admin != Some(id) && !enabled.iter().any(|c| c == id) {
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
/// before a fence rewrites it. `pick` is the tab's own login-or-key choice
/// ([`with_pick`]). `admin` is the CLI a hosted server's user runs
/// on the administrator's key (`server::agent_keys::admin_for_spawn`, which
/// checked the offer): its grants forward with that key, whatever the
/// own-key switches say. Settings first, so a spawn of a CLI nobody switched
/// on never touches the keyring; nothing at all where the proxy is not running
/// (the `--agent-shim` process).
pub fn inject_env(
    cmd: &str,
    subcommand: bool,
    local_model: bool,
    pick: Option<bool>,
    admin: Option<&'static str>,
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
        &with_pick(enabled_clis(), cmd, pick),
        admin,
        env,
        CARRY,
        |k| std::env::var_os(k).is_some_and(|v| !v.is_empty()),
        |provider| crate::services::api_proxy::issue(provider, admin, binding.scope, binding.tab, binding.tmux),
    )
}

/// A launch-only provider selects API authentication even when Codex has a
/// saved ChatGPT login. Only the public URL and variable name ride argv;
/// the token stays in the environment and no Codex config/auth file changes.
pub(crate) fn codex_proxy_args(base: &str) -> Vec<String> {
    let settings = [
        "model_provider=\"api_key\"".to_string(),
        "model_providers.api_key.name=\"OpenAI\"".to_string(),
        format!("model_providers.api_key.base_url={}", serde_json::to_string(&format!("{base}/v1")).expect("URL string")),
        format!("model_providers.api_key.env_key=\"{OPENAI_TOKEN_ENV}\""),
        "model_providers.api_key.wire_api=\"responses\"".to_string(),
        "model_providers.api_key.requires_openai_auth=false".to_string(),
        // The proxy relays HTTP SSE and meters each response, never upgrades.
        "model_providers.api_key.supports_websockets=false".to_string(),
    ];
    settings.into_iter().flat_map(|s| ["-c".to_string(), s]).collect()
}

/// Must run while opts still names the CLI, before a fence copies its argv.
pub fn inject_launch(opts: &mut crate::terminal::PtyOptions, admin: Option<&'static str>, binding: Binding<'_>) {
    let subcommand = keyless_subcommand(&opts.cmd, &opts.args);
    let local_model = is_local_model(opts);
    let injected = inject_env(&opts.cmd, subcommand, local_model, opts.api_key, admin, binding, &mut opts.env);
    match cli_of(&opts.cmd) {
        Some("codex") if injected.contains(&OPENAI_BASE_ENV) => {
            // Put global overrides before `resume`/`fork` and their positional id.
            let mut args = codex_proxy_args(&opts.env[OPENAI_BASE_ENV]);
            args.append(&mut opts.args);
            opts.args = args;
        }
        Some("opencode") if !injected.is_empty() => {
            let ambient = std::env::var(OPENCODE_INLINE_ENV).ok();
            // The cached listings are the user's own keys': an administrator's
            // key hides nothing.
            let picker = match admin {
                None => {
                    let keyed: Vec<Provider> =
                        routes_of("opencode").iter().filter(|r| injected.contains(&r.base_var)).map(|r| r.provider).collect();
                    let store = crate::services::agent_versions::load();
                    Picker {
                        v2: crate::services::agent_versions::opencode_is_v2(store.get("opencode")),
                        hidden: crate::services::opencode_models::hidden_for(&keyed),
                        extra: crate::services::opencode_models::extra_for(&keyed),
                    }
                }
                Some(_) => Picker::default(),
            };
            route_opencode(&mut opts.env, &injected, ambient.as_deref(), &picker);
        }
        _ => {}
    }
}

/// OpenCode's inline config, deep-merged over its config files.
pub const OPENCODE_INLINE_ENV: &str = "OPENCODE_CONFIG_CONTENT";

/// OpenCode's id for `provider`, and the path its SDK expects at the end of
/// the base URL (checked against OpenCode 1.19: `/v1/messages`,
/// `/v1beta/models/…:streamGenerateContent`, `/v1/responses`).
fn opencode_provider(provider: Provider) -> (&'static str, &'static str) {
    match provider {
        Provider::Anthropic => ("anthropic", "/v1"),
        Provider::Gemini => ("google", "/v1beta"),
        Provider::OpenAi => ("openai", "/v1"),
    }
}

/// `existing` (an inline config, or none) with each of `keyed` — a provider,
/// the variable holding its token and the proxy base URL — pointed at the
/// proxy: `baseURL`, and the key field naming the variable (`{env:<var>}`),
/// so the token itself never enters the config (which rides a tmux argv).
/// Over a stored OpenCode login too: the inline config outranks `auth.json`,
/// key or OAuth (OpenCode 1.19.3 and 2.1.3).
/// A provider whose block in `existing` already names a base URL or key keeps
/// it — OpenCode 2's own `providers` block too — and every one does when
/// `existing` is not a JSON object. A routed provider's catalog models its
/// key cannot call (`picker`) are hidden as well ([`hide_in_picker`]).
/// Returns the config when something was added, and the providers left out.
/// Pure.
fn opencode_inline_with(
    existing: Option<&str>,
    keyed: &[(Provider, &str, String)],
    picker: &Picker,
) -> (Option<String>, Vec<Provider>) {
    let all = || keyed.iter().map(|(p, _, _)| *p).collect();
    let mut config = match existing.map(serde_json::from_str::<serde_json::Value>) {
        None => serde_json::json!({}),
        Some(Ok(v)) if v.is_object() => v,
        Some(_) => return (None, all()),
    };
    let native_claimed = |config: &serde_json::Value, name: &str| {
        let settings = &config["providers"][name]["settings"];
        settings.get("baseURL").is_some() || settings.get("apiKey").is_some()
    };
    let mut left_out = Vec::new();
    for (provider, token_var, base) in keyed {
        let (name, path) = opencode_provider(*provider);
        if native_claimed(&config, name) {
            left_out.push(*provider);
            continue;
        }
        let Some(providers) = config
            .as_object_mut()
            .map(|root| root.entry("provider").or_insert_with(|| serde_json::json!({})))
            .and_then(serde_json::Value::as_object_mut)
        else {
            return (None, all());
        };
        let options = providers
            .entry(name)
            .or_insert_with(|| serde_json::json!({}))
            .as_object_mut()
            .map(|block| block.entry("options").or_insert_with(|| serde_json::json!({})))
            .and_then(serde_json::Value::as_object_mut);
        let Some(options) = options.filter(|o| !o.contains_key("baseURL") && !o.contains_key("apiKey")) else {
            left_out.push(*provider);
            continue;
        };
        let settings = serde_json::json!({ "baseURL": format!("{base}{path}"), "apiKey": format!("{{env:{token_var}}}") });
        options.extend(settings.as_object().cloned().unwrap_or_default());
        let hidden = picker.hidden.get(provider).map(Vec::as_slice).unwrap_or_default();
        let extra = picker.extra.get(provider).map(Vec::as_slice).unwrap_or_default();
        // OpenCode 2's own block for the provider outranks the legacy one,
        // so one the user's config has must carry the route too.
        if !hidden.is_empty() || !extra.is_empty() || (picker.v2 && config["providers"][name].is_object()) {
            hide_in_picker(&mut config, name, &settings, hidden, extra, picker.v2);
        }
    }
    let added = left_out.len() < keyed.len();
    (added.then(|| config.to_string()), left_out)
}

/// What a keyed OpenCode spawn hides from its model picker
/// (`opencode_models`): by provider, the catalog models its key cannot call.
#[derive(Debug, Default)]
pub(crate) struct Picker {
    /// The OpenCode Tabtivity last probed is 2.x (`agent_versions`).
    pub v2: bool,
    pub hidden: HashMap<Provider, Vec<String>>,
    /// By provider, the models its key can call that the catalog lacks
    /// (`opencode_models::extra`): offered under their exact id.
    pub extra: HashMap<Provider, Vec<String>>,
}

/// Hide `hidden` of provider `name` from OpenCode's model list and offer
/// `extra` — models the key calls that the catalog lacks — under their exact
/// id. 1.x: the legacy block's `blacklist` (unless it filters already) and
/// `models`. 2.x drops that as a legacy setting and takes
/// `providers.<name>.models.<id>.disabled` — in its own `providers` block,
/// which outranks the legacy one for that provider, so it carries the same
/// `settings` (checked with 2.1.2) — also with nothing to hide, for a block
/// the user's config has. A model entry the config already has keeps its own
/// `disabled` and `name`.
fn hide_in_picker(
    config: &mut serde_json::Value,
    name: &str,
    settings: &serde_json::Value,
    hidden: &[String],
    extra: &[String],
    v2: bool,
) {
    let Some(root) = config.as_object_mut() else {
        return;
    };
    let block = if v2 {
        root.entry("providers")
            .or_insert_with(|| serde_json::json!({}))
            .as_object_mut()
            .and_then(|providers| providers.entry(name).or_insert_with(|| serde_json::json!({})).as_object_mut())
    } else {
        root.get_mut("provider").and_then(|p| p.get_mut(name)).and_then(serde_json::Value::as_object_mut)
    };
    let Some(block) = block else {
        return;
    };
    if v2 {
        if let Some(own) = block.entry("settings").or_insert_with(|| serde_json::json!({})).as_object_mut() {
            own.extend(settings.as_object().cloned().unwrap_or_default());
        }
    } else if !hidden.is_empty() && !block.contains_key("whitelist") && !block.contains_key("blacklist") {
        block.insert("blacklist".into(), hidden.into());
    }
    if (!v2 || hidden.is_empty()) && extra.is_empty() {
        return;
    }
    let Some(models) = block.entry("models").or_insert_with(|| serde_json::json!({})).as_object_mut() else {
        return;
    };
    for id in extra {
        models.entry(id.as_str()).or_insert_with(|| serde_json::json!({ "name": id }));
    }
    if !v2 {
        return;
    }
    for id in hidden {
        if let Some(entry) = models.entry(id.as_str()).or_insert_with(|| serde_json::json!({})).as_object_mut() {
            entry.entry("disabled").or_insert(true.into());
        }
    }
}

/// OpenCode reads none of its routes' base-URL variables: each route
/// [`inject_env`] set (`injected`) goes into its inline config instead
/// ([`opencode_inline_with`]), merged over the one already in `env` —
/// Tabtivity's Ollama models — or else (`ambient`) the user's own from
/// Tabtivity's environment. A route that config keeps for itself loses its
/// token and base URL again, so the CLI stays on what the user set.
fn route_opencode(env: &mut HashMap<String, String>, injected: &[&'static str], ambient: Option<&str>, picker: &Picker) {
    let routes = routes_of("opencode");
    let keyed: Vec<(Provider, &str, String)> = routes
        .iter()
        .filter(|r| injected.contains(&r.base_var))
        .map(|r| (r.provider, r.token_var, env[r.base_var].clone()))
        .collect();
    let existing = env.get(OPENCODE_INLINE_ENV).cloned().or_else(|| ambient.map(str::to_string));
    let (config, left_out) = opencode_inline_with(existing.as_deref(), &keyed, picker);
    if let Some(config) = config {
        env.insert(OPENCODE_INLINE_ENV.to_string(), config);
    }
    for route in routes.iter().filter(|r| left_out.contains(&r.provider)) {
        env.remove(route.base_var);
        env.remove(route.token_var);
        env.remove(carrier_of(route.token_var));
    }
}

/// Whether `env`'s OpenCode inline config points a provider at the proxy
/// ([`route_opencode`]): a spawn that cannot carry the token (tmux < 3.2)
/// must not start that way, or each request would reach the proxy with none.
pub fn opencode_routed(env: &HashMap<String, String>) -> bool {
    let Some(config) = env.get(OPENCODE_INLINE_ENV).and_then(|c| serde_json::from_str::<serde_json::Value>(c).ok()) else {
        return false;
    };
    Provider::ALL.into_iter().any(|p| {
        let (name, path) = opencode_provider(p);
        config["provider"][name]["options"]["baseURL"]
            .as_str()
            .and_then(|url| url.strip_suffix(path))
            .is_some_and(|base| crate::services::api_proxy::is_proxy_base(base, p))
    })
}

pub(crate) fn keyless_subcommand(cmd: &str, args: &[String]) -> bool {
    if cli_of(cmd) == Some("codex") {
        !crate::services::agent_versions::codex_runs_tui(args)
    } else {
        crate::services::agent_fence::runs_subcommand(args)
    }
}

/// A project-container spawn of `cmd` (`sandbox`): refused when the CLI runs
/// on an API key — the user's own (picked by the tab or switched on, with a
/// key saved) or a server administrator's — since the container cannot reach
/// this process's loopback proxy and no key is ever put into one (#2389). The
/// message names the way out. `keyless`: a spawn that never takes a key (a
/// local-model tab, a CLI subcommand such as a sign-in). Settings first: the
/// keychain is read only for a CLI the key applies to.
pub fn refuse_in_container(cmd: &str, pick: Option<bool>, keyless: bool) -> Result<(), String> {
    if keyless {
        return Ok(());
    }
    let Some(id) = cli_of(cmd).filter(|id| proxies(id)) else {
        return Ok(());
    };
    let admin = crate::services::server::is_server()
        && crate::services::server::agent_keys::chosen_in(&crate::storage::state_dir()).contains(id);
    let own = applies_to(cmd, pick, &settings()) && routes_of(id).iter().any(|r| has_key(r.provider));
    if admin || own {
        let label = crate::services::agent_registry::agent_label_for_id(id).unwrap_or(id);
        return Err(format!(
            "{label} runs on an API key, which never goes into a project container: turn the container off for this project, or switch {label} back to its own login in Settings → Manage CLIs"
        ));
    }
    Ok(())
}

/// Switch CLI `id`'s own API key off (`Settings::agent_api_key_clis`): a
/// server user choosing the administrator's key for it (one credential per
/// CLI, `server::agent_keys::choose`).
pub fn switch_off(id: &str) -> Result<(), String> {
    let path = crate::storage::settings_path();
    if !settings().agent_api_key_clis.is_some_and(|on| on.iter().any(|c| c == id)) {
        return Ok(());
    }
    // Under the settings file's own lock, as `patch_settings` writes it.
    crate::storage::patch_json(&path, crate::schema::Settings::default(), |settings| {
        if let Some(on) = settings.agent_api_key_clis.as_mut() {
            on.retain(|c| c != id);
        }
        settings.rev += 1;
        Ok(())
    })
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderStatus {
    pub id: &'static str,
    pub saved: bool,
    /// The monthly limit in billed tokens (`Settings::agent_api_token_limits`),
    /// if a valid one is set.
    pub limit_tokens: Option<u64>,
    /// Billed tokens this month (the limit's unit).
    pub billed: u64,
    /// What they cost by `api_prices`: an estimate, shown beside the tokens.
    pub spent_usd: f64,
    /// An older build's dollar limit, while no token limit is set: a hint
    /// for choosing one, never enforced.
    pub legacy_limit_usd: Option<f64>,
    /// `api_usage::Verdict::id`: `open`, `reached`, or `noLimit` (requests
    /// are refused until a limit is set).
    pub budget: &'static str,
    /// Models used this month that the price table does not know: priced at
    /// the provider's highest rate.
    pub unknown_models: Vec<String>,
    /// This month's use by model, most billed first: what the one billed
    /// count is made of (input and output are priced apart).
    pub models: Vec<ModelStatus>,
    /// The workspace a saved Anthropic key that is not scoped to one names.
    pub workspace: Option<String>,
}

/// One model's month from `api_usage::ModelUsage`, in the panel's casing.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModelStatus {
    pub model: String,
    pub input: u64,
    pub output: u64,
    pub cache_write: u64,
    pub cache_read: u64,
    pub requests: u64,
    pub billed: u64,
    pub usd: f64,
}

/// `ledger`'s models for `provider`, most billed first.
fn model_statuses(ledger: &crate::services::api_usage::Ledger, provider: Provider) -> Vec<ModelStatus> {
    let mut models: Vec<ModelStatus> = ledger
        .providers
        .get(provider.id())
        .map(|u| {
            u.models
                .iter()
                .map(|(name, m)| ModelStatus {
                    model: name.clone(),
                    input: m.input,
                    output: m.output,
                    cache_write: m.cache_write,
                    cache_read: m.cache_read,
                    requests: m.requests,
                    billed: m.billed,
                    usd: m.usd,
                })
                .collect()
        })
        .unwrap_or_default();
    models.sort_by(|a, b| b.billed.cmp(&a.billed).then_with(|| a.model.cmp(&b.model)));
    models
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
    /// A hosted server's administrator offers this user a key for the CLI
    /// (`server::agent_keys::offered`); always false on a desktop.
    pub admin_offered: bool,
    /// This user runs the CLI on the administrator's key (#2389: one
    /// credential per CLI — login, own key, or this).
    pub uses_admin: bool,
    /// Through the server's key broker: this month's use and budget.
    pub admin_broker: Option<crate::services::server::keys_wire::MonthUsage>,
}

/// What Manage CLIs shows. Never a key.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ApiKeyStatus {
    /// The keyring can be read now. While it cannot, every `saved` reads
    /// false, so the panel says "locked" instead of "not saved".
    pub readable: bool,
    /// Where keys are kept: `keychain` (the OS's, on a desktop) or `vault`
    /// (a server daemon's sealed store, opened by a paired device — no
    /// unlock button can open it).
    pub store: &'static str,
    pub providers: Vec<ProviderStatus>,
    pub clis: Vec<CliStatus>,
    /// The UTC month the spending is counted for (`YYYY-MM`).
    pub month: String,
    /// When the count starts again (`YYYY-MM-01`, UTC).
    pub resets_on: String,
    /// When this month's count restarted because the ledger file could not
    /// be read (RFC 3339).
    pub ledger_restarted: Option<String>,
    /// When the price table was read off the vendors' pages.
    pub prices_date: &'static str,
}

/// [`status`] over a given `saved` answer, switched-on list, limits and
/// ledger. Pure.
#[allow(clippy::too_many_arguments)]
fn status_with(
    readable: bool,
    store: &'static str,
    saved: impl Fn(Provider) -> bool,
    enabled: &[String],
    limits: &std::collections::BTreeMap<String, u64>,
    legacy_usd: &std::collections::BTreeMap<String, f64>,
    ledger: &crate::services::api_usage::Ledger,
) -> ApiKeyStatus {
    let providers: Vec<ProviderStatus> = Provider::ALL
        .into_iter()
        .map(|p| {
            let limit_tokens = limits.get(p.id()).copied();
            let billed = ledger.billed(p);
            ProviderStatus {
                id: p.id(),
                saved: saved(p),
                limit_tokens,
                billed,
                spent_usd: ledger.spent_usd(p),
                legacy_limit_usd: limit_tokens.is_none().then(|| legacy_usd.get(p.id()).copied()).flatten(),
                budget: crate::services::api_usage::Verdict::of(billed, limit_tokens).id(),
                unknown_models: ledger.unknown_models(p),
                models: model_statuses(ledger, p),
                workspace: None,
            }
        })
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
                admin_offered: false,
                uses_admin: false,
                admin_broker: None,
            }
        })
        .collect();
    ApiKeyStatus {
        readable,
        store,
        providers,
        clis,
        month: ledger.month.clone(),
        resets_on: crate::services::api_usage::resets_on(&ledger.month),
        ledger_restarted: ledger.restarted.clone(),
        prices_date: crate::services::api_prices::PRICES_DATE,
    }
}

/// The CLIs that start on a stored key now: switched on, with a key saved for
/// one of their providers. Reads the keychain only for providers of a
/// switched-on CLI, so with nothing switched on it never touches it.
pub fn ready_clis() -> Vec<&'static str> {
    ready_clis_with(&enabled_clis(), has_key)
}

/// The CLIs the ＋ menu's API section offers: served by the proxy, which runs
/// in this process, with a key saved for one of their providers — switched on
/// or not. Only a provider with a monthly limit set is looked up (a key is
/// saved only beside one, [`require_limit`]), so a user who never saved a key
/// never has the keychain read; the lookups go through `api_proxy`'s cache.
pub fn keyable_clis() -> Vec<&'static str> {
    if !crate::services::api_proxy::running() {
        return Vec::new();
    }
    let limits = crate::services::api_usage::limits_in(&settings());
    let all: Vec<String> = CLI_ROUTES.iter().map(|(id, _)| id.to_string()).collect();
    ready_clis_with(&all, |p| limits.contains_key(p.id()) && crate::services::api_proxy::key_for(p).is_some())
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
    let settings = settings();
    let mut status = status_with(
        crate::services::remote_credentials::store_readable(),
        if crate::services::server::vault::vault().is_some() { "vault" } else { "keychain" },
        has_key,
        &settings.agent_api_key_clis.clone().unwrap_or_default(),
        &crate::services::api_usage::limits_in(&settings),
        &crate::services::api_usage::legacy_usd_limits_in(&settings),
        &crate::services::api_usage::book().snapshot(chrono::Utc::now()),
    );
    for p in &mut status.providers {
        if p.saved {
            p.workspace = Provider::from_id(p.id).and_then(get_workspace);
        }
    }
    // A hosted server's administrator's keys: the third choice per CLI.
    if crate::services::server::is_server() {
        use crate::services::server::agent_keys;
        let offered = agent_keys::offered();
        let chosen = agent_keys::chosen_in(&crate::storage::state_dir());
        let mut brokered = agent_keys::broker_usage(&chosen);
        for cli in &mut status.clis {
            cli.admin_offered = offered.contains(cli.id);
            cli.uses_admin = chosen.contains(cli.id);
            cli.admin_broker = brokered.remove(cli.id);
        }
    }
    status
}

/// Of `ready` (from [`ready_clis`]), the CLIs whose every provider is out of
/// budget this month, or has no limit set: their keyed tabs are refused.
pub fn budget_blocked_clis(ready: &[&'static str]) -> Vec<&'static str> {
    let settings = settings();
    let limits = crate::services::api_usage::limits_in(&settings);
    let ledger = crate::services::api_usage::book().snapshot(chrono::Utc::now());
    budget_blocked_with(ready, &limits, &ledger)
}

fn budget_blocked_with(
    ready: &[&'static str],
    limits: &std::collections::BTreeMap<String, u64>,
    ledger: &crate::services::api_usage::Ledger,
) -> Vec<&'static str> {
    ready
        .iter()
        .copied()
        .filter(|id| {
            let routes = routes_of(id);
            !routes.is_empty()
                && routes.iter().all(|r| {
                    crate::services::api_usage::Verdict::of(ledger.billed(r.provider), limits.get(r.provider.id()).copied())
                        != crate::services::api_usage::Verdict::Open
                })
        })
        .collect()
}

/// The monthly limit saving `provider`'s key requires: refused without one.
pub fn require_limit(provider: Provider) -> Result<u64, String> {
    crate::services::api_usage::limit_for(provider)
        .ok_or_else(|| "set a monthly token limit for this provider before saving its key".to_string())
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
        inject_env_with(cmd, false, false, &on(enabled), None, env, false, |_| false, proxied)
    }

    /// Administrator-key CLIs must have proxy routes; Codex currently supports
    /// the user's own key only (the keeper does not offer OpenAI keys).
    #[test]
    fn the_keepers_key_clis_all_have_proxy_routes() {
        let ours: Vec<&str> = CLI_ROUTES.iter().map(|(id, _)| *id).collect();
        assert!(crate::services::server::keys_wire::KEY_CLIS.iter().all(|cli| ours.contains(cli)));
    }

    /// #2389: a CLI a server user runs on the administrator's key gets a
    /// grant though its own-key switch is off, and only that CLI does.
    #[test]
    fn a_cli_on_the_administrators_key_gets_a_grant_without_its_own_switch() {
        let mut env = HashMap::new();
        let set = inject_env_with("claude", false, false, &[], Some("claude"), &mut env, true, |_| false, proxied);
        assert_eq!(set, vec![ANTHROPIC_CARRIER, ANTHROPIC_BASE_ENV]);
        let mut env = HashMap::new();
        assert!(inject_env_with("gemini", false, false, &[], Some("claude"), &mut env, true, |_| false, proxied).is_empty());
        // A subcommand (a sign-in) or a local-model tab still gets nothing.
        assert!(inject_env_with("claude", true, false, &[], Some("claude"), &mut env, true, |_| false, proxied).is_empty());
        assert!(inject_env_with("claude", false, true, &[], Some("claude"), &mut env, true, |_| false, proxied).is_empty());
        assert!(env.is_empty());
        assert!(proxies("claude") && proxies("gemini") && !proxies("vibe") && proxies("codex") && proxies("opencode"));
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
        let set = inject_env_with("claude", false, false, &on(&["claude"]), None, &mut env, false, |k| k == ANTHROPIC_BASE_ENV, proxied);
        assert!(set.is_empty() && env.is_empty());
        // An empty value is not a choice.
        let mut env = HashMap::from([(ANTHROPIC_TOKEN_ENV.to_string(), String::new())]);
        assert_eq!(inject("claude", &["claude"], &mut env), vec![ANTHROPIC_TOKEN_ENV, ANTHROPIC_BASE_ENV]);
    }

    #[test]
    fn no_grant_sets_nothing() {
        let mut env = HashMap::new();
        let set = inject_env_with("claude", false, false, &on(&["claude"]), None, &mut env, true, |_| false, |_| None);
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
        // Not in the table, switched on or not: nothing points it at the
        // proxy.
        assert!(inject("vibe", &["vibe"], &mut env).is_empty());
        assert!(env.is_empty());
    }

    #[test]
    fn local_model_tabs_and_subcommands_get_nothing() {
        let mut env = HashMap::new();
        let all = on(&["claude", "gemini"]);
        assert!(inject_env_with("claude", false, true, &all, None, &mut env, true, |_| false, proxied).is_empty());
        assert!(inject_env_with("claude", true, false, &all, None, &mut env, true, |_| false, proxied).is_empty());
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
        let set = inject_env_with("claude", false, false, &on(&["claude"]), None, &mut env, true, |_| false, proxied);
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
        assert!(inject_env_with("claude", false, false, &on(&["claude"]), None, &mut env, true, |_| false, proxied).is_empty());
        assert!(!env.contains_key(ANTHROPIC_CARRIER));
    }

    #[test]
    fn without_a_running_proxy_nothing_is_injected() {
        // The test binary never starts the listener, as the `--agent-shim`
        // process never does.
        assert!(!crate::services::api_proxy::running());
        let mut env = HashMap::new();
        let binding = Binding { tab: "t", scope: "s", tmux: None };
        assert!(inject_env("claude", false, false, Some(true), None, binding, &mut env).is_empty());
        assert!(env.is_empty());
    }

    #[test]
    fn only_a_workspace_id_is_a_workspace() {
        assert!(workspace_shape_ok("wrkspc_01JwQvzr7rXLA5AGx3HKfFUJ"));
        for bad in ["", "wrkspc_", "01JwQvzr7rXLA5AGx3HKfFUJ", "wrkspc_01 J", "wrkspc_01\r\nx-api-key: y", "WRKSPC_01"] {
            assert!(!workspace_shape_ok(bad), "{bad:?}");
        }
        assert!(!workspace_shape_ok(&format!("wrkspc_{}", "a".repeat(65))));
    }

    #[test]
    fn providers_round_trip_their_ids_and_accounts() {
        for p in Provider::ALL {
            assert_eq!(Provider::from_id(p.id()), Some(p));
            assert_eq!(p.account(), format!("agent-key:{}", p.id()));
            assert_eq!(p.workspace_account(), format!("agent-key:{}:workspace", p.id()));
        }
        assert_eq!(Provider::from_id("copilot"), None);
        assert_eq!(Provider::from_id("openai"), Some(Provider::OpenAi));
        assert_eq!(Provider::from_id("mistral"), None);
    }

    #[test]
    fn codex_gets_only_a_token_and_launch_only_provider_settings() {
        for carry in [false, true] {
            let mut env = HashMap::new();
            let set = inject_env_with("codex", false, false, &on(&["codex"]), None, &mut env, carry, |_| false, proxied);
            let token_var = if carry { OPENAI_CARRIER } else { OPENAI_TOKEN_ENV };
            assert_eq!(set, [token_var, OPENAI_BASE_ENV]);
            assert_eq!(env[token_var], format!("{FAKE_TOKEN}-openai"));
            let args = codex_proxy_args(&env[OPENAI_BASE_ENV]);
            assert!(args.iter().any(|s| s == "model_provider=\"api_key\""));
            assert!(args.iter().any(|s| s == "model_providers.api_key.env_key=\"OPENAI_API_KEY\""));
            assert!(args.iter().any(|s| s.contains("/openai/v1")));
            assert!(!args.join(" ").contains(FAKE_TOKEN));
        }
        for name in [OPENAI_TOKEN_ENV, OPENAI_BASE_ENV, "CODEX_API_KEY"] {
            let mut env = HashMap::from([(name.to_string(), "user-value".to_string())]);
            assert!(inject("codex", &["codex"], &mut env).is_empty(), "{name}");
            assert_eq!(env.len(), 1, "user settings win");
        }
    }

    /// OpenCode gets every keyed provider as an inline-config route over the
    /// models already there, the token only as an `{env:…}` reference; the
    /// carriers and base URLs stay for `agent_exec` and the old-tmux check.
    #[test]
    fn opencode_routes_every_keyed_provider_through_its_inline_config() {
        let ollama = r#"{"provider":{"ollama":{"name":"Ollama (local)","options":{"baseURL":"http://127.0.0.1:11434/v1"}}}}"#;
        let mut env = HashMap::from([(OPENCODE_INLINE_ENV.to_string(), ollama.to_string())]);
        let set = inject_env_with("opencode", false, false, &on(&["opencode"]), None, &mut env, true, |_| false, proxied);
        assert_eq!(set, [ANTHROPIC_CARRIER, ANTHROPIC_BASE_ENV, GEMINI_CARRIER, GEMINI_BASE_ENV, OPENAI_CARRIER, OPENAI_BASE_ENV]);
        route_opencode(&mut env, &set, None, &Picker::default());
        let text = &env[OPENCODE_INLINE_ENV];
        assert!(!text.contains(FAKE_TOKEN), "no token in the config: {text}");
        let config: serde_json::Value = serde_json::from_str(text).unwrap();
        let p = &config["provider"];
        assert_eq!(p["ollama"]["options"]["baseURL"], "http://127.0.0.1:11434/v1");
        assert_eq!(p["anthropic"]["options"]["baseURL"], "http://127.0.0.1:9/anthropic/v1");
        assert_eq!(p["anthropic"]["options"]["apiKey"], "{env:ANTHROPIC_AUTH_TOKEN}");
        assert_eq!(p["google"]["options"]["baseURL"], "http://127.0.0.1:9/gemini/v1beta");
        assert_eq!(p["google"]["options"]["apiKey"], "{env:GEMINI_API_KEY}");
        assert_eq!(p["openai"]["options"]["baseURL"], "http://127.0.0.1:9/openai/v1");
        assert_eq!(p["openai"]["options"]["apiKey"], "{env:OPENAI_API_KEY}");
        assert_eq!(env[ANTHROPIC_CARRIER], format!("{FAKE_TOKEN}-anthropic"));
        assert!(opencode_routed(&env));
        // Only the keyed providers: the others stay on OpenCode's own login.
        let mut env = HashMap::new();
        let anthropic_only = |p: Provider| (p == Provider::Anthropic).then(|| proxied(p)).flatten();
        let set = inject_env_with("opencode", false, false, &on(&["opencode"]), None, &mut env, true, |_| false, anthropic_only);
        route_opencode(&mut env, &set, None, &Picker::default());
        let config: serde_json::Value = serde_json::from_str(&env[OPENCODE_INLINE_ENV]).unwrap();
        assert_eq!(config["provider"].as_object().unwrap().keys().collect::<Vec<_>>(), ["anthropic"]);
        assert!(proxies("opencode"));
    }

    #[test]
    fn a_provider_the_users_inline_config_points_somewhere_keeps_it() {
        let mine = r#"{"provider":{"anthropic":{"options":{"baseURL":"https://gateway.example/v1"}}},"model":"anthropic/x"}"#;
        let mut env = HashMap::new();
        let set = inject_env_with("opencode", false, false, &on(&["opencode"]), None, &mut env, true, |_| false, proxied);
        route_opencode(&mut env, &set, Some(mine), &Picker::default());
        let config: serde_json::Value = serde_json::from_str(&env[OPENCODE_INLINE_ENV]).unwrap();
        assert_eq!(config["provider"]["anthropic"]["options"]["baseURL"], "https://gateway.example/v1");
        assert!(config["provider"]["anthropic"]["options"].get("apiKey").is_none());
        assert_eq!(config["model"], "anthropic/x");
        assert_eq!(config["provider"]["google"]["options"]["apiKey"], "{env:GEMINI_API_KEY}");
        assert!(!env.contains_key(ANTHROPIC_CARRIER) && !env.contains_key(ANTHROPIC_BASE_ENV));
        assert!(env.contains_key(GEMINI_CARRIER) && env.contains_key(OPENAI_CARRIER));
        // An inline config that is not a JSON object is left alone, and so is
        // every route: nothing points the CLI anywhere.
        for broken in ["not json", "[1]", r#"{"provider":"x"}"#] {
            let mut env = HashMap::new();
            let set = inject_env_with("opencode", false, false, &on(&["opencode"]), None, &mut env, true, |_| false, proxied);
            route_opencode(&mut env, &set, Some(broken), &Picker::default());
            assert!(env.is_empty(), "{broken}: {env:?}");
        }
    }

    /// What a key cannot call leaves OpenCode's picker: 2.x through its own
    /// `providers` block, carrying the proxy settings too; 1.x as a legacy
    /// `blacklist`. A provider without a list, or one the user routed, is
    /// left as it was.
    #[test]
    fn opencode_hides_the_catalog_models_a_key_cannot_call() {
        let hidden = HashMap::from([(Provider::Anthropic, vec!["claude-sonnet-5".to_string(), "claude-sonnet-5-fast".to_string()])]);
        let routed = |picker: &Picker, ambient: Option<&str>| {
            let mut env = HashMap::new();
            let set = inject_env_with("opencode", false, false, &on(&["opencode"]), None, &mut env, true, |_| false, proxied);
            route_opencode(&mut env, &set, ambient, picker);
            serde_json::from_str::<serde_json::Value>(&env[OPENCODE_INLINE_ENV]).unwrap()
        };
        let v2 = routed(&Picker { v2: true, hidden: hidden.clone(), ..Default::default() }, None);
        let native = &v2["providers"]["anthropic"];
        assert_eq!(native["models"]["claude-sonnet-5"]["disabled"], true);
        assert_eq!(native["models"]["claude-sonnet-5-fast"]["disabled"], true);
        assert_eq!(native["settings"]["baseURL"], "http://127.0.0.1:9/anthropic/v1");
        assert_eq!(native["settings"]["apiKey"], "{env:ANTHROPIC_AUTH_TOKEN}");
        assert_eq!(v2["provider"]["anthropic"]["options"]["baseURL"], "http://127.0.0.1:9/anthropic/v1");
        assert!(v2["provider"]["anthropic"].get("blacklist").is_none());
        assert_eq!(v2["providers"].as_object().unwrap().len(), 1, "no list, no native block: {v2}");

        let v1 = routed(&Picker { v2: false, hidden: hidden.clone(), ..Default::default() }, None);
        assert_eq!(v1["provider"]["anthropic"]["blacklist"], serde_json::json!(["claude-sonnet-5", "claude-sonnet-5-fast"]));
        assert!(v1.get("providers").is_none());
        // The user's own filter and model entries stay theirs.
        let mine = r#"{"provider":{"anthropic":{"whitelist":["claude-opus-5-5"]}}}"#;
        assert_eq!(routed(&Picker { v2: false, hidden: hidden.clone(), ..Default::default() }, Some(mine))["provider"]["anthropic"]["whitelist"], serde_json::json!(["claude-opus-5-5"]));
        let mine = r#"{"providers":{"anthropic":{"models":{"claude-sonnet-5":{"disabled":false}}}}}"#;
        let kept = routed(&Picker { v2: true, hidden: hidden.clone(), ..Default::default() }, Some(mine));
        assert_eq!(kept["providers"]["anthropic"]["models"]["claude-sonnet-5"]["disabled"], false);
        assert_eq!(kept["providers"]["anthropic"]["models"]["claude-sonnet-5-fast"]["disabled"], true);
        // A provider OpenCode 2's own block points somewhere is not routed at all.
        let mine = r#"{"providers":{"anthropic":{"settings":{"baseURL":"https://gateway.example/v1"}}}}"#;
        let mut env = HashMap::new();
        let set = inject_env_with("opencode", false, false, &on(&["opencode"]), None, &mut env, true, |_| false, proxied);
        route_opencode(&mut env, &set, Some(mine), &Picker { v2: true, hidden, ..Default::default() });
        let config: serde_json::Value = serde_json::from_str(&env[OPENCODE_INLINE_ENV]).unwrap();
        assert_eq!(config["providers"]["anthropic"], serde_json::json!({"settings":{"baseURL":"https://gateway.example/v1"}}));
        assert!(config["provider"].get("anthropic").is_none_or(|b| b["options"].get("baseURL").is_none()));
        assert!(!env.contains_key(ANTHROPIC_CARRIER) && env.contains_key(GEMINI_CARRIER));
        // The user's 2.x block without a route gets the proxy's, list or not.
        let mine = r#"{"providers":{"google":{"name":"Mine"}}}"#;
        let config = routed(&Picker { v2: true, hidden: HashMap::new(), ..Default::default() }, Some(mine));
        assert_eq!(config["providers"]["google"]["settings"]["apiKey"], "{env:GEMINI_API_KEY}");
        assert_eq!(config["providers"]["google"]["name"], "Mine");
        assert!(config["providers"]["google"].get("models").is_none());
        assert!(config["providers"].get("anthropic").is_none());
    }

    #[test]
    fn a_model_the_catalog_lacks_is_offered_under_its_exact_id() {
        let extra = HashMap::from([(Provider::Anthropic, vec!["claude-sonnet-5-5".to_string()])]);
        let mut config = serde_json::json!({"provider":{"anthropic":{"options":{}}}});
        let settings = serde_json::json!({"baseURL": "http://127.0.0.1:9/anthropic/v1"});
        hide_in_picker(&mut config, "anthropic", &settings, &[], &extra[&Provider::Anthropic], false);
        assert_eq!(config["provider"]["anthropic"]["models"]["claude-sonnet-5-5"]["name"], "claude-sonnet-5-5");
        assert!(config.get("providers").is_none());
        let mut config = serde_json::json!({"providers":{"anthropic":{"models":{"claude-sonnet-5-5":{"name":"Mine"}}}}});
        hide_in_picker(&mut config, "anthropic", &settings, &["old".into()], &["claude-sonnet-5-5".into(), "claude-x".into()], true);
        let models = &config["providers"]["anthropic"]["models"];
        assert_eq!(models["claude-sonnet-5-5"]["name"], "Mine");
        assert_eq!(models["claude-x"]["name"], "claude-x");
        assert_eq!(models["old"]["disabled"], true);
    }

    #[test]
    fn only_a_proxy_base_counts_as_an_opencode_route() {
        let with = |config: &str| HashMap::from([(OPENCODE_INLINE_ENV.to_string(), config.to_string())]);
        assert!(!opencode_routed(&HashMap::new()));
        assert!(!opencode_routed(&with(r#"{"provider":{"ollama":{"options":{"baseURL":"http://127.0.0.1:11434/v1"}}}}"#)));
        assert!(!opencode_routed(&with(r#"{"provider":{"anthropic":{"options":{"baseURL":"https://api.anthropic.com/v1"}}}}"#)));
        assert!(opencode_routed(&with(r#"{"provider":{"google":{"options":{"baseURL":"http://127.0.0.1:4242/gemini/v1beta"}}}}"#)));
        assert!(!opencode_routed(&with("not json")));
    }

    #[test]
    fn codex_resumed_and_forked_conversations_take_keys_but_sign_in_does_not() {
        for args in [vec![], on(&["resume", "session-id"]), on(&["fork", "session-id"]), on(&["--no-daemon", "resume", "session-id"])] {
            assert!(!keyless_subcommand("codex", &args), "{args:?}");
        }
        for args in [on(&["login", "--with-api-key"]), on(&["logout"]), on(&["exec", "prompt"])] {
            assert!(keyless_subcommand("codex", &args), "{args:?}");
        }
    }

    #[test]
    fn status_is_ready_only_for_a_switched_on_cli_with_a_key() {
        let ledger = crate::services::api_usage::Ledger { month: "2026-10".into(), ..Default::default() };
        let s = status_with(true, "keychain", |p| p == Provider::Anthropic, &on(&["claude", "gemini"]), &Default::default(), &Default::default(), &ledger);
        let cli = |id: &str| s.clis.iter().find(|c| c.id == id).unwrap().clone();
        assert!(cli("claude").ready);
        assert!(!cli("gemini").ready, "on, but no Gemini key");
        assert_eq!(cli("claude").providers, vec!["anthropic"]);
        assert!(s.providers.iter().any(|p| p.id == "anthropic" && p.saved));
        assert!(!s.clis.iter().any(|c| c.id == "vibe"));
        // A CLI of several providers is ready on any one key.
        let s = status_with(true, "keychain", |p| p == Provider::OpenAi, &on(&["opencode"]), &Default::default(), &Default::default(), &ledger);
        let opencode = s.clis.iter().find(|c| c.id == "opencode").unwrap();
        assert!(opencode.ready);
        assert_eq!(opencode.providers, vec!["anthropic", "gemini", "openai"]);
        assert_eq!(s.providers.len(), 3);
        let json = serde_json::to_value(&s).unwrap();
        assert!(json.get("readable").is_some() && json["clis"][0].get("ready").is_some());
        assert_eq!(json["resetsOn"], "2026-11-01");
    }

    #[test]
    fn status_shows_the_budget_per_provider() {
        use crate::services::api_prices::Charge;
        use crate::services::api_usage::Ledger;
        let mut ledger = Ledger { month: "2026-10".into(), ..Default::default() };
        // `output` tokens billed in full; `usd` the estimate beside them.
        let charge = |model: &str, output: u64, usd: f64, known: bool| Charge {
            model: model.into(),
            known,
            output,
            usd,
            ..Charge::default()
        };
        ledger.add(Provider::Anthropic, &charge("claude-opus-5-5", 12_000, 12.0, true));
        ledger.add(Provider::Anthropic, &charge("claude-new", 8_000, 8.0, false));
        ledger.add(Provider::Gemini, &charge("gemini-2.5-pro", 1_000, 1.0, true));
        ledger.restarted = Some("2026-10-04T12:00:00Z".into());
        let limits = std::collections::BTreeMap::from([("anthropic".to_string(), 20_000)]);
        // An older build's dollar limits: shown only where no token limit is.
        let legacy = std::collections::BTreeMap::from([("anthropic".to_string(), 20.0), ("gemini".to_string(), 7.5)]);
        let s = status_with(true, "vault", |_| true, &on(&["claude", "gemini"]), &limits, &legacy, &ledger);
        let anthropic = &s.providers[0];
        assert_eq!((anthropic.id, anthropic.limit_tokens, anthropic.budget), ("anthropic", Some(20_000), "reached"));
        assert_eq!(anthropic.billed, 20_000);
        assert!((anthropic.spent_usd - 20.0).abs() < 1e-9);
        assert_eq!(anthropic.legacy_limit_usd, None, "a token limit is set");
        assert_eq!(anthropic.unknown_models, ["claude-new"]);
        // By model, most billed first, input and output kept apart.
        let models: Vec<_> = anthropic.models.iter().map(|m| (m.model.as_str(), m.input, m.output, m.billed)).collect();
        assert_eq!(models, [("claude-opus-5-5", 0, 12_000, 12_000), ("claude-new", 0, 8_000, 8_000)]);
        let gemini = &s.providers[1];
        assert_eq!((gemini.limit_tokens, gemini.budget, gemini.legacy_limit_usd), (None, "noLimit", Some(7.5)));
        assert_eq!(s.ledger_restarted.as_deref(), Some("2026-10-04T12:00:00Z"));
        let json = serde_json::to_value(&s).unwrap();
        assert_eq!(json["providers"][0]["limitTokens"], 20_000);
        assert_eq!(json["providers"][0]["billed"], 20_000);
        assert_eq!(json["providers"][1]["legacyLimitUsd"], 7.5);
        assert_eq!(json["providers"][1]["budget"], "noLimit");
        assert_eq!(json["providers"][0]["models"][0]["cacheRead"], 0);
        assert_eq!(json["providers"][2]["models"], serde_json::json!([]));
        assert_eq!(json["store"], "vault");
        // Claude's only provider is out of budget, Gemini's has no limit:
        // both are blocked; with a limit and room, Gemini is not.
        assert_eq!(budget_blocked_with(&["claude", "gemini"], &limits, &ledger), vec!["claude", "gemini"]);
        let limits = std::collections::BTreeMap::from([("anthropic".to_string(), 50_000), ("gemini".to_string(), 5_000)]);
        assert!(budget_blocked_with(&["claude", "gemini"], &limits, &ledger).is_empty());
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
        assert!(!applies_to("claude", None, &settings));
        settings.agent_api_key_clis = Some(on(&["claude", "codex", "vibe"]));
        assert!(applies_to("claude", None, &settings));
        assert!(applies_to("/opt/bin/claude", None, &settings));
        assert!(applies_to("codex", None, &settings));
        assert!(!applies_to("vibe", None, &settings), "dropped: no proxy route");
        assert!(!applies_to("gemini", None, &settings));
    }

    #[test]
    fn a_tabs_own_pick_outranks_the_switch() {
        let mut settings = crate::schema::Settings::default();
        // The ＋ menu's API section: the key with the switch off.
        assert!(applies_to("claude", Some(true), &settings));
        assert!(!applies_to("gemini", Some(false), &settings));
        settings.agent_api_key_clis = Some(on(&["claude", "gemini"]));
        // A plain row: the login with the switch on, for its own CLI only.
        assert!(!applies_to("claude", Some(false), &settings));
        assert!(applies_to("gemini", None, &settings));
        // A pick never reaches a CLI the proxy cannot serve.
        assert!(!applies_to("vibe", Some(true), &settings));
        assert_eq!(with_pick(on(&["claude", "gemini"]), "/opt/bin/claude", Some(false)), on(&["gemini"]));
        assert_eq!(with_pick(on(&["gemini"]), "claude", Some(true)), on(&["gemini", "claude"]));
        assert_eq!(with_pick(on(&["claude"]), "claude", Some(true)), on(&["claude"]));
        assert_eq!(with_pick(on(&["claude"]), "bash", Some(false)), on(&["claude"]));
    }
}
