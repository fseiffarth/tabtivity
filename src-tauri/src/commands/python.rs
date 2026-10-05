//! Which Python runs the code viewer's Run/Debug buttons (#87).
//!
//! Naming the interpreter is the whole problem. Running a project's script with a
//! bare `python3` when its dependencies live in a venv fails with
//! `ModuleNotFoundError`, and that reads to the user as "Tabtivity's Run button is
//! broken" rather than "wrong interpreter" — so getting this right is what makes
//! Run trustworthy at all.
//!
//! Two layers, in this order:
//!
//! 1. **The project's explicit choice** (the `projects.json` entry's
//!    `extra["python_interpreter"]`, never the in-folder copy), set in the
//!    pill's "Python interpreter…" dialog. Always wins, and once set costs nothing
//!    to honour — no probing at all.
//! 2. **Auto-detect**, which is what an unconfigured project gets. It probes the
//!    environment managers people actually use, because a `.venv/` scan alone
//!    silently mis-fires on every conda/Poetry project.
//!
//! Auto-detect deliberately only *auto-selects* an environment that is
//! unambiguously this project's: an in-tree venv, this project's Poetry env, the
//! shell's active `VIRTUAL_ENV`/`CONDA_PREFIX`, a pyenv version pinned by
//! `.python-version`. Named conda envs are **listed** for the dialog but never
//! auto-picked — choosing one of the user's N unrelated envs on their behalf would
//! be a guess, and a wrong guess here is indistinguishable from a bug.
//!
//! A project can hold **more than one** venv (a top-level `.venv` plus a
//! per-subproject one), so the in-tree scan walks the tree for `pyvenv.cfg`
//! markers rather than checking only the root — the dialog lists them all, and the
//! shallowest (a root `.venv`) is the one auto-detect prefers.
//!
//! Remote projects probe **the host**, over the pooled ControlMaster, with a single
//! constant `sh` script (`run_remote_script`) — the interpreter that matters is the
//! one on the machine the run tab will actually run on.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use crate::schema::projects::ProjectsList;
use crate::storage;

/// One interpreter the user could pick, as offered by the dialog.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PyInterpreter {
    /// Where it came from: `venv` | `poetry` | `conda` | `pyenv` | `active` | `system`.
    /// Drives the dialog's grouping and the auto-select precedence below.
    pub kind: String,
    /// The command Run/Debug executes. Relative (`.venv/bin/python`) for an in-tree
    /// venv — the run tab's cwd is the project root — absolute otherwise.
    pub path: String,
    /// Human label for the dropdown, e.g. `conda: ml-env`.
    pub label: String,
}

/// Precedence for auto-detect. Lower sorts first, and the first entry wins.
/// A `conda` (named, not active) env never auto-wins — see the module note.
fn auto_rank(kind: &str) -> u8 {
    match kind {
        "venv" => 0,   // in the project tree: unambiguous
        "poetry" => 1, // this project's env, per poetry itself
        "active" => 2, // the shell Tabtivity was launched from
        "pyenv" => 3,  // usually pinned by an in-tree .python-version
        "system" => 5,
        _ => 4, // "conda" (named): offered, never auto-selected
    }
}

/// True when auto-detect may select this kind on its own.
fn auto_selectable(kind: &str) -> bool {
    matches!(kind, "venv" | "poetry" | "active" | "pyenv" | "system")
}

const WINDOWS: bool = cfg!(windows);

fn default_interpreter() -> String {
    if WINDOWS {
        "python".into()
    } else {
        "python3".into()
    }
}

/// The venv directory names we look for in the project root, in preference order.
const VENV_DIRS: [&str; 3] = [".venv", "venv", "env"];

/// How deep the tree scan hunts for venvs below the project root. A project may
/// carry more than one (a top-level `.venv` plus a per-subproject one), so a
/// root-only scan misses the rest; the cap keeps a deep tree from being walked in
/// full for one dialog.
const VENV_SCAN_MAX_DEPTH: usize = 4;

/// Directory names never descended into while hunting for venvs: heavy or
/// irrelevant subtrees (a venv's own `pyvenv.cfg` sits at its root, so we never
/// need to walk *into* one, and `node_modules`/`.git` never hold a project venv).
fn prunes_venv_scan(name: &str) -> bool {
    matches!(
        name,
        ".git"
            | "node_modules"
            | "__pycache__"
            | ".mypy_cache"
            | ".pytest_cache"
            | ".ruff_cache"
            | ".tox"
            | ".idea"
            | ".vscode"
            | "site-packages"
    )
}

/// The interpreter inside a venv root, relative to it.
fn venv_python_rel() -> &'static str {
    if WINDOWS {
        "Scripts\\python.exe"
    } else {
        "bin/python"
    }
}

/// True when `dir` is a venv root: it carries a `pyvenv.cfg` (PEP 405, the
/// canonical marker every `python -m venv`/`virtualenv` writes) *and* the
/// interpreter. Requiring the marker is what keeps the recursive scan from
/// mistaking a stray `env/bin/python` for an environment.
fn is_venv_root(dir: &Path) -> bool {
    dir.join("pyvenv.cfg").is_file() && dir.join(venv_python_rel()).is_file()
}

/// The label for a discovered in-tree venv: leads with its path relative to the
/// project root, so two venvs in one project are told apart (`.venv` vs
/// `services/api/.venv`).
fn venv_label(rel: &Path) -> String {
    format!("{} (in this project)", rel.to_string_lossy())
}

/// Every venv *anywhere* under the project root (bounded by `VENV_SCAN_MAX_DEPTH`),
/// each as a project-relative interpreter path — the run tab's cwd is the project
/// root, so a relative path keeps working when the project moves. A venv is never
/// descended into (its `pyvenv.cfg` is at its root), and heavy dirs are pruned.
/// Sorted shallowest-first so a top-level `.venv` sorts ahead of a nested one and
/// wins auto-select.
fn find_venvs(root: &Path) -> Vec<PyInterpreter> {
    let mut roots: Vec<PathBuf> = Vec::new();
    let mut stack: Vec<(PathBuf, usize)> = vec![(root.to_path_buf(), 0)];
    while let Some((dir, depth)) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for child in entries.flatten().map(|e| e.path()).filter(|p| p.is_dir()) {
            if is_venv_root(&child) {
                roots.push(child); // a venv root — record it, don't walk into it
                continue;
            }
            let name = child.file_name().and_then(|s| s.to_str()).unwrap_or("");
            if depth < VENV_SCAN_MAX_DEPTH && !prunes_venv_scan(name) {
                stack.push((child, depth + 1));
            }
        }
    }
    // Shallowest first, then lexicographic — a stable, sensible dropdown order that
    // also puts the top-level venv (the auto-detect winner) ahead of nested ones.
    roots.sort_by(|a, b| {
        a.components()
            .count()
            .cmp(&b.components().count())
            .then_with(|| a.cmp(b))
    });
    roots
        .into_iter()
        .filter_map(|d| {
            let rel = d.strip_prefix(root).ok()?.to_path_buf();
            Some(PyInterpreter {
                kind: "venv".into(),
                path: rel.join(venv_python_rel()).to_string_lossy().into_owned(),
                label: venv_label(&rel),
            })
        })
        .collect()
}

// ── Local discovery ──────────────────────────────────────────────────────────

/// Run a helper program and return its trimmed stdout, or None if it isn't
/// installed / failed. Every probe here is *optional* by design: a machine with no
/// conda must not make interpreter discovery fail, it must simply offer no conda.
fn probe(dir: &Path, program: &str, args: &[&str]) -> Option<String> {
    let out = crate::paths::command_no_window(program)
        .args(args)
        .current_dir(dir)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

/// Interpreters visible from a LOCAL project directory.
///
/// Done natively rather than by shelling out a script because it must also work on
/// Windows, where there is no `sh` and the interpreter sits at `Scripts\python.exe`.
pub fn discover_local(dir: &Path) -> Vec<PyInterpreter> {
    let mut out: Vec<PyInterpreter> = Vec::new();

    // 1. venvs in the project tree — ALL of them, not just the root's, since a
    //    project can carry several. `find_venvs` walks the tree for `pyvenv.cfg`
    //    markers; the classic root names catch a venv that predates the marker.
    out.extend(find_venvs(dir));
    for name in VENV_DIRS {
        let py = dir.join(name).join(venv_python_rel());
        if py.is_file() {
            out.push(PyInterpreter {
                kind: "venv".into(),
                // Relative: the run tab's cwd IS the project root, and a relative
                // path keeps working if the project is moved. Native separators —
                // `cmd.exe` will not exec `.venv/Scripts/python.exe`.
                path: PathBuf::from(name)
                    .join(venv_python_rel())
                    .to_string_lossy()
                    .into_owned(),
                label: format!("{name} (in this project)"),
            });
        }
    }

    // 2. Poetry — the env lives outside the tree, so nothing else can find it.
    if let Some(p) = probe(dir, "poetry", &["env", "info", "-p"]) {
        let py = PathBuf::from(&p).join(venv_python_rel());
        if py.is_file() {
            out.push(PyInterpreter {
                kind: "poetry".into(),
                path: py.to_string_lossy().into_owned(),
                label: format!("poetry ({})", basename_of(&p)),
            });
        }
    }

    // 3. The environment Tabtivity itself was launched inside.
    for (var, kind) in [("VIRTUAL_ENV", "active"), ("CONDA_PREFIX", "active")] {
        if let Ok(root) = std::env::var(var) {
            if root.is_empty() {
                continue;
            }
            let py = PathBuf::from(&root).join(venv_python_rel());
            if py.is_file() {
                out.push(PyInterpreter {
                    kind: kind.into(),
                    path: py.to_string_lossy().into_owned(),
                    label: format!("active ${var} ({})", basename_of(&root)),
                });
            }
        }
    }

    // 4. Named conda envs — offered, never auto-picked.
    if let Some(list) = probe(dir, "conda", &["env", "list"]) {
        for env in parse_conda_envs(&list) {
            let py = PathBuf::from(&env.1).join(venv_python_rel());
            if py.is_file() {
                out.push(PyInterpreter {
                    kind: "conda".into(),
                    path: py.to_string_lossy().into_owned(),
                    label: format!("conda: {}", env.0),
                });
            }
        }
    }

    // 5. pyenv — honours an in-tree `.python-version`, since we probe from `dir`.
    if let Some(p) = probe(dir, "pyenv", &["which", "python"]) {
        if Path::new(&p).is_file() {
            out.push(PyInterpreter {
                kind: "pyenv".into(),
                path: p.clone(),
                label: format!("pyenv ({})", basename_of(&p)),
            });
        }
    }

    // 6. The system interpreter — always last, always present as a fallback.
    out.push(PyInterpreter {
        kind: "system".into(),
        path: default_interpreter(),
        label: format!("system ({})", default_interpreter()),
    });

    dedupe_and_rank(out)
}

/// `conda env list` → `(name, prefix)` pairs. Its output is columns with a `*`
/// marking the active env:
/// ```text
/// # conda environments:
/// #
/// base                  *  /home/u/miniconda3
/// ml-env                   /home/u/miniconda3/envs/ml-env
/// ```
pub fn parse_conda_envs(stdout: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for line in stdout.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let fields: Vec<&str> = line.split_whitespace().collect();
        // Name first, prefix last; the optional `*` sits between them.
        if fields.len() < 2 {
            continue;
        }
        let name = fields[0];
        let prefix = fields[fields.len() - 1];
        if name == "*" || !prefix.starts_with('/') && !prefix.contains(":\\") {
            continue;
        }
        out.push((name.to_string(), prefix.to_string()));
    }
    out
}

fn basename_of(p: &str) -> String {
    p.rsplit(['/', '\\']).next().unwrap_or(p).to_string()
}

/// Drop duplicate interpreter paths (a poetry env can also be the active one) and
/// order by auto-detect precedence, so `first()` IS the auto-detected choice.
fn dedupe_and_rank(mut list: Vec<PyInterpreter>) -> Vec<PyInterpreter> {
    list.sort_by_key(|i| auto_rank(&i.kind));
    let mut seen = std::collections::HashSet::new();
    list.retain(|i| seen.insert(i.path.clone()));
    list
}

// ── Remote discovery ─────────────────────────────────────────────────────────

/// The host-side probe. A **constant** POSIX-`sh` script (the `run_remote_script`
/// contract: nothing may be interpolated into it), run with the project's remote
/// dir as cwd so `poetry`/`pyenv` resolve *this* project's environment. Emits one
/// `kind\tpath\tlabel` line per interpreter — collapsing what would otherwise be
/// six SSH round trips into one.
const REMOTE_PROBE: &str = r#"
emit() { printf '%s\t%s\t%s\n' "$1" "$2" "$3"; }
for d in .venv venv env; do
  [ -x "$d/bin/python" ] && emit venv "$d/bin/python" "$d (in this project)"
done
find . -maxdepth 4 \( -name node_modules -o -name .git -o -name site-packages \) -prune \
  -o -name pyvenv.cfg -type f -print 2>/dev/null | while read -r cfg; do
  d=${cfg%/pyvenv.cfg}; d=${d#./}
  [ -x "$d/bin/python" ] && emit venv "$d/bin/python" "$d (in this project)"
done
if command -v poetry >/dev/null 2>&1; then
  p=$(poetry env info -p 2>/dev/null)
  [ -n "$p" ] && [ -x "$p/bin/python" ] && emit poetry "$p/bin/python" "poetry ($(basename "$p"))"
fi
[ -n "$VIRTUAL_ENV" ] && [ -x "$VIRTUAL_ENV/bin/python" ] && \
  emit active "$VIRTUAL_ENV/bin/python" "active \$VIRTUAL_ENV ($(basename "$VIRTUAL_ENV"))"
[ -n "$CONDA_PREFIX" ] && [ -x "$CONDA_PREFIX/bin/python" ] && \
  emit active "$CONDA_PREFIX/bin/python" "active \$CONDA_PREFIX ($(basename "$CONDA_PREFIX"))"
if command -v conda >/dev/null 2>&1; then
  conda env list 2>/dev/null | awk '!/^#/ && NF >= 2 { print $1, $NF }' | while read -r n p; do
    [ -x "$p/bin/python" ] && emit conda "$p/bin/python" "conda: $n"
  done
fi
if command -v pyenv >/dev/null 2>&1; then
  p=$(pyenv which python 2>/dev/null)
  [ -n "$p" ] && [ -x "$p" ] && emit pyenv "$p" "pyenv ($(basename "$p"))"
fi
p=$(command -v python3 || command -v python)
[ -n "$p" ] && emit system "$p" "system ($p)"
exit 0
"#;

/// Parse the `kind\tpath\tlabel` lines the remote probe emits.
pub fn parse_remote_probe(stdout: &str) -> Vec<PyInterpreter> {
    let mut out = Vec::new();
    for line in stdout.lines() {
        let mut f = line.splitn(3, '\t');
        let (Some(kind), Some(path), Some(label)) = (f.next(), f.next(), f.next()) else {
            continue;
        };
        if kind.is_empty() || path.is_empty() {
            continue;
        }
        out.push(PyInterpreter {
            kind: kind.to_string(),
            path: path.to_string(),
            label: label.to_string(),
        });
    }
    dedupe_and_rank(out)
}

// ── Commands ─────────────────────────────────────────────────────────────────
//
// A remote probe shells out over the pooled SSH ControlMaster, which can stall up
// to its ConnectTimeout/ServerAlive window on a dead/degraded host. Tauri runs a
// synchronous `#[command]` on the MAIN thread, so doing that inline froze the
// whole window — the same bug `commands::git` already fixed (see its
// `run_off_thread` doc comment) but that fix never reached this file. The two
// remote-capable commands are now `async` wrappers that offload their blocking
// body via `spawn_blocking`; the local-only `discover_local`/`project_python`
// paths stay plain sync fns underneath, so they remain directly unit-testable.

async fn run_off_thread<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| format!("python task failed: {e}"))?
}

/// Every interpreter offered for `project_dir` — the dialog's dropdown. Probes
/// whichever machine the run tab will actually run on: the **host** for a remote
/// project, **inside the container** for a containerized one, else this machine.
///
/// The container branch exists because the host answer is wrong there in a way
/// that looks like a broken Run button. The project directory is bind-mounted at
/// its identical path, so a host-detected `.venv/bin/python` *is* present inside
/// the container — as a symlink to a system interpreter that is not, since a venv
/// records its base interpreter in `pyvenv.cfg` and carries no copy of it. Handing
/// that path to a container tab produced `no such file or directory` for a
/// directory the user can see in the file tree.
///
/// The probe is the SAME script the remote branch runs, which is what makes the
/// two answers comparable: `[ -x … ]` follows symlinks, so a venv whose base
/// interpreter is missing from the image is simply not emitted, and the image's
/// own `python3` is the last-resort entry that wins instead. What it cannot see is
/// a venv whose interpreter resolves but whose compiled wheels were built against
/// host libraries; that one fails at `import`, and no cheap probe distinguishes it.
fn python_interpreters_blocking(project_dir: &str) -> Result<Vec<PyInterpreter>, String> {
    if let Some(target) = crate::services::remote::remote_target_for_dir(project_dir) {
        let out = crate::services::ssh_exec::run_remote_script(&target.spec, REMOTE_PROBE)?;
        return Ok(parse_remote_probe(&String::from_utf8_lossy(&out.stdout)));
    }
    if let Some(project_id) = crate::services::sandbox::containerized_project_for_dir(project_dir) {
        // A container that is not up answers nothing rather than being started for
        // a probe — fall through to the host scan, whose in-tree venv is at least
        // the right *path* (the mount makes it identical) even if this cannot yet
        // confirm the interpreter behind it resolves in there.
        if let Some(stdout) =
            crate::services::sandbox::run_in_container(&project_id, project_dir, REMOTE_PROBE)
        {
            return Ok(parse_remote_probe(&stdout));
        }
    }
    Ok(discover_local(Path::new(project_dir)))
}

#[tauri::command]
pub async fn python_interpreters(project_dir: String) -> Result<Vec<PyInterpreter>, String> {
    run_off_thread(move || python_interpreters_blocking(&project_dir)).await
}

/// The interpreter Run/Debug should use *right now*: the project's explicit choice
/// if it has one (no probing), else the best auto-detected candidate, else the
/// system default. This is the only thing `lib/terminal/pythonRun.ts` needs to ask.
#[tauri::command]
pub async fn python_interpreter_for(
    project_id: Option<String>,
    project_dir: String,
) -> Result<String, String> {
    if let Some(pinned) = project_id.as_deref().and_then(project_python) {
        return Ok(pinned);
    }
    run_off_thread(move || {
        let found = python_interpreters_blocking(&project_dir).unwrap_or_default();
        Ok(found
            .into_iter()
            .find(|i| auto_selectable(&i.kind))
            .map(|i| i.path)
            .unwrap_or_else(default_interpreter))
    })
    .await
}

/// A project's pinned interpreter, read from the always-local `projects.json`
/// mirror only — like the sandbox spec. The in-folder `project.json` copy is
/// never consulted: that file is writable by a fenced agent, a container tab, a
/// `git pull` or byte-sync, and Run would execute what it names on the host.
fn project_python(project_id: &str) -> Option<String> {
    let list_path = storage::state_dir().join("projects.json");
    let list: ProjectsList = storage::read_json(&list_path).ok()?;
    python_from_entry(list.iter().find(|p| p.id == project_id)?)
}

fn python_from_entry(entry: &crate::schema::ProjectEntry) -> Option<String> {
    entry
        .extra
        .get("python_interpreter")
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .filter(|s| !s.trim().is_empty())
}

/// Pin (or clear, with `None`/blank) the project's interpreter. Written to both
/// stores, like the sandbox spec: the `projects.json` mirror is what the run path
/// reads, `project.json` keeps it with the project.
#[tauri::command]
pub fn set_project_python(
    project_id: String,
    interpreter: Option<String>,
) -> Result<Option<String>, String> {
    let value = interpreter
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    crate::commands::projects::patch_project_entry_mirrored(
        &project_id,
        |entry| {
            match &value {
                Some(v) => {
                    entry.extra.insert(
                        "python_interpreter".into(),
                        serde_json::Value::String(v.clone()),
                    );
                }
                None => {
                    entry.extra.remove("python_interpreter");
                }
            }
            Ok(())
        },
        |project, ()| project.python_interpreter = value.clone(),
    )?;
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pinned_python_ignores_the_in_folder_project_json() {
        let tmp = tempfile::tempdir().unwrap();
        let local_file = tmp.path().join("project.json");
        std::fs::write(
            &local_file,
            r#"{"id":"p","name":"p","directory":"/x","python_interpreter":"/x/evil.sh"}"#,
        )
        .unwrap();
        let mut entry = crate::schema::ProjectEntry {
            id: "p".into(),
            name: "p".into(),
            status: "active".into(),
            position: 0,
            local_file: local_file.to_string_lossy().into_owned(),
            extra: Default::default(),
        };
        assert_eq!(python_from_entry(&entry), None);
        entry
            .extra
            .insert("python_interpreter".into(), "/usr/bin/python3".into());
        assert_eq!(python_from_entry(&entry).as_deref(), Some("/usr/bin/python3"));
    }

    #[test]
    fn conda_env_list_is_parsed_name_and_prefix() {
        let out = "# conda environments:\n#\nbase                  *  /home/u/miniconda3\nml-env                   /home/u/miniconda3/envs/ml-env\n";
        assert_eq!(
            parse_conda_envs(out),
            vec![
                ("base".to_string(), "/home/u/miniconda3".to_string()),
                (
                    "ml-env".to_string(),
                    "/home/u/miniconda3/envs/ml-env".to_string()
                ),
            ]
        );
    }

    #[test]
    fn conda_comments_and_short_lines_are_skipped() {
        assert!(parse_conda_envs("# nothing\n\ngarbage\n").is_empty());
    }

    #[test]
    fn remote_probe_lines_are_parsed() {
        let out = "venv\t.venv/bin/python\t.venv (in this project)\nsystem\t/usr/bin/python3\tsystem (/usr/bin/python3)\n";
        let got = parse_remote_probe(out);
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].kind, "venv");
        assert_eq!(got[0].path, ".venv/bin/python");
        assert_eq!(got[1].kind, "system");
    }

    #[test]
    fn malformed_probe_lines_are_dropped_not_fatal() {
        assert!(parse_remote_probe("garbage\nalso\tgarbage\n").is_empty());
    }

    #[test]
    fn ranking_puts_an_in_tree_venv_first_and_system_last() {
        let list = parse_remote_probe(
            "system\t/usr/bin/python3\tsystem\nconda\t/c/envs/x/bin/python\tconda: x\nvenv\t.venv/bin/python\t.venv\n",
        );
        assert_eq!(list[0].kind, "venv");
        assert_eq!(list.last().unwrap().kind, "system");
    }

    #[test]
    fn a_named_conda_env_is_offered_but_never_auto_selected() {
        // The dialog lists it; auto-detect must not pick one of N unrelated envs.
        assert!(!auto_selectable("conda"));
        assert!(auto_selectable("venv"));
        assert!(auto_selectable("poetry"));
        assert!(auto_selectable("system"));
    }

    #[test]
    fn duplicate_paths_collapse_to_the_higher_ranked_kind() {
        // A poetry env that is ALSO the active VIRTUAL_ENV must appear once.
        let list = parse_remote_probe(
            "active\t/e/x/bin/python\tactive\npoetry\t/e/x/bin/python\tpoetry (x)\n",
        );
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].kind, "poetry"); // ranked above "active"
    }

    #[test]
    fn local_discovery_finds_an_in_tree_venv_as_a_relative_path() {
        let tmp = std::env::temp_dir().join(format!(concat!(crate::app_slug!(), "-py-{}"), std::process::id()));
        let bin = tmp
            .join(".venv")
            .join(if WINDOWS { "Scripts" } else { "bin" });
        std::fs::create_dir_all(&bin).unwrap();
        let py = bin.join(if WINDOWS { "python.exe" } else { "python" });
        std::fs::write(&py, b"#!/bin/sh\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&py, std::fs::Permissions::from_mode(0o755)).unwrap();
        }

        let found = discover_local(&tmp);
        // Relative, because the run tab's cwd is the project root.
        assert_eq!(found[0].kind, "venv");
        let expected = PathBuf::from(".venv")
            .join(venv_python_rel())
            .to_string_lossy()
            .into_owned();
        assert_eq!(found[0].path, expected);
        // The system interpreter is always offered as the last resort.
        assert!(found.iter().any(|i| i.kind == "system"));

        std::fs::remove_dir_all(&tmp).ok();
    }

    /// Build a fake venv (interpreter + `pyvenv.cfg`) at `root/rel`.
    #[cfg(test)]
    fn make_fake_venv(root: &Path, rel: &str) {
        let venv = root.join(rel);
        let bin = venv.join(if WINDOWS { "Scripts" } else { "bin" });
        std::fs::create_dir_all(&bin).unwrap();
        let py = bin.join(if WINDOWS { "python.exe" } else { "python" });
        std::fs::write(&py, b"#!/bin/sh\n").unwrap();
        std::fs::write(venv.join("pyvenv.cfg"), b"home = /usr\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&py, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
    }

    #[test]
    fn local_discovery_finds_every_venv_in_the_tree_not_only_the_root() {
        let tmp = std::env::temp_dir().join(format!(concat!(crate::app_slug!(), "-py-multi-{}"), std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        make_fake_venv(&tmp, ".venv");
        make_fake_venv(&tmp, "services/api/.venv");

        let found = discover_local(&tmp);
        let venvs: Vec<&str> = found
            .iter()
            .filter(|i| i.kind == "venv")
            .map(|i| i.path.as_str())
            .collect();
        let root_py = PathBuf::from(".venv").join(venv_python_rel());
        // Build from components, not a "services/api/.venv" literal: discovery emits
        // the relative path with the OS separator (backslash on Windows), so a
        // forward-slash literal would fail the string compare there.
        let nested_py = PathBuf::from("services")
            .join("api")
            .join(".venv")
            .join(venv_python_rel());
        assert!(
            venvs.contains(&root_py.to_string_lossy().as_ref()),
            "root venv missing: {venvs:?}"
        );
        assert!(
            venvs.contains(&nested_py.to_string_lossy().as_ref()),
            "nested venv missing: {venvs:?}"
        );
        // The top-level venv sorts first, so it stays the auto-detect winner.
        assert_eq!(found[0].path, root_py.to_string_lossy());

        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn venv_scan_prunes_heavy_dirs() {
        // A venv buried inside node_modules is not the project's — don't offer it,
        // and don't pay to walk that subtree.
        let tmp = std::env::temp_dir().join(format!(concat!(crate::app_slug!(), "-py-prune-{}"), std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        make_fake_venv(&tmp, "node_modules/pkg/.venv");
        let found = find_venvs(&tmp);
        assert!(
            found.is_empty(),
            "should not descend into node_modules: {found:?}"
        );
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn local_discovery_with_no_venv_still_offers_the_system_interpreter() {
        let tmp = std::env::temp_dir().join(format!(concat!(crate::app_slug!(), "-py-none-{}"), std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        let found = discover_local(&tmp);
        assert!(found.iter().any(|i| i.kind == "system"));
        assert!(!found.iter().any(|i| i.kind == "venv"));
        std::fs::remove_dir_all(&tmp).ok();
    }
}
