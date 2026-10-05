//! Live-SSH driver for the git-lockstep case matrix (`docs/git_lockstep_case_matrix.md`).
//!
//! Every case in that matrix was, until now, backed only by unit tests over the pure
//! decision functions — nothing had ever run against a real host. This driver closes
//! that gap: it calls the **same `services::git_peer` / `services::sync_auto` entry
//! points the Tauri commands call**, against a real remote project, so a case exercised
//! here exercises the code that ships. The only things it does not reproduce are the UI
//! event emits and the engines' *timing* (watcher + poll interval); it invokes the very
//! passes those timers would have invoked.
//!
//! It is an example, not a test: it needs a reachable host and it mutates both trees, so
//! it must never run in CI. Point it at a scratch project.
//!
//! ```text
//! TABTIVITY_PROJECT=<project-id> cargo run --example lockstep_drv -- <script>
//! ```
//!
//! Script: one command per line, `#` comments, blank lines ignored.
//!
//! | Command | Effect |
//! |---|---|
//! | `connect` / `disconnect` | open / drop the pooled SSH+SFTP session |
//! | `ls-enable` / `ls-disable` | the lockstep opt-in (`git_peer.json`) |
//! | `bs-auto <rel\|.> on\|off` | per-path byte-sync auto flag (`.` = whole project) |
//! | `bs` | one **real** byte-sync reconcile pass |
//! | `sync` | `detect_and_sync` forced (the Retry / "Sync git" action) |
//! | `sync-soft` | `detect_and_sync` unforced (lets the D5 early-out fire) |
//! | `pair-confirm` | forced + `allow_pair_overwrite` |
//! | `resolve local\|remote` | divergence resolution |
//! | `checkout <target> [local\|remote]` | coordinated checkout |
//! | `backups` / `restore <peer> <ref>` | safety refs |
//! | `status` | print persisted state, no network |
//! | `lsh <sh>` / `hsh <sh>` | shell in the mirror / on the host (in `remote_path`) |
//! | `lwrite <rel> <text>` | write a mirror file |
//! | `sleep <secs>` / `echo <text>` | pacing / annotation |

use std::process::Command;

use app_lib::services::git_peer::{self, ReconcileOpts};
use app_lib::services::{remote, remote_sync, ssh_exec, sync_auto};

/// Print a `GitPeerState` as the one line that matters when reading a case log.
fn show(state: &git_peer::GitPeerState) {
    let head = |h: &Option<git_peer::HeadRef>| match h {
        Some(git_peer::HeadRef::Branch { name, sha }) => {
            format!("{name}@{}", sha.chars().take(8).collect::<String>())
        }
        Some(git_peer::HeadRef::Detached { sha }) => {
            format!("DETACHED@{}", sha.chars().take(8).collect::<String>())
        }
        Some(git_peer::HeadRef::Unborn) => "unborn".into(),
        None => "-".into(),
    };
    println!(
        "   status={:?} local={} remote={}",
        state.status,
        head(&state.local_head),
        head(&state.remote_head)
    );
    if let Some(d) = &state.detail {
        println!("   detail: {d}");
    }
    if let Some(c) = &state.pairing_conflict {
        println!(
            "   pairingConflict: source_is_local={} paths={:?}",
            c.source_is_local, c.paths
        );
    }
}

fn show_result(r: Result<git_peer::GitPeerState, String>) {
    match r {
        Ok(s) => show(&s),
        Err(e) => println!("   ERR: {e}"),
    }
}

#[tokio::main]
async fn main() {
    let script_path = std::env::args()
        .nth(1)
        .expect("usage: lockstep_drv <script>");
    let project_id = std::env::var(app_lib::app_env!("PROJECT")).expect(concat!("set ", app_lib::app_upper!(), "_PROJECT=<project-id>"));
    let script = std::fs::read_to_string(&script_path).expect("cannot read script");

    let target = remote::remote_target_for(&project_id).expect("not an SSH remote project");
    let good_spec = target.spec.clone();
    let mut spec = good_spec.clone();
    let mirror = remote_sync::mirror_dir(&project_id);

    // The same three registries `lib.rs` hands to the commands via `manage`.
    let pool = remote::new_pool();
    let manifest = remote_sync::new_manifest_state();
    let auto = sync_auto::new_state();

    println!("project : {project_id}");
    println!("mirror  : {}", mirror.display());
    println!("host    : {}:{}", spec.host, spec.remote_path);

    for (n, raw) in script.lines().enumerate() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let (cmd, rest) = match line.split_once(char::is_whitespace) {
            Some((c, r)) => (c, r.trim()),
            None => (line, ""),
        };
        println!("\n── [{:>2}] {line}", n + 1);
        let t0 = std::time::Instant::now();

        match cmd {
            "connect" => match remote::connect(&pool, &project_id, None).await {
                Ok(()) => println!("   connected"),
                Err(e) => println!("   ERR: {e}"),
            },
            "disconnect" => {
                remote::disconnect(&pool, &project_id).await;
                println!("   disconnected");
            }
            "ls-enable" | "ls-disable" => {
                let mut s = git_peer::load_state(&project_id);
                s.enabled = cmd == "ls-enable";
                git_peer::save_state(&project_id, &s).expect("save git_peer.json");
                println!("   lockstep enabled={}", s.enabled);
            }
            // Mirrors `commands::sync::sync_set_auto`.
            "bs-auto" => {
                let (rel, on) = rest
                    .split_once(char::is_whitespace)
                    .expect("bs-auto <rel> on|off");
                let rel = if rel == "." { "" } else { rel };
                let on = on.trim() == "on";
                let mut g = manifest.lock().await;
                let m = remote_sync::ensure_loaded(&mut g, &project_id);
                let e = m.entry(rel.to_string()).or_default();
                e.auto_sync = on;
                e.auto_off = !on;
                if on {
                    e.selected = true;
                }
                e.is_dir = rel.is_empty() || !mirror.join(rel).is_file();
                remote_sync::save_manifest(&project_id, m).expect("save sync.json");
                println!(
                    "   byte-sync auto[{}] = {on}",
                    if rel.is_empty() { "." } else { rel }
                );
            }
            "bs" => {
                sync_auto::reconcile_once(&pool, &manifest, &target, &project_id).await;
                println!("   byte-sync pass done");
            }
            "sync" | "sync-soft" | "pair-confirm" => {
                let opts = ReconcileOpts {
                    forced: cmd != "sync-soft",
                    allow_pair_overwrite: cmd == "pair-confirm",
                    ..Default::default()
                };
                let s =
                    git_peer::detect_and_sync(&pool, &manifest, &auto, &project_id, &spec, opts)
                        .await;
                show(&s);
            }
            "resolve" => show_result(
                git_peer::resolve(&pool, &manifest, &auto, &project_id, &spec, rest).await,
            ),
            "checkout" => {
                let (tgt, side) = match rest.split_once(char::is_whitespace) {
                    Some((t, s)) => (t, s.trim()),
                    None => (rest, "local"),
                };
                show_result(
                    git_peer::checkout_lockstep(
                        &pool,
                        &manifest,
                        &auto,
                        &project_id,
                        &spec,
                        tgt,
                        side,
                        false,
                    )
                    .await,
                );
            }
            "backups" => {
                let b = git_peer::list_backups(&project_id, &spec);
                if b.is_empty() {
                    println!("   (none)");
                }
                for r in b {
                    println!(
                        "   {:<6} {} → {} {}",
                        r.peer,
                        r.refname,
                        &r.sha[..8.min(r.sha.len())],
                        r.subject
                    );
                }
            }
            "restore" => {
                let (peer, refname) = rest
                    .split_once(char::is_whitespace)
                    .expect("restore <peer> <ref>");
                show_result(
                    git_peer::restore_backup(
                        &pool,
                        &manifest,
                        &auto,
                        &project_id,
                        &spec,
                        peer,
                        refname.trim(),
                    )
                    .await,
                );
            }
            "status" => show(&git_peer::load_state(&project_id)),
            // Case 24 (D3.4): make the *host's* probe fail to run, as opposed to running
            // and answering "not a repo". `validate_arg` rejects a leading '-', so
            // `run_remote_script` returns Err — which is precisely the input that sets
            // `PeerSnapshot::probe_error` on a remote peer. The cause is synthetic; the
            // guard it feeds, and the refusal it must produce, are the real ones.
            "badspec" => {
                spec = if rest == "on" {
                    let mut s = good_spec.clone();
                    s.remote_path = "-unreadable".to_string();
                    s
                } else {
                    good_spec.clone()
                };
                println!("   remote_path = {:?}", spec.remote_path);
            }
            "lsh" => {
                let out = Command::new("bash")
                    .arg("-lc")
                    .arg(rest)
                    .current_dir(&mirror)
                    .output()
                    .expect("bash");
                print!("{}", indent(&String::from_utf8_lossy(&out.stdout)));
                print!("{}", indent(&String::from_utf8_lossy(&out.stderr)));
            }
            "hsh" => match ssh_exec::run_remote_script(&spec, rest) {
                Ok(out) => {
                    print!("{}", indent(&String::from_utf8_lossy(&out.stdout)));
                    print!("{}", indent(&String::from_utf8_lossy(&out.stderr)));
                }
                Err(e) => println!("   ERR: {e}"),
            },
            "lwrite" => {
                let (rel, text) = rest.split_once(char::is_whitespace).unwrap_or((rest, ""));
                let p = mirror.join(rel);
                if let Some(d) = p.parent() {
                    std::fs::create_dir_all(d).ok();
                }
                std::fs::write(&p, format!("{text}\n")).expect("write mirror file");
                println!("   wrote {rel}");
            }
            "sleep" => {
                let secs: f64 = rest.parse().unwrap_or(1.0);
                tokio::time::sleep(std::time::Duration::from_secs_f64(secs)).await;
                println!("   slept {secs}s");
            }
            "echo" => println!("   {rest}"),
            other => println!("   ?? unknown command '{other}'"),
        }
        // Elapsed is the only way to *see* the D5 early-out (case 9): it skips the
        // bundle+transfer round trip, not the probe, so it shows up as a fast pass.
        if matches!(
            cmd,
            "sync" | "sync-soft" | "pair-confirm" | "bs" | "resolve" | "checkout"
        ) {
            println!("   ({} ms)", t0.elapsed().as_millis());
        }
    }
    println!("\n── done");
}

fn indent(s: &str) -> String {
    s.lines().map(|l| format!("   | {l}\n")).collect()
}
