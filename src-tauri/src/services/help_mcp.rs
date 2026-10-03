//! **Tabtivity's help MCP** — a read-only question-answering surface over the
//! help corpus (`docs/help/*.md`), served to every local agent tab as the MCP
//! server `tabtivity-help` and to the window as `help_search` / `help_read` /
//! `help_topics`. Design: `docs/help_mcp_plan.md`, `docs/context/help_mcp.md`.
//!
//! The authority is deliberately the smallest one Tabtivity hands out: the corpus
//! is compiled into the binary (`build.rs` → `HELP_CORPUS`), so no tool here
//! reads a file, a store, a setting, a project or a path at call time. A
//! [`Caller::Helper`] token (per spawn, like the schedule identity) reaches
//! only `/mcp/help`; the four tool names are registered in
//! `root_mcp_security::tool` as served to that class alone, and that class is
//! served nothing else. Every answer is bounded ([`MAX_TOPIC_BYTES`],
//! [`MAX_SECTION_BYTES`], [`MAX_RESULTS`]).
//!
//! `AppHandle`-free and deterministic: the index is built once from the
//! embedded corpus, search is tokenized BM25 over sections with the topic's
//! title and keywords boosted, ties broken by topic id then section order.

use std::collections::HashMap;
use std::sync::OnceLock;

use serde::Serialize;
use serde_json::{json, Value};

use super::root_mcp::{Caller, Session};
use super::root_mcp_security as security;

mod corpus {
    include!(concat!(env!("OUT_DIR"), "/help_corpus.rs"));
}

pub const SERVER_NAME: &str = crate::brand::MCP_HELP_SERVER;
pub const INSTRUCTIONS: &str = concat!(crate::app_name!(), "'s own user documentation, read-only. Use it to answer questions about using ", crate::app_name!(), " (projects, tabs, agent CLIs, local models, remote projects, sync, mobile, mail/calendar, containers, troubleshooting). Start with ", crate::app_slug!(), "_help_search, then ", crate::app_slug!(), "_help_read the best topic or section; ", crate::app_slug!(), "_help_topics lists everything. It knows nothing about the user's projects, files or settings.");

/// The tools, in the order `tools/list` gives them.
const TOOL_SEARCH: &str = crate::brand::HELP_TOOL_SEARCH;
const TOOL_READ: &str = crate::brand::HELP_TOOL_READ;
const TOOL_TOPICS: &str = crate::brand::HELP_TOOL_TOPICS;
const TOOL_STATUS: &str = crate::brand::HELP_TOOL_STATUS;
pub const TOOLS: &[&str] = &[TOOL_SEARCH, TOOL_READ, TOOL_TOPICS, TOOL_STATUS];
/// Search hits per call: default and ceiling.
pub const DEFAULT_RESULTS: usize = 5;
pub const MAX_RESULTS: usize = 10;
/// A whole-topic read, and a one-section read, in bytes of text.
pub const MAX_TOPIC_BYTES: usize = 16 * 1024;
pub const MAX_SECTION_BYTES: usize = 8 * 1024;
/// A search snippet, in characters.
pub const SNIPPET_CHARS: usize = 240;
pub const MAX_QUERY_BYTES: usize = 256;
pub const MAX_QUERY_TERMS: usize = 16;
/// Topics `tabtivity_help_topics` lists at most (the corpus is a few dozen).
pub const MAX_TOPICS: usize = 200;
const TRUNCATED: &str = "\n\n[… truncated — read one section at a time with `section`]";

/// The agent CLIs the help server is named to on their own command line
/// (`root_mcp::apply_help_to_spawn_with`); tool-tagged local Vibe models get
/// it through Vibe's env layer. Every other agent CLI gets the env pair only.
pub const WIRED_CLIS: &[&str] = &["claude", "codex"];

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Section {
    pub id: String,
    pub title: String,
    #[serde(skip)]
    pub body: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Topic {
    pub id: String,
    pub title: String,
    pub keywords: Vec<String>,
    #[serde(skip)]
    pub intro: String,
    pub sections: Vec<Section>,
}

/// One searchable unit: a topic's intro (`section: None`) or one `##` section.
struct Unit {
    topic: usize,
    section: Option<usize>,
    tf: HashMap<String, f64>,
    len: f64,
}

pub struct Index {
    pub topics: Vec<Topic>,
    /// Files the build embedded that did not parse, with why — served nowhere,
    /// held to zero by `real_corpus_parses`.
    pub rejected: Vec<(String, String)>,
    units: Vec<Unit>,
    df: HashMap<String, usize>,
    avg_len: f64,
}

// ── Parsing ─────────────────────────────────────────────────────────────────

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// A heading's addressable id: lowercase ASCII alphanumerics, runs of
/// anything else collapsed to one `-`.
pub fn slug(title: &str) -> String {
    let mut out = String::new();
    for c in title.chars().flat_map(char::to_lowercase) {
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else if !out.ends_with('-') && !out.is_empty() {
            out.push('-');
        }
    }
    while out.ends_with('-') { out.pop(); }
    out.truncate(96);
    if out.is_empty() { "section".into() } else { out }
}

fn unquote(s: &str) -> &str {
    let s = s.trim();
    s.strip_prefix('"').and_then(|s| s.strip_suffix('"'))
        .or_else(|| s.strip_prefix('\'').and_then(|s| s.strip_suffix('\'')))
        .unwrap_or(s)
}

/// One corpus file, `stem` its filename without `.md`. The contract
/// (`docs/help_mcp_plan.md`): a `---` front-matter block with `id` (= the
/// stem), `title` and `keywords: [a, b]`; `##` headings open sections, text
/// before the first is the intro. `##` inside a fenced code block is text.
pub fn parse_topic(stem: &str, text: &str) -> Result<Topic, String> {
    let text = text.replace("\r\n", "\n");
    let rest = text.strip_prefix("---\n").ok_or("missing front matter")?;
    let end = rest.find("\n---\n").map(|i| (i, i + 5))
        .or_else(|| rest.strip_suffix("\n---").map(|r| (r.len(), rest.len())))
        .ok_or("unterminated front matter")?;
    let (front, body) = (&rest[..end.0], &rest[end.1..]);
    let (mut id, mut title, mut keywords) = (None, None, None);
    for line in front.lines().filter(|l| !l.trim().is_empty() && !l.trim_start().starts_with('#')) {
        let (key, value) = line.split_once(':').ok_or("front matter line without `key:`")?;
        match key.trim() {
            "id" => id = Some(unquote(value).to_string()),
            "title" => title = Some(unquote(value).to_string()),
            "keywords" => {
                let list = value.trim().strip_prefix('[').and_then(|v| v.strip_suffix(']'))
                    .ok_or("keywords must be a flow list `[a, b]`")?;
                keywords = Some(list.split(',').map(unquote).filter(|k| !k.is_empty()).map(str::to_string).collect::<Vec<_>>());
            }
            _ => {} // forward-compatible: unknown keys are ignored
        }
    }
    let id = id.ok_or("missing `id`")?;
    if !valid_id(&id) { return Err(format!("`id` {id:?} is not kebab-case [a-z0-9-], ≤ 64")); }
    if id != stem { return Err(format!("`id` {id:?} does not match the filename {stem:?}")); }
    let title = title.filter(|t| !t.is_empty() && t.chars().count() <= 120).ok_or("missing or over-long `title`")?;
    let keywords = keywords.ok_or("missing `keywords`")?;
    if keywords.len() > 32 || keywords.iter().any(|k| k.chars().count() > 48) {
        return Err("too many or over-long keywords".into());
    }
    let mut intro = String::new();
    let mut sections: Vec<Section> = Vec::new();
    let mut fenced = false;
    for line in body.lines() {
        if line.trim_start().starts_with("```") || line.trim_start().starts_with("~~~") { fenced = !fenced; }
        if let Some(heading) = line.strip_prefix("## ").filter(|_| !fenced) {
            let title = heading.trim().trim_end_matches('#').trim().to_string();
            let base = slug(&title);
            let mut sid = base.clone();
            let mut n = 2;
            while sections.iter().any(|s| s.id == sid) { sid = format!("{base}-{n}"); n += 1; }
            sections.push(Section { id: sid, title, body: String::new() });
            continue;
        }
        let into = match sections.last_mut() { Some(s) => &mut s.body, None => &mut intro };
        into.push_str(line);
        into.push('\n');
    }
    let trim = |s: &mut String| *s = s.trim().to_string();
    trim(&mut intro);
    sections.iter_mut().for_each(|s| trim(&mut s.body));
    Ok(Topic { id, title, keywords, intro, sections })
}

// ── Tokens ──────────────────────────────────────────────────────────────────

const STOPWORDS: &[&str] = &[
    "a", "an", "and", "are", "as", "at", "be", "by", "can", "do", "does", "for", "from", "how", "i", "if", "in",
    "into", "is", "it", "its", "me", "my", "of", "on", "or", "so", "that", "the", "then", "this", "to", "what",
    "when", "where", "which", "who", "why", "with", "you", "your",
];

fn stem(word: &str) -> String {
    let n = word.chars().count();
    if n > 4 && word.ends_with("ies") {
        format!("{}y", &word[..word.len() - 3])
    } else if n > 3 && word.ends_with('s') && !word.ends_with("ss") && !word.ends_with("us") {
        word[..word.len() - 1].to_string()
    } else {
        word.to_string()
    }
}

/// Lowercase alphanumeric runs, stopwords dropped, a light plural stem.
pub fn tokenize(text: &str) -> Vec<String> {
    text.split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .map(str::to_lowercase)
        .filter(|w| !STOPWORDS.contains(&w.as_str()) && (w.chars().count() > 1 || w.chars().all(|c| c.is_ascii_digit())))
        .map(|w| stem(&w))
        .collect()
}

// ── Index and search ────────────────────────────────────────────────────────

/// Field weights: a term in the topic's title or keywords counts as three in
/// the body, one in the section's heading as two.
const W_TOPIC: f64 = 3.0;
const W_HEADING: f64 = 2.0;
const K1: f64 = 1.2;
const B: f64 = 0.75;

impl Index {
    /// Build from `(filename, text)` pairs. Non-`.md` names are skipped; a
    /// file that does not parse, or repeats an id, is set aside in `rejected`.
    pub fn build(files: &[(&str, &str)]) -> Index {
        let mut topics: Vec<Topic> = Vec::new();
        let mut rejected = Vec::new();
        for (name, text) in files {
            let Some(stem) = name.strip_suffix(".md") else { continue };
            match parse_topic(stem, text) {
                Ok(t) if topics.iter().any(|o| o.id == t.id) => rejected.push((name.to_string(), "duplicate id".into())),
                Ok(t) => topics.push(t),
                Err(e) => rejected.push((name.to_string(), e)),
            }
        }
        topics.sort_by(|a, b| a.id.cmp(&b.id));
        let mut units = Vec::new();
        for (ti, topic) in topics.iter().enumerate() {
            let mut head = tokenize(&topic.title);
            head.extend(topic.keywords.iter().flat_map(|k| tokenize(k)));
            head.extend(tokenize(&topic.id.replace('-', " ")));
            let unit = |section: Option<usize>, heading: &str, body: &str| {
                let mut tf: HashMap<String, f64> = HashMap::new();
                let body = tokenize(body);
                let heading = tokenize(heading);
                let len = (body.len() + heading.len()) as f64;
                for t in body { *tf.entry(t).or_default() += 1.0; }
                for t in heading { *tf.entry(t).or_default() += W_HEADING; }
                for t in &head { *tf.entry(t.clone()).or_default() += W_TOPIC; }
                Unit { topic: ti, section, tf, len: len.max(1.0) }
            };
            if !topic.intro.is_empty() || topic.sections.is_empty() {
                units.push(unit(None, "", &topic.intro));
            }
            for (si, s) in topic.sections.iter().enumerate() {
                units.push(unit(Some(si), &s.title, &s.body));
            }
        }
        let mut df: HashMap<String, usize> = HashMap::new();
        for u in &units { for t in u.tf.keys() { *df.entry(t.clone()).or_default() += 1; } }
        let avg_len = if units.is_empty() { 1.0 } else { units.iter().map(|u| u.len).sum::<f64>() / units.len() as f64 };
        Index { topics, rejected, units, df, avg_len }
    }

    pub fn topic(&self, id: &str) -> Option<&Topic> {
        self.topics.iter().find(|t| t.id == id)
    }

    /// Ranked hits for `query`, at most `limit` (clamped to [`MAX_RESULTS`]).
    pub fn search(&self, query: &str, limit: usize) -> Vec<Hit> {
        let mut terms = tokenize(query);
        terms.dedup();
        let mut seen = std::collections::HashSet::new();
        terms.retain(|t| seen.insert(t.clone()));
        terms.truncate(MAX_QUERY_TERMS);
        if terms.is_empty() { return Vec::new(); }
        let n = self.units.len() as f64;
        let mut scored: Vec<(f64, usize)> = self.units.iter().enumerate().filter_map(|(i, u)| {
            let score: f64 = terms.iter().map(|t| {
                let tf = u.tf.get(t).copied().unwrap_or(0.0);
                if tf == 0.0 { return 0.0; }
                let df = self.df.get(t).copied().unwrap_or(0) as f64;
                let idf = (1.0 + (n - df + 0.5) / (df + 0.5)).ln();
                idf * tf * (K1 + 1.0) / (tf + K1 * (1.0 - B + B * u.len / self.avg_len))
            }).sum();
            (score > 0.0).then_some((score, i))
        }).collect();
        scored.sort_by(|a, b| {
            let (ua, ub) = (&self.units[a.1], &self.units[b.1]);
            b.0.total_cmp(&a.0)
                .then_with(|| self.topics[ua.topic].id.cmp(&self.topics[ub.topic].id))
                .then_with(|| ua.section.cmp(&ub.section))
        });
        scored.into_iter().take(limit.clamp(1, MAX_RESULTS)).map(|(score, i)| {
            let u = &self.units[i];
            let topic = &self.topics[u.topic];
            let section = u.section.map(|s| &topic.sections[s]);
            let body = section.map_or(topic.intro.as_str(), |s| s.body.as_str());
            Hit {
                id: topic.id.clone(),
                title: topic.title.clone(),
                section: section.map(|s| s.id.clone()),
                section_title: section.map(|s| s.title.clone()),
                snippet: snippet(body, &terms),
                score: (score * 1000.0).round() / 1000.0,
            }
        }).collect()
    }

    /// A topic's text: one section (`section` = its id), or the intro and
    /// every section as markdown. Capped; `truncated` says so.
    pub fn read(&self, id: &str, section: Option<&str>) -> Result<Read, String> {
        let topic = self.topic(id).ok_or_else(|| {
            let near: Vec<String> = self.search(&id.replace('-', " "), 3).into_iter().map(|h| h.id).collect();
            format!(concat!("unknown topic {:?}; call ", crate::app_slug!(), "_help_topics for the list{}"), clip(id, 64),
                if near.is_empty() { String::new() } else { format!(" (closest: {})", near.join(", ")) })
        })?;
        let (text, cap) = match section {
            Some(sid) => {
                let s = topic.sections.iter().find(|s| s.id == sid).ok_or_else(|| format!(
                    "unknown section {:?} of {:?}; sections: {}", clip(sid, 96), topic.id,
                    topic.sections.iter().map(|s| s.id.as_str()).collect::<Vec<_>>().join(", ")))?;
                (format!("## {}\n\n{}", s.title, s.body), MAX_SECTION_BYTES)
            }
            None => {
                let mut text = String::new();
                if !topic.intro.is_empty() { text.push_str(&topic.intro); text.push_str("\n\n"); }
                for s in &topic.sections { text.push_str(&format!("## {}\n\n{}\n\n", s.title, s.body)); }
                (text.trim_end().to_string(), MAX_TOPIC_BYTES)
            }
        };
        let truncated = text.len() > cap;
        let text = if truncated { format!("{}{TRUNCATED}", clip_bytes(&text, cap)) } else { text };
        Ok(Read {
            id: topic.id.clone(), title: topic.title.clone(), keywords: topic.keywords.clone(),
            section: section.map(str::to_string), text, truncated,
            sections: topic.sections.iter().map(|s| SectionRef { id: s.id.clone(), title: s.title.clone() }).collect(),
        })
    }

    pub fn list(&self) -> Vec<TopicRef> {
        self.topics.iter().take(MAX_TOPICS).map(|t| TopicRef {
            id: t.id.clone(), title: t.title.clone(), keywords: t.keywords.clone(),
            sections: t.sections.iter().map(|s| SectionRef { id: s.id.clone(), title: s.title.clone() }).collect(),
        }).collect()
    }
}

fn clip_bytes(s: &str, max: usize) -> &str {
    if s.len() <= max { return s; }
    let mut end = max;
    while !s.is_char_boundary(end) { end -= 1; }
    &s[..end]
}
fn clip(s: &str, chars: usize) -> String { s.chars().take(chars).collect() }

/// The first line of `body` holding a query term, else its first line;
/// markdown list/heading markers dropped, cut to [`SNIPPET_CHARS`].
fn snippet(body: &str, terms: &[String]) -> String {
    let lines: Vec<&str> = body.lines().map(str::trim).filter(|l| !l.is_empty() && !l.starts_with("```")).collect();
    let hit = lines.iter().find(|l| {
        let toks = tokenize(l);
        terms.iter().any(|t| toks.contains(t))
    });
    let line = hit.or(lines.first()).copied().unwrap_or("");
    let line = line.trim_start_matches(['#', '-', '*', '>', ' ']);
    let line = line.split_once(". ").filter(|(n, _)| n.chars().all(|c| c.is_ascii_digit())).map_or(line, |(_, r)| r);
    if line.chars().count() > SNIPPET_CHARS { format!("{}…", clip(line, SNIPPET_CHARS - 1)) } else { line.to_string() }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hit {
    pub id: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub section: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub section_title: Option<String>,
    pub snippet: String,
    pub score: f64,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SectionRef { pub id: String, pub title: String }
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Read {
    pub id: String,
    pub title: String,
    pub keywords: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub section: Option<String>,
    pub text: String,
    pub truncated: bool,
    pub sections: Vec<SectionRef>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TopicRef { pub id: String, pub title: String, pub keywords: Vec<String>, pub sections: Vec<SectionRef> }

/// The index over the corpus this binary embeds, built on first use.
pub fn index() -> &'static Index {
    static INDEX: OnceLock<Index> = OnceLock::new();
    INDEX.get_or_init(|| Index::build(corpus::HELP_CORPUS))
}

/// Non-sensitive live facts: what this binary is and what the help server
/// reaches. Nothing read from the state directory, the environment or disk.
pub fn status(index: &Index) -> Value {
    json!({
        "version": env!("CARGO_PKG_VERSION"),
        "commit": option_env!(crate::app_env!("BUILD_COMMIT")),
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "topics": index.topics.len(),
        "wiredClis": WIRED_CLIS,
        "localModels": "Mistral Vibe tabs on a tool-tagged Ollama model",
        "reach": "local agent tabs only; remote, VM and container tabs are not wired",
    })
}

// ── MCP ─────────────────────────────────────────────────────────────────────

fn schema(name: &str) -> Value {
    let object = |properties: Value, required: Value| json!({"type":"object","properties":properties,"required":required,"additionalProperties":false});
    match name {
        TOOL_SEARCH => object(json!({
            "query": {"type":"string","maxLength":MAX_QUERY_BYTES,"description":"What the user wants to know, in plain words (e.g. \"install a local model\", \"sync a remote project\")."},
            "limit": {"type":"integer","minimum":1,"maximum":MAX_RESULTS,"description":format!("How many hits, 1–{MAX_RESULTS}; default {DEFAULT_RESULTS}.")}
        }), json!(["query"])),
        TOOL_READ => object(json!({
            "topic_id": {"type":"string","maxLength":64,"description":concat!("A topic id from ", crate::app_slug!(), "_help_search or ", crate::app_slug!(), "_help_topics.")},
            "section": {"type":"string","maxLength":96,"description":"Optional section id (from the hit or the topic's `sections`) to read just that part."}
        }), json!(["topic_id"])),
        _ => object(json!({}), json!([])),
    }
}

pub fn tools() -> Value {
    let describe = |name: &str| match name {
        TOOL_SEARCH => concat!("Search ", crate::app_name!(), "'s user documentation. Returns ranked topic sections with a snippet; follow up with ", crate::app_slug!(), "_help_read."),
        TOOL_READ => concat!("Read one ", crate::app_name!(), " help topic (or one of its sections) as markdown. Output is capped; read by section for long topics."),
        TOOL_TOPICS => concat!("List every ", crate::app_name!(), " help topic with its sections and keywords."),
        _ => concat!("Which ", crate::app_name!(), " build this is (version, OS) and which agent tabs have these help tools. No user data."),
    };
    Value::Array(TOOLS.iter().map(|name| json!({
        "name": name,
        "description": describe(name),
        "inputSchema": schema(name),
        "annotations": super::root_mcp::tool_annotations(name),
    })).collect())
}

/// One tool call against `index`. Arguments are schema-checked first
/// (unknown fields refused, bounds enforced) — the registry's validator.
pub fn call(index: &Index, name: &str, args: &Value) -> Result<Value, String> {
    // A session that outlived a rename still calls the tools by the names it
    // was listed; the list itself only ever carries the current ones.
    let name = &*crate::services::brand_migration::compat::current_tool_name(&crate::brand::PAIR, name);
    if !security::tool(name).is_some_and(|t| t.serves(Caller::Helper)) { return Err("unknown tool".into()); }
    security::validate(&schema(name), args)?;
    match name {
        TOOL_SEARCH => {
            let query = args["query"].as_str().unwrap_or_default();
            let limit = args["limit"].as_u64().map_or(DEFAULT_RESULTS, |n| n as usize);
            let hits = index.search(query, limit);
            Ok(json!({"query": clip(query, 256), "results": hits,
                "hint": if hits.is_empty() { concat!("no match; try other words or ", crate::app_slug!(), "_help_topics") } else { concat!(crate::app_slug!(), "_help_read(topic_id, section) for the full text") }}))
        }
        TOOL_READ => {
            let read = index.read(args["topic_id"].as_str().unwrap_or_default(), args["section"].as_str())?;
            serde_json::to_value(read).map_err(|e| e.to_string())
        }
        TOOL_TOPICS => Ok(json!({"topics": index.list()})),
        TOOL_STATUS => Ok(status(index)),
        _ => Err("unknown tool".into()),
    }
}

/// One JSON-RPC message from a [`Caller::Helper`] session; `None` for a
/// notification. Any other class, or a revoked session, is refused here too,
/// whatever the route said.
pub fn handle_message(session: &Session, message: &Value) -> Option<Value> {
    handle_with(session, index(), message)
}

pub(crate) fn handle_with(session: &Session, index: &Index, message: &Value) -> Option<Value> {
    let error = |id: Value, code: i64, text: &str| Some(json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":text}}));
    if message["jsonrpc"] != "2.0" || !message["method"].is_string()
        || message.get("id").is_some_and(|id| !id.is_string() && !id.is_i64() && !id.is_u64())
        || message.get("params").is_some_and(|p| !p.is_object()) {
        return error(Value::Null, -32600, "invalid request");
    }
    let id = message.get("id").cloned()?;
    if session.identity.caller != Caller::Helper || session.check().is_err() { return error(id, -32000, "access refused"); }
    let ok = |value: Value| Some(json!({"jsonrpc":"2.0","id":id,"result":value}));
    match message["method"].as_str().unwrap_or_default() {
        "initialize" => ok(json!({"protocolVersion":"2025-03-26","capabilities":{"tools":{}},
            "serverInfo":{"name":SERVER_NAME,"version":env!("CARGO_PKG_VERSION")},"instructions":INSTRUCTIONS})),
        "ping" => ok(json!({})),
        "tools/list" => ok(json!({"tools": tools()})),
        "tools/call" => {
            let name = message["params"]["name"].as_str().unwrap_or_default();
            let args = message["params"].get("arguments").cloned().unwrap_or(json!({}));
            ok(match call(index, name, &args) {
                Ok(value) => {
                    let text = value.to_string();
                    if text.len() > security::MAX_RESPONSE {
                        json!({"content":[{"type":"text","text":"response too large"}],"isError":true})
                    } else {
                        json!({"content":[{"type":"text","text":text}],"structuredContent":value,"isError":false})
                    }
                }
                Err(e) => json!({"content":[{"type":"text","text":e}],"isError":true}),
            })
        }
        _ => error(id, -32601, "method not found"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const LOCAL: &str = "---\nid: local-models\ntitle: Installing local models\nkeywords: [ollama, model, gpu, pull, offline]\n---\n\nRun models on your own machine.\n\n## Install Ollama\n\n1. Open Settings → Models.\n2. Click Install Ollama.\n\n## Pull a model\n\nPick a model and click Pull. Models need disk space.\n\n```sh\n## not a heading\nollama pull qwen\n```\n\n## Pull a model\n\nDuplicate heading.\n";
    const SYNC: &str = "---\nid: sync\ntitle: Syncing remote projects\nkeywords: [\"git\", 'lockstep', byte-sync]\n---\n## Lockstep\n\nTracked files follow git commits. A model of the peer is kept.\n\n## Byte sync\n\nOpt in per path.\n";
    const PROJECTS: &str = concat!("---\nid: projects\ntitle: Projects\nkeywords: [project, create, folder]\n---\n\n## What a project is\n\nA folder ", crate::app_name!(), " manages.\n");

    fn fixture() -> Index {
        Index::build(&[("sync.md", SYNC), ("local-models.md", LOCAL), ("projects.md", PROJECTS), ("notes.txt", "ignored")])
    }

    #[test]
    fn index_builds_from_a_fixture_corpus() {
        let index = fixture();
        assert!(index.rejected.is_empty(), "{:?}", index.rejected);
        assert_eq!(index.topics.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(), ["local-models", "projects", "sync"]);
        let local = index.topic("local-models").unwrap();
        assert_eq!(local.intro, "Run models on your own machine.");
        let ids: Vec<_> = local.sections.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(ids, ["install-ollama", "pull-a-model", "pull-a-model-2"]);
        assert!(local.sections[1].body.contains("## not a heading"), "a fenced ## is text");
        assert_eq!(index.topic("sync").unwrap().keywords, ["git", "lockstep", "byte-sync"]);
    }

    #[test]
    fn malformed_files_are_rejected_not_served() {
        let index = Index::build(&[
            ("a.md", "no front matter"),
            ("b.md", "---\nid: other\ntitle: B\nkeywords: []\n---\n"),
            ("c.md", "---\nid: c\ntitle: C\nkeywords: a, b\n---\n"),
            ("d.md", "---\nid: d\nkeywords: []\n---\n"),
            ("E.md", "---\nid: E\ntitle: E\nkeywords: []\n---\n"),
            ("f.md", "---\nid: f\ntitle: F\nkeywords: []\n"),
            ("projects.md", PROJECTS),
        ]);
        assert_eq!(index.topics.len(), 1);
        assert_eq!(index.rejected.len(), 6, "{:?}", index.rejected);
    }

    #[test]
    fn search_ranks_title_and_keywords_first_and_is_deterministic() {
        let index = fixture();
        let hits = index.search("How do I install Ollama?", 5);
        assert_eq!((hits[0].id.as_str(), hits[0].section.as_deref()), ("local-models", Some("install-ollama")));
        assert!(hits[0].snippet.contains("Ollama"), "{}", hits[0].snippet);
        // "model" is a keyword of local-models but only body text in sync.
        let hits = index.search("models", 10);
        assert_eq!(hits[0].id, "local-models");
        assert!(hits.iter().any(|h| h.id == "sync"));
        assert!(hits.windows(2).all(|w| w[0].score >= w[1].score));
        assert_eq!(index.search("models", 10), hits, "same query, same answer");
        assert_eq!(index.search("lockstep git", 1)[0].id, "sync");
        assert!(index.search("the and of", 5).is_empty(), "stopwords alone match nothing");
        assert!(index.search("zebra", 5).is_empty());
    }

    #[test]
    fn results_and_reads_are_bounded() {
        let body: String = (0..400).map(|i| format!("## Part {i}\n\n{}\n\n", "ollama words ".repeat(40))).collect();
        let big = format!("---\nid: big\ntitle: Big\nkeywords: [ollama]\n---\n{body}");
        let index = Index::build(&[("big.md", &big)]);
        assert_eq!(index.search("ollama", 1000).len(), MAX_RESULTS);
        assert_eq!(index.search("ollama", 0).len(), 1);
        let read = index.read("big", None).unwrap();
        assert!(read.truncated && read.text.len() <= MAX_TOPIC_BYTES + TRUNCATED.len());
        let one = index.read("big", Some("part-3")).unwrap();
        assert!(!one.truncated && one.text.starts_with("## Part 3"));
        assert!(index.search("ollama", 3).iter().all(|h| h.snippet.chars().count() <= SNIPPET_CHARS));
        // The schema's bounds are enforced before any work.
        let long = "x".repeat(MAX_QUERY_BYTES + 1);
        assert!(call(&index, concat!(crate::app_slug!(), "_help_search"), &json!({"query": long})).is_err());
        assert!(call(&index, concat!(crate::app_slug!(), "_help_search"), &json!({"query": "a", "limit": 11})).is_err());
        assert!(call(&index, concat!(crate::app_slug!(), "_help_search"), &json!({"query": "a", "path": "/etc"})).is_err(), "unknown argument");
        assert!(call(&index, concat!(crate::app_slug!(), "_help_topics"), &json!({"x": 1})).is_err());
    }

    #[test]
    fn unknown_topic_and_section_are_errors_with_a_way_forward() {
        let index = fixture();
        let err = index.read("local-model", None).unwrap_err();
        assert!(err.contains("unknown topic") && err.contains("local-models"), "{err}");
        let err = index.read("sync", Some("nope")).unwrap_err();
        assert!(err.contains("lockstep") && err.contains("byte-sync"), "{err}");
        let read = index.read("sync", Some("lockstep")).unwrap();
        assert_eq!(read.section.as_deref(), Some("lockstep"));
        assert!(call(&index, "mail_read", &json!({})).is_err(), "a root tool is not a help tool");
        assert!(call(&index, "schedule_prompt", &json!({})).is_err());
    }

    #[test]
    fn rpc_serves_only_the_helper_class() {
        let index = fixture();
        let list = json!({"jsonrpc":"2.0","id":1,"method":"tools/list"});
        let call_msg = json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":concat!(crate::app_slug!(), "_help_search"),"arguments":{"query":"ollama"}}});
        for caller in [Caller::Agent, Caller::LocalModel, Caller::Reader, Caller::Scheduler, Caller::Pusher, Caller::Marker] {
            let (_, s) = super::super::root_mcp::test_session(caller);
            assert_eq!(handle_with(&s, &index, &call_msg).unwrap()["error"]["message"], "access refused", "{caller:?}");
            super::super::root_mcp::revoke_tab(&s.identity.tab);
        }
        let (_, s) = super::super::root_mcp::test_session(Caller::Helper);
        let tools = handle_with(&s, &index, &list).unwrap();
        let names: Vec<_> = tools["result"]["tools"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap().to_string()).collect();
        assert_eq!(names, TOOLS);
        assert!(tools["result"]["tools"].as_array().unwrap().iter().all(|t| t["annotations"]["readOnlyHint"] == true));
        let reply = handle_with(&s, &index, &call_msg).unwrap();
        assert_eq!(reply["result"]["isError"], false);
        assert_eq!(reply["result"]["structuredContent"]["results"][0]["id"], "local-models");
        // A root tool name on the help route is unknown, not served.
        let root = json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"projects_list","arguments":{}}});
        assert_eq!(handle_with(&s, &index, &root).unwrap()["result"]["isError"], true);
        assert!(handle_with(&s, &index, &json!({"jsonrpc":"2.0","method":"notifications/initialized"})).is_none());
        // Revocation (the tab closed) refuses the next call.
        assert!(super::super::root_mcp::revoke_tab(&s.identity.tab));
        assert_eq!(handle_with(&s, &index, &call_msg).unwrap()["error"]["message"], "access refused");
    }

    #[test]
    fn registry_keeps_help_and_root_apart() {
        for name in TOOLS {
            let policy = security::tool(name).unwrap();
            assert!(policy.serves(Caller::Helper) && !policy.write);
            for other in [Caller::Agent, Caller::LocalModel, Caller::Reader, Caller::Scheduler, Caller::Pusher, Caller::Marker] {
                assert!(!policy.serves(other), "{name} {other:?}");
            }
        }
        for name in super::super::root_mcp::tool_names() {
            assert!(!security::tool(name).unwrap().serves(Caller::Helper), "{name}");
        }
        for name in super::super::schedule_mcp::tool_names() {
            assert!(security::tool(name).is_none());
        }
    }

    #[test]
    fn status_carries_no_user_state() {
        let s = status(&fixture());
        let keys: Vec<_> = s.as_object().unwrap().keys().cloned().collect();
        assert_eq!(keys.len(), 8, "{keys:?}");
        let text = s.to_string();
        assert!(!text.contains('/') && !text.contains('\\'), "no paths: {text}");
    }

    /// The corpus this binary embeds (`docs/help/*.md`) meets the contract:
    /// every file parses, ids are unique and match their filenames.
    #[test]
    fn real_corpus_parses() {
        let index = Index::build(corpus::HELP_CORPUS);
        assert!(index.rejected.is_empty(), "docs/help files that do not parse: {:?}", index.rejected);
        assert_eq!(index.topics.len(), corpus::HELP_CORPUS.len());
    }
}
