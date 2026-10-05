//! Headless probe for the local-model surfaces the 🧠 menu drives.
//!
//! These are `#[tauri::command]` functions, i.e. ordinary `async fn`s with an
//! attribute — so they can be awaited directly, without a window, a webview or
//! a click. That is the whole point of this example: "the button does nothing"
//! has two very different causes (the command isn't reachable vs. it ran and
//! had nothing to report), and reading the actual return values is the only way
//! to tell them apart.
//!
//!   cargo run --example ollama_probe --manifest-path src-tauri/Cargo.toml
//!
//! Reaches the network for the two update checks, exactly as clicking the
//! button does. Nothing here writes anything.

use app_lib::commands::ollama;

#[tokio::main(flavor = "current_thread")]
async fn main() {
    println!("── installed models ──────────────────────────────");
    match ollama::list_ollama_models_detailed().await {
        Ok(models) => {
            for m in &models {
                let caps = if m.capabilities.is_empty() {
                    "(couldn't ask)".to_string()
                } else {
                    m.capabilities.join(",")
                };
                let tools = if m.capabilities.is_empty() {
                    "?"
                } else if m.capabilities.iter().any(|c| c == "tools") {
                    "yes"
                } else {
                    "NO"
                };
                println!(
                    "  {:<34} tools={:<4} caps={:<28} digest={}",
                    m.name,
                    tools,
                    caps,
                    m.digest.chars().take(12).collect::<String>()
                );
            }
        }
        Err(e) => println!("  ERROR: {e}"),
    }

    println!("\n── drivers offered per model ─────────────────────");
    for model in ["deepcoder:latest", "qwen3-coder:latest"] {
        let drivers = ollama::list_local_drivers(Some(model.to_string())).await;
        let offered: Vec<&str> = drivers
            .iter()
            .filter(|d| d.available)
            .map(|d| d.id.as_str())
            .collect();
        let blocked: Vec<&str> = drivers
            .iter()
            .filter(|d| d.needs_tools_unsupported)
            .map(|d| d.id.as_str())
            .collect();
        println!("  {model}");
        println!("    offered: {offered:?}");
        println!("    blocked by the model: {blocked:?}");
    }

    println!("\n── prepare_local_launch(codex, deepcoder) ────────");
    match ollama::prepare_local_launch("codex".into(), "deepcoder:latest".into()).await {
        Ok(spec) => println!("  ALLOWED (unexpected): {} {:?}", spec.cmd, spec.args),
        Err(e) => println!("  refused: {e}"),
    }

    // The launch line an agent tab actually gets, for a model that has `tools`
    // but not `thinking` — the case that must bypass `ollama launch`, turn
    // reasoning off and carry its own model catalog.
    println!("\n── prepare_local_launch per driver (qwen3-coder) ─");
    for agent in ["codex", "claude", "opencode", "droid", "openclaw"] {
        match ollama::prepare_local_launch(agent.into(), "qwen3-coder:latest".into()).await {
            Ok(spec) => println!("  {agent:<9} {} {:?}", spec.cmd, spec.args),
            Err(e) => println!("  {agent:<9} refused: {e}"),
        }
    }

    println!("\n── model update check (network) ──────────────────");
    match ollama::ollama_check_updates(vec![]).await {
        Ok(list) => {
            for u in &list {
                println!(
                    "  {:<34} update={:<5} {}",
                    u.model,
                    u.update_available,
                    u.error.clone().unwrap_or_default()
                );
            }
            println!(
                "  → {} of {} have an update",
                list.iter().filter(|u| u.update_available).count(),
                list.len()
            );
        }
        Err(e) => println!("  ERROR: {e}"),
    }

    println!("\n── ollama server version (network) ───────────────");
    let v = ollama::ollama_version_status(true).await;
    println!("  current={:?} latest={:?}", v.current, v.latest);
    println!(
        "  update_available={} error={:?}",
        v.update_available, v.error
    );
    println!("  install_cmd={:?} shell={:?}", v.install_cmd, v.shell_kind);

    // The integrated-GPU gate. Headless for the same reason the rest of this
    // probe is: "the models are answering on the CPU" is a claim about a running
    // server, and the only way to tell a correct diagnosis from a plausible one
    // is to read the four facts it is built from separately.
    println!("\n── gpu status ────────────────────────────────────");
    let g = ollama::ollama_gpu_status().await;
    println!(
        "  gpu_present={} integrated_only={} model_on_cpu={}",
        g.gpu_present, g.integrated_only, g.model_on_cpu
    );
    println!(
        "  igpu_flag_supported={} igpu_dropped={} systemd_service={}",
        g.igpu_flag_supported, g.igpu_dropped, g.systemd_service
    );
    println!("  fix_cmd={:?} shell={:?}", g.fix_cmd, g.shell_kind);
}
