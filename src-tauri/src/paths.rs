use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::process::{Child, Command};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OsKind {
    Windows,
    Macos,
    Unix,
}

impl OsKind {
    pub fn current() -> Self {
        if cfg!(target_os = "windows") {
            Self::Windows
        } else if cfg!(target_os = "macos") {
            Self::Macos
        } else {
            Self::Unix
        }
    }
}

/// The PATH-lookup executable for `os`: `where` on Windows, `which` elsewhere.
/// `which` does not exist on Windows, so any detection that hardcodes it reports
/// every Windows install as missing.
pub fn path_finder(os: OsKind) -> &'static str {
    match os {
        OsKind::Windows => "where",
        OsKind::Macos | OsKind::Unix => "which",
    }
}

/// Build a [`std::process::Command`] for `bin` that never flashes a console
/// window on Windows. Console tools (TeX engines, `bibtex`, `synctex`, `where`)
/// are GUI-less subprocesses we only read output from; without `CREATE_NO_WINDOW`
/// each invocation pops a transient console window, and a single TeX compile
/// spawns several. No-op on non-Windows targets.
///
/// One of Tabtivity's own helpers ([`TRUSTED_HELPERS`]) is taken from the
/// root-owned system directories first — see [`helper_program`].
pub fn command_no_window(bin: impl AsRef<OsStr>) -> Command {
    let bin = bin.as_ref();
    let mut cmd = match helper_program(bin) {
        Some(program) => Command::new(program),
        None => Command::new(bin),
    };
    augment_command_path(&mut cmd);
    hide_command_window(&mut cmd);
    cmd
}

pub(crate) fn hide_command_window(_cmd: &mut Command) {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW (winbase.h): don't allocate a console for the child.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        _cmd.creation_flags(CREATE_NO_WINDOW);
    }
}

/// True when `bin` resolves on Tabtivity's effective PATH on the current OS.
/// Windows lookup expands PATHEXT and all platforms include supplemental
/// per-user/package-manager directories.
pub fn binary_on_path(bin: &str) -> bool {
    resolve_executable(bin).is_some()
}

/// Tabtivity's own security-relevant helpers: they run with its full authority
/// in project folders and against remote hosts, often in the background. By
/// bare name they would resolve through [`effective_path`], which puts
/// user-writable dirs (`~/.local/bin`, …) first — a planted `~/.local/bin/git`
/// would then run at the next file-tree poll (#861). The last three are
/// Windows' own shells and ACL tool, which Tabtivity runs its one-liners
/// through (agent installers, junctions, `services::private_file`); Unix has
/// no root-owned copy of them, so nothing changes there.
const TRUSTED_HELPERS: &[&str] =
    &["git", "tmux", "ssh", "scp", "sftp", "rsync", "cmd", "powershell", "icacls"];

/// Directories only root can add a program to on a sane Unix install. Each
/// hit is still checked with [`root_owned_file`].
#[cfg(unix)]
const SYSTEM_BIN_DIRS: &[&str] = &[
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
    "/usr/local/bin",
    "/usr/local/sbin",
];

/// Where an administrator-installed copy of a helper lives on Windows, in
/// lookup order: Git for Windows' launcher and tool dirs, the in-box OpenSSH,
/// Windows PowerShell, System32. Each hit is still checked with
/// `services::private_file::admin_locked`, so a variable pointing somewhere
/// the user can write only ever costs the lookup. Pure over the two values.
#[cfg(any(windows, test))]
fn windows_system_bin_dirs(program_files: Option<&OsStr>, system_root: Option<&OsStr>) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(pf) = program_files.filter(|p| !p.is_empty()) {
        let git = Path::new(pf).join("Git");
        dirs.push(git.join("cmd"));
        dirs.push(git.join("bin"));
    }
    if let Some(root) = system_root.filter(|r| !r.is_empty()) {
        let system32 = Path::new(root).join("System32");
        dirs.push(system32.join("OpenSSH"));
        dirs.push(system32.join("WindowsPowerShell").join("v1.0"));
        dirs.push(system32);
    }
    dirs
}

/// The first `dir/bin` in `dirs` that `trusted` accepts. Pure over `trusted`.
fn first_trusted_in(
    dirs: &[PathBuf],
    bin: &str,
    trusted: &impl Fn(&Path) -> bool,
) -> Option<PathBuf> {
    if bin.is_empty() || bin.contains('/') || bin.contains('\\') {
        return None;
    }
    dirs.iter().map(|dir| dir.join(bin)).find(|cand| trusted(cand))
}

/// An executable only root can have put there or changed: after resolving
/// links, the file and its directory are root-owned and neither is group- or
/// world-writable. (A Homebrew `/usr/local/bin` owned by the user fails this.)
#[cfg(unix)]
fn root_owned_file(path: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    let Ok(real) = path.canonicalize() else {
        return false;
    };
    let locked = |p: &Path| {
        std::fs::metadata(p).is_ok_and(|m| m.uid() == 0 && m.mode() & 0o022 == 0)
    };
    std::fs::metadata(&real).is_ok_and(|m| m.is_file() && m.mode() & 0o111 != 0)
        && locked(&real)
        && real.parent().is_some_and(locked)
}

/// `bin` from the root-owned system directories only — never from `PATH` or a
/// per-user directory. `None` when there is no such copy. On Windows the
/// directories are [`windows_system_bin_dirs`], the file is `<bin>.exe`, and
/// "root-owned" means owned by Administrators/SYSTEM/TrustedInstaller with no
/// one else allowed to write it or its folder; a descriptor that cannot be
/// read is `None`, never trusted. The agent fence takes `bwrap` from here and
/// fails closed without it.
pub fn system_executable(bin: &str) -> Option<PathBuf> {
    #[cfg(unix)]
    {
        let dirs: Vec<PathBuf> = SYSTEM_BIN_DIRS.iter().map(PathBuf::from).collect();
        first_trusted_in(&dirs, bin, &root_owned_file)
    }
    #[cfg(windows)]
    {
        if bin.is_empty() {
            return None;
        }
        let dirs = windows_system_bin_dirs(
            std::env::var_os("ProgramFiles").as_deref(),
            std::env::var_os("SystemRoot").as_deref(),
        );
        first_trusted_in(&dirs, &format!("{bin}.exe"), &crate::services::private_file::admin_locked)
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = bin;
        None
    }
}

/// The program to spawn for one of Tabtivity's own helpers ([`TRUSTED_HELPERS`]):
/// its root-owned system copy when there is one. `None` for any other name,
/// and for a helper the system lacks (Homebrew's tmux, a per-user Git for
/// Windows), which then resolves on the effective `PATH` as before.
pub fn helper_program(bin: &OsStr) -> Option<PathBuf> {
    let name = bin.to_str()?;
    if !TRUSTED_HELPERS.contains(&name) {
        return None;
    }
    system_executable(name)
}

/// True when a failed `rename` failed only because source and destination sit
/// on different filesystems or volumes — the one failure a copy-then-delete
/// fallback is the right answer to. Anything else (a file held open on Windows,
/// a permission refusal, a TCC-protected folder on macOS) must surface: a copy
/// would either fail the same way halfway through or succeed and then leave the
/// source behind, i.e. a duplicate the user never asked for.
///
/// `ErrorKind::CrossesDevices` maps both `EXDEV` and `ERROR_NOT_SAME_DEVICE`.
/// The raw-code arms are a belt-and-braces fallback and are deliberately
/// cfg-gated per OS family: raw 17 is `ERROR_NOT_SAME_DEVICE` on Windows but
/// `EEXIST` on Linux and macOS, so comparing it across OSes would turn "the
/// destination already exists" into a silent copy over it.
pub fn is_cross_device(e: &std::io::Error) -> bool {
    if e.kind() == std::io::ErrorKind::CrossesDevices {
        return true;
    }
    #[cfg(unix)]
    {
        // EXDEV is 18 on Linux and macOS alike.
        e.raw_os_error() == Some(18)
    }
    #[cfg(windows)]
    {
        // ERROR_NOT_SAME_DEVICE.
        e.raw_os_error() == Some(17)
    }
    #[cfg(not(any(unix, windows)))]
    {
        false
    }
}

/// Standard directories macOS package managers (Homebrew, MacTeX) install CLI
/// tools into but which a Finder/Dock-launched GUI app's inherited PATH omits —
/// so a tool can be installed yet unreachable by bare name. The macOS analogue of
/// the per-user dirs in [`launch_search_dirs`].
const MACOS_EXTRA_DIRS: &[&str] = &[
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/local/sbin",
    "/opt/local/bin",
    "/opt/local/sbin",
    "/Library/TeX/texbin",
];

fn supplemental_path_dirs_for(
    os: OsKind,
    home: &Path,
    local_app_data: Option<&OsStr>,
    app_data: Option<&OsStr>,
    program_files: Option<&OsStr>,
) -> Vec<PathBuf> {
    let mut dirs = vec![
        home.join(".local").join("bin"),
        home.join(".cargo").join("bin"),
        home.join(".opencode").join("bin"),
        // OpenClaw's installer puts only its `openclaw` wrapper here (the
        // private Node it bundles lives under `tools/`), so nothing is shadowed.
        home.join(".openclaw").join("bin"),
    ];
    match os {
        OsKind::Macos => {
            dirs.extend(MACOS_EXTRA_DIRS.iter().map(PathBuf::from));
            // Container CLIs a Finder-launched app cannot see: Docker Desktop's
            // per-user install (no admin rights, nothing in /usr/local/bin),
            // OrbStack's, and the CLI inside Docker.app itself. Mac-only on
            // purpose — the common list above is prepended on Linux too, where an
            // extra dir would change which binary wins.
            dirs.push(home.join(".docker").join("bin"));
            dirs.push(home.join(".orbstack").join("bin"));
            dirs.push(PathBuf::from(
                "/Applications/Docker.app/Contents/Resources/bin",
            ));
        }
        OsKind::Windows => {
            if let Some(local) = local_app_data {
                let local = PathBuf::from(local);
                dirs.push(local.join("Microsoft").join("WindowsApps"));
                dirs.push(local.join("Programs").join("Ollama"));
                // Per-user winget install of MiKTeX (`winget install --id
                // MiKTeX.MiKTeX -e`, the command the "Install MiKTeX" button runs) —
                // without this, a fresh install stays invisible to Tabtivity's own
                // process until it's relaunched, since a Windows PATH change made by
                // an installer never reaches an already-running process's env.
                dirs.push(
                    local
                        .join("Programs")
                        .join("MiKTeX")
                        .join("miktex")
                        .join("bin")
                        .join("x64"),
                );
                // Codex's standalone Windows installer (releases.openai.com/codex/
                // install.ps1) writes here and updates the User PATH registry for
                // *future* sessions only — the same "invisible until relaunch" gap.
                dirs.push(
                    local
                        .join("Programs")
                        .join("OpenAI")
                        .join("Codex")
                        .join("bin"),
                );
                dirs.push(local.join("bin"));
            }
            if let Some(roaming) = app_data {
                dirs.push(PathBuf::from(roaming).join("npm"));
            }
            // Machine-wide MiKTeX install (`winget install --scope machine`, or the
            // classic non-winget installer, which defaults here).
            if let Some(pf) = program_files {
                dirs.push(
                    PathBuf::from(pf)
                        .join("MiKTeX")
                        .join("miktex")
                        .join("bin")
                        .join("x64"),
                );
                // The official QEMU Windows installer (qemu.org) puts
                // `qemu-system-*.exe` and `qemu-img.exe` here and adds nothing
                // to PATH; the VM tier resolves them through this.
                dirs.push(PathBuf::from(pf).join("qemu"));
            }
        }
        OsKind::Unix => {}
    }
    dirs
}

/// Directories prepended to every child process PATH. GUI-launched applications
/// commonly miss per-user package directories on every supported OS.
pub fn extra_path_dirs() -> Vec<PathBuf> {
    let mut dirs = vec![crate::services::agent_bin::bin_dir()];
    // CLIs Tabtivity installed itself, ahead of any host copy of the same name.
    dirs.extend(crate::services::agent_install::bin_dirs());
    dirs.extend(supplemental_path_dirs_for(
        OsKind::current(),
        &home_dir(),
        std::env::var_os("LOCALAPPDATA").as_deref(),
        std::env::var_os("APPDATA").as_deref(),
        std::env::var_os("ProgramFiles").as_deref(),
    ));
    if OsKind::current() != OsKind::Windows {
        dirs.extend(nvm_default_node_bin());
    }
    dirs
}

/// `v24.19.0` / `24.19.0` → `(24, 19, 0)`; a missing minor/patch reads as 0.
pub fn parse_node_version(raw: &str) -> Option<(u32, u32, u32)> {
    let mut parts = raw.trim().trim_start_matches('v').splitn(3, '.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next().map_or(Some(0), |p| p.parse().ok())?;
    let patch = parts.next().map_or(Some(0), |p| p.parse().ok())?;
    Some((major, minor, patch))
}

/// The `bin` dir of nvm's default Node, the one an interactive shell gets once
/// `nvm.sh` runs from its rc file. Tabtivity's own processes never source that, so
/// without this a Node installed through nvm (the Manage Agents Node helper's
/// route) stays invisible to agent installs and to the helper's recheck, which
/// would keep finding an older system Node instead.
fn nvm_default_node_bin() -> Option<PathBuf> {
    let nvm_dir = std::env::var_os("NVM_DIR")
        .filter(|d| !d.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| home_dir().join(".nvm"));
    let versions = nvm_dir.join("versions").join("node");
    let installed: Vec<String> = std::fs::read_dir(&versions)
        .ok()?
        .filter_map(|e| e.ok()?.file_name().into_string().ok())
        .collect();
    let read_alias = |name: &str| {
        std::fs::read_to_string(nvm_dir.join("alias").join(name))
            .ok()
            .map(|s| s.trim().to_string())
    };
    let version = resolve_nvm_version(read_alias("default").as_deref(), &read_alias, &installed)?;
    Some(versions.join(version).join("bin"))
}

/// Which installed nvm version (`v24.19.0` dir name) the `default` alias means.
/// Aliases chain through nvm's alias files (`lts/*` → `lts/jod` → `v22.22.2`);
/// a version prefix (`24`, `v24.19`) takes the newest install it matches. With
/// no default, or one that resolves to nothing installed, the newest install
/// wins — what `nvm.sh` activates when a lone `nvm install --lts` set no alias.
fn resolve_nvm_version(
    default: Option<&str>,
    read_alias: &impl Fn(&str) -> Option<String>,
    installed: &[String],
) -> Option<String> {
    let newest_matching = |prefix: Option<&str>| {
        installed
            .iter()
            .filter(|v| {
                prefix.is_none_or(|p| {
                    let p = p.trim_start_matches('v');
                    let v = v.trim_start_matches('v');
                    v == p || v.starts_with(&format!("{p}."))
                })
            })
            .filter_map(|v| Some((parse_node_version(v)?, v)))
            .max_by_key(|(parsed, _)| *parsed)
            .map(|(_, v)| v.clone())
    };
    let mut alias = default.map(str::to_string);
    for _ in 0..8 {
        let Some(current) = alias.take() else { break };
        // The user pointed nvm back at the OS Node on purpose; add nothing.
        if current == "system" {
            return None;
        }
        if parse_node_version(&current).is_some() {
            return newest_matching(Some(&current)).or_else(|| newest_matching(None));
        }
        alias = read_alias(&current);
    }
    newest_matching(None)
}

/// Prepend [`extra_path_dirs`] to `cmd`'s PATH env.
pub fn augment_command_path(cmd: &mut std::process::Command) {
    if let Some(path) = effective_path() {
        cmd.env("PATH", path);
    }
}

pub fn effective_path() -> Option<std::ffi::OsString> {
    let current = std::env::var_os("PATH").unwrap_or_default();
    let mut paths = extra_path_dirs();
    paths.extend(std::env::split_paths(&current));
    std::env::join_paths(&paths).ok()
}

/// Where an off-PATH launch looks: the extra dirs minus the agent shims,
/// which are never the CLI itself (see `resolve_executable`).
fn launch_search_dirs() -> Vec<PathBuf> {
    let shims = crate::services::agent_bin::bin_dir();
    extra_path_dirs().into_iter().filter(|d| *d != shims).collect()
}

/// Pure resolver: the first existing `bin` across `dirs`, trying each of `exts`
/// (an empty `exts` / `""` entry means no extension expansion). `exists` is
/// injected so this is unit-testable without touching the filesystem.
fn resolve_in_dirs(
    dirs: &[PathBuf],
    bin: &str,
    exts: &[&str],
    exists: &impl Fn(&Path) -> bool,
) -> Option<PathBuf> {
    for dir in dirs {
        let base = dir.join(bin);
        if exists(&base) {
            return Some(base);
        }
        for ext in exts {
            if ext.is_empty() {
                continue;
            }
            let cand = dir.join(format!("{bin}.{ext}"));
            if exists(&cand) {
                return Some(cand);
            }
        }
    }
    None
}

fn windows_extensions(pathext: Option<&OsStr>) -> Vec<String> {
    let value = pathext
        .and_then(OsStr::to_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(".COM;.EXE;.BAT;.CMD;.PS1");
    let mut extensions = value
        .split(';')
        .map(|ext| ext.trim().trim_start_matches('.').to_ascii_lowercase())
        .filter(|ext| !ext.is_empty())
        .collect::<Vec<_>>();
    // PowerShell scripts are launchable through our explicit dispatcher even
    // though Windows' default PATHEXT usually omits .PS1.
    if !extensions.iter().any(|ext| ext == "ps1") {
        extensions.push("ps1".to_string());
    }
    extensions
}

fn resolve_executable_in_dirs(
    os: OsKind,
    dirs: &[PathBuf],
    bin: &str,
    pathext: Option<&OsStr>,
    exists: &impl Fn(&Path) -> bool,
) -> Option<PathBuf> {
    if bin.is_empty() {
        return None;
    }
    if bin.contains('/') || bin.contains('\\') {
        let path = PathBuf::from(bin);
        return exists(&path).then_some(path);
    }
    let exts = if os == OsKind::Windows {
        windows_extensions(pathext)
    } else {
        Vec::new()
    };
    let refs = exts.iter().map(String::as_str).collect::<Vec<_>>();
    resolve_in_dirs(dirs, bin, &refs, exists)
}

/// Resolve a command using the same effective PATH Tabtivity applies at execution.
/// Windows resolution follows PATHEXT, including script shims.
pub fn resolve_executable(bin: &str) -> Option<PathBuf> {
    let current = std::env::var_os("PATH").unwrap_or_default();
    // Never the agent shims in `<state_dir>/bin`: a resolver wants the CLI
    // itself (to probe its version, to bind its install into a fence), and
    // the shim is only a door back to it for shell tabs.
    let shims = crate::services::agent_bin::bin_dir();
    let mut dirs: Vec<PathBuf> = extra_path_dirs().into_iter().filter(|d| *d != shims).collect();
    dirs.extend(std::env::split_paths(&current).filter(|d| *d != shims));
    resolve_executable_in_dirs(
        OsKind::current(),
        &dirs,
        bin,
        std::env::var_os("PATHEXT").as_deref(),
        &|path| path.is_file(),
    )
}

pub fn resolve_executable_in_dir(dir: &Path, bin: &str) -> Option<PathBuf> {
    resolve_executable_in_dirs(
        OsKind::current(),
        std::slice::from_ref(&dir.to_path_buf()),
        bin,
        std::env::var_os("PATHEXT").as_deref(),
        &|path| path.is_file(),
    )
}

fn command_for_program_for(os: OsKind, program: &Path) -> Command {
    let ext = program
        .extension()
        .and_then(OsStr::to_str)
        .unwrap_or("")
        .to_ascii_lowercase();
    let mut cmd = if os == OsKind::Windows && matches!(ext.as_str(), "cmd" | "bat") {
        let mut cmd = Command::new("cmd.exe");
        cmd.args(["/D", "/C"]).arg(program);
        cmd
    } else if os == OsKind::Windows && ext == "ps1" {
        let mut cmd = Command::new("powershell.exe");
        cmd.args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"])
            .arg(program);
        cmd
    } else {
        Command::new(program)
    };
    augment_command_path(&mut cmd);
    hide_command_window(&mut cmd);
    cmd
}

/// Build a command for a resolved executable. Windows command/batch shims run
/// through cmd.exe and PowerShell scripts through powershell.exe.
pub fn command_for_program(program: &Path) -> Command {
    command_for_program_for(OsKind::current(), program)
}

/// Spawn a process whose result is intentionally ignored, retaining the Child
/// in a background waiter so it cannot become a zombie or leak process handles.
pub fn spawn_reaped(mut cmd: Command) -> std::io::Result<u32> {
    let mut child: Child = cmd.spawn()?;
    let pid = child.id();
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(pid)
}

/// Resolve a bare tool name to an absolute executable path when it is installed
/// in a well-known per-user location but is NOT on the inherited PATH. Returns
/// `None` when the name already carries a path, already resolves on PATH (so the
/// caller should keep using the bare name), or matches nowhere. This closes the
/// gap where Tabtivity *detects* a tool (ollama/vibe/agent CLIs) yet fails to
/// *launch* it on Windows because winget/uv/npm install dirs aren't on PATH.
pub fn resolve_offpath_binary(bin: &str) -> Option<PathBuf> {
    if bin.is_empty() || bin.contains('/') || bin.contains('\\') {
        return None;
    }
    if binary_on_path(bin) {
        return None;
    }
    resolve_executable_in_dirs(
        OsKind::current(),
        &launch_search_dirs(),
        bin,
        std::env::var_os("PATHEXT").as_deref(),
        &|p| p.is_file(),
    )
}

pub fn home_dir() -> PathBuf {
    home_dir_for(OsKind::current(), |key| std::env::var(key).ok())
}

pub fn home_dir_string() -> String {
    home_dir().to_string_lossy().into_owned()
}

pub fn home_dir_for<F>(os: OsKind, mut env: F) -> PathBuf
where
    F: FnMut(&str) -> Option<String>,
{
    match os {
        OsKind::Windows => {
            if let Some(userprofile) = non_empty(env("USERPROFILE")) {
                return PathBuf::from(userprofile);
            }
            if let (Some(drive), Some(path)) =
                (non_empty(env("HOMEDRIVE")), non_empty(env("HOMEPATH")))
            {
                return PathBuf::from(format!("{drive}{path}"));
            }
            PathBuf::from(r"C:\Users\Default")
        }
        OsKind::Macos => env("HOME")
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("/tmp")),
        OsKind::Unix => env("HOME")
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("/root")),
    }
}

/// The `~/tabtivity` tree: managed projects ([`projects_root`]), the root
/// workspace, boxes, and the project archive.
///
/// `TABTIVITY_HOME` overrides it so a sandboxed dev instance
/// (`start-tabtivity-dev-sandbox.sh`) keeps its projects and boxes
/// symlink farm out of the daily-driver instance's real tree — an instance
/// reconciling those folders against its own (empty) state must not be looking
/// at another instance's folders. Set it together with `TABTIVITY_STATE_DIR`:
/// overriding only one splits a single instance's world across the sandbox and
/// the real data.
pub fn app_home() -> PathBuf {
    app_home_for(|key| std::env::var(key).ok())
}

pub fn app_home_for<F>(env: F) -> PathBuf
where
    F: FnMut(&str) -> Option<String>,
{
    app_home_in(&crate::brand::PAIR, env, &home_dir())
}

/// [`app_home`] for any brand pair and home. The environment override wins
/// (current name, then the old one). Otherwise an install made by an older
/// build keeps its tree under the old name — it holds the user's projects,
/// and moving it is a step of its own that only the user starts — and
/// everything else gets the current name: `~/<current>` if it exists, else
/// `~/<old>` if that exists, else `~/<current>`. A `~/<current>` with no file
/// in it does not win over a `~/<old>` that has files
/// (`brand_migration::resolve_user_tree`): a stray empty folder must not move
/// the root workspace and orphan the root agents' conversations.
pub fn app_home_in<F>(pair: &crate::brand::Pair, env: F, home: &Path) -> PathBuf
where
    F: FnMut(&str) -> Option<String>,
{
    match pair.env_in("HOME", env) {
        Some(dir) => PathBuf::from(dir),
        None => crate::services::brand_migration::resolve_user_tree(
            pair,
            crate::brand::Name::HOME_DIR_NAME,
            home,
            "home-tree",
        ),
    }
}

pub fn projects_root() -> PathBuf {
    app_home().join("projects")
}

/// The default parent for remote (SSH) projects' local mirrors: a top-level
/// `tabtivity/projects-ssh/` sibling of [`projects_root`], rather than a nested
/// `projects/ssh/` subfolder. Keeps synced remote working copies out of the
/// managed-local-projects tree.
pub fn projects_ssh_root() -> PathBuf {
    app_home().join("projects-ssh")
}

pub fn root_work_dir() -> PathBuf {
    app_home().join("root")
}

/// Id of the retired built-in Trash workspace. Kept only so its leftover
/// `projects.json` entry is dropped.
pub const LEGACY_TRASH_PROJECT_ID: &str = concat!(crate::legacy_slug!(), "-trash");

pub fn boxes_root() -> PathBuf {
    app_home().join("boxes")
}

/// Holding area for deleted projects: `~/tabtivity/archive/<id>/`. A deleted
/// project's local folders (and a restore manifest) move here rather than being
/// erased, so it can be restored or permanently cleared from Settings. Only ever
/// emptied manually from the Settings "Archived projects" panel.
pub fn archive_root() -> PathBuf {
    app_home().join("archive")
}

fn non_empty(value: Option<String>) -> Option<String> {
    value.filter(|value| !value.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn env<'a>(values: &'a [(&str, &str)]) -> impl FnMut(&str) -> Option<String> + 'a {
        let map = values.iter().copied().collect::<HashMap<_, _>>();
        move |key| map.get(key).map(|value| (*value).to_string())
    }

    #[test]
    fn windows_home_prefers_userprofile() {
        let home = home_dir_for(
            OsKind::Windows,
            env(&[
                ("USERPROFILE", r"C:\Users\alice"),
                ("HOMEDRIVE", "D:"),
                ("HOMEPATH", r"\Users\bob"),
            ]),
        );
        assert_eq!(home, PathBuf::from(r"C:\Users\alice"));
    }

    #[test]
    fn windows_home_uses_homedrive_and_homepath() {
        let home = home_dir_for(
            OsKind::Windows,
            env(&[("HOMEDRIVE", "D:"), ("HOMEPATH", r"\Users\bob")]),
        );
        assert_eq!(home, PathBuf::from(r"D:\Users\bob"));
    }

    #[test]
    fn windows_home_has_stable_fallback() {
        let home = home_dir_for(OsKind::Windows, env(&[]));
        assert_eq!(home, PathBuf::from(r"C:\Users\Default"));
    }

    #[test]
    fn unix_home_uses_home() {
        let home = home_dir_for(OsKind::Unix, env(&[("HOME", "/home/alice")]));
        assert_eq!(home, PathBuf::from("/home/alice"));
    }

    #[test]
    fn unix_home_falls_back_to_root() {
        let home = home_dir_for(OsKind::Unix, env(&[]));
        assert_eq!(home, PathBuf::from("/root"));
    }

    #[test]
    fn path_finder_is_where_on_windows_which_elsewhere() {
        assert_eq!(path_finder(OsKind::Windows), "where");
        assert_eq!(path_finder(OsKind::Macos), "which");
        assert_eq!(path_finder(OsKind::Unix), "which");
    }

    #[test]
    fn resolve_in_dirs_finds_extensionless_match() {
        let dirs = vec![
            PathBuf::from("/opt/bin"),
            PathBuf::from("/home/a/.local/bin"),
        ];
        let present = PathBuf::from("/home/a/.local/bin/vibe");
        let found = resolve_in_dirs(&dirs, "vibe", &[], &|p| p == present);
        assert_eq!(found, Some(present));
    }

    #[test]
    fn resolve_in_dirs_expands_windows_extensions_in_order() {
        let dirs = vec![PathBuf::from(r"C:\Users\a\.local\bin")];
        // Build the expected path via `join` (as `resolve_in_dirs` does) so the
        // separator is correct on every OS: a hardcoded backslash literal only
        // equals `dir.join(..)` on Windows, so it failed on the Linux CI runner.
        let present = dirs[0].join("vibe.exe");
        let found = resolve_in_dirs(&dirs, "vibe", &["exe", "cmd", "bat"], &|p| p == present);
        assert_eq!(found, Some(present));
    }

    #[test]
    fn resolve_in_dirs_returns_none_when_absent() {
        let dirs = vec![PathBuf::from("/opt/bin")];
        let found = resolve_in_dirs(&dirs, "nope", &["exe"], &|_| false);
        assert_eq!(found, None);
    }

    #[test]
    fn parse_node_version_reads_node_and_nvm_spellings() {
        assert_eq!(parse_node_version("v22.22.1\n"), Some((22, 22, 1)));
        assert_eq!(parse_node_version("24.19.0"), Some((24, 19, 0)));
        assert_eq!(parse_node_version("24"), Some((24, 0, 0)));
        assert_eq!(parse_node_version("lts/*"), None);
        assert_eq!(parse_node_version("node"), None);
    }

    #[test]
    fn nvm_default_alias_resolution() {
        let installed: Vec<String> = ["v20.11.0", "v22.22.2", "v24.9.0", "v24.19.0"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let aliases = |name: &str| match name {
            "lts/*" => Some("lts/jod".to_string()),
            "lts/jod" => Some("v22.22.2".to_string()),
            _ => None,
        };
        let pick = |default: Option<&str>| resolve_nvm_version(default, &aliases, &installed);
        // A major prefix takes the newest install of that line (numerically).
        assert_eq!(pick(Some("24")).as_deref(), Some("v24.19.0"));
        assert_eq!(pick(Some("v20.11.0")).as_deref(), Some("v20.11.0"));
        // Aliases chain through nvm's alias files.
        assert_eq!(pick(Some("lts/*")).as_deref(), Some("v22.22.2"));
        // No alias, or one naming nothing installed → the newest install.
        assert_eq!(pick(None).as_deref(), Some("v24.19.0"));
        assert_eq!(pick(Some("node")).as_deref(), Some("v24.19.0"));
        assert_eq!(pick(Some("18")).as_deref(), Some("v24.19.0"));
        // `system` means the OS Node: nvm contributes nothing.
        assert_eq!(pick(Some("system")), None);
        assert_eq!(resolve_nvm_version(None, &aliases, &[]), None);
    }

    #[test]
    fn supplemental_paths_cover_all_supported_os_families() {
        let home = Path::new("/home/alice");
        let unix = supplemental_path_dirs_for(OsKind::Unix, home, None, None, None);
        assert!(unix.contains(&home.join(".local/bin")));
        assert!(unix.contains(&home.join(".cargo/bin")));
        assert!(unix.contains(&home.join(".opencode/bin")));
        assert!(unix.contains(&home.join(".openclaw/bin")));

        let mac = supplemental_path_dirs_for(OsKind::Macos, home, None, None, None);
        assert!(mac.contains(&PathBuf::from("/opt/homebrew/bin")));
        assert!(mac.contains(&PathBuf::from("/Library/TeX/texbin")));
        assert!(mac.contains(&home.join(".docker").join("bin")));
        assert!(mac.contains(&home.join(".orbstack").join("bin")));
        assert!(mac.contains(&PathBuf::from("/Applications/Docker.app/Contents/Resources/bin")));
        // The container dirs are the Mac's alone: Linux keeps its list unchanged.
        assert!(!unix.contains(&home.join(".docker").join("bin")));
        assert!(!unix.contains(&home.join(".orbstack").join("bin")));

        let windows = supplemental_path_dirs_for(
            OsKind::Windows,
            Path::new(r"C:\Users\alice"),
            Some(OsStr::new(r"C:\Users\alice\AppData\Local")),
            Some(OsStr::new(r"C:\Users\alice\AppData\Roaming")),
            Some(OsStr::new(r"C:\Program Files")),
        );
        assert!(windows
            .iter()
            .any(|path| path.ends_with(Path::new("Microsoft/WindowsApps"))));
        assert!(windows.iter().any(|path| path.ends_with(Path::new("npm"))));
        assert!(windows
            .iter()
            .any(|path| path.ends_with(Path::new("Programs/Ollama"))));
        assert!(windows
            .iter()
            .any(|path| path.ends_with(Path::new("Programs/MiKTeX/miktex/bin/x64"))));
        assert!(windows
            .iter()
            .any(|path| path.ends_with(Path::new("Programs/OpenAI/Codex/bin"))));
        assert!(windows.iter().any(|path| {
            path.starts_with(r"C:\Program Files")
                && path.ends_with(Path::new("MiKTeX/miktex/bin/x64"))
        }));
    }

    #[test]
    fn windows_resolution_honors_pathext() {
        let dir = PathBuf::from("tools");
        for (ext, expected) in [
            ("EXE", "fmt.exe"),
            ("CMD", "fmt.cmd"),
            ("BAT", "fmt.bat"),
            ("PS1", "fmt.ps1"),
        ] {
            let present = dir.join(expected);
            let pathext = format!(".{ext}");
            let found = resolve_executable_in_dirs(
                OsKind::Windows,
                std::slice::from_ref(&dir),
                "fmt",
                Some(OsStr::new(&pathext)),
                &|path| path == present,
            );
            assert_eq!(found, Some(present));
        }
        let script = dir.join("fmt.ps1");
        let found = resolve_executable_in_dirs(
            OsKind::Windows,
            std::slice::from_ref(&dir),
            "fmt",
            Some(OsStr::new(".EXE;.CMD")),
            &|path| path == script,
        );
        assert_eq!(found, Some(script));
    }

    #[test]
    fn windows_scripts_dispatch_through_their_interpreters() {
        let cmd = command_for_program_for(OsKind::Windows, Path::new(r"C:\tools\fmt.cmd"));
        assert_eq!(cmd.get_program(), "cmd.exe");
        assert!(cmd
            .get_args()
            .any(|arg| arg == OsStr::new(r"C:\tools\fmt.cmd")));

        let ps = command_for_program_for(OsKind::Windows, Path::new(r"C:\tools\fmt.ps1"));
        assert_eq!(ps.get_program(), "powershell.exe");
        assert!(ps
            .get_args()
            .any(|arg| arg == OsStr::new(r"C:\tools\fmt.ps1")));

        let exe = command_for_program_for(OsKind::Windows, Path::new(r"C:\tools\fmt.exe"));
        assert_eq!(exe.get_program(), OsStr::new(r"C:\tools\fmt.exe"));
    }

    #[cfg(unix)]
    #[test]
    fn fire_and_forget_children_are_reaped() {
        let mut cmd = command_no_window("sh");
        cmd.args(["-c", "exit 0"]);
        let pid = spawn_reaped(cmd).expect("spawn");
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while std::time::Instant::now() < deadline {
            let result =
                unsafe { libc::waitpid(pid as libc::pid_t, std::ptr::null_mut(), libc::WNOHANG) };
            if result == -1 {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        panic!("background waiter did not reap pid {pid}");
    }

    #[test]
    fn cross_device_is_recognized_by_kind_on_every_os() {
        let e = std::io::Error::from(std::io::ErrorKind::CrossesDevices);
        assert!(is_cross_device(&e));
        let denied = std::io::Error::from(std::io::ErrorKind::PermissionDenied);
        assert!(!is_cross_device(&denied));
    }

    #[cfg(unix)]
    #[test]
    fn cross_device_raw_codes_on_unix() {
        // EXDEV.
        assert!(is_cross_device(&std::io::Error::from_raw_os_error(18)));
        // EEXIST — the code Windows uses for ERROR_NOT_SAME_DEVICE. Treating it as
        // cross-device here would copy over an existing destination.
        assert!(!is_cross_device(&std::io::Error::from_raw_os_error(17)));
        // ENOTEMPTY / EACCES.
        assert!(!is_cross_device(&std::io::Error::from_raw_os_error(39)));
        assert!(!is_cross_device(&std::io::Error::from_raw_os_error(13)));
    }

    #[cfg(windows)]
    #[test]
    fn cross_device_raw_codes_on_windows() {
        let not_same_device = std::io::Error::from_raw_os_error(17);
        assert!(is_cross_device(&not_same_device));
        // Checks std's own mapping on the windows-latest job.
        assert_eq!(not_same_device.kind(), std::io::ErrorKind::CrossesDevices);
        // ERROR_SHARING_VIOLATION: a file inside is open — must surface.
        assert!(!is_cross_device(&std::io::Error::from_raw_os_error(32)));
    }

    #[test]
    fn resolve_offpath_binary_ignores_qualified_names() {
        // A name carrying a path separator is already explicit — leave it alone.
        assert_eq!(resolve_offpath_binary("/usr/bin/vibe"), None);
        assert_eq!(resolve_offpath_binary(r"C:\tools\vibe.exe"), None);
        assert_eq!(resolve_offpath_binary(""), None);
    }

    /// #861: a helper planted in a user-writable dir listed first never wins
    /// over the trusted system copy, and a qualified name is not looked up.
    #[test]
    fn a_planted_user_helper_never_shadows_the_system_copy() {
        let tmp = tempfile::tempdir().unwrap();
        let user = tmp.path().join("home/.local/bin");
        let system = tmp.path().join("usr/bin");
        for dir in [&user, &system] {
            std::fs::create_dir_all(dir).unwrap();
            std::fs::write(dir.join("git"), "#!/bin/sh\n").unwrap();
        }
        let trusted = |p: &Path| p.starts_with(&system) && p.is_file();
        let dirs = [user.clone(), system.clone()];
        assert_eq!(first_trusted_in(&dirs, "git", &trusted), Some(system.join("git")));
        assert_eq!(first_trusted_in(&dirs, "bwrap", &trusted), None);
        assert_eq!(first_trusted_in(&dirs, "../usr/bin/git", &trusted), None);
        assert_eq!(first_trusted_in(&dirs, "", &trusted), None);
    }

    #[test]
    fn windows_helpers_are_looked_up_in_the_admin_dirs_in_order() {
        let pf = Path::new(r"C:\Program Files");
        let sys = Path::new(r"C:\Windows").join("System32");
        assert_eq!(
            windows_system_bin_dirs(Some(OsStr::new(r"C:\Program Files")), Some(OsStr::new(r"C:\Windows"))),
            vec![
                pf.join("Git").join("cmd"),
                pf.join("Git").join("bin"),
                sys.join("OpenSSH"),
                sys.join("WindowsPowerShell").join("v1.0"),
                sys.clone(),
            ]
        );
        // An unset or empty variable drops its dirs; it never means "here".
        assert_eq!(windows_system_bin_dirs(None, Some(OsStr::new(""))), Vec::<PathBuf>::new());
        assert_eq!(windows_system_bin_dirs(Some(OsStr::new("")), Some(OsStr::new(r"C:\Windows"))).len(), 3);
    }

    #[cfg(unix)]
    #[test]
    fn helpers_come_from_root_owned_system_dirs_only() {
        use std::os::unix::fs::MetadataExt;
        // Not a helper: left to the ordinary PATH lookup.
        assert_eq!(helper_program(OsStr::new("claude")), None);
        assert_eq!(helper_program(OsStr::new("/usr/bin/git")), None);
        // A file this (non-root) user owns is never trusted, wherever it sits.
        let tmp = tempfile::tempdir().unwrap();
        let planted = tmp.path().join("git");
        std::fs::write(&planted, "#!/bin/sh\n").unwrap();
        if std::fs::metadata(&planted).unwrap().uid() != 0 {
            assert!(!root_owned_file(&planted));
        }
        // Whatever the host has: a hit is under a system dir, never home, and
        // the spawned program is that absolute path.
        for bin in TRUSTED_HELPERS.iter().chain(&["bwrap"]) {
            if let Some(found) = system_executable(bin) {
                assert!(SYSTEM_BIN_DIRS.iter().any(|d| found.starts_with(d)), "{found:?}");
                assert!(!found.starts_with(home_dir()), "{found:?}");
                if TRUSTED_HELPERS.contains(bin) {
                    assert_eq!(command_no_window(bin).get_program(), found.as_os_str());
                }
            }
        }
    }

    #[test]
    fn app_home_for_honors_override() {
        let dir = app_home_for(|key| {
            (key == crate::app_env!("HOME")).then(|| concat!("/tmp/", crate::app_slug!(), "-sandbox").to_string())
        });
        assert_eq!(dir, PathBuf::from(concat!("/tmp/", crate::app_slug!(), "-sandbox")));
    }

    /// The leaf this machine's home tree has: the current name, or the old
    /// one where an install made before the rename still keeps its tree there
    /// (the resolution rule itself is tested on a temp home below).
    fn home_tree_leaf() -> String {
        let tree = app_home_in(&crate::brand::PAIR, |_| None, &home_dir());
        let leaf = tree.file_name().and_then(|n| n.to_str()).unwrap_or("").to_string();
        assert!(leaf == crate::brand::HOME_DIR_NAME || leaf == crate::brand::LEGACY_HOME_DIR_NAME, "{tree:?}");
        leaf
    }

    #[test]
    fn app_home_for_ignores_empty_override() {
        // An empty override means unset, same as the state dir's rule.
        let dir = app_home_for(|key| (key == crate::app_env!("HOME")).then(String::new));
        assert_eq!(dir, home_dir().join(home_tree_leaf()));
    }

    /// A fresh machine gets the tree under the current name; an install made
    /// under the old name keeps its tree where it is (moving the user's
    /// projects is a step only the user starts); once both exist the current
    /// one wins unless it holds no file and the old one does; and the old
    /// variable still redirects it.
    #[test]
    fn the_home_tree_is_the_current_name_unless_only_the_old_one_exists() {
        let pair = crate::brand::PAIR;
        let home = tempfile::tempdir().unwrap();
        let current = home.path().join(crate::brand::HOME_DIR_NAME);
        assert_eq!(app_home_in(&pair, |_| None, home.path()), current);
        if !pair.renamed() {
            return;
        }
        let old = home.path().join(crate::brand::LEGACY_HOME_DIR_NAME);
        std::fs::create_dir(&old).unwrap();
        assert_eq!(app_home_in(&pair, |_| None, home.path()), old);
        std::fs::create_dir(&current).unwrap();
        assert_eq!(app_home_in(&pair, |_| None, home.path()), current);
        // A fileless current tree (a stray `mkdir`, an empty `root/`, a box
        // farm's symlink) loses to an old tree with the user's files in it.
        std::fs::create_dir_all(old.join("projects").join("p")).unwrap();
        std::fs::write(old.join("projects").join("p").join("notes.md"), "x").unwrap();
        std::fs::create_dir_all(current.join("root")).unwrap();
        std::fs::create_dir_all(current.join("boxes")).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(old.join("projects").join("p").join("notes.md"), current.join("boxes").join("p")).unwrap();
        assert_eq!(app_home_in(&pair, |_| None, home.path()), old);
        // One real file in it and the current tree wins again.
        std::fs::write(current.join("root").join("todo.txt"), "x").unwrap();
        assert_eq!(app_home_in(&pair, |_| None, home.path()), current);
        let old_var = crate::brand::LEGACY.env_name("HOME");
        assert_eq!(
            app_home_in(&pair, |key| (key == old_var).then(|| "/elsewhere".to_string()), home.path()),
            PathBuf::from("/elsewhere")
        );
    }

    #[test]
    fn boxes_root_ends_with_boxes_under_app() {
        let dir = boxes_root();
        let last = dir.file_name().and_then(|n| n.to_str()).unwrap_or("");
        assert_eq!(last, "boxes", "boxes_root must end in 'boxes': {dir:?}");
        let parent = dir
            .parent()
            .and_then(|p| p.file_name())
            .and_then(|n| n.to_str())
            .unwrap_or("");
        assert_eq!(parent, home_tree_leaf(), "boxes_root sits in the home tree");
    }

    #[test]
    fn archive_root_ends_with_archive_under_app() {
        let dir = archive_root();
        let last = dir.file_name().and_then(|n| n.to_str()).unwrap_or("");
        assert_eq!(
            last, "archive",
            "archive_root must end in 'archive': {dir:?}"
        );
        let parent = dir
            .parent()
            .and_then(|p| p.file_name())
            .and_then(|n| n.to_str())
            .unwrap_or("");
        assert_eq!(parent, home_tree_leaf(), "archive_root sits in the home tree");
    }
}
