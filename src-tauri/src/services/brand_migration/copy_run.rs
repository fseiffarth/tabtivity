//! The launch steps against a copy of a real install, without the app: the
//! gate before the name changes. `scripts/brand-copy-run.sh` makes the copy
//! (a home of its own, holding the state dir, the webview data and the
//! archive entries, with the stored paths re-pointed at the copy) and runs
//! this. Nothing outside that home is read or written, and the machine-wide
//! side (the phone host) is recorded, not done.

use std::fs;
use std::path::{Path, PathBuf};

use super::testing::*;
use super::*;
use crate::brand::{Forms, Name, Pair, LEGACY};

/// Files larger than this are not searched for leftovers.
const SCAN_LIMIT: u64 = 8 * 1024 * 1024;

/// Every file under `root` that still holds `needle`, with how often. Links
/// are not followed.
fn holders_of(root: &Path, needle: &str) -> Vec<(PathBuf, usize)> {
    let mut found = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(meta) = fs::symlink_metadata(&path) else { continue };
            if meta.file_type().is_dir() {
                stack.push(path);
            } else if meta.file_type().is_file() && meta.len() <= SCAN_LIMIT {
                let Ok(bytes) = fs::read(&path) else { continue };
                let count = String::from_utf8_lossy(&bytes).matches(needle).count();
                if count > 0 {
                    found.push((path, count));
                }
            }
        }
    }
    found.sort();
    found
}

/// The kind of place a holder is: its first two path components, with an
/// agent home's own name left out (`agent-homes/*/.claude/projects`), so a
/// thousand transcripts are one line and a single config file is not lost
/// among them.
fn group_of(rel: &Path) -> String {
    let parts: Vec<String> = rel.components().map(|part| part.as_os_str().to_string_lossy().into_owned()).collect();
    let dirs = &parts[..parts.len().saturating_sub(1)];
    match dirs {
        [first, _, rest @ ..] if first == "agent-homes" => {
            let tail: Vec<&str> = rest.iter().take(2).map(String::as_str).collect();
            if tail.is_empty() {
                format!("agent-homes/*/{}", parts.last().map(String::as_str).unwrap_or(""))
            } else {
                format!("agent-homes/*/{}", tail.join("/"))
            }
        }
        [] => parts.join("/"),
        _ => dirs.iter().take(2).map(String::as_str).collect::<Vec<_>>().join("/"),
    }
}

fn print_holders(title: &str, root: &Path, holders: &[(PathBuf, usize)]) {
    println!("\n{title}: {} file(s)", holders.len());
    let mut groups: std::collections::BTreeMap<String, (usize, usize, PathBuf)> = std::collections::BTreeMap::new();
    for (path, count) in holders {
        let rel = path.strip_prefix(root).unwrap_or(path);
        let group = groups.entry(group_of(rel)).or_insert((0, 0, rel.to_path_buf()));
        group.0 += 1;
        group.1 += count;
    }
    for (group, (files, count, example)) in &groups {
        println!("  {files:>5} file(s) {count:>6} hit(s)  {group}   e.g. {}", example.display());
    }
}

#[test]
#[ignore = "runs against a copy of a real install: scripts/brand-copy-run.sh"]
fn copy_run() {
    let home = PathBuf::from(std::env::var_os("BRAND_COPY_RUN_HOME").expect("BRAND_COPY_RUN_HOME names the copied home"));
    let home = home.canonicalize().expect("the copied home exists");
    // The name to move to. Leaked: a brand's forms are `'static`.
    let display = std::env::var("BRAND_COPY_RUN_NAME")
        .ok()
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| RENAMED.cur.display.to_string());
    let leak = |text: String| -> &'static str { Box::leak(text.into_boxed_str()) };
    let pair = Pair {
        cur: Forms {
            display: leak(display.clone()),
            slug: leak(display.to_lowercase()),
            upper: leak(display.to_uppercase()),
        },
        legacy: LEGACY,
    };
    assert!(pair.renamed(), "BRAND_COPY_RUN_NAME must differ from the old name");

    let machine = Machine::at(home.clone());
    let old_state = machine.state_dir(&LEGACY);
    let new_state = machine.state_dir(&pair.cur);
    assert!(
        fs::symlink_metadata(&old_state).is_ok_and(|meta| meta.file_type().is_dir()),
        "{} is not a folder: the copy holds no install under the old name (or was already migrated)",
        old_state.display()
    );
    machine.world.legacy_host.set(true);
    let _ = hits::taken();

    let env = machine.env(pair);
    println!("home:       {}", home.display());
    println!("state dir:  {} -> {}", old_state.display(), new_state.display());
    println!("home tree:  {:?}", env.home_trees);

    let report = run_startup(&env);
    println!("\nfirst launch: done {:?}", report.done);
    for (step, reason) in &report.pending {
        println!("  PENDING {step}: {reason}");
    }
    println!("machine-wide requests (recorded, not done): {:?}", machine.world.calls.borrow());

    // What the launch left.
    let link = fs::read_link(&old_state).ok();
    println!("\nold state dir is now: {}", match &link {
        Some(target) => format!("a link to {}", target.display()),
        None => "NOT a link".to_string(),
    });
    println!("record ({RECORD_FILE}):\n{}", fs::read_to_string(new_state.join(RECORD_FILE)).unwrap_or_default());

    // A second launch finds nothing left to do and changes no step.
    let record_before = fs::read_to_string(new_state.join(RECORD_FILE)).unwrap_or_default();
    let again = run_startup(&env);
    let record_after = fs::read_to_string(new_state.join(RECORD_FILE)).unwrap_or_default();
    println!("second launch: done {:?}, pending {:?}", again.done, again.pending);

    // Leftovers. A path into the state dir under its old name still resolves
    // through the link, so these are not failures by themselves — but each
    // one is something release B's link removal would break.
    let old_prefix = format!("{}/", old_state.display());
    let path_holders = holders_of(&new_state, &old_prefix);
    print_holders("stored paths still under the old state dir", &new_state, &path_holders);
    let hook_holders = holders_of(&new_state.join("agent-homes"), &LEGACY.name(Name::SESSION_HOOK_SH));
    print_holders("agent-home files still naming the old hook script", &new_state, &hook_holders);
    let global_holders = holders_of(&new_state.join("agent-global"), &LEGACY.name(Name::SESSION_HOOK_SH));
    print_holders("app-wide layer files still naming the old hook script", &new_state, &global_holders);
    for tree in &env.home_trees {
        print_holders("home-tree archive entries still under the old state dir", tree, &holders_of(&tree.join("archive"), &old_prefix));
    }
    println!("\nlegacy hits counted during the run: {:?}", hits::taken());

    assert!(!report.crashed);
    assert!(report.pending.is_empty(), "steps are pending: {:?}", report.pending);
    assert!(new_state.is_dir(), "the state dir did not arrive under the current name");
    assert_eq!(link.as_deref(), Some(new_state.as_path()), "the old name must be a link to the moved state dir");
    assert!(again.pending.is_empty() && !again.crashed, "{again:?}");
    assert_eq!(record_before, record_after, "a second launch rewrote the record");
    println!("\ncopy run: the launch steps finished. Read the leftover lists above.");
}
