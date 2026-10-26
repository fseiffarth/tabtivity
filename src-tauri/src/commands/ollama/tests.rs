use super::*;

/// An interrupted-pull list that does not parse keeps its entries: a new
/// pull fails to record itself rather than replacing them with its own.
#[test]
fn a_pending_pull_never_replaces_an_unreadable_list() {
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("ollama_pending_pulls.json");
    std::fs::write(&path, "[\"llama3\", ").unwrap();
    assert!(mark_pending_pull_in(&path, "qwen3", true).is_err());
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "[\"llama3\", ");

    std::fs::remove_file(&path).unwrap();
    mark_pending_pull_in(&path, "llama3", true).unwrap();
    mark_pending_pull_in(&path, "qwen3", true).unwrap();
    mark_pending_pull_in(&path, "qwen3", true).unwrap();
    mark_pending_pull_in(&path, "llama3", false).unwrap();
    let list: Vec<String> = crate::storage::read_json(&path).unwrap();
    assert_eq!(list, vec!["qwen3"]);
}

#[test]
fn prose_sentence_stops_preserve_language_punctuation_and_decimals() {
    assert_eq!(completion_stop(" kostet 3.14 Euro. Weiter", true, false), Some(" kostet 3.14 Euro.".len()));
    assert_eq!(completion_stop(" kostet 3.", true, false), None);
    assert_eq!(completion_stop(" fertig!", true, true), Some(" fertig!".len()));
    assert_eq!(completion_stop("一文。次", true, false), Some("一文。".len()));
    assert_eq!(completion_stop("call().next()\nother()", false, false), Some("call().next()".len()));
    for language in ["markdown", "tex", "text", ""] {
        let prompt = completion_prompt("% Ein deutscher Absatz", "", language, CompletionMode::Sentence, "English reference");
        assert!(prompt.contains("Do not translate or switch to English"));
        assert!(!prompt.contains("code that implements"));
    }
}

#[test]
fn completion_fim_uses_native_suffix_and_preserves_whitespace() {
    let body = completion_body(
        "fn f() {",
        "\n}",
        "coder",
        "rust",
        CompletionMode::Sentence,
        "",
        true,
    );
    assert_eq!(body["prompt"], "fn f() {");
    assert_eq!(body["suffix"], "\n}");
    assert!(body.get("messages").is_none());
    assert_eq!(body["options"]["stop"], serde_json::json!(["\n"]));
    assert_eq!(body["stream"], true);
    assert_eq!(body["think"], false);
    assert_eq!(
        completion_preview("\n    return 1;\n", true, true, "", ""),
        "\n    return 1;\n"
    );
}

#[test]
fn completion_chat_keeps_reference_context_and_language_instruction() {
    let body = completion_body(
        "Ein Satz",
        ".",
        "chat",
        "markdown",
        CompletionMode::Block,
        "notes",
        false,
    );
    assert!(body.get("suffix").is_none());
    assert!(body["messages"][1]["content"]
        .as_str()
        .unwrap()
        .contains("notes"));
    assert!(body["messages"][0]["content"]
        .as_str()
        .unwrap()
        .contains("never translate"));
    assert_eq!(
        body["options"]["num_predict"],
        CompletionMode::Block.num_predict()
    );
}

#[test]
fn completion_stream_withholds_partial_wrappers() {
    assert_eq!(completion_preview("```py", false, false, "", ""), "");
    assert_eq!(completion_preview("Here is the", false, false, "", ""), "");
    assert_eq!(
        completion_preview(
            "Here is the continuation:\n```py\nreturn",
            false,
            false,
            "",
            ""
        ),
        "return"
    );
    assert_eq!(
        completion_preview("return a + b", false, true, "return ", ""),
        "a + b"
    );
    assert_eq!(completion_preview("x\nnext", false, true, "", "next"), "x");
}

#[test]
fn completion_backend_window_is_utf8_safe() {
    let text = "界".repeat(10_000);
    let tail = bounded_completion_prefix(&text);
    assert!(tail.len() <= 16_384);
    assert!(text.ends_with(&tail));
}

#[test]
fn partial_file_match_takes_the_layer_and_its_chunks_only() {
    let main = "sha256-ab12-partial";
    assert!(is_partial_file_of("sha256-ab12-partial", main));
    assert!(is_partial_file_of("sha256-ab12-partial-0", main));
    assert!(is_partial_file_of("sha256-ab12-partial-15", main));
    assert!(!is_partial_file_of("sha256-ab12-partial-", main));
    assert!(!is_partial_file_of("sha256-ab12-partial-x", main));
    assert!(!is_partial_file_of("sha256-ab12", main));
    assert!(!is_partial_file_of("sha256-ab123-partial", main));
}

#[test]
fn remove_blob_files_ignores_already_gone_files() {
    let dir = tempfile::tempdir().unwrap();
    let kept = dir.path().join("sha256-ab12-partial");
    std::fs::write(&kept, b"x").unwrap();
    let gone = dir.path().join("sha256-ab12-partial-0");
    assert!(remove_blob_files(&[kept.clone(), gone]).is_ok());
    assert!(!kept.exists());
}
use std::io::Write;

// ── Helper: simulate prepare_local_agent using a tmp base dir ─────────────

fn write_agent_config(base: &std::path::Path, model: &str) -> (std::path::PathBuf, String) {
    let alias = sanitize_alias(model);
    let vibe_home = base.join(&alias);
    std::fs::create_dir_all(&vibe_home).unwrap();
    let config_path = vibe_home.join("config.toml");
    let mut cfg = format!("active_model = \"{alias}\"\nenabled_tools = [\"__no_tools__\"]\n");
    cfg.push_str(&ollama_provider_block());
    cfg.push_str(&ollama_model_block(model, &alias));
    std::fs::write(&config_path, &cfg).unwrap();
    (vibe_home, alias)
}

// ── model-name validation (TOML injection defense) ───────────────────────

#[test]
fn validate_model_name_accepts_real_refs() {
    for ok in [
        "llama3.2:1b",
        "qwen2.5-coder:7b",
        "library/llama3:latest",
        "registry.example.com/ns/model:tag",
        "model@sha256",
        "phi-4",
    ] {
        assert!(validate_model_name(ok).is_ok(), "{ok} should be accepted");
    }
}

#[test]
fn validate_model_name_rejects_toml_injection() {
    // A `"` closes the TOML basic string; a newline lets the attacker append
    // arbitrary keys/tables. Both — and other shell/TOML metacharacters and
    // control chars — must be rejected.
    for bad in [
        "model\"\nmalicious_key = \"x",
        "model\nenabled_tools = []",
        "a\"b",
        "back`tick",
        "with space",
        "tab\tinside",
        "",
        "   ",
    ] {
        assert!(
            validate_model_name(bad).is_err(),
            "{bad:?} should be rejected"
        );
    }
}

/// Step 9 review: the name is also the Vibe home's folder, which "Clear
/// conversations" deletes from and `prepare_local_agent` writes. A name
/// that is absolute or climbs out (`/home/u/.vibe`, `../../.vibe`) would
/// point both at a folder outside `vibe_local` — the user's own Vibe's.
#[test]
fn validate_model_name_rejects_path_escapes() {
    for bad in ["/home/u/.vibe", "../../../.vibe", "a/../../b", "./x", "a//b", "a/", "..", "."] {
        assert!(validate_model_name(bad).is_err(), "{bad:?} should be rejected");
    }
    for ok in ["hf.co/user/repo:Q4_K_M", "a..b:c", ".hidden-ish:1", "x/y.z:latest"] {
        assert!(validate_model_name(ok).is_ok(), "{ok:?} should be accepted");
    }
    // Refused before anything is read or deleted (`prepare_local_agent`
    // validates first too; not called here, as a regression would write
    // into the real share dir's neighbourhood). Neither path exists, so
    // the old code answered `Ok` here.
    let rt = tokio::runtime::Builder::new_current_thread().build().unwrap();
    for bad in ["/nonexistent-vibe-home-for-a-test", "../../../nonexistent-vibe-home-for-a-test"] {
        assert!(rt.block_on(clear_local_model_conversations(bad.to_string())).is_err(), "{bad}");
    }
}

// ── local-driver registry (ollama launch + fallbacks) ────────────────────

// ── the tool-capability gate ─────────────────────────────────────────────

#[test]
fn a_completion_only_model_withholds_every_tool_calling_agent() {
    // The bug this exists for: picking a completion-only model (`llama3`) in
    // the 🧠 menu left Codex in the + menu, and the tab it opened died on its
    // first request with `does not support tools`.
    for d in LOCAL_DRIVERS {
        let (available, blocked) = driver_verdict(d.needs_tools, true, true);
        assert!(!available, "{} should be withheld", d.id);
        assert!(blocked, "{} should say the model is why", d.id);
    }
}

#[test]
fn an_unreadable_capability_list_never_hides_an_agent() {
    // `model_supports_tools` answers `None` when Ollama is down or too old
    // to report capabilities, which reaches the verdict as `false`. A probe
    // failure must not empty the menu — an agent that errors is recoverable,
    // an agent that silently vanished is not diagnosable.
    for d in LOCAL_DRIVERS {
        let (available, blocked) = driver_verdict(d.needs_tools, true, false);
        assert!(available, "{} should still be offered", d.id);
        assert!(!blocked);
    }
}

#[test]
fn a_missing_binary_is_not_reported_as_a_model_problem() {
    // Two different failures with two different fixes: the menu says
    // "install the agent" for one and "pick another model" for the other,
    // and an uninstalled agent must never claim the latter.
    let (available, blocked) = driver_verdict(true, false, true);
    assert!(!available);
    assert!(!blocked);
}

#[test]
fn every_local_driver_needs_tools() {
    // vibe is the deliberate exception and is deliberately not in this
    // list — it turns tools off (`enabled_tools = ["__no_tools__"]`), which
    // is exactly why it still runs on a completion-only model. If an entry
    // here ever stops needing tools, this assertion is where to say so.
    assert!(LOCAL_DRIVERS.iter().all(|d| d.needs_tools));
}

// ── update checks ────────────────────────────────────────────────────────

#[test]
fn the_manifest_url_defaults_the_namespace_and_the_tag() {
    assert_eq!(
        registry_manifest_url("deepcoder").unwrap(),
        "https://registry.ollama.ai/v2/library/deepcoder/manifests/latest"
    );
    assert_eq!(
        registry_manifest_url("qwen3-coder:30b").unwrap(),
        "https://registry.ollama.ai/v2/library/qwen3-coder/manifests/30b"
    );
    // An explicit namespace is kept rather than nested under `library/`.
    assert_eq!(
        registry_manifest_url("hf.co/someone/model:q4").unwrap(),
        "https://registry.ollama.ai/v2/hf.co/someone/model/manifests/q4"
    );
}

#[test]
fn the_digest_header_is_read_case_insensitively_and_last_wins() {
    // HTTP/2 lowercases header names and HTTP/1.1 does not, and a redirect
    // leaves several head blocks in curl's output — the manifest came with
    // the last one.
    let head = "HTTP/1.1 301 Moved\r\n\
                    Ollama-Content-Digest: sha256:old\r\n\
                    \r\n\
                    HTTP/2 200\r\n\
                    ollama-content-digest: sha256:new\r\n\
                    ollama-push-time: 1744152652\r\n\r\n";
    assert_eq!(
        header_value(head, "ollama-content-digest").as_deref(),
        Some("sha256:new")
    );
    assert_eq!(
        header_value(head, "OLLAMA-PUSH-TIME").as_deref(),
        Some("1744152652")
    );
    assert_eq!(header_value(head, "etag"), None);
}

// ── the Ollama server's own version ──────────────────────────────────────

#[test]
fn the_installed_version_is_found_whatever_else_the_command_printed() {
    assert_eq!(
        parse_version("ollama version is 0.14.3\n").as_deref(),
        Some("0.14.3")
    );
    // The real output when the server isn't running: a warning line first,
    // which is why this scans rather than taking a fixed field.
    assert_eq!(
        parse_version(
            "Warning: could not connect to a running Ollama instance\n\
                 ollama version is 0.32.5\n"
        )
        .as_deref(),
        Some("0.32.5")
    );
    // A release tag, straight out of the API's JSON.
    assert_eq!(
        parse_version("\"tag_name\": \"v0.32.5\",").as_deref(),
        Some("0.32.5")
    );
    assert_eq!(parse_version("no version here").as_deref(), None);
}

#[test]
fn versions_compare_numerically_not_lexically() {
    // The bug a string compare would have: "0.9.0" > "0.14.3" as text, so
    // most of Ollama's history would have reported a downgrade as an update.
    assert_eq!(version_is_newer("0.14.3", "0.9.0"), Some(true));
    assert_eq!(version_is_newer("0.9.0", "0.14.3"), Some(false));
    assert_eq!(version_is_newer("0.32.5", "0.14.3"), Some(true));
    assert_eq!(version_is_newer("0.14.3", "0.14.3"), Some(false));
    // A missing component is zero — 0.15 and 0.15.0 are one version.
    assert_eq!(version_is_newer("0.15", "0.15.0"), Some(false));
    assert_eq!(version_is_newer("0.15.1", "0.15"), Some(true));
    // The leading `v` of a tag, and a pre-release suffix, are both handled.
    assert_eq!(version_is_newer("v0.16.0", "0.15.9"), Some(true));
    assert_eq!(version_is_newer("0.16.0-rc1", "0.15.9"), Some(true));
    // Unparseable on either side is "couldn't tell", never an update.
    assert_eq!(version_is_newer("dev", "0.14.3"), None);
    assert_eq!(version_is_newer("0.14.3", ""), None);
}

#[test]
fn an_unreachable_registry_is_not_an_up_to_date_verdict() {
    // The whole point of carrying `error` per model: "couldn't check" and
    // "current" must never render the same, and neither may raise a badge.
    let out = wanted_updates(vec![("no-such-model-xyz".into(), "sha256:local".into())]);
    assert_eq!(out.len(), 1);
    assert!(!out[0].update_available);
    assert!(out[0].error.is_some(), "a failure must say so");
}

#[test]
fn codex_fallback_substitutes_model_for_oss_mode() {
    let d = LOCAL_DRIVERS.iter().find(|d| d.id == "codex").unwrap();
    let spec = fallback_spec(d, "qwen2.5-coder:7b", &[]).expect("codex has a fallback");
    assert_eq!(spec.cmd, "codex");
    // `oss_provider` rides every codex fallback, not just the non-thinking
    // one: codex ≥0.146 refuses a bare `--oss` with "No default OSS
    // provider configured", i.e. the tab dies before it reaches Ollama.
    assert_eq!(
        spec.args,
        vec![
            "--oss",
            "-c",
            "oss_provider=\"ollama\"",
            "-m",
            "qwen2.5-coder:7b"
        ]
    );
}

#[test]
fn opencode_fallback_prefixes_the_ollama_provider() {
    let d = LOCAL_DRIVERS.iter().find(|d| d.id == "opencode").unwrap();
    let spec = fallback_spec(d, "llama3.2", &[]).expect("opencode has a fallback");
    assert_eq!(spec.cmd, "opencode");
    assert_eq!(spec.args, vec!["--model", "ollama/llama3.2"]);
    // Direct only: `ollama launch` would override the injected model list.
    assert!(d.launch_sub.is_none());
}

fn argv(a: &[&str]) -> Vec<String> {
    a.iter().map(|s| s.to_string()).collect()
}

#[test]
fn opencode_spawn_model_recognises_every_opencode_launch_shape() {
    assert_eq!(opencode_spawn_model("opencode", &[]), Some(None));
    assert_eq!(
        opencode_spawn_model("/home/u/.opencode/bin/opencode", &argv(&["--model", "ollama/qwen3:8b"])),
        Some(Some("qwen3:8b".into()))
    );
    assert_eq!(
        opencode_spawn_model("opencode", &argv(&["--model=ollama/qwen3:8b"])),
        Some(Some("qwen3:8b".into()))
    );
    // Another provider's model is not an Ollama request.
    assert_eq!(
        opencode_spawn_model("opencode", &argv(&["-m", "anthropic/claude"])),
        Some(None)
    );
    assert_eq!(
        opencode_spawn_model("ollama", &argv(&["launch", "opencode", "--model", "qwen3:8b"])),
        Some(Some("qwen3:8b".into()))
    );
    assert_eq!(opencode_spawn_model("ollama", &argv(&["launch", "codex"])), None);
    assert_eq!(opencode_spawn_model("codex", &[]), None);
}

#[test]
fn loaded_model_names_reads_api_ps() {
    let body = r#"{"models":[{"name":"nemotron:30b","model":"nemotron:30b"},{"model":"qwen3:8b"}]}"#;
    assert_eq!(
        loaded_model_names(body),
        Some(vec!["nemotron:30b".to_string(), "qwen3:8b".to_string()])
    );
    assert_eq!(loaded_model_names(r#"{"models":[]}"#), Some(vec![]));
    assert_eq!(loaded_model_names("garbage"), None);
}

#[test]
fn opencode_config_whitelists_the_loaded_models_plus_the_requested_one() {
    let cfg: serde_json::Value = serde_json::from_str(&opencode_ollama_config(
        "127.0.0.1:11434",
        &["nemotron:30b".to_string()],
        Some("qwen3:8b"),
    ))
    .unwrap();
    let p = &cfg["provider"]["ollama"];
    assert_eq!(p["options"]["baseURL"], "http://127.0.0.1:11434/v1");
    assert_eq!(p["whitelist"], serde_json::json!(["nemotron:30b", "qwen3:8b"]));
    assert_eq!(p["models"]["nemotron:30b"]["name"], "nemotron:30b");
    assert!(p["models"]["qwen3:8b"].is_object());

    // Nothing loaded: an empty whitelist, so stale config models drop out.
    let cfg: serde_json::Value =
        serde_json::from_str(&opencode_ollama_config("h:1", &[], None)).unwrap();
    assert_eq!(cfg["provider"]["ollama"]["whitelist"], serde_json::json!([]));
}

#[test]
fn launch_only_drivers_have_no_fallback() {
    // These need `ollama launch`; there is no hand-rolled spec.
    for id in ["claude", "droid", "openclaw", "pi", "cline"] {
        let d = LOCAL_DRIVERS.iter().find(|d| d.id == id).unwrap();
        assert!(
            fallback_spec(d, "any:model", &[]).is_none(),
            "{id} must be launch-only"
        );
        assert!(d.launch_sub.is_some(), "{id} must support ollama launch");
    }
}

// ── the thinking gate ────────────────────────────────────────────────────

#[test]
fn codex_turns_reasoning_off_only_for_a_non_thinking_model() {
    // The bug this exists for: `qwen3-coder` reports `tools` but not
    // `thinking`, so it passed the tool gate and then died on its first
    // turn with `"qwen3-coder:latest" does not support thinking` — Codex
    // sends `model_reasoning_effort` (default `medium`, and usually set
    // outright in the user's ~/.codex/config.toml) and Ollama rejects the
    // whole request rather than ignoring the field.
    let d = LOCAL_DRIVERS.iter().find(|d| d.id == "codex").unwrap();

    let off = non_thinking_override(d, Some(false));
    assert_eq!(off, ["-c", "model_reasoning_effort=\"none\""]);
    let spec = fallback_spec(d, "qwen3-coder:latest", off).expect("codex has a fallback");
    assert_eq!(
        spec.args.last().map(String::as_str),
        Some("model_reasoning_effort=\"none\"")
    );

    // A thinking model keeps its reasoning: forcing it off would silently
    // downgrade every reasoning-capable local model to a worse agent.
    assert!(non_thinking_override(d, Some(true)).is_empty());
    // And "could not tell" changes nothing — same rule as the tool gate.
    assert!(non_thinking_override(d, None).is_empty());
}

#[test]
fn pi_leads_with_opencode_and_cline_is_cautioned() {
    // Light-harness drivers lead the menu ahead of Mistral; Pi is built
    // for small models, Cline's prompt for a frontier one.
    let ids: Vec<&str> = LOCAL_DRIVERS.iter().filter(|d| !d.heavy_harness).map(|d| d.id).collect();
    assert_eq!(ids, ["opencode", "pi"]);
    let cline = LOCAL_DRIVERS.iter().find(|d| d.id == "cline").unwrap();
    assert!(cline.heavy_harness);
    assert_eq!(local_driver_bin("pi"), Some("pi"));
    assert_eq!(local_driver_bin("cline"), Some("cline"));
}

#[test]
fn an_agent_that_sends_no_reasoning_is_left_alone() {
    for id in ["claude", "opencode", "droid", "openclaw", "pi", "cline"] {
        let d = LOCAL_DRIVERS.iter().find(|d| d.id == id).unwrap();
        assert!(
            non_thinking_override(d, Some(false)).is_empty(),
            "{id} must not be rewritten for a non-thinking model"
        );
    }
}

#[test]
fn the_local_catalog_carries_the_two_facts_only_ollama_knows() {
    let doc: serde_json::Value = serde_json::from_str(&local_catalog_json(
        "qwen3-coder:latest",
        Some(false),
        Some(262_144),
        false,
    ))
    .expect("catalog is valid JSON");
    let m = &doc["models"][0];
    assert_eq!(m["slug"], "qwen3-coder:latest");
    // The whole point of writing one: Codex's fallback metadata does not
    // know this number, so it compacts against a guess.
    assert_eq!(m["context_window"], 262_144);
    assert_eq!(m["supported_reasoning_levels"].as_array().unwrap().len(), 0);
    assert_eq!(m["input_modalities"].as_array().unwrap().len(), 1);

    // A thinking model keeps its levels, and a vision model its modality.
    let doc: serde_json::Value =
        serde_json::from_str(&local_catalog_json("m:latest", Some(true), None, true)).unwrap();
    let m = &doc["models"][0];
    assert!(!m["supported_reasoning_levels"]
        .as_array()
        .unwrap()
        .is_empty());
    assert!(m["input_modalities"]
        .as_array()
        .unwrap()
        .iter()
        .any(|v| v == "image"));
    // An unknown window is absent, never a plausible-looking default.
    assert!(m.get("context_window").is_none());

    // "Could not tell" must not strip a capability, same as the tool gate.
    let doc: serde_json::Value =
        serde_json::from_str(&local_catalog_json("m:latest", None, None, false)).unwrap();
    assert!(!doc["models"][0]["supported_reasoning_levels"]
        .as_array()
        .unwrap()
        .is_empty());
}

#[test]
fn a_persisted_local_launch_line_must_be_one_app_builds() {
    let v = |args: &[&str]| args.iter().map(|a| a.to_string()).collect::<Vec<_>>();
    let m = "qwen3-coder:30b";
    // `ollama launch`, for a driver that has it.
    assert!(local_launch_line_ok("claude", m, "ollama", &v(&["launch", "claude", "--model", m])));
    assert!(local_launch_line_ok("droid", m, "ollama", &v(&["launch", "droid", "--model", m])));
    assert!(local_launch_line_ok("pi", m, "ollama", &v(&["launch", "pi", "--model", m])));
    assert!(local_launch_line_ok("cline", m, "ollama", &v(&["launch", "cline", "--model", m])));
    assert!(!local_launch_line_ok("pi", m, "pi", &v(&["--model", m])));
    // Direct fallbacks, with and without the reasoning-off override.
    assert!(local_launch_line_ok("opencode", m, "opencode", &v(&["--model", &format!("ollama/{m}")])));
    let codex = fallback_spec(
        LOCAL_DRIVERS.iter().find(|d| d.id == "codex").unwrap(),
        m,
        &["-c", "model_reasoning_effort=\"none\""],
    )
    .unwrap();
    assert!(local_launch_line_ok("codex", m, "codex", &codex.args));
    // Codex's catalog pair rides after either form, and only the path
    // Tabtivity writes it to.
    let mut with_catalog = codex.args.clone();
    with_catalog.extend(catalog_arg_pair(&local_catalog_path(m)));
    assert!(local_launch_line_ok("codex", m, "codex", &with_catalog));
    let mut elsewhere = codex.args.clone();
    elsewhere.extend(catalog_arg_pair(std::path::Path::new("/tmp/x.json")));
    assert!(!local_launch_line_ok("codex", m, "codex", &elsewhere));

    // Anything else is refused: another sub, another model, an extra
    // flag, a driver without a fallback run directly, an unknown driver,
    // a model that reads as a flag, and a line of another driver.
    assert!(!local_launch_line_ok("claude", m, "ollama", &v(&["launch", "codex", "--model", m])));
    assert!(!local_launch_line_ok("claude", m, "ollama", &v(&["launch", "claude", "--model", "other"])));
    assert!(!local_launch_line_ok("claude", m, "ollama", &v(&["launch", "claude", "--model", m, "--yes"])));
    assert!(!local_launch_line_ok("claude", m, "claude", &v(&["--model", m])));
    assert!(!local_launch_line_ok("vibe", m, "vibe", &[]));
    let flag = "--dangerously-skip-permissions";
    assert!(!local_launch_line_ok("claude", flag, "ollama", &v(&["launch", "claude", "--model", flag])));
    assert!(!local_launch_line_ok("opencode", m, "ollama", &v(&["launch", "claude", "--model", m])));
    assert_eq!(local_driver_bin("opencode"), Some("opencode"));
    assert_eq!(local_driver_bin("nope"), None);
}

/// The chat assistant builds its local lines from the driver table, not a
/// copy of it, and takes a model name only as a plain argument.
#[test]
fn the_pinned_local_line_is_the_drivers_own_and_takes_only_plain_names() {
    let m = "qwen3-coder:30b";
    let claude = pinned_local_line("claude", m).unwrap();
    assert_eq!((claude.cmd.as_str(), claude.args.as_slice()), ("ollama", ["launch", "claude", "--model", m].map(String::from).as_slice()));
    let opencode = pinned_local_line("opencode", m).unwrap();
    assert_eq!(opencode.cmd, "opencode");
    assert_eq!(opencode.args, ["--model", &format!("ollama/{m}")]);
    for spec in [&claude, &opencode] {
        let driver = if spec.cmd == "ollama" { "claude" } else { "opencode" };
        assert!(local_launch_line_ok(driver, m, &spec.cmd, &spec.args));
    }
    // Codex has the direct form only with its catalog, so the plain line
    // here is the fallback's; an unknown driver has none.
    assert!(pinned_local_line("nope", m).is_none());
    for bad in ["--yes", "-m", "", " m", "m ", "a b", "m\"x", "../m", "a//b"] {
        assert!(pinned_local_line("claude", bad).is_none(), "{bad:?}");
        assert!(!model_name_ok(bad), "{bad:?}");
    }
    assert!(model_name_ok("hf.co/org/model-GGUF:Q4_K_M") && model_name_ok("llama3:latest"));
    // The provider block always names the requested model, Ollama up or not.
    let config: serde_json::Value = serde_json::from_str(&opencode_assistant_provider(m)).unwrap();
    assert!(config["provider"]["ollama"]["models"][m].is_object());
}

#[test]
fn only_a_driver_with_a_fallback_asks_for_a_catalog() {
    // The catalog rides the direct invocation's argv; `ollama launch`
    // generates its own and is not trusted to forward args, so a launch-only driver
    // asking for one would silently get nothing.
    for d in LOCAL_DRIVERS {
        if d.wants_local_catalog {
            assert!(d.fallback.is_some(), "{} needs a fallback", d.id);
        }
    }
}

#[test]
fn a_reasoning_override_requires_a_fallback_to_ride() {
    // An older `ollama launch` forwards nothing — it rejects an extra flag
    // with `unknown shorthand flag` — so a driver that needs the override and
    // has no direct invocation would report the launch-only error message,
    // which names the wrong problem and an update that wouldn't fix it.
    for d in LOCAL_DRIVERS {
        if d.non_thinking_args.is_some() {
            assert!(
                d.fallback.is_some(),
                "{} needs a fallback to carry its reasoning override",
                d.id
            );
        }
    }
}

#[test]
fn model_block_with_validated_name_has_no_stray_quotes_or_newlines_in_value() {
    // Defense in depth: once validated, the interpolated name can never break
    // out of its `name = "<...>"` TOML string.
    let model = "qwen2.5-coder:7b";
    assert!(validate_model_name(model).is_ok());
    let block = ollama_model_block(model, &sanitize_alias(model));
    let name_line = block
        .lines()
        .find(|l| l.starts_with("name = "))
        .expect("name line");
    assert_eq!(name_line, "name = \"qwen2.5-coder:7b\"");
}

// ── active_model is always the first line of the per-model config ─────────

#[test]
fn prepare_local_agent_config_has_active_model_first() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let (vibe_home, alias) = write_agent_config(tmp.path(), "llama3:latest");

    let written = std::fs::read_to_string(vibe_home.join("config.toml")).unwrap();
    let first_line = written.lines().next().unwrap_or("");
    assert_eq!(first_line, format!("active_model = \"{alias}\""),
        "active_model must be the first config line so it is not shadowed by the global ~/.vibe/config.toml");
}

// ── each model gets its own directory so configs never collide ────────────

#[test]
fn prepare_local_agent_uses_per_alias_directory() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let (home_a, alias_a) = write_agent_config(tmp.path(), "llama3:latest");
    let (home_b, alias_b) = write_agent_config(tmp.path(), "qwen2:7b");

    // Directories are distinct.
    assert_ne!(home_a, home_b);
    assert!(home_a.ends_with(&alias_a));
    assert!(home_b.ends_with(&alias_b));

    // Each config's active_model matches its own alias — not the other's.
    let cfg_a = std::fs::read_to_string(home_a.join("config.toml")).unwrap();
    let cfg_b = std::fs::read_to_string(home_b.join("config.toml")).unwrap();
    assert!(cfg_a.contains(&format!("active_model = \"{alias_a}\"")));
    assert!(!cfg_a.contains(&format!("active_model = \"{alias_b}\"")));
    assert!(cfg_b.contains(&format!("active_model = \"{alias_b}\"")));
    assert!(!cfg_b.contains(&format!("active_model = \"{alias_a}\"")));
}

// ── config contains exactly the requested model, provider, and no-tools ──

#[test]
fn prepare_local_agent_config_structure() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let model = "mistral:latest";
    let (vibe_home, alias) = write_agent_config(tmp.path(), model);

    let cfg = std::fs::read_to_string(vibe_home.join("config.toml")).unwrap();
    assert!(
        cfg.contains("enabled_tools = [\"__no_tools__\"]"),
        "tool calls must be disabled for local models"
    );
    assert!(
        cfg.contains("name = \"ollama\""),
        "ollama provider block required"
    );
    assert!(
        cfg.contains(&format!("name = \"{model}\"")),
        "model name must appear"
    );
    assert!(
        cfg.contains(&format!("alias = \"{alias}\"")),
        "model alias must appear"
    );
}

// ── friendly error mapping: broken Ollama runner (#vibe 500) ─────────────

#[test]
fn friendly_ollama_error_detects_missing_runner() {
    // The exact shape Ollama returns when its llama-server binary is absent —
    // this is what surfaces through vibe as an "internal server error".
    let raw = "error starting llama-server: llama-server binary not found \
            (checked: /usr/local/lib/ollama/llama-server, ...). Run 'cmake -S \
            llama/server --preset cpu && cmake --build --preset cpu' first";
    let msg = friendly_ollama_error(raw);
    assert!(
        msg.contains("inference runner") && msg.contains("incomplete"),
        "missing-runner error should be rewritten to an actionable message, got: {msg}"
    );
    // It points the user at the reinstall command.
    assert!(msg.contains(ollama_install_cmd()));
    // And it no longer leaks the raw cmake/build hint.
    assert!(!msg.contains("cmake"));
}

#[test]
fn friendly_ollama_error_is_case_insensitive() {
    let msg = friendly_ollama_error("LLAMA-SERVER binary NOT FOUND");
    assert!(msg.contains("inference runner"));
}

#[test]
fn friendly_ollama_error_passes_through_unrelated() {
    // Errors we don't special-case must be returned verbatim, not swallowed.
    for raw in [
        "model 'foo' not found, try pulling it first",
        "out of memory",
        "HTTP 500",
    ] {
        assert_eq!(friendly_ollama_error(raw), raw);
    }
}

// ── registry search HTML parsing ─────────────────────────────────────────

// Trimmed-down but structurally faithful fixture of two ollama.com/search
// result cards, matching the post-2026-redesign markup (no `x-test-*`
// hooks): the title links to `/library/<name>`, badges are colour-coded
// `rounded-md bg-…` spans, and the pull count / updated label sit in the
// meta row. nomic deliberately carries no size badge (embedding models omit
// one on the live page), exercising the empty-sizes path.
const SEARCH_FIXTURE: &str = r#"
      <ul role="list">
      <li  class="flex items-baseline border-b border-neutral-200 py-6">
        <a href="/library/glm-5.2" class="group w-full">
          <div class="flex flex-col mb-1" title="glm-5.2">
            <h2 class="truncate text-xl"><span >glm-5.2</span></h2>
            <p class="max-w-lg break-words text-neutral-800 text-md">GLM-5.2 is Z.ai&#39;s flagship model &amp; more.</p>
          </div>
          <div class="flex flex-col">
            <div class="flex flex-wrap space-x-2">
              <span  class="inline-flex my-1 items-center rounded-md bg-indigo-50 px-2 py-[2px] text-xs text-indigo-600">tools</span>
              <span  class="inline-flex my-1 items-center rounded-md bg-indigo-50 px-2 py-[2px] text-xs text-indigo-600">thinking</span>
              <span  class="inline-flex my-1 items-center rounded-md bg-[#ddf4ff] px-2 py-[2px] text-xs text-blue-600">8b</span>
              <span  class="inline-flex my-1 items-center rounded-md bg-[#ddf4ff] px-2 py-[2px] text-xs text-blue-600">355b</span>
            </div>
            <p class="my-1 flex space-x-5 text-[13px] text-neutral-500">
              <span class="flex items-center"><svg></svg><span >65.8K</span><span class="hidden sm:flex">&nbsp;Pulls</span></span>
              <span class="flex items-center"><svg></svg><span >93</span><span class="hidden sm:flex">&nbsp;Tags</span></span>
              <span class="flex items-center" title="Sep 30, 2026 10:34 PM UTC"><svg></svg><span class="hidden sm:flex">Updated&nbsp;</span><span >1 week ago</span></span>
            </p>
          </div>
        </a>
      </li>
      <li  class="flex items-baseline border-b border-neutral-200 py-6">
        <a href="/library/nomic-embed-text" class="group w-full">
          <div class="flex flex-col mb-1" title="nomic-embed-text">
            <h2 class="truncate text-xl"><span >nomic-embed-text</span></h2>
            <p class="max-w-lg break-words text-neutral-800 text-md">High-quality text embeddings.</p>
          </div>
          <div class="flex flex-col">
            <div class="flex flex-wrap space-x-2">
              <span  class="inline-flex my-1 items-center rounded-md bg-indigo-50 px-2 py-[2px] text-xs text-indigo-600">embedding</span>
            </div>
            <p class="my-1 flex space-x-5 text-[13px] text-neutral-500">
              <span class="flex items-center"><svg></svg><span >30M</span><span class="hidden sm:flex">&nbsp;Pulls</span></span>
              <span class="flex items-center" title="Feb 21, 2024 5:26 PM UTC"><svg></svg><span class="hidden sm:flex">Updated&nbsp;</span><span >1 year ago</span></span>
            </p>
          </div>
        </a>
      </li>
      </ul>"#;

#[test]
fn parse_search_html_extracts_all_fields() {
    let page = parse_search_html(SEARCH_FIXTURE);
    assert!(!page.has_more);
    let models = page.models;
    assert_eq!(models.len(), 2);

    let glm = &models[0];
    assert_eq!(glm.name, "glm-5.2");
    assert!(!glm.community);
    // HTML entities are unescaped.
    assert_eq!(glm.description, "GLM-5.2 is Z.ai's flagship model & more.");
    assert_eq!(glm.capabilities, vec!["tools", "thinking"]);
    assert_eq!(glm.sizes, vec!["8b", "355b"]);
    assert_eq!(glm.pulls, "65.8K");
    assert_eq!(glm.updated, "1 week ago");

    let nomic = &models[1];
    assert_eq!(nomic.name, "nomic-embed-text");
    assert_eq!(nomic.capabilities, vec!["embedding"]);
    assert!(nomic.sizes.is_empty());
    assert_eq!(nomic.pulls, "30M");
    assert_eq!(nomic.updated, "1 year ago");
}

// The current ollama.com/search markup, trimmed: the description is the
// card's first <p>, the pull count sits in a `title="… downloads"` span, the
// update label is a short `2mo` under `title="Updated …"`, and community
// models (`/<user>/<name>`) follow the library ones in the same list.
const SEARCH_FIXTURE_CURRENT: &str = r#"
<ul role="list" class="overflow-hidden rounded-3xl">
<li  class="border-t-[0.5px] border-line first:border-t-0">
  <a href="/library/gemma4" class="group grid grid-cols-1 gap-x-4 px-4 py-6">
    <div class="flex min-w-0 items-baseline gap-2.5">
      <h2 class="min-w-0 truncate text-xl" title="gemma4"><span >gemma4</span></h2>
      <span class="flex-none text-[15px] tabular-nums text-muted" title="Updated October 12, 2026">1w</span>
    </div>
    <div class="order-last mt-3 flex flex-wrap items-center gap-2"><span  class="inline-flex items-center rounded-md bg-indigo-50 px-2 py-0.5 text-xs">vision</span><span  class="inline-flex items-center rounded-md bg-indigo-50 px-2 py-0.5 text-xs">tools</span>
      <span  class="inline-flex items-center rounded-md bg-cyan-50 px-2 py-0.5 text-xs">cloud</span>
    </div>
    <p class="mt-1 line-clamp-2 text-[15px] leading-6 text-black sm:col-span-2">Gemma 4 models &amp; more.</p>
    <div class="mt-3 flex flex-wrap items-center gap-2 text-sm">
      <span class="inline-flex items-center gap-1.5 tabular-nums text-ink sm:mr-1" title="27,871,499 downloads"><svg class="flex-none" width="15"><path d="M12 3.5v12"/></svg><span >27.9M</span></span>
      <span class="inline-flex items-center gap-1.5 tabular-nums text-ink sm:mr-1"><svg></svg><span >51 tags</span></span>
      <span  class="inline-flex items-center rounded-md bg-[#ddf4ff] px-2 py-0.5 text-xs">e4b</span>
      <span  class="inline-flex items-center rounded-md bg-[#ddf4ff] px-2 py-0.5 text-xs">26b</span>
    </div>
  </a>
</li>
<li  class="border-t-[0.5px] border-line first:border-t-0">
  <a href="/library/glm-5.3-flash" class="group grid grid-cols-1 gap-x-4 px-4 py-6">
    <div class="flex min-w-0 items-baseline gap-2.5">
      <h2 class="min-w-0 truncate text-xl" title="glm-5.3-flash"><span >glm-5.3-flash</span></h2>
      <span class="flex-none text-[15px] tabular-nums text-muted" title="Updated August 26, 2026">2mo</span>
    </div>
    <div class="order-last mt-3 flex flex-wrap items-center gap-2"><span  class="inline-flex items-center rounded-md bg-indigo-50 px-2 py-0.5 text-xs">vision</span><span  class="inline-flex items-center rounded-md bg-indigo-50 px-2 py-0.5 text-xs">thinking</span>
      <span  class="inline-flex items-center rounded-md bg-cyan-50 px-2 py-0.5 text-xs">cloud</span>
    </div>
    <p class="mt-1 line-clamp-2 text-[15px] leading-6 text-black sm:col-span-2">Z.ai&#39;s first natively multimodal model.</p>
    <div class="mt-3 flex flex-wrap items-center gap-2 text-sm">
      <span class="inline-flex items-center gap-1.5 text-ink sm:mr-1" title="Context window"><svg></svg><span >1M</span></span>
    </div>
  </a>
</li>
<li  class="border-t-[0.5px] border-line first:border-t-0">
  <a href="/someone/gemma4-uncensored" class="group grid grid-cols-1 gap-x-4 px-4 py-6">
    <div class="flex min-w-0 items-baseline gap-2.5">
      <h2 class="min-w-0 truncate text-xl" title="someone/gemma4-uncensored"><span >someone/gemma4-uncensored</span></h2>
      <span class="flex-none text-[15px] tabular-nums text-muted" title="Updated October 23, 2026">2d</span>
    </div>
    <div class="order-last mt-3 flex flex-wrap items-center gap-2"><span  class="inline-flex items-center rounded-md bg-indigo-50 px-2 py-0.5 text-xs">tools</span><span  class="inline-flex items-center rounded-md bg-indigo-50 px-2 py-0.5 text-xs">audio</span></div>
    <p class="mt-1 line-clamp-2 text-[15px] leading-6 text-black sm:col-span-2">A community model.</p>
    <div class="mt-3 flex flex-wrap items-center gap-2 text-sm">
      <span class="inline-flex items-center gap-1.5 tabular-nums text-ink sm:mr-1" title="293 downloads"><svg></svg><span >293</span></span>
      <span  class="inline-flex items-center rounded-md bg-[#ddf4ff] px-2 py-0.5 text-xs">12b</span>
    </div>
  </a>
</li>
<li
  hx-get="/search?page=2&q=gemma&#43;4"
  hx-trigger="revealed"
  hx-swap="outerHTML"
></li>
</ul>
<footer><a href="/public/terms" class="group">Terms</a><a href="/search">Search</a></footer>"#;

#[test]
fn parse_search_html_reads_the_current_layout() {
    let page = parse_search_html(SEARCH_FIXTURE_CURRENT);
    // The next-page placeholder closes the list.
    assert!(page.has_more);
    let models = page.models;
    // Library and community cards; the footer links are not cards.
    assert_eq!(models.len(), 3);

    let gemma = &models[0];
    assert_eq!(gemma.name, "gemma4");
    assert!(!gemma.community);
    assert_eq!(gemma.description, "Gemma 4 models & more.");
    assert_eq!(gemma.capabilities, vec!["vision", "tools", "cloud"]);
    assert_eq!(gemma.sizes, vec!["e4b", "26b"]);
    assert_eq!(gemma.pulls, "27.9M");
    assert_eq!(gemma.updated, "1 week ago");

    // The last library card stops at its own `</li>`: the community card's
    // badges and size after it are not its own.
    let glm = &models[1];
    assert_eq!(glm.name, "glm-5.3-flash");
    assert_eq!(glm.description, "Z.ai's first natively multimodal model.");
    assert_eq!(glm.capabilities, vec!["vision", "thinking", "cloud"]);
    assert!(glm.sizes.is_empty());
    assert_eq!(glm.pulls, "");
    assert_eq!(glm.updated, "2 months ago");

    let community = &models[2];
    assert_eq!(community.name, "someone/gemma4-uncensored");
    assert!(community.community);
    assert_eq!(community.capabilities, vec!["tools", "audio"]);
    assert_eq!(community.sizes, vec!["12b"]);
    assert_eq!(community.pulls, "293");
    assert_eq!(community.updated, "2 days ago");
}

#[test]
fn search_url_passes_only_ollama_com_s_own_filters() {
    assert_eq!(
        search_url(" gemma 4 ", &[], "", "popular", 0),
        "https://ollama.com/search?q=gemma%204&page=1"
    );
    let caps = ["vision", "cloud", "tools", "x&y=1"].map(String::from);
    assert_eq!(
        search_url("", &caps, "16", "newest", 3),
        "https://ollama.com/search?q=&page=3&c=tools&c=vision&c=cloud&s=16&o=newest"
    );
    assert_eq!(
        search_url("", &[], "17&o=x", "name", 2),
        "https://ollama.com/search?q=&page=2&o=name"
    );
}

#[test]
fn html_unescape_decodes_named_and_numeric_entities() {
    assert_eq!(html_unescape("A &#43; B &amp; C&#39;s &#x2014; &lt;x&gt;"), "A + B & C's — <x>");
    assert_eq!(html_unescape("&amp;lt; stays one pass"), "&lt; stays one pass");
    assert_eq!(html_unescape("AT&T & co; &bogus; &#xZZ;"), "AT&T & co; &bogus; &#xZZ;");
}

#[test]
fn long_age_label_expands_the_short_units() {
    assert_eq!(long_age_label("1w"), "1 week ago");
    assert_eq!(long_age_label("2mo"), "2 months ago");
    assert_eq!(long_age_label("12h"), "12 hours ago");
    assert_eq!(long_age_label("1y"), "1 year ago");
    assert_eq!(long_age_label("yesterday"), "yesterday");
}

#[test]
fn parse_search_html_empty_when_no_cards() {
    let page = parse_search_html("<html><body>no results</body></html>");
    assert!(page.models.is_empty());
    assert!(!page.has_more);
}

#[test]
fn percent_encode_query_escapes_unsafe_chars() {
    assert_eq!(percent_encode_query("llama 3.2"), "llama%203.2");
    assert_eq!(percent_encode_query("a&b=c"), "a%26b%3Dc");
    assert_eq!(percent_encode_query("qwen2.5-coder"), "qwen2.5-coder");
}

// ── completion prompt construction (#45) ──────────────────────────────────

#[test]
fn completion_prompt_includes_prefix_suffix_and_language() {
    let p = completion_prompt("let x =", " + 1;", "rust", CompletionMode::Sentence, "");
    assert!(p.contains("let x ="), "prefix must be embedded");
    assert!(p.contains(" + 1;"), "suffix must be embedded");
    assert!(p.contains("rust"), "language must be named");
    // Prefix appears before suffix so the model fills in the middle.
    assert!(p.find("let x =").unwrap() < p.find(" + 1;").unwrap());
}

#[test]
fn completion_prompt_defaults_empty_language_to_text() {
    let p = completion_prompt("a", "b", "", CompletionMode::Sentence, "");
    assert!(
        p.contains("Language: text"),
        "empty language defaults to text"
    );
}

#[test]
fn completion_prompt_labels_before_and_after_sections() {
    // The BEFORE/AFTER framing is what stops a chat model rewriting the doc.
    let p = completion_prompt("pre", "post", "rust", CompletionMode::Sentence, "");
    assert!(p.contains("BEFORE:\npre"));
    assert!(p.contains("AFTER:\npost"));
    assert!(p.find("BEFORE:").unwrap() < p.find("AFTER:").unwrap());
}

#[test]
fn build_context_block_labels_files_and_skips_empty() {
    let files = vec![
        ContextFile {
            name: "util.rs".into(),
            content: "fn helper() {}".into(),
        },
        ContextFile {
            name: "blank.rs".into(),
            content: "   \n  ".into(),
        },
        ContextFile {
            name: "types.rs".into(),
            content: "struct Foo;".into(),
        },
    ];
    let block = build_context_block(&files);
    assert!(block.contains("--- util.rs ---\nfn helper() {}"));
    assert!(block.contains("--- types.rs ---\nstruct Foo;"));
    // Whitespace-only files contribute nothing.
    assert!(!block.contains("blank.rs"));
    // No files → empty string, so the prompt omits the section.
    assert_eq!(build_context_block(&[]), "");
}

#[test]
fn build_context_block_caps_total_size() {
    let big = "x".repeat(20_000);
    let files = vec![
        ContextFile {
            name: "a".into(),
            content: big.clone(),
        },
        ContextFile {
            name: "b".into(),
            content: big.clone(),
        },
        ContextFile {
            name: "c".into(),
            content: big,
        },
    ];
    let block = build_context_block(&files);
    // Each file is per-file capped and the total is bounded; allow for the
    // labels/separators on top of the included bytes.
    assert!(
        block.len() <= MAX_CONTEXT_TOTAL + 256,
        "total context stays bounded"
    );
    // The first file always makes it in.
    assert!(block.contains("--- a ---"));
}

#[test]
fn truncate_chars_respects_utf8_boundaries() {
    // Cutting mid-multibyte must back off to a valid boundary, never panic.
    let s = "a\u{00e9}b"; // 'é' is 2 bytes → byte index 2 splits it
    assert_eq!(truncate_chars(s, 2), "a");
    assert_eq!(truncate_chars(s, 100), s);
}

#[test]
fn completion_prompt_embeds_reference_files_before_the_cursor_sections() {
    let ctx = build_context_block(&[ContextFile {
        name: "lib.rs".into(),
        content: "pub fn answer() -> i32 { 42 }".into(),
    }]);
    let p = completion_prompt("let x = ", "", "rust", CompletionMode::Sentence, &ctx);
    assert!(p.contains("REFERENCE FILES"));
    assert!(p.contains("pub fn answer"));
    // Reference context precedes the BEFORE/AFTER framing.
    assert!(p.find("REFERENCE FILES").unwrap() < p.find("BEFORE:").unwrap());
    // With no context the section is omitted entirely.
    let plain = completion_prompt("let x = ", "", "rust", CompletionMode::Sentence, "");
    assert!(!plain.contains("REFERENCE FILES"));
}

#[test]
fn completion_mode_parse_and_caps_scale_by_mode() {
    assert_eq!(CompletionMode::parse("block"), CompletionMode::Block);
    assert_eq!(CompletionMode::parse("scope"), CompletionMode::Scope);
    // Unknown / absent → the conservative default.
    assert_eq!(CompletionMode::parse("sentence"), CompletionMode::Sentence);
    assert_eq!(CompletionMode::parse("bogus"), CompletionMode::Sentence);
    // Caps grow with scope so bigger modes have room to finish.
    assert!(
        CompletionMode::Sentence.num_predict() < CompletionMode::Block.num_predict()
            && CompletionMode::Block.num_predict() < CompletionMode::Scope.num_predict()
    );
}

#[test]
fn completion_prompt_block_and_scope_drop_the_single_sentence_bias() {
    // Block/scope allow multi-line output; they must NOT carry the sentence
    // mode's "do not begin a new paragraph" restriction.
    let mid = "fn add(a: i32, b: i32) {\n    ";
    let block = completion_prompt(mid, "\n}", "rust", CompletionMode::Block, "");
    assert!(block.contains("block"));
    assert!(!block.contains("middle of a sentence"));

    let scope = completion_prompt(mid, "\n}", "rust", CompletionMode::Scope, "");
    assert!(scope.contains("function") && scope.contains("scope"));
    assert!(!scope.contains("middle of a sentence"));
}

#[test]
fn trailing_comment_intent_detects_comment_above_a_fresh_line() {
    // Caret on a fresh indented line directly below a `//` comment.
    let p = "fn main() {\n    // new for loop to compute the sum\n    ";
    assert_eq!(
        trailing_comment_intent(p, "rust").as_deref(),
        Some("new for loop to compute the sum")
    );
    // Caret at the end of the comment line itself (no newline yet).
    let p2 = "# compute the average of the list";
    assert_eq!(
        trailing_comment_intent(p2, "python").as_deref(),
        Some("compute the average of the list")
    );
}

#[test]
fn trailing_comment_intent_merges_consecutive_comment_lines() {
    let p = "    // compute the sum of all even numbers\n    /// and return the result\n    ";
    assert_eq!(
        trailing_comment_intent(p, "rust").as_deref(),
        Some("compute the sum of all even numbers and return the result")
    );
    // Single-line block comment is recognised in C-family languages.
    let blk = "/* build the lookup table */\n";
    assert_eq!(
        trailing_comment_intent(blk, "typescript").as_deref(),
        Some("build the lookup table")
    );
}

#[test]
fn trailing_comment_intent_ignores_non_instructions_and_prose() {
    // Real code on the caret line → not an intent comment.
    assert_eq!(trailing_comment_intent("let x = 1;\n", "rust"), None);
    // Dividers / lone tokens don't read as instructions.
    assert_eq!(trailing_comment_intent("// ----\n", "rust"), None);
    assert_eq!(trailing_comment_intent("//\n", "rust"), None);
    // Comment is no longer adjacent to the caret (intervening code line).
    let gap = "// describe the loop\nlet y = 2;\n";
    assert_eq!(trailing_comment_intent(gap, "rust"), None);
    // Markdown headings must never be treated as code-intent comments.
    assert_eq!(trailing_comment_intent("# My Heading\n", "markdown"), None);
    // Shebang line is not a natural-language instruction.
    assert_eq!(trailing_comment_intent("#!/bin/bash\n", "bash"), None);
}

#[test]
fn completion_prompt_switches_to_implement_mode_for_intent_comments() {
    let p = "fn main() {\n    // new for loop to compute the sum\n    ";
    let prompt = completion_prompt(p, "\n}", "rust", CompletionMode::Sentence, "");
    // Implements the comment as code rather than continuing prose.
    assert!(prompt.contains("implements that description"));
    assert!(prompt.contains("new for loop to compute the sum"));
    assert!(!prompt.contains("middle of a sentence"));
    // Without a trailing comment it keeps the ordinary sentence behaviour.
    let plain = completion_prompt("let x = ", "", "rust", CompletionMode::Sentence, "");
    assert!(!plain.contains("implements that description"));
}

#[test]
fn is_mid_sentence_detects_unfinished_sentences() {
    // Mid-sentence: ends on a word, comma, or trailing space after a word.
    assert!(is_mid_sentence("The main advantages are"));
    assert!(is_mid_sentence("I am writing to "));
    assert!(is_mid_sentence("a, b,"));
    // Not mid-sentence: terminator, newline, or empty (start of document).
    assert!(!is_mid_sentence("Done."));
    assert!(!is_mid_sentence("Why?"));
    assert!(!is_mid_sentence("Header:"));
    assert!(!is_mid_sentence("paragraph end.\n"));
    assert!(!is_mid_sentence(""));
}

#[test]
fn completion_prompt_biases_to_finishing_the_sentence_when_mid_sentence() {
    let mid = completion_prompt(
        "I am writing to ",
        " Best regards",
        "text",
        CompletionMode::Sentence,
        "",
    );
    assert!(mid.contains("middle of a sentence"));
    assert!(mid.contains("complete") || mid.contains("completes"));
    // At a sentence boundary it switches to the plain-continuation hint.
    let cont = completion_prompt("First line.\n", "", "text", CompletionMode::Sentence, "");
    assert!(!cont.contains("middle of a sentence"));
    assert!(cont.contains("Continue"));
}

#[test]
fn clean_completion_strips_code_fences() {
    assert_eq!(clean_completion("foo()\n"), "foo()");
    assert_eq!(clean_completion("```rust\nfoo()\n```"), "foo()\n");
    // No fence → unchanged (bar a trailing newline trim).
    assert_eq!(clean_completion("plain"), "plain");
}

#[test]
fn clean_completion_strips_conversational_preamble() {
    // The exact failure the user hit: a chat model prefacing the answer.
    assert_eq!(
        clean_completion("Here is the reformatted version of the text:\nreturn a + b"),
        "return a + b",
    );
    assert_eq!(clean_completion("Sure, here you go:\nx = 1"), "x = 1");
    // A real first line that merely ends in ':' is NOT a preamble — keep it.
    assert_eq!(
        clean_completion("def foo():\n    return 1"),
        "def foo():\n    return 1",
    );
    // A normal multi-line completion is untouched.
    assert_eq!(clean_completion("a + b\nc + d"), "a + b\nc + d");
}

#[test]
fn trim_context_overlap_drops_echoed_prefix_tail() {
    // The exact case from llama3.2:3b: BEFORE ends with "return ", model echoes it.
    assert_eq!(
        trim_context_overlap("    return ", "\n\nprint(x)", "return a + b"),
        "a + b",
    );
    // Repeated trailing word.
    assert_eq!(
        trim_context_overlap("The quick brown fox", " over the dog", "fox jumps"),
        "jumps",
    );
}

#[test]
fn trim_context_overlap_drops_echoed_suffix_head() {
    // Model pre-echoes the start of AFTER at the end of its insertion.
    assert_eq!(
        trim_context_overlap("a = ", " + 1", "compute() + 1"),
        "compute()",
    );
}

#[test]
fn trim_context_overlap_keeps_unrelated_completion() {
    // No overlap → returned unchanged.
    assert_eq!(
        trim_context_overlap("I am writing to ", " Best regards", "express my thanks"),
        "express my thanks",
    );
    // A 1–2 char incidental match is below the threshold, so it is NOT trimmed.
    assert_eq!(
        trim_context_overlap("foo a", "", "a list of items"),
        "a list of items"
    );
}

#[test]
fn overlap_len_finds_seam() {
    assert_eq!(overlap_len("    return", "return a"), 6);
    assert_eq!(overlap_len("brown fox", "fox jumps"), 3);
    assert_eq!(overlap_len("hello", "world"), 0);
}

// ── sanitize_alias turns ':' into '-' ─────────────────────────────────────

#[test]
fn sanitize_alias_replaces_colon() {
    assert_eq!(sanitize_alias("llama3:latest"), "llama3-latest");
    assert_eq!(sanitize_alias("qwen2:7b"), "qwen2-7b");
    assert_eq!(sanitize_alias("noname"), "noname");
}

// ── "Clear conversations" (gap 33 follow-up (c)) ─────────────────────────

/// A model home as Vibe leaves it: config and logins beside the session
/// store (unified and legacy) and the debug log.
fn vibe_home_with_sessions(root: &std::path::Path) -> std::path::PathBuf {
    let home = root.join("vibe_local").join("llama3-latest");
    let unified = home.join("logs").join("session").join("unified").join("abc");
    std::fs::create_dir_all(&unified).unwrap();
    std::fs::write(unified.join("CURRENT"), b"x").unwrap();
    let legacy = home.join("logs").join("session").join("session_20261013_1");
    std::fs::create_dir_all(&legacy).unwrap();
    std::fs::write(legacy.join("meta.json"), b"{}").unwrap();
    std::fs::write(home.join("logs").join("vibe.log"), b"log").unwrap();
    for keep in ["config.toml", "hooks.toml", ".env", "vibehistory"] {
        std::fs::write(home.join(keep), b"keep").unwrap();
    }
    home
}

fn none_live() -> Vec<String> {
    Vec::new()
}

/// Step 9 review: a tab of the model that starts while the store is being
/// deleted keeps the marker — its conversation may hold mail.
#[test]
fn a_tab_starting_during_the_clear_keeps_the_marker() {
    let tmp = tempfile::tempdir().unwrap();
    let home = vibe_home_with_sessions(tmp.path());
    let marker = tmp.path().join("marker");
    std::fs::write(&marker, b"").unwrap();
    let asked = std::cell::Cell::new(0);
    let live = || {
        asked.set(asked.get() + 1);
        if asked.get() == 1 { Vec::new() } else { vec!["late-tab".to_string()] }
    };
    // A refusal of its own: the conversations are gone, the mark is kept.
    assert_eq!(clear_conversations_in(&home, &marker, &live).unwrap_err(), LOCAL_MODEL_TAB_STARTED);
    assert_eq!(asked.get(), 2);
    assert!(marker.exists(), "the marker outlives a clear a new tab overlapped");
    assert!(!home.join("logs").join("session").exists(), "the conversations were cleared");
}

#[test]
fn clearing_deletes_the_conversations_then_the_marker_and_nothing_else() {
    let tmp = tempfile::tempdir().unwrap();
    let home = vibe_home_with_sessions(tmp.path());
    let marker = tmp.path().join("root_mcp").join("read_mail_model").join("h");
    std::fs::create_dir_all(marker.parent().unwrap()).unwrap();
    std::fs::write(&marker, b"").unwrap();
    clear_conversations_in(&home, &marker, &none_live).unwrap();
    assert!(!home.join("logs").join("session").exists());
    assert!(!marker.exists());
    for keep in ["config.toml", "hooks.toml", ".env", "vibehistory"] {
        assert!(home.join(keep).is_file(), "{keep}");
    }
    assert!(home.join("logs").join("vibe.log").is_file());
    // Again: nothing left to clear is not an error; nor is a model never run.
    clear_conversations_in(&home, &marker, &none_live).unwrap();
    clear_conversations_in(&tmp.path().join("vibe_local").join("never"), &marker, &none_live).unwrap();
}

#[test]
fn clearing_is_refused_while_a_tab_of_the_model_runs_and_keeps_the_marker() {
    let tmp = tempfile::tempdir().unwrap();
    let home = vibe_home_with_sessions(tmp.path());
    let marker = tmp.path().join("marker");
    std::fs::write(&marker, b"").unwrap();
    let err = clear_conversations_in(&home, &marker, &|| vec!["tab-1".to_string()]).unwrap_err();
    assert_eq!(err, LOCAL_MODEL_TAB_OPEN);
    assert!(home.join("logs").join("session").join("unified").is_dir());
    assert!(marker.exists());
}

#[cfg(unix)]
#[test]
fn clearing_never_follows_a_planted_link_and_keeps_the_marker_on_failure() {
    let tmp = tempfile::tempdir().unwrap();
    let outside = tmp.path().join("outside");
    std::fs::create_dir_all(outside.join("session")).unwrap();
    std::fs::write(outside.join("session").join("precious"), b"x").unwrap();
    // `logs` a link out of the home: the link goes, the target stays.
    let home = tmp.path().join("vibe_local").join("m");
    std::fs::create_dir_all(&home).unwrap();
    std::os::unix::fs::symlink(&outside, home.join("logs")).unwrap();
    let marker = tmp.path().join("marker");
    std::fs::write(&marker, b"").unwrap();
    clear_conversations_in(&home, &marker, &none_live).unwrap();
    assert!(std::fs::symlink_metadata(home.join("logs")).is_err());
    assert!(outside.join("session").join("precious").is_file());
    // `session` a link: the same.
    std::fs::create_dir_all(home.join("logs")).unwrap();
    std::os::unix::fs::symlink(outside.join("session"), home.join("logs").join("session")).unwrap();
    clear_conversations_in(&home, &marker, &none_live).unwrap();
    assert!(outside.join("session").join("precious").is_file());
    // A link deeper in the store is unlinked, its target untouched.
    assert!(std::fs::symlink_metadata(home.join("logs").join("session")).is_err());
    std::fs::create_dir_all(home.join("logs").join("session").join("s1")).unwrap();
    std::os::unix::fs::symlink(&outside, home.join("logs").join("session").join("s1").join("out")).unwrap();
    clear_conversations_in(&home, &marker, &none_live).unwrap();
    assert!(!home.join("logs").join("session").exists());
    assert!(outside.join("session").join("precious").is_file());
    // A home that is itself a link is refused, and the marker stays.
    let linked = tmp.path().join("vibe_local").join("linked");
    std::os::unix::fs::symlink(&outside, &linked).unwrap();
    std::fs::write(&marker, b"").unwrap();
    assert!(clear_conversations_in(&linked, &marker, &none_live).is_err());
    assert!(marker.exists());
    assert!(outside.join("session").join("precious").is_file());
}

#[cfg(unix)]
#[test]
fn a_store_that_cannot_be_looked_at_keeps_the_marker() {
    // A home the model's tab took the search permission from: `logs`
    // cannot be stat'ed. That is not "nothing to clear" — the clear fails
    // and the marker stays with the conversations it guards.
    use std::os::unix::fs::PermissionsExt;
    if unsafe { libc::geteuid() } == 0 {
        return; // root ignores the permission bits
    }
    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path().join("vibe_local").join("m");
    std::fs::create_dir_all(home.join("logs").join("session")).unwrap();
    std::fs::write(home.join("logs").join("session").join("s.json"), b"{}").unwrap();
    let marker = tmp.path().join("marker");
    std::fs::write(&marker, b"").unwrap();
    std::fs::set_permissions(&home, std::fs::Permissions::from_mode(0o600)).unwrap();
    let result = clear_conversations_in(&home, &marker, &none_live);
    std::fs::set_permissions(&home, std::fs::Permissions::from_mode(0o700)).unwrap();
    assert!(result.is_err(), "{result:?}");
    assert!(marker.exists(), "the marker went while the conversations stayed");
    assert!(home.join("logs").join("session").join("s.json").is_file());
    // Put right, the same clear goes through.
    clear_conversations_in(&home, &marker, &none_live).unwrap();
    assert!(!marker.exists());
    assert!(!home.join("logs").join("session").exists());
}

// ── reload regression: writing the same model twice is idempotent ─────────

#[test]
fn prepare_local_agent_idempotent_on_same_model() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let model = "llama3:latest";
    let (vibe_home, alias) = write_agent_config(tmp.path(), model);
    // Write again — should produce identical content (no duplicated blocks).
    write_agent_config(tmp.path(), model);

    let cfg = std::fs::read_to_string(vibe_home.join("config.toml")).unwrap();
    let model_block_count = cfg.matches("[[models]]").count();
    assert_eq!(
        model_block_count, 1,
        "calling prepare_local_agent twice must not duplicate the model block"
    );
    // active_model appears exactly once.
    let active_model_count = cfg.matches(&format!("active_model = \"{alias}\"")).count();
    assert_eq!(active_model_count, 1);
}

#[test]
fn model_directory_candidates_are_os_specific() {
    let home = std::path::Path::new("/home/alice");
    for os in [crate::paths::OsKind::Windows, crate::paths::OsKind::Macos] {
        let dirs = ollama_model_dir_candidates(os, home, None);
        assert_eq!(dirs, vec![home.join(".ollama/models")]);
    }
    let linux = ollama_model_dir_candidates(crate::paths::OsKind::Unix, home, None);
    assert!(linux.contains(&home.join(".ollama/models")));
    assert!(linux.contains(&std::path::PathBuf::from(
        "/usr/share/ollama/.ollama/models"
    )));
}

// ── models-download-location (Settings::ollama_models_path) ──────────────

#[test]
fn models_path_safety_gates_the_service_command_only() {
    assert!(models_path_is_safe("/data/ollama/models"));
    assert!(models_path_is_safe("/mnt/big disk/models")); // a space is fine
    assert!(!models_path_is_safe("")); // nothing to point at
    assert!(!models_path_is_safe("/data/\"quoted\"")); // breaks Environment="…"
    assert!(!models_path_is_safe("/data/50%")); // a systemd specifier
    assert!(!models_path_is_safe("/data/back\\slash"));
    assert!(!models_path_is_safe("/data/\nnewline"));
}

#[test]
fn service_command_is_a_drop_in_only_under_systemd() {
    let path = "/data/ollama/models";
    // No service to reconfigure → nothing to run (a Tabtivity-spawned server
    // already honours the setting).
    assert_eq!(
        models_dir_service_command(path, false),
        (String::new(), String::new())
    );

    let (cmd, shell) = models_dir_service_command(path, true);
    assert_eq!(shell, "bash");
    assert!(cmd.contains(concat!("ollama.service.d/", crate::app_slug!(), "-models.conf")));
    assert!(cmd.contains("OLLAMA_MODELS=%s")); // path arrives as a printf arg
    assert!(cmd.contains(&crate::quote::posix(path)));
    assert!(cmd.contains("systemctl restart ollama"));
    // The dir is created and handed to whoever the unit runs as.
    assert!(cmd.contains("systemctl show -p User"));
    assert!(cmd.contains("chown"));
}

#[test]
fn service_command_withheld_for_an_unsafe_path_even_under_systemd() {
    assert_eq!(
        models_dir_service_command("/data/\"x\"", true),
        (String::new(), String::new())
    );
}

// ── #201a: `ollama_host` actually reaches the transport ──────────────────

fn addr(raw: &str) -> Result<String, String> {
    resolve_ollama_addr(Some(raw), false)
}

#[test]
fn unset_ollama_host_is_the_address_it_always_was() {
    // The whole compatibility promise: every install that predates this
    // change keeps dialling exactly what it dialled before.
    assert_eq!(
        resolve_ollama_addr(None, false).unwrap(),
        DEFAULT_OLLAMA_ADDR
    );
    assert_eq!(addr("").unwrap(), DEFAULT_OLLAMA_ADDR);
    assert_eq!(addr("   ").unwrap(), DEFAULT_OLLAMA_ADDR);
}

#[test]
fn a_port_is_the_case_this_exists_for() {
    assert_eq!(addr("127.0.0.1:11500").unwrap(), "127.0.0.1:11500");
    assert_eq!(addr(":11500").unwrap(), "127.0.0.1:11500");
    // Ollama's own documented bare-port spelling.
    assert_eq!(addr("11500").unwrap(), "127.0.0.1:11500");
    assert_eq!(addr("localhost").unwrap(), "localhost:11434");
}

#[test]
fn spellings_that_get_copied_in_are_understood() {
    assert_eq!(addr("http://127.0.0.1:11434").unwrap(), "127.0.0.1:11434");
    assert_eq!(addr("http://localhost:11500/").unwrap(), "localhost:11500");
    assert_eq!(
        addr("http://localhost:11500/v1").unwrap(),
        "localhost:11500"
    );
    // `0.0.0.0` is what you write to make the *server* listen everywhere; as
    // a connect address it means this machine.
    assert_eq!(addr("0.0.0.0:11500").unwrap(), "127.0.0.1:11500");
    assert_eq!(addr("::").unwrap(), "[::1]:11434");
    assert_eq!(addr("::1").unwrap(), "[::1]:11434");
    assert_eq!(addr("[::1]:11500").unwrap(), "[::1]:11500");
}

#[test]
fn https_is_refused_rather_than_downgraded() {
    // The transport is plaintext HTTP/1.0 over a raw TcpStream. Connecting
    // in the clear to an address written as TLS is the one outcome that must
    // not be silent.
    let err = addr("https://127.0.0.1:11434").unwrap_err();
    assert!(err.contains("HTTPS"), "{err}");
    assert!(addr("ftp://127.0.0.1").is_err());
}

#[test]
fn another_machine_needs_saying_so() {
    // RFC 5737 documentation addresses, not RFC 1918 ones: these are
    // guaranteed unroutable and reserved for exactly this, and the privacy
    // scan still flags a real `10.x`/`192.168.x` so a leaked internal
    // address cannot hide among test fixtures.
    for host in ["192.0.2.9:11434", "nas.example:11434", "203.0.113.5"] {
        assert!(
            resolve_ollama_addr(Some(host), false).is_err(),
            "{host} must not be reachable without the opt-in"
        );
        assert!(
            resolve_ollama_addr(Some(host), true).is_ok(),
            "{host} must be reachable with it"
        );
    }
    // Loopback never needs the opt-in, whatever it is spelled as.
    for host in [
        "127.0.0.1",
        "127.1.2.3",
        "localhost",
        "dev.localhost",
        "::1",
    ] {
        assert!(resolve_ollama_addr(Some(host), false).is_ok(), "{host}");
    }
}

#[test]
fn a_host_that_could_inject_a_header_is_refused() {
    // The result is interpolated into a request line and a `Host:` header.
    assert!(addr("local\r\nX-Evil: 1").is_err());
    assert!(addr("local host").is_err());
    assert!(addr("127.0.0.1:not-a-port").is_err());
    assert!(addr("127.0.0.1:99999").is_err());
}

#[test]
fn ensure_running_only_starts_a_server_it_could_own() {
    assert!(addr_is_loopback("127.0.0.1:11434"));
    assert!(addr_is_loopback("localhost:11500"));
    assert!(addr_is_loopback("[::1]:11434"));
    assert!(!addr_is_loopback("192.0.2.9:11434"));
}

#[test]
fn the_vibe_provider_points_at_the_same_server() {
    // Not a strong assertion about the address (that depends on this
    // machine's settings.json) — only that the stanza is still well-formed
    // and names an `http://` base, which is what the agent parses.
    let block = ollama_provider_block();
    assert!(block.contains("api_base = \"http://"), "{block}");
    assert!(block.ends_with("/v1\"\napi_key_env_var = \"\"\napi_style = \"openai\"\nbackend = \"generic\"\nreasoning_field_name = \"reasoning_content\"\nproject_id = \"\"\nregion = \"\"\n\n[providers.extra_headers]\n"), "{block}");
}

/// Integration test: only runs when Ollama is reachable and has models.
#[test]
fn prepare_local_agent_integration_if_ollama_running() {
    if TcpStream::connect_timeout(
        &"127.0.0.1:11434".parse().unwrap(),
        Duration::from_millis(300),
    )
    .is_err()
    {
        eprintln!("Ollama not running — skipping integration test");
        return;
    }

    let model = match first_available_model() {
        Some(m) => m,
        None => {
            eprintln!("No Ollama models found — skipping integration test");
            return;
        }
    };

    let tmp = tempfile::tempdir().expect("tempdir");
    let (vibe_home, alias) = write_agent_config(tmp.path(), &model);

    let cfg = std::fs::read_to_string(vibe_home.join("config.toml")).unwrap();
    assert_eq!(
        cfg.lines().next().unwrap_or(""),
        format!("active_model = \"{alias}\""),
        "active_model must be first so global config cannot shadow it"
    );
    assert!(cfg.contains(&format!("alias = \"{alias}\"")));
}

fn first_available_model() -> Option<String> {
    let mut stream = TcpStream::connect("127.0.0.1:11434").ok()?;
    stream
        .write_all(b"GET /api/tags HTTP/1.0\r\nHost: localhost\r\n\r\n")
        .ok()?;
    let mut response = String::new();
    std::io::Read::read_to_string(&mut stream, &mut response).ok()?;
    let body = response.split("\r\n\r\n").nth(1)?;
    let v: serde_json::Value = serde_json::from_str(body).ok()?;
    v["models"]
        .as_array()?
        .iter()
        .find_map(|m| Some(m["name"].as_str()?.to_owned()))
}
