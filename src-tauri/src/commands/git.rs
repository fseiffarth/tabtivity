use crate::brand::UPPER;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

use crate::services::remote::{remote_target_for_dir, RemoteTarget};

// Every git invocation goes through the single `run_git` helper, which dispatches
// on whether the project is local or remote:
//
//   * **local** → `crate::paths::command_no_window("git")` in `project_dir`
//     rather than a bare `Command::new`: Tabtivity is a windowed app with no
//     console, so on Windows every `git` subprocess would otherwise flash a
//     transient console window — and `git_status`/`git_file_statuses` are polled
//     continuously for the file tree. `command_no_window` sets CREATE_NO_WINDOW
//     on Windows and is a no-op elsewhere.
//   * **remote** (project carries a `RemoteSpec`) → the same `git <args>` run on
//     the host over SSH, riding the shared ControlMaster (`ssh_exec::
//     run_git_remote`). git's output is plain text, so the captured stdout/
//     stderr/exit are parsed byte-for-byte identically to the local case and
//     every parser below is reused unchanged. `push` then authenticates with the
//     *host's* own git credentials/SSH keys, since git runs there.
//
// Each command resolves remoteness once via `remote_target_for_dir(&project_dir)`
// (a reverse-lookup from the absolute `project_dir` the frontend passes to the
// owning project's `RemoteSpec`) and threads the resulting `Option<&RemoteTarget>`
// into `run_git` and the `local_non_repo` guard.

// ── The repo's own config is untrusted input (Group O #151) ───────────────────
//
// Every git invocation below runs in the **project directory**, and for a project
// with the container toggle on that directory — `.git` included — is the
// container's writable rw mount (`services::sandbox` mounts `<project_dir>` whole).
// A repo's `.git/config` names programs git then executes, so a contained agent
// writing one gets code execution **on the host**, outside the container that was
// supposed to confine it. The sharpest is `core.fsmonitor`: it fires on plain
// `git status`, and `git_file_statuses`/`git_status` are polled continuously for
// the file tree — no user action anywhere in the chain.
//
// So Tabtivity's own invocations pin the config keys that turn a read into an exec.
// This does not need a read/write split: none of these are settings a Tabtivity
// git call wants honoured in the first place. Two layers: `-c` overrides for
// keys Tabtivity knows the exact name of ([`HARDENED_CONFIG`] below), and a
// pattern-matched strip of the repo's own `.git/config` file for keys whose
// name the attacker picks ([`CONFIG_DENYLIST`]/[`sanitize_repo_git_config`],
// further down) — a `-c` can only ever fix an exact key, so it cannot reach
// `filter.<any driver name>.clean`.

/// `-c <key>=<value>` overrides applied to every git call Tabtivity makes.
///
/// - `core.fsmonitor=false` — the hook form of this key is a program git runs on
///   `status`/`diff`. Pinning it off also costs the *builtin* FSMonitor daemon on
///   a repo that enables it, i.e. a little polling speed on very large trees; a
///   `-c` override cannot distinguish `true` (safe, builtin) from a path (exec),
///   and the safe direction is the one that cannot execute.
/// - `protocol.ext.allow=never` — an `ext::<command>` remote URL runs a shell
///   command, and git's default (`user`) permits exactly the direct invocations
///   Tabtivity makes. Tabtivity never legitimately uses `ext::`.
/// - `safe.bareRepository=explicit` — a folder laid out as a bare repository
///   (`HEAD`, `objects/`, `refs/`, `config`) is otherwise *itself* the git dir to
///   implicit discovery, and its `config` can name a `core.worktree` and filter
///   drivers the `.git`-based strip never sees (#158). Tabtivity never runs git in
///   a bare repo by discovery. Honoured only from protected config, which
///   includes `-c`; an older git ignores the unknown key.
///
/// Deliberately **not** here: `diff.external=`. An empty value does not disable an
/// external differ, it makes git try to exec the empty string and die
/// ("external diff died") — verified, and it would break diff for every user. The
/// working form is the per-command `--no-ext-diff` below.
const HARDENED_CONFIG: &[&str] = &[
    "core.fsmonitor=false",
    "protocol.ext.allow=never",
    "safe.bareRepository=explicit",
];

/// Subcommands that accept `--no-ext-diff` / `--no-textconv`, the two flags that
/// stop a repo-configured `diff.external` / `diff.<driver>.textconv` program from
/// running. Neither flag changes output for a repo that configures neither, and
/// every parser here reads git's own internal diff format anyway.
const DIFF_DRIVER_CMDS: &[&str] = &["diff", "log", "show", "blame"];

/// Prefix `args` with [`HARDENED_CONFIG`] and, for a [`DIFF_DRIVER_CMDS`]
/// subcommand, insert the diff-driver flags straight after it. Pure, so the shape
/// is unit-tested rather than inferred from a spawn.
///
/// **Known residual** — repo-controlled state naming a program git then
/// executes, of the same shape as [`HARDENED_CONFIG`] but where the attacker
/// picks the config key's own name so no fixed `-c` can name it in advance:
///
/// * a repo-local `filter.<driver>.clean`/`.smudge`/`.process` (bound by an
///   in-tree `.gitattributes`), or `diff.<driver>.textconv`/`.command`, on
///   `git diff`/`git add`/`git status`. **Closed** — for local git calls, via
///   [`CONFIG_DENYLIST`]/[`sanitize_repo_git_config`], run by every caller
///   that goes through [`hardened_git_command_in`] (which `run_git`'s local
///   branch does). Remote git calls are not covered (see `run_git`'s doc).
/// * **`.git/hooks/*`**. **Closed by default** (#862): this pins
///   [`NO_HOOKS_CONFIG`] too, unless the call goes through a `hooked` entry
///   point ([`run_git_hooked`], [`hooked_git_command_in`]). Reads are not
///   hook-free — `git add`, and `git diff` refreshing the index, fire
///   `post-index-change` even under `GIT_OPTIONAL_LOCKS=0` — so hooks-off had
///   to be the default rather than a per-verb opt-in. The hooked entry points
///   serve only the verbs where the user's hooks *are* the point — Commit,
///   Reword, Push, Publish, Pull's merge and the merge commit — and each is
///   gated by `services::exec_trust` first (`TrustKind::GitHooks`, see
///   [`require_hook_trust`]): the hook files and the repo-scope keys that name
///   programs (`core.hooksPath`, `core.sshCommand`, `credential*.helper`) are
///   fingerprinted and approved once, and any change asks again.
///   `services::git_guard` additionally mounts `.git/config` and `.git/hooks`
///   read-only for fenced and contained agents; the one redirect it cannot
///   cover — an agent *creating* a `commondir` in a main `.git`, so git reads
///   config and hooks from wherever it points — is overridden for every local
///   call by [`pin_common_dir`]. A plain `git` in the user's terminal still
///   follows such a file.
pub(crate) fn hardened_git_args<S: AsRef<str>>(args: &[S]) -> Vec<String> {
    git_args(args, Hooks::Off)
}

/// Whether a git call may run the repo's hooks. `Live` only behind
/// [`require_hook_trust`] — see [`hardened_git_args`].
#[derive(Clone, Copy, PartialEq, Eq)]
enum Hooks {
    Off,
    Live,
}

fn git_args<S: AsRef<str>>(args: &[S], hooks: Hooks) -> Vec<String> {
    let mut out: Vec<String> = Vec::with_capacity(args.len() + HARDENED_CONFIG.len() * 2 + 4);
    for kv in HARDENED_CONFIG {
        out.push("-c".to_string());
        out.push((*kv).to_string());
    }
    if hooks == Hooks::Off {
        for kv in NO_HOOKS_CONFIG {
            out.push("-c".to_string());
            out.push((*kv).to_string());
        }
    }
    let mut rest = args.iter().map(|a| a.as_ref()).peekable();
    // A caller may bring its own `-c <key>=<value>` pairs (`scoped_token_config`),
    // and those are git's *pre-subcommand* options — so they are passed through
    // first and the subcommand is whatever follows them. Without this the leading
    // `-c` was mistaken for the subcommand, which happens to still produce a valid
    // command line but would silently skip the diff-driver flags for `diff`/`log`/
    // `show`/`blame` the moment one of those grew a scoped config of its own.
    while rest.peek() == Some(&"-c") {
        out.push(rest.next().unwrap().to_string());
        if let Some(kv) = rest.next() {
            out.push(kv.to_string());
        }
    }
    if let Some(sub) = rest.next() {
        out.push(sub.to_string());
        if DIFF_DRIVER_CMDS.contains(&sub) {
            out.push("--no-ext-diff".to_string());
            out.push("--no-textconv".to_string());
        }
    }
    out.extend(rest.map(str::to_string));
    out
}

/// `crate::paths::command_no_window("git")` with [`git_args`] already applied —
/// the base of [`hardened_git_command_in`] and [`hooked_git_command_in`].
fn git_command<S: AsRef<str>>(args: &[S], hooks: Hooks) -> std::process::Command {
    let mut cmd = crate::paths::command_no_window("git");
    cmd.args(if hooks == Hooks::Off {
        hardened_git_args(args)
    } else {
        git_args(args, hooks)
    });
    // Read-only commands must not write the repo. `git status` (and everything
    // that runs it: the file tree's per-entry letters, the git bar, the pill's
    // dirty poll) opportunistically REWRITES `.git/index` when stat data looks
    // stale — an `index.lock` create + rename that bumps `.git`'s mtime, which the
    // file tree's non-recursive watch on the project root sees as a change to the
    // `.git` entry. That re-listed the folder, which ran `git status`, which
    // rewrote the index, which… — a closed loop that kept the root folder
    // re-listing about once a second for as long as it was on screen, and rows
    // flickering between sections whenever one of the piled-up probes failed.
    // `GIT_OPTIONAL_LOCKS=0` is git's own switch for exactly this ("don't take
    // optional locks, don't do the optional index refresh"): the output of every
    // read command is unchanged, and the mutating commands (add, commit, …) take
    // their mandatory locks regardless.
    cmd.env("GIT_OPTIONAL_LOCKS", "0");
    cmd
}

// ── Config-key denylist (Group O #151) ─────────────────────────────────────
//
// `HARDENED_CONFIG`'s per-key `-c` overrides can only ever fix an EXACT key —
// which closes `core.fsmonitor`/`protocol.ext.allow` because Tabtivity knows those
// names in advance, but cannot touch `filter.<driver>.clean`: the driver name is
// the attacker's choice, so there is no finite list of `-c` flags that covers it.
// This closes that shape instead, structurally: before any LOCAL git call, the
// project's own `.git/config` is read (as a plain file, never as a repo — this
// cannot itself trigger a filter/hook) and any key matching a denylisted
// *pattern* (section + suffix, subsection wildcarded) is stripped from the file
// in place. Unlike a `-c` override this generalizes over the attacker-chosen
// part of the key, the same way `git help config` says an alias can never
// override an existing subcommand name regardless of what it's called.

/// A `<prefix>*<suffix>` key shape, matched against `git config --list
/// --name-only`'s lowercase `section.subsection.key` form with the subsection
/// wildcarded — `("filter.", ".clean")` matches `filter.lfs.clean` and
/// `filter.anything.clean` alike.
struct DenylistedConfigKey {
    prefix: &'static str,
    suffix: &'static str,
}

/// Key shapes that name a program git executes, or that launder one into a
/// file this sanitizer never inspects. Deliberately narrow, and each entry
/// earns its place:
///
/// - `filter.*.clean` / `.smudge` / `.process` — the named residual: an
///   in-repo `.gitattributes` binds a path to this driver name, and this is
///   the command git then runs on `status`/`diff`/`add`. **Known cost**: a
///   repo that legitimately uses a content filter (Git LFS is the common
///   case) loses it for every local git call this codebase makes — `status`
///   sees unfiltered content instead of smudged/cleaned content. There is no
///   way to keep "some filters, but not attacker-chosen ones" here; the
///   command names *are* the entire configuration surface for a filter.
/// - `diff.*.textconv` / `.command` — the same shape for diff drivers.
///   Belt-and-suspenders beside the per-command `--no-textconv`/`--no-ext-diff`
///   flags on [`DIFF_DRIVER_CMDS`]: those don't cover every subcommand that
///   can trigger a diff (and won't cover one added later that forgets them),
///   and the config-level strip means a future call site needs nothing extra.
/// - `include.path` / `includeif.*.path` — **not optional**: without denying
///   these, an attacker launders any of the above through a second file this
///   sanitizer never reads (`git config --file` does not follow includes by
///   default, so removing a key from the top-level file does nothing if the
///   real definition lives in an included one) — the include directive itself
///   is the thing that must go.
///
/// **Deliberately not here**, both distinct, already-documented trade-offs
/// rather than oversights:
/// - `.git/hooks/*` — files, not config keys; pinned off per call by
///   [`hardened_git_args`], and left live only for the commit/push verbs,
///   where a user's own hooks are the point. A planted hook is not this
///   sanitizer's job: the ask-once `services::exec_trust` gate on those verbs
///   covers it.
/// - `alias.*` — not a vector against this codebase at all: every subcommand
///   here is a live builtin, and `git help config` states an alias hiding an
///   existing command "is ignored except for deprecated commands."
/// - `credential.helper` / `credential.*.helper` — real exec capability, but
///   blocking the *key* also breaks the legitimate case (a credential helper
///   set from inside a container, meant to carry to the host's later push);
///   closing it without that cost needs value-level judgment (an allowlist of
///   known-safe helper names) this pass doesn't attempt. Covered instead by
///   the `services::exec_trust` fingerprint, which includes these keys.
const CONFIG_DENYLIST: &[DenylistedConfigKey] = &[
    DenylistedConfigKey {
        prefix: "filter.",
        suffix: ".clean",
    },
    DenylistedConfigKey {
        prefix: "filter.",
        suffix: ".smudge",
    },
    DenylistedConfigKey {
        prefix: "filter.",
        suffix: ".process",
    },
    DenylistedConfigKey {
        prefix: "diff.",
        suffix: ".textconv",
    },
    DenylistedConfigKey {
        prefix: "diff.",
        suffix: ".command",
    },
    DenylistedConfigKey {
        prefix: "include.",
        suffix: "path",
    },
    DenylistedConfigKey {
        prefix: "includeif.",
        suffix: ".path",
    },
];

/// Pure match against [`CONFIG_DENYLIST`], case-insensitive (git lowercases
/// section and key names itself; only the attacker-controlled subsection may
/// carry mixed case, and it never touches the fixed prefix/suffix ends this
/// checks).
fn is_denylisted_config_key(key: &str) -> bool {
    let key = key.to_ascii_lowercase();
    CONFIG_DENYLIST
        .iter()
        .any(|d| key.starts_with(d.prefix) && key.ends_with(d.suffix))
}

/// Strip every [`CONFIG_DENYLIST`]-matching key from `project_dir`'s
/// `.git/config`, in place, before any LOCAL git call runs against it. A
/// no-op when there's no repo, no config, or nothing to strip.
///
/// **Best-effort, and deliberately non-blocking on failure**: if listing the
/// config fails outright, that means `.git/config` is malformed badly enough
/// that git itself cannot parse it — which the *actual* command this call is
/// guarding would then also fail on identically (a fatal config parse error
/// stops git before it invokes anything), so silently skipping sanitization
/// here creates no new exposure. Each `--unset-all` is likewise independent —
/// one failing (a key already gone, a race with a concurrent write) must not
/// leave the rest of a poisoned config standing.
///
/// Reads/writes the file directly via `git config --file <path>` rather than
/// `git -C <project_dir>` — listing or editing a config file this way cannot
/// itself invoke a filter or hook, so this cannot be the very thing it exists
/// to prevent.
fn sanitize_repo_git_config(project_dir: &Path) {
    for config in repo_config_files(project_dir) {
        sanitize_git_config_file(&config);
    }
}

/// Every repo-scope config file git reads for a command run in `project_dir`,
/// found the way git's own discovery finds them but **without running git in
/// the repo** (that would be the very call this guards; #158):
///
/// - the nearest `.git` walking up from `project_dir` — a project folder can sit
///   below its repo's root, and git walks up too;
/// - a `.git` *file* is a pointer (`gitdir: <path>`, relative to its folder):
///   linked worktrees, submodules, `--separate-git-dir`, and a hostile
///   `gitdir: .notgit`. Followed exactly one hop, as git does;
/// - a git dir reached through a pointer, with a `commondir` (a linked
///   worktree's), shares the common dir's `config`. A `commondir` inside a
///   **main** `.git` directory is never git's own (#862) — it is a redirect a
///   sandboxed agent can create even with `.git/config` and `.git/hooks` bound
///   read-only — so it is not followed here: [`pin_common_dir`] makes git
///   ignore it too, and following it would only strip keys from whatever file
///   the attacker named;
/// - `config.worktree` beside each: `extensions.worktreeConfig` makes git read
///   it as a second repo-scope file.
///
/// A folder that is itself a git dir (bare layout) is not found here — the
/// `safe.bareRepository=explicit` pin in [`HARDENED_CONFIG`] refuses it instead.
fn repo_config_files(project_dir: &Path) -> Vec<PathBuf> {
    let Some(git_dir) = discover_git_dir(project_dir) else {
        return Vec::new();
    };
    let mut dirs = vec![git_dir.path.clone()];
    if !git_dir.main {
        if let Ok(common) = std::fs::read_to_string(git_dir.path.join("commondir")) {
            let common = common.trim();
            if !common.is_empty() {
                dirs.push(git_dir.path.join(common)); // an absolute path replaces the base
            }
        }
    }
    dirs.iter()
        .flat_map(|d| [d.join("config"), d.join("config.worktree")])
        .collect()
}

/// The git dir [`discover_git_dir`] found.
struct GitDir {
    path: PathBuf,
    /// A real `.git` directory — not a pointer file, not a symlink. A main
    /// repo's git dir is its own common dir; only a linked worktree's (always
    /// reached through a pointer) legitimately names another.
    main: bool,
}

/// The git dir for `project_dir`: the nearest ancestor's `.git` directory, or
/// the target of the nearest `.git` pointer file.
fn discover_git_dir(project_dir: &Path) -> Option<GitDir> {
    for dir in project_dir.ancestors() {
        let dot_git = dir.join(".git");
        if dot_git.is_dir() {
            let main = std::fs::symlink_metadata(&dot_git).is_ok_and(|m| m.is_dir());
            return Some(GitDir { path: dot_git, main });
        }
        if dot_git.is_file() {
            let text = std::fs::read_to_string(&dot_git).ok()?;
            let target = text.lines().find_map(|l| l.strip_prefix("gitdir:"))?.trim();
            return (!target.is_empty()).then(|| GitDir { path: dir.join(target), main: false });
        }
    }
    None
}

/// Pin `GIT_COMMON_DIR` to the main `.git` directory git will discover for
/// `project_dir`, so a `commondir` file planted in it is ignored (#862). git
/// reads config, hooks, refs and objects from the common dir, and an agent
/// whose fence binds `.git/config` and `.git/hooks` read-only can still create
/// `.git/commondir` pointing at a directory of its own — verified: git then
/// runs that directory's `hooks/post-index-change` on a plain `git add`.
///
/// Pinned whenever the git dir is a main one, not only when a `commondir` is
/// present: for a main repo the value is what git would use anyway, and a
/// check-then-run would leave a window to plant the file in. Not pinned for a
/// pointer (linked worktree, submodule, `--separate-git-dir`), where a
/// `commondir` is git's own. git drops the variable for submodule and
/// local-transport children (`local_repo_env`); hooks the trusted verbs run
/// inherit it, as they already inherit `GIT_INDEX_FILE`.
pub(crate) fn pin_common_dir(cmd: &mut std::process::Command, project_dir: &Path) {
    let Some(git_dir) = discover_git_dir(project_dir).filter(|g| g.main) else {
        return;
    };
    // git cannot parse Windows' `\\?\` form, and `absolute` keeps it when the
    // caller already canonicalized `project_dir` (the dir-size breakdown does).
    if let Ok(abs) = std::path::absolute(&git_dir.path) {
        cmd.env("GIT_COMMON_DIR", crate::commands::fs::display_path(&abs));
    }
}

fn sanitize_git_config_file(config_path: &Path) {
    let Some(config_path_str) = config_path.to_str() else {
        return;
    };
    if !config_path.is_file() {
        return;
    }
    let Ok(listed) = crate::paths::command_no_window("git")
        .args([
            "config",
            "--file",
            config_path_str,
            "--name-only",
            "--list",
            "--no-includes",
        ])
        .output()
    else {
        return;
    };
    if !listed.status.success() {
        return;
    }
    let keys: std::collections::HashSet<String> = String::from_utf8_lossy(&listed.stdout)
        .lines()
        .map(str::trim)
        .filter(|k| !k.is_empty())
        .map(str::to_string)
        .collect();
    for key in keys {
        if !is_denylisted_config_key(&key) {
            continue;
        }
        let _ = crate::paths::command_no_window("git")
            .args(["config", "--file", config_path_str, "--unset-all", &key])
            .output();
    }
}

/// [`git_command`] with [`sanitize_repo_git_config`] run first, `current_dir
/// (project_dir)` set, [`pin_common_dir`] applied and hooks pinned off — the one
/// function every LOCAL git spawn in this codebase goes through, so "this
/// project's repo is untrusted" (Group O #151, #862) has one definition instead
/// of one per call site. Hooks run only through [`hooked_git_command_in`].
pub(crate) fn hardened_git_command_in<S: AsRef<str>, P: AsRef<Path>>(
    project_dir: P,
    args: &[S],
) -> std::process::Command {
    git_command_in(project_dir.as_ref(), args, Hooks::Off)
}

/// [`hardened_git_command_in`] with the repo's hooks left live — only for a verb
/// [`require_hook_trust`] has just approved (push, Publish's push). Everything
/// else about the call is hardened the same.
pub(crate) fn hooked_git_command_in<S: AsRef<str>, P: AsRef<Path>>(
    project_dir: P,
    args: &[S],
) -> std::process::Command {
    git_command_in(project_dir.as_ref(), args, Hooks::Live)
}

/// [`hardened_git_command_in`] under the name the background callers (lockstep,
/// the scaffold commit, the MCP git tools) were written against: no hook in the
/// repo may ever run through them. Hooks-off is now the default for every call,
/// so this is the same command.
pub(crate) fn hookless_git_command_in<S: AsRef<str>, P: AsRef<Path>>(
    project_dir: P,
    args: &[S],
) -> std::process::Command {
    hardened_git_command_in(project_dir, args)
}

fn git_command_in<S: AsRef<str>>(project_dir: &Path, args: &[S], hooks: Hooks) -> std::process::Command {
    // `init` creates a new repository here. An ancestor may itself be a repo
    // (including a shared temp root); pinning its common dir would make the
    // new repository incomplete and send later commands to the ancestor.
    let initializing = args.first().is_some_and(|arg| arg.as_ref() == "init");
    if !initializing {
        sanitize_repo_git_config(project_dir);
    }
    let mut cmd = git_command(args, hooks);
    cmd.current_dir(project_dir);
    if !initializing {
        pin_common_dir(&mut cmd, project_dir);
    }
    cmd
}

/// Run `git <args>` for a project, dispatching local-vs-remote on `target`.
/// Returns the captured `Output` (stdout/stderr/exit) for both, so callers parse
/// it identically. `target` is the resolved remoteness for `project_dir`.
///
/// Both branches go through [`hardened_git_args`] — the remote one too, because a
/// host repo's config is written by whatever runs on that host, and `git <args>`
/// there is built from the same argument list. [`sanitize_repo_git_config`] is
/// LOCAL-only, though (via [`hardened_git_command_in`]): a project container only
/// ever mounts a local directory (`services::sandbox` refuses remote projects),
/// so the container→host escalation this exists for has no remote counterpart —
/// a remote host's own `.git/config` is that host's business, same as any other
/// file a user's own SSH session could write there.
///
/// Hooks are pinned off on both sides; [`run_git_hooked`] is the exception.
pub(crate) fn run_git(
    target: Option<&RemoteTarget>,
    project_dir: &str,
    args: &[&str],
) -> Result<std::process::Output, String> {
    run_git_as(target, project_dir, args, Hooks::Off)
}

/// [`run_git`] with the repo's hooks left live — only for a verb
/// [`require_hook_trust`] has just approved (commit, reword, Pull's merge, the
/// merge commit).
pub(crate) fn run_git_hooked(
    target: Option<&RemoteTarget>,
    project_dir: &str,
    args: &[&str],
) -> Result<std::process::Output, String> {
    run_git_as(target, project_dir, args, Hooks::Live)
}

fn run_git_as(
    target: Option<&RemoteTarget>,
    project_dir: &str,
    args: &[&str],
    hooks: Hooks,
) -> Result<std::process::Output, String> {
    match target {
        Some(t) => {
            let args = git_args(args, hooks);
            crate::services::ssh_exec::run_git_remote(&t.spec, &args)
        }
        None => git_command_in(Path::new(project_dir), args, hooks)
            .output()
            .map_err(|e| e.to_string()),
    }
}

/// Whether `s` is safe to hand `git` as a revision / refname / commit-ish.
///
/// `git check-ref-format` happily accepts a refname whose last component starts
/// with `-` (`refs/heads/--output=/tmp/x` is format-legal), so a hostile upstream
/// can publish one, `git_branches` will list it, and the moment it reaches `git`
/// as a bare positional argument git parses it as an **option**. On the
/// `log`/`show`/`diff` family the useful one is `--output=<file>`: an arbitrary
/// attacker-directed file write as the user, which the persisted-layout and
/// `open_apps` sinks then turn into execution.
///
/// A `--` separator is *not* the fix for a rev: `git checkout <branch> --` means
/// "check out this tree-ish with an empty pathspec" and `git log <rev> --` changes
/// what the pathspec limits to, so inserting one would silently change behaviour.
/// Every path argument in this module already has its `--` (see `git add`,
/// `git status`, `git diff`, `git blame`, `git log --follow`); revisions are
/// validated instead.
///
/// Rejected: empty, a leading `-`, whitespace, and ASCII control characters —
/// none of which a legal refname can contain, so nothing legitimate is lost.
pub(crate) fn valid_rev(s: &str) -> bool {
    !s.is_empty() && !s.starts_with('-') && !s.chars().any(|c| c.is_whitespace() || c.is_control())
}

/// [`valid_rev`] as a command error, so a call site is one `?` away from safe.
pub(crate) fn check_rev(s: &str) -> Result<(), String> {
    if valid_rev(s) {
        Ok(())
    } else {
        Err(format!("'{s}' is not a valid git revision"))
    }
}

/// Whether `s` is safe to hand `git` as a bare positional **path** at a call site
/// that cannot take a `--` separator (`git worktree add/remove`, whose synopsis has
/// no pathspec boundary). Only the option-lookalike case is rejected; everything
/// else about the path is git's business.
fn valid_positional_path(s: &str) -> bool {
    !s.trim().is_empty() && !s.starts_with('-')
}

/// Cheap "not a git repo" short-circuit for the read commands. Applies only to
/// **local** projects, where a missing `.git` means "no repo" without spawning
/// git. A remote project's `.git` lives on the host, so it is never short-
/// circuited here — its command runs over SSH and the usual lenient
/// empty-on-failure handling covers a non-repo host dir.
pub(crate) fn local_non_repo(target: Option<&RemoteTarget>, project_dir: &str) -> bool {
    target.is_none() && !Path::new(project_dir).join(".git").exists()
}

/// Run a blocking git command body on a worker thread.
///
/// Every git command here is genuinely blocking — `run_git` either spawns a local
/// `git` subprocess (`.output()`) or runs `git` over SSH (`run_git_remote`, which
/// can stall up to the SSH `ConnectTimeout`/`ServerAlive` window on an unreachable
/// or unauthenticated host). Tauri runs a synchronous `#[command]` on the MAIN
/// thread, so doing that work inline froze the whole window whenever a remote
/// project's host was down (the remote-disconnect freeze). Each command is an
/// `async` wrapper that offloads its sync body here via `spawn_blocking`, so the
/// blocking work runs on tokio's blocking pool and the UI thread stays free. The
/// bodies live in sibling `*_blocking` fns (kept sync, so they remain directly
/// unit-testable without a tokio runtime).
pub(crate) async fn run_off_thread<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| format!("git task failed: {e}"))?
}

/// Whether the `git` binary is on `PATH`. The new/import-project dialog calls
/// this before offering a git-backed project, so a missing `git` surfaces as an
/// install prompt instead of `scaffold_project` silently no-oping `git init`
/// (see its `let _ =` discard) and registering a git-typed project with no repo.
#[tauri::command]
pub fn git_available() -> bool {
    crate::paths::command_no_window("git")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

#[derive(serde::Serialize)]
pub struct GitStatus {
    pub staged: usize,
    pub unstaged: usize,
    pub untracked: usize,
    pub has_remote: bool,
    pub is_repo: bool,
    /// Commits the upstream has that the current branch lacks, as of the last
    /// fetch — the git bar's Pull button. `0` with no upstream.
    pub behind: usize,
    /// A tag already names `HEAD` — the git bar hides Release, whose only
    /// target is that commit. Probed only for a local repo with a remote (the
    /// sole case the button shows); `false` otherwise.
    pub head_tagged: bool,
}

#[tauri::command]
pub async fn git_status(
    project_dir: String,
    worktree: Option<GitWorktreeSelection>,
) -> Result<GitStatus, String> {
    run_off_thread(move || match worktree {
        None => git_status_blocking(project_dir),
        Some(selection) => git_status_blocking_selected(project_dir, Some(selection)),
    })
    .await
}

fn git_status_blocking(project_dir: String) -> Result<GitStatus, String> {
    git_status_blocking_selected(project_dir, None)
}

fn git_status_blocking_selected(
    project_dir: String,
    worktree: Option<GitWorktreeSelection>,
) -> Result<GitStatus, String> {
    git_status_probe_selected(project_dir, true, worktree)
}

/// `probe_remote: false` skips the `git remote` spawn and reports
/// `has_remote: false`. Only `git_dirty_probe` passes it: that path is the
/// switcher's 12 s per-project poll, and its sole consumer (`stores/gitDirty.ts`
/// → `gitDirtyState`) reads the counts and `is_repo`, never `has_remote` — so the
/// second process (an SSH round trip on a remote project) bought nothing. The
/// `git_status` command keeps the full answer for anything that does read it.
pub(crate) fn git_status_probe(project_dir: String, probe_remote: bool) -> Result<GitStatus, String> {
    git_status_probe_selected(project_dir, probe_remote, None)
}

fn git_status_probe_selected(
    project_dir: String,
    probe_remote: bool,
    worktree: Option<GitWorktreeSelection>,
) -> Result<GitStatus, String> {
    let (project_dir, target) = selected_git_context(project_dir, worktree.as_ref())?;
    if local_non_repo(target.as_ref(), &project_dir) {
        return Ok(GitStatus {
            staged: 0,
            unstaged: 0,
            untracked: 0,
            has_remote: false,
            is_repo: false,
            behind: 0,
            head_tagged: false,
        });
    }

    // `--branch` adds one `## main...origin/main [behind 2]` header — the
    // behind count for free, in the spawn this probe already pays for.
    let out = run_git(
        target.as_ref(),
        &project_dir,
        &["status", "--porcelain", "--branch"],
    )?;

    let text = String::from_utf8_lossy(&out.stdout);
    let mut staged = 0usize;
    let mut unstaged = 0usize;
    let mut untracked = 0usize;
    let mut behind = 0usize;
    for line in text.lines() {
        if let Some(header) = line.strip_prefix("## ") {
            behind = header
                .rfind('[')
                .map(|at| parse_track(&header[at..]).1)
                .unwrap_or(0);
            continue;
        }
        if line.len() < 2 {
            continue;
        }
        let x = line.chars().next().unwrap_or(' ');
        let y = line.chars().nth(1).unwrap_or(' ');
        if x == '?' && y == '?' {
            untracked += 1;
        } else {
            if x != ' ' {
                staged += 1;
            }
            if y != ' ' {
                unstaged += 1;
            }
        }
    }

    let has_remote = probe_remote
        && run_git(target.as_ref(), &project_dir, &["remote"])
            .map(|o| !o.stdout.is_empty())
            .unwrap_or(false);
    let head_tagged = has_remote
        && target.is_none()
        && run_git(None, &project_dir, &["tag", "--points-at", "HEAD"])
            .map(|o| o.status.success() && !o.stdout.trim_ascii().is_empty())
            .unwrap_or(false);

    Ok(GitStatus {
        staged,
        unstaged,
        untracked,
        has_remote,
        is_repo: true,
        behind,
        head_tagged,
    })
}

/// `(ahead, behind)` out of git's tracking text — `[ahead 1, behind 2]`,
/// `ahead 1` (`%(upstream:track,nobracket)`), `[gone]` or empty. Anything it
/// does not recognise counts as zero: a stale reading never invents a pull.
pub(crate) fn parse_track(s: &str) -> (usize, usize) {
    let mut ahead = 0;
    let mut behind = 0;
    for part in s.trim_matches(|c| c == '[' || c == ']').split(',') {
        let mut words = part.split_whitespace();
        let (Some(word), Some(n)) = (words.next(), words.next()) else {
            continue;
        };
        let n = n.parse().unwrap_or(0);
        match word {
            "ahead" => ahead = n,
            "behind" => behind = n,
            _ => {}
        }
    }
    (ahead, behind)
}

/// One probe behind the project switcher's per-pill git dot.
#[derive(serde::Serialize)]
pub struct GitDirtyProbe {
    pub status: GitStatus,
    /// Commits ahead of the upstream — computed **only when the working tree is
    /// clean**, `0` otherwise (the dot never consults it while anything is
    /// dirty or staged, so probing it unconditionally paid a second git spawn
    /// per project per poll tick for an answer that was then discarded).
    pub unpushed: usize,
}

/// `git_status` + the unpushed-commit count as ONE command, for the switcher's
/// 12 s per-project dot poll: one git spawn and one IPC round trip in the
/// common (dirty, non-repo, or no-upstream-relevant) case instead of two each.
#[tauri::command]
pub async fn git_dirty_probe(project_dir: String) -> Result<GitDirtyProbe, String> {
    run_off_thread(move || {
        // `has_remote` is not read by the dot (see `git_status_probe`); skip it.
        let status = git_status_probe(project_dir.clone(), false)?;
        let clean = status.is_repo
            && status.staged == 0
            && status.unstaged == 0
            && status.untracked == 0;
        let unpushed = if clean {
            // Best-effort, like the frontend's old `.catch(() => [])`: a failed
            // unpushed read must not blank a dot the status half already earned.
            git_unpushed_commits_blocking(project_dir)
                .map(|v| v.len())
                .unwrap_or(0)
        } else {
            0
        };
        Ok(GitDirtyProbe { status, unpushed })
    })
    .await
}

/// Resolve the git top-level enclosing `project_dir`/`rel_path` (the folder the
/// user is currently browsing in the file tree). Returns the absolute repo root
/// path, or `None` when the folder isn't inside any git repo. The side panel
/// uses this to detect a **nested** repo — a subfolder that is its own git repo
/// distinct from the project's repo — and re-root its git section at it.
///
/// Local only for now: a remote project's tree lives on the host, and a nested
/// host toplevel can't be reverse-mapped back to the project's `RemoteSpec` by
/// `remote_target_for_dir`, so remote projects short-circuit to `None` and keep
/// their existing project-scoped behavior.
#[tauri::command]
pub async fn git_repo_root(
    project_dir: String,
    rel_path: String,
) -> Result<Option<String>, String> {
    run_off_thread(move || git_repo_root_blocking(project_dir, rel_path)).await
}

fn git_repo_root_blocking(project_dir: String, rel_path: String) -> Result<Option<String>, String> {
    // Remote projects keep project-scoped git (see doc comment).
    if remote_target_for_dir(&project_dir).is_some() {
        return Ok(None);
    }
    let dir: PathBuf = if rel_path.is_empty() {
        PathBuf::from(&project_dir)
    } else {
        Path::new(&project_dir).join(&rel_path)
    };
    // `--show-toplevel` prints the absolute root of the innermost repo enclosing
    // `dir`. Any failure (not a repo, missing dir) maps to `None`, not an error,
    // so the UI treats it as "no repo here" rather than flashing a banner.
    let out = crate::paths::command_no_window("git")
        .args(["rev-parse", "--show-toplevel"])
        .current_dir(&dir)
        .output();
    match out {
        Ok(o) if o.status.success() => {
            let top = String::from_utf8_lossy(&o.stdout).trim().to_string();
            Ok(if top.is_empty() { None } else { Some(top) })
        }
        _ => Ok(None),
    }
}

#[tauri::command]
pub async fn git_add_all(
    project_dir: String,
    worktree: Option<GitWorktreeSelection>,
) -> Result<(), String> {
    run_off_thread(move || match worktree {
        None => git_add_all_blocking(project_dir),
        Some(selection) => git_add_all_blocking_selected(project_dir, Some(selection)),
    })
    .await
}

fn git_add_all_blocking(project_dir: String) -> Result<(), String> {
    git_add_all_blocking_selected(project_dir, None)
}

fn git_add_all_blocking_selected(
    project_dir: String,
    worktree: Option<GitWorktreeSelection>,
) -> Result<(), String> {
    let (project_dir, target) = selected_git_context(project_dir, worktree.as_ref())?;
    let out = run_git(target.as_ref(), &project_dir, &["add", "-A"])?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).to_string());
    }
    Ok(())
}

#[tauri::command]
pub async fn git_generate_commit_message(
    project_dir: String,
    worktree: Option<GitWorktreeSelection>,
) -> Result<String, String> {
    run_off_thread(move || match worktree {
        None => git_generate_commit_message_blocking(project_dir),
        Some(selection) => {
            git_generate_commit_message_blocking_selected(project_dir, Some(selection))
        }
    })
    .await
}

fn git_generate_commit_message_blocking(project_dir: String) -> Result<String, String> {
    git_generate_commit_message_blocking_selected(project_dir, None)
}

fn git_generate_commit_message_blocking_selected(
    project_dir: String,
    worktree: Option<GitWorktreeSelection>,
) -> Result<String, String> {
    let (project_dir, target) = selected_git_context(project_dir, worktree.as_ref())?;
    let files_out = run_git(
        target.as_ref(),
        &project_dir,
        &["diff", "--staged", "--name-only"],
    )?;
    let staged_text = String::from_utf8_lossy(&files_out.stdout).to_string();
    let staged: Vec<&str> = staged_text.lines().collect();

    // Also check untracked / unstaged if nothing staged
    let files: Vec<String> = if staged.is_empty() {
        let all = run_git(target.as_ref(), &project_dir, &["diff", "--name-only"])
            .map(|o| {
                String::from_utf8_lossy(&o.stdout)
                    .lines()
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default();
        all
    } else {
        staged.iter().map(|s| s.to_string()).collect()
    };

    if files.is_empty() {
        return Ok("chore: update files".to_string());
    }

    let kind = infer_commit_type(&files);
    let msg = format_commit_message(kind, &files);
    Ok(msg)
}

fn infer_commit_type(files: &[String]) -> &'static str {
    let has = |pat: &str| files.iter().any(|f| f.contains(pat));
    if has(".github/") || has("ci-cd") || has("Dockerfile") {
        return "ci";
    }
    if files.iter().all(|f| f.ends_with(".md")) {
        return "docs";
    }
    if has("Cargo.toml") || has("package.json") || has("package-lock") {
        return "chore";
    }
    if has("test") || has("spec") || has("__tests__") {
        return "test";
    }
    if has("src/") || has("src-tauri/src/") {
        return "feat";
    }
    "chore"
}

fn format_commit_message(kind: &str, files: &[String]) -> String {
    let names: Vec<String> = files
        .iter()
        .map(|f| {
            std::path::Path::new(f)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or(f.as_str())
                .to_string()
        })
        .collect();

    let mut seen = std::collections::HashSet::new();
    let unique: Vec<&String> = names.iter().filter(|n| seen.insert(n.as_str())).collect();

    let subject = match unique.len() {
        0 => "update files".to_string(),
        1 => format!("update {}", unique[0]),
        2 => format!("update {} and {}", unique[0], unique[1]),
        _ => format!(
            "update {}, {} and {} more",
            unique[0],
            unique[1],
            unique.len() - 2
        ),
    };
    format!("{kind}: {subject}")
}

#[tauri::command]
pub async fn git_commit(
    project_dir: String,
    message: String,
    worktree: Option<GitWorktreeSelection>,
) -> Result<(), String> {
    run_off_thread(move || match worktree {
        None => git_commit_blocking(project_dir, message),
        Some(selection) => git_commit_blocking_selected(project_dir, message, Some(selection)),
    })
    .await
}

fn git_commit_blocking(project_dir: String, message: String) -> Result<(), String> {
    git_commit_blocking_selected(project_dir, message, None)
}

fn git_commit_blocking_selected(
    project_dir: String,
    message: String,
    worktree: Option<GitWorktreeSelection>,
) -> Result<(), String> {
    let (project_dir, target) = selected_git_context(project_dir, worktree.as_ref())?;
    require_hook_trust(target.as_ref(), &project_dir)?;
    let out = run_git_hooked(target.as_ref(), &project_dir, &["commit", "-m", &message])?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).to_string());
    }
    Ok(())
}

/// Returns a map of `relative_path → status` for all entries directly under `rel_path`.
/// Status values (highest priority first when bubbled up to a directory):
///   "modified"  – tracked file with unstaged working-tree changes (red bar)
///   "untracked" – new, not yet tracked (red bar)
///   "staged"    – staged, not yet committed (orange bar)
///   "unpushed"  – committed locally but not pushed to upstream (green ↑)
///   "ignored"   – ignored by git (gray ✕)
/// For directories the highest-priority child status bubbles up.
#[tauri::command]
pub async fn git_file_statuses(
    project_dir: String,
    rel_path: String,
) -> Result<HashMap<String, String>, String> {
    run_off_thread(move || git_file_statuses_blocking(project_dir, rel_path)).await
}

fn git_file_statuses_blocking(
    project_dir: String,
    rel_path: String,
) -> Result<HashMap<String, String>, String> {
    let target = remote_target_for_dir(&project_dir);
    if local_non_repo(target.as_ref(), &project_dir) {
        return Ok(HashMap::new());
    }

    // A directory that is itself wholly ignored is collapsed by git into a
    // single `!! rel_path/` line at every ancestor listing under the default
    // `--untracked-files=normal` — so listing `rel_path` itself would come
    // back with zero lines under its prefix, and its children would silently
    // lose their "ignored" marker (rather than the folder just being empty of
    // git-reportable changes, which is the far more common reason this map
    // comes back empty). Detect that case up front via `check-ignore` and add
    // `--untracked-files=all`, which makes git recurse into an ignored
    // directory and report every file underneath individually instead of
    // collapsing it, scoped to `rel_path` so this stays cheap even inside a
    // huge folder like `node_modules`. Left off for the common case: it's a
    // more expensive walk, and combined with the anti-bubble rule below it
    // would actually stop a normal (non-wholly-ignored-ancestor) ignored
    // subfolder from being recognized, since a deep file line like
    // `sub/leaf.js` never equals its containing folder's own name.
    let wholly_ignored = !rel_path.is_empty()
        && run_git(
            target.as_ref(),
            &project_dir,
            &["check-ignore", "-q", "--", &rel_path],
        )
        .map(|out| out.status.success())
        .unwrap_or(false);

    // Scope the status to the browsed folder. Without a pathspec git walks the
    // WHOLE repo — and with `--ignored` that means stat-ing every ignored path in
    // it — only for `record` below to throw away every line outside `rel_path`
    // anyway. On a REMOTE project that walk runs on the host over SSH, on every
    // folder navigation and on every Local→Remote switch, which is what made
    // both feel like a hang on a repo carrying big gitignored trees (data,
    // checkpoints, venvs). The wholly-ignored branch already scoped itself for
    // exactly this reason; the common branch just never did. An empty
    // `rel_path` IS the repo root, so there is nothing to scope it to.
    let status_args: Vec<&str> = if wholly_ignored {
        vec![
            "status",
            "--porcelain",
            "--ignored",
            "--untracked-files=all",
            "--",
            &rel_path,
        ]
    } else if rel_path.is_empty() {
        vec![
            "status",
            "--porcelain",
            "--ignored",
            "--untracked-files=normal",
        ]
    } else {
        vec![
            "status",
            "--porcelain",
            "--ignored",
            "--untracked-files=normal",
            "--",
            &rel_path,
        ]
    };
    let out = run_git(target.as_ref(), &project_dir, &status_args)?;
    let porcelain = String::from_utf8_lossy(&out.stdout).into_owned();

    // prefix used to filter entries under rel_path
    let prefix = if rel_path.is_empty() {
        String::new()
    } else {
        format!("{rel_path}/")
    };

    fn priority(s: &str) -> u8 {
        match s {
            "modified" => 5,
            "untracked" => 4,
            "staged" => 3,
            "unpushed" => 2,
            "ignored" => 1,
            _ => 0,
        }
    }

    let mut map: HashMap<String, String> = HashMap::new();
    // Record `raw_path → status`, bubbling the highest-priority status up to the
    // top-level entry directly under `rel_path`.
    let mut record = |raw_path: &str, status: &str| {
        let file_path = if raw_path.contains(" -> ") {
            raw_path
                .split(" -> ")
                .last()
                .unwrap_or(raw_path)
                .trim_matches('"')
        } else {
            raw_path.trim_matches('"')
        };

        let rel = if prefix.is_empty() {
            file_path
        } else if let Some(stripped) = file_path.strip_prefix(&prefix) {
            stripped
        } else {
            return;
        };

        let top = rel.split('/').next().unwrap_or(rel);
        if top.is_empty() {
            return;
        }

        // "ignored" must not bubble up from a descendant: git reports a wholly
        // ignored path as `foo` (file) or `foo/` (whole dir), but an ignored
        // file inside an otherwise-tracked dir as `foo/bar`. Only mark the
        // top-level entry ignored when the ignored path IS that entry — else a
        // single ignored child would drag the whole folder into the gitignored
        // section. Other statuses still bubble up so a dir reflects its changes.
        // Skipped when `rel_path` itself is already known to be wholly
        // ignored: every line here is one of its descendants, so there is no
        // "is this ONE child ignored or is the whole folder" ambiguity to
        // guard against, and a deep file's top-level parent must still be
        // marked ignored even though the two paths never match exactly.
        if status == "ignored" && !wholly_ignored && rel.trim_end_matches('/') != top {
            return;
        }

        let cur = map.get(top).map(|s| priority(s.as_str())).unwrap_or(0);
        if priority(status) > cur {
            map.insert(top.to_string(), status.to_string());
        }
    };

    for line in porcelain.lines() {
        if line.len() < 4 {
            continue;
        }
        let bytes = line.as_bytes();
        let (x, y) = (bytes[0], bytes[1]);
        let raw_path = &line[3..];

        let status = if x == b'!' && y == b'!' {
            "ignored"
        } else if x == b'?' && y == b'?' {
            "untracked"
        } else if y != b' ' {
            // Unstaged working-tree change (also covers partly-staged like "MM").
            "modified"
        } else if x != b' ' {
            "staged"
        } else {
            continue;
        };
        record(raw_path, status);
    }

    // Files in commits that exist locally but are not on the upstream branch.
    let unpushed = unpushed_base(target.as_ref(), &project_dir).and_then(|base| {
        run_git(
            target.as_ref(),
            &project_dir,
            &["log", &format!("{base}.."), "--name-only", "--pretty=format:"],
        )
        .ok()
    });
    if let Some(out) = unpushed {
        if out.status.success() {
            let committed = String::from_utf8_lossy(&out.stdout).into_owned();
            for line in committed.lines() {
                let p = line.trim();
                if !p.is_empty() {
                    record(p, "unpushed");
                }
            }
        }
    }

    // When `rel_path` is itself wholly ignored, EVERY entry under it is ignored —
    // but git's porcelain only ever emits *file* lines, so a child that is an
    // empty directory (or a tree of only empty directories, e.g. freshly scaffolded
    // experiment-output folders) produces no line at all and would silently drop
    // its "ignored" marker, landing in the regular section. git also can't be
    // coaxed into listing such dirs: it collapses a wholly-ignored subtree to its
    // topmost ignored ancestor and never enumerates empty descendants. Emit a
    // sentinel under the reserved key "." (never a real listing entry) so the
    // frontend can default every child of this directory to ignored, letting any
    // explicit per-child status above (a force-added tracked file) still win.
    if wholly_ignored {
        map.insert(".".to_string(), "ignored".to_string());
    }

    Ok(map)
}

/// Stages a specific path (file or directory) via `git add`.
#[tauri::command]
pub async fn git_add_path(project_dir: String, rel_path: String) -> Result<(), String> {
    run_off_thread(move || git_add_path_blocking(project_dir, rel_path)).await
}

fn git_add_path_blocking(project_dir: String, rel_path: String) -> Result<(), String> {
    let target = remote_target_for_dir(&project_dir);
    let out = run_git(target.as_ref(), &project_dir, &["add", "--", &rel_path])?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).to_string());
    }
    Ok(())
}

/// A single changed file with its line delta, used by the action-button change
/// tree (Add/Commit/Push). `binary` files report 0/0 — git emits "-" for them.
#[derive(serde::Serialize)]
pub struct FileChange {
    pub path: String,
    pub added: i64,
    pub deleted: i64,
    pub binary: bool,
}

/// Per-file line stats (`git diff --numstat`) for one of three scopes:
///   "unstaged" – working-tree changes + untracked files (the Add list)
///   "staged"   – index vs HEAD (the Commit list)
///   "unpushed" – local commits ahead of upstream (the Push list)
/// The frontend folds these flat paths into a navigable folder tree.
#[tauri::command]
pub async fn git_change_stats(
    project_dir: String,
    scope: String,
    pool: tauri::State<'_, crate::services::remote::RemotePoolState>,
    worktree: Option<GitWorktreeSelection>,
) -> Result<Vec<FileChange>, String> {
    let (project_dir, target) = selected_git_context(project_dir, worktree.as_ref())?;
    let dir = Path::new(&project_dir);
    if local_non_repo(target.as_ref(), &project_dir) {
        return Ok(vec![]);
    }

    let numstat_args: Option<Vec<String>> = match scope.as_str() {
        "staged" => Some(vec![
            "diff".into(),
            "--cached".into(),
            "--numstat".into(),
            "--".into(),
        ]),
        "unpushed" => unpushed_base(target.as_ref(), &project_dir).map(|base| {
            vec![
                "diff".into(),
                format!("{base}.."),
                "--numstat".into(),
                "--".into(),
            ]
        }),
        _ => Some(vec!["diff".into(), "--numstat".into(), "--".into()]),
    };

    let mut changes: Vec<FileChange> = Vec::new();
    let numstat = numstat_args.and_then(|args| {
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        run_git(target.as_ref(), &project_dir, &args).ok()
    });
    if let Some(out) = numstat {
        if out.status.success() {
            let text = String::from_utf8_lossy(&out.stdout);
            for line in text.lines() {
                let mut parts = line.splitn(3, '\t');
                let a = parts.next().unwrap_or("");
                let d = parts.next().unwrap_or("");
                let p = parts.next().unwrap_or("");
                if p.is_empty() {
                    continue;
                }
                changes.push(FileChange {
                    path: normalize_numstat_path(p),
                    added: a.parse().unwrap_or(0),
                    deleted: d.parse().unwrap_or(0),
                    binary: a == "-" || d == "-",
                });
            }
        }
    }

    // Untracked files never appear in `git diff`; list them separately and count
    // their lines as additions (the Add list shows them alongside modified files).
    if scope == "unstaged" {
        if let Ok(out) = run_git(
            target.as_ref(),
            &project_dir,
            &["ls-files", "--others", "--exclude-standard", "-z"],
        ) {
            if out.status.success() {
                for chunk in out.stdout.split(|&b| b == 0) {
                    if chunk.is_empty() {
                        continue;
                    }
                    let rel = String::from_utf8_lossy(chunk).into_owned();
                    // Untracked line counts read the file's bytes and apply the
                    // same NUL/newline logic for both project kinds:
                    //   * local  → `std::fs::read` under the project directory;
                    //   * remote → the bytes over the pooled SFTP session, with
                    //     the rel path confined under `spec.remote_path` (a path
                    //     that escapes the root is treated as unreadable).
                    // Any read/confinement error degrades to (0, false) rather
                    // than failing the whole listing.
                    let (added, binary) = match &target {
                        None => count_added_lines(&dir.join(&rel)),
                        Some(t) => count_added_lines_remote(&pool, t, &rel).await,
                    };
                    changes.push(FileChange {
                        path: rel,
                        added,
                        deleted: 0,
                        binary,
                    });
                }
            }
        }
    }

    Ok(changes)
}

/// `git --numstat` renders renames as `old => new`, optionally with a braced
/// common segment (`src/{a => b}/f.rs`). Reduce either form to the new path.
fn normalize_numstat_path(p: &str) -> String {
    let Some(arrow) = p.find(" => ") else {
        return p.to_string();
    };
    if let (Some(lb), Some(rb)) = (p.find('{'), p.find('}')) {
        if lb < arrow && arrow < rb {
            return format!("{}{}{}", &p[..lb], &p[arrow + 4..rb], &p[rb + 1..]);
        }
    }
    p[arrow + 4..].to_string()
}

/// Classify an untracked file's bytes into `(added_lines, binary)`, treating
/// NUL-containing files as binary (0 lines). A final line without a trailing
/// newline still counts. Shared by the local and remote readers below.
fn count_lines_in_bytes(bytes: &[u8]) -> (i64, bool) {
    if bytes.contains(&0) {
        return (0, true);
    }
    let newlines = bytes.iter().filter(|&&b| b == b'\n').count() as i64;
    let trailing = matches!(bytes.last(), Some(&b) if b != b'\n') as i64;
    (newlines + trailing, false)
}

/// Line count of an untracked **local** file. An unreadable path degrades to
/// `(0, false)` rather than failing the listing.
fn count_added_lines(path: &Path) -> (i64, bool) {
    match std::fs::read(path) {
        Ok(bytes) => count_lines_in_bytes(&bytes),
        Err(_) => (0, false),
    }
}

/// Line count of an untracked **remote** file, read over the project's pooled
/// SFTP session (mount-free remote). `rel` is the project-relative path from
/// `git ls-files --others`; it is confined under `spec.remote_path` so a hostile
/// path cannot escape the root. A confinement or read error degrades to
/// `(0, false)`, mirroring the local reader.
async fn count_added_lines_remote(
    pool: &crate::services::remote::RemotePoolState,
    target: &RemoteTarget,
    rel: &str,
) -> (i64, bool) {
    let Ok(path) = crate::commands::fs::remote_join_confined(&target.spec.remote_path, rel) else {
        return (0, false);
    };
    match crate::commands::fs::remote_read(pool, target, &path).await {
        Ok(bytes) => count_lines_in_bytes(&bytes),
        Err(_) => (0, false),
    }
}

/// The ref every "unpushed" view (tree markers, Push list, pill dot) measures
/// against: the configured upstream, else the current branch's namesake on a
/// remote (`origin` first). A branch pushed with an explicit refspec — or by a
/// tool that never set tracking — has no `@{u}` yet plainly has a pushed copy,
/// and measuring only `@{u}` left every one of its local commits unmarked.
/// `None` for a detached HEAD or a branch no remote has.
fn unpushed_base(target: Option<&RemoteTarget>, project_dir: &str) -> Option<String> {
    let ok = |args: &[&str]| {
        run_git(target, project_dir, args)
            .ok()
            .filter(|out| out.status.success())
            .map(|out| String::from_utf8_lossy(&out.stdout).trim().to_string())
    };
    if ok(&["rev-parse", "--verify", "-q", "@{u}"]).is_some() {
        return Some("@{u}".to_string());
    }
    let branch = ok(&["symbolic-ref", "-q", "--short", "HEAD"]).filter(|b| !b.is_empty())?;
    let refs = ok(&["for-each-ref", "--format=%(refname)", "refs/remotes/"])?;
    pick_remote_namesake(&refs, &branch)
}

/// From `for-each-ref refs/remotes/` output, the ref that is `branch` on some
/// remote — `origin`'s when several remotes carry it.
fn pick_remote_namesake(refs: &str, branch: &str) -> Option<String> {
    let suffix = format!("/{branch}");
    let mut found: Option<&str> = None;
    for r in refs.lines().map(str::trim) {
        let Some(rest) = r.strip_prefix("refs/remotes/") else {
            continue;
        };
        if !rest.ends_with(&suffix) || rest.len() == suffix.len() {
            continue;
        }
        if rest == format!("origin{suffix}") {
            return Some(r.to_string());
        }
        found.get_or_insert(r);
    }
    found.map(str::to_string)
}

/// Returns one-line summaries of commits ahead of the upstream (not yet pushed),
/// measured against [`unpushed_base`]. Empty when there is none or no repo.
#[tauri::command]
pub async fn git_unpushed_commits(
    project_dir: String,
    worktree: Option<GitWorktreeSelection>,
) -> Result<Vec<String>, String> {
    run_off_thread(move || match worktree {
        None => git_unpushed_commits_blocking(project_dir),
        Some(selection) => git_unpushed_commits_blocking_selected(project_dir, Some(selection)),
    })
    .await
}

pub(crate) fn git_unpushed_commits_blocking(project_dir: String) -> Result<Vec<String>, String> {
    git_unpushed_commits_blocking_selected(project_dir, None)
}

fn git_unpushed_commits_blocking_selected(
    project_dir: String,
    worktree: Option<GitWorktreeSelection>,
) -> Result<Vec<String>, String> {
    let (project_dir, target) = selected_git_context(project_dir, worktree.as_ref())?;
    if local_non_repo(target.as_ref(), &project_dir) {
        return Ok(vec![]);
    }
    let Some(base) = unpushed_base(target.as_ref(), &project_dir) else {
        return Ok(vec![]);
    };
    let out = run_git(
        target.as_ref(),
        &project_dir,
        &["log", &format!("{base}.."), "--oneline"],
    )?;
    if !out.status.success() {
        return Ok(vec![]);
    }
    let text = String::from_utf8_lossy(&out.stdout);
    Ok(text
        .lines()
        .filter(|l| !l.is_empty())
        .map(|l| l.to_string())
        .collect())
}

/// `-c` pairs for an ephemeral inline credential helper that answers an https
/// challenge with the effective token — **only for `origins`** (from
/// `git_hosting::token_origins`). The token is read from the child's env INSIDE
/// the snippet, so it never lands in argv or on disk. A leading empty
/// `credential.helper=` clears every helper configured so far (a system GCM, and
/// any a repo's own config names) so only ours runs.
///
/// Scoping by origin is the point: the push URL comes from `.git/config`, which a
/// fenced agent can rewrite (`pushurl`, `insteadOf`), and an unscoped helper
/// would hand the token to whatever server that names. Harmless for SSH remotes —
/// git won't call an http helper. Shared by push, publish and clone.
pub(crate) fn scoped_token_config(origins: &[String], username: &str) -> Vec<String> {
    let helper = format!(
        "!f() {{ test \"$1\" = get && echo username={username} && echo \"password=${UPPER}_GIT_TOKEN\"; }}; f" // privacy-check: ok — an env-var NAME; the token is read at runtime, never written here
    );
    let mut args = vec!["-c".to_string(), "credential.helper=".to_string()];
    for origin in origins {
        args.push("-c".to_string());
        args.push(format!("credential.{origin}.helper={helper}"));
    }
    args
}

/// The ask-once gate (`services::exec_trust`) for git verbs that run the repo's
/// hooks on this machine. A remote project's git runs on its host — that host's
/// hooks are its own business — so only local repos are gated.
pub(crate) fn require_hook_trust(target: Option<&RemoteTarget>, project_dir: &str) -> Result<(), String> {
    if target.is_some() {
        return Ok(());
    }
    crate::services::exec_trust::require(
        crate::services::exec_trust::TrustKind::GitHooks,
        Path::new(project_dir),
    )
}

#[tauri::command]
pub async fn git_push(
    project_dir: String,
    project_id: Option<String>,
    worktree: Option<GitWorktreeSelection>,
) -> Result<String, String> {
    run_off_thread(move || {
        if worktree.is_none() {
            return git_push_blocking(project_dir, project_id);
        }
        let (dir, target) = selected_git_context(project_dir, worktree.as_ref())?;
        if let Some(target) = target {
            let out = run_git_hooked(Some(&target), &dir, &PUSH_ARGS)?;
            push_outcome(&out, None, None)
        } else {
            git_push_blocking(dir, project_id)
        }
    })
    .await
}

/// The git bar's Release dialog: the suggested tag for the checked-out
/// branch's tip and whether a release could go out now
/// (`services::git_release`). Local projects only; asks the remote.
#[tauri::command]
pub async fn git_release_preview(
    project_dir: String,
    project_id: Option<String>,
    worktree: Option<GitWorktreeSelection>,
) -> Result<crate::services::git_release::Preview, String> {
    run_off_thread(move || {
        let (project_dir, target) = selected_git_context(project_dir, worktree.as_ref())?;
        if target.is_some() {
            return Err("Releases are tagged from local projects only.".to_string());
        }
        require_hook_trust(None, &project_dir)?;
        let (token, origins) = release_creds(project_id.as_deref());
        Ok(crate::services::git_release::preview(
            Path::new(&project_dir),
            token.as_deref(),
            &origins,
        ))
    })
    .await
}

/// The user's Release click: tag the checked-out branch's tip as `tag`
/// (annotated, unsigned) and push that one tag, hooks off. Refused unless the
/// tip is exactly what the remote branch holds and the tag is new there. Gated
/// like Push: with no stored token the user's own credential helpers answer,
/// and those are part of the approved hook fingerprint.
#[tauri::command]
pub async fn git_release_tag(
    project_dir: String,
    project_id: Option<String>,
    tag: String,
    worktree: Option<GitWorktreeSelection>,
) -> Result<String, String> {
    run_off_thread(move || {
        let (project_dir, target) = selected_git_context(project_dir, worktree.as_ref())?;
        if target.is_some() {
            return Err("Releases are tagged from local projects only.".to_string());
        }
        require_hook_trust(None, &project_dir)?;
        let dir = Path::new(&project_dir);
        let (token, origins) = release_creds(project_id.as_deref());
        let plan =
            crate::services::git_release::plan(dir, tag.trim(), false, token.as_deref(), &origins)
                .map_err(|f| f.message)?;
        crate::services::git_release::release(dir, &plan, &plan.tag, token.as_deref(), &origins)
            .map(|_| {
                format!(
                    "Tagged {} at {} and pushed it to {}.",
                    plan.tag,
                    &plan.head[..7.min(plan.head.len())],
                    plan.remote
                )
            })
            .map_err(|f| {
                if f.output.is_empty() {
                    f.message
                } else {
                    format!("{}\n{}", f.message, f.output)
                }
            })
    })
    .await
}

/// The project's effective token and the origins it may go to; no project
/// (a nested repo) means no token, so the user's own helpers answer.
fn release_creds(project_id: Option<&str>) -> (Option<String>, Vec<String>) {
    match project_id {
        Some(id) => crate::services::git_push_mcp::creds(id),
        None => (None, Vec::new()),
    }
}

/// The push button's `git push`. A branch with no upstream (created locally,
/// or pushed once with an explicit refspec) would fail with "has no upstream
/// branch"; `push.autoSetupRemote` pushes it to the same-named branch on the
/// push remote and records that as its upstream, like `push -u`. A git older
/// than 2.37 ignores the key and fails as before.
const PUSH_ARGS: [&str; 3] = ["-c", "push.autoSetupRemote=true", "push"];

/// `git push` in a local directory, authenticating an https remote with `token`
/// when one is set — scoped to `project_id`'s token origins (see
/// [`scoped_token_config`]). Hardened like every local git call, and gated on
/// the repo's hooks (`pre-push`) being approved. Shared by the local-project push
/// and the mirror-side push below, so both sides get identical auth.
fn push_local(
    dir: &std::path::Path,
    token: Option<&str>,
    project_id: Option<&str>,
) -> Result<std::process::Output, String> {
    crate::services::exec_trust::require(crate::services::exec_trust::TrustKind::GitHooks, dir)?;
    let mut args: Vec<String> = Vec::new();
    if token.is_some() {
        let origins = crate::commands::git_hosting::token_origins(project_id, None);
        args.extend(scoped_token_config(&origins, "x-access-token"));
    }
    args.extend(PUSH_ARGS.map(str::to_string));
    let mut cmd = hooked_git_command_in(dir, &args);
    if let Some(tok) = token {
        cmd.env(crate::app_env!("GIT_TOKEN"), tok);
        cmd.env("GIT_TERMINAL_PROMPT", "0");
    }
    cmd.output().map_err(|e| e.to_string())
}

/// The transport half of an agent-requested push (`services::git_push_mcp`):
/// one explicit `refspec` to one explicit `url`, hooks off. Unlike
/// [`push_local`] this never runs the repo's `pre-push` — the fenced,
/// tokenless preflight has already run it — so no project code runs on the
/// host while `TABTIVITY_GIT_TOKEN` is in the environment. `--no-verify` says so
/// twice: [`hardened_git_command_in`] already pins `core.hooksPath=`, which
/// also silences `reference-transaction`. The URL goes on the command line, so
/// `remote.<r>.pushurl` plays no part (a repo-scope `insteadOf` is refused by
/// the caller before this runs). `token` is offered only to `origins`. The
/// caller runs it under its own timeout.
pub(crate) fn push_transport_command(
    dir: &std::path::Path,
    url: &str,
    refspec: &str,
    token: Option<&str>,
    origins: &[String],
) -> std::process::Command {
    let mut args: Vec<String> = Vec::new();
    if token.is_some() {
        args.extend(scoped_token_config(origins, "x-access-token"));
    }
    args.extend(["push", "--no-verify", "--porcelain", "--", url, refspec].map(str::to_string));
    let mut cmd = hardened_git_command_in(dir, &args);
    if let Some(tok) = token {
        cmd.env(crate::app_env!("GIT_TOKEN"), tok);
    }
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    cmd
}

/// The repo's `pre-push` hook as git would find it for a hooked push: the dir
/// `rev-parse --git-path hooks` names (honouring `core.hooksPath`, relative to
/// the repo), if an executable `pre-push` sits there. The lookup
/// `services::exec_trust` fingerprints against. Neither query runs a hook.
pub(crate) fn resolve_pre_push_hook(dir: &std::path::Path) -> Option<std::path::PathBuf> {
    let out = hooked_git_command_in(dir, &["rev-parse", "--git-path", "hooks"]).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let rel = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let hooks = if std::path::Path::new(&rel).is_absolute() { std::path::PathBuf::from(&rel) } else { dir.join(&rel) };
    let hook = hooks.join("pre-push");
    let meta = std::fs::metadata(&hook).ok()?;
    #[cfg(unix)]
    let executable = {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o111 != 0
    };
    #[cfg(not(unix))]
    let executable = true;
    (meta.is_file() && executable).then_some(hook)
}

fn git_push_blocking(project_dir: String, project_id: Option<String>) -> Result<String, String> {
    // The local repo whose remote-tracking ref this push moves — the mirror
    // for a mirror-published remote project, none for a push run on the host.
    let mut local_repo: Option<std::path::PathBuf> = None;
    let (out, before) = if let Some(target) = remote_target_for_dir(&project_dir) {
        // A remote project published from THIS machine has its `origin` on the
        // lockstep mirror, not on the host (see `commands::git_publish`) — so the
        // push has to run there, where the remote exists and the effective token
        // is the right machine's secret.
        match crate::commands::git_publish::mirror_origin_repo(&target.project_id) {
            Some(mirror) => {
                let token = crate::commands::git_hosting::effective_git_creds(&target.project_id).1;
                let before = pushed_tip(&mirror);
                local_repo = Some(mirror.clone());
                let out = push_local(&mirror, token.as_deref(), Some(&target.project_id))?;
                (out, before)
            }
            // No mirror-side origin: the repo was published (or wired by hand) on
            // the host, so the push runs there and authenticates with the host's
            // own git credentials/SSH keys. The local effective token does not
            // apply (it would be the wrong machine's secret) and is not forwarded.
            None => (crate::services::ssh_exec::run_git_remote(&target.spec, &PUSH_ARGS.map(str::to_string))?, None),
        }
    } else {
        // Local project: effective per-project → global token (if any).
        let token = project_id
            .as_deref()
            .and_then(|id| crate::commands::git_hosting::effective_git_creds(id).1);
        let dir = std::path::PathBuf::from(&project_dir);
        let before = pushed_tip(&dir);
        local_repo = Some(dir.clone());
        (push_local(&dir, token.as_deref(), project_id.as_deref())?, before)
    };
    push_outcome(&out, local_repo.as_deref(), before)
}

/// The push's result for the git bar. `repo` is the local repo whose
/// remote-tracking ref the push moves and `before` that ref's commit ahead of
/// the push (see [`pushed_tip`]).
fn push_outcome(out: &std::process::Output, repo: Option<&std::path::Path>, before: Option<String>) -> Result<String, String> {
    let stderr = String::from_utf8_lossy(&out.stderr).to_string();
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    if !out.status.success() {
        // A pre-push hook that amends the push (this repo's version bump)
        // re-pushes HEAD itself and then aborts the original, so git reports
        // failure for a push that landed — with everything the bump commit's
        // own hooks printed (the phone-staleness advisory) as the "error".
        // The remote-tracking ref says what actually happened.
        let landed = repo.is_some_and(|dir| {
            let after = pushed_tip(dir);
            after.is_some() && after != before && after == head_sha(dir)
        });
        if !landed {
            return Err(if stderr.is_empty() { stdout } else { stderr });
        }
        if let Some(dir) = repo {
            adopt_pushed_upstream(dir);
        }
        return Ok("Pushed — the repository's pre-push hook re-pushed it itself.".to_string());
    }
    Ok(if stdout.is_empty() { stderr } else { stdout })
}

/// The commit the current branch's pushed copy points at, per the local
/// remote-tracking ref ([`unpushed_base`]); `None` when there is none.
fn pushed_tip(dir: &std::path::Path) -> Option<String> {
    let d = dir.to_string_lossy();
    let base = unpushed_base(None, &d)?;
    rev_parse(dir, &base)
}

/// Record the upstream `push.autoSetupRemote` would have: a push the hook
/// re-pushed "failed", so git never set one, and a branch without one can't
/// be released or pushed by an agent (`services::git_release`). Only when
/// the branch has none; the same-named remote-tracking ref the push moved.
fn adopt_pushed_upstream(dir: &std::path::Path) {
    let d = dir.to_string_lossy();
    if rev_parse(dir, "@{u}").is_some() {
        return;
    }
    let Some(tracking) = unpushed_base(None, &d) else { return };
    let _ = run_git(None, &d, &["branch", &format!("--set-upstream-to={tracking}")]);
}

fn head_sha(dir: &std::path::Path) -> Option<String> {
    rev_parse(dir, "HEAD")
}

fn rev_parse(dir: &std::path::Path, rev: &str) -> Option<String> {
    let out = run_git(None, &dir.to_string_lossy(), &["rev-parse", "--verify", "-q", rev]).ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
}

// ── Clone (import from GitHub/GitLab) ───────────────────────────────────────

/// Accept only the clone URL forms we actually mean to support: https/http,
/// `ssh://`, `git://`, and the scp-like `[user@]host:path`. This is a whitelist
/// on purpose — git also understands `ext::<command>` (which *runs* the command)
/// and local paths, and neither belongs behind a "paste a repo URL" field.
pub(crate) fn validate_clone_url(url: &str) -> Result<(), String> {
    let url = url.trim();
    let reject = || {
        Err(format!(
            "'{url}' is not a supported repository URL (expected https://…, ssh://… or git@host:owner/repo.git)"
        ))
    };
    if url.is_empty() {
        return Err("Repository URL is empty".to_string());
    }

    let lower = url.to_ascii_lowercase();
    if let Some(scheme_end) = lower.find("://") {
        // An explicit scheme must be one we support. `file://` is not a remote,
        // and anything else is a transport we did not mean to expose.
        return if ["https", "http", "ssh", "git"].contains(&&lower[..scheme_end]) {
            Ok(())
        } else {
            reject()
        };
    }

    // scp-like: `[user@]host:path`. The host part carries no slash (that would be
    // a local path) and no colon of its own — `transport::address` is git's
    // transport-helper form, and `ext::<command>` *runs* the command.
    let Some(colon) = url.find(':') else {
        return reject();
    };
    let (host, path) = (&url[..colon], &url[colon + 1..]);
    if host.is_empty()
        || host.contains('/')
        || host.starts_with('-')
        || path.is_empty()
        || path.starts_with(':')
    {
        return reject();
    }
    Ok(())
}

/// Turn git's own auth failure into the one sentence that tells the user what to
/// do about it. A private https repo with no token stored reads as "could not
/// read Username" / "Authentication failed", which explains nothing on its own.
fn clone_error(stderr: &str, had_token: bool, https: bool) -> String {
    let lower = stderr.to_ascii_lowercase();
    let auth_failed = lower.contains("could not read username")
        || lower.contains("authentication failed")
        || lower.contains("terminal prompts disabled")
        || lower.contains("repository not found");
    if auth_failed && https {
        let hint = if had_token {
            "The stored access token was rejected (or has no access to this repository) — check it in Settings → Git Hosting."
        } else {
            "For a private repository, add an access token in Settings → Git Hosting, or use an SSH URL."
        };
        return format!("{}\n\n{hint}", stderr.trim());
    }
    if auth_failed {
        return format!(
            "{}\n\nSSH authentication failed — make sure your key is loaded (ssh-agent) and the host is known.",
            stderr.trim()
        );
    }
    stderr.trim().to_string()
}

/// Clone `url` into `dest` and return `dest`. Used by the import dialog's
/// "Clone from GitHub/GitLab" source: the clone lands first, then the regular
/// `import_project` registers the resulting directory in place ("keep" mode).
///
/// Auth: an https URL rides the global access token from Settings → Git Hosting
/// (via the same inline credential helper as `git_push`) when one is stored; an
/// SSH URL uses the user's own keys. Every interactive prompt git could raise is
/// disabled (`GIT_TERMINAL_PROMPT=0`, ssh `BatchMode=yes`) — Tabtivity has no console
/// attached, so a prompt would be an invisible hang rather than a question.
#[tauri::command]
pub async fn git_clone(url: String, dest: String) -> Result<String, String> {
    run_off_thread(move || git_clone_blocking(url, dest)).await
}

pub(crate) fn git_clone_blocking(url: String, dest: String) -> Result<String, String> {
    let url = url.trim().to_string();
    validate_clone_url(&url)?;

    let dest_path = PathBuf::from(&dest);
    if dest_path.exists() {
        let empty = std::fs::read_dir(&dest_path)
            .map(|mut entries| entries.next().is_none())
            .unwrap_or(false);
        if !empty {
            return Err(format!(
                "Destination '{dest}' already exists and is not empty"
            ));
        }
    }
    if let Some(parent) = dest_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    let token = crate::commands::git_hosting::global_git_token();
    let https = {
        let lower = url.to_ascii_lowercase();
        lower.starts_with("https://") || lower.starts_with("http://")
    };

    let mut cmd = crate::paths::command_no_window("git");
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    cmd.env("GIT_SSH_COMMAND", "ssh -o BatchMode=yes");
    if https {
        if let Some(tok) = token.as_deref() {
            let origins = crate::commands::git_hosting::token_origins(None, None);
            cmd.args(scoped_token_config(&origins, "x-access-token"));
            cmd.env(crate::app_env!("GIT_TOKEN"), tok);
        }
    }
    // `--` so a URL can never be read as an option.
    cmd.args(["clone", "--", &url, &dest]);

    let out = cmd.output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).to_string();
        let stdout = String::from_utf8_lossy(&out.stdout).to_string();
        let raw = if stderr.trim().is_empty() {
            stdout
        } else {
            stderr
        };
        // A failed clone can still leave a partial directory behind; drop it so a
        // retry isn't blocked by its own debris.
        if dest_path.exists() {
            let _ = std::fs::remove_dir_all(&dest_path);
        }
        return Err(clone_error(&raw, token.is_some(), https));
    }
    Ok(dest)
}

/// The https form of a clone URL, for an *anonymous* readability probe. An
/// `ssh://`/scp-style URL says nothing about visibility on its own (a key opens
/// public and private repos alike), so it is rewritten to the same repo's https
/// address; `http(s)` URLs are returned as-is minus any userinfo, which would
/// otherwise make the probe authenticated. Pure.
pub(crate) fn https_probe_url(raw: &str) -> Option<String> {
    let url = raw.trim();
    if url.is_empty() {
        return None;
    }
    let (authority, path) = match url.to_ascii_lowercase().find("://") {
        Some(i) => {
            let rest = &url[i + 3..];
            let slash = rest.find('/')?;
            (&rest[..slash], &rest[slash + 1..])
        }
        None => {
            // scp-like `[user@]host:path`.
            let colon = url.find(':')?;
            (&url[..colon], &url[colon + 1..])
        }
    };
    // Drop userinfo and any port: a probe must be anonymous, and the https
    // service does not live on the ssh port.
    let host = authority.rsplit('@').next().unwrap_or("");
    let host = host.split(':').next().unwrap_or("");
    let path = path.trim_start_matches('/');
    if host.is_empty() || path.is_empty() {
        return None;
    }
    Some(format!("https://{host}/{path}"))
}

/// Whether `url`'s repository can be read **without credentials** — the one
/// honest signal for "is this repo public or private" that costs a single
/// `ls-remote` and no provider login.
///
/// Returns `"public"`, `"private"`, or `"unknown"` (offline, an unreachable or
/// non-provider host, anything that is not an auth refusal). Used by the import
/// dialog to fill the Git hosting field from the repository being cloned rather
/// than assuming private. Deliberately anonymous: the stored access token is
/// *not* offered, since a token turns a private repo into a readable one and the
/// probe would then answer "public" for every repo the user can see.
///
/// A host that hides private repos behind a 404 (GitHub does) is indistinguishable
/// from a mistyped URL — both read as `"private"`, which is also the safe default
/// for the field this fills, and the clone itself is the thing that reports a bad
/// URL.
#[tauri::command]
pub async fn git_remote_visibility(url: String) -> Result<String, String> {
    run_off_thread(move || git_remote_visibility_blocking(url)).await
}

fn git_remote_visibility_blocking(url: String) -> Result<String, String> {
    validate_clone_url(&url)?;
    let Some(probe) = https_probe_url(&url) else {
        return Ok("unknown".to_string());
    };
    let mut cmd = crate::paths::command_no_window("git");
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    // No credential helper, no stored token: the whole point is what an
    // anonymous reader sees. `lowSpeed*` bounds a stalled connection so the
    // dialog's probe cannot hang around forever.
    cmd.args([
        "-c",
        "credential.helper=",
        "-c",
        "http.lowSpeedLimit=1000",
        "-c",
        "http.lowSpeedTime=8",
        "ls-remote",
        "--heads",
        "--",
        &probe,
    ]);
    let out = match cmd.output() {
        Ok(out) => out,
        Err(_) => return Ok("unknown".to_string()),
    };
    if out.status.success() {
        return Ok("public".to_string());
    }
    let stderr = String::from_utf8_lossy(&out.stderr).to_ascii_lowercase();
    let refused = stderr.contains("could not read username")
        || stderr.contains("authentication failed")
        || stderr.contains("terminal prompts disabled")
        || stderr.contains("repository not found")
        || stderr.contains("access denied")
        || stderr.contains("403")
        || stderr.contains("404");
    Ok(if refused { "private" } else { "unknown" }.to_string())
}

// ── Git history & branches ──────────────────────────────────────────────────

#[derive(Clone, serde::Serialize)]
pub struct GitCommit {
    pub hash: String,
    pub short: String,
    pub subject: String,
    pub author: String,
    pub date: String,
    pub refs: String,
    pub is_head: bool,
    /// Full hashes of this commit's parents (2+ for merge commits), oldest-first
    /// as reported by git. Empty for the root commit.
    pub parents: Vec<String>,
}

fn git_head_hash(target: Option<&RemoteTarget>, project_dir: &str) -> Option<String> {
    run_git(target, project_dir, &["rev-parse", "HEAD"])
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
}

/// Returns commits as one-line summaries, newest first: `limit` of them (default
/// 100) starting `skip` commits back from HEAD, so the panel can page a long
/// history in instead of stopping at the first page. Returns an empty vec for a
/// non-git directory, a repo with no commits yet, or a `skip` past the root.
#[tauri::command]
pub async fn git_log(
    project_dir: String,
    limit: Option<u32>,
    skip: Option<u32>,
    worktree: Option<GitWorktreeSelection>,
) -> Result<Vec<GitCommit>, String> {
    run_off_thread(move || match worktree {
        None => git_log_blocking(project_dir, limit, skip),
        Some(selection) => git_log_blocking_selected(project_dir, limit, skip, Some(selection)),
    })
    .await
}

fn git_log_blocking(
    project_dir: String,
    limit: Option<u32>,
    skip: Option<u32>,
) -> Result<Vec<GitCommit>, String> {
    git_log_blocking_selected(project_dir, limit, skip, None)
}

fn git_log_blocking_selected(
    project_dir: String,
    limit: Option<u32>,
    skip: Option<u32>,
    worktree: Option<GitWorktreeSelection>,
) -> Result<Vec<GitCommit>, String> {
    let (project_dir, target) = selected_git_context(project_dir, worktree.as_ref())?;
    if local_non_repo(target.as_ref(), &project_dir) {
        return Ok(vec![]);
    }
    let max = limit.unwrap_or(100);
    let max_count = format!("--max-count={max}");
    let skipped = format!("--skip={}", skip.unwrap_or(0));
    let out = run_git(
        target.as_ref(),
        &project_dir,
        &["log", &max_count, &skipped, GIT_LOG_FMT],
    )?;
    if !out.status.success() {
        // Empty repository (no commits) — not an error for our purposes.
        return Ok(vec![]);
    }
    let head = git_head_hash(target.as_ref(), &project_dir);
    Ok(parse_git_log(
        &String::from_utf8_lossy(&out.stdout),
        head.as_deref(),
    ))
}

/// How far back a history search reads. Bounded so a huge repo cannot turn one
/// keystroke into an unbounded `git log`; the panel says when a search hit it.
const GIT_LOG_SEARCH_SCAN: u32 = 20_000;

/// Search the history (newest first) for commits whose hash, subject, author or
/// ref names contain `query` (case-insensitive). Reads `GIT_LOG_SEARCH_SCAN`
/// commits at most and returns up to `limit` matches.
#[tauri::command]
pub async fn git_log_search(
    project_dir: String,
    query: String,
    limit: Option<u32>,
    worktree: Option<GitWorktreeSelection>,
) -> Result<Vec<GitCommit>, String> {
    run_off_thread(move || match worktree {
        None => git_log_search_blocking(project_dir, query, limit),
        Some(selection) => {
            git_log_search_blocking_selected(project_dir, query, limit, Some(selection))
        }
    })
    .await
}

fn git_log_search_blocking(
    project_dir: String,
    query: String,
    limit: Option<u32>,
) -> Result<Vec<GitCommit>, String> {
    git_log_search_blocking_selected(project_dir, query, limit, None)
}

fn git_log_search_blocking_selected(
    project_dir: String,
    query: String,
    limit: Option<u32>,
    worktree: Option<GitWorktreeSelection>,
) -> Result<Vec<GitCommit>, String> {
    let needle = query.trim().to_lowercase();
    if needle.is_empty() {
        return Ok(vec![]);
    }
    let (project_dir, target) = selected_git_context(project_dir, worktree.as_ref())?;
    if local_non_repo(target.as_ref(), &project_dir) {
        return Ok(vec![]);
    }
    let max_count = format!("--max-count={GIT_LOG_SEARCH_SCAN}");
    let out = run_git(
        target.as_ref(),
        &project_dir,
        &["log", &max_count, GIT_LOG_FMT],
    )?;
    if !out.status.success() {
        return Ok(vec![]);
    }
    let head = git_head_hash(target.as_ref(), &project_dir);
    let all = parse_git_log(&String::from_utf8_lossy(&out.stdout), head.as_deref());
    Ok(filter_commits(all, &needle, limit.unwrap_or(200) as usize))
}

/// Keep the commits matching the lower-cased `needle`, at most `limit`.
fn filter_commits(commits: Vec<GitCommit>, needle: &str, limit: usize) -> Vec<GitCommit> {
    commits
        .into_iter()
        .filter(|c| {
            c.hash.starts_with(needle)
                || c.subject.to_lowercase().contains(needle)
                || c.author.to_lowercase().contains(needle)
                || c.refs.to_lowercase().contains(needle)
        })
        .take(limit)
        .collect()
}

/// The `--pretty` format shared by `git_log` and `git_file_log`: fields separated
/// by US (0x1f) so subjects can contain anything but a newline.
const GIT_LOG_FMT: &str = "--pretty=format:%H\u{1f}%h\u{1f}%s\u{1f}%an\u{1f}%ar\u{1f}%D\u{1f}%P";

/// Parse `git log` output emitted with `GIT_LOG_FMT` into `GitCommit`s. `head` is
/// the current HEAD sha (used only to flag `is_head`).
fn parse_git_log(text: &str, head: Option<&str>) -> Vec<GitCommit> {
    let mut commits = Vec::new();
    for line in text.lines() {
        let parts: Vec<&str> = line.split('\u{1f}').collect();
        if parts.len() < 7 {
            continue;
        }
        let hash = parts[0].to_string();
        let is_head = head == Some(hash.as_str());
        let parents = parts[6].split_whitespace().map(|p| p.to_string()).collect();
        commits.push(GitCommit {
            hash,
            short: parts[1].to_string(),
            subject: parts[2].to_string(),
            author: parts[3].to_string(),
            date: parts[4].to_string(),
            refs: parts[5].to_string(),
            is_head,
            parents,
        });
    }
    commits
}

/// The commit history for a single file (`git log --follow -- <rel_path>`), most
/// recent first. `--follow` keeps history across renames. Returns an empty vec for
/// a non-git dir, an untracked path, or a repo with no commits. Local and remote
/// (SSH) projects both work via the shared `run_git` dispatch.
#[tauri::command]
pub async fn git_file_log(
    project_dir: String,
    rel_path: String,
    limit: Option<u32>,
) -> Result<Vec<GitCommit>, String> {
    run_off_thread(move || git_file_log_blocking(project_dir, rel_path, limit)).await
}

fn git_file_log_blocking(
    project_dir: String,
    rel_path: String,
    limit: Option<u32>,
) -> Result<Vec<GitCommit>, String> {
    let target = remote_target_for_dir(&project_dir);
    if local_non_repo(target.as_ref(), &project_dir) {
        return Ok(vec![]);
    }
    let max = limit.unwrap_or(100);
    let max_count = format!("--max-count={max}");
    let out = run_git(
        target.as_ref(),
        &project_dir,
        &["log", &max_count, "--follow", GIT_LOG_FMT, "--", &rel_path],
    )?;
    if !out.status.success() {
        // Untracked path or empty repo — not an error for our purposes.
        return Ok(vec![]);
    }
    let head = git_head_hash(target.as_ref(), &project_dir);
    Ok(parse_git_log(
        &String::from_utf8_lossy(&out.stdout),
        head.as_deref(),
    ))
}

/// Returns a file's contents at a specific revision (`git show <rev>:<rel_path>`).
/// Used by the in-app compare/merge view for the "old version" pane. Errors (bad
/// rev, path absent at that rev) surface as `Err(stderr)`. Local and remote (SSH)
/// projects both work via the shared `run_git` dispatch.
#[tauri::command]
pub async fn git_file_at_rev(
    project_dir: String,
    rel_path: String,
    rev: String,
) -> Result<String, String> {
    run_off_thread(move || git_file_at_rev_blocking(project_dir, rel_path, rev)).await
}

fn git_file_at_rev_blocking(
    project_dir: String,
    rel_path: String,
    rev: String,
) -> Result<String, String> {
    let target = remote_target_for_dir(&project_dir);
    if local_non_repo(target.as_ref(), &project_dir) {
        return Ok(String::new());
    }
    // `git show <rev>:<path>` is one combined argument, so it can take no `--`
    // separator — the rev is validated instead (see `valid_rev`).
    check_rev(&rev)?;
    // `git show <rev>:<path>` wants a repo-relative, forward-slash path.
    let spec = format!("{rev}:{}", rel_path.replace('\\', "/"));
    let out = run_git(target.as_ref(), &project_dir, &["show", &spec])?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

#[derive(serde::Serialize)]
pub struct GitBranch {
    pub name: String,
    pub is_current: bool,
    pub is_remote: bool,
    /// The configured upstream (`origin/main`), "" for none / a remote branch.
    pub upstream: String,
    /// Against that upstream, as of the last fetch.
    pub ahead: usize,
    pub behind: usize,
}

/// Lists local and remote-tracking branches.
#[tauri::command]
pub async fn git_branches(
    project_dir: String,
    worktree: Option<GitWorktreeSelection>,
) -> Result<Vec<GitBranch>, String> {
    run_off_thread(move || match worktree {
        None => git_branches_blocking(project_dir),
        Some(selection) => git_branches_blocking_selected(project_dir, Some(selection)),
    })
    .await
}

pub(crate) fn git_branches_blocking(project_dir: String) -> Result<Vec<GitBranch>, String> {
    git_branches_blocking_selected(project_dir, None)
}

fn git_branches_blocking_selected(
    project_dir: String,
    worktree: Option<GitWorktreeSelection>,
) -> Result<Vec<GitBranch>, String> {
    let (project_dir, target) = selected_git_context(project_dir, worktree.as_ref())?;
    if local_non_repo(target.as_ref(), &project_dir) {
        return Ok(vec![]);
    }
    let fmt = "--format=%(if)%(HEAD)%(then)*%(else) %(end)\u{1f}%(refname:short)\u{1f}%(refname)\u{1f}%(upstream:short)\u{1f}%(upstream:track,nobracket)";
    let out = run_git(target.as_ref(), &project_dir, &["branch", "-a", fmt])?;
    let text = String::from_utf8_lossy(&out.stdout);
    let mut branches = Vec::new();
    for line in text.lines() {
        let parts: Vec<&str> = line.split('\u{1f}').collect();
        if parts.len() < 3 {
            continue;
        }
        let name = parts[1].to_string();
        // Skip the symbolic remote HEAD pointer (e.g. "origin/HEAD").
        if name.ends_with("/HEAD") {
            continue;
        }
        let upstream = parts.get(3).copied().unwrap_or("").to_string();
        let (ahead, behind) = parse_track(parts.get(4).copied().unwrap_or(""));
        branches.push(GitBranch {
            is_current: parts[0] == "*",
            is_remote: parts[2].starts_with("refs/remotes/"),
            name,
            upstream,
            ahead,
            behind,
        });
    }
    Ok(branches)
}

/// Checks out a branch name or commit hash. Surfaces git's stderr on failure
/// (e.g. when the working tree has conflicting uncommitted changes).
#[tauri::command]
pub async fn git_checkout(
    project_dir: String,
    target: String,
    worktree: Option<GitWorktreeSelection>,
) -> Result<String, String> {
    run_off_thread(move || match worktree {
        None => git_checkout_blocking(project_dir, target),
        Some(selection) => git_checkout_blocking_selected(project_dir, target, Some(selection)),
    })
    .await
}

fn git_checkout_blocking(project_dir: String, target: String) -> Result<String, String> {
    git_checkout_blocking_selected(project_dir, target, None)
}

fn git_checkout_blocking_selected(
    project_dir: String,
    target: String,
    worktree: Option<GitWorktreeSelection>,
) -> Result<String, String> {
    // `target` originates from `git_branches` output, i.e. from repo content — a
    // refname beginning with `-` would be parsed by git as an option.
    check_rev(&target)?;
    let (project_dir, rt) = selected_git_context(project_dir, worktree.as_ref())?;
    // A checkout fires `post-checkout`, and for a container-toggled project
    // `.git/hooks` is the container's writable mount — so a contained agent
    // writing one would get host execution from a click in Tabtivity's Git panel.
    // `run_git` pins hooks off (see `hardened_git_args`); checkout stays there.
    let out = run_git(rt.as_ref(), &project_dir, &["checkout", &target])?;
    let stderr = String::from_utf8_lossy(&out.stderr).to_string();
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    if !out.status.success() {
        return Err(if stderr.is_empty() { stdout } else { stderr });
    }
    Ok(if stdout.is_empty() { stderr } else { stdout })
}

/// Returns the full commit message (subject + body) for a single commit.
#[tauri::command]
pub async fn git_commit_message(
    project_dir: String,
    hash: String,
    worktree: Option<GitWorktreeSelection>,
) -> Result<String, String> {
    run_off_thread(move || match worktree {
        None => git_commit_message_blocking(project_dir, hash),
        Some(selection) => git_commit_message_blocking_selected(project_dir, hash, Some(selection)),
    })
    .await
}

fn git_commit_message_blocking(project_dir: String, hash: String) -> Result<String, String> {
    git_commit_message_blocking_selected(project_dir, hash, None)
}

fn git_commit_message_blocking_selected(
    project_dir: String,
    hash: String,
    worktree: Option<GitWorktreeSelection>,
) -> Result<String, String> {
    check_rev(&hash)?;
    let (project_dir, target) = selected_git_context(project_dir, worktree.as_ref())?;
    let out = run_git(
        target.as_ref(),
        &project_dir,
        &["log", "-1", "--pretty=format:%B", &hash],
    )?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

/// Rewords the most recent commit (HEAD) via `git commit --amend`. Only valid
/// for the latest commit; rewording older commits would require a rebase.
#[tauri::command]
pub async fn git_reword_head(
    project_dir: String,
    message: String,
    worktree: Option<GitWorktreeSelection>,
) -> Result<(), String> {
    run_off_thread(move || match worktree {
        None => git_reword_head_blocking(project_dir, message),
        Some(selection) => git_reword_head_blocking_selected(project_dir, message, Some(selection)),
    })
    .await
}

fn git_reword_head_blocking(project_dir: String, message: String) -> Result<(), String> {
    git_reword_head_blocking_selected(project_dir, message, None)
}

fn git_reword_head_blocking_selected(
    project_dir: String,
    message: String,
    worktree: Option<GitWorktreeSelection>,
) -> Result<(), String> {
    if message.trim().is_empty() {
        return Err("Commit message cannot be empty".to_string());
    }
    let (project_dir, target) = selected_git_context(project_dir, worktree.as_ref())?;
    require_hook_trust(target.as_ref(), &project_dir)?;
    let out = run_git_hooked(
        target.as_ref(),
        &project_dir,
        &["commit", "--amend", "-m", &message],
    )?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).to_string());
    }
    Ok(())
}

/// Returns the unified diff for a single file relative to `project_dir`.
///
/// Runs `git diff -- <rel_path>` (working-tree changes against the index/HEAD).
/// When that yields no output — typically because the file is untracked, so it
/// has no tracked diff — it falls back to `git diff --no-index -- /dev/null
/// <rel_path>`, which renders the whole file as added. `--no-index` exits
/// non-zero whenever there are differences, so for the fallback we treat any
/// non-empty stdout as success regardless of exit status.
#[tauri::command]
pub async fn git_diff_file(project_dir: String, rel_path: String) -> Result<String, String> {
    run_off_thread(move || git_diff_file_blocking(project_dir, rel_path)).await
}

fn git_diff_file_blocking(project_dir: String, rel_path: String) -> Result<String, String> {
    let target = remote_target_for_dir(&project_dir);
    let out = run_git(target.as_ref(), &project_dir, &["diff", "--", &rel_path])?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).to_string());
    }
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    if !stdout.is_empty() {
        return Ok(stdout);
    }

    // Tracked diff is empty (e.g. untracked file). Show the whole file as added.
    // `--no-index` exits non-zero when differences exist, which is the normal
    // case here, so treat any non-empty stdout as success.
    let fallback = run_git(
        target.as_ref(),
        &project_dir,
        &["diff", "--no-index", "--", "/dev/null", &rel_path],
    )?;
    let fb_stdout = String::from_utf8_lossy(&fallback.stdout).to_string();
    if !fb_stdout.is_empty() {
        return Ok(fb_stdout);
    }
    if !fallback.status.success() {
        return Err(String::from_utf8_lossy(&fallback.stderr).to_string());
    }
    // No tracked changes and the fallback produced nothing — return empty diff.
    Ok(stdout)
}

// ── Git blame ────────────────────────────────────────────────────────────────

/// One source line's blame attribution. Mirrored field-for-field by the
/// frontend `BlameLine` interface (snake_case, no serde renames).
#[derive(serde::Serialize)]
pub struct GitBlameLine {
    /// 1-based final line number in the current file.
    pub line_no: u32,
    /// Full commit sha. All-zeros ⇒ the line is uncommitted (working tree).
    pub hash: String,
    /// First 8 chars of `hash`.
    pub short: String,
    pub author: String,
    /// Author time as unix epoch seconds; the frontend renders the relative date.
    pub author_time: i64,
    /// Commit subject (first line of the message).
    pub summary: String,
}

#[derive(Clone, Default)]
struct BlameMeta {
    author: String,
    author_time: i64,
    summary: String,
}

/// Parses `git blame --porcelain` output into one `GitBlameLine` per source
/// line. In porcelain form each line begins with a header
/// `<40-hex-sha> <orig-lineno> <final-lineno>[ <group-size>]`, followed — only
/// the **first** time a given commit appears — by its metadata (`author`,
/// `author-time`, `summary`, …), and always ends with a `\t`-prefixed content
/// line. Later lines of an already-seen commit carry only the header + content,
/// so commit metadata is cached by sha and reused.
fn parse_blame_porcelain(text: &str) -> Vec<GitBlameLine> {
    let mut cache: HashMap<String, BlameMeta> = HashMap::new();
    let mut lines: Vec<GitBlameLine> = Vec::new();

    let mut cur_hash: Option<String> = None;
    let mut cur_line_no: u32 = 0;
    let mut building = BlameMeta::default();

    let is_header = |l: &str| -> Option<(String, u32)> {
        let mut it = l.split(' ');
        let sha = it.next()?;
        if sha.len() != 40 || !sha.bytes().all(|b| b.is_ascii_hexdigit()) {
            return None;
        }
        let _orig = it.next()?; // original line number (unused)
        let final_no: u32 = it.next()?.parse().ok()?;
        Some((sha.to_string(), final_no))
    };

    for line in text.lines() {
        if let Some((sha, final_no)) = is_header(line) {
            // Start a new line record; seed metadata from cache if this commit
            // was already described earlier in the stream.
            building = cache.get(&sha).cloned().unwrap_or_default();
            cur_hash = Some(sha);
            cur_line_no = final_no;
        } else if let Some(rest) = line.strip_prefix("author-time ") {
            building.author_time = rest.trim().parse().unwrap_or(0);
        } else if let Some(rest) = line.strip_prefix("author ") {
            building.author = rest.to_string();
        } else if let Some(rest) = line.strip_prefix("summary ") {
            building.summary = rest.to_string();
        } else if line.starts_with('\t') {
            // Content line — finalizes the current record.
            if let Some(hash) = cur_hash.take() {
                cache
                    .entry(hash.clone())
                    .or_insert_with(|| building.clone());
                let short = hash.chars().take(8).collect();
                lines.push(GitBlameLine {
                    line_no: cur_line_no,
                    short,
                    author: building.author.clone(),
                    author_time: building.author_time,
                    summary: building.summary.clone(),
                    hash,
                });
            }
        }
    }

    lines
}

/// Per-line git blame for a file, ordered by line number. Returns an empty vec
/// for a non-git dir or a path with no blame (e.g. never committed and no
/// working-tree content). Local and remote (SSH) projects both work via the
/// shared `run_git` dispatch.
#[tauri::command]
pub async fn git_blame(project_dir: String, rel_path: String) -> Result<Vec<GitBlameLine>, String> {
    run_off_thread(move || git_blame_blocking(project_dir, rel_path)).await
}

fn git_blame_blocking(project_dir: String, rel_path: String) -> Result<Vec<GitBlameLine>, String> {
    let target = remote_target_for_dir(&project_dir);
    if local_non_repo(target.as_ref(), &project_dir) {
        return Ok(vec![]);
    }
    // `--porcelain` emits commit metadata once per commit; `-w` ignores
    // whitespace-only changes so reformatting doesn't reassign blame.
    let out = run_git(
        target.as_ref(),
        &project_dir,
        &["blame", "--porcelain", "-w", "--", &rel_path],
    )?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        // An unmodified/untracked-but-blamable file blames fine; genuinely
        // un-blamable paths (never committed, no HEAD) just yield nothing.
        if stderr.is_empty() {
            return Ok(vec![]);
        }
        return Err(stderr);
    }
    Ok(parse_blame_porcelain(&String::from_utf8_lossy(&out.stdout)))
}

// ── Git worktrees (#23) ──────────────────────────────────────────────────────
//
// Three things about this surface are not obvious from the git verbs it wraps.
//
// **Where the operation runs is not where the bytes the user picked live** (I2).
// For a remote project `project_dir` is the *local mirror*, so resolving
// remoteness from it alone made every path the user typed into a local file
// tree get created on the login node — a mirror of the mirror's path inside the
// cluster `$HOME`, with nothing erroring. `WorktreeSite` makes that choice
// explicit, following `git_publish::PublishSite`, which solved the same problem.
//
// **A worktree has exactly one legitimate home** (I3). `git worktree add <path>`
// creates *and populates* `<path>`, so an unconstrained path argument is a
// "write repo-controlled content to any writable absolute path" primitive —
// including a path Tabtivity would later read back as executable intent (Group O
// #151). Every worktree therefore lands under `<root>/.tabtivity/worktrees/`, which
// is also the answer to two other findings at once: `.tabtivity` is already a walk
// boundary for both byte-sync walkers (so a worktree is never mirrored as a
// second full copy of the tree), and it sits inside the project directory the
// container bind-mounts at its identical absolute path (so the linked `.git`
// file's `gitdir:` pointer resolves inside the container instead of dangling).
// A single enumerable root per project is also what the deferred PTY-cwd
// confinement (#149) was waiting on.
//
// **`worktree add` checks out, and a checkout runs hooks** (I4). `.git/hooks`
// sits in a container-toggled project's writable rw mount, so a contained agent
// writing `.git/hooks/post-checkout` would get *host* execution the moment the
// user clicked Add. `run_git` pins `NO_HOOKS_CONFIG` on every verb that is not
// hook-trust gated (#862), the worktree verbs included (verified: `-c
// core.hooksPath=` does suppress the hook).

/// `-c core.hooksPath=` — pinned by [`hardened_git_args`] on every git call
/// except the hook-trust-gated verbs ([`run_git_hooked`],
/// [`hooked_git_command_in`]). An empty value makes git find no hook to run —
/// neither in `.git/hooks` nor relative to the cwd (verified against git
/// 2.53.0); unlike `diff.external=` it does not make git try to exec the empty
/// string.
const NO_HOOKS_CONFIG: &[&str] = &["core.hooksPath="];

#[derive(serde::Serialize)]
pub struct Worktree {
    pub path: String,
    /// Short branch name, or "" when detached/bare.
    pub branch: String,
    /// Full HEAD sha, or "" for a bare worktree.
    pub head: String,
    pub is_main: bool,
    pub is_locked: bool,
    /// git's own words for *why* it is locked ("on a removable drive"), or "".
    /// Shown rather than discarded: the reason is the whole content of a lock.
    pub lock_reason: String,
    /// The administrative entry survives but the checkout is gone (deleted
    /// out-of-band). Discarding this was why a dead worktree listed as healthy.
    pub is_prunable: bool,
    pub prunable_reason: String,
    pub is_bare: bool,
    /// This worktree **is** the directory the command ran in. git does not
    /// protect the current worktree — `remove --force` on the tree you are
    /// standing in exits 0 and deletes it (verified) — so the refusal is ours
    /// (D4). `is_main` answers a different question and cannot stand in for it.
    pub is_current: bool,
}

/// Parses `git worktree list --porcelain` output. Records are blank-line
/// separated; each starts with `worktree <abs-path>` followed by optional
/// attribute lines (`HEAD <sha>`, `branch refs/heads/<name>`, `bare`,
/// `detached`, `locked [<reason>]`, `prunable [<reason>]`). git always lists
/// the main worktree first, so the first record is flagged `is_main`.
pub(crate) fn parse_worktree_porcelain(text: &str) -> Vec<Worktree> {
    let mut out: Vec<Worktree> = Vec::new();
    let mut cur: Option<Worktree> = None;
    let mut first = true;

    fn flush(cur: &mut Option<Worktree>, out: &mut Vec<Worktree>) {
        if let Some(wt) = cur.take() {
            if !wt.path.is_empty() {
                out.push(wt);
            }
        }
    }

    for line in text.lines() {
        if line.is_empty() {
            flush(&mut cur, &mut out);
            continue;
        }
        if let Some(path) = line.strip_prefix("worktree ") {
            // Starting a new record; close any in progress.
            flush(&mut cur, &mut out);
            cur = Some(Worktree {
                path: path.to_string(),
                branch: String::new(),
                head: String::new(),
                is_main: first,
                is_locked: false,
                lock_reason: String::new(),
                is_prunable: false,
                prunable_reason: String::new(),
                is_bare: false,
                is_current: false,
            });
            first = false;
        } else if let Some(wt) = cur.as_mut() {
            if let Some(sha) = line.strip_prefix("HEAD ") {
                wt.head = sha.to_string();
            } else if let Some(refname) = line.strip_prefix("branch ") {
                wt.branch = refname
                    .strip_prefix("refs/heads/")
                    .unwrap_or(refname)
                    .to_string();
            } else if line == "bare" {
                wt.is_bare = true;
            } else if line == "detached" {
                // branch stays empty
            } else if line == "locked" || line.starts_with("locked ") {
                wt.is_locked = true;
                wt.lock_reason = line["locked".len()..].trim().to_string();
            } else if line == "prunable" || line.starts_with("prunable ") {
                wt.is_prunable = true;
                wt.prunable_reason = line["prunable".len()..].trim().to_string();
            }
            // ignore unknown lines
        }
    }
    flush(&mut cur, &mut out);
    out
}

/// Which side of a project a worktree command operates on.
///
/// The distinction only bites for a **remote** project, whose `project_dir` is
/// the local mirror while its repo of record is on the host. `git_publish`'s
/// `PublishSite` is the precedent: where the bytes are is not where the
/// operation runs.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum WorktreeSite {
    /// The remote host's tree (a remote project's default — the Git panel
    /// reflects the host, and `git_checkout` already initiates from there).
    Host,
    /// The local working copy: a local project's directory, or a remote
    /// project's lockstep mirror.
    Local,
}

impl WorktreeSite {
    fn parse(s: Option<&str>) -> Self {
        match s {
            Some("mirror") | Some("local") => WorktreeSite::Local,
            _ => WorktreeSite::Host,
        }
    }
}

/// Frontend capability check: older running binaries ignore unknown command
/// arguments, so selection must stay disabled until this API is available.
#[tauri::command]
pub fn git_worktree_selection_supported() -> bool {
    true
}

/// Explicit panel selection, always anchored to the registered project's repository.
#[derive(Clone, serde::Deserialize)]
pub struct GitWorktreeSelection {
    pub path: String,
    pub site: String,
}

/// Resolve the side first, then accept only a live checkout returned by that
/// repository's own worktree list. A host path never becomes a local invocation.
pub(crate) fn selected_git_context(
    project_dir: String,
    selection: Option<&GitWorktreeSelection>,
) -> Result<(String, Option<RemoteTarget>), String> {
    let Some(selection) = selection else {
        let target = remote_target_for_dir(&project_dir);
        return Ok((project_dir, target));
    };
    if selection.site != "host" && selection.site != "mirror" {
        return Err("Unknown worktree side".into());
    }
    let mut ctx = worktree_ctx(&project_dir, Some(&selection.site), None);
    if !selection.path.is_empty() {
        let out = run_worktree_git(&ctx, &["worktree", "list", "--porcelain"])?;
        if !out.status.success() {
            return Err(git_err(&out));
        }
        let list = parse_worktree_porcelain(&String::from_utf8_lossy(&out.stdout));
        let wt = list
            .iter()
            .find(|wt| same_dir(&ctx, &wt.path, &selection.path))
            .ok_or_else(|| {
                "The selected worktree no longer belongs to this repository".to_string()
            })?;
        if wt.is_prunable || wt.is_bare {
            return Err("The selected worktree is not a live checkout".into());
        }
        ctx.cwd = wt.path.clone();
        if let Some(target) = ctx.target.as_mut() {
            target.spec.remote_path = wt.path.clone();
        }
    }
    Ok((ctx.cwd, ctx.target))
}

/// Everything a worktree command needs once the site question is settled.
pub(crate) struct WorktreeCtx {
    /// `Some` → git runs over SSH on that host (and `remote_git_command` cds
    /// into `spec.remote_path`); `None` → git runs locally in `cwd`.
    target: Option<RemoteTarget>,
    /// The directory git runs in for a local invocation.
    cwd: String,
    /// The repo root on the side git actually runs — the containment anchor.
    /// Equal to `cwd` locally and to `spec.remote_path` on a host.
    root: String,
    /// The root's path separator: a host is always POSIX, whatever this machine is.
    posix: bool,
}

impl WorktreeCtx {
    /// The one sanctioned home for this side's worktrees (I3).
    fn worktrees_root(&self) -> String {
        self.join(&self.root, crate::brand::WORKTREES_DIR)
    }

    fn sep(&self) -> char {
        if self.posix || cfg!(not(windows)) {
            '/'
        } else {
            '\\'
        }
    }

    fn join(&self, base: &str, rel: &str) -> String {
        let base = base.trim_end_matches(['/', '\\']);
        let sep = self.sep();
        let rel = if sep == '/' {
            rel.replace('\\', "/")
        } else {
            rel.replace('/', "\\")
        };
        format!("{base}{sep}{rel}")
    }
}

/// Resolve `(project_dir, site, host_id)` into the side a worktree command runs on.
///
/// `host_id` mirrors `commands::slurm`: absent (or `"primary"`) means the
/// project's own host; anything else names one of its compute hosts.
pub(crate) fn worktree_ctx(
    project_dir: &str,
    site: Option<&str>,
    host_id: Option<&str>,
) -> WorktreeCtx {
    let primary = remote_target_for_dir(project_dir);
    let Some(primary) = primary else {
        // A local project has one side; `site` is meaningless and ignored.
        return WorktreeCtx {
            target: None,
            cwd: project_dir.to_string(),
            root: project_dir.to_string(),
            posix: false,
        };
    };
    if WorktreeSite::parse(site) == WorktreeSite::Local {
        // The remote project's local mirror — a real local git repo, and the
        // only repo whose worktrees could never be managed at all before.
        let mirror = crate::services::remote_sync::mirror_dir(&primary.project_id)
            .to_string_lossy()
            .to_string();
        return WorktreeCtx {
            target: None,
            cwd: mirror.clone(),
            root: mirror,
            posix: false,
        };
    }
    let target = match host_id {
        Some(h) if h != crate::services::remote::PRIMARY_HOST => {
            crate::services::remote::remote_target_for_host(&primary.project_id, h)
                .unwrap_or(primary)
        }
        _ => primary,
    };
    let root = target.spec.remote_path.clone();
    WorktreeCtx {
        target: Some(target),
        cwd: project_dir.to_string(),
        root,
        posix: true,
    }
}

/// Split a path into its components for both separators, so a lexical
/// containment check cannot be defeated by the other machine's slash.
fn path_components(s: &str) -> Vec<&str> {
    s.split(['/', '\\']).filter(|c| !c.is_empty()).collect()
}

fn is_absolute_on(s: &str, posix: bool) -> bool {
    if posix {
        s.starts_with('/')
    } else {
        s.starts_with('/')
            || s.starts_with('\\')
            || s.as_bytes()
                .get(1)
                .is_some_and(|&b| b == b':' && s.len() > 2)
    }
}

/// Resolve the user's worktree input to an absolute path **inside the sanctioned
/// worktrees root**, or refuse with the reason (I3).
///
/// Accepts a bare name (`feature-x`, the normal case — resolved inside the root)
/// or an absolute path already under the root (what the resolved-path preview in
/// the UI shows, so a paste of it round-trips). Everything else is refused
/// naming the root, because with exactly one legal location there is nothing
/// else a path could mean. `..` is rejected outright rather than normalized: a
/// path that has to be walked back into bounds is not one anybody typed on
/// purpose.
pub(crate) fn resolve_worktree_path(ctx: &WorktreeCtx, input: &str) -> Result<String, String> {
    let input = input.trim();
    if input.is_empty() {
        return Err("Worktree path cannot be empty".to_string());
    }
    if input.chars().any(|c| c.is_control()) {
        return Err("Worktree path contains control characters".to_string());
    }
    // `git worktree add` has no `--` boundary, so a positional that looks like an
    // option is refused rather than shielded.
    if !valid_positional_path(input) {
        return Err(format!("'{input}' is not a valid worktree path"));
    }
    let root = ctx.worktrees_root();
    let comps = path_components(input);
    if comps.iter().any(|c| *c == ".." || *c == ".") {
        return Err(format!(
            "A worktree path may not contain '.' or '..' — it must sit directly under {root}"
        ));
    }
    let abs = if is_absolute_on(input, ctx.posix) {
        input.to_string()
    } else {
        ctx.join(&root, input)
    };
    // Lexical containment, component-wise so `<root>-evil` cannot pass a prefix test.
    let root_comps = path_components(&root);
    let abs_comps = path_components(&abs);
    let contained = abs_comps.len() > root_comps.len()
        && abs_comps[..root_comps.len()] == root_comps[..]
        && is_absolute_on(&abs, ctx.posix);
    if !contained {
        return Err(format!(
            "Worktrees live under {root}. '{input}' is outside it."
        ));
    }
    Ok(abs)
}

/// Whether two paths on `ctx`'s side name the same directory. Canonicalized
/// locally (so a symlink or a `//` cannot smuggle a second name past the
/// current-worktree refusal); lexical for a host, where there is nothing to
/// canonicalize against without another round trip.
fn same_dir(ctx: &WorktreeCtx, a: &str, b: &str) -> bool {
    if ctx.target.is_none() {
        if let (Ok(a), Ok(b)) = (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
            return a == b;
        }
    }
    path_components(a) == path_components(b)
}

/// Run a worktree verb on `ctx`'s side, with hooks pinned off (I4) — as
/// `run_git` pins them for every verb it runs.
fn run_worktree_git(ctx: &WorktreeCtx, args: &[&str]) -> Result<std::process::Output, String> {
    run_git(ctx.target.as_ref(), &ctx.cwd, args)
}

fn git_err(out: &std::process::Output) -> String {
    let stderr = String::from_utf8_lossy(&out.stderr).to_string();
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    if stderr.trim().is_empty() {
        stdout
    } else {
        stderr
    }
}

/// Lists worktrees attached to the repository on the chosen side.
#[tauri::command]
pub async fn git_worktree_list(
    project_dir: String,
    site: Option<String>,
    host_id: Option<String>,
) -> Result<Vec<Worktree>, String> {
    run_off_thread(move || git_worktree_list_blocking(project_dir, site, host_id)).await
}

pub(crate) fn git_worktree_list_blocking(
    project_dir: String,
    site: Option<String>,
    host_id: Option<String>,
) -> Result<Vec<Worktree>, String> {
    let ctx = worktree_ctx(&project_dir, site.as_deref(), host_id.as_deref());
    // `.git` exists as a DIRECTORY for a main repo and as a FILE in a linked
    // worktree, so this guard tests existence, never `is_dir` (I6).
    if local_non_repo(ctx.target.as_ref(), &ctx.cwd) {
        return Ok(vec![]);
    }
    let out = run_worktree_git(&ctx, &["worktree", "list", "--porcelain"])?;
    if !out.status.success() {
        // Lenient, like git_log (e.g. empty repo).
        return Ok(vec![]);
    }
    let mut list = parse_worktree_porcelain(&String::from_utf8_lossy(&out.stdout));
    for wt in list.iter_mut() {
        wt.is_current = same_dir(&ctx, &wt.path, &ctx.root);
    }
    Ok(list)
}

/// Adds a worktree. When `new_branch` is true, `branch` is *created* at
/// `start_point` (default `HEAD`); otherwise the existing `branch` is checked
/// out there.
///
/// `path` is resolved into the project's sanctioned worktrees root — see
/// [`resolve_worktree_path`]; a bare name is the normal input.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn git_worktree_add(
    project_dir: String,
    path: String,
    branch: String,
    new_branch: bool,
    start_point: Option<String>,
    site: Option<String>,
    host_id: Option<String>,
) -> Result<String, String> {
    run_off_thread(move || {
        git_worktree_add_blocking(
            project_dir,
            path,
            branch,
            new_branch,
            start_point,
            site,
            host_id,
        )
    })
    .await
}

fn git_worktree_add_blocking(
    project_dir: String,
    path: String,
    branch: String,
    new_branch: bool,
    start_point: Option<String>,
    site: Option<String>,
    host_id: Option<String>,
) -> Result<String, String> {
    if branch.trim().is_empty() {
        return Err("Branch cannot be empty".to_string());
    }
    // Neither positional can be shielded with `--` (`git worktree add`'s synopsis
    // has no pathspec boundary), so both are validated instead.
    check_rev(&branch)?;
    let start = start_point.unwrap_or_default();
    let start = start.trim();
    if !start.is_empty() {
        check_rev(start)?;
    }
    if !new_branch && !start.is_empty() {
        return Err("A start point only applies when creating a new branch".to_string());
    }
    let ctx = worktree_ctx(&project_dir, site.as_deref(), host_id.as_deref());
    let abs = resolve_worktree_path(&ctx, &path)?;

    // The worktrees root lives inside the project tree so a container mount and
    // both byte-sync walkers already cover it — but an *imported* repo has no
    // `.tabtivity/` ignore rule, and `git add -A` then records the new checkout as a
    // bogus gitlink (mode 160000, verified). Repo-local `info/exclude` fixes that
    // without touching a tracked file. Best-effort: a failure here costs a noisy
    // `git status`, never the worktree.
    exclude_app_dir(&ctx);

    let mut args: Vec<&str> = vec!["worktree", "add"];
    if new_branch {
        args.push("-b");
        args.push(&branch);
        args.push(&abs);
        if !start.is_empty() {
            args.push(start);
        }
    } else {
        args.push(&abs);
        args.push(&branch);
    }
    let out = run_worktree_git(&ctx, &args)?;
    if !out.status.success() {
        return Err(git_err(&out));
    }
    Ok(abs)
}

/// Add `.tabtivity/` to the repo's own `info/exclude` if it is not already ignored.
/// Untracked and repo-local, so it changes nothing the user has committed.
fn exclude_app_dir(ctx: &WorktreeCtx) {
    const RULE: &str = crate::brand::PROJECT_DIR_EXCLUDE_RULE;
    match ctx.target.as_ref() {
        None => {
            let Ok(out) = run_git(None, &ctx.cwd, &["rev-parse", "--git-common-dir"]) else {
                return;
            };
            if !out.status.success() {
                return;
            }
            let git_dir = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if git_dir.is_empty() {
                return;
            }
            let git_dir = Path::new(&git_dir);
            let git_dir = if git_dir.is_absolute() {
                git_dir.to_path_buf()
            } else {
                Path::new(&ctx.cwd).join(git_dir)
            };
            let info = git_dir.join("info");
            let file = info.join("exclude");
            let existing = std::fs::read_to_string(&file).unwrap_or_default();
            if existing.lines().any(|l| l.trim() == RULE) {
                return;
            }
            let _ = std::fs::create_dir_all(&info);
            let mut next = existing;
            if !next.is_empty() && !next.ends_with('\n') {
                next.push('\n');
            }
            next.push_str(RULE);
            next.push('\n');
            let _ = std::fs::write(&file, next);
        }
        Some(t) => {
            // One round trip, nothing interpolated: `run_remote_script` supplies the
            // `cd <remote_path> &&` itself, already shell-quoted.
            let script = format!(
                "d=$(git rev-parse --git-common-dir 2>/dev/null) && \
                 mkdir -p \"$d/info\" && \
                 {{ grep -qxF '{RULE}' \"$d/info/exclude\" 2>/dev/null || \
                   printf '{RULE}\\n' >> \"$d/info/exclude\"; }}"
            );
            let _ = crate::services::ssh_exec::run_remote_script(&t.spec, &script);
        }
    }
}

/// Removes the worktree at `path`.
///
/// `force` is a **count**, not a flag: `1` removes a dirty worktree, and `2`
/// (`remove -f -f`) is the only thing that removes a *locked* one — git says so
/// itself and exits 128 for a single `--force` (verified). Passing a bool here
/// is what made a locked worktree permanently unremovable from Tabtivity (B4).
#[tauri::command]
pub async fn git_worktree_remove(
    project_dir: String,
    path: String,
    force: u8,
    site: Option<String>,
    host_id: Option<String>,
) -> Result<(), String> {
    run_off_thread(move || git_worktree_remove_blocking(project_dir, path, force, site, host_id))
        .await
}

fn git_worktree_remove_blocking(
    project_dir: String,
    path: String,
    force: u8,
    site: Option<String>,
    host_id: Option<String>,
) -> Result<(), String> {
    if !valid_positional_path(&path) {
        return Err(format!("'{path}' is not a valid worktree path"));
    }
    let ctx = worktree_ctx(&project_dir, site.as_deref(), host_id.as_deref());
    // D4: git happily deletes the tree you are standing in. Every open terminal
    // tab, the file watcher and the container bind mount are rooted there.
    if same_dir(&ctx, &path, &ctx.root) {
        return Err(
            concat!("That is this project's own checkout — removing it would delete the tree ", crate::app_name!(), " is \
             working in. Switch to another worktree first.")
                .to_string(),
        );
    }
    // Deliberately NOT containment-checked: git refuses a path it never
    // registered, so the delete side is already bounded — and a worktree created
    // before the sanctioned root existed (or from a terminal) must stay removable.
    let mut args: Vec<&str> = vec!["worktree", "remove"];
    args.extend(std::iter::repeat_n("--force", force.min(2) as usize));
    args.push(&path);
    let out = run_worktree_git(&ctx, &args)?;
    if !out.status.success() {
        return Err(git_err(&out));
    }
    Ok(())
}

/// Locks a worktree so neither `prune` nor a plain `remove` can drop it —
/// `reason` is git's own free text, shown back in the list.
#[tauri::command]
pub async fn git_worktree_lock(
    project_dir: String,
    path: String,
    reason: Option<String>,
    site: Option<String>,
    host_id: Option<String>,
) -> Result<(), String> {
    run_off_thread(move || {
        let ctx = worktree_ctx(&project_dir, site.as_deref(), host_id.as_deref());
        if !valid_positional_path(&path) {
            return Err(format!("'{path}' is not a valid worktree path"));
        }
        let reason = reason.unwrap_or_default();
        let reason = reason.trim();
        let mut args: Vec<&str> = vec!["worktree", "lock"];
        if !reason.is_empty() {
            if reason.chars().any(|c| c.is_control()) {
                return Err("A lock reason cannot contain control characters".to_string());
            }
            args.push("--reason");
            args.push(reason);
        }
        args.push(&path);
        let out = run_worktree_git(&ctx, &args)?;
        if !out.status.success() {
            return Err(git_err(&out));
        }
        Ok(())
    })
    .await
}

/// Unlocks a worktree. Without this, and without `remove -f -f`, a locked
/// worktree could only be freed from a terminal — for a feature whose point is
/// not needing one (B4).
#[tauri::command]
pub async fn git_worktree_unlock(
    project_dir: String,
    path: String,
    site: Option<String>,
    host_id: Option<String>,
) -> Result<(), String> {
    run_off_thread(move || {
        let ctx = worktree_ctx(&project_dir, site.as_deref(), host_id.as_deref());
        if !valid_positional_path(&path) {
            return Err(format!("'{path}' is not a valid worktree path"));
        }
        let out = run_worktree_git(&ctx, &["worktree", "unlock", &path])?;
        if !out.status.success() {
            return Err(git_err(&out));
        }
        Ok(())
    })
    .await
}

/// Prunes administrative entries for worktrees whose directories were removed
/// out-of-band (`git worktree prune`).
#[tauri::command]
pub async fn git_worktree_prune(
    project_dir: String,
    site: Option<String>,
    host_id: Option<String>,
) -> Result<(), String> {
    run_off_thread(move || {
        let ctx = worktree_ctx(&project_dir, site.as_deref(), host_id.as_deref());
        let out = run_worktree_git(&ctx, &["worktree", "prune"])?;
        if !out.status.success() {
            return Err(git_err(&out));
        }
        Ok(())
    })
    .await
}

/// Map an `origin` remote URL to a hosting provider by its **host only**.
/// Handles both SSH (`git@github.com:owner/repo.git`) and HTTPS
/// (`https://github.com/owner/repo.git`) forms. Read-only string work — no
/// network. Returns `None` for unrecognized/self-hosted vanity hosts so we
/// never render a wrong badge.
fn provider_from_origin_url(url: &str) -> Option<&'static str> {
    let lower = url.to_ascii_lowercase();
    if lower.contains("gitlab") {
        Some("gitlab")
    } else if lower.contains("github") {
        Some("github")
    } else {
        None
    }
}

/// A recognized `origin` for a local project: the hosting provider plus the raw
/// remote URL, so the frontend can both badge the provider and display the git
/// address in the project hover.
#[derive(serde::Serialize)]
pub struct DetectedOrigin {
    pub provider: String,
    pub url: String,
}

/// Sniff the `origin` host for each **local** git project and map it to a
/// hosting provider (`"github"`/`"gitlab"`) plus its raw URL. Read-only: runs
/// `git remote get-url origin`, makes no network calls and writes nothing.
/// Returns `{ project_id -> { provider, url } }` only for projects whose origin
/// resolves to a recognized provider. Published (`remote-*`) local projects are
/// included too, so their git address shows in the hover even though their badge
/// already rides on `git_type`. Used to decorate pill/side-panel hovers for
/// repos pushed to a host — including ones published outside Tabtivity's own
/// Publish flow (the sole writer of the `remote-*` `git_type`).
///
/// Offloaded via [`run_off_thread`]: the body forks one `git remote get-url`
/// per local project, and as a sync command that whole loop ran on the main
/// thread, stalling the window for N process spawns on every call.
#[tauri::command]
pub async fn detect_git_providers() -> Result<HashMap<String, DetectedOrigin>, String> {
    run_off_thread(detect_git_providers_blocking).await
}

fn detect_git_providers_blocking() -> Result<HashMap<String, DetectedOrigin>, String> {
    use serde_json::Value;

    let path = crate::storage::state_dir().join("projects.json");
    if !path.exists() {
        return Ok(HashMap::new());
    }
    let list: crate::schema::projects::ProjectsList =
        crate::storage::read_json(&path).map_err(|e| e.to_string())?;

    let mut out = HashMap::new();
    for entry in &list {
        // Local projects only: a remote project's `origin` lives on the host,
        // and sniffing it would be a network call.
        if entry.extra.contains_key("remote") {
            continue;
        }
        // Skip repo-less projects; `local` and `remote-*` are both eligible.
        if let Some(Value::String(gt)) = entry.extra.get("git_type") {
            if gt == "none" {
                continue;
            }
        }
        // The project's working directory. Legacy entries (created before
        // `directory` was persisted — e.g. the self-hosting checkout's own
        // entry) omit the key; fall back to `local_file`'s parent, which is
        // always `<directory>/project.json`, so they still get sniffed/badged.
        let dir: String = match entry.extra.get("directory") {
            Some(Value::String(d)) => d.clone(),
            _ => match Path::new(&entry.local_file).parent() {
                Some(p) => p.to_string_lossy().into_owned(),
                None => continue,
            },
        };
        if !Path::new(&dir).join(".git").exists() {
            continue;
        }
        let output = crate::paths::command_no_window("git")
            .args(["-C", &dir, "remote", "get-url", "origin"])
            .output();
        let Ok(output) = output else { continue };
        if !output.status.success() {
            continue;
        }
        let url = String::from_utf8_lossy(&output.stdout);
        let url = url.trim();
        if let Some(provider) = provider_from_origin_url(url) {
            out.insert(
                entry.id.clone(),
                DetectedOrigin {
                    provider: provider.to_string(),
                    url: url.to_string(),
                },
            );
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// Tests skip gracefully when `git` isn't on PATH.
    fn git_available() -> bool {
        super::git_available()
    }

    fn init_repo(dir: &std::path::Path) {
        let run = |args: &[&str]| {
            let ok = crate::paths::command_no_window("git")
                .args(args)
                .current_dir(dir)
                .output()
                .expect("git command should run")
                .status
                .success();
            assert!(ok, "git {args:?} failed");
        };
        run(&["init"]);
        run(&["config", "user.email", "test@example.com"]);
        run(&["config", "user.name", "Test User"]);
    }

    #[test]
    fn status_reports_a_tag_on_head_so_release_hides() {
        if !git_available() {
            eprintln!("git not on PATH — skipping status_reports_a_tag_on_head_so_release_hides");
            return;
        }
        let tmp = tempfile::tempdir().expect("tempdir");
        let dir = tmp.path();
        init_repo(dir);
        let run = |args: &[&str]| {
            crate::paths::command_no_window("git")
                .args(args)
                .current_dir(dir)
                .output()
                .expect("git")
        };
        let probe = || git_status_probe(dir.to_string_lossy().into_owned(), true).expect("status");
        fs::write(dir.join("f.txt"), "a\n").expect("write");
        run(&["add", "f.txt"]);
        run(&["commit", "-m", "one"]);
        run(&["tag", "-a", "v0.1.0", "-m", "v0.1.0"]);
        // No remote, no Release button: not probed.
        assert!(!probe().head_tagged);
        run(&["remote", "add", "origin", "https://git.example.org/owner/repo.git"]);
        assert!(probe().head_tagged);
        // A new commit past the tag is releasable again.
        fs::write(dir.join("f.txt"), "b\n").expect("write");
        run(&["commit", "-am", "two"]);
        assert!(!probe().head_tagged);
    }

    // ── Anonymous visibility probe ───────────────────────────────────────────

    #[test]
    fn https_probe_url_normalizes_every_clone_form() {
        // scp-like and ssh:// both name the https address of the same repo.
        assert_eq!(
            https_probe_url("git@github.com:owner/repo.git").as_deref(),
            Some("https://github.com/owner/repo.git")
        );
        assert_eq!(
            https_probe_url("ssh://git@gitlab.example.org:2222/group/sub/repo.git").as_deref(),
            Some("https://gitlab.example.org/group/sub/repo.git")
        );
        // Userinfo is dropped: the probe has to be anonymous to mean anything.
        // A reserved example host, so the privacy scan does not read the
        // `<name>@<host>` in a clone URL as somebody's address.
        assert_eq!(
            https_probe_url("https://user@git.example.org/owner/repo").as_deref(),
            Some("https://git.example.org/owner/repo")
        );
        assert_eq!(
            https_probe_url("https://github.com/owner/repo.git").as_deref(),
            Some("https://github.com/owner/repo.git")
        );
        // Nothing repo-shaped to probe.
        assert_eq!(https_probe_url(""), None);
        assert_eq!(https_probe_url("https://github.com/"), None);
        assert_eq!(https_probe_url("git@github.com:"), None);
    }

    // ── Repo config hardening (Group O #151) ─────────────────────────────────

    #[test]
    fn hardened_git_args_pins_config_ahead_of_the_subcommand() {
        let args = hardened_git_args(&["status", "--porcelain"]);
        // `-c k=v` pairs must precede the subcommand, or git parses them as its
        // arguments instead of its own options.
        assert_eq!(
            &args[..6],
            &[
                "-c",
                "core.fsmonitor=false",
                "-c",
                "protocol.ext.allow=never",
                "-c",
                "safe.bareRepository=explicit"
            ]
        );
        // Hooks off by default (#862): a read can fire `post-index-change`.
        assert_eq!(&args[6..8], &["-c", "core.hooksPath="]);
        assert_eq!(&args[8..], &["status", "--porcelain"]);
        // A subcommand that takes no diff-driver flags gets none.
        assert!(!args.iter().any(|a| a == "--no-ext-diff"));
    }

    #[test]
    fn hardened_git_args_adds_diff_driver_flags_after_the_subcommand_only() {
        for sub in DIFF_DRIVER_CMDS {
            let args = hardened_git_args(&[sub, "--", "a file.txt"]);
            let at = args
                .iter()
                .position(|a| a == sub)
                .expect("subcommand present");
            assert_eq!(args[at + 1], "--no-ext-diff");
            assert_eq!(args[at + 2], "--no-textconv");
            // Everything the caller passed keeps its order behind them — the
            // pathspec separator must not end up before the flags.
            assert_eq!(&args[at + 3..], &["--", "a file.txt"]);
        }
        // Owned args (the `Vec<String>` call sites) go through the same builder.
        let owned = vec!["log".to_string(), "--numstat".to_string()];
        let pinned = (HARDENED_CONFIG.len() + NO_HOOKS_CONFIG.len()) * 2;
        assert_eq!(
            hardened_git_args(&owned)[pinned..],
            ["log", "--no-ext-diff", "--no-textconv", "--numstat"]
        );
        // No subcommand at all is just the pinned config (no panic, no stray flag).
        let empty: [&str; 0] = [];
        assert_eq!(hardened_git_args(&empty).len(), pinned);
    }

    /// The escape this hardening exists for: a project container mounts the
    /// project dir — `.git` included — writable, so a contained agent can write
    /// `.git/config`, and git runs what it names **on the host**. Asserted in both
    /// directions, so the test fails if the hardening is removed *and* if git ever
    /// stops honouring the config the test plants (which would make it vacuous).
    #[cfg(unix)]
    #[test]
    fn a_repos_own_config_cannot_run_a_program_on_the_host() {
        if !git_available() {
            eprintln!(
                "git not on PATH — skipping a_repos_own_config_cannot_run_a_program_on_the_host"
            );
            return;
        }
        use std::os::unix::fs::PermissionsExt;

        let tmp = tempfile::tempdir().expect("tempdir");
        let dir = tmp.path();
        init_repo(dir);
        let run = |args: &[&str]| {
            crate::paths::command_no_window("git")
                .args(args)
                .current_dir(dir)
                .output()
                .expect("git")
        };
        fs::write(dir.join("f.txt"), "a\n").expect("write");
        run(&["add", "f.txt"]);
        run(&["commit", "-m", "init"]);
        fs::write(dir.join("f.txt"), "b\n").expect("modify");

        // The payload a hostile `.git/config` would name, and the mark it leaves.
        let marker = dir.join("executed");
        let payload = dir.join("payload.sh");
        fs::write(
            &payload,
            format!("#!/bin/sh\ntouch '{}'\n", marker.display()),
        )
        .expect("write");
        fs::set_permissions(&payload, fs::Permissions::from_mode(0o755)).expect("chmod");
        let p = payload.to_str().expect("utf-8 path");
        run(&["config", "core.fsmonitor", p]);
        run(&["config", "diff.external", p]);

        let project_dir = dir.to_str().expect("utf-8 path");
        // `core.fsmonitor` on a plain status — the polled read the file tree makes.
        run(&["status", "--porcelain"]);
        assert!(
            marker.exists(),
            "setup is stale: git no longer runs core.fsmonitor on status"
        );
        fs::remove_file(&marker).expect("clear marker");
        run_git(None, project_dir, &["status", "--porcelain"]).expect("hardened status");
        assert!(!marker.exists(), "core.fsmonitor executed through run_git");

        // `diff.external` on a diff — the viewer's and the file-status poll's path.
        run(&["diff"]);
        assert!(
            marker.exists(),
            "setup is stale: git no longer runs diff.external"
        );
        fs::remove_file(&marker).expect("clear marker");
        let out = run_git(None, project_dir, &["diff"]).expect("hardened diff");
        assert!(!marker.exists(), "diff.external executed through run_git");
        // …and the hardening must leave a working diff behind, not a dead one.
        assert!(
            out.status.success(),
            "hardened diff failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        assert!(String::from_utf8_lossy(&out.stdout).contains("+b"));
    }

    #[test]
    fn config_denylist_matches_the_named_shapes_and_nothing_else() {
        // The residual this closes: an attacker-chosen driver name.
        assert!(is_denylisted_config_key("filter.lfs.clean"));
        assert!(is_denylisted_config_key("filter.anything-at-all.clean"));
        assert!(is_denylisted_config_key("filter.x.smudge"));
        assert!(is_denylisted_config_key("filter.x.process"));
        assert!(is_denylisted_config_key("diff.mydriver.textconv"));
        assert!(is_denylisted_config_key("diff.mydriver.command"));
        // Case: git lowercases section/key itself; the checker must too.
        assert!(is_denylisted_config_key("Filter.Weird.Clean"));
        // The bypass this sanitizer would otherwise have: laundering a
        // denylisted key through a file it never reads.
        assert!(is_denylisted_config_key("include.path"));
        assert!(is_denylisted_config_key("includeif.gitdir:/x/.path"));

        // Adjacent, harmless keys must survive — this is a denylist, not a
        // section-wide ban.
        assert!(!is_denylisted_config_key("filter.lfs.required"));
        assert!(!is_denylisted_config_key("user.email"));
        assert!(!is_denylisted_config_key("user.name"));
        assert!(!is_denylisted_config_key("core.fsmonitor"));
        assert!(!is_denylisted_config_key("core.hookspath"));
        assert!(!is_denylisted_config_key("remote.origin.url"));
        assert!(!is_denylisted_config_key("branch.main.remote"));
        // Deliberately not on the list at all (see the doc comment).
        assert!(!is_denylisted_config_key("alias.status"));
        assert!(!is_denylisted_config_key("credential.helper"));
    }

    /// The headline residual named in Group O #151: a repo-local
    /// `filter.<driver>.clean` bound by an in-tree `.gitattributes`, run on
    /// `git add`. The driver name (`evil`, here) is exactly what a fixed `-c`
    /// override cannot cover; [`sanitize_repo_git_config`] must, because it
    /// matches by key *shape* instead of by exact name.
    #[cfg(unix)]
    #[test]
    fn sanitize_stops_a_repo_local_filter_clean_driver() {
        if !git_available() {
            eprintln!("git not on PATH — skipping sanitize_stops_a_repo_local_filter_clean_driver");
            return;
        }
        use std::os::unix::fs::PermissionsExt;

        let tmp = tempfile::tempdir().expect("tempdir");
        let dir = tmp.path();
        init_repo(dir);
        let run = |args: &[&str]| {
            crate::paths::command_no_window("git")
                .args(args)
                .current_dir(dir)
                .output()
                .expect("git")
        };

        let marker = dir.join("executed");
        let payload = dir.join("payload.sh");
        fs::write(
            &payload,
            format!("#!/bin/sh\ntouch '{}'\n", marker.display()),
        )
        .expect("write");
        fs::set_permissions(&payload, fs::Permissions::from_mode(0o755)).expect("chmod");
        let p = payload.to_str().expect("utf-8 path");

        run(&["config", "filter.evil.clean", p]);
        fs::write(dir.join(".gitattributes"), "secret.txt filter=evil\n").expect("attrs");
        fs::write(dir.join("secret.txt"), "a\n").expect("write");

        run(&["add", "secret.txt"]);
        assert!(
            marker.exists(),
            "setup is stale: git no longer runs a repo-local filter.clean"
        );
        run(&["rm", "--cached", "-f", "secret.txt"]);
        fs::remove_file(&marker).expect("clear marker");

        let project_dir = dir.to_str().expect("utf-8 path");
        run_git(None, project_dir, &["add", "secret.txt"]).expect("hardened add");
        assert!(
            !marker.exists(),
            "filter.evil.clean executed through run_git"
        );
    }

    /// The bypass a filter/diff-only denylist would otherwise have: an
    /// attacker doesn't need the payload in `.git/config` itself, only an
    /// `include.path` pointing at a second, ordinary file this sanitizer
    /// would never look at — laundering the same `filter.<driver>.clean`
    /// through a file `git config --file X --list` (no `--includes` by
    /// default) never sees. Closed by denying `include.path` itself, so the
    /// real, include-following git invocation that follows never gets there.
    #[cfg(unix)]
    #[test]
    fn sanitize_closes_the_include_laundering_bypass() {
        if !git_available() {
            eprintln!("git not on PATH — skipping sanitize_closes_the_include_laundering_bypass");
            return;
        }
        use std::os::unix::fs::PermissionsExt;

        let tmp = tempfile::tempdir().expect("tempdir");
        let dir = tmp.path();
        init_repo(dir);
        let run = |args: &[&str]| {
            crate::paths::command_no_window("git")
                .args(args)
                .current_dir(dir)
                .output()
                .expect("git")
        };

        let marker = dir.join("executed");
        let payload = dir.join("payload.sh");
        fs::write(
            &payload,
            format!("#!/bin/sh\ntouch '{}'\n", marker.display()),
        )
        .expect("write");
        fs::set_permissions(&payload, fs::Permissions::from_mode(0o755)).expect("chmod");
        let p = payload.to_str().expect("utf-8 path");

        // The laundering file: never touched directly by the sanitizer.
        fs::write(
            dir.join("laundered.gitconfig"),
            format!("[filter \"evil\"]\n\tclean = {p}\n"),
        )
        .expect("write laundering file");
        run(&["config", "--add", "include.path", "../laundered.gitconfig"]);
        fs::write(dir.join(".gitattributes"), "secret.txt filter=evil\n").expect("attrs");
        fs::write(dir.join("secret.txt"), "a\n").expect("write");

        // Setup check: the include genuinely reaches the filter today.
        run(&["add", "secret.txt"]);
        assert!(
            marker.exists(),
            "setup is stale: the include-laundered filter never ran"
        );
        // `rm --cached -f` re-runs the clean filter too (to compare working-tree
        // content against the index) — clear the marker *after* this, not before,
        // or the next check would pass on a marker this line left behind.
        run(&["rm", "--cached", "-f", "secret.txt"]);
        fs::remove_file(&marker).expect("clear marker");

        let project_dir = dir.to_str().expect("utf-8 path");
        run_git(None, project_dir, &["add", "secret.txt"]).expect("hardened add");
        assert!(
            !marker.exists(),
            "include-laundered filter.evil.clean executed through run_git"
        );

        // The strip must not be so blunt it takes the whole file with it.
        let email = crate::paths::command_no_window("git")
            .args([
                "config",
                "--file",
                &dir.join(".git/config").to_string_lossy(),
                "user.email",
            ])
            .output()
            .expect("read back user.email");
        assert_eq!(
            String::from_utf8_lossy(&email.stdout).trim(),
            "test@example.com"
        );
    }

    #[test]
    fn git_diff_file_shows_modified_hunk() {
        if !git_available() {
            eprintln!("git not on PATH — skipping git_diff_file_shows_modified_hunk");
            return;
        }
        let tmp = tempfile::tempdir().expect("tempdir");
        let dir = tmp.path();
        init_repo(dir);

        let file = dir.join("note.txt");
        fs::write(&file, "first line\nsecond line\n").expect("write");
        let add_ok = crate::paths::command_no_window("git")
            .args(["add", "note.txt"])
            .current_dir(dir)
            .output()
            .expect("add runs")
            .status
            .success();
        assert!(add_ok, "git add failed");
        let real_commit = crate::paths::command_no_window("git")
            .args(["commit", "-m", "init"])
            .current_dir(dir)
            .output()
            .expect("commit runs")
            .status
            .success();
        assert!(real_commit, "git commit failed");

        // Modify the file so a tracked diff exists.
        fs::write(&file, "first line\nCHANGED line\n").expect("rewrite");

        let diff =
            git_diff_file_blocking(dir.to_string_lossy().to_string(), "note.txt".to_string())
                .expect("git_diff_file should succeed");
        assert!(diff.contains("@@"), "expected a hunk marker, got: {diff}");
        assert!(
            diff.contains("CHANGED line"),
            "expected changed line, got: {diff}"
        );
    }

    #[test]
    fn git_diff_file_untracked_uses_no_index_fallback() {
        if !git_available() {
            eprintln!("git not on PATH — skipping git_diff_file_untracked_uses_no_index_fallback");
            return;
        }
        let tmp = tempfile::tempdir().expect("tempdir");
        let dir = tmp.path();
        init_repo(dir);

        // Brand-new untracked file: the tracked `git diff` is empty, so the
        // command must fall back to `--no-index` and show it as added.
        let file = dir.join("fresh.txt");
        fs::write(&file, "brand new content\nanother line\n").expect("write");

        let diff =
            git_diff_file_blocking(dir.to_string_lossy().to_string(), "fresh.txt".to_string())
                .expect("git_diff_file should succeed via fallback");
        assert!(!diff.is_empty(), "fallback diff should be non-empty");
        assert!(
            diff.contains("brand new content"),
            "expected file content in fallback diff, got: {diff}"
        );
    }

    #[test]
    fn parse_blame_porcelain_maps_lines_and_caches_metadata() {
        // Two commits: `aaa…` owns lines 1 & 3 (its metadata appears once, on
        // line 1, and is reused for line 3), `bbb…` owns line 2, and line 4 is
        // uncommitted (all-zeros sha, "Not Committed Yet").
        let sample = "\
aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 1 1 1
author Alice
author-mail <alice@example.com>
author-time 1000000000
author-tz +0000
summary first commit
filename note.txt
\tline one
bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb 2 2 1
author Bob
author-mail <bob@example.com>
author-time 1600000000
author-tz +0000
summary second commit
filename note.txt
\tline two
aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 3 3 1
filename note.txt
\tline three
0000000000000000000000000000000000000000 4 4 1
author Not Committed Yet
author-mail <not.committed.yet>
author-time 1700000000
author-tz +0000
summary Version of note.txt from note.txt
filename note.txt
\tline four
";
        let blame = parse_blame_porcelain(sample);
        assert_eq!(blame.len(), 4, "one entry per source line");

        assert_eq!(blame[0].line_no, 1);
        assert_eq!(blame[0].short, "aaaaaaaa");
        assert_eq!(blame[0].author, "Alice");
        assert_eq!(blame[0].author_time, 1_000_000_000);
        assert_eq!(blame[0].summary, "first commit");

        assert_eq!(blame[1].line_no, 2);
        assert_eq!(blame[1].author, "Bob");
        assert_eq!(blame[1].author_time, 1_600_000_000);

        // Line 3 reuses `aaa…`'s cached metadata even though it wasn't repeated.
        assert_eq!(blame[2].line_no, 3);
        assert_eq!(blame[2].hash, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        assert_eq!(blame[2].author, "Alice");
        assert_eq!(blame[2].summary, "first commit");

        // Line 4 is uncommitted.
        assert_eq!(blame[3].line_no, 4);
        assert_eq!(blame[3].hash, "0000000000000000000000000000000000000000");
        assert_eq!(blame[3].author, "Not Committed Yet");
    }

    #[test]
    fn git_blame_blocking_attributes_lines() {
        if !git_available() {
            eprintln!("git not on PATH — skipping git_blame_blocking_attributes_lines");
            return;
        }
        let tmp = tempfile::tempdir().expect("tempdir");
        let dir = tmp.path();
        init_repo(dir);

        let file = dir.join("note.txt");
        fs::write(&file, "first line\nsecond line\n").expect("write");
        for args in [&["add", "note.txt"][..], &["commit", "-m", "init"][..]] {
            let ok = crate::paths::command_no_window("git")
                .args(args)
                .current_dir(dir)
                .output()
                .expect("git runs")
                .status
                .success();
            assert!(ok, "git {args:?} failed");
        }

        let blame = git_blame_blocking(dir.to_string_lossy().to_string(), "note.txt".to_string())
            .expect("git_blame should succeed");
        assert_eq!(blame.len(), 2, "two committed lines");
        assert_eq!(blame[0].line_no, 1);
        assert_eq!(blame[0].author, "Test User");
        assert_ne!(blame[0].hash, "0000000000000000000000000000000000000000");
    }

    #[test]
    fn git_blame_blocking_empty_for_non_repo() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let dir = tmp.path();
        // No `git init` → local_non_repo short-circuits to an empty vec.
        let blame = git_blame_blocking(
            dir.to_string_lossy().to_string(),
            "whatever.txt".to_string(),
        )
        .expect("non-repo blame is empty, not an error");
        assert!(blame.is_empty());
    }

    #[test]
    fn ignored_child_does_not_mark_whole_folder_ignored() {
        if !git_available() {
            eprintln!(
                "git not on PATH — skipping ignored_child_does_not_mark_whole_folder_ignored"
            );
            return;
        }
        let tmp = tempfile::tempdir().expect("tempdir");
        let dir = tmp.path();
        init_repo(dir);

        // `partial/` has one ignored file and one tracked file → the folder
        // itself is NOT ignored. `whole/` is ignored in its entirety.
        fs::write(dir.join(".gitignore"), "partial/ignored.log\nwhole/\n")
            .expect("write .gitignore");
        fs::create_dir(dir.join("partial")).expect("mkdir partial");
        fs::write(dir.join("partial/ignored.log"), "log\n").expect("write log");
        fs::write(dir.join("partial/keep.txt"), "keep\n").expect("write keep");
        fs::create_dir(dir.join("whole")).expect("mkdir whole");
        fs::write(dir.join("whole/a.txt"), "a\n").expect("write a");

        let statuses = git_file_statuses_blocking(dir.to_string_lossy().to_string(), String::new())
            .expect("git_file_statuses should succeed");

        // A folder with only some ignored content stays out of the ignored bucket.
        assert_ne!(
            statuses.get("partial").map(String::as_str),
            Some("ignored"),
            "partial/ must not be marked ignored (got {:?})",
            statuses.get("partial")
        );
        // A wholly-ignored folder is still reported as ignored.
        assert_eq!(
            statuses.get("whole").map(String::as_str),
            Some("ignored"),
            "whole/ should be ignored (got {:?})",
            statuses.get("whole")
        );

        // Navigating INTO the wholly-ignored folder must still report its own
        // children as ignored, not silently come back empty (the bug this
        // test guards: plain `--ignored` collapses `whole/` to one line and
        // never descends into it).
        let inner =
            git_file_statuses_blocking(dir.to_string_lossy().to_string(), "whole".to_string())
                .expect("git_file_statuses on whole/ should succeed");
        assert_eq!(
            inner.get("a.txt").map(String::as_str),
            Some("ignored"),
            "whole/a.txt should be reported as ignored when listing whole/ (got {:?})",
            inner.get("a.txt")
        );
    }

    #[test]
    fn ignored_entries_are_reported_when_git_config_hides_untracked_files() {
        if !git_available() {
            eprintln!("git not on PATH — skipping ignored_entries_are_reported_when_git_config_hides_untracked_files");
            return;
        }
        let tmp = tempfile::tempdir().expect("tempdir");
        let dir = tmp.path();
        init_repo(dir);

        fs::write(dir.join(".gitignore"), "cache/\n").expect("write .gitignore");
        fs::create_dir(dir.join("cache")).expect("mkdir cache");
        fs::write(dir.join("cache/data.bin"), "ignored\n").expect("write ignored file");
        let configured = crate::paths::command_no_window("git")
            .args(["config", "status.showUntrackedFiles", "no"])
            .current_dir(dir)
            .output()
            .expect("git config should run")
            .status
            .success();
        assert!(configured, "git config failed");

        let statuses = git_file_statuses_blocking(dir.to_string_lossy().to_string(), String::new())
            .expect("git_file_statuses should override the user's untracked-files setting");

        assert_eq!(statuses.get("cache").map(String::as_str), Some("ignored"));
    }

    #[test]
    fn remote_namesake_prefers_origin_and_needs_the_whole_branch_name() {
        let refs = "refs/remotes/fork/develop\nrefs/remotes/origin/HEAD\nrefs/remotes/origin/develop\nrefs/remotes/origin/main\n";
        assert_eq!(pick_remote_namesake(refs, "develop").as_deref(), Some("refs/remotes/origin/develop"));
        assert_eq!(
            pick_remote_namesake("refs/remotes/fork/develop\n", "develop").as_deref(),
            Some("refs/remotes/fork/develop")
        );
        // `feature/develop` is not `develop`, and a bare `refs/remotes/develop`
        // names no remote at all.
        assert_eq!(pick_remote_namesake("refs/remotes/origin/feature-develop\n", "develop"), None);
        assert_eq!(pick_remote_namesake("refs/remotes/develop\n", "develop"), None);
        assert_eq!(
            pick_remote_namesake("refs/remotes/origin/feature/x\n", "feature/x").as_deref(),
            Some("refs/remotes/origin/feature/x")
        );
    }

    #[test]
    fn unpushed_commits_count_without_a_configured_upstream() {
        if !git_available() {
            eprintln!("git not on PATH — skipping unpushed_commits_count_without_a_configured_upstream");
            return;
        }
        let tmp = tempfile::tempdir().expect("tempdir");
        let remote = tmp.path().join("remote.git");
        let dir = tmp.path().join("work");
        fs::create_dir(&dir).expect("mkdir work");
        let git = |cwd: &Path, args: &[&str]| {
            let ok = crate::paths::command_no_window("git")
                .args(args)
                .current_dir(cwd)
                .output()
                .expect("git should run")
                .status
                .success();
            assert!(ok, "git {args:?} failed");
        };
        git(tmp.path(), &["init", "--bare", "remote.git"]);
        init_repo(&dir);
        git(&dir, &["checkout", "-b", "develop"]);
        fs::write(dir.join("pushed.txt"), "a\n").expect("write");
        git(&dir, &["add", "."]);
        git(&dir, &["commit", "-m", "pushed"]);
        git(&dir, &["remote", "add", "origin", remote.to_str().unwrap()]);
        // An explicit refspec and no `-u`: the branch is on the remote, but
        // `@{u}` stays unset.
        git(&dir, &["push", "origin", "develop:develop"]);
        fs::create_dir(dir.join("src")).expect("mkdir src");
        fs::write(dir.join("src/new.txt"), "b\n").expect("write");
        git(&dir, &["add", "."]);
        git(&dir, &["commit", "-m", "local only"]);

        let d = dir.to_string_lossy().to_string();
        let statuses = git_file_statuses_blocking(d.clone(), String::new()).expect("statuses");
        assert_eq!(statuses.get("src").map(String::as_str), Some("unpushed"));
        assert_eq!(statuses.get("pushed.txt"), None);
        assert_eq!(git_unpushed_commits_blocking(d).expect("unpushed").len(), 1);
    }

    #[test]
    fn push_sets_the_upstream_of_a_branch_that_has_none() {
        if !git_available() {
            eprintln!("git not on PATH — skipping push_sets_the_upstream_of_a_branch_that_has_none");
            return;
        }
        let tmp = tempfile::tempdir().expect("tempdir");
        let remote = tmp.path().join("remote.git");
        let dir = tmp.path().join("work");
        fs::create_dir(&dir).expect("mkdir work");
        let git = |cwd: &Path, args: &[&str]| {
            crate::paths::command_no_window("git").args(args).current_dir(cwd).output().expect("git should run")
        };
        assert!(git(tmp.path(), &["init", "--bare", "remote.git"]).status.success());
        init_repo(&dir);
        assert!(git(&dir, &["checkout", "-b", "develop"]).status.success());
        fs::write(dir.join("a.txt"), "a\n").expect("write");
        assert!(git(&dir, &["add", "."]).status.success());
        assert!(git(&dir, &["commit", "-m", "first"]).status.success());
        assert!(git(&dir, &["remote", "add", "origin", remote.to_str().unwrap()]).status.success());

        let d = dir.to_string_lossy().to_string();
        git_push_blocking(d, None).expect("push without an upstream");
        let upstream = git(&dir, &["rev-parse", "--abbrev-ref", "@{u}"]);
        assert_eq!(String::from_utf8_lossy(&upstream.stdout).trim(), "origin/develop");
        let pushed = git(&remote, &["rev-parse", "develop"]);
        let head = git(&dir, &["rev-parse", "HEAD"]);
        assert_eq!(pushed.stdout, head.stdout);
    }

    #[test]
    fn a_push_a_pre_push_hook_re_pushed_itself_is_not_an_error() {
        if !git_available() {
            eprintln!("git not on PATH — skipping a_push_a_pre_push_hook_re_pushed_itself_is_not_an_error");
            return;
        }
        let tmp = tempfile::tempdir().expect("tempdir");
        let remote = tmp.path().join("remote.git");
        let dir = tmp.path().join("work");
        fs::create_dir(&dir).expect("mkdir work");
        let git = |cwd: &Path, args: &[&str]| {
            crate::paths::command_no_window("git").args(args).current_dir(cwd).output().expect("git should run")
        };
        assert!(git(tmp.path(), &["init", "--bare", "remote.git"]).status.success());
        init_repo(&dir);
        assert!(git(&dir, &["checkout", "-b", "develop"]).status.success());
        fs::write(dir.join("a.txt"), "a\n").expect("write");
        assert!(git(&dir, &["add", "."]).status.success());
        assert!(git(&dir, &["commit", "-m", "first"]).status.success());
        assert!(git(&dir, &["remote", "add", "origin", remote.to_str().unwrap()]).status.success());
        // Pushed once without `-u`: every push so far went through the hook's
        // re-push, so git never recorded an upstream.
        assert!(git(&dir, &["push", "origin", "develop"]).status.success());
        assert!(!git(&dir, &["rev-parse", "--verify", "-q", "@{u}"]).status.success());
        fs::write(dir.join("a.txt"), "b\n").expect("write");
        assert!(git(&dir, &["commit", "-am", "second"]).status.success());

        // What the version-bump hook leaves behind: HEAD re-pushed by the
        // hook, the original push aborted with a failure and hook chatter.
        let before = pushed_tip(&dir);
        let aborted = git(&dir, &["rev-parse", "--verify", "-q", "no-such-ref"]);
        assert!(!aborted.status.success());
        assert!(push_outcome(&aborted, Some(&dir), before.clone()).is_err(), "nothing landed: a real failure");
        assert!(git(&dir, &["push", "origin", "HEAD"]).status.success());
        assert!(push_outcome(&aborted, Some(&dir), before).is_ok(), "HEAD landed on the remote");
        let upstream = git(&dir, &["rev-parse", "--abbrev-ref", "@{u}"]);
        assert_eq!(String::from_utf8_lossy(&upstream.stdout).trim(), "origin/develop", "the landed push records the upstream");
        // A failure with the tracking ref already at HEAD is not salvaged.
        let now = pushed_tip(&dir);
        assert!(push_outcome(&aborted, Some(&dir), now).is_err());
    }

    #[test]
    fn filter_commits_matches_hash_subject_author_and_refs() {
        let mk = |hash: &str, subject: &str, author: &str, refs: &str| GitCommit {
            hash: hash.into(),
            short: hash[..4].into(),
            subject: subject.into(),
            author: author.into(),
            date: String::new(),
            refs: refs.into(),
            is_head: false,
            parents: vec![],
        };
        let commits = vec![
            mk("abcd1234", "Fix the Parser", "Ann", "HEAD -> develop"),
            mk("ffff0000", "Add tests", "Bob", "tag: v1.0"),
            mk("12345678", "Docs", "Parsley", ""),
        ];
        let subjects = |needle: &str, limit| {
            filter_commits(commits.clone(), needle, limit)
                .into_iter()
                .map(|c| c.subject)
                .collect::<Vec<_>>()
        };
        assert_eq!(subjects("parser", 10), vec!["Fix the Parser"]);
        assert_eq!(subjects("pars", 10), vec!["Fix the Parser", "Docs"]);
        assert_eq!(subjects("pars", 1), vec!["Fix the Parser"]);
        assert_eq!(subjects("abcd12", 10), vec!["Fix the Parser"]);
        assert_eq!(subjects("v1.0", 10), vec!["Add tests"]);
        assert_eq!(subjects("bob", 10), vec!["Add tests"]);
        assert!(subjects("nothing", 10).is_empty());
    }

    #[test]
    fn git_log_pages_the_history_with_skip() {
        if !git_available() {
            eprintln!("git not on PATH — skipping git_log_pages_the_history_with_skip");
            return;
        }
        let tmp = tempfile::tempdir().expect("tempdir");
        let dir = tmp.path();
        init_repo(dir);
        let run = |args: &[&str]| {
            let ok = crate::paths::command_no_window("git")
                .args(args)
                .current_dir(dir)
                .output()
                .expect("git command should run")
                .status
                .success();
            assert!(ok, "git {args:?} failed");
        };
        for i in 0..5 {
            fs::write(dir.join("f.txt"), format!("{i}\n")).expect("write");
            run(&["add", "f.txt"]);
            run(&["commit", "-m", &format!("c{i}")]);
        }
        let project_dir = dir.to_string_lossy().to_string();
        let page = |limit, skip| {
            git_log_blocking(project_dir.clone(), Some(limit), Some(skip))
                .expect("git_log should read this repo")
                .into_iter()
                .map(|c| c.subject)
                .collect::<Vec<_>>()
        };

        // Newest first, and `skip` steps back from HEAD rather than re-serving
        // the first page — the whole point of paging the list in.
        assert_eq!(page(2, 0), vec!["c4", "c3"]);
        assert_eq!(page(2, 2), vec!["c2", "c1"]);
        assert_eq!(page(2, 4), vec!["c0"]);
        // Past the root commit the log is simply empty — not an error, which is
        // what tells the panel there is nothing more to page in.
        assert!(page(2, 6).is_empty());
        // No `skip` is the old call, unchanged.
        assert_eq!(
            git_log_blocking(project_dir, Some(2), None)
                .expect("git_log should read this repo")
                .len(),
            2
        );
    }

    #[test]
    fn parses_main_and_linked_with_branches() {
        let text = "worktree /home/u/proj\nHEAD abc123def456\nbranch refs/heads/main\n\nworktree /home/u/proj-feature\nHEAD 999888777666\nbranch refs/heads/feature\n";
        let wts = parse_worktree_porcelain(text);
        assert_eq!(wts.len(), 2);
        assert_eq!(wts[0].path, "/home/u/proj");
        assert_eq!(wts[0].branch, "main");
        assert_eq!(wts[0].head, "abc123def456");
        assert!(wts[0].is_main);
        assert!(!wts[0].is_bare);
        assert!(!wts[0].is_locked);
        assert_eq!(wts[1].path, "/home/u/proj-feature");
        assert_eq!(wts[1].branch, "feature");
        assert!(!wts[1].is_main);
    }

    #[test]
    fn parses_detached_head() {
        let text = "worktree /home/u/proj\nHEAD abc123\nbranch refs/heads/main\n\nworktree /home/u/detached\nHEAD deadbeef\ndetached\n";
        let wts = parse_worktree_porcelain(text);
        assert_eq!(wts.len(), 2);
        assert_eq!(wts[1].branch, "");
        assert_eq!(wts[1].head, "deadbeef");
        assert!(!wts[1].is_main);
    }

    #[test]
    fn parses_bare_main() {
        let text = "worktree /home/u/bare.git\nbare\n\nworktree /home/u/linked\nHEAD abc123\nbranch refs/heads/work\n";
        let wts = parse_worktree_porcelain(text);
        assert_eq!(wts.len(), 2);
        assert!(wts[0].is_bare);
        assert!(wts[0].is_main);
        assert_eq!(wts[0].branch, "");
        assert_eq!(wts[0].head, "");
        assert_eq!(wts[1].branch, "work");
    }

    #[test]
    fn parses_locked_with_reason() {
        let text = "worktree /home/u/proj\nHEAD abc\nbranch refs/heads/main\n\nworktree /home/u/locked\nHEAD def\nbranch refs/heads/wip\nlocked on a removable drive\n";
        let wts = parse_worktree_porcelain(text);
        assert_eq!(wts.len(), 2);
        assert!(wts[1].is_locked);
        // The reason IS the content of a lock — discarding it left the UI with
        // nothing to say about a worktree it could not remove.
        assert_eq!(wts[1].lock_reason, "on a removable drive");
        assert_eq!(wts[1].branch, "wip");
        assert!(wts[0].lock_reason.is_empty());
    }

    #[test]
    fn parses_a_bare_locked_line_with_no_reason() {
        let text = "worktree /home/u/proj\nHEAD abc\nbranch refs/heads/main\n\nworktree /home/u/l\nHEAD def\nbranch refs/heads/wip\nlocked\n";
        let wts = parse_worktree_porcelain(text);
        assert!(wts[1].is_locked);
        assert!(wts[1].lock_reason.is_empty());
    }

    #[test]
    fn parses_prunable_with_reason() {
        // The one signal git gives that a listed worktree is dead. It used to be
        // discarded, so a deleted checkout listed as healthy.
        let text = "worktree /home/u/proj\nHEAD abc\nbranch refs/heads/main\n\nworktree /home/u/gone\nHEAD def\nbranch refs/heads/old\nprunable gitdir file points to non-existent location\n";
        let wts = parse_worktree_porcelain(text);
        assert_eq!(wts.len(), 2);
        assert!(!wts[0].is_prunable);
        assert!(wts[1].is_prunable);
        assert_eq!(
            wts[1].prunable_reason,
            "gitdir file points to non-existent location"
        );
    }

    #[test]
    fn is_main_is_the_first_record_not_the_first_path_alphabetically() {
        // Every other fixture puts main both first AND alphabetically first, so a
        // regression to "sort by path" would pass them all. git lists the main
        // worktree first whatever its path sorts like (verified against 2.53.0).
        let text = "worktree /home/u/zzz-main\nHEAD abc\nbranch refs/heads/main\n\nworktree /home/u/aaa-linked\nHEAD def\nbranch refs/heads/feature\n";
        let wts = parse_worktree_porcelain(text);
        assert!(wts[0].is_main, "the first record is main");
        assert_eq!(wts[0].path, "/home/u/zzz-main");
        assert!(!wts[1].is_main);
    }

    /// A local-project context rooted at `dir`, i.e. what `worktree_ctx` builds
    /// for any project `projects.json` does not know as remote.
    fn local_ctx(dir: &str) -> WorktreeCtx {
        worktree_ctx(dir, None, None)
    }

    #[test]
    fn a_bare_name_resolves_inside_the_sanctioned_root() {
        let ctx = local_ctx("/home/u/proj");
        let p = resolve_worktree_path(&ctx, "feature-x").unwrap();
        assert_eq!(
            path_components(&p),
            path_components(concat!("/home/u/proj/.", crate::app_slug!(), "/worktrees/feature-x"))
        );
    }

    #[test]
    fn an_absolute_path_inside_the_root_round_trips() {
        let ctx = local_ctx("/home/u/proj");
        let shown = ctx.join(&ctx.worktrees_root(), "feature-x");
        let p = resolve_worktree_path(&ctx, &shown).unwrap();
        assert_eq!(path_components(&p), path_components(&shown));
    }

    #[test]
    fn paths_outside_the_sanctioned_root_are_refused() {
        let ctx = local_ctx("/home/u/proj");
        // The whole point of I3: `git worktree add <path>` populates `<path>`, so an
        // unconstrained argument writes repo content anywhere writable.
        for bad in [
            "/etc/cron.d/x",
            "/home/u/proj/wt", // inside the project, outside the root
            concat!("/home/u/proj/.", crate::app_slug!(), "/sessions/x"), // Tabtivity reads this dir as intent
            "../../elsewhere",
            concat!("/home/u/proj/.", crate::app_slug!(), "/worktrees/../../x"),
            concat!("/home/u/proj/.", crate::app_slug!(), "/worktrees-evil/x"), // prefix-match near miss
        ] {
            assert!(
                resolve_worktree_path(&ctx, bad).is_err(),
                "should refuse {bad}"
            );
        }
    }

    #[test]
    fn the_root_itself_is_not_a_worktree_path() {
        let ctx = local_ctx("/home/u/proj");
        let root = ctx.worktrees_root();
        assert!(resolve_worktree_path(&ctx, &root).is_err());
    }

    #[test]
    fn option_lookalike_and_empty_worktree_paths_are_refused() {
        let ctx = local_ctx("/home/u/proj");
        assert!(resolve_worktree_path(&ctx, "").is_err());
        assert!(resolve_worktree_path(&ctx, "   ").is_err());
        assert!(resolve_worktree_path(&ctx, "--upload-pack=x").is_err());
        assert!(resolve_worktree_path(&ctx, "a\u{7}b").is_err());
    }

    #[test]
    fn a_worktree_verb_pins_hooks_off_and_keeps_its_subcommand() {
        // I4: `worktree add` checks out, and a checkout runs `post-checkout` — which
        // for a container-toggled project lives in the container's writable mount.
        // `-c core.hooksPath=` suppresses it (verified against git 2.53.0), and
        // since #862 every non-gated verb carries it without asking.
        let args = hardened_git_args(&["worktree", "add", "/p/wt", "feat"]);
        assert_eq!(
            args,
            vec![
                "-c",
                "core.fsmonitor=false",
                "-c",
                "protocol.ext.allow=never",
                "-c",
                "safe.bareRepository=explicit",
                "-c",
                "core.hooksPath=",
                "worktree",
                "add",
                "/p/wt",
                "feat",
            ]
        );
        // The caller's own `-c` pair must not be mistaken for the subcommand: a
        // scoped config on a diff-driver command would otherwise silently drop
        // `--no-ext-diff`/`--no-textconv`.
        let diff = hardened_git_args(&["-c", "user.name=T", "diff", "HEAD"]);
        assert!(diff.contains(&"--no-ext-diff".to_string()));
        assert_eq!(
            diff[diff.len() - 4..],
            ["diff", "--no-ext-diff", "--no-textconv", "HEAD"]
        );
    }

    #[test]
    fn the_remote_worktree_command_is_quoted_argument_by_argument() {
        // Nothing asserts the `cd '<path>' && git 'worktree' …` shape anywhere, so an
        // argv-order regression on the remote path was caught only by the LOCAL
        // roundtrip — which cannot run it.
        use crate::services::ssh_exec::remote_git_command;
        let args = hardened_git_args(&["worktree", "add", concat!("/s/p/.", crate::app_slug!(), "/worktrees/a b"), "feat"]);
        let cmd = remote_git_command("/scratch/proj", &args);
        assert_eq!(
            cmd,
            concat!("cd '/scratch/proj' && git '-c' 'core.fsmonitor=false' '-c' 'protocol.ext.allow=never' \
             '-c' 'safe.bareRepository=explicit' '-c' 'core.hooksPath=' 'worktree' 'add' \
             '/s/p/.", crate::app_slug!(), "/worktrees/a b' 'feat'")
        );
    }

    #[test]
    fn a_host_side_root_is_posix_whatever_this_machine_is() {
        // A ctx built for a host must never join with a backslash: the path is
        // interpolated into a POSIX shell on the other end.
        let ctx = WorktreeCtx {
            target: None,
            cwd: "/scratch/proj".into(),
            root: "/scratch/proj".into(),
            posix: true,
        };
        assert_eq!(ctx.worktrees_root(), concat!("/scratch/proj/.", crate::app_slug!(), "/worktrees"));
        assert_eq!(
            resolve_worktree_path(&ctx, "feat").unwrap(),
            concat!("/scratch/proj/.", crate::app_slug!(), "/worktrees/feat")
        );
        assert!(resolve_worktree_path(&ctx, "/scratch/other/feat").is_err());
    }

    #[test]
    fn skips_empty_path_records() {
        // Leading/trailing blank lines must not produce phantom worktrees.
        let text = "\n\nworktree /home/u/proj\nHEAD abc\nbranch refs/heads/main\n\n\n";
        let wts = parse_worktree_porcelain(text);
        assert_eq!(wts.len(), 1);
        assert_eq!(wts[0].path, "/home/u/proj");
        assert!(wts[0].is_main);
    }

    #[test]
    fn add_list_remove_roundtrip() {
        if !git_available() {
            eprintln!("skipping: git binary not available");
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("repo");
        std::fs::create_dir(&root).unwrap();
        let root_str = root.to_string_lossy().to_string();

        let run = |args: &[&str]| {
            crate::paths::command_no_window("git")
                .args(args)
                .current_dir(&root)
                .output()
                .expect("git run")
        };
        assert!(run(&["init"]).status.success());
        run(&["config", "user.email", "test@example.com"]);
        run(&["config", "user.name", "Test"]);
        // Ensure a known starting branch name regardless of git defaults.
        run(&["checkout", "-b", "main"]);
        std::fs::write(root.join("file.txt"), "hello").unwrap();
        run(&["add", "-A"]);
        assert!(run(&["commit", "-m", "init"]).status.success());

        // Initially a single (main) worktree, which is also the one we ran in.
        let listed = git_worktree_list_blocking(root_str.clone(), None, None).unwrap();
        assert_eq!(listed.len(), 1);
        assert!(listed[0].is_main);
        assert!(listed[0].is_current);

        // Add a new worktree on a new branch. The path is a bare NAME now — the
        // backend decides where a worktree lives (I3).
        let wt_path = git_worktree_add_blocking(
            root_str.clone(),
            "feature".to_string(),
            "feature".to_string(),
            true,
            None,
            None,
            None,
        )
        .unwrap();
        assert!(wt_path.ends_with("feature"));
        assert!(Path::new(&wt_path).join(".git").exists());

        let listed = git_worktree_list_blocking(root_str.clone(), None, None).unwrap();
        assert_eq!(listed.len(), 2);
        assert_eq!(listed.iter().filter(|w| w.is_main).count(), 1);
        assert_eq!(listed.iter().filter(|w| w.is_current).count(), 1);
        assert!(listed.iter().any(|w| w.branch == "feature"));

        let selection = GitWorktreeSelection { path: wt_path.clone(), site: "host".into() };
        let branches = git_branches_blocking_selected(root_str.clone(), Some(selection.clone())).unwrap();
        assert!(branches.iter().any(|b| b.name == "feature" && b.is_current));
        assert!(git_branches_blocking(root_str.clone()).unwrap().iter().any(|b| b.name == "main" && b.is_current));
        std::fs::write(Path::new(&wt_path).join("selected.txt"), "selected\n").unwrap();
        git_add_all_blocking_selected(root_str.clone(), Some(selection.clone())).unwrap();
        assert_eq!(git_status_blocking_selected(root_str.clone(), Some(selection.clone())).unwrap().staged, 1);
        assert_eq!(git_status_blocking(root_str.clone()).unwrap().staged, 0);
        let invalid = GitWorktreeSelection { path: tmp.path().to_string_lossy().into_owned(), site: "host".into() };
        assert!(selected_git_context(root_str.clone(), Some(&invalid)).is_err());
        run_git(None, &wt_path, &["reset"]).unwrap();
        std::fs::remove_file(Path::new(&wt_path).join("selected.txt")).unwrap();

        // `.tabtivity/` is excluded repo-locally, so the new checkout is not staged as
        // a bogus gitlink by the commit UI's `git add -A` (verified: without this,
        // `git ls-files --stage` shows mode 160000 for it).
        run(&["add", "-A"]);
        let staged = run(&["ls-files", "--stage"]);
        let staged = String::from_utf8_lossy(&staged.stdout).to_string();
        assert!(
            !staged.contains("160000"),
            "embedded gitlink staged: {staged}"
        );
        run(&["reset"]);

        // Removing the worktree we are standing in is refused (D4) — git itself
        // does not refuse it, and it would delete the tree Tabtivity works in.
        let err = git_worktree_remove_blocking(root_str.clone(), root_str.clone(), 2, None, None)
            .unwrap_err();
        assert!(err.contains("own checkout"), "unexpected: {err}");

        // Remove it and confirm we are back to one.
        git_worktree_remove_blocking(root_str.clone(), wt_path, 1, None, None).unwrap();
        let listed = git_worktree_list_blocking(root_str, None, None).unwrap();
        assert_eq!(listed.len(), 1);
    }

    #[test]
    fn a_locked_worktree_needs_two_forces_and_can_be_unlocked() {
        // git: "use 'remove -f -f' to override or unlock first" — exit 128 for a
        // single --force. Neither escape existed in Tabtivity before (B4).
        if !git_available() {
            eprintln!("skipping: git binary not available");
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("repo");
        std::fs::create_dir(&root).unwrap();
        let root_str = root.to_string_lossy().to_string();
        let run = |args: &[&str]| {
            crate::paths::command_no_window("git")
                .args(args)
                .current_dir(&root)
                .output()
                .expect("git run")
        };
        assert!(run(&["init"]).status.success());
        run(&["config", "user.email", "t@e.c"]);
        run(&["config", "user.name", "T"]);
        run(&["checkout", "-b", "main"]);
        std::fs::write(root.join("f.txt"), "hi").unwrap();
        run(&["add", "-A"]);
        assert!(run(&["commit", "-m", "init"]).status.success());

        let wt = git_worktree_add_blocking(
            root_str.clone(),
            "wip".into(),
            "wip".into(),
            true,
            Some("main".into()),
            None,
            None,
        )
        .unwrap();

        let ctx = worktree_ctx(&root_str, None, None);
        run_worktree_git(
            &ctx,
            &["worktree", "lock", "--reason", "on a removable drive", &wt],
        )
        .unwrap();

        let listed = git_worktree_list_blocking(root_str.clone(), None, None).unwrap();
        let locked = listed.iter().find(|w| !w.is_main).unwrap();
        assert!(locked.is_locked);
        assert_eq!(locked.lock_reason, "on a removable drive");

        // One --force is not enough.
        assert!(git_worktree_remove_blocking(root_str.clone(), wt.clone(), 1, None, None).is_err());
        // Two is.
        git_worktree_remove_blocking(root_str.clone(), wt, 2, None, None).unwrap();
        assert_eq!(
            git_worktree_list_blocking(root_str, None, None)
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn a_new_branch_is_created_at_its_start_point() {
        // B1: the toggle could never succeed, because the branch name came from a
        // list of EXISTING branches — `git worktree add -b <existing>` always
        // answers "a branch named 'X' already exists".
        if !git_available() {
            eprintln!("skipping: git binary not available");
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("repo");
        std::fs::create_dir(&root).unwrap();
        let root_str = root.to_string_lossy().to_string();
        let run = |args: &[&str]| {
            crate::paths::command_no_window("git")
                .args(args)
                .current_dir(&root)
                .output()
                .expect("git run")
        };
        assert!(run(&["init"]).status.success());
        run(&["config", "user.email", "t@e.c"]);
        run(&["config", "user.name", "T"]);
        run(&["checkout", "-b", "main"]);
        std::fs::write(root.join("f.txt"), "one").unwrap();
        run(&["add", "-A"]);
        run(&["commit", "-m", "one"]);
        let first = String::from_utf8_lossy(&run(&["rev-parse", "HEAD"]).stdout)
            .trim()
            .to_string();
        std::fs::write(root.join("f.txt"), "two").unwrap();
        run(&["add", "-A"]);
        run(&["commit", "-m", "two"]);

        let wt = git_worktree_add_blocking(
            root_str.clone(),
            "from-first".into(),
            "from-first".into(),
            true,
            Some(first.clone()),
            None,
            None,
        )
        .unwrap();
        let head = crate::paths::command_no_window("git")
            .args(["rev-parse", "HEAD"])
            .current_dir(&wt)
            .output()
            .unwrap();
        assert_eq!(String::from_utf8_lossy(&head.stdout).trim(), first);

        // A start point without `newBranch` is a contradiction, not a silent no-op.
        assert!(git_worktree_add_blocking(
            root_str,
            "x".into(),
            "main".into(),
            false,
            Some(first),
            None,
            None,
        )
        .is_err());
    }

    #[test]
    fn listing_from_inside_a_linked_worktree_still_finds_main_and_current() {
        // Every existing fixture operates from the MAIN worktree, so `is_main`
        // and `is_current` were both unguarded for the one case where they differ.
        if !git_available() {
            eprintln!("skipping: git binary not available");
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("repo");
        std::fs::create_dir(&root).unwrap();
        let root_str = root.to_string_lossy().to_string();
        let run = |args: &[&str]| {
            crate::paths::command_no_window("git")
                .args(args)
                .current_dir(&root)
                .output()
                .expect("git run")
        };
        assert!(run(&["init"]).status.success());
        run(&["config", "user.email", "t@e.c"]);
        run(&["config", "user.name", "T"]);
        run(&["checkout", "-b", "main"]);
        std::fs::write(root.join("f.txt"), "hi").unwrap();
        run(&["add", "-A"]);
        run(&["commit", "-m", "init"]);
        let wt = git_worktree_add_blocking(
            root_str.clone(),
            "feat".into(),
            "feat".into(),
            true,
            None,
            None,
            None,
        )
        .unwrap();

        // A linked worktree's `.git` is a FILE — `local_non_repo` must test
        // existence, never `is_dir` (I6), or this returns an empty list.
        let listed = git_worktree_list_blocking(wt.clone(), None, None).unwrap();
        assert_eq!(listed.len(), 2, "listing from a linked worktree");
        assert!(listed[0].is_main, "main is still first");
        assert!(!listed[0].is_current);
        let cur = listed.iter().find(|w| w.is_current).expect("a current row");
        assert_eq!(cur.branch, "feat");

        // …and removing the one we are standing in is refused from here too.
        assert!(git_worktree_remove_blocking(wt.clone(), wt, 2, None, None).is_err());
    }

    #[test]
    fn provider_from_origin_url_recognizes_hosts() {
        // SSH form.
        assert_eq!(
            provider_from_origin_url("git@github.com:owner/repo.git"),
            Some("github")
        );
        assert_eq!(
            provider_from_origin_url("git@gitlab.com:owner/repo.git"),
            Some("gitlab")
        );
        // HTTPS form.
        assert_eq!(
            provider_from_origin_url("https://github.com/owner/repo.git"),
            Some("github")
        );
        assert_eq!(
            provider_from_origin_url("https://gitlab.example.com/owner/repo.git"),
            Some("gitlab")
        );
        // Enterprise/vanity host containing the provider name still matches.
        assert_eq!(
            provider_from_origin_url("git@github.corp.internal:owner/repo.git"),
            Some("github")
        );
        // Unrecognized / self-hosted vanity host → no badge.
        assert_eq!(
            provider_from_origin_url("git@git.mycorp.com:owner/repo.git"),
            None
        );
    }

    // ── validate_clone_url ─────────────────────────────────────────────────

    #[test]
    fn validate_clone_url_accepts_supported_forms() {
        for url in &[
            "https://github.com/owner/repo.git",
            "https://gitlab.com/group/sub/repo",
            "http://git.internal/owner/repo.git",
            "ssh://git@github.com:22/owner/repo.git",
            "git://git.internal/repo.git",
            "git@github.com:owner/repo.git",
            "gitlab.com:group/repo.git",
        ] {
            assert!(validate_clone_url(url).is_ok(), "should accept: {url}");
        }
        // Surrounding whitespace (a pasted URL) is tolerated.
        assert!(validate_clone_url("  https://github.com/o/r.git  ").is_ok());
    }

    #[test]
    fn validate_clone_url_rejects_unsupported_forms() {
        for url in &[
            "",
            "   ",
            // `ext::` runs a command — never behind a URL field.
            "ext::sh -c 'touch /tmp/pwned'",
            "file:///etc",
            "/etc/passwd",
            "../repo",
            "just-a-name",
            // Option injection, with and without the scp-like colon.
            "--upload-pack=touch /tmp/pwned",
            "--upload-pack=x:y",
        ] {
            assert!(validate_clone_url(url).is_err(), "should reject: {url}");
        }
    }

    #[test]
    fn clone_error_explains_missing_token_for_https() {
        let msg = clone_error(
            "fatal: could not read Username for 'https://github.com'",
            false,
            true,
        );
        assert!(msg.contains("Settings → Git Hosting"), "{msg}");

        // A token IS stored but was rejected → point at the token, not at adding one.
        let msg = clone_error("remote: Repository not found.", true, true);
        assert!(msg.contains("was rejected"), "{msg}");

        // SSH auth failure gets the key/agent hint instead.
        let msg = clone_error(
            "git@github.com: Permission denied (publickey).\nfatal: Authentication failed",
            false,
            false,
        );
        assert!(msg.contains("ssh-agent"), "{msg}");

        // A non-auth failure is passed through unchanged (no misleading hint).
        let msg = clone_error("fatal: destination path exists", false, true);
        assert_eq!(msg, "fatal: destination path exists");
    }

    // ── Revision / positional-path validation (S-9) ───────────────────────────

    #[test]
    fn valid_rev_rejects_option_lookalike_refnames() {
        // The primitive: a format-legal refname that git would parse as an option.
        assert!(!valid_rev("--output=/home/u/.bashrc"));
        assert!(!valid_rev("-evil"));
        assert!(!valid_rev(""));
        // Whitespace and control characters cannot occur in a legal refname, and a
        // shell-quoted-looking rev is never one either.
        assert!(!valid_rev("main; rm -rf /"));
        assert!(!valid_rev("ma\nin"));
        assert!(!valid_rev("refs/heads/a b"));
    }

    #[test]
    fn valid_rev_accepts_every_ordinary_revision_spelling() {
        for rev in [
            "HEAD",
            "HEAD~3",
            "HEAD^{tree}",
            "main",
            "origin/main",
            "refs/heads/feature/x",
            "@{u}..",
            "0123456789abcdef0123456789abcdef01234567",
            "v1.2.3",
        ] {
            assert!(valid_rev(rev), "{rev} must be accepted");
            assert!(check_rev(rev).is_ok());
        }
        assert!(check_rev("-evil").is_err());
    }

    #[test]
    fn positional_paths_reject_only_the_option_lookalike() {
        assert!(valid_positional_path("/home/u/wt/feature"));
        assert!(valid_positional_path("../sibling-worktree"));
        assert!(!valid_positional_path("--force"));
        assert!(!valid_positional_path("-x"));
        assert!(!valid_positional_path("   "));
    }

    /// The background/automatic git path (lockstep, the scaffold commit) runs in
    /// trees a fenced agent can write: neither a planted `core.fsmonitor` nor a
    /// planted hook may run through it. Both directions, as above.
    #[cfg(unix)]
    #[test]
    fn hookless_git_runs_neither_fsmonitor_nor_hooks() {
        if !git_available() {
            eprintln!("git not on PATH — skipping hookless_git_runs_neither_fsmonitor_nor_hooks");
            return;
        }
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().expect("tempdir");
        let dir = tmp.path();
        init_repo(dir);
        let marker = dir.join("executed");
        let payload = dir.join("payload.sh");
        fs::write(&payload, format!("#!/bin/sh\ntouch '{}'\n", marker.display())).expect("write");
        fs::set_permissions(&payload, fs::Permissions::from_mode(0o755)).expect("chmod");
        let hook = dir.join(".git/hooks/pre-commit");
        fs::copy(&payload, &hook).expect("hook");
        fs::set_permissions(&hook, fs::Permissions::from_mode(0o755)).expect("chmod");
        let plain = |args: &[&str]| {
            crate::paths::command_no_window("git").args(args).current_dir(dir).output().expect("git")
        };
        plain(&["config", "core.fsmonitor", payload.to_str().unwrap()]);
        fs::write(dir.join("f.txt"), "a\n").expect("write");

        plain(&["status", "--porcelain"]);
        assert!(marker.exists(), "setup is stale: git no longer runs core.fsmonitor");
        fs::remove_file(&marker).expect("clear");
        let out = hookless_git_command_in(dir, &["status", "--porcelain"]).output().expect("git");
        assert!(out.status.success());
        assert!(!marker.exists(), "core.fsmonitor ran through hookless_git_command_in");

        hookless_git_command_in(dir, &["add", "f.txt"]).output().expect("add");
        let out = hookless_git_command_in(
            dir,
            &["-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-m", "x"],
        )
        .output()
        .expect("commit");
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        assert!(!marker.exists(), "pre-commit hook ran through hookless_git_command_in");
    }

    /// #862: the fence binds `.git/config` and `.git/hooks` read-only, but an
    /// agent can still *create* `.git/commondir` naming a git dir of its own,
    /// whose `hooks/post-index-change` git runs on anything that rewrites the
    /// index. Neither the redirect nor any hook may reach the Git panel's reads
    /// — file diff, commit-message generation, stage, the merge-state probe a
    /// planted `MERGE_HEAD` leads to — and a hook-trusted verb runs the repo's
    /// *real* hooks, never the planted ones.
    #[cfg(unix)]
    #[test]
    fn a_commondir_redirected_hook_never_runs_through_app_git() {
        if !git_available() {
            eprintln!(concat!("git not on PATH — skipping a_commondir_redirected_hook_never_runs_through_", crate::app_slug!(), "_git"));
            return;
        }
        use std::os::unix::fs::{symlink, PermissionsExt};
        let tmp = tempfile::tempdir().expect("tempdir");
        let dir = tmp.path().join("proj");
        fs::create_dir(&dir).expect("mkdir");
        init_repo(&dir);
        fs::write(dir.join("f.txt"), "a\n").expect("write");
        plain_git(&dir, &["add", "f.txt"]);
        plain_git(&dir, &["commit", "-qm", "init"]);
        let hook = |hooks: &Path, marker: &Path| {
            fs::create_dir_all(hooks).expect("hooks dir");
            let h = hooks.join("post-index-change");
            fs::write(&h, format!("#!/bin/sh\ntouch '{}'\n", marker.display())).expect("hook");
            fs::set_permissions(&h, fs::Permissions::from_mode(0o755)).expect("chmod");
        };

        // The plant: a common dir sharing the real objects, refs and config, with
        // hooks of its own — nothing in `.git/config` or `.git/hooks` touched.
        let git = dir.join(".git");
        let evil = git.join("x");
        fs::create_dir(&evil).expect("mkdir");
        for shared in ["objects", "refs", "config"] {
            symlink(git.join(shared), evil.join(shared)).expect("symlink");
        }
        let planted = tmp.path().join("planted-ran");
        hook(&evil.join("hooks"), &planted);
        fs::write(git.join("commondir"), "x\n").expect("commondir");
        fs::write(dir.join("f.txt"), "b\n").expect("edit");
        plain_git(&dir, &["add", "f.txt"]);
        assert!(planted.exists(), "setup is stale: plain git no longer follows a planted commondir");
        fs::remove_file(&planted).expect("clear");

        let d = dir.to_string_lossy().into_owned();
        fs::write(dir.join("f.txt"), "c\n").expect("edit");
        let diff = git_diff_file_blocking(d.clone(), "f.txt".into()).expect("file diff");
        assert!(diff.contains("+c"), "file diff lost its content: {diff}");
        assert!(!planted.exists(), "planted hook ran on the file diff");
        git_generate_commit_message_blocking(d.clone()).expect("commit message");
        assert!(!planted.exists(), "planted hook ran on commit-message generation");
        git_add_path_blocking(d.clone(), "f.txt".into()).expect("stage");
        assert!(!planted.exists(), "planted hook ran on stage");
        let staged = plain_git(&dir, &["diff", "--cached", "--name-only"]);
        assert_eq!(String::from_utf8_lossy(&staged.stdout).trim(), "f.txt", "stage did not stage");

        // Opening Git history with a planted `MERGE_HEAD` reaches the probe.
        let head = plain_git(&dir, &["rev-parse", "HEAD"]);
        fs::write(git.join("MERGE_HEAD"), &head.stdout).expect("MERGE_HEAD");
        fs::write(dir.join("f.txt"), "d\n").expect("edit");
        let state = tauri::async_runtime::block_on(crate::commands::git_pull::git_merge_state(d.clone(), None))
            .expect("merge state");
        assert!(state.merging, "setup is stale: MERGE_HEAD not seen");
        assert!(!planted.exists(), "planted hook ran on the merge-state probe");
        fs::remove_file(git.join("MERGE_HEAD")).expect("clear MERGE_HEAD");

        // A hook-trusted verb runs hooks — the repo's own, never the planted ones.
        let real = tmp.path().join("real-ran");
        hook(&git.join("hooks"), &real);
        fs::write(dir.join("f.txt"), "e\n").expect("edit");
        let out = run_git_hooked(None, &d, &["add", "f.txt"]).expect("hooked add");
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        assert!(real.exists(), "the repo's own hook did not run through run_git_hooked");
        assert!(!planted.exists(), "planted hook ran through run_git_hooked");
        // …and the default path runs neither.
        fs::remove_file(&real).expect("clear");
        fs::write(dir.join("f.txt"), "f\n").expect("edit");
        run_git(None, &d, &["add", "f.txt"]).expect("add");
        assert!(!real.exists() && !planted.exists(), "a hook ran through run_git");
    }

    /// `GIT_COMMON_DIR` is pinned for a main `.git` only: a linked worktree's
    /// `commondir` is git's own, and pinning it would point the worktree at its
    /// private git dir as if it were the shared one.
    #[cfg(unix)]
    #[test]
    fn the_common_dir_pin_spares_linked_worktrees() {
        if !git_available() {
            eprintln!("git not on PATH — skipping the_common_dir_pin_spares_linked_worktrees");
            return;
        }
        let pinned = |cmd: &std::process::Command| {
            cmd.get_envs()
                .find(|(k, _)| *k == "GIT_COMMON_DIR")
                .and_then(|(_, v)| v.map(PathBuf::from))
        };
        let tmp = tempfile::tempdir().expect("tempdir");
        let main = tmp.path().join("main");
        fs::create_dir(&main).expect("mkdir");
        init_repo(&main);
        fs::write(main.join("f.txt"), "a\n").expect("write");
        plain_git(&main, &["add", "f.txt"]);
        plain_git(&main, &["commit", "-qm", "init"]);
        let sub = main.join("sub");
        fs::create_dir(&sub).expect("mkdir");
        assert_eq!(pinned(&hardened_git_command_in(&sub, &["status"])), Some(main.join(".git")));

        let wt = tmp.path().join("wt");
        let out = plain_git(&main, &["worktree", "add", "-q", wt.to_str().unwrap()]);
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        assert_eq!(pinned(&hardened_git_command_in(&wt, &["status"])), None);
        let out = run_git(None, wt.to_str().unwrap(), &["rev-parse", "--git-common-dir"]).expect("git");
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        let common = PathBuf::from(String::from_utf8_lossy(&out.stdout).trim());
        assert_eq!(
            common.canonicalize().unwrap(),
            main.join(".git").canonicalize().unwrap(),
            "a linked worktree lost its shared common dir"
        );
    }

    #[test]
    fn token_helper_is_registered_only_for_the_given_origins() {
        let args = scoped_token_config(&["https://github.com".to_string()], "x-access-token");
        assert_eq!(&args[..2], ["-c", "credential.helper="]);
        let helpers: Vec<&String> = args.iter().filter(|a| a.contains(".helper=!")).collect();
        assert_eq!(helpers.len(), 1);
        assert!(helpers[0].starts_with("credential.https://github.com.helper=!"));
        assert!(!args.iter().any(|a| a.starts_with("credential.helper=!")), "unscoped helper");
    }

    /// #158 fixture: a clean-filter payload bound to `*.txt` by an in-tree
    /// `.gitattributes`, plus the marker it leaves. The driver itself is planted
    /// by each test wherever the layout under test makes git read it from.
    #[cfg(unix)]
    fn filter_payload(root: &Path) -> (PathBuf, String) {
        use std::os::unix::fs::PermissionsExt;
        let marker = root.join("executed");
        let payload = root.join("payload.sh");
        fs::write(&payload, format!("#!/bin/sh\ntouch '{}'\ncat\n", marker.display()))
            .expect("write");
        fs::set_permissions(&payload, fs::Permissions::from_mode(0o755)).expect("chmod");
        (marker, payload.to_string_lossy().into_owned())
    }

    #[cfg(unix)]
    fn plain_git(dir: &Path, args: &[&str]) -> std::process::Output {
        crate::paths::command_no_window("git")
            .args(args)
            .current_dir(dir)
            .output()
            .expect("git")
    }

    /// Commit a tracked `f.txt` under the filter binding, then make a same-size
    /// edit so the next status/diff has to re-read (and so re-filter) it.
    #[cfg(unix)]
    fn tracked_txt_with_pending_edit(worktree: &Path) {
        fs::write(worktree.join(".gitattributes"), "*.txt filter=x\n").expect("attrs");
        fs::write(worktree.join("f.txt"), "a\n").expect("write");
        plain_git(worktree, &["add", ".gitattributes", "f.txt"]);
        plain_git(
            worktree,
            &["-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-qm", "init"],
        );
        fs::write(worktree.join("f.txt"), "b\n").expect("edit");
    }

    /// Both directions for one layout: plain git in `run_dir` runs the planted
    /// filter (else the setup is stale and the test vacuous), `run_git` does not.
    #[cfg(unix)]
    fn assert_filter_contained(run_dir: &Path, worktree: &Path, marker: &Path, layout: &str) {
        plain_git(run_dir, &["diff"]);
        assert!(marker.exists(), "{layout}: setup is stale — plain git did not run the filter");
        fs::remove_file(marker).expect("clear marker");
        fs::write(worktree.join("f.txt"), "c\n").expect("edit again");

        let dir = run_dir.to_str().expect("utf-8 path");
        run_git(None, dir, &["status", "--porcelain"]).expect("hardened status");
        assert!(!marker.exists(), "{layout}: clean filter ran through run_git status");
        run_git(None, dir, &["diff"]).expect("hardened diff");
        assert!(!marker.exists(), "{layout}: clean filter ran through run_git diff");
    }

    /// #158: `.git` as a pointer file (`gitdir: .notgit`) — the sanitizer used
    /// to open `<project>/.git/config`, find no file, and strip nothing.
    #[cfg(unix)]
    #[test]
    fn a_gitdir_pointer_file_does_not_skip_the_config_strip() {
        if !git_available() {
            eprintln!("git not on PATH — skipping a_gitdir_pointer_file_does_not_skip_the_config_strip");
            return;
        }
        let tmp = tempfile::tempdir().expect("tempdir");
        let dir = tmp.path().join("proj");
        fs::create_dir(&dir).expect("mkdir");
        init_repo(&dir);
        fs::rename(dir.join(".git"), dir.join(".notgit")).expect("move git dir");
        fs::write(dir.join(".git"), "gitdir: .notgit\n").expect("pointer");
        tracked_txt_with_pending_edit(&dir);
        let (marker, payload) = filter_payload(tmp.path());
        plain_git(&dir, &["config", "filter.x.clean", &payload]);
        assert!(
            fs::read_to_string(dir.join(".notgit/config")).unwrap().contains("payload.sh"),
            "the driver must live in the redirected config"
        );
        assert_filter_contained(&dir, &dir, &marker, "gitdir pointer");
    }

    /// #158: a linked worktree — Tabtivity's own agent worktrees. Its `.git`
    /// points at `<common>/worktrees/<name>`, whose `commondir` names the shared
    /// config; with `extensions.worktreeConfig` it also reads `config.worktree`.
    #[cfg(unix)]
    #[test]
    fn a_linked_worktrees_common_and_worktree_config_are_stripped() {
        if !git_available() {
            eprintln!("git not on PATH — skipping a_linked_worktrees_common_and_worktree_config_are_stripped");
            return;
        }
        let tmp = tempfile::tempdir().expect("tempdir");
        let main = tmp.path().join("main");
        fs::create_dir(&main).expect("mkdir");
        init_repo(&main);
        tracked_txt_with_pending_edit(&main);
        plain_git(&main, &["checkout", "-q", "--", "f.txt"]);
        let wt = tmp.path().join("wt");
        let out = plain_git(&main, &["worktree", "add", "-q", wt.to_str().unwrap()]);
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        assert!(wt.join(".git").is_file());
        fs::write(wt.join("f.txt"), "b\n").expect("edit");

        let (marker, payload) = filter_payload(tmp.path());
        plain_git(&main, &["config", "extensions.worktreeConfig", "true"]);
        plain_git(&wt, &["config", "--worktree", "filter.x.clean", &payload]);
        assert_filter_contained(&wt, &wt, &marker, "linked worktree, config.worktree");

        // The shared (common-dir) config, reached through `commondir`.
        plain_git(&main, &["config", "filter.x.clean", &payload]);
        fs::write(wt.join("f.txt"), "d\n").expect("edit");
        assert_filter_contained(&wt, &wt, &marker, "linked worktree, common config");
    }

    /// #158: a project folder inside a larger repo — git discovers the repo by
    /// walking up, so the sanitizer has to find the same `.git` git will.
    #[cfg(unix)]
    #[test]
    fn a_project_below_the_repo_root_is_stripped_too() {
        if !git_available() {
            eprintln!("git not on PATH — skipping a_project_below_the_repo_root_is_stripped_too");
            return;
        }
        let tmp = tempfile::tempdir().expect("tempdir");
        let repo = tmp.path().join("repo");
        let sub = repo.join("sub");
        fs::create_dir_all(&sub).expect("mkdir");
        init_repo(&repo);
        tracked_txt_with_pending_edit(&repo);
        let (marker, payload) = filter_payload(tmp.path());
        plain_git(&repo, &["config", "filter.x.clean", &payload]);
        assert_filter_contained(&sub, &repo, &marker, "project below the repo root");
    }

    /// A folder laid out as a bare repository (`HEAD`, `objects/`, `refs/`,
    /// `config`) is itself a git dir to implicit discovery, and its `config` can
    /// name a `core.worktree`. `safe.bareRepository=explicit` refuses that.
    #[cfg(unix)]
    #[test]
    fn an_implicit_bare_repo_layout_is_refused() {
        if !git_available() {
            eprintln!("git not on PATH — skipping an_implicit_bare_repo_layout_is_refused");
            return;
        }
        let tmp = tempfile::tempdir().expect("tempdir");
        let work = tmp.path().join("work");
        fs::create_dir(&work).expect("mkdir");
        init_repo(&work);
        tracked_txt_with_pending_edit(&work);
        let (marker, payload) = filter_payload(tmp.path());
        // The folder the user adds: the git dir itself, pointing its worktree
        // back at the files.
        let project = tmp.path().join("project");
        fs::rename(work.join(".git"), &project).expect("move git dir");
        plain_git(&project, &["config", "core.bare", "false"]);
        plain_git(&project, &["config", "core.worktree", work.to_str().unwrap()]);
        plain_git(&project, &["config", "filter.x.clean", &payload]);

        plain_git(&project, &["diff"]);
        assert!(marker.exists(), "setup is stale — plain git did not treat the folder as a repo");
        fs::remove_file(&marker).expect("clear marker");
        fs::write(work.join("f.txt"), "c\n").expect("edit again");
        let dir = project.to_str().unwrap();
        let _ = run_git(None, dir, &["status", "--porcelain"]);
        let _ = run_git(None, dir, &["diff"]);
        assert!(!marker.exists(), "implicit bare repo: clean filter ran through run_git");
    }
}
