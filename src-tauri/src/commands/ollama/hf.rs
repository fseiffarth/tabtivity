//! Hugging Face as a second model source beside Ollama's registry.
//!
//! Ollama pulls any GGUF repo on the Hub as `hf.co/<user>/<repo>:<quant>`: the
//! Hub serves an Ollama-compatible manifest for it at
//! `huggingface.co/v2/<user>/<repo>/manifests/<quant>`, built from the one
//! `.gguf` file whose name carries that quantization (`latest` picks one).
//! [`super::registry_ref`] sends such a ref's manifest and blob reads there, so
//! the size hint, the update check and the paused-download cleanup work for
//! these models as they do for Ollama's own.
//!
//! The browse list searches the Hub's model API, GGUF repos only, and offers
//! each repo's single-file quantizations as its tags. A sharded GGUF
//! (`-00001-of-00003`) is left out: the Hub refuses to serve it to Ollama.

use std::sync::LazyLock;

use chrono::{DateTime, Utc};
use regex::Regex;
use sha2::{Digest, Sha256};

use super::{long_age_label, percent_encode_query, validate_model_name, RegistryModel};

/// The Hub's Ollama-compatible registry root.
pub(super) const REGISTRY: &str = "https://huggingface.co/v2";

/// The Hub's model search.
const SEARCH_API: &str = "https://huggingface.co/api/models";

/// Rows per page, about what one ollama.com search page holds.
const PAGE_SIZE: u32 = 20;

/// The fields a row needs, and nothing else (a bare search returns none of
/// them but `siblings`, which `full` would bloat with every file's metadata).
const EXPAND: &str = "&expand%5B%5D=downloads&expand%5B%5D=lastModified&expand%5B%5D=gated\
                      &expand%5B%5D=gguf&expand%5B%5D=siblings";

/// The quantization a file stem ends in: `qwen2.5-7b-instruct-q4_k_m` →
/// `q4_k_m`, `gemma-3-4b-it-UD-Q4_K_XL` → `UD-Q4_K_XL`, `llama-2-7b.Q5_0` →
/// `Q5_0`.
static QUANT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)(?:^|[-_.])((?:UD-)?(?:I?Q[1-8](?:_[A-Z0-9]+)*|BF16|F16|F32|FP16|FP32|MXFP4(?:_MOE)?))$")
        .expect("quant pattern")
});

/// One part of a sharded GGUF.
static SHARD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"-\d{5}-of-\d{5}$").expect("shard pattern"));

/// The tag offered first: the quantization Ollama's own library ships by
/// default, then the nearest alternatives.
const DEFAULT_QUANTS: [&str; 5] = ["Q4_K_M", "Q4_K_S", "Q5_K_M", "Q4_0", "Q8_0"];

/// The hosts Ollama treats as the Hub.
pub(super) fn is_hf_host(host: &str) -> bool {
    host.eq_ignore_ascii_case("hf.co") || host.eq_ignore_ascii_case("huggingface.co")
}

/// One page of Hub search results.
#[derive(serde::Serialize, Clone, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HfSearchPage {
    pub models: Vec<RegistryModel>,
    /// What to pass back for the next page; `None` on the last one.
    pub next_cursor: Option<String>,
}

/// Search the Hub's GGUF repos, one page at a time. `sort` is the browse list's
/// own (`popular`, `newest`, `name`); `cursor` the previous page's
/// `next_cursor`, passed back with the same query and sort.
/// The body of the `search_huggingface_models` command, which lives in
/// `commands/ollama.rs` so the core dispatcher's generator (it reads only
/// top-level command files) gives the browser and daemon transports a wrapper.
pub async fn search_huggingface_models_in(
    query: String,
    sort: String,
    cursor: Option<String>,
) -> Result<HfSearchPage, String> {
    let url = search_url(&query, &sort, cursor.as_deref())?;
    let (head, body) = super::registry_response(&url, &[])
        .await?
        .ok_or_else(|| "Hugging Face search request failed".to_string())?;
    let link = head
        .get(reqwest::header::LINK)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default();
    parse_search(&body, link, Utc::now())
}

/// The search URL for one page. The query loses a pasted `hf.co/` prefix and
/// `:tag`, so a copied model ref finds its repo; only the three sorts pass, and
/// a cursor only when it is the opaque token the Hub handed out.
fn search_url(query: &str, sort: &str, cursor: Option<&str>) -> Result<String, String> {
    let mut q = query.trim();
    if let Some((_, rest)) = q.split_once('/').filter(|(host, _)| is_hf_host(host)) {
        q = rest;
    }
    if let Some((repo, _tag)) = q.rsplit_once(':').filter(|(_, t)| !t.contains('/')) {
        q = repo;
    }
    let (sort, direction) = match sort {
        "newest" => ("lastModified", "-1"),
        "name" => ("id", "1"),
        _ => ("downloads", "-1"),
    };
    let mut url = format!(
        "{SEARCH_API}?search={}&filter=gguf&sort={sort}&direction={direction}&limit={PAGE_SIZE}{EXPAND}",
        percent_encode_query(q)
    );
    if let Some(cursor) = cursor {
        if !cursor_ok(cursor) {
            return Err("invalid search cursor".to_string());
        }
        url.push_str("&cursor=");
        url.push_str(cursor);
    }
    Ok(url)
}

/// A cursor as the Hub writes it: base64, percent-encoded.
fn cursor_ok(cursor: &str) -> bool {
    !cursor.is_empty()
        && cursor.len() <= 4096
        && cursor.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '%' | '-' | '_' | '.' | '~'))
}

/// The `cursor` of the `Link: <…>; rel="next"` header, if there is a next page.
fn next_cursor(link: &str) -> Option<String> {
    link.split(',')
        .find(|part| part.contains("rel=\"next\""))
        .and_then(|part| part.split_once("cursor="))
        .map(|(_, rest)| rest.split(['&', '>']).next().unwrap_or_default().to_string())
        .filter(|c| cursor_ok(c))
}

fn parse_search(body: &[u8], link: &str, now: DateTime<Utc>) -> Result<HfSearchPage, String> {
    let rows: Vec<serde_json::Value> =
        serde_json::from_slice(body).map_err(|e| format!("Hugging Face search json: {e}"))?;
    Ok(HfSearchPage {
        models: rows.iter().filter_map(|row| model_row(row, now)).collect(),
        next_cursor: next_cursor(link),
    })
}

/// One search row as a browse-list card, or `None` when it offers nothing
/// Ollama could pull (no single-file GGUF) or its id is not a model name.
fn model_row(row: &serde_json::Value, now: DateTime<Utc>) -> Option<RegistryModel> {
    let id = row["id"].as_str()?;
    let name = format!("hf.co/{id}");
    validate_model_name(&name).ok()?;
    let files: Vec<&str> = row["siblings"]
        .as_array()
        .map(|a| a.iter().filter_map(|f| f["rfilename"].as_str()).collect())
        .unwrap_or_default();
    let sizes = quant_tags(&files);
    if sizes.is_empty() {
        return None;
    }
    let mut capabilities = Vec::new();
    if row["gguf"]["chat_template"].as_str().is_some_and(|t| t.contains("tools")) {
        capabilities.push("tools".to_string());
    }
    if files.iter().any(|f| f.to_ascii_lowercase().contains("mmproj")) {
        capabilities.push("vision".to_string());
    }
    Some(RegistryModel {
        name,
        community: false,
        description: String::new(),
        capabilities,
        sizes,
        pulls: row["downloads"].as_u64().map(count_label).unwrap_or_default(),
        updated: row["lastModified"]
            .as_str()
            .and_then(|t| age_label(t, now))
            .unwrap_or_default(),
        hugging_face: true,
        params: row["gguf"]["total"].as_u64().filter(|n| *n > 0).map(params_label),
        gated: !matches!(row["gated"], serde_json::Value::Bool(false) | serde_json::Value::Null),
    })
}

/// The quantization tags a repo's files offer, each once, the default first:
/// top-level single-file `.gguf` models only (no shard, no vision projector).
fn quant_tags(files: &[&str]) -> Vec<String> {
    let mut tags: Vec<String> = Vec::new();
    for file in files {
        if file.contains('/') {
            continue;
        }
        let Some(stem) = file
            .len()
            .checked_sub(5)
            .filter(|&at| file.is_char_boundary(at) && file[at..].eq_ignore_ascii_case(".gguf"))
            .map(|at| &file[..at])
        else {
            continue;
        };
        if stem.to_ascii_lowercase().contains("mmproj") || SHARD.is_match(stem) {
            continue;
        }
        if let Some(quant) = QUANT.captures(stem).and_then(|c| c.get(1)) {
            let tag = quant.as_str().to_ascii_uppercase();
            if !tags.contains(&tag) {
                tags.push(tag);
            }
        }
    }
    if let Some(at) = DEFAULT_QUANTS
        .iter()
        .find_map(|d| tags.iter().position(|t| t == d))
    {
        let first = tags.remove(at);
        tags.insert(0, first);
    }
    tags
}

/// `351061` → `351.1K`, as ollama.com writes its pull counts.
fn count_label(n: u64) -> String {
    let short = |v: f64, unit: &str| {
        let s = format!("{v:.1}");
        format!("{}{unit}", s.strip_suffix(".0").unwrap_or(&s))
    };
    match n {
        0..=999 => n.to_string(),
        1_000..=999_999 => short(n as f64 / 1e3, "K"),
        1_000_000..=999_999_999 => short(n as f64 / 1e6, "M"),
        _ => short(n as f64 / 1e9, "B"),
    }
}

/// `7615616512` → `7.6B`, `494032768` → `494M`.
fn params_label(n: u64) -> String {
    if n >= 1_000_000_000 {
        let s = format!("{:.1}", n as f64 / 1e9);
        format!("{}B", s.strip_suffix(".0").unwrap_or(&s))
    } else {
        format!("{}M", (n as f64 / 1e6).round() as u64)
    }
}

/// An RFC 3339 time as the "3 weeks ago" label ollama.com rows carry.
fn age_label(then: &str, now: DateTime<Utc>) -> Option<String> {
    let then = DateTime::parse_from_rfc3339(then).ok()?.with_timezone(&Utc);
    let secs = (now - then).num_seconds().max(0);
    let (n, unit) = match secs {
        0..=3_599 => (secs / 60, "m"),
        3_600..=86_399 => (secs / 3_600, "h"),
        86_400..=604_799 => (secs / 86_400, "d"),
        604_800..=2_591_999 => (secs / 604_800, "w"),
        2_592_000..=31_535_999 => (secs / 2_592_000, "mo"),
        _ => (secs / 31_536_000, "y"),
    };
    Some(long_age_label(&format!("{}{unit}", n.max(1))))
}

/// The digest Ollama reports for a model pulled from the Hub: the SHA-256 of
/// its manifest, which the Hub — unlike Ollama's registry — sends no header
/// for, so the manifest is fetched (a few hundred bytes). A refusal keeps the
/// Hub's own message ("This tag is a sharded GGUF…"). `curl`, bounded by
/// `--max-time`, args passed directly; the URL comes from
/// [`super::registry_ref`], already `validate_model_name`d. Blocking.
pub(super) fn manifest_digest(url: &str) -> Result<String, String> {
    let output = crate::paths::command_no_window("curl")
        .args([
            "-sSL",
            "--max-time",
            "15",
            "-H",
            "Accept: application/vnd.docker.distribution.manifest.v2+json",
            "-w",
            "\n%{http_code}",
            url,
        ])
        .output()
        .map_err(|e| format!("failed to query registry: {e}"))?;
    if !output.status.success() {
        return Err("registry unreachable".to_string());
    }
    manifest_digest_of(&output.stdout)
}

/// [`manifest_digest`] on curl's output: the body, a newline, the status code.
fn manifest_digest_of(out: &[u8]) -> Result<String, String> {
    let split = out
        .iter()
        .rposition(|b| *b == b'\n')
        .ok_or_else(|| "registry unreachable".to_string())?;
    let (body, code) = (&out[..split], String::from_utf8_lossy(&out[split + 1..]));
    if code.trim() != "200" {
        let said = serde_json::from_slice::<serde_json::Value>(body)
            .ok()
            .and_then(|v| v["error"].as_str().map(String::from));
        return Err(said.unwrap_or_else(|| format!("registry answered HTTP {}", code.trim())));
    }
    Ok(format!("{:x}", Sha256::digest(body)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hugging_face_refs_are_read_from_the_hub() {
        let at = super::super::registry_ref("hf.co/bartowski/Qwen2.5-7B-Instruct-GGUF:Q4_K_M").unwrap();
        assert_eq!(
            at.manifest_url(),
            "https://huggingface.co/v2/bartowski/Qwen2.5-7B-Instruct-GGUF/manifests/Q4_K_M"
        );
        assert_eq!(
            at.blob_url("ab12"),
            "https://huggingface.co/v2/bartowski/Qwen2.5-7B-Instruct-GGUF/blobs/sha256:ab12"
        );
        assert!(at.hugging_face());
        let latest = super::super::registry_ref("huggingface.co/u/m").unwrap();
        assert_eq!(latest.manifest_url(), "https://huggingface.co/v2/u/m/manifests/latest");
        // Another host is not asked of Ollama's registry, nor fetched from.
        assert!(super::super::registry_ref("registry.example.com:5000/ns/model:tag").is_err());
    }

    #[test]
    fn quant_tags_offer_single_file_ggufs_default_first() {
        let files = [
            ".gitattributes",
            "README.md",
            "qwen2.5-coder-7b-instruct-fp16-00001-of-00004.gguf",
            "qwen2.5-coder-7b-instruct-q2_k.gguf",
            "qwen2.5-coder-7b-instruct-q4_k_m.gguf",
            "qwen2.5-coder-7b-instruct-q5_0-00001-of-00002.gguf",
            "Qwen2.5-Coder-7B-Instruct-IQ4_XS.gguf",
            "gemma-3-4b-it-UD-Q4_K_XL.gguf",
            "llama-2-7b.Q8_0.gguf",
            "mmproj-model-f16.gguf",
            "BF16/big-model-BF16-00001-of-00002.gguf",
            "model-imatrix.dat",
            "Q4_K_M.gguf",
        ];
        assert_eq!(
            quant_tags(&files),
            ["Q4_K_M", "Q2_K", "IQ4_XS", "UD-Q4_K_XL", "Q8_0"]
        );
        assert!(quant_tags(&["a-00001-of-00002.gguf", "notes.txt"]).is_empty());
    }

    #[test]
    fn the_search_url_passes_only_known_sorts_and_hub_cursors() {
        assert_eq!(
            search_url(" qwen coder ", "popular", None).unwrap(),
            format!("{SEARCH_API}?search=qwen%20coder&filter=gguf&sort=downloads&direction=-1&limit=20{EXPAND}")
        );
        assert!(search_url("hf.co/u/m-GGUF:Q4_K_M", "name", None)
            .unwrap()
            .contains("?search=u%2Fm-GGUF&filter=gguf&sort=id&direction=1&"));
        assert!(search_url("", "newest", Some("eyJ4IjoxfQ%3D%3D"))
            .unwrap()
            .ends_with("&cursor=eyJ4IjoxfQ%3D%3D"));
        assert!(search_url("", "newest", Some("x&sort=evil")).is_err());
        assert!(search_url("", "&evil", None).unwrap().contains("sort=downloads"));
    }

    #[test]
    fn the_next_cursor_comes_from_the_link_header() {
        let link = "<https://huggingface.co/api/models?search=q&limit=3&cursor=eyJ4IjoxfQ%3D%3D>; rel=\"next\"";
        assert_eq!(next_cursor(link).as_deref(), Some("eyJ4IjoxfQ%3D%3D"));
        assert_eq!(next_cursor(""), None);
        assert_eq!(next_cursor("<https://huggingface.co/api/models?cursor=a b>; rel=\"next\""), None);
    }

    #[test]
    fn search_rows_become_cards() {
        let now = DateTime::parse_from_rfc3339("2026-11-05T00:00:00Z").unwrap().with_timezone(&Utc);
        let body = serde_json::json!([
            {
                "id": "bartowski/Model-GGUF",
                "gated": false,
                "lastModified": "2026-10-15T00:00:00.000Z",
                "downloads": 351061,
                "gguf": { "total": 7615616512u64, "chat_template": "{% if tools %}…" },
                "siblings": [
                    { "rfilename": "Model-Q8_0.gguf" },
                    { "rfilename": "Model-Q4_K_M.gguf" },
                    { "rfilename": "mmproj-Model-f16.gguf" }
                ]
            },
            { "id": "someone/only-safetensors", "siblings": [{ "rfilename": "model.safetensors" }] },
            {
                "id": "org/Gated-GGUF",
                "gated": "manual",
                "downloads": 12,
                "siblings": [{ "rfilename": "gated-q4_0.gguf" }]
            }
        ]);
        let page = parse_search(body.to_string().as_bytes(), "", now).unwrap();
        assert_eq!(page.next_cursor, None);
        assert_eq!(page.models.len(), 2);
        let m = &page.models[0];
        assert_eq!(m.name, "hf.co/bartowski/Model-GGUF");
        assert_eq!(m.sizes, ["Q4_K_M", "Q8_0"]);
        assert_eq!(m.capabilities, ["tools", "vision"]);
        assert_eq!(m.pulls, "351.1K");
        assert_eq!(m.updated, "3 weeks ago");
        assert_eq!(m.params.as_deref(), Some("7.6B"));
        assert!(m.hugging_face && !m.community && !m.gated);
        let gated = &page.models[1];
        assert!(gated.gated && gated.params.is_none() && gated.updated.is_empty());
        assert_eq!(gated.pulls, "12");
    }

    #[test]
    fn labels_read_like_ollama_com() {
        assert_eq!(count_label(999), "999");
        assert_eq!(count_label(65_800), "65.8K");
        assert_eq!(count_label(2_000_000), "2M");
        assert_eq!(params_label(494_032_768), "494M");
        assert_eq!(params_label(70_000_000_000), "70B");
        let now = DateTime::parse_from_rfc3339("2026-11-05T12:00:00Z").unwrap().with_timezone(&Utc);
        assert_eq!(age_label("2026-11-05T11:59:30Z", now).as_deref(), Some("1 minute ago"));
        assert_eq!(age_label("2024-11-12T07:59:32.000Z", now).as_deref(), Some("1 year ago"));
        assert_eq!(age_label("not a date", now), None);
    }

    #[test]
    fn the_manifest_digest_is_the_body_hash_or_the_hub_s_refusal() {
        let mut ok = br#"{"schemaVersion":2}"#.to_vec();
        ok.extend_from_slice(b"\n200");
        assert_eq!(
            manifest_digest_of(&ok).unwrap(),
            format!("{:x}", Sha256::digest(br#"{"schemaVersion":2}"#))
        );
        let refused = b"{\"error\":\"This tag is a sharded GGUF.\"}\n400";
        assert_eq!(manifest_digest_of(refused).unwrap_err(), "This tag is a sharded GGUF.");
        assert_eq!(manifest_digest_of(b"<html>\n502").unwrap_err(), "registry answered HTTP 502");
    }
}
