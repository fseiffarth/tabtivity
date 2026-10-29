//! How Tabtivity runs git: the hardened builder every LOCAL git spawn goes
//! through ([`hardened_git_command_in`] and its hooked/hookless variants), the
//! repo-config sanitizer, the local-vs-remote [`run_git`] dispatch, revision
//! checks and the push/clone transport helpers. Moved down from
//! `commands::git` (S5) so services can use it without naming `commands`;
//! `commands::git` re-exports every item, so `commands::git::
//! hardened_git_command_in` keeps resolving.

use crate::brand::UPPER;
use std::path::{Path, PathBuf};

use crate::services::remote::RemoteTarget;

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
pub(crate) const HARDENED_CONFIG: &[&str] = &[
    "core.fsmonitor=false",
    "protocol.ext.allow=never",
    "safe.bareRepository=explicit",
];

/// The user's own config that changes the shape of output Tabtivity parses,
/// pinned back to git's defaults on every call: `color.ui=always` (or a
/// per-command `color.diff=always`) put escape codes into captured diffs and
/// statuses, `diff.noprefix` / `diff.mnemonicPrefix` drop or rename the
/// `a/` `b/` prefixes, `diff.relative` cuts paths to the cwd, and
/// `log.showSignature` adds gpg output to log records. Settings that choose
/// *what* is shown (`status.showUntrackedFiles`) stay the user's.
pub(crate) const OUTPUT_CONFIG: &[&str] = &[
    "color.ui=never",
    "color.diff=never",
    "color.status=never",
    "color.branch=never",
    "color.grep=never",
    "diff.noprefix=false",
    "diff.mnemonicPrefix=false",
    "diff.relative=false",
    "log.showSignature=false",
];

/// Subcommands that accept `--no-ext-diff` / `--no-textconv`, the two flags that
/// stop a repo-configured `diff.external` / `diff.<driver>.textconv` program from
/// running. Neither flag changes output for a repo that configures neither, and
/// every parser here reads git's own internal diff format anyway.
pub(crate) const DIFF_DRIVER_CMDS: &[&str] = &["diff", "log", "show", "blame"];

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

/// [`git_args`] with the hooks left live: what [`run_git_hooked`] runs.
#[cfg(test)]
pub(crate) fn hooked_git_args<S: AsRef<str>>(args: &[S]) -> Vec<String> {
    git_args(args, Hooks::Live)
}

/// Whether a git call may run the repo's hooks. `Live` only behind
/// [`require_hook_trust`] — see [`hardened_git_args`].
#[derive(Clone, Copy, PartialEq, Eq)]
enum Hooks {
    Off,
    Live,
}

fn git_args<S: AsRef<str>>(args: &[S], hooks: Hooks) -> Vec<String> {
    let mut out: Vec<String> = Vec::with_capacity(args.len() + (HARDENED_CONFIG.len() + OUTPUT_CONFIG.len()) * 2 + 4);
    for kv in HARDENED_CONFIG.iter().chain(OUTPUT_CONFIG) {
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

/// Keys beyond [`CONFIG_DENYLIST`] from which git runs a program, **refused**
/// (never stripped) in a project shared through a hosted server's hub (TODO
/// #2374, user decision: fail closed). Stripping them would silently break
/// legitimate setups (`merge.ours.driver`, signing, a credential helper);
/// pinning exact keys with `-c` cannot reach a named driver. So git is not
/// run in that clone until the key is removed, and the refusal names it.
/// `(prefix, suffix)` like [`CONFIG_DENYLIST`]; an empty suffix with a
/// prefix ending in `.` takes any key below it. `core.hooksPath` and
/// `core.fsmonitor` are absent on purpose: a shared clone's git runs
/// hookless and with `core.fsmonitor=false` pinned per call.
const SHARED_PROGRAM_KEYS: &[(&str, &str)] = &[
    ("merge.", ".driver"),
    ("remote.", ".uploadpack"),
    ("remote.", ".receivepack"),
    ("remote.", ".vcs"),
    ("gpg.", ".program"),
    ("credential.", ".helper"),
    ("url.", ".insteadof"),
    ("url.", ".pushinsteadof"),
    ("pager.", ""),
    ("difftool.", ".cmd"),
    ("mergetool.", ".cmd"),
    ("browser.", ".cmd"),
    ("browser.", ".path"),
    ("man.", ".cmd"),
    ("man.", ".path"),
    ("submodule.", ".update"),
    ("core.sshcommand", ""),
    ("core.gitproxy", ""),
    ("core.askpass", ""),
    ("core.editor", ""),
    ("core.pager", ""),
    ("core.alternaterefscommand", ""),
    ("sequence.editor", ""),
    ("diff.external", ""),
    ("web.browser", ""),
    ("interactive.difffilter", ""),
    ("sendemail.smtpserver", ""),
];

/// Pure match against [`SHARED_PROGRAM_KEYS`], case-insensitive.
fn is_shared_program_key(key: &str) -> bool {
    let key = key.to_ascii_lowercase();
    SHARED_PROGRAM_KEYS.iter().any(|(prefix, suffix)| {
        if suffix.is_empty() && !prefix.ends_with('.') {
            key == *prefix
        } else {
            key.starts_with(prefix) && key.ends_with(suffix) && key.len() > prefix.len()
        }
    })
}

/// Pure match against [`CONFIG_DENYLIST`], case-insensitive (git lowercases
/// section and key names itself; only the attacker-controlled subsection may
/// carry mixed case, and it never touches the fixed prefix/suffix ends this
/// checks).
pub(crate) fn is_denylisted_config_key(key: &str) -> bool {
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
        // Regular files only: a FIFO here would block before git even ran (#2349).
        if let Some(common) = crate::services::git_bounded::read_small_regular(&git_dir.path.join("commondir")) {
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
            let text = crate::services::git_bounded::read_small_regular(&dot_git)?;
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
        cmd.env("GIT_COMMON_DIR", crate::paths::display_path(&abs));
    }
}

/// [`sanitize_repo_git_config`] that **fails closed** (hosted plan §6.5 gate
/// 1): for a shared project's repo, whose `.git/config` can be reached by
/// whatever a co-member's merged content makes run. After the strip every
/// config file is listed again; a file that cannot be listed, or a
/// denylisted key that survived, is an error and the git call is refused.
fn sanitize_repo_git_config_strict(project_dir: &Path) -> Result<(), String> {
    for config in repo_config_files(project_dir) {
        sanitize_git_config_file(&config);
        if let Some(key) = surviving_denylisted_key(&config)? {
            return Err(format!(
                "{} sets {key}, which can make git run a program; git is not run in this shared project until it is removed (git config --file {} --unset-all {key})",
                config.display(),
                config.display()
            ));
        }
    }
    Ok(())
}

/// The first [`CONFIG_DENYLIST`] or [`SHARED_PROGRAM_KEYS`] key `config_path`
/// still sets; `Err` when the file is there but cannot be listed.
fn surviving_denylisted_key(config_path: &Path) -> Result<Option<String>, String> {
    if !config_path.exists() {
        return Ok(None);
    }
    let path = config_path.to_str().ok_or_else(|| format!("{}: not a UTF-8 path", config_path.display()))?;
    // Bare on purpose: `config --file` reads one file as plain config, no repo.
    let listed = crate::paths::command_no_window("git")
        .args(["config", "--file", path, "--name-only", "--list", "--no-includes"])
        .output()
        .map_err(|e| format!("git config: {e}"))?;
    if !listed.status.success() {
        return Err(format!("{} cannot be read as git config, so git is not run in this shared project", config_path.display()));
    }
    Ok(String::from_utf8_lossy(&listed.stdout)
        .lines()
        .map(str::trim)
        .find(|k| is_denylisted_config_key(k) || is_shared_program_key(k))
        .map(str::to_string))
}

/// A command that runs nothing and fails with `message` on stderr — what a
/// git call becomes when [`sanitize_repo_git_config_strict`] refuses it.
/// The message is `sh`'s `$1`, so arguments a caller appends to the returned
/// command (`worktree repair <paths>`) are only more ignored parameters.
fn refusing_command(message: &str) -> std::process::Command {
    let mut cmd = crate::paths::command_no_window(refusal_shell());
    cmd.args(["-c", "printf '%s\\n' \"$1\" >&2; exit 128", "sh", message]);
    cmd
}

#[cfg(not(windows))]
fn refusal_shell() -> PathBuf {
    PathBuf::from("/bin/sh")
}

/// Windows has no `/bin/sh` (the refusal used to surface as a spawn error,
/// its message lost): Git for Windows' own `sh.exe`, from the install the
/// git we run comes from. Not cmd or PowerShell: both re-parse appended
/// arguments as code. With no Git for Windows `sh` the spawn still fails —
/// still refused, only without the message.
#[cfg(windows)]
fn refusal_shell() -> PathBuf {
    let git = crate::paths::helper_program(std::ffi::OsStr::new("git"))
        .or_else(|| crate::paths::resolve_executable("git"));
    git.into_iter()
        .flat_map(|git| sh_beside_git(&git))
        .find(|sh| sh.is_file())
        .unwrap_or_else(|| PathBuf::from("sh"))
}

/// Where Git for Windows keeps `sh.exe` relative to a `git.exe` it ships —
/// `<root>\cmd\git.exe`, `<root>\bin\git.exe` or
/// `<root>\mingw64\bin\git.exe` — in lookup order. Pure.
#[cfg(any(windows, test))]
fn sh_beside_git(git: &Path) -> Vec<PathBuf> {
    git.ancestors()
        .skip(2)
        .take(2)
        .flat_map(|root| [root.join("bin").join("sh.exe"), root.join("usr").join("bin").join("sh.exe")])
        .collect()
}

fn sanitize_git_config_file(config_path: &Path) {
    let Some(config_path_str) = config_path.to_str() else {
        return;
    };
    if !config_path.is_file() {
        return;
    }
    // Bare on purpose (both spawns here): `config --file` edits one file as
    // plain config, no repo — this is the sanitizer the hardened builder runs.
    let mut list = crate::paths::command_no_window("git");
    list.args([
        "config",
        "--file",
        config_path_str,
        "--name-only",
        "--list",
        "--no-includes",
    ]);
    let read = crate::services::git_bounded::READ_TIMEOUT;
    let Ok(listed) = crate::services::git_bounded::output_within(list, read) else {
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
        let mut unset = crate::paths::command_no_window("git");
        unset.args(["config", "--file", config_path_str, "--unset-all", &key]);
        let _ = crate::services::git_bounded::output_within(unset, read);
    }
}

/// [`git_command`] with [`sanitize_repo_git_config`] run first, `current_dir
/// (project_dir)` set, [`pin_common_dir`] applied and hooks pinned off — the one
/// function every LOCAL git spawn in this codebase goes through, so "this
/// project's repo is untrusted" (Group O #151, #862) has one definition instead
/// of one per call site. Hooks run only through [`hooked_git_command_in`].
/// The test `every_local_git_spawn_goes_through_the_hardened_builder` scans
/// the sources for a bare spawn outside its allowlist.
pub(crate) fn hardened_git_command_in<S: AsRef<str>, P: AsRef<Path>>(
    project_dir: P,
    args: &[S],
) -> std::process::Command {
    git_command_in(project_dir.as_ref(), args, Hooks::Off)
}

/// `git <args>` in `dir` (on `target`'s host when remote), hooks pinned off:
/// its stdout, trimmed, or `None` when git could not run (or was stopped) or
/// exited non-zero. The one shape every "read one value out of git" caller
/// wants; use [`run_git`] when the failure text matters.
pub(crate) fn stdout<P: AsRef<Path>>(target: Option<&RemoteTarget>, dir: P, args: &[&str]) -> Option<String> {
    use crate::services::git_bounded::BoundedOutput;
    let out = match target {
        Some(_) => run_git(target, &dir.as_ref().to_string_lossy(), args).ok()?,
        None => hardened_git_command_in(dir, args).bounded_output().ok()?,
    };
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
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

/// The subcommand of a git argument list: the first argument after any
/// leading `-c key=value` pairs.
fn subcommand_of<S: AsRef<str>>(args: &[S]) -> Option<&str> {
    let mut rest = args.iter().map(|a| a.as_ref());
    loop {
        match rest.next()? {
            "-c" => {
                rest.next()?;
            }
            sub => return Some(sub),
        }
    }
}

fn git_command_in<S: AsRef<str>>(project_dir: &Path, args: &[S], hooks: Hooks) -> std::process::Command {
    // `init` creates a new repository here, and `clone` a new one below it
    // (a shared project's clone-to-add, hosted plan §6.2). An ancestor may
    // itself be a repo (including a shared temp root); pinning its common dir
    // would make the new repository incomplete and send later commands to the
    // ancestor. The subcommand follows any leading `-c key=value` pairs.
    let initializing = subcommand_of(args).is_some_and(|sub| sub == "init" || sub == "clone");
    // A project shared through a hosted server's hub (plan §6.5 gate 1): its
    // hooks can arrive by merge, so a hooked verb runs hookless here, and
    // config sanitizing fails closed.
    let shared = !initializing && crate::services::server::share::is_shared_dir(project_dir);
    let hooks = if shared { Hooks::Off } else { hooks };
    if shared {
        if let Err(message) = sanitize_repo_git_config_strict(project_dir) {
            return refusing_command(&message);
        }
    } else if !initializing {
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
        // Bounded too, at the same verb's ceiling (`run_git_remote`): a stalled
        // master must not wedge the caller.
        Some(t) => {
            let args = git_args(args, hooks);
            crate::services::ssh_exec::run_git_remote(&t.spec, &args)
        }
        // Bounded (#2349): a FIFO ignore/attributes file must not hang git.
        None => crate::services::git_bounded::output_within(
            git_command_in(Path::new(project_dir), args, hooks),
            crate::services::git_bounded::timeout_for(args, hooks == Hooks::Live),
        ),
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
pub(crate) fn valid_positional_path(s: &str) -> bool {
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

/// [`git_available`] on the calling thread, for code already off the window's.
pub fn git_available_blocking() -> bool {
    // Bare on purpose: `--version` touches no repo.
    crate::paths::command_no_window("git")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
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
    // A `refs/replace` graft would otherwise pass push's fast-forward check
    // for a commit that rewrites the remote branch.
    cmd.env("GIT_NO_REPLACE_OBJECTS", "1");
    cmd
}

/// The repo's `pre-push` hook as git would find it for a hooked push: the dir
/// `rev-parse --git-path hooks` names (honouring `core.hooksPath`, relative to
/// the repo), if an executable `pre-push` sits there. The lookup
/// `services::exec_trust` fingerprints against. Neither query runs a hook.
pub(crate) fn resolve_pre_push_hook(dir: &std::path::Path) -> Option<std::path::PathBuf> {
    let out = crate::services::git_bounded::output(hooked_git_command_in(dir, &["rev-parse", "--git-path", "hooks"])).ok()?;
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

/// `-c core.hooksPath=` — pinned by [`hardened_git_args`] on every git call
/// except the hook-trust-gated verbs ([`run_git_hooked`],
/// [`hooked_git_command_in`]). An empty value makes git find no hook to run —
/// neither in `.git/hooks` nor relative to the cwd (verified against git
/// 2.53.0); unlike `diff.external=` it does not make git try to exec the empty
/// string.
pub(crate) const NO_HOOKS_CONFIG: &[&str] = &["core.hooksPath="];

/// Turn git's own auth failure into the one sentence that tells the user what to
/// do about it. A private https repo with no token stored reads as "could not
/// read Username" / "Authentication failed", which explains nothing on its own.
pub(crate) fn clone_error(stderr: &str, had_token: bool, https: bool) -> String {
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

    let token = crate::services::git_hosting::global_git_token();
    let https = {
        let lower = url.to_ascii_lowercase();
        lower.starts_with("https://") || lower.starts_with("http://")
    };

    // Bare on purpose: a network clone into a new, empty `dest`; no local repo
    // whose config or hooks could run (the URL is validated above).
    let mut cmd = crate::paths::command_no_window("git");
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    cmd.env("GIT_SSH_COMMAND", "ssh -o BatchMode=yes");
    if https {
        if let Some(tok) = token.as_deref() {
            let origins = crate::services::git_hosting::token_origins(None, None);
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

/// Hosted plan §6.5 gate 1: in a shared project's repo, config sanitizing
/// fails closed and a refused call runs nothing.
#[cfg(all(test, unix))]
mod shared_gate_tests {
    use super::*;

    fn repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let out = std::process::Command::new("git").args(["init", "-q"]).current_dir(dir.path()).output().unwrap();
        assert!(out.status.success());
        dir
    }

    #[test]
    fn strict_sanitizing_strips_and_then_refuses_what_it_cannot_read() {
        let dir = repo();
        let config = dir.path().join(".git/config");
        let mut text = std::fs::read_to_string(&config).unwrap();
        text.push_str("[filter \"x\"]\n\tclean = touch /tmp/pwned\n");
        std::fs::write(&config, &text).unwrap();
        sanitize_repo_git_config_strict(dir.path()).unwrap();
        assert!(!std::fs::read_to_string(&config).unwrap().contains("pwned"), "the filter is gone");
        // A config git cannot parse: refused, not skipped.
        std::fs::write(&config, "[core\n\tbare = false\n").unwrap();
        let error = sanitize_repo_git_config_strict(dir.path()).unwrap_err();
        assert!(error.contains("cannot be read"), "{error}");
        // The lenient path the desktop keeps does not refuse.
        sanitize_repo_git_config(dir.path());
    }

    /// TODO #2374 (user decision): every other key git runs a program from
    /// refuses the shared clone's git — not stripped — and says which.
    #[test]
    fn strict_sanitizing_refuses_every_program_running_key() {
        for (section, line) in [
            ("[merge \"ours\"]", "driver = true"),
            ("[remote \"origin\"]", "uploadpack = touch /tmp/x"),
            ("[core]", "sshCommand = ssh -oProxyCommand=x"),
            ("[core]", "askPass = /tmp/x"),
            ("[gpg]", "program = /tmp/x"),
            ("[gpg \"ssh\"]", "program = /tmp/x"),
            ("[credential]", "helper = !x"),
            ("[credential \"https://example.invalid\"]", "helper = x"),
            ("[url \"/tmp/evil\"]", "insteadOf = https://example.invalid/"),
            ("[sequence]", "editor = x"),
            ("[pager]", "log = x"),
            ("[diff]", "external = x"),
        ] {
            let dir = repo();
            let config = dir.path().join(".git/config");
            let mut text = std::fs::read_to_string(&config).unwrap();
            text.push_str(&format!("{section}\n\t{line}\n"));
            std::fs::write(&config, &text).unwrap();
            let error = sanitize_repo_git_config_strict(dir.path()).unwrap_err();
            assert!(error.contains("can make git run a program"), "{section} {line}: {error}");
            assert!(std::fs::read_to_string(&config).unwrap().contains(line.split(' ').next().unwrap()), "refused, not stripped: {section}");
        }
        // What a clone of a shared project legitimately holds still runs.
        let dir = repo();
        let config = dir.path().join(".git/config");
        let mut text = std::fs::read_to_string(&config).unwrap();
        text.push_str("[remote \"origin\"]\n\turl = /srv/hub/p.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n[core]\n\thooksPath = .husky\n[user]\n\tname = A\n");
        std::fs::write(&config, &text).unwrap();
        sanitize_repo_git_config_strict(dir.path()).unwrap();
        assert!(is_shared_program_key("core.sshCommand") && !is_shared_program_key("core.sshcommandx") && !is_shared_program_key("remote.origin.url"));
    }

    #[test]
    fn a_refused_call_runs_nothing_and_says_why() {
        let out = refusing_command("refused: because").output().unwrap();
        assert_eq!(out.status.code(), Some(128));
        assert_eq!(String::from_utf8_lossy(&out.stderr).trim(), "refused: because");
        assert!(out.stdout.is_empty());
        // A caller appending arguments (`worktree repair <paths>`) adds nothing
        // that runs: they are positional parameters, never code.
        let tmp = tempfile::tempdir().unwrap();
        let marker = tmp.path().join("ran");
        let out = refusing_command("refused")
            .arg(format!("; touch {}", marker.display()))
            .arg(format!("$(touch {})", marker.display()))
            .output()
            .unwrap();
        assert_eq!(out.status.code(), Some(128));
        assert_eq!(String::from_utf8_lossy(&out.stderr).trim(), "refused");
        assert!(!marker.exists());
    }

    /// Windows has no `/bin/sh`: the refusal runs Git for Windows' `sh.exe`,
    /// found from the git it would have run, wherever that git lives.
    #[test]
    fn the_windows_refusal_shell_is_found_beside_git() {
        let root = Path::new("C:").join("Program Files").join("Git");
        let sh = root.join("bin").join("sh.exe");
        for git in [
            root.join("cmd").join("git.exe"),
            root.join("bin").join("git.exe"),
            root.join("mingw64").join("bin").join("git.exe"),
        ] {
            assert!(sh_beside_git(&git).contains(&sh), "{}: {:?}", git.display(), sh_beside_git(&git));
        }
        assert_eq!(sh_beside_git(&root.join("cmd").join("git.exe"))[0], sh, "the install's own bin first");
    }

    #[test]
    fn the_subcommand_follows_leading_config_pairs() {
        assert_eq!(subcommand_of(&["-c", "safe.directory=/x", "clone", "a"]), Some("clone"));
        assert_eq!(subcommand_of(&["status"]), Some("status"));
        assert_eq!(subcommand_of(&["-c", "a=b"]), None);
    }
}
