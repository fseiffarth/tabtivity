//! Agent-CLI version drift, headlessly: what is installed against what
//! `docs/third_party_update_checklist.md` says was verified.
//!
//! ```sh
//! cargo run --example agent_versions          # cached answers (a day old at most)
//! cargo run --example agent_versions -- --refresh   # ask every CLI again
//! ```
//!
//! Exits 1 when any installed CLI has moved away from a recorded check, so the
//! checklist's "did anything move?" is one command rather than an archaeology
//! dig. It reports; it never updates anything.
//!
//! Re-verifying a surface means running the checklist's own **Verify** steps for
//! that section and then bumping the matching row in
//! `services::agent_versions::VERIFIED` — and the prose note it mirrors — in the
//! same commit.

use app_lib::services::agent_versions::{Direction, DriftState};

fn main() {
    let refresh = std::env::args().any(|arg| arg == "--refresh" || arg == "-r");

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");
    let reports = runtime.block_on(app_lib::commands::agents::agent_versions(Some(refresh)));

    if reports.is_empty() {
        println!("No agent CLI is installed on this machine.");
        return;
    }

    let mut moved = 0;
    for report in &reports {
        let installed = report
            .version
            .clone()
            .or_else(|| report.raw.clone())
            .unwrap_or_else(|| "—".to_string());
        let state = match report.state {
            DriftState::Match => "ok",
            DriftState::Moved => "MOVED",
            DriftState::Unverified => "unverified",
            DriftState::Unknown => "unknown",
        };
        let source = if report.cached { " (cached)" } else { "" };
        println!("{:<14} {installed:<24} {state}{source}", report.label);
        if let Some(error) = &report.error {
            println!("{:<14}   {error}", "");
        }
        if !report.supported {
            println!("{:<14}   no version recipe — nobody has checked what it answers", "");
        }
        if report.state == DriftState::Unverified {
            println!("{:<14}   installed, but no verified-against note exists yet", "");
        }
        for note in &report.stale {
            let direction = match note.direction {
                Direction::Newer => "newer than",
                Direction::Older => "OLDER than",
                Direction::Different => "differs from",
            };
            println!("{:<14}   {direction} {}  {}", "", note.version, note.surface);
        }
        if report.state == DriftState::Moved {
            moved += 1;
        }
    }

    if moved > 0 {
        println!();
        println!(
            "{moved} agent CLI(s) moved away from a recorded check — walk the named \
             sections of docs/third_party_update_checklist.md."
        );
        std::process::exit(1);
    }
}
