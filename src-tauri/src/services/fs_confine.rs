//! The confinement of the absolute-path file commands and viewers: which
//! roots a scope (project, box sibling, root work dir) or a server user may
//! name, the planted-root fences, the cached registry parses every check
//! reads, and the handle-based open (`open_confined`) that walks a path
//! without following a link swapped in after the check. Moved down from
//! `commands::fs` (S5), which keeps the file commands and re-exports these
//! names.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use app_core::sync::LockExt;
use serde_json::Value;

use crate::paths::canonical_or_new;

use crate::schema::boxes::BoxesList;
use crate::schema::projects::{ProjectEntry, ProjectsList};
use crate::storage;

// ── Absolute-path confinement (Security #1) ────────────────────────────────

/// The set of directories the absolute-path file commands may touch for a given
/// **scope**: the scope project's own directory, plus the directories of any
/// projects that share a box with it. Projects are filesystem-isolated from one
/// another — a file command made on behalf of project X can reach X's tree (and
/// any box sibling's tree, since box members are deliberately co-accessible), and
/// nothing else.
///
/// Crucially the scope is the project that *owns the calling viewer* (passed by
/// the frontend), NOT whichever project is globally "current". In-app viewers
/// stay mounted across project switches, are restored on relaunch, and can live
/// in detached windows; binding confinement to the current project made those
/// fail with a spurious "path is not in the current project" error the moment you
/// switched away (e.g. a `file_mtime` poll or `read_file_text` reload). Binding
/// it to the viewer's own project keeps strict per-project isolation while
/// letting a viewer keep working regardless of which project is current.
///
/// `scope_id` of `None` (root scope, or a caller that supplied no project) falls
/// back to the current project + its box siblings. Returns an empty set when the
/// scope resolves to no project (e.g. first run), which makes every absolute-path
/// command fail closed. See REVIEW.md Security #1.
pub(crate) fn allowed_roots(scope_id: Option<&str>) -> Vec<PathBuf> {
    let projects = PROJECTS.get("projects.json");
    let boxes = BOXES.get("boxes.json");
    compute_allowed_roots(&projects, &boxes, scope_id, &storage::root_work_dir())
}

/// The parsed registries every confinement check reads (see [`StateJsonCache`]).
pub(crate) static PROJECTS: StateJsonCache<ProjectsList> = StateJsonCache::new();
pub(crate) static BOXES: StateJsonCache<BoxesList> = StateJsonCache::new();

/// Every folder a server **user** (`core_dispatch::Role::User`) may name to a
/// command that takes a local path (`core_dispatch::confine_for_user`): the
/// root work dir, the parents new projects and remote mirrors are created
/// under, every project's directory and mirror override, and every box
/// folder. Wider than [`allowed_roots`] on purpose — that one isolates a
/// viewer to its own project; this one is the whole of what the user's
/// projects are, so a folder outside every project (`/`, `/etc`, another
/// account's home) is refused while switching projects is not.
pub(crate) fn user_roots() -> Vec<PathBuf> {
    let projects = PROJECTS.get("projects.json");
    let boxes = BOXES.get("boxes.json");
    let base = [
        storage::root_work_dir(),
        crate::paths::projects_root(),
        crate::paths::projects_ssh_root(),
    ];
    let keep_clear = [crate::paths::home_dir(), crate::paths::app_home(), storage::state_dir()];
    compute_user_roots(&projects, &boxes, &base, &keep_clear)
}

/// Pure core of [`user_roots`]. Each root is resolved as a confinement
/// candidate is (`canonical_or_new`), so a root that does not exist yet still
/// compares equal to a path under it.
///
/// A registered root (a project, mirror or box folder; not a `base` one) is
/// judged by where it resolves *now*, and a user can turn a folder they own
/// into a symlink after registering it (`git_checkout` of a branch holding a
/// link, `move_path` of one over it) — without these two rules, a project
/// folder swapped for a link to `/` made `/` a root. So a registered root is
/// dropped when
/// - any symlink on its spelling (the root itself or an ancestor) sits
///   strictly inside a root, by either spelling: a link there is the user's
///   to plant. A link above every root (`/home` → `/data/home`, macOS's
///   `/var`) is the system's and is followed; or
/// - it resolves to `keep_clear` (home, app home, state dir) or an ancestor of
///   one, whatever the route.
///
/// The cost: a project registered (by an admin or the desktop) through a link
/// inside a root is not one of a user's roots — refused, never widened.
pub(crate) fn compute_user_roots(
    projects: &ProjectsList,
    boxes: &BoxesList,
    base: &[PathBuf],
    keep_clear: &[PathBuf],
) -> Vec<PathBuf> {
    let mut registered: Vec<PathBuf> = projects.iter().filter_map(project_dir).collect();
    registered.extend(projects.iter().filter_map(mirror_override_dir));
    registered.extend(boxes.iter().filter_map(|b| b.folder.as_deref()).map(str::trim).filter(|f| !f.is_empty()).map(PathBuf::from));
    // A relative entry would resolve against the process's cwd, and a `..`
    // makes the spelling a lie about where the link checks look: never a root.
    let usable = |r: &PathBuf| r.is_absolute() && !r.components().any(|c| matches!(c, std::path::Component::ParentDir));
    let base: Vec<PathBuf> = base.iter().filter(|r| usable(r)).cloned().collect();
    registered.retain(usable);
    let resolve = |r: &PathBuf| canonical_or_new(r).unwrap_or_else(|_| r.clone());
    let keep_clear: Vec<PathBuf> = keep_clear.iter().filter(|k| k.is_absolute()).map(resolve).collect();
    let covers_kept = |c: &Path| keep_clear.iter().any(|k| k.starts_with(c));
    let resolved: Vec<(PathBuf, PathBuf)> = registered.iter().map(|r| (r.clone(), resolve(r))).collect();
    // Where a planted link would sit: inside any root, as spelled or resolved
    // (a resolution that covers a kept-clear folder is no fence: it would
    // count every system link as planted).
    let mut fences: Vec<PathBuf> = base.iter().flat_map(|b| [b.clone(), resolve(b)]).collect();
    for (lexical, canonical) in &resolved {
        fences.push(lexical.clone());
        if !covers_kept(canonical) {
            fences.push(canonical.clone());
        }
    }
    let mut roots: Vec<PathBuf> = base.iter().map(resolve).collect();
    roots.extend(
        resolved
            .into_iter()
            .filter(|(lexical, canonical)| !covers_kept(canonical) && !through_planted_link(lexical, &fences))
            .map(|(_, canonical)| canonical),
    );
    roots
}

/// `roots` without any reached through a link planted inside another root,
/// any of `roots` or of `registered` (every registered project, mirror and box
/// folder: a scope's own set is narrower than what an agent can plant a link
/// in). The user-roots rule of [`compute_user_roots`]: a root is **dropped**,
/// never rewritten to its real path, since the fence binds a root at its own
/// path and the viewers compare against what is listed. A root spelled with
/// `..` is dropped too (the link checks read the spelling). A link above every
/// root is the system's and is followed, and a resolution covering one of
/// `keep_clear` (home, state dir) is no fence for the others.
pub(crate) fn drop_planted_roots(roots: Vec<PathBuf>, registered: &[PathBuf], keep_clear: &[PathBuf]) -> Vec<PathBuf> {
    let all: Vec<PathBuf> = roots.iter().chain(registered).cloned().collect();
    let fences = root_fences(&all, keep_clear);
    roots
        .into_iter()
        .filter(|r| !r.components().any(|c| matches!(c, std::path::Component::ParentDir)) && !through_planted_link(r, &fences))
        .collect()
}

/// Where a planted link would sit: inside any of `roots`, as spelled or
/// resolved (a resolution that covers a `keep_clear` folder is no fence: it
/// would count every system link as planted).
pub(crate) fn root_fences(roots: &[PathBuf], keep_clear: &[PathBuf]) -> Vec<PathBuf> {
    let resolve = |r: &Path| canonical_or_new(r).unwrap_or_else(|_| r.to_path_buf());
    let keep_clear: Vec<PathBuf> = keep_clear.iter().filter(|k| k.is_absolute()).map(|k| resolve(k)).collect();
    let covers_kept = |c: &Path| keep_clear.iter().any(|k| k.starts_with(c));
    let mut fences: Vec<PathBuf> = Vec::new();
    for root in roots {
        fences.push(root.clone());
        let canonical = resolve(root);
        if !covers_kept(&canonical) {
            fences.push(canonical);
        }
    }
    fences
}

/// Every registered project folder, mirror override and box folder (absolute
/// ones only: a relative entry would resolve against the process's cwd).
pub(crate) fn registered_roots(projects: &ProjectsList, boxes: &BoxesList) -> Vec<PathBuf> {
    let mut registered: Vec<PathBuf> = projects.iter().filter_map(project_dir).collect();
    registered.extend(projects.iter().filter_map(mirror_override_dir));
    registered.extend(boxes.iter().filter_map(|b| b.folder.as_deref()).map(str::trim).filter(|f| !f.is_empty()).map(PathBuf::from));
    registered.retain(|r| r.is_absolute());
    registered
}

/// Whether `root` (a project's folder, as the phone's file browser is handed
/// it) is reached through a link planted inside any registered project, mirror
/// or box folder: such a root is refused, never followed.
pub(crate) fn is_planted_root(root: &Path) -> bool {
    let projects = PROJECTS.get("projects.json");
    let boxes = BOXES.get("boxes.json");
    is_planted_root_in(root, &projects, &boxes, &keep_clear_roots())
}

pub(crate) fn is_planted_root_in(root: &Path, projects: &ProjectsList, boxes: &BoxesList, keep_clear: &[PathBuf]) -> bool {
    through_planted_link(root, &root_fences(&registered_roots(projects, boxes), keep_clear))
}

/// The folders [`drop_planted_roots`] keeps clear of the fences: home and the
/// state dir.
pub(crate) fn keep_clear_roots() -> Vec<PathBuf> {
    vec![crate::paths::home_dir(), storage::state_dir()]
}

/// [`drop_planted_roots`] against `projects`/`boxes`, then each survivor
/// canonicalized where it can be (the literal path stays for a folder that
/// does not exist yet).
pub(crate) fn pin_roots(roots: Vec<PathBuf>, projects: &ProjectsList, boxes: &BoxesList) -> Vec<PathBuf> {
    let mut roots = drop_planted_roots(roots, &registered_roots(projects, boxes), &keep_clear_roots());
    roots.iter_mut().for_each(|r| *r = r.canonicalize().unwrap_or_else(|_| r.clone()));
    roots
}

/// Whether a symlink on `root`'s spelling (`root` itself or an ancestor) sits
/// strictly inside one of `fences`, by its spelled or its resolved location.
pub(crate) fn through_planted_link(root: &Path, fences: &[PathBuf]) -> bool {
    root.ancestors().any(|at| {
        if !fs::symlink_metadata(at).is_ok_and(|m| m.file_type().is_symlink()) {
            return false;
        }
        let real = at.parent().zip(at.file_name()).and_then(|(parent, name)| parent.canonicalize().ok().map(|p| p.join(name)));
        let inside = |loc: &Path| fences.iter().any(|f| loc != f.as_path() && loc.starts_with(f));
        inside(at) || real.as_deref().is_some_and(inside)
    })
}

/// Whether `local_file` is a known project's `project.json` (`local_file` in
/// `projects.json`), by its spelling or, failing that, by where it resolves.
pub(crate) fn is_project_local_file(local_file: &str) -> bool {
    is_local_file_in(&PROJECTS.get("projects.json"), local_file)
}

pub(crate) fn is_local_file_in(projects: &ProjectsList, local_file: &str) -> bool {
    if local_file.trim().is_empty() {
        return false;
    }
    if projects.iter().any(|e| !e.local_file.is_empty() && e.local_file == local_file) {
        return true;
    }
    let Ok(wanted) = fs::canonicalize(local_file) else {
        return false;
    };
    projects
        .iter()
        .filter(|e| !e.local_file.is_empty())
        .any(|e| fs::canonicalize(&e.local_file).is_ok_and(|known| known == wanted))
}

/// The last parse of one state file, reused while the file's bytes are unchanged.
///
/// Every confinement check (each `file_mtime` poll of every open viewer) used to
/// parse all of `projects.json` — thousands of `serde_json::Value`s for the
/// entries' flattened `extra` — making it the process's busiest allocator.
/// Keyed on the bytes, not on mtime/len: the file is rewritten in place by many
/// writers, and a project switch swaps two statuses without changing its length.
pub(crate) struct StateJsonCache<T>(std::sync::Mutex<Option<(PathBuf, String, std::sync::Arc<T>)>>);

impl<T> StateJsonCache<T>
where
    T: serde::de::DeserializeOwned + Default,
{
    pub(crate) const fn new() -> Self {
        Self(std::sync::Mutex::new(None))
    }

    /// The state file `name`, parsed; `T::default()` when it is absent or
    /// unparseable, so confinement degrades to fail-closed. Failures are not cached.
    pub(crate) fn get(&self, name: &str) -> std::sync::Arc<T> {
        self.load(storage::state_dir().join(name))
    }

    pub(crate) fn load(&self, path: PathBuf) -> std::sync::Arc<T> {
        let Ok(content) = fs::read_to_string(&path) else {
            return std::sync::Arc::new(T::default());
        };
        let mut slot = self.0.lock_ok();
        if let Some((cached_path, cached, value)) = slot.as_ref() {
            if *cached_path == path && *cached == content {
                return value.clone();
            }
        }
        let Ok(parsed) = serde_json::from_str::<T>(&content) else {
            *slot = None;
            return std::sync::Arc::new(T::default());
        };
        let value = std::sync::Arc::new(parsed);
        *slot = Some((path, content, value.clone()));
        value
    }
}

/// Pure core of [`allowed_roots`], split out so the project/box scoping logic is
/// testable without touching the real state dir.
pub(crate) fn compute_allowed_roots(
    projects: &ProjectsList,
    boxes: &BoxesList,
    scope_id: Option<&str>,
    root_work: &Path,
) -> Vec<PathBuf> {
    // The ROOT scope — a viewer with no owning project (`scope_id: None`), i.e.
    // the side panel's root view and any root-scope tab — browses the root
    // terminal folder `~/tabtivity/root`. Its *listing* passes confinement because
    // `list_dir` confines against the project_dir argument, but every absolute-
    // path read a viewer then makes (`read_file_bytes`, `file_mtime`, …) lands
    // here — and a roots set without that folder refused each one, so a PDF
    // opened from the root tree sat on "Loading" forever. Only the no-project
    // scope gains it: a project-scoped viewer stays project-isolated.
    let mut roots: Vec<PathBuf> = Vec::new();
    // A BOX scope (`box:<id>`) has no single anchor project: its roots are the
    // box folder plus every member's tree (and mirror override) — the
    // co-accessible set the box exists to create. An unknown box stays empty
    // (fail closed), and the root work dir is never folded in: a box viewer is
    // not the root scope.
    if let Some(box_id) = scope_id.and_then(crate::services::box_store::box_id_of_scope) {
        let Some(b) = boxes.iter().find(|b| b.id == box_id) else {
            return Vec::new();
        };
        if let Some(folder) = &b.folder {
            roots.push(PathBuf::from(folder));
        }
        let in_box = || {
            projects
                .iter()
                .filter(|e| b.member_ids.iter().any(|m| m == &e.id))
        };
        roots.extend(in_box().filter_map(project_dir));
        roots.extend(in_box().filter_map(mirror_override_dir));
        return pin_roots(roots, projects, boxes);
    }
    if scope_id.is_none() {
        roots.push(root_work.to_path_buf());
    }
    // Anchor on the scope project when one is named, else the current project.
    let anchor = match scope_id {
        Some(id) => projects.iter().find(|e| e.id == id),
        None => projects.iter().find(|e| e.status == "current"),
    };
    let Some(anchor) = anchor else {
        // No current project: the root scope still reads its own folder.
        return pin_roots(roots, projects, boxes);
    };

    // Start with the anchor project, then fold in every member of any box the
    // anchor belongs to (`member_ids` is the authoritative membership —
    // see schema::boxes::ProjectBox).
    let mut ids: HashSet<&str> = HashSet::new();
    ids.insert(anchor.id.as_str());
    for b in boxes {
        if b.member_ids.iter().any(|m| m == &anchor.id) {
            for m in &b.member_ids {
                ids.insert(m.as_str());
            }
        }
    }

    let in_scope = || projects.iter().filter(|e| ids.contains(e.id.as_str()));
    roots.extend(in_scope().filter_map(project_dir));
    // For a remote (SSH) project the tree the user actually browses is the local
    // *mirror*, not the state dir that `project_dir` returns. The default mirror
    // lives under the state dir (already covered above), but an explicit
    // `extra["mirror"]` relocation — including the top-level default minted at
    // import — sits outside it, so add each in-scope project's mirror override as
    // its own root. Otherwise opening a mirrored local file fails confinement
    // with a spurious "not in the current project" error. Pure: read straight
    // from the entry, no state-dir touch.
    roots.extend(in_scope().filter_map(mirror_override_dir));
    // Canonicalize where possible so symlinked roots compare correctly; fall
    // back to the literal path when the dir does not exist (yet). A root
    // reached through a link planted inside another root is dropped first.
    pin_roots(roots, projects, boxes)
}

/// A project entry's working directory: the canonical `directory` field when
/// present, otherwise the parent of its `local_file` (which is `<dir>/project.json`).
pub(crate) fn project_dir(entry: &ProjectEntry) -> Option<PathBuf> {
    entry.directory().map(PathBuf::from)
}

/// A remote project's explicit local-mirror override (`extra["mirror"]`), or
/// `None` when unset/empty or for a local project. Mirrors the resolution in
/// `services::remote_sync::mirror_override` but stays pure (reads the passed
/// entry, not the state dir) so `compute_allowed_roots` remains testable.
pub(crate) fn mirror_override_dir(entry: &ProjectEntry) -> Option<PathBuf> {
    let raw = entry.extra.get("mirror").and_then(Value::as_str)?.trim();
    (!raw.is_empty()).then(|| PathBuf::from(raw))
}

/// Resolve `p` to a canonical path for confinement checks, or `None` when it
/// is refused outright. Something standing at `p` (a file, a folder, a link)
/// counts by its real target, so a dangling link — which resolves nowhere —
/// is refused rather than taken for a new file (threat recheck gap 22). For a
/// path that does not exist yet the nearest existing ancestor is resolved and
/// the rest re-joined, so a write target inside an allowed root still
/// validates before creation and a missing folder below an in-root link out
/// of the project is judged by where the link leads. A `..` component is
/// refused: `root/missing/../..` used to pass the prefix check lexically.
pub(crate) fn resolve_for_confinement(p: &Path) -> Option<PathBuf> {
    if p.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
        return None;
    }
    if fs::symlink_metadata(p).is_ok() {
        return p.canonicalize().ok();
    }
    canonical_or_new(p).ok()
}

pub(crate) fn confine_abs(p: &Path, scope_id: Option<&str>) -> Result<(), String> {
    confine_abs_within(p, &allowed_roots(scope_id))
}

/// Pure confinement check against an explicit root set. Empty `roots` (no current
/// project) refuses everything.
pub(crate) fn confine_abs_within(p: &Path, roots: &[PathBuf]) -> Result<(), String> {
    match resolve_for_confinement(p) {
        Some(resolved) if roots.iter().any(|root| resolved.starts_with(root)) => Ok(()),
        _ => Err(outside_roots(p)),
    }
}

/// The refusal for a path outside every allowed root.
pub(crate) fn outside_roots(p: &Path) -> String {
    format!(
        "path '{}' is not in the current project (open that project, or add it to a box with the current one, to access it)",
        p.display()
    )
}

// ── Handle-based viewer I/O (threat recheck gaps 22 and 31, decision D1) ───

/// What [`open_confined`] opens a path for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Confined {
    /// An existing regular file, for reading.
    Read,
    /// An existing regular file or folder, for its metadata only.
    Stat,
    /// An existing regular file, emptied for an in-place save.
    Overwrite,
    /// An existing regular file emptied for an in-place save, or a new one
    /// created `O_EXCL`.
    Write,
    /// [`Confined::Write`], and the file's own folder is walked by name from
    /// its canonical parent, so a folder that is a link is refused too: the
    /// deck's TeX figures, whose folder an agent could otherwise point at a
    /// box sibling (threat recheck gap 23, D3). A leaf with `~` (a Windows
    /// 8.3 alias such as `EVIL~1.PNG`, which names another file) is refused.
    WriteOwnFolder,
}

/// `write_file_bytes` request header: `1` asks for
/// [`Confined::WriteOwnFolder`] (the deck's figure writes).
pub const NO_FOLDER_LINK_HEADER: &str = "x-no-folder-link";

/// Open the absolute path `p` inside one of `roots` without following a link
/// that was not there when the path was checked — the viewers' one way to the
/// local disk (`read_file_*_local`, `write_file_*_local`, `file_mtime_local`,
/// `file_size_local`).
///
/// The longest root holding the path is opened, and every folder below it is
/// walked one name at a time through held handles
/// (`mobile_control::files::ProjectDir`: `openat(O_NOFOLLOW)` on Unix,
/// `NtCreateFile` with `FILE_OPEN_REPARSE_POINT` on Windows). Every component
/// of a canonical path is link-free, so a folder swapped for a link after the
/// check fails the walk instead of redirecting it.
///
/// Reads canonicalize the whole path: an in-root link still reads, as it
/// always did, and its real target is what gets opened. A save canonicalizes
/// only the folder and opens the leaf itself without following it: **a leaf
/// that is a link — dangling or not, into the project or out of it — or a
/// Windows link-type (name-surrogate) reparse point is refused** (decision
/// D1). Other Windows reparse points (OneDrive placeholders, dedup) are no
/// links and are read and saved through their filter. An existing file is
/// emptied in place (inode, owner and mode kept); a missing one is created
/// `O_EXCL`. A `..` or `.` component is refused outright.
pub(crate) fn open_confined(p: &Path, roots: &[PathBuf], mode: Confined) -> Result<fs::File, String> {
    use crate::services::mobile_control::files::{ProjectDir, WriteRefusal};
    use std::path::Component;
    if !p.is_absolute() || p.components().any(|c| matches!(c, Component::ParentDir | Component::CurDir)) {
        return Err(format!("path '{}' is not a plain absolute path", p.display()));
    }
    let missing = || format!("{}: No such file or directory", p.display());
    let not_a_file = || "not a file".to_string();
    let saving = matches!(mode, Confined::Overwrite | Confined::Write | Confined::WriteOwnFolder);
    // The real path to walk: the canonical folder plus the leaf as named for
    // a save (the canonical grandparent plus folder and leaf as named for
    // `WriteOwnFolder`), the canonical whole path for a read.
    let target = if saving {
        let leaf = match p.components().next_back() {
            Some(Component::Normal(leaf)) => leaf,
            _ => return Err(not_a_file()),
        };
        let parent = p.parent().ok_or_else(not_a_file)?;
        if mode == Confined::WriteOwnFolder {
            if leaf.to_string_lossy().contains('~') {
                return Err(format!("'{}' has a `~` in its name; it was not saved", p.display()));
            }
            let folder = match parent.components().next_back() {
                Some(Component::Normal(folder)) => folder,
                _ => return Err(not_a_file()),
            };
            let grand = parent.parent().ok_or_else(not_a_file)?;
            grand.canonicalize().map_err(|_| missing())?.join(folder).join(leaf)
        } else {
            parent.canonicalize().map_err(|_| missing())?.join(leaf)
        }
    } else {
        p.canonicalize().map_err(|_| missing())?
    };
    let root = roots
        .iter()
        .filter(|root| target.starts_with(root))
        .max_by_key(|root| root.components().count())
        .ok_or_else(|| outside_roots(p))?;
    let rel = target.strip_prefix(root).map_err(|_| outside_roots(p))?;
    let mut names = Vec::new();
    for component in rel.components() {
        match component {
            Component::Normal(name) => names.push(
                name.to_str()
                    .ok_or_else(|| format!("path '{}' is not valid UTF-8", p.display()))?,
            ),
            _ => return Err(format!("path '{}' is not a plain absolute path", p.display())),
        }
    }
    let changed = || {
        format!(
            "'{}' changed while it was opened (a folder on the way is now a link or gone); nothing was read or written",
            p.display()
        )
    };
    let mut dir = ProjectDir::open_root(root).map_err(|_| missing())?;
    let Some((leaf, folders)) = names.split_last() else {
        // The root itself: a folder, so only its metadata is served.
        return if mode == Confined::Stat { Ok(dir.into_file()) } else { Err(not_a_file()) };
    };
    let link = || format!("'{}' is a link; viewers do not save through links", p.display());
    for (i, name) in folders.iter().enumerate() {
        let own_folder = mode == Confined::WriteOwnFolder && i + 1 == folders.len();
        // The deck makes its figure folder on the first figure (`mkdirat`,
        // then opened no-follow like any other folder).
        if own_folder && matches!(dir.lookup_dir(name), Ok(None)) {
            dir.create_dir(name).map_err(|e| e.to_string())?;
        }
        dir = match dir.lookup_dir(name) {
            Ok(Some(next)) => next,
            Ok(None) => return Err(missing()),
            // The own folder of a `WriteOwnFolder` save was never resolved:
            // something other than a plain folder there is that folder.
            Err(()) if own_folder => {
                return Err(format!(
                    "'{}' is in a folder that is a link; viewers do not save through links",
                    p.display()
                ))
            }
            Err(()) => return Err(changed()),
        };
    }
    let refused = |refusal: WriteRefusal| match refusal {
        WriteRefusal::Link => link(),
        WriteRefusal::NotFile => not_a_file(),
        WriteRefusal::Io(error) => error.to_string(),
    };
    match mode {
        Confined::Read => match dir.lookup_file(leaf) {
            Ok(Some((file, _))) => Ok(file),
            Ok(None) => Err(missing()),
            Err(()) => Err(not_a_file()),
        },
        Confined::Stat => match dir.lookup_file(leaf) {
            Ok(Some((file, _))) => Ok(file),
            Ok(None) => Err(missing()),
            Err(()) => match dir.lookup_dir(leaf) {
                Ok(Some(folder)) => Ok(folder.into_file()),
                Ok(None) => Err(missing()),
                Err(()) => Err(not_a_file()),
            },
        },
        Confined::Overwrite => dir.open_existing_for_write(leaf).map_err(refused)?.ok_or_else(missing),
        Confined::Write | Confined::WriteOwnFolder => {
            if let Some(file) = dir.open_existing_for_write(leaf).map_err(refused)? {
                return Ok(file);
            }
            match dir.create_file(leaf) {
                Ok(file) => Ok(file),
                // Something took the name since: only an existing regular
                // file is written, a link that appeared is still refused.
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    dir.open_existing_for_write(leaf).map_err(refused)?.ok_or_else(missing)
                }
                Err(error) => Err(error.to_string()),
            }
        }
    }
}

/// At most `max` bytes of a file [`open_confined`] proved regular, read from
/// its handle; a file larger than that is refused, never cut short.
pub(crate) fn read_opened(file: fs::File, max: u64) -> Result<Vec<u8>, String> {
    use std::io::Read;
    let len = file.metadata().map_err(|e| e.to_string())?.len();
    if len > max {
        return Err(format!("file too large to view ({len} bytes; limit {max})"));
    }
    let mut bytes = Vec::with_capacity(len as usize);
    file.take(max + 1).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    if bytes.len() as u64 > max {
        return Err(format!("file too large to view (over {max} bytes; limit {max})"));
    }
    Ok(bytes)
}

/// Write `content` through a handle [`open_confined`] opened for a save.
pub(crate) fn write_opened(mut file: fs::File, content: &[u8]) -> Result<(), String> {
    use std::io::Write;
    file.write_all(content).map_err(|e| e.to_string())
}

/// Confine a path a **non-file** command is about to act on (today:
/// `commands::apps::run_script_detached`, which runs `bash <path>`) to exactly the
/// per-project roots every file command is bound by.
///
/// Exposed because the confinement logic in this module — canonicalize-then-prefix,
/// fail-closed on an unknown scope — is the only correct implementation in the
/// codebase, and a second copy elsewhere would drift from it.
pub(crate) fn confine_project_path(p: &Path, scope_id: Option<&str>) -> Result<(), String> {
    confine_abs(p, scope_id)
}

/// Confine a path a server **user** (not the box's admin) names to a command
/// with no confinement of its own — `list_dir_all` (on the desktop it stands
/// in for an OS file dialog), every path argument `core_dispatch`'s user table
/// holds, the browser's file tickets and grants
/// (`services::core_dispatch::user_path`) — to [`user_roots`]. A relative path
/// is refused: it would resolve against the server process's cwd.
pub(crate) fn confine_user_path(p: &Path) -> Result<(), String> {
    if !p.is_absolute() {
        return Err(format!("path '{}' is not absolute", p.display()));
    }
    confine_abs_within(p, &user_roots()).map_err(|_| outside_user_roots(p))
}

/// The refusal for a path outside every one of a user's roots. Keeps the
/// "not in the current project" wording the other refusals use.
pub(crate) fn outside_user_roots(p: &Path) -> String {
    format!(
        "path '{}' is not in the current project or any other of your projects",
        p.display()
    )
}
