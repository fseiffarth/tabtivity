//! Which IDE a project belongs to, read off the footprint the IDE left in its
//! tree — `.idea/` (JetBrains, Android Studio), `.vs/` + `*.sln` (Visual
//! Studio), `.vscode/` / `*.code-workspace` (VS Code), `.cursor/`,
//! `.windsurf/`, `.zed/`, `*.xcodeproj` / `*.xcworkspace` (Xcode, macOS only),
//! `.project` (Eclipse), `*.sublime-project`, `*.Rproj` (RStudio),
//! `.spyproject/` (Spyder) — and which installed program opens it.
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
    PhpStorm,
    RubyMine,
    Rider,
    RustRover,
    GoLand,
    AndroidStudio,
    Idea,
    VisualStudio,
    VsCode,
    Cursor,
    Windsurf,
    Zed,
    Xcode,
    Eclipse,
    SublimeText,
    RStudio,
    Spyder,
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
    pub const ALL: [IdeId; 20] = [
        IdeId::PyCharm,
        IdeId::CLion,
        IdeId::WebStorm,
        IdeId::PhpStorm,
        IdeId::RubyMine,
        IdeId::Rider,
        IdeId::RustRover,
        IdeId::GoLand,
        IdeId::AndroidStudio,
        IdeId::Idea,
        IdeId::VisualStudio,
        IdeId::VsCode,
        IdeId::Cursor,
        IdeId::Windsurf,
        IdeId::Zed,
        IdeId::Xcode,
        IdeId::Eclipse,
        IdeId::SublimeText,
        IdeId::RStudio,
        IdeId::Spyder,
    ];

    pub fn id(self) -> &'static str {
        match self {
            IdeId::PyCharm => "pycharm",
            IdeId::CLion => "clion",
            IdeId::WebStorm => "webstorm",
            IdeId::PhpStorm => "phpstorm",
            IdeId::RubyMine => "rubymine",
            IdeId::Rider => "rider",
            IdeId::RustRover => "rustrover",
            IdeId::GoLand => "goland",
            IdeId::AndroidStudio => "android_studio",
            IdeId::Idea => "idea",
            IdeId::VisualStudio => "visual_studio",
            IdeId::VsCode => "vscode",
            IdeId::Cursor => "cursor",
            IdeId::Windsurf => "windsurf",
            IdeId::Zed => "zed",
            IdeId::Xcode => "xcode",
            IdeId::Eclipse => "eclipse",
            IdeId::SublimeText => "sublime_text",
            IdeId::RStudio => "rstudio",
            IdeId::Spyder => "spyder",
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
            IdeId::PhpStorm => "PhpStorm",
            IdeId::RubyMine => "RubyMine",
            IdeId::Rider => "Rider",
            IdeId::RustRover => "RustRover",
            IdeId::GoLand => "GoLand",
            IdeId::AndroidStudio => "Android Studio",
            IdeId::Idea => "IntelliJ IDEA",
            IdeId::VisualStudio => "Visual Studio",
            IdeId::VsCode => "Visual Studio Code",
            IdeId::Cursor => "Cursor",
            IdeId::Windsurf => "Windsurf",
            IdeId::Zed => "Zed",
            IdeId::Xcode => "Xcode",
            IdeId::Eclipse => "Eclipse",
            IdeId::SublimeText => "Sublime Text",
            IdeId::RStudio => "RStudio",
            IdeId::Spyder => "Spyder",
        }
    }

    /// JetBrains (Android Studio is IntelliJ-based), Visual Studio, VS Code
    /// and its forks; every other IDE is a family of its own, named by its id.
    pub fn family(self) -> &'static str {
        match self {
            IdeId::PyCharm
            | IdeId::CLion
            | IdeId::WebStorm
            | IdeId::PhpStorm
            | IdeId::RubyMine
            | IdeId::Rider
            | IdeId::RustRover
            | IdeId::GoLand
            | IdeId::AndroidStudio
            | IdeId::Idea => FAMILY_JETBRAINS,
            IdeId::VisualStudio => FAMILY_VISUAL_STUDIO,
            IdeId::VsCode | IdeId::Cursor | IdeId::Windsurf => FAMILY_VSCODE,
            _ => self.id(),
        }
    }

    /// Arguments placed before the target. Sublime Text opens a
    /// `.sublime-project` as a project only behind `--project` (bare, it edits
    /// the file); Spyder opens a folder as a project only behind `-p`.
    fn args_for(self, target: &Path) -> &'static [&'static str] {
        match self {
            IdeId::SublimeText if has_ext(target, "sublime-project") => &["--project"],
            IdeId::Spyder => &["-p"],
            _ => &[],
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
            IdeId::PhpStorm => &["phpstorm"],
            IdeId::RubyMine => &["rubymine"],
            IdeId::Rider => &["rider"],
            IdeId::RustRover => &["rustrover"],
            IdeId::GoLand => &["goland"],
            IdeId::AndroidStudio => &["studio", "android-studio"],
            IdeId::Idea => &["idea", "intellij-idea-ultimate", "intellij-idea-community"],
            IdeId::VisualStudio => &["devenv"],
            IdeId::VsCode => &["code", "code-insiders", "codium", "code-oss", "cursor"],
            IdeId::Cursor => &["cursor"],
            IdeId::Windsurf => &["windsurf"],
            // `zeditor` / `zedit` are the Linux distro packages' names for it.
            IdeId::Zed => &["zed", "zeditor", "zedit", "zed-editor"],
            // Xcode's own command-line opener.
            IdeId::Xcode => &["xed"],
            IdeId::Eclipse => &["eclipse"],
            IdeId::SublimeText => &["subl", "sublime_text", "sublime-text"],
            IdeId::RStudio => &["rstudio"],
            IdeId::Spyder => &["spyder", "spyder3"],
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
            IdeId::PhpStorm => &["phpstorm"],
            IdeId::RubyMine => &["rubymine"],
            IdeId::Rider => &["jetbrains rider", "jetbrains-rider", "com.jetbrains.rider", "rider.sh"],
            IdeId::RustRover => &["rustrover"],
            IdeId::GoLand => &["goland"],
            IdeId::AndroidStudio => &["android studio", "android-studio", "com.google.androidstudio"],
            IdeId::Idea => &["intellij", "jetbrains-idea", "idea.sh"],
            IdeId::VisualStudio => &["devenv"],
            IdeId::VsCode => &["visual studio code", "com.visualstudio.code", "code - oss", "vscodium", "cursor"],
            IdeId::Cursor => &["cursor"],
            IdeId::Windsurf => &["windsurf"],
            // The flatpak id; the bare word would claim "Optimized …" entries.
            IdeId::Zed => &["dev.zed.zed"],
            // `Xcode.app`, not the many `xcode-*` helper tools.
            IdeId::Xcode => &[],
            IdeId::Eclipse => &["eclipse"],
            IdeId::SublimeText => &["sublime text", "com.sublimetext"],
            IdeId::RStudio => &["rstudio"],
            IdeId::Spyder => &["spyder"],
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
            IdeId::AndroidStudio => &["studio", "studio64"],
            IdeId::Zed => &["zed", "zeditor", "zedit", "zed-editor"],
            IdeId::Xcode => &["xcode"],
            IdeId::SublimeText => &["subl", "sublime_text"],
            _ => &[],
        }
    }

    /// Which other IDE may open this one's project when it is not installed:
    /// any JetBrains project opens in IDEA (Ultimate carries every language
    /// plugin, and imports Eclipse projects too), a Visual Studio solution opens
    /// in Rider, and failing that in VS Code (on the folder — see
    /// [`IdeId::opens_solutions`]); a VS Code fork's project opens in VS Code.
    /// The rest have no stand-in.
    fn fallbacks(self) -> &'static [IdeId] {
        match self {
            IdeId::PyCharm
            | IdeId::CLion
            | IdeId::WebStorm
            | IdeId::PhpStorm
            | IdeId::RubyMine
            | IdeId::Rider
            | IdeId::RustRover
            | IdeId::GoLand
            | IdeId::AndroidStudio
            | IdeId::Eclipse => &[IdeId::Idea],
            IdeId::VisualStudio => &[IdeId::Rider, IdeId::VsCode],
            IdeId::Cursor | IdeId::Windsurf => &[IdeId::VsCode],
            _ => &[],
        }
    }

    /// Lower-case names this IDE's top-level windows carry: an X11 `WM_CLASS`
    /// segment (`jetbrains-pycharm`, `code`) or, on Windows, the executable's
    /// file stem (`pycharm64`, `code`). A name also claims its `-suffix`
    /// editions (`jetbrains-pycharm-ce`, `jetbrains-idea-ce`).
    fn window_classes(self) -> &'static [&'static str] {
        match self {
            IdeId::PyCharm => &["jetbrains-pycharm", "pycharm64"],
            IdeId::CLion => &["jetbrains-clion", "clion64"],
            IdeId::WebStorm => &["jetbrains-webstorm", "webstorm64"],
            IdeId::PhpStorm => &["jetbrains-phpstorm", "phpstorm64"],
            IdeId::RubyMine => &["jetbrains-rubymine", "rubymine64"],
            IdeId::Rider => &["jetbrains-rider", "rider64"],
            IdeId::RustRover => &["jetbrains-rustrover", "rustrover64"],
            IdeId::GoLand => &["jetbrains-goland", "goland64"],
            IdeId::AndroidStudio => &["jetbrains-studio", "studio64"],
            IdeId::Idea => &["jetbrains-idea", "idea64"],
            IdeId::VisualStudio => &["devenv"],
            // The `code` launcher may be any of these (`path_candidates`).
            IdeId::VsCode => &["code", "code - insiders", "vscodium", "codium", "cursor"],
            IdeId::Cursor => &["cursor"],
            IdeId::Windsurf => &["windsurf"],
            IdeId::Zed => &["dev.zed.zed", "zed"],
            IdeId::Xcode => &["xcode"],
            IdeId::Eclipse => &["eclipse"],
            IdeId::SublimeText => &["sublime_text"],
            IdeId::RStudio => &["rstudio"],
            IdeId::Spyder => &["spyder"],
        }
    }
}

// ── Open windows ───────────────────────────────────────────────────────────

/// The names an IDE window may title the project with: the folder's, a
/// JetBrains project's own (`.idea/.name`), and a `.code-workspace` target's
/// stem. The `.name` file is only ever compared against window titles.
pub fn project_window_names(dir: &Path, target: &Path) -> Vec<String> {
    use std::io::Read;
    let mut names = Vec::new();
    let mut push = |name: &str| {
        let name = name.trim();
        if !name.is_empty() && !names.iter().any(|n| n == name) {
            names.push(name.to_string());
        }
    };
    if let Some(name) = dir.file_name() {
        push(&name.to_string_lossy());
    }
    let mut idea_name = String::new();
    if let Ok(file) = fs::File::open(dir.join(".idea").join(".name")) {
        let _ = file.take(256).read_to_string(&mut idea_name);
        push(&idea_name);
    }
    if has_ext(target, "code-workspace") {
        if let Some(stem) = target.file_stem() {
            push(&stem.to_string_lossy());
        }
    }
    names
}

/// Whether a top-level window is `ide`'s window on a project called one of
/// `names`. `class` is the X11 `WM_CLASS` (NUL-separated instance and class)
/// or a Windows executable's file name. Pure, so the title shapes are tested
/// with literals.
pub fn window_shows_project(ide: IdeId, class: &str, title: &str, names: &[String]) -> bool {
    window_is_ide(ide, class) && title_names_project(title, names)
}

fn window_is_ide(ide: IdeId, class: &str) -> bool {
    class
        .to_lowercase()
        .split('\0')
        .map(|seg| seg.trim().trim_end_matches(".exe"))
        .filter(|seg| !seg.is_empty())
        .any(|seg| {
            ide.window_classes()
                .iter()
                .any(|c| seg == *c || seg.strip_prefix(c).is_some_and(|rest| rest.starts_with('-')))
        })
}

/// JetBrains titles a project window `name – file` (older builds
/// `name [~/path] – file`), VS Code `file - name - Visual Studio Code` (a
/// workspace `name (Workspace)`, an unsaved file `● file`): the project's name
/// is one whole dash-separated part of the title.
fn title_names_project(title: &str, names: &[String]) -> bool {
    let title = title.replace(" – ", " - ").replace(" — ", " - ");
    title.split(" - ").any(|part| {
        let part = part.trim().trim_start_matches('●').trim();
        let part = part.split(" [").next().unwrap_or(part);
        let part = part.trim_end_matches(" (Workspace)").trim();
        names.iter().any(|n| n == part)
    })
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
    cursor: bool,
    windsurf: bool,
    zed: bool,
    spyder: bool,
    /// `.project` plus one of the files Eclipse writes beside it — a bare
    /// `.project` is too generic a name to claim on its own.
    eclipse_project: bool,
    eclipse_companion: bool,
    /// A top-level module with `src/main/AndroidManifest.xml` (`app/`).
    android: bool,
    cmake: bool,
    cargo: bool,
    go_mod: bool,
    python: bool,
    package_json: bool,
    composer: bool,
    gemfile: bool,
    solutions: Vec<PathBuf>,
    workspaces: Vec<PathBuf>,
    imls: Vec<PathBuf>,
    /// `*.xcworkspace` / `*.xcodeproj` bundles (directories).
    xcode_workspaces: Vec<PathBuf>,
    xcode_projects: Vec<PathBuf>,
    sublime_projects: Vec<PathBuf>,
    rprojs: Vec<PathBuf>,
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
            ".cursor" if is_dir => top.cursor = true,
            ".windsurf" if is_dir => top.windsurf = true,
            ".zed" if is_dir => top.zed = true,
            ".spyproject" if is_dir => top.spyder = true,
            ".project" if !is_dir => top.eclipse_project = true,
            ".classpath" | ".cproject" | ".pydevproject" if !is_dir => top.eclipse_companion = true,
            ".settings" if is_dir => top.eclipse_companion = true,
            "composer.json" if !is_dir => top.composer = true,
            "Gemfile" if !is_dir => top.gemfile = true,
            "CMakeLists.txt" if !is_dir => top.cmake = true,
            "Cargo.toml" if !is_dir => top.cargo = true,
            "go.mod" if !is_dir => top.go_mod = true,
            "pyproject.toml" | "setup.py" | "setup.cfg" | "requirements.txt" | "Pipfile"
            | "environment.yml"
                if !is_dir =>
            {
                top.python = true
            }
            "package.json" if !is_dir => top.package_json = true,
            _ => {}
        }
        let ext = path
            .extension()
            .map(|e| e.to_string_lossy().to_ascii_lowercase())
            .unwrap_or_default();
        if is_dir {
            match ext.as_str() {
                "xcworkspace" => top.xcode_workspaces.push(path),
                "xcodeproj" => top.xcode_projects.push(path),
                _ if !name.starts_with('.')
                    && path.join("src").join("main").join("AndroidManifest.xml").is_file() =>
                {
                    top.android = true
                }
                _ => {}
            }
            continue;
        }
        match ext.as_str() {
            "sln" | "slnx" => top.solutions.push(path),
            "code-workspace" => top.workspaces.push(path),
            "iml" => top.imls.push(path),
            "sublime-project" => top.sublime_projects.push(path),
            "rproj" => top.rprojs.push(path),
            _ => {}
        }
    }
    top.solutions.sort();
    top.workspaces.sort();
    top.xcode_workspaces.sort();
    top.xcode_projects.sort();
    top.sublime_projects.sort();
    top.rprojs.sort();
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

/// Which JetBrains product (or Android Studio) a `.idea/` belongs to. The `.iml` module type is
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
            // PhpStorm writes the same module type WebStorm does.
            Some("WEB_MODULE") if top.composer => return IdeId::PhpStorm,
            Some("WEB_MODULE") => return IdeId::WebStorm,
            Some("GO_MODULE") => return IdeId::GoLand,
            Some("RUBY_MODULE") => return IdeId::RubyMine,
            _ => {}
        }
    }
    if top.android {
        IdeId::AndroidStudio
    } else if top.cmake {
        IdeId::CLion
    } else if top.cargo {
        IdeId::RustRover
    } else if top.go_mod {
        IdeId::GoLand
    } else if top.python {
        IdeId::PyCharm
    } else if top.composer {
        IdeId::PhpStorm
    } else if top.gemfile {
        IdeId::RubyMine
    } else if top.package_json {
        IdeId::WebStorm
    } else {
        IdeId::Idea
    }
}

/// The IDEs `dir` carries markers for, in a fixed order (JetBrains, Visual
/// Studio, VS Code and its forks, then the rest). Empty when nothing is recognised or `dir` is unreadable.
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
    let folder = |found: &mut Vec<Detected>, ide: IdeId, marker: &str| {
        found.push(Detected {
            ide,
            marker: PathBuf::from(marker),
            target: dir.to_path_buf(),
        })
    };
    // The file a marker list names first, relative to `dir`, as the marker.
    let first_name = |files: &[PathBuf]| -> PathBuf {
        files[0].file_name().map(PathBuf::from).unwrap_or_default()
    };
    if top.cursor {
        folder(&mut found, IdeId::Cursor, ".cursor");
    }
    if top.windsurf {
        folder(&mut found, IdeId::Windsurf, ".windsurf");
    }
    if top.zed {
        folder(&mut found, IdeId::Zed, ".zed");
    }
    // Xcode exists only on macOS; elsewhere the bundle would be a row nothing
    // can ever open.
    if cfg!(target_os = "macos")
        && (!top.xcode_workspaces.is_empty() || !top.xcode_projects.is_empty())
    {
        // A workspace wraps its projects, so it is what opens when there is one.
        let (bundles, target) = if top.xcode_workspaces.is_empty() {
            (&top.xcode_projects, single(&top.xcode_projects))
        } else {
            (&top.xcode_workspaces, single(&top.xcode_workspaces))
        };
        let marker = first_name(bundles);
        let target = target.unwrap_or_else(|| dir.to_path_buf());
        found.push(Detected {
            ide: IdeId::Xcode,
            marker,
            target,
        });
    }
    if top.eclipse_project && top.eclipse_companion {
        folder(&mut found, IdeId::Eclipse, ".project");
    }
    if !top.sublime_projects.is_empty() {
        found.push(Detected {
            ide: IdeId::SublimeText,
            marker: first_name(&top.sublime_projects),
            target: single(&top.sublime_projects).unwrap_or_else(|| dir.to_path_buf()),
        });
    }
    if !top.rprojs.is_empty() {
        found.push(Detected {
            ide: IdeId::RStudio,
            marker: first_name(&top.rprojs),
            target: single(&top.rprojs).unwrap_or_else(|| dir.to_path_buf()),
        });
    }
    if top.spyder {
        folder(&mut found, IdeId::Spyder, ".spyproject");
    }
    found
}

fn has_ext(path: &Path, ext: &str) -> bool {
    path.extension().is_some_and(|e| e.eq_ignore_ascii_case(ext))
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
    /// The arguments that go before [`Launcher::target_for`]'s target.
    pub fn args_for(&self, target: &Path) -> Vec<String> {
        self.ide.args_for(target).iter().map(|a| a.to_string()).collect()
    }

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
        let cases: [(&[&str], IdeId); 11] = [
            (&["CMakeLists.txt"], IdeId::CLion),
            (&["Cargo.toml"], IdeId::RustRover),
            (&["go.mod"], IdeId::GoLand),
            (&["pyproject.toml"], IdeId::PyCharm),
            (&["requirements.txt"], IdeId::PyCharm),
            (&["package.json"], IdeId::WebStorm),
            (&["composer.json", "package.json"], IdeId::PhpStorm),
            (&["Gemfile"], IdeId::RubyMine),
            (&["app/src/main/AndroidManifest.xml", "CMakeLists.txt"], IdeId::AndroidStudio),
            // A Python backend with a web front end is still a PyCharm project.
            (&["package.json", "setup.py"], IdeId::PyCharm),
            (&["pom.xml"], IdeId::Idea),
        ];
        for (files, ide) in cases {
            let p = project();
            fs::create_dir(p.path().join(".idea")).unwrap();
            for f in files {
                let rel: PathBuf = f.split('/').collect();
                touch(p.path(), &rel.to_string_lossy(), "");
            }
            assert_eq!(ids(&detect(p.path())), vec![ide], "{files:?}");
        }
    }

    #[test]
    fn iml_types_for_php_and_ruby() {
        let p = project();
        touch(p.path(), ".idea/app.iml", "<module type=\"WEB_MODULE\" />");
        touch(p.path(), "composer.json", "{}");
        assert_eq!(ids(&detect(p.path())), vec![IdeId::PhpStorm]);

        let p = project();
        touch(p.path(), ".idea/app.iml", "<module type=\"RUBY_MODULE\" />");
        assert_eq!(ids(&detect(p.path())), vec![IdeId::RubyMine]);
    }

    #[test]
    fn folder_markers_of_the_other_editors() {
        let cases = [
            (".cursor", IdeId::Cursor),
            (".windsurf", IdeId::Windsurf),
            (".zed", IdeId::Zed),
            (".spyproject", IdeId::Spyder),
        ];
        for (marker, ide) in cases {
            let p = project();
            fs::create_dir(p.path().join(marker)).unwrap();
            let found = detect(p.path());
            assert_eq!(ids(&found), vec![ide], "{marker}");
            assert_eq!(found[0].marker, PathBuf::from(marker));
            assert_eq!(found[0].target, p.path());
        }
    }

    #[test]
    fn eclipse_needs_a_companion_file_beside_dot_project() {
        let p = project();
        touch(p.path(), ".project", "<projectDescription/>");
        assert!(detect(p.path()).is_empty(), "a bare .project is too generic");
        touch(p.path(), ".classpath", "");
        assert_eq!(ids(&detect(p.path())), vec![IdeId::Eclipse]);

        let p = project();
        touch(p.path(), ".project", "");
        fs::create_dir(p.path().join(".settings")).unwrap();
        assert_eq!(ids(&detect(p.path())), vec![IdeId::Eclipse]);
    }

    #[test]
    fn sublime_and_rstudio_open_their_one_project_file() {
        let p = project();
        touch(p.path(), "app.sublime-project", "{}");
        touch(p.path(), "analysis.Rproj", "");
        let found = detect(p.path());
        assert_eq!(ids(&found), vec![IdeId::SublimeText, IdeId::RStudio]);
        assert_eq!(found[0].target, p.path().join("app.sublime-project"));
        assert_eq!(found[0].marker, PathBuf::from("app.sublime-project"));
        assert_eq!(found[1].target, p.path().join("analysis.Rproj"));

        touch(p.path(), "other.sublime-project", "{}");
        assert_eq!(detect(p.path())[0].target, p.path(), "two projects → the folder");
    }

    #[test]
    fn xcode_bundles_count_only_on_macos() {
        let p = project();
        fs::create_dir(p.path().join("App.xcodeproj")).unwrap();
        fs::create_dir(p.path().join("App.xcworkspace")).unwrap();
        let found = detect(p.path());
        if cfg!(target_os = "macos") {
            assert_eq!(ids(&found), vec![IdeId::Xcode]);
            assert_eq!(found[0].target, p.path().join("App.xcworkspace"), "the workspace wins");
        } else {
            assert!(found.is_empty());
        }
    }

    #[test]
    fn launch_args_per_ide() {
        let p = project();
        let sublime = |target: &Path| {
            Launcher {
                ide: IdeId::SublimeText,
                exec: "subl".into(),
                display_name: "Sublime Text".into(),
                source: LauncherSource::Path,
            }
            .args_for(target)
        };
        assert_eq!(sublime(&p.path().join("a.sublime-project")), vec!["--project"]);
        assert!(sublime(p.path()).is_empty(), "a folder opens bare");
        let spyder = Launcher {
            ide: IdeId::Spyder,
            exec: "spyder".into(),
            display_name: "Spyder".into(),
            source: LauncherSource::Path,
        };
        assert_eq!(spyder.args_for(p.path()), vec!["-p"]);
        let code = Launcher {
            ide: IdeId::VsCode,
            exec: "code".into(),
            display_name: "Visual Studio Code".into(),
            source: LauncherSource::Path,
        };
        assert!(code.args_for(p.path()).is_empty());
    }

    #[test]
    fn vscode_forks_fall_back_to_vscode_and_ids_round_trip() {
        let code = |name: &str| (name == "code").then(|| PathBuf::from("/usr/bin/code"));
        let got = resolve_launcher(IdeId::Windsurf, &HashMap::new(), &[], &closed_world(&code)).unwrap();
        assert_eq!(got.ide, IdeId::VsCode);
        for ide in IdeId::ALL {
            assert_eq!(IdeId::parse(ide.id()), Some(ide));
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
        assert!(pick_installed(IdeId::Zed, &installed).is_none());

        let installed = vec![
            app("Xcode", "/Applications/Xcode.app/Contents/MacOS/Xcode"),
            app("Zed", "/usr/bin/zeditor"),
            app("Android Studio", "/opt/android-studio/bin/studio.sh"),
            app("Sublime Text", "/opt/sublime_text/sublime_text --class=sublime-text"),
        ];
        assert_eq!(pick_installed(IdeId::Xcode, &installed).unwrap().name, "Xcode");
        assert!(pick_installed(IdeId::VsCode, &installed).is_none());
        assert_eq!(pick_installed(IdeId::AndroidStudio, &installed).unwrap().name, "Android Studio");
        assert_eq!(pick_installed(IdeId::SublimeText, &installed).unwrap().name, "Sublime Text");
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

    fn names(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn an_open_ide_window_is_found_by_class_and_project_title() {
        let proj = names(&["my-app"]);
        for (ide, class, title) in [
            (IdeId::PyCharm, "jetbrains-pycharm\0jetbrains-pycharm\0", "my-app – main.py"),
            (IdeId::PyCharm, "jetbrains-pycharm-ce\0jetbrains-pycharm-ce\0", "my-app [~/src/my-app] – main.py"),
            (IdeId::PyCharm, "pycharm64.exe", "my-app – main.py"),
            (IdeId::VsCode, "code\0Code\0", "● main.py - my-app - Visual Studio Code"),
            (IdeId::VsCode, "code\0Code\0", "my-app - Visual Studio Code"),
            (IdeId::VsCode, "Code.exe", "my-app (Workspace) - Visual Studio Code"),
            (IdeId::VsCode, "vscodium\0VSCodium\0", "main.py — my-app — VSCodium"),
        ] {
            assert!(window_shows_project(ide, class, title, &proj), "{class:?} {title:?}");
        }
    }

    #[test]
    fn other_projects_and_other_apps_are_not_raised() {
        let proj = names(&["app"]);
        for (ide, class, title) in [
            // Another project, its name merely containing this one's.
            (IdeId::PyCharm, "jetbrains-pycharm\0jetbrains-pycharm\0", "my-app – main.py"),
            (IdeId::VsCode, "code\0Code\0", "main.py - webapp - Visual Studio Code"),
            // The right title in another program.
            (IdeId::PyCharm, "jetbrains-idea\0jetbrains-idea\0", "app – main.py"),
            (IdeId::VsCode, "xcode", "app - Xcode"),
            (IdeId::VsCode, "firefox\0firefox\0", "app - Visual Studio Code - Mozilla Firefox"),
        ] {
            assert!(!window_shows_project(ide, class, title, &proj), "{class:?} {title:?}");
        }
        assert!(!window_shows_project(IdeId::VsCode, "code\0Code\0", "", &[]));
    }

    #[test]
    fn window_names_add_the_jetbrains_name_and_the_workspace_stem() {
        let p = project();
        let dir = p.path().join("proj");
        touch(&dir, ".idea/.name", "Pretty Name\n");
        touch(&dir, "team.code-workspace", "{}");
        assert_eq!(
            project_window_names(&dir, &dir.join("team.code-workspace")),
            names(&["proj", "Pretty Name", "team"])
        );
        assert_eq!(project_window_names(&dir, &dir), names(&["proj", "Pretty Name"]));
    }
}
