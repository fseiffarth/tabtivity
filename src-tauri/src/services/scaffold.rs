//! The project scaffold catalog: which root docs a project can hold, what each
//! one is written with, and which of three states each one is in.
//!
//! One list ([`DOCS`]) replaces the flat file table the scaffold used to be.
//! A new project gets only the `default` entries (`AGENTS.md`, `README.md`;
//! `.gitignore` is git's own rule, `commands::projects`). The other docs are
//! *create on demand* (`creatable`), `REMARKS.md` belongs to the remarks
//! feature, and the two agent pointer files (`CLAUDE.md`, `GEMINI.md`) are no
//! longer written at all: they stay in the catalog only so a project that
//! already holds one is recognised and its file left alone.
//!
//! State of an entry ([`DocState`]), from one capped, no-follow read
//! ([`read_scaffold_doc`], the only reader):
//! - `Missing`: nothing there, or not a plain file (a link, a FIFO, too large,
//!   not UTF-8 — never read through, never rewritten);
//! - `Template`: empty, or byte-equal (CRLF-normalised, ends trimmed) to the
//!   current template or one Tabtivity shipped before (`history`); a pointer
//!   entry reports `Pointer` instead;
//! - `Edited`: anything else — the user's (or an agent's) own words.
//!
//! The project tree is attacker-controlled and the user's own: every write
//! here is create-new + `O_NOFOLLOW` ([`create_doc_at`]) except the single
//! upgrade of an untouched `AGENTS.md` ([`upgrade_doc_at`]). Nothing is ever
//! deleted. `AppHandle`-free and unit-testable.

use std::io;
use std::path::Path;

use serde::Serialize;

use crate::commands::projects::write_no_follow;

pub const AGENTS_MD: &str = "AGENTS.md";
pub const README_MD: &str = "README.md";
pub const CLAUDE_MD: &str = "CLAUDE.md";
pub const GEMINI_MD: &str = "GEMINI.md";
pub const REMARKS_MD: &str = "REMARKS.md";

/// The most of a scaffold doc read to tell an untouched template from the
/// user's own text.
const MAX_SCAFFOLD_DOC_BYTES: u64 = 4 << 20;

/// One root doc the scaffold knows.
#[derive(Debug)]
pub struct ScaffoldDoc {
    /// The file's name in the project root, `"AGENTS.md"`.
    pub name: &'static str,
    /// What a create writes.
    pub template: &'static str,
    /// Written for a new project.
    pub default: bool,
    /// Has a "create" ghost row / button (a default doc, or one made on demand).
    pub creatable: bool,
    /// `CLAUDE.md` / `GEMINI.md`: shown nested under `AGENTS.md`, never
    /// written, never rewritten, an untouched one reports [`DocState::Pointer`].
    pub pointer: bool,
    /// Every earlier text Tabtivity shipped for this name, byte for byte, so
    /// an untouched copy written by any older build is still recognised.
    pub history: &'static [&'static str],
}

impl ScaffoldDoc {
    /// The state of this doc given its content as [`read_scaffold_doc`]
    /// returned it (`None` = nothing readable there). Pure.
    pub fn state_of(&self, content: Option<&str>) -> DocState {
        let Some(content) = content else {
            return DocState::Missing;
        };
        if self.is_untouched(content) {
            if self.pointer {
                DocState::Pointer
            } else {
                DocState::Template
            }
        } else {
            DocState::Edited
        }
    }

    /// True when `content` holds nothing of the user's: empty, or the current
    /// template, or an earlier one. Line endings and the text's ends are
    /// ignored — a checkout may have turned the endings to CRLF.
    pub fn is_untouched(&self, content: &str) -> bool {
        let content = content.replace("\r\n", "\n");
        let content = content.trim();
        content.is_empty()
            || content == self.template.trim()
            || self.history.iter().any(|old| old.trim() == content)
    }

    /// True for the one doc a repair rewrites in place when it is still an
    /// untouched earlier template: `AGENTS.md`, whose older texts told agents
    /// things that are no longer true. Every other doc is never rewritten.
    pub fn upgradable(&self) -> bool {
        self.name == AGENTS_MD
    }
}

/// The three states of a catalog entry in a project folder (plus `Pointer`,
/// which an untouched pointer file reports in place of `Template`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DocState {
    Missing,
    Template,
    Edited,
    Pointer,
}

/// A catalog entry as the project's file listing shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocStatus {
    pub name: &'static str,
    pub state: DocState,
    /// The doc this one is shown beneath (`AGENTS.md` for a pointer file);
    /// the listing nests only when that doc is itself shown.
    pub nested_under: Option<&'static str>,
    pub creatable: bool,
    /// A new project is born with it (the catalog's `default`): what the
    /// group's `present/total` summary and the "no scaffold" tag count.
    pub is_default: bool,
}

/// What `AGENTS.md` is written with. Placeholders only: agents load it every
/// session, and it is the user's file from the first write on — rewritten only
/// while still byte-identical to a template Tabtivity shipped (`history`). So
/// nothing about Tabtivity itself goes here (the `tabtivity-send` hint comes
/// from `services::agent_hint` and the session hook), and no pointer files or
/// other docs are named: every CLI Tabtivity wraps reads this file by itself
/// (Gemini through the `context.fileName` Tabtivity sets in its own agent
/// homes).
///
/// Changing this text? Add the old one to `commands/scaffold_history/` first
/// and list it in [`AGENTS_HISTORY`] — a test pins the text.
pub const AGENTS_SCAFFOLD: &str = r#"# Agents

Canonical instructions for every AI coding agent in this project. Write
guidance **here**, and keep it to what an agent would otherwise get wrong: it
is loaded into every session.

## Project

_What this project is, in a sentence or two._

## Running

_Build, run and test commands._

## Conventions

_Layout, style, and anything an agent must not do._

## Boundaries

_What an agent must never touch, and what to ask about first._

## Verify

_How to check that work is done: the tests, linters or build that must pass._
"#;

/// Every earlier `AGENTS_SCAFFOLD`, byte for byte, oldest first, after the
/// bare `# Agents` stub the doc started as. A project scaffolded with one of
/// them still holds that text until someone edits it, and only this list lets
/// a repair tell such an untouched copy from the user's own words.
pub const AGENTS_HISTORY: &[&str] = &[
    "# Agents\n",
    include_str!("../commands/scaffold_history/AGENTS.2026-08-26.md"),
    include_str!("../commands/scaffold_history/AGENTS.2026-08-30.md"),
    include_str!("../commands/scaffold_history/AGENTS.2026-09-05.md"),
    include_str!("../commands/scaffold_history/AGENTS.2026-09-14.md"),
    include_str!("../commands/scaffold_history/AGENTS.2026-09-28.md"),
    include_str!("../commands/scaffold_history/AGENTS.2026-11-13.md"),
];

/// The Claude Code pointer an older build wrote. Never written any more:
/// Claude Code reads `AGENTS.md` itself when no `CLAUDE.md` exists. Kept so
/// a project that holds one is recognised (`Pointer`). `@AGENTS.md` on its own
/// line is Claude Code's import syntax.
const CLAUDE_POINTER: &str = r#"# Claude Context

This project's instructions live in [AGENTS.md](./AGENTS.md); the import below
pulls them in. Write project guidance there, not here — keep this file for
Claude-specific overrides only.

@AGENTS.md

Other agent files: [AGENTS.md](./AGENTS.md) · [GEMINI.md](./GEMINI.md)
"#;

/// The Gemini CLI pointer an older build wrote; see [`CLAUDE_POINTER`].
const GEMINI_POINTER: &str = r#"# Gemini Context

This project's instructions live in [AGENTS.md](./AGENTS.md); the import below
pulls them in. Write project guidance there, not here — keep this file for
Gemini-specific overrides only.

@AGENTS.md

Other agent files: [AGENTS.md](./AGENTS.md) · [CLAUDE.md](./CLAUDE.md)
"#;

/// The navigation hub, created on demand: one file linking the other docs
/// with a line on what each is for. The links are relative, so the markdown
/// viewer's link-following opens each target in-app.
const PROJECT_SCAFFOLD: &str = concat!(r#"# Project Map

Start here. This file links the project's docs with what each is for, so the
project can be navigated from one place. The links are relative and open
in "#, crate::app_name!(), r#"'s markdown viewer.

## Docs

- [README.md](./README.md) — overview: what this project is and how to use it
- [DOCUMENTATION.md](./DOCUMENTATION.md) — reference documentation
- [ROADMAP.md](./ROADMAP.md) — planned direction
- [STATUS.md](./STATUS.md) — current state
- [TODO.md](./TODO.md) — open work items

## Agent instructions

- [AGENTS.md](./AGENTS.md) — canonical instructions for every AI coding agent

## Config

- [.gitignore](./.gitignore) — patterns git ignores (git-backed projects only)

_Add links to your own key files and folders here so this stays the map of
the project._
"#);

/// `PROJECT_SCAFFOLD` as it was when every new project got it, together with
/// the pointer files and `.claude/settings.json` it linked.
const PROJECT_SCAFFOLD_2026_11_13: &str = concat!(r#"# Project Map

Start here. This file links every scaffold file with what it is for, so the
project can be navigated from one place. The links are relative and open
in "#, crate::app_name!(), r#"'s markdown viewer.

## Docs

- [README.md](./README.md) — overview: what this project is and how to use it
- [DOCUMENTATION.md](./DOCUMENTATION.md) — reference documentation
- [ROADMAP.md](./ROADMAP.md) — planned direction
- [STATUS.md](./STATUS.md) — current state
- [TODO.md](./TODO.md) — open work items
- [REMARKS.md](./REMARKS.md) — project-wide remarks attached to files and lines

## Agent instructions

- [AGENTS.md](./AGENTS.md) — canonical instructions for every AI coding agent
- [CLAUDE.md](./CLAUDE.md) — Claude Code pointer; imports AGENTS.md
- [GEMINI.md](./GEMINI.md) — Gemini CLI pointer; imports AGENTS.md

## Config

- [.claude/settings.json](./.claude/settings.json) — Claude Code permissions for this project
- [.gitignore](./.gitignore) — patterns git ignores (git-backed projects only)

_Add links to your own key files and folders here so this stays the map of
the project._
"#);

/// What the remarks feature starts `REMARKS.md` with. Pinned byte for byte to
/// `REMARKS_TEMPLATE` in `src/lib/projects/projectRemarks.ts` by a test.
pub const REMARKS_SCAFFOLD: &str = r#"# Remarks

Per-file remarks. One bullet per remark:
`- [ ] [<path>:<line>](./<path>:<line>) — text`. Line optional, a hint only.
Tick a box to resolve a remark. Everything else in this file is yours.
"#;

/// A bare-heading doc made on demand (`# TODO\n`).
const fn stub(name: &'static str, template: &'static str, default: bool) -> ScaffoldDoc {
    ScaffoldDoc { name, template, default, creatable: true, pointer: false, history: &[] }
}

/// The catalog, in the order a listing shows it.
pub const DOCS: &[ScaffoldDoc] = &[
    ScaffoldDoc {
        name: AGENTS_MD,
        template: AGENTS_SCAFFOLD,
        default: true,
        creatable: true,
        pointer: false,
        history: AGENTS_HISTORY,
    },
    stub(README_MD, "# Project\n", true),
    ScaffoldDoc {
        name: "PROJECT.md",
        template: PROJECT_SCAFFOLD,
        default: false,
        creatable: true,
        pointer: false,
        history: &[PROJECT_SCAFFOLD_2026_11_13],
    },
    stub("TODO.md", "# TODO\n", false),
    stub("ROADMAP.md", "# Roadmap\n", false),
    stub("STATUS.md", "# Status\n", false),
    stub("DOCUMENTATION.md", "# Documentation\n", false),
    ScaffoldDoc {
        name: REMARKS_MD,
        template: REMARKS_SCAFFOLD,
        default: false,
        creatable: false,
        pointer: false,
        history: &[],
    },
    ScaffoldDoc {
        name: CLAUDE_MD,
        template: CLAUDE_POINTER,
        default: false,
        creatable: false,
        pointer: true,
        history: &["# Claude Context\n"],
    },
    ScaffoldDoc {
        name: GEMINI_MD,
        template: GEMINI_POINTER,
        default: false,
        creatable: false,
        pointer: true,
        history: &["# Gemini Context\n"],
    },
];

/// The catalog entry named `name` (a leaf name, exact match), if any.
pub fn doc(name: &str) -> Option<&'static ScaffoldDoc> {
    DOCS.iter().find(|d| d.name == name)
}

/// The entries a new project is written with.
pub fn defaults() -> impl Iterator<Item = &'static ScaffoldDoc> {
    DOCS.iter().filter(|d| d.default)
}

/// A scaffold doc in the project tree as text, `None` for anything else:
/// missing, a link, a FIFO (never waited on — the project list asks this of
/// every project), too large or not UTF-8. `None` is never a template, so
/// nothing that is not a plain file of ours is rewritten.
pub fn read_scaffold_doc(path: &Path) -> Option<String> {
    crate::services::home_io::read_record_capped(path, MAX_SCAFFOLD_DOC_BYTES)
}

/// The state of `doc` in the project folder `dir`.
pub fn state_at(dir: &Path, doc: &ScaffoldDoc) -> DocState {
    doc.state_of(read_scaffold_doc(&dir.join(doc.name)).as_deref())
}

/// True when anything — a file, a folder, a link, dangling or not — sits at
/// `name` in `dir`: what a create keeps, so what counts as "there" for the
/// "no scaffold" tag (`exists()` would call a dangling link missing for good,
/// as no repair ever writes over it).
pub fn present_at(dir: &Path, name: &str) -> bool {
    std::fs::symlink_metadata(dir.join(name)).is_ok()
}

/// The `default` entries with nothing at their name in `dir`.
pub fn missing_defaults_at(dir: &Path) -> Vec<&'static str> {
    defaults().filter(|d| !present_at(dir, d.name)).map(|d| d.name).collect()
}

/// Create `path` with `content` unless something — a file, a folder, a
/// symlink, dangling or not — is already there. Returns whether it was
/// written.
///
/// The never-overwrite rule in one place. An imported tree is attacker-controlled
/// and the user's own, so an `exists()`-then-write pair was two holes: a
/// dangling `CLAUDE.md -> ~/somewhere` passed the check and the write then
/// created the link's target outside the project, and a file appearing between
/// the check and the write was truncated. `create_new` + `O_NOFOLLOW` decide
/// in the one open.
pub fn write_scaffold_file(path: &Path, content: &str) -> io::Result<bool> {
    match write_no_follow(path, content.as_bytes(), true) {
        Ok(()) => Ok(true),
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => Ok(false),
        // Windows will not open a folder as a file at all, so a folder at the
        // name answers "Access is denied" instead of "already exists".
        Err(e) if e.kind() == io::ErrorKind::PermissionDenied && path.symlink_metadata().is_ok_and(|m| m.is_dir()) => {
            Ok(false)
        }
        Err(e) => Err(e),
    }
}

/// Create `doc` from its template in `dir`, never over anything. Returns
/// whether it was written.
pub fn create_doc_at(dir: &Path, doc: &ScaffoldDoc) -> io::Result<bool> {
    write_scaffold_file(&dir.join(doc.name), doc.template)
}

/// Rewrite `doc` to its current template when it is an [`upgradable`] doc
/// still holding an untouched earlier text (or nothing): that text is
/// provably nobody's, so replacing it loses nothing. Returns whether it was
/// rewritten. A link, a FIFO, an edited file: left alone.
///
/// The old file is never opened for writing. The template goes into an
/// exclusively created temporary beside it, the doc is read again, and only if
/// it is still the same inode holding an untouched text does the temporary
/// replace it by `rename` (so a save made in between is kept, not truncated
/// away). The window left is the gap between that last read and the rename.
///
/// [`upgradable`]: ScaffoldDoc::upgradable
pub fn upgrade_doc_at(dir: &Path, doc: &ScaffoldDoc) -> io::Result<bool> {
    upgrade_doc_with(dir, doc, || {})
}

/// [`upgrade_doc_at`] with `between` run after the temporary is written and
/// before the doc is read again: where a test plays the user's save.
fn upgrade_doc_with(dir: &Path, doc: &ScaffoldDoc, between: impl FnOnce()) -> io::Result<bool> {
    upgrade_doc_via(dir, doc, between, write_no_follow)
}

/// [`upgrade_doc_with`] with the temporary's writer as an argument: where a
/// test makes the write fail after the temporary exists, as a full disk does.
fn upgrade_doc_via(
    dir: &Path,
    doc: &ScaffoldDoc,
    between: impl FnOnce(),
    write_temp: impl FnOnce(&Path, &[u8], bool) -> io::Result<()>,
) -> io::Result<bool> {
    if !doc.upgradable() {
        return Ok(false);
    }
    let path = dir.join(doc.name);
    let untouched = |read: Option<(String, FileId)>| match read {
        Some((text, id)) if doc.is_untouched(&text) => Some((text, id)),
        _ => None,
    };
    let Some((existing, id)) = untouched(read_with_id(&path)) else {
        return Ok(false);
    };
    if existing == doc.template {
        return Ok(false);
    }
    let tmp = dir.join(temp_name(doc.name));
    // Create-new + no-follow: a name somebody planted is an error, not a target.
    // Any failure but "the name is taken" may have left a half-written temp
    // (create-new makes the file before the bytes go in): it is ours, so it goes.
    if let Err(err) = write_temp(&tmp, doc.template.as_bytes(), true) {
        if err.kind() != io::ErrorKind::AlreadyExists {
            let _ = std::fs::remove_file(&tmp);
        }
        return Err(err);
    }
    let swapped = (|| {
        copy_permissions(&path, &tmp);
        between();
        if untouched(read_with_id(&path)).is_none_or(|(_, now)| now != id) {
            return Ok(false);
        }
        std::fs::rename(&tmp, &path).map(|()| true)
    })();
    if !matches!(swapped, Ok(true)) {
        let _ = std::fs::remove_file(&tmp);
    }
    swapped
}

/// Which file a read saw: `(device, inode)` — on Windows the volume serial and
/// the NTFS file id — so a doc replaced by another file with the same bytes
/// still reads as changed. (Length and modification time are no stand-in: a
/// same-sized file written within one clock tick matches both.)
type FileId = (u64, u128);

/// [`read_scaffold_doc`] with the identity of the file that was read, taken
/// from the opened descriptor.
fn read_with_id(path: &Path) -> Option<(String, FileId)> {
    use std::io::Read;
    let file = crate::services::home_io::open_regular(path)?;
    let id = file_id(&file)?;
    let mut bytes = Vec::new();
    file.take(MAX_SCAFFOLD_DOC_BYTES + 1).read_to_end(&mut bytes).ok()?;
    if bytes.len() as u64 > MAX_SCAFFOLD_DOC_BYTES {
        return None;
    }
    Some((String::from_utf8(bytes).ok()?, id))
}

#[cfg(unix)]
fn file_id(file: &std::fs::File) -> Option<FileId> {
    use std::os::unix::fs::MetadataExt;
    let meta = file.metadata().ok()?;
    Some((meta.dev(), meta.ino() as u128))
}

#[cfg(windows)]
fn file_id(file: &std::fs::File) -> Option<FileId> {
    crate::services::mobile_control::files::handle_identity(file).ok()
}

/// A name for the upgrade's temporary: dot-led, in the doc's own folder.
fn temp_name(name: &str) -> String {
    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    format!(".{name}.{}-{}-{n}.tmp", crate::brand::SLUG, std::process::id())
}

/// The replaced file's permission bits onto its replacement; best effort.
fn copy_permissions(from: &Path, to: &Path) {
    if let Ok(meta) = std::fs::symlink_metadata(from) {
        let _ = std::fs::set_permissions(to, meta.permissions());
    }
}

/// True when `dir`'s `AGENTS.md` holds no project guidance: missing, empty or
/// an untouched template of any build. A link or FIFO there is `Missing`, so
/// also "empty" — and never followed. A plain file this module cannot read
/// (over the cap, not UTF-8) is somebody's text, not an empty doc, so it is not
/// "empty" either (the card this drives asks an agent to fill the file in).
pub fn agents_empty_at(dir: &Path) -> bool {
    let agents = doc(AGENTS_MD).expect("AGENTS.md is in the catalog");
    match state_at(dir, agents) {
        DocState::Template => true,
        DocState::Missing => !std::fs::symlink_metadata(dir.join(agents.name)).is_ok_and(|m| m.is_file()),
        DocState::Edited | DocState::Pointer => false,
    }
}

/// The catalog as the project's file listing shows it, in catalog order: every
/// entry that is there, plus the `creatable` ones that are not (ghost rows).
/// An absent `REMARKS.md` or pointer file is left out.
///
/// Something *there* is never `Missing`, so it never gets a ghost row that a
/// create would refuse: a link (also a dangling one), a FIFO, a non-UTF-8 or
/// over-cap file — anything [`read_scaffold_doc`] cannot take — is reported as
/// `Edited` ("somebody's, not ours to judge"), with `creatable` as the
/// catalog says; the listing keys its ghost row on `Missing` alone. A folder
/// named like a doc gets no row: the tree already shows the folder.
pub fn docs_status_at(dir: &Path) -> Vec<DocStatus> {
    DOCS.iter()
        .filter_map(|d| {
            let mut state = state_at(dir, d);
            if state == DocState::Missing {
                match std::fs::symlink_metadata(dir.join(d.name)) {
                    Ok(meta) if meta.is_dir() => return None,
                    Ok(_) => state = DocState::Edited,
                    Err(_) => {}
                }
            }
            (state != DocState::Missing || d.creatable).then(|| DocStatus {
                name: d.name,
                state,
                nested_under: d.pointer.then_some(AGENTS_MD),
                creatable: d.creatable,
                is_default: d.default,
            })
        })
        .collect()
}

/// A `.gitignore` section a project gets on top of the generic default when
/// its folder shows that kind of work (`gitignore_sections_at`). Only adds:
/// the generic list (`commands::projects::GITIGNORE_DEFAULT`) already covers
/// Python, Node and Rust build folders and `*.log`.
pub struct GitignoreSection {
    /// The comment line heading the section in a freshly written file.
    pub heading: &'static str,
    pub patterns: &'static [&'static str],
    /// A file name (lower-cased) whose presence marks the kind.
    marks: fn(&str) -> bool,
}

pub const GITIGNORE_SECTIONS: &[GitignoreSection] = &[GitignoreSection {
    heading: "# LaTeX build files",
    patterns: &["*.aux", "*.out", "*.toc", "*.fls", "*.fdb_latexmk", "*.synctex.gz", "*.bbl", "*.blg"],
    marks: |name| name.ends_with(".tex"),
}];

/// Directory entries `gitignore_sections_at` looks at, all folders together.
const SECTION_SCAN_ENTRIES: usize = 2048;
/// Subfolders of the root it also lists (one level down: `chapters/`).
const SECTION_SCAN_SUBDIRS: usize = 32;

/// The [`GITIGNORE_SECTIONS`] whose marker file sits in `dir` or in one of its
/// direct subfolders. The tree is attacker-controlled: only directory
/// listings, never a file read; a link is neither followed nor counted; dot
/// folders and the generic list's build folders are skipped; both the entries
/// and the subfolders looked at are capped. An unreadable folder detects
/// nothing.
pub fn gitignore_sections_at(dir: &Path) -> Vec<&'static GitignoreSection> {
    let mut found = vec![false; GITIGNORE_SECTIONS.len()];
    let mut budget = SECTION_SCAN_ENTRIES;
    let mut subdirs = Vec::new();
    scan_for_sections(dir, &mut found, &mut budget, Some(&mut subdirs));
    for sub in subdirs {
        if found.iter().all(|f| *f) {
            break;
        }
        scan_for_sections(&sub, &mut found, &mut budget, None);
    }
    GITIGNORE_SECTIONS.iter().zip(found).filter(|(_, f)| *f).map(|(s, _)| s).collect()
}

fn scan_for_sections(dir: &Path, found: &mut [bool], budget: &mut usize, mut subdirs: Option<&mut Vec<std::path::PathBuf>>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries {
        if *budget == 0 {
            return;
        }
        *budget -= 1;
        let Ok(entry) = entry else { continue };
        // `DirEntry::file_type` does not follow a link.
        let Ok(kind) = entry.file_type() else { continue };
        let name = entry.file_name().to_string_lossy().to_lowercase();
        if kind.is_file() {
            for (section, hit) in GITIGNORE_SECTIONS.iter().zip(found.iter_mut()) {
                *hit = *hit || (section.marks)(&name);
            }
        } else if kind.is_dir() {
            let skipped = name.starts_with('.')
                || ["node_modules", "target", "dist", "build", "__pycache__"].contains(&name.as_str());
            if let Some(list) = subdirs.as_deref_mut() {
                if !skipped && list.len() < SECTION_SCAN_SUBDIRS {
                    list.push(entry.path());
                }
            }
        }
    }
}

#[cfg(test)]
mod tests;
