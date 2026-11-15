//! The phone's "Project docs" group: the project root's catalog docs
//! (`services::scaffold`) with the state each is in, and creating one from its
//! template. Names only cross the browser API — the sealed project scope is
//! the folder, the doc is a catalog leaf, and the answer is a status row and
//! the file's sealed listing row, never a path.
//!
//! Two routes use it (`host.rs`): the root listing gains a `docs` array, and
//! `POST …/files/docs?name=<leaf>` creates one doc behind the upload guards
//! (`upload_scope`: session, exact origin, both switches).

use std::{io, path::Path};

use crate::services::scaffold::{self, DocStatus};

/// Why a create made nothing.
#[derive(Debug)]
pub enum CreateError {
    /// Not a catalog doc the phone may create: a path, an unknown name, a
    /// pointer file, `REMARKS.md`. Decided on the name alone.
    NotCreatable,
    /// Something already sits at the name; nothing was touched.
    Exists,
    Io(io::Error),
}

impl CreateError {
    /// The wire code the phone maps to a message (`uploads::UploadError::code`
    /// speaks the same for the matching cases).
    pub fn code(&self) -> &'static str {
        match self {
            CreateError::NotCreatable => "invalid_request",
            CreateError::Exists => "already_exists",
            CreateError::Io(_) => "write_failed",
        }
    }
}

/// Where each catalog doc stands in `root`, in catalog order: every doc that
/// is there, plus the creatable ones that are not (`scaffold::docs_status_at`,
/// the desktop tree's own function).
pub fn status(root: &Path) -> Vec<DocStatus> {
    scaffold::docs_status_at(root)
}

/// Create the catalog doc `name` in `root` from its template: create-new and
/// no-follow, so nothing is overwritten and no link is followed. `name` is
/// matched against the catalog's leaves, never joined as given.
pub fn create(root: &Path, name: &str) -> Result<(), CreateError> {
    let doc = scaffold::doc(name).filter(|doc| doc.creatable).ok_or(CreateError::NotCreatable)?;
    match scaffold::create_doc_at(root, doc) {
        Ok(true) => Ok(()),
        Ok(false) => Err(CreateError::Exists),
        Err(error) => Err(CreateError::Io(error)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::scaffold::DocState;

    #[test]
    fn a_catalog_name_is_created_once_and_never_overwritten() {
        let tmp = tempfile::tempdir().unwrap();
        create(tmp.path(), "TODO.md").unwrap();
        assert!(std::fs::read_to_string(tmp.path().join("TODO.md")).unwrap().contains("TODO"));
        std::fs::write(tmp.path().join("TODO.md"), "mine").unwrap();
        assert!(matches!(create(tmp.path(), "TODO.md"), Err(CreateError::Exists)));
        assert_eq!(std::fs::read_to_string(tmp.path().join("TODO.md")).unwrap(), "mine");
    }

    #[test]
    fn only_a_creatable_catalog_leaf_is_taken() {
        let tmp = tempfile::tempdir().unwrap();
        let nested = Path::new("sub").join("x.md").to_string_lossy().into_owned();
        let names = ["", "..", "../x.md", "sub/x.md", nested.as_str(), "x.md", "todo.md", "CLAUDE.md", "GEMINI.md", "REMARKS.md", ".gitignore", "TODO.md "];
        for name in names {
            assert!(matches!(create(tmp.path(), name), Err(CreateError::NotCreatable)), "{name:?}");
        }
        assert_eq!(std::fs::read_dir(tmp.path()).unwrap().count(), 0, "nothing was written");
    }

    #[test]
    fn the_status_marks_the_defaults_and_offers_the_rest_as_ghosts() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("README.md"), "# mine\n").unwrap();
        let rows = status(tmp.path());
        let row = |name: &str| rows.iter().find(|row| row.name == name).cloned().unwrap();
        assert_eq!(row("README.md").state, DocState::Edited);
        assert!(row("README.md").is_default && row("AGENTS.md").is_default);
        assert!(row("AGENTS.md").creatable && row("AGENTS.md").state == DocState::Missing);
        assert!(!row("TODO.md").is_default && row("TODO.md").creatable);
    }
}
