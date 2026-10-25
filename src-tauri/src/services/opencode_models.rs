//! The OpenCode catalog models a keyed provider's API key cannot call, kept
//! out of the CLI's model picker (`agent_api_keys::route_opencode`).
//!
//! OpenCode lists every model models.dev knows for a provider it is pointed
//! at, whatever the key behind it may use. Two lists say which to hide, both
//! kept in `<state_dir>/opencode-models.json` (no secret in it) and refreshed
//! in the background ([`refresh`]), never on a spawn's path:
//!
//! - the **catalog**: models.dev's `anthropic`, `google` and `openai` model
//!   ids with the modes OpenCode 2 lists as entries of their own
//!   (`<id>-<mode>`, from `experimental.modes`), at most [`FRESH`] old;
//! - each **key's own listing** (`api_proxy::key_models`), as old, dropped
//!   when its key is saved or removed ([`forget`]).
//!
//! A spawn hides nothing until both are known, and nothing for a provider
//! whose listing came back empty. OpenCode 2 takes the result as
//! `providers.<id>.models.<model>.disabled` (it drops 1.x's `whitelist` and
//! `blacklist` as legacy settings); 1.x as `provider.<id>.blacklist`.
//! AppHandle-free.

use std::collections::{BTreeSet, HashMap};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use app_core::sync::LockExt;
use serde::{Deserialize, Serialize};

use super::agent_api_keys::Provider;

/// Where OpenCode's catalog comes from (its own default `OPENCODE_MODELS_URL`).
const CATALOG_URL: &str = "https://models.dev/api.json";
/// The catalog is several MiB; anything far larger is not it.
const MAX_CATALOG_BYTES: usize = 64 * 1024 * 1024;
const CATALOG_WAIT: Duration = Duration::from_secs(60);
/// How old a list may be before the next keyed spawn refreshes it.
const FRESH: u64 = 24 * 60 * 60;

/// One catalog model: its id and the modes OpenCode 2 adds as `<id>-<mode>`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct CatalogModel {
    pub id: String,
    #[serde(default)]
    pub modes: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct Catalog {
    fetched: u64,
    /// By OpenCode provider id (`opencode_id`).
    providers: HashMap<String, Vec<CatalogModel>>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct Listed {
    fetched: u64,
    ids: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct Store {
    #[serde(default)]
    catalog: Option<Catalog>,
    /// By `Provider::id`.
    #[serde(default)]
    keys: HashMap<String, Listed>,
}

/// Serialises this process's read-modify-writes of the store.
static STORE: Mutex<()> = Mutex::new(());
/// Bumped by every [`forget`], so a listing fetched with the old key is not
/// stored over it.
static KEY_GENERATION: AtomicU64 = AtomicU64::new(0);
static REFRESHING: AtomicBool = AtomicBool::new(false);

fn store_path() -> std::path::PathBuf {
    crate::storage::state_dir().join("opencode-models.json")
}

fn load() -> Store {
    crate::storage::read_json(&store_path()).unwrap_or_default()
}

fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn stale(fetched: u64, now: u64) -> bool {
    now.saturating_sub(fetched) >= FRESH
}

/// OpenCode's id for `provider` (its catalog key and config block name).
pub fn opencode_id(provider: Provider) -> &'static str {
    match provider {
        Provider::Anthropic => "anthropic",
        Provider::Gemini => "google",
        Provider::OpenAi => "openai",
    }
}

/// The catalog's models for each of `providers`, from models.dev's
/// `api.json`; `None` when it is not that document.
fn parse_catalog(body: &[u8]) -> Option<HashMap<String, Vec<CatalogModel>>> {
    #[derive(Deserialize)]
    struct Modes {
        #[serde(default)]
        modes: HashMap<String, serde::de::IgnoredAny>,
    }
    #[derive(Deserialize)]
    struct Model {
        #[serde(default)]
        experimental: Option<Modes>,
    }
    #[derive(Deserialize)]
    struct Entry {
        #[serde(default)]
        models: HashMap<String, Model>,
    }
    let all: HashMap<String, serde_json::Value> = serde_json::from_slice(body).ok()?;
    let mut out = HashMap::new();
    for provider in Provider::ALL {
        let name = opencode_id(provider);
        let Some(entry) = all.get(name).and_then(|v| serde_json::from_value::<Entry>(v.clone()).ok()) else {
            continue;
        };
        let mut models: Vec<CatalogModel> = entry
            .models
            .into_iter()
            .map(|(id, m)| {
                let mut modes: Vec<String> = m.experimental.map(|e| e.modes.into_keys().collect()).unwrap_or_default();
                modes.sort();
                CatalogModel { id, modes }
            })
            .collect();
        models.sort_by(|a, b| a.id.cmp(&b.id));
        out.insert(name.to_string(), models);
    }
    (!out.is_empty()).then_some(out)
}

/// The model ids a provider's own listing names: `data[].id` (Anthropic,
/// OpenAI) or `models[].name` without `models/` (Gemini). `None` for a body
/// that is not such a listing.
pub fn listed_ids(provider: Provider, body: &str) -> Option<Vec<String>> {
    let v: serde_json::Value = serde_json::from_str(body).ok()?;
    let (list, field) = match provider {
        Provider::Anthropic | Provider::OpenAi => (v.get("data")?.as_array()?, "id"),
        Provider::Gemini => (v.get("models")?.as_array()?, "name"),
    };
    Some(
        list.iter()
            .filter_map(|m| m.get(field)?.as_str())
            .map(|id| id.strip_prefix("models/").unwrap_or(id).to_string())
            .collect(),
    )
}

/// `id` without a trailing release date: Anthropic's `-20251101`, OpenAI's
/// `-2024-08-06`. The catalog names most models by that alias too.
fn undated(id: &str) -> &str {
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    if let Some((head, tail)) = id.rsplit_once('-') {
        if tail.len() == 8 && digits(tail) {
            return head;
        }
    }
    let parts: Vec<&str> = id.rsplitn(4, '-').collect();
    if let [d, m, y, head] = parts.as_slice() {
        if y.len() == 4 && m.len() == 2 && d.len() == 2 && digits(y) && digits(m) && digits(d) {
            return head;
        }
    }
    id
}

/// The catalog entries (with their mode entries) that none of `listed` —
/// the key's own model ids — names, by id or by its undated alias. Empty
/// when the key listed nothing: a listing that empty is not believed. Pure.
pub fn hidden(catalog: &[CatalogModel], listed: &[String]) -> Vec<String> {
    if listed.is_empty() {
        return Vec::new();
    }
    let callable: BTreeSet<&str> = listed.iter().flat_map(|id| [id.as_str(), undated(id)]).collect();
    let mut out = Vec::new();
    for model in catalog.iter().filter(|m| !callable.contains(m.id.as_str())) {
        out.push(model.id.clone());
        out.extend(model.modes.iter().map(|mode| format!("{}-{mode}", model.id)));
    }
    out
}

/// The ids `listed` — the key's own model ids — has that the catalog names
/// neither by id nor by undated alias: models OpenCode would not offer at all
/// (a release models.dev lacks yet), kept to the chat ones (a Gemini listing
/// also has embedding and image models, OpenAI's whisper and tts). Empty
/// while the catalog is empty. Pure.
pub fn extra(provider: Provider, catalog: &[CatalogModel], listed: &[String]) -> Vec<String> {
    if catalog.is_empty() {
        return Vec::new();
    }
    let known: BTreeSet<&str> = catalog.iter().map(|m| m.id.as_str()).collect();
    let chat = |id: &str| match provider {
        Provider::Anthropic => id.starts_with("claude-"),
        Provider::Gemini => id.starts_with("gemini-") && !id.contains("embedding") && !id.contains("image") && !id.contains("tts"),
        Provider::OpenAi => {
            let o_series = id.strip_prefix('o').is_some_and(|r| r.starts_with(|c: char| c.is_ascii_digit()));
            (id.starts_with("gpt-") || id.starts_with("chatgpt-") || o_series)
                && !["audio", "realtime", "image", "tts", "transcribe", "embedding", "search"].iter().any(|w| id.contains(w))
        }
    };
    let mut out: Vec<String> = listed
        .iter()
        .filter(|id| chat(id) && !known.contains(id.as_str()) && !known.contains(undated(id)))
        .cloned()
        .collect();
    out.sort();
    out.dedup();
    out
}

/// The key-callable models the catalog lacks, for each of `providers`
/// ([`extra`]); a provider is left out while the catalog or its listing is
/// unknown. Reads the cache only — [`hidden_for`] starts the refresh.
pub fn extra_for(providers: &[Provider]) -> HashMap<Provider, Vec<String>> {
    let Store { mut catalog, mut keys } = load();
    let mut out = HashMap::new();
    for &provider in providers {
        let models = catalog.as_mut().and_then(|c| c.providers.remove(opencode_id(provider)));
        if let (Some(models), Some(listed)) = (models, keys.remove(provider.id())) {
            let ids = extra(provider, &models, &listed.ids);
            if !ids.is_empty() {
                out.insert(provider, ids);
            }
        }
    }
    out
}

/// What to hide for each of `providers` on this spawn; a provider is left
/// out while the catalog or its key's listing is unknown. Starts one
/// background [`refresh`] when any of those is missing or older than
/// [`FRESH`]. Reads one small file.
pub fn hidden_for(providers: &[Provider]) -> HashMap<Provider, Vec<String>> {
    let Store { mut catalog, mut keys } = load();
    let now = now();
    let catalog_stale = catalog.as_ref().is_none_or(|c| stale(c.fetched, now));
    if catalog_stale || providers.iter().any(|p| keys.get(p.id()).is_none_or(|l| stale(l.fetched, now))) {
        refresh(providers.to_vec());
    }
    let mut out = HashMap::new();
    for &provider in providers {
        let models = catalog.as_mut().and_then(|c| c.providers.remove(opencode_id(provider)));
        if let (Some(models), Some(listed)) = (models, keys.remove(provider.id())) {
            out.insert(provider, hidden(&models, &listed.ids));
        }
    }
    out
}

/// `provider`'s key was saved or removed: its listing is stale.
pub fn forget(provider: Provider) {
    let _guard = STORE.lock_ok();
    KEY_GENERATION.fetch_add(1, Ordering::AcqRel);
    let mut store = load();
    if store.keys.remove(provider.id()).is_some() {
        let _ = crate::storage::write_json_atomic(&store_path(), &store);
    }
}

/// Fetch whatever of the catalog and `providers`' listings is missing or
/// stale, once at a time, in the background. A failed fetch keeps the old
/// list (or none) and is tried again by the next spawn.
pub fn refresh(providers: Vec<Provider>) {
    if REFRESHING.swap(true, Ordering::AcqRel) {
        return;
    }
    app_core::rt::spawn(async move {
        refresh_now(&providers).await;
        REFRESHING.store(false, Ordering::Release);
    });
}

async fn refresh_now(providers: &[Provider]) {
    let before = load();
    let now = now();
    if before.catalog.as_ref().is_none_or(|c| stale(c.fetched, now)) {
        if let Some(providers) = fetch_catalog().await {
            let _guard = STORE.lock_ok();
            let mut store = load();
            store.catalog = Some(Catalog { fetched: now, providers });
            let _ = crate::storage::write_json_atomic(&store_path(), &store);
        }
    }
    for &provider in providers {
        if before.keys.get(provider.id()).is_some_and(|l| !stale(l.fetched, now)) {
            continue;
        }
        let generation = KEY_GENERATION.load(Ordering::Acquire);
        let Some(ids) = super::api_proxy::key_models(provider).await else {
            continue;
        };
        let _guard = STORE.lock_ok();
        if KEY_GENERATION.load(Ordering::Acquire) != generation {
            continue;
        }
        let mut store = load();
        store.keys.insert(provider.id().to_string(), Listed { fetched: now, ids });
        let _ = crate::storage::write_json_atomic(&store_path(), &store);
    }
}

async fn fetch_catalog() -> Option<HashMap<String, Vec<CatalogModel>>> {
    crate::services::mail_engine::install_crypto_provider();
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .https_only(true)
        .timeout(CATALOG_WAIT)
        .build()
        .ok()?;
    let response = client.get(CATALOG_URL).send().await.ok()?;
    if !response.status().is_success() || response.content_length().is_some_and(|n| n as usize > MAX_CATALOG_BYTES) {
        return None;
    }
    let body = response.bytes().await.ok()?;
    if body.len() > MAX_CATALOG_BYTES {
        return None;
    }
    parse_catalog(&body)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn model(id: &str, modes: &[&str]) -> CatalogModel {
        CatalogModel { id: id.into(), modes: modes.iter().map(|m| m.to_string()).collect() }
    }

    fn ids(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn the_catalog_keeps_three_providers_and_their_modes() {
        let body = br#"{
            "anthropic": {"id": "anthropic", "models": {
                "claude-opus-5-5": {"id": "claude-opus-5-5", "experimental": {"modes": {"fast": {"cost": {}}}}},
                "claude-haiku-4-5": {"id": "claude-haiku-4-5"}}},
            "google": {"models": {"gemini-3.5-flash": {"experimental": null}}},
            "openai": {"models": {"gpt-5": {"experimental": {"modes": {"flex": {}, "fast": {}}}}}},
            "mistral": {"models": {"x": {}}}
        }"#;
        let catalog = parse_catalog(body).unwrap();
        assert_eq!(catalog.len(), 3);
        assert_eq!(catalog["anthropic"], [model("claude-haiku-4-5", &[]), model("claude-opus-5-5", &["fast"])]);
        assert_eq!(catalog["google"], [model("gemini-3.5-flash", &[])]);
        assert_eq!(catalog["openai"], [model("gpt-5", &["fast", "flex"])]);
        assert!(parse_catalog(b"[]").is_none());
        assert!(parse_catalog(br#"{"mistral": {"models": {}}}"#).is_none());
    }

    #[test]
    fn listings_name_their_model_ids() {
        let anthropic = r#"{"data":[{"id":"claude-opus-4-5-20251101","type":"model"},{"id":"claude-opus-5-5"}],"has_more":false}"#;
        assert_eq!(listed_ids(Provider::Anthropic, anthropic).unwrap(), ["claude-opus-4-5-20251101", "claude-opus-5-5"]);
        let gemini = r#"{"models":[{"name":"models/gemini-3.5-flash"},{"name":"models/gemini-pro-latest"}]}"#;
        assert_eq!(listed_ids(Provider::Gemini, gemini).unwrap(), ["gemini-3.5-flash", "gemini-pro-latest"]);
        assert_eq!(listed_ids(Provider::OpenAi, r#"{"object":"list","data":[]}"#).unwrap(), Vec::<String>::new());
        assert!(listed_ids(Provider::OpenAi, r#"{"error":{"message":"no"}}"#).is_none());
        assert!(listed_ids(Provider::Gemini, "not json").is_none());
    }

    #[test]
    fn dates_come_off_both_shapes() {
        assert_eq!(undated("claude-opus-4-5-20251101"), "claude-opus-4-5");
        assert_eq!(undated("gpt-4o-2024-08-06"), "gpt-4o");
        assert_eq!(undated("claude-opus-5-5"), "claude-opus-5-5");
        assert_eq!(undated("gpt-4o-mini"), "gpt-4o-mini");
        assert_eq!(undated("gemini-2.5-pro-preview-05-06"), "gemini-2.5-pro-preview-05-06");
        assert_eq!(undated("deep-research-preview-04-2026"), "deep-research-preview-04-2026");
    }

    #[test]
    fn a_callable_model_the_catalog_lacks_is_added() {
        let catalog = [model("claude-opus-4-5", &[]), model("claude-opus-5-5", &["fast"])];
        let listed = ids(&["claude-opus-4-5-20251101", "claude-opus-5-5", "claude-sonnet-5-5", "claude-sonnet-5-5"]);
        assert_eq!(extra(Provider::Anthropic, &catalog, &listed), ["claude-sonnet-5-5"]);
        let openai = ids(&["gpt-5", "gpt-5.5", "o4-mini", "whisper-1", "gpt-4o-realtime-preview", "text-embedding-3-small"]);
        assert_eq!(extra(Provider::OpenAi, &[model("gpt-5", &[])], &openai), ["gpt-5.5", "o4-mini"]);
        let gemini = ids(&["gemini-3.5-flash", "gemini-embedding-001", "imagen-4"]);
        assert_eq!(extra(Provider::Gemini, &[model("x", &[])], &gemini), ["gemini-3.5-flash"]);
        // No catalog, nothing to compare with.
        assert!(extra(Provider::Anthropic, &[], &listed).is_empty());
    }

    #[test]
    fn only_what_the_key_cannot_call_is_hidden_with_its_modes() {
        let catalog = [
            model("claude-opus-4-5", &[]),
            model("claude-opus-4-5-20251101", &[]),
            model("claude-opus-5-5", &["fast"]),
            model("claude-sonnet-5", &["fast"]),
        ];
        let listed = ids(&["claude-opus-4-5-20251101", "claude-opus-5-5"]);
        assert_eq!(hidden(&catalog, &listed), ["claude-sonnet-5", "claude-sonnet-5-fast"]);
        // An empty listing is not believed: nothing is hidden.
        assert!(hidden(&catalog, &[]).is_empty());
    }
}
