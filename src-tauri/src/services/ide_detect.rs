//! Which IDE a project belongs to, read off the footprint the IDE left in its
//! tree — `.idea/` (JetBrains), `.vs/` + `*.sln` (Visual Studio), `.vscode/` /
//! `*.code-workspace` (VS Code) — and which installed program opens it.
//!
//! Two halves, both `AppHandle`-free and pure over their inputs:
//!
//! - [`detect`] lists the IDEs a directory carries markers for. It reads only
//!   marker *names* plus one attribute (`type=` of an `.iml`) to tell the
//!   JetBrains products apart. Nothing in the tree ever names the program that
//!   runs: the tree is attacker-controlled (a fenced agent, a container tab, a
//!   `git pull` all write it), and an exec taken from it would launch on the
//!   host, unfenced, at the next click.
//! - [`resolve_launcher`] finds that program from the user's own override in
//!   `settings.json`, the `PATH`, JetBrains Toolbox's shell scripts, the
//!   installed-app list (`commands::apps::list_installed_apps`) and, on
//!   Windows, `vswhere`. The caller supplies the override map and the installed
//!   list so the resolution order is unit-testable on any OS.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::commands::apps::InstalledApp;

/// The IDEs Tabtivity can tell apart. `id()` is the stable string the frontend
/// and `settings.ide_launchers` key on, and what the enum serializes as.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum IdeId {
    PyCharm,
    CLion,
    WebStorm,
    Rider,
    RustRover,
    GoLand,
    Idea,
    VisualStudio,
    VsCode,
}

impl Serialize for IdeId {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.id())
    }
}

pub const FAMILY_JETBRAINS: &str = "jetbrains";
pub const FAMILY_VISUAL_STUDIO: &str = "visual_studio";
pub const FAMILY_VSCODE: &str = "vscode";

impl IdeId {
    pub const ALL: [IdeId; 9] = [
        IdeId::PyCharm,
        IdeId::CLion,
        IdeId::WebStorm,
        IdeId::Rider,
        IdeId::RustRover,
        IdeId::GoLand,
        IdeId::Idea,
        IdeId::VisualStudio,
        IdeId::VsCode,
    ];

    pub fn id(self) -> &'static str {
        match self {
            IdeId::PyCharm => "pycharm",
            IdeId::CLion => "clion",
            IdeId::WebStorm => "webstorm",
            IdeId::Rider => "rider",
            IdeId::RustRover => "rustrover",
            IdeId::GoLand => "goland",
            IdeId::Idea => "idea",
            IdeId::VisualStudio => "visual_studio",
            IdeId::VsCode => "vscode",
        }
    }

    pub fn parse(id: &str) -> Option<IdeId> {
        IdeId::ALL.into_iter().find(|ide| ide.id() == id)
    }

    /// The product name shown when no installed entry supplies a better one.
    pub fn label(self) -> &'static str {
        match self {
            IdeId::PyCharm => "PyCharm",
            IdeId::CLion => "CLion",
            IdeId::WebStorm => "WebStorm",
            IdeId::Rider => "Rider",
            IdeId::RustRover => "RustRover",
            IdeId::GoLand => "GoLand",
            IdeId::Idea => "IntelliJ IDEA",
            IdeId::VisualStudio => "Visual Studio",
            IdeId::VsCode => "Visual Studio Code",
        }
    }

    pub fn family(self) -> &'static str {
        match self {
            IdeId::VisualStudio => FAMILY_VISUAL_STUDIO,
            IdeId::VsCode => FAMILY_VSCODE,
            _ => FAMILY_JETBRAINS,
        }
    }

    /// Can this IDE be handed a `.sln` as the thing to open? Everything else
    /// gets the project directory when it stands in for a solution IDE.
    fn opens_solutions(self) -> bool {
        matches!(self, IdeId::VisualStudio | IdeId::Rider)
    }

    /// Program names looked up on `PATH` and in the Toolbox scripts dir, most
    /// specific first. Snap exports (`/snap/bin/pycharm-professional`) and
    /// Toolbox's generated scripts both land here.
    fn path_candidates(self) -> &'static [&'static str] {
        match self {
            IdeId::PyCharm => &["pycharm", "pycharm-professional", "pycharm-community", "charm"],
            IdeId::CLion => &["clion"],
            IdeId::WebStorm => &["webstorm"],
            IdeId::Rider => &["rider"],
            IdeId::RustRover => &["rustrover"],
            IdeId::GoLand => &["goland"],
            IdeId::Idea => &["idea", "intellij-idea-ultimate", "intellij-idea-community"],
            IdeId::VisualStudio => &["devenv"],
            IdeId::VsCode => &["code", "code-insiders", "codium", "code-oss", "cursor"],
        }
    }

    /// Lower-case substrings that identify an installed-app entry (desktop
    /// file `Name=`, Start-Menu shortcut name, macOS bundle name, or the exec's
    /// basename: `jetbrains-pycharm`, `com.jetbrains.PyCharm-Professional`,
    /// `Code.exe`).
    fn installed_name_patterns(self) -> &'static [&'static str] {
        match self {
            IdeId::PyCharm => &["pycharm"],
            IdeId::CLion => &["clion"],
            IdeId::WebStorm => &["webstorm"],
            IdeId::Rider => &["jetbrains rider", "jetbrains-rider", "com.jetbrains.rider", "rider.sh"],
            IdeId::RustRover => &["rustrover"],
            IdeId::GoLand => &["goland"],
            IdeId::Idea => &["intellij", "jetbrains-idea", "idea.sh"],
            IdeId::VisualStudio => &["devenv"],
            IdeId::VsCode => &["visual studio code", "com.visualstudio.code", "code - oss", "vscodium", "cursor"],
        }
    }

    /// Exact exec basenames (extension stripped, lower-case) that identify an
    /// installed entry when the name does not — `code` alone would otherwise
    /// need a substring loose enough to match Xcode.
    fn installed_exec_basenames(self) -> &'static [&'static str] {
        match self {
            IdeId::VsCode => &["code", "code-insiders", "codium", "code-oss", "cursor"],
            IdeId::VisualStudio => &["devenv"],
            IdeId::Idea => &["idea"],
            // `Rider.app` on macOS: the bundle name is the bare word, which no
            // substring pattern can claim without also claiming "Glider".
            IdeId::Rider => &["rider"],
            _ => &[],
        }
    }

    /// Which other IDE may open this one's project when it is not installed:
    /// any JetBrains project opens in IDEA (Ultimate carries every language
    /// plugin), a Visual Studio solution opens in Rider, and failing that in VS
    /// Code (on the folder — see [`IdeId::opens_solutions`]).
    fn fallbacks(self) -> &'static [IdeId] {
        match self {
            IdeId::Idea | IdeId::VsCode => &[],
            IdeId::VisualStudio => &[IdeId::Rider, IdeId::VsCode],
            _ => &[IdeId::Idea],
        }
    }
}

/// One IDE a directory carries a marker for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Detected {
    pub ide: IdeId,
    /// The marker that identified it, relative to the project dir (`.idea`,
    /// `.vscode`, `App.sln`).
    pub marker: PathBuf,
    /// What the IDE is handed: the directory, or the one `.sln` /
    /// `.code-workspace` when exactly one exists.
    pub target: PathBuf,
}

/// Snapshot of the top-level names detection looks at, so the rules below
/// read as rules and the directory is listed once.
#[derive(Default)]
struct TopLevel {
    idea: bool,
    vs: bool,
    vscode: bool,
    cmake: bool,
    cargo: bool,
    go_mod: bool,
    solutions: Vec<PathBuf>,
    workspaces: Vec<PathBuf>,
    imls: Vec<PathBuf>,
}

fn scan_top_level(dir: &Path) -> TopLevel {
    let mut top = TopLevel::default();
    let Ok(entries) = fs::read_dir(dir) else {
        return top;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        let is_dir = path.is_dir();
        match name.as_str() {
            ".idea" if is_dir => top.idea = true,
            ".vs" if is_dir => top.vs = true,
            ".vscode" if is_dir => top.vscode = true,
            "CMakeLists.txt" if !is_dir => top.cmake = true,
            "Cargo.toml" if !is_dir => top.cargo = true,
            "go.mod" if !is_dir => top.go_mod = true,
            _ => {}
        }
        if is_dir {
            continue;
        }
        let ext = path
            .extension()
            .map(|e| e.to_string_lossy().to_ascii_lowercase())
            .unwrap_or_default();
        match ext.as_str() {
            "sln" | "slnx" => top.solutions.push(path),
            "code-workspace" => top.workspaces.push(path),
            "iml" => top.imls.push(path),
            _ => {}
        }
    }
    top.solutions.sort();
    top.workspaces.sort();
    top
}

/// The `type="…"` of the first `<module …>` tag in an `.iml`, upper-cased.
fn iml_module_type(path: &Path) -> Option<String> {
    let text = fs::read_to_string(path).ok()?;
    let module = text.find("<module")?;
    let rest = &text[module..];
    let end = rest.find('>').unwrap_or(rest.len());
    let tag = &rest[..end];
    let idx = tag.find("type=\"")? + "type=\"".len();
    let value = &tag[idx..];
    let close = value.find('"')?;
    Some(value[..close].trim().to_ascii_uppercase())
}

/// Which JetBrains product a `.idea/` belongs to. The `.iml` module type is
/// the IDE's own word and wins; the build files are a hint for layouts that
/// carry no `.iml` (recent PyCharm/IDEA versions), and IDEA is the default.
fn jetbrains_product(dir: &Path, top: &TopLevel) -> IdeId {
    let rider_layout = fs::read_dir(dir.join(".idea"))
        .map(|entries| {
            entries.flatten().any(|e| {
                e.file_name().to_string_lossy().starts_with(".idea.") && e.path().is_dir()
            })
        })
        .unwrap_or(false);
    if rider_layout || !top.solutions.is_empty() {
        return IdeId::Rider;
    }
    let mut imls: Vec<PathBuf> = top.imls.clone();
    if let Ok(entries) = fs::read_dir(dir.join(".idea")) {
        imls.extend(
            entries
                .flatten()
                .map(|e| e.path())
                .filter(|p| p.extension().is_some_and(|e| e.eq_ignore_ascii_case("iml"))),
        );
    }
    imls.sort();
    for iml in &imls {
        match iml_module_type(iml).as_deref() {
            Some("PYTHON_MODULE") => return IdeId::PyCharm,
            Some("CPP_MODULE") => return IdeId::CLion,
            Some("WEB_MODULE") => return IdeId::WebStorm,
            Some("GO_MODULE") => return IdeId::GoLand,
            _ => {}
        }
    }
    if top.cmake {
        IdeId::CLion
    } else if top.cargo {
        IdeId::RustRover
    } else if top.go_mod {
        IdeId::GoLand
    } else {
        IdeId::Idea
    }
}

/// The IDEs `dir` carries markers for, in a fixed order (JetBrains, Visual
/// Studio, VS Code). Empty when nothing is recognised or `dir` is unreadable.
pub fn detect(dir: &Path) -> Vec<Detected> {
    let top = scan_top_level(dir);
    let single = |files: &[PathBuf]| -> Option<PathBuf> {
        match files {
            [one] => Some(one.clone()),
            _ => None,
        }
    };
    let mut found = Vec::new();
    if top.idea {
        let ide = jetbrains_product(dir, &top);
        let target = if ide == IdeId::Rider {
            single(&top.solutions).unwrap_or_else(|| dir.to_path_buf())
        } else {
            dir.to_path_buf()
        };
        found.push(Detected {
            ide,
            marker: PathBuf::from(".idea"),
            target,
        });
    }
    if top.vs || !top.solutions.is_empty() {
        let marker = if top.vs {
            PathBuf::from(".vs")
        } else {
            top.solutions[0]
                .file_name()
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from(".vs"))
        };
        found.push(Detected {
            ide: IdeId::VisualStudio,
            marker,
            target: single(&top.solutions).unwrap_or_else(|| dir.to_path_buf()),
        });
    }
    if top.vscode || !top.workspaces.is_empty() {
        let marker = if top.vscode {
            PathBuf::from(".vscode")
        } else {
            top.workspaces[0]
                .file_name()
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from(".vscode"))
        };
        found.push(Detected {
            ide: IdeId::VsCode,
            marker,
            target: single(&top.workspaces).unwrap_or_else(|| dir.to_path_buf()),
        });
    }
    found
}

// ── Launcher resolution ────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LauncherSource {
    /// `settings.ide_launchers[id]`.
    Override,
    /// Found on `PATH`.
    Path,
    /// A JetBrains Toolbox shell script.
    Toolbox,
    /// An installed-app entry (desktop file / Start-Menu shortcut / bundle).
    Installed,
    /// `vswhere.exe` (Windows, Visual Studio only).
    Vswhere,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Launcher {
    /// The IDE this program is — the detected one, or the fallback that stands
    /// in for it.
    pub ide: IdeId,
    pub exec: String,
    pub display_name: String,
    pub source: LauncherSource,
}

impl Launcher {
    /// What to hand this launcher for a detection: its own target when the
    /// launcher *is* the detected IDE (or both take solutions), else the
    /// directory — VS Code standing in for Visual Studio must not be handed a
    /// `.sln` it would open as a text file.
    pub fn target_for(&self, detected: &Detected, dir: &Path) -> PathBuf {
        if self.ide == detected.ide || (self.ide.opens_solutions() && detected.ide.opens_solutions()) {
            detected.target.clone()
        } else {
            dir.to_path_buf()
        }
    }
}

/// Where the resolver looks besides the override map and the installed list.
/// Real lookups go through [`HostProbe::real`]; tests supply a closed world.
pub struct HostProbe<'a> {
    /// The absolute path of `name` on `PATH`, if any.
    pub on_path: &'a dyn Fn(&str) -> Option<PathBuf>,
    /// The JetBrains Toolbox scripts directory, if it exists.
    pub toolbox_scripts: Option<PathBuf>,
    /// `vswhere`'s answer for the newest Visual Studio (`devenv.exe`).
    pub vswhere: &'a dyn Fn() -> Option<PathBuf>,
}

impl HostProbe<'static> {
    pub fn real() -> HostProbe<'static> {
        HostProbe {
            on_path: &find_on_path,
            toolbox_scripts: toolbox_scripts_dir().filter(|d| d.is_dir()),
            vswhere: &vswhere_devenv,
        }
    }
}

/// The program that opens `ide`'s projects, or the first installed fallback's.
/// Order per IDE: override, `PATH`, Toolbox, installed list, `vswhere`.
pub fn resolve_launcher(
    ide: IdeId,
    overrides: &HashMap<String, String>,
    installed: &[InstalledApp],
    probe: &HostProbe<'_>,
) -> Option<Launcher> {
    std::iter::once(ide)
        .chain(ide.fallbacks().iter().copied())
        .find_map(|candidate| resolve_one(candidate, overrides, installed, probe))
}

fn resolve_one(
    ide: IdeId,
    overrides: &HashMap<String, String>,
    installed: &[InstalledApp],
    probe: &HostProbe<'_>,
) -> Option<Launcher> {
    if let Some(exec) = overrides.get(ide.id()).map(|s| s.trim()).filter(|s| !s.is_empty()) {
        return Some(Launcher {
            ide,
            exec: exec.to_string(),
            display_name: ide.label().to_string(),
            source: LauncherSource::Override,
        });
    }
    for name in ide.path_candidates() {
        if let Some(path) = (probe.on_path)(name) {
            return Some(Launcher {
                ide,
                exec: path.to_string_lossy().into_owned(),
                display_name: ide.label().to_string(),
                source: LauncherSource::Path,
            });
        }
    }
    if let Some(scripts) = &probe.toolbox_scripts {
        for name in ide.path_candidates() {
            if let Some(path) = script_in(scripts, name) {
                return Some(Launcher {
                    ide,
                    exec: path.to_string_lossy().into_owned(),
                    display_name: ide.label().to_string(),
                    source: LauncherSource::Toolbox,
                });
            }
        }
    }
    if let Some(app) = pick_installed(ide, installed) {
        return Some(Launcher {
            ide,
            exec: app.exec.clone(),
            display_name: app.name.clone(),
            source: LauncherSource::Installed,
        });
    }
    if ide == IdeId::VisualStudio {
        if let Some(devenv) = (probe.vswhere)() {
            return Some(Launcher {
                ide,
                exec: devenv.to_string_lossy().into_owned(),
                display_name: ide.label().to_string(),
                source: LauncherSource::Vswhere,
            });
        }
    }
    None
}

/// Program-name lookup against the installed-app list. Pure, so the patterns
/// are tested with hand-written entries on any OS.
pub fn pick_installed(ide: IdeId, installed: &[InstalledApp]) -> Option<&InstalledApp> {
    installed.iter().find(|app| installed_matches(ide, app))
}

fn installed_matches(ide: IdeId, app: &InstalledApp) -> bool {
    let name = app.name.to_lowercase();
    let exec = app.exec.to_lowercase();
    // The program token of a multi-word exec (`flatpak run … com.jetbrains.X`
    // ends in the app id; `/opt/pycharm/bin/pycharm.sh` in the script).
    let last = exec.split_whitespace().last().unwrap_or("");
    let basename = Path::new(last)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let stem = Path::new(&basename)
        .file_stem()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    if ide.installed_exec_basenames().contains(&stem.as_str()) {
        return true;
    }
    ide.installed_name_patterns()
        .iter()
        .any(|p| name.contains(p) || basename.contains(p) || last.contains(p))
}

fn find_on_path(name: &str) -> Option<PathBuf> {
    let path_var = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path_var) {
        if let Some(found) = script_in(&dir, name) {
            return Some(found);
        }
    }
    None
}

/// `dir/name` when it is a file — with the Windows launcher extensions tried
/// too (`code.cmd`, `pycharm.cmd`, `devenv.exe`).
fn script_in(dir: &Path, name: &str) -> Option<PathBuf> {
    let exact = dir.join(name);
    if exact.is_file() {
        return Some(exact);
    }
    if cfg!(windows) {
        for ext in ["exe", "cmd", "bat"] {
            let candidate = dir.join(format!("{name}.{ext}"));
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

fn toolbox_scripts_dir() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        std::env::var_os("LOCALAPPDATA")
            .map(|d| PathBuf::from(d).join("JetBrains").join("Toolbox").join("scripts"))
    }
    #[cfg(target_os = "macos")]
    {
        Some(
            crate::paths::home_dir()
                .join("Library")
                .join("Application Support")
                .join("JetBrains")
                .join("Toolbox")
                .join("scripts"),
        )
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let data_home = std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .filter(|p| p.is_absolute())
            .unwrap_or_else(|| crate::paths::home_dir().join(".local").join("share"));
        Some(data_home.join("JetBrains").join("Toolbox").join("scripts"))
    }
}

/// `vswhere.exe -latest -property productPath` → the newest `devenv.exe`.
/// Windows only; every other OS answers `None` without spawning anything.
fn vswhere_devenv() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        let base = std::env::var_os("ProgramFiles(x86)")
            .or_else(|| std::env::var_os("ProgramFiles"))?;
        let vswhere = PathBuf::from(base)
            .join("Microsoft Visual Studio")
            .join("Installer")
            .join("vswhere.exe");
        if !vswhere.is_file() {
            return None;
        }
        let out = crate::paths::command_no_window(&vswhere)
            .args(["-latest", "-products", "*", "-property", "productPath"])
            .output()
            .ok()?;
        let line = String::from_utf8_lossy(&out.stdout)
            .lines()
            .map(str::trim)
            .find(|l| !l.is_empty())?
            .to_string();
        let path = PathBuf::from(line);
        path.is_file().then_some(path)
    }
    #[cfg(not(target_os = "windows"))]
    {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn project() -> TempDir {
        TempDir::new().unwrap()
    }

    fn touch(dir: &Path, rel: &str, body: &str) {
        let path = dir.join(rel);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, body).unwrap();
    }

    fn ids(found: &[Detected]) -> Vec<IdeId> {
        found.iter().map(|d| d.ide).collect()
    }

    #[test]
    fn nothing_detected_in_a_plain_tree() {
        let p = project();
        touch(p.path(), "src/main.rs", "");
        touch(p.path(), "Cargo.toml", "");
        assert!(detect(p.path()).is_empty());
        assert!(detect(&p.path().join("missing")).is_empty());
    }

    #[test]
    fn idea_products_from_the_iml_module_type() {
        for (module_type, ide) in [
            ("PYTHON_MODULE", IdeId::PyCharm),
            ("CPP_MODULE", IdeId::CLion),
            ("WEB_MODULE", IdeId::WebStorm),
            ("GO_MODULE", IdeId::GoLand),
            ("JAVA_MODULE", IdeId::Idea),
        ] {
            let p = project();
            touch(
                p.path(),
                ".idea/app.iml",
                &format!("<?xml version=\"1.0\"?>\n<module type=\"{module_type}\" version=\"4\">\n</module>"),
            );
            let found = detect(p.path());
            assert_eq!(ids(&found), vec![ide], "{module_type}");
            assert_eq!(found[0].marker, PathBuf::from(".idea"));
            assert_eq!(found[0].target, p.path());
        }
    }

    #[test]
    fn iml_type_outranks_build_file_hints() {
        let p = project();
        touch(p.path(), ".idea/app.iml", "<module type=\"PYTHON_MODULE\" />");
        touch(p.path(), "Cargo.toml", "");
        assert_eq!(ids(&detect(p.path())), vec![IdeId::PyCharm]);
    }

    #[test]
    fn idea_without_an_iml_reads_the_build_files_then_defaults_to_idea() {
        let cases: [(&[&str], IdeId); 4] = [
            (&["CMakeLists.txt"], IdeId::CLion),
            (&["Cargo.toml"], IdeId::RustRover),
            (&["go.mod"], IdeId::GoLand),
            (&["pom.xml"], IdeId::Idea),
        ];
        for (files, ide) in cases {
            let p = project();
            fs::create_dir(p.path().join(".idea")).unwrap();
            for f in files {
                touch(p.path(), f, "");
            }
            assert_eq!(ids(&detect(p.path())), vec![ide], "{files:?}");
        }
    }

    #[test]
    fn a_root_level_iml_counts_too() {
        let p = project();
        fs::create_dir(p.path().join(".idea")).unwrap();
        touch(p.path(), "app.iml", "<module type=\"WEB_MODULE\">");
        assert_eq!(ids(&detect(p.path())), vec![IdeId::WebStorm]);
    }

    #[test]
    fn rider_layout_and_a_solution_both_mean_rider() {
        let p = project();
        fs::create_dir_all(p.path().join(".idea/.idea.App/.idea")).unwrap();
        assert_eq!(ids(&detect(p.path())), vec![IdeId::Rider]);

        let p = project();
        fs::create_dir(p.path().join(".idea")).unwrap();
        touch(p.path(), "App.sln", "");
        let found = detect(p.path());
        assert_eq!(ids(&found), vec![IdeId::Rider, IdeId::VisualStudio]);
        // Both solution IDEs get the one .sln.
        assert_eq!(found[0].target, p.path().join("App.sln"));
        assert_eq!(found[1].target, p.path().join("App.sln"));
        assert_eq!(found[1].marker, PathBuf::from("App.sln"));
    }

    #[test]
    fn visual_studio_from_vs_dir_or_solution_files() {
        let p = project();
        fs::create_dir(p.path().join(".vs")).unwrap();
        let found = detect(p.path());
        assert_eq!(ids(&found), vec![IdeId::VisualStudio]);
        assert_eq!(found[0].marker, PathBuf::from(".vs"));
        assert_eq!(found[0].target, p.path(), "no .sln → the folder");

        touch(p.path(), "One.slnx", "");
        assert_eq!(detect(p.path())[0].target, p.path().join("One.slnx"));

        touch(p.path(), "Two.sln", "");
        assert_eq!(detect(p.path())[0].target, p.path(), "two solutions → the folder");
    }

    #[test]
    fn vscode_from_dir_or_workspace_file() {
        let p = project();
        fs::create_dir(p.path().join(".vscode")).unwrap();
        let found = detect(p.path());
        assert_eq!(ids(&found), vec![IdeId::VsCode]);
        assert_eq!(found[0].target, p.path());

        let p = project();
        touch(p.path(), "app.code-workspace", "{}");
        let found = detect(p.path());
        assert_eq!(ids(&found), vec![IdeId::VsCode]);
        assert_eq!(found[0].marker, PathBuf::from("app.code-workspace"));
        assert_eq!(found[0].target, p.path().join("app.code-workspace"));
    }

    #[test]
    fn several_markers_list_in_fixed_order() {
        let p = project();
        fs::create_dir(p.path().join(".vscode")).unwrap();
        fs::create_dir(p.path().join(".idea")).unwrap();
        fs::create_dir(p.path().join(".vs")).unwrap();
        assert_eq!(
            ids(&detect(p.path())),
            vec![IdeId::Idea, IdeId::VisualStudio, IdeId::VsCode]
        );
    }

    #[test]
    fn marker_named_files_are_not_markers() {
        // A *file* called `.idea` is not a JetBrains project.
        let p = project();
        touch(p.path(), ".idea", "");
        touch(p.path(), ".vscode", "");
        assert!(detect(p.path()).is_empty());
    }

    // ── resolution ────────────────────────────────────────────────────────

    fn app(name: &str, exec: &str) -> InstalledApp {
        InstalledApp {
            name: name.to_string(),
            exec: exec.to_string(),
            icon: None,
        }
    }

    fn closed_world<'a>(on_path: &'a dyn Fn(&str) -> Option<PathBuf>) -> HostProbe<'a> {
        HostProbe {
            on_path,
            toolbox_scripts: None,
            vswhere: &|| None,
        }
    }

    #[test]
    fn installed_matching_per_ide() {
        let installed = vec![
            app("Xcode", "/Applications/Xcode.app"),
            app("PyCharm Professional", "flatpak run --branch=stable com.jetbrains.PyCharm-Professional"),
            app("Visual Studio Code", "/usr/share/code/code"),
            app("IntelliJ IDEA Ultimate", "/opt/idea/bin/idea.sh"),
            app("Rider", "/home/u/.local/share/JetBrains/Toolbox/apps/rider/bin/rider.sh"),
            app("Glider", "/usr/bin/glider"),
            app("Visual Studio 2022", r"C:\VS\Common7\IDE\devenv.exe"),
        ];
        assert_eq!(pick_installed(IdeId::PyCharm, &installed).unwrap().name, "PyCharm Professional");
        assert_eq!(pick_installed(IdeId::VsCode, &installed).unwrap().name, "Visual Studio Code");
        assert_eq!(pick_installed(IdeId::Idea, &installed).unwrap().name, "IntelliJ IDEA Ultimate");
        assert_eq!(pick_installed(IdeId::Rider, &installed).unwrap().name, "Rider");
        assert_eq!(pick_installed(IdeId::VisualStudio, &installed).unwrap().name, "Visual Studio 2022");
        assert!(pick_installed(IdeId::CLion, &installed).is_none());
        assert!(pick_installed(IdeId::GoLand, &installed).is_none());
    }

    #[test]
    fn vscode_never_matches_xcode_or_codium_by_name_only_when_exec_says_so() {
        let installed = vec![app("Xcode", "/Applications/Xcode.app")];
        assert!(pick_installed(IdeId::VsCode, &installed).is_none());
        let installed = vec![app("VSCodium", "/usr/bin/codium")];
        assert!(pick_installed(IdeId::VsCode, &installed).is_some());
    }

    #[test]
    fn override_wins_over_everything() {
        let on_path = |name: &str| (name == "pycharm").then(|| PathBuf::from("/usr/bin/pycharm"));
        let mut overrides = HashMap::new();
        overrides.insert("pycharm".to_string(), " /opt/mine/pycharm ".to_string());
        let got = resolve_launcher(IdeId::PyCharm, &overrides, &[], &closed_world(&on_path)).unwrap();
        assert_eq!(got.exec, "/opt/mine/pycharm");
        assert_eq!(got.source, LauncherSource::Override);
        assert_eq!(got.ide, IdeId::PyCharm);
    }

    #[test]
    fn blank_override_is_ignored() {
        let on_path = |name: &str| (name == "pycharm").then(|| PathBuf::from("/usr/bin/pycharm"));
        let mut overrides = HashMap::new();
        overrides.insert("pycharm".to_string(), "  ".to_string());
        let got = resolve_launcher(IdeId::PyCharm, &overrides, &[], &closed_world(&on_path)).unwrap();
        assert_eq!(got.source, LauncherSource::Path);
        assert_eq!(got.exec, "/usr/bin/pycharm");
    }

    #[test]
    fn path_outranks_toolbox_outranks_installed() {
        let scripts = TempDir::new().unwrap();
        touch(scripts.path(), "clion", "#!/bin/sh");
        let installed = vec![app("CLion", "/opt/clion/bin/clion.sh")];
        let none = |_: &str| None;
        let probe = HostProbe {
            on_path: &none,
            toolbox_scripts: Some(scripts.path().to_path_buf()),
            vswhere: &|| None,
        };
        let got = resolve_launcher(IdeId::CLion, &HashMap::new(), &installed, &probe).unwrap();
        assert_eq!(got.source, LauncherSource::Toolbox);
        assert_eq!(got.exec, scripts.path().join("clion").to_string_lossy());

        let probe = HostProbe {
            on_path: &none,
            toolbox_scripts: None,
            vswhere: &|| None,
        };
        let got = resolve_launcher(IdeId::CLion, &HashMap::new(), &installed, &probe).unwrap();
        assert_eq!(got.source, LauncherSource::Installed);
        assert_eq!(got.display_name, "CLion");
    }

    #[test]
    fn jetbrains_products_fall_back_to_idea() {
        let on_path = |name: &str| (name == "idea").then(|| PathBuf::from("/usr/bin/idea"));
        let got = resolve_launcher(IdeId::PyCharm, &HashMap::new(), &[], &closed_world(&on_path)).unwrap();
        assert_eq!(got.ide, IdeId::Idea);
        assert_eq!(got.display_name, "IntelliJ IDEA");
        assert!(resolve_launcher(IdeId::VsCode, &HashMap::new(), &[], &closed_world(&on_path)).is_none());
    }

    #[test]
    fn visual_studio_falls_back_to_rider_then_vscode_and_targets_follow() {
        let p = project();
        touch(p.path(), "App.sln", "");
        let detected = detect(p.path()).remove(0);
        assert_eq!(detected.ide, IdeId::VisualStudio);

        let rider = |name: &str| (name == "rider").then(|| PathBuf::from("/usr/bin/rider"));
        let got = resolve_launcher(IdeId::VisualStudio, &HashMap::new(), &[], &closed_world(&rider)).unwrap();
        assert_eq!(got.ide, IdeId::Rider);
        assert_eq!(got.target_for(&detected, p.path()), p.path().join("App.sln"));

        let code = |name: &str| (name == "code").then(|| PathBuf::from("/usr/bin/code"));
        let got = resolve_launcher(IdeId::VisualStudio, &HashMap::new(), &[], &closed_world(&code)).unwrap();
        assert_eq!(got.ide, IdeId::VsCode);
        assert_eq!(got.target_for(&detected, p.path()), p.path(), "VS Code gets the folder, not the .sln");

        let none = |_: &str| None;
        assert!(resolve_launcher(IdeId::VisualStudio, &HashMap::new(), &[], &closed_world(&none)).is_none());
    }

    #[test]
    fn vswhere_is_the_last_resort_for_visual_studio() {
        let none = |_: &str| None;
        let probe = HostProbe {
            on_path: &none,
            toolbox_scripts: None,
            vswhere: &|| Some(PathBuf::from(r"C:\VS\devenv.exe")),
        };
        let got = resolve_launcher(IdeId::VisualStudio, &HashMap::new(), &[], &probe).unwrap();
        assert_eq!(got.source, LauncherSource::Vswhere);
        assert_eq!(got.ide, IdeId::VisualStudio);
    }

    #[test]
    fn ids_round_trip_and_serialize_as_snake_case() {
        for ide in IdeId::ALL {
            assert_eq!(IdeId::parse(ide.id()), Some(ide));
            assert_eq!(serde_json::to_value(ide).unwrap(), ide.id());
        }
        assert_eq!(IdeId::parse("emacs"), None);
    }
}
