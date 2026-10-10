//! The desktop PDF viewer's **Mark up** → **Submit**
//! (`docs/pdf_markup_rounds_plan.md` §2.6): the same submit as the phone's
//! (`services::mobile_control::markup`), named by the project id and the
//! absolute path the viewer opened instead of a sealed token, with each
//! page's layer PNG in the payload rather than uploaded through the inbox
//! first.
//!
//! The project's folder comes from `projects.json` (`remote::project_directory`),
//! never from the in-folder `project.json`; a remote project is refused
//! (`remote::remote_target_for`). The source is only read; the layers and the
//! marked copy land in the project's `.tabtivity/inbox/` — the phone's existing,
//! user-initiated channel, git-ignored by default. Not gated by the phone's
//! `project_files` switch: that is the phone's door, not the desktop's.
//!
//! Errors are wire codes (`MarkupError::code()` plus `project_not_found`,
//! `remote_project`, `markup_failed`) for the frontend to map to text.
//!
//! **Apply marks directly** (`docs/pdf_markup_direct_apply_plan.md`): a
//! Submit with `mode: "apply"` takes an undo snapshot first
//! (`services::markup_rounds`, owned by the project id) and answers which mode
//! the round got; `pdf_markup_undo_settle` / `_preview` / `pdf_markup_undo`
//! settle, show and undo it. Their refusals are `{ code, files, more }`
//! (`PdfMarkupUndoFailure`).

use std::path::{Path, PathBuf};

use base64::Engine as _;
use serde::{Deserialize, Serialize};

use crate::services::markup_rounds;
use crate::services::mobile_control::markup::{self, Anchor, LocalPage, Mark};
use crate::services::remote;

/// One marked page as the viewer sends it.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PdfMarkupPage {
    /// 1-based page number.
    pub n: u32,
    /// The page's size in points after `/Rotate` — the units of `marks`.
    pub size: [f64; 2],
    pub marks: Vec<Mark>,
    /// The page's PNG, standard base64 (no `data:` prefix): the page with its
    /// marks drawn on (`composed`), or the marks alone on a transparent page.
    pub layer_png: String,
    #[serde(default)]
    pub composed: bool,
    /// The page's words each mark is on (`markup::Anchor`).
    #[serde(default)]
    pub anchors: Vec<Anchor>,
}

/// What a submit answers: the prompt to queue into the agent tab and the
/// marked copy's project-relative inbox reference, when one was baked; the
/// mode the round got (`apply` only with an undo snapshot), the snapshot's
/// id, and why a requested `apply` runs as `list` (`markup_rounds::NoUndo`).
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PdfMarkupSubmitted {
    pub prompt: String,
    pub marked: Option<String>,
    pub mode: markup::Mode,
    pub undo: Option<String>,
    pub no_undo: Option<&'static str>,
}

/// The local project folder to submit into, from what `projects.json` says
/// of the project: a remote project or one with no recorded directory is
/// refused. Pure, so the refusals are testable without the state dir.
fn local_root(is_remote: bool, directory: Option<String>) -> Result<PathBuf, &'static str> {
    if is_remote {
        return Err("remote_project");
    }
    directory.filter(|dir| !dir.is_empty()).map(PathBuf::from).ok_or("project_not_found")
}

#[cfg(test)]
fn submit_in(root: &Path, path: &str, pages: Vec<PdfMarkupPage>) -> Result<PdfMarkupSubmitted, String> {
    submit_in_with(root, path, pages, None, None, None)
}

/// A `list` Submit, as before the **Apply marks directly** switch.
#[cfg(test)]
fn submit_in_with(
    root: &Path,
    path: &str,
    pages: Vec<PdfMarkupPage>,
    instruction: Option<String>,
    ask: Option<u8>,
    round: Option<String>,
) -> Result<PdfMarkupSubmitted, String> {
    let list = markup::UndoRequest { mode: markup::Mode::List, target: Err(markup_rounds::NoUndo::Failed) };
    submit_in_with_undo(root, path, pages, instruction, ask, round, list)
}

/// Decodes the payload and runs the shared core. Blocking (file reads, the
/// bake, inbox writes, an `apply` round's snapshot). `instruction`: the
/// desktop's own Mark up prompt setting; `None` or blank is the mode's
/// default. `ask`: its asking dial (`markup::ASK_LINES`); `None` is
/// `DEFAULT_ASK`. `undo`: the switch's mode and where the snapshot goes.
fn submit_in_with_undo(
    root: &Path,
    path: &str,
    pages: Vec<PdfMarkupPage>,
    instruction: Option<String>,
    ask: Option<u8>,
    round: Option<String>,
    undo: markup::UndoRequest,
) -> Result<PdfMarkupSubmitted, String> {
    if pages.is_empty() || pages.len() > markup::MAX_PAGES {
        return Err(markup::MarkupError::Invalid.code().into());
    }
    let mut local = Vec::with_capacity(pages.len());
    for page in pages {
        // Bound the text before decoding it: base64 is 4 bytes per 3.
        if page.layer_png.len() > markup::MAX_LAYER_BYTES / 3 * 4 + 4 {
            return Err(markup::MarkupError::InvalidLayer.code().into());
        }
        let layer_png = base64::engine::general_purpose::STANDARD
            .decode(page.layer_png.as_bytes())
            .map_err(|_| markup::MarkupError::InvalidLayer.code().to_string())?;
        local.push(LocalPage { n: page.n, size: page.size, marks: page.marks, layer_png, composed: page.composed, anchors: page.anchors });
    }
    markup::submit_local_with_undo(root, Path::new(path), local, instruction, ask, round, undo)
        .map(|done| PdfMarkupSubmitted {
            prompt: done.prompt,
            marked: done.marked,
            mode: done.mode,
            undo: done.undo,
            no_undo: done.no_undo.map(markup_rounds::NoUndo::code),
        })
        .map_err(|error| error.code().into())
}

/// `pdf_markup_submit({ projectId, path, pages, instruction?, ask?, round?, mode? })` →
/// `{ prompt, marked, mode, undo, noUndo }`. `round` is the id the viewer
/// minted for this Submit (`markup::valid_round`), under which the agent
/// ticks marks off. `mode`: `"apply"` (the **Apply marks directly** switch,
/// `Settings::pdf_markup_direct`) or `"list"`; absent is `list`.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn pdf_markup_submit(
    project_id: String,
    path: String,
    pages: Vec<PdfMarkupPage>,
    instruction: Option<String>,
    ask: Option<u8>,
    round: Option<String>,
    mode: Option<markup::Mode>,
) -> Result<PdfMarkupSubmitted, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = local_root(
            remote::remote_target_for(&project_id).is_some(),
            remote::project_directory(&project_id),
        )?;
        let state_dir = crate::storage::state_dir();
        let undo = markup::UndoRequest {
            mode: mode.unwrap_or_default(),
            target: Ok(markup::UndoTarget { state_dir: &state_dir, owner: desktop_owner(&project_id) }),
        };
        submit_in_with_undo(&root, &path, pages, instruction, ask, round, undo)
    })
    .await
    .map_err(|_| "markup_failed".to_string())?
}

/// The owner a desktop Submit's undo snapshot is recorded under.
fn desktop_owner(project_id: &str) -> markup_rounds::Owner {
    markup_rounds::Owner::Desktop { project: project_id.to_string() }
}

/// A refused settle, preview or undo: `markup_rounds::RoundError::code()`
/// (`round_not_found`, `undo_gone`, `undo_not_ready`, `undo_conflict`,
/// `undo_failed`, or `markup_failed` when the task died), and for
/// `undo_conflict` the project-relative files changed since and how many more.
#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct PdfMarkupUndoFailure {
    pub code: &'static str,
    pub files: Vec<String>,
    pub more: usize,
}

impl From<markup_rounds::RoundError> for PdfMarkupUndoFailure {
    fn from(error: markup_rounds::RoundError) -> Self {
        let code = error.code();
        match error {
            markup_rounds::RoundError::Conflict { files, more } => PdfMarkupUndoFailure { code, files, more },
            _ => PdfMarkupUndoFailure { code, files: Vec::new(), more: 0 },
        }
    }
}

/// Runs one round call off the async runtime under the desktop owner.
async fn round_call<T: Send + 'static>(
    project_id: String,
    undo_id: String,
    call: fn(&Path, &str, &markup_rounds::Owner) -> Result<T, markup_rounds::RoundError>,
) -> Result<T, PdfMarkupUndoFailure> {
    tauri::async_runtime::spawn_blocking(move || {
        call(&crate::storage::state_dir(), &undo_id, &desktop_owner(&project_id)).map_err(PdfMarkupUndoFailure::from)
    })
    .await
    .map_err(|_| PdfMarkupUndoFailure { code: "markup_failed", files: Vec::new(), more: 0 })?
}

/// `pdf_markup_undo_settle({ projectId, undoId })` → `null`: the round's
/// after-snapshot, each time its turn finishes (the last one wins).
#[tauri::command]
pub async fn pdf_markup_undo_settle(project_id: String, undo_id: String) -> Result<(), PdfMarkupUndoFailure> {
    round_call(project_id, undo_id, markup_rounds::settle).await
}

/// `pdf_markup_undo_preview({ projectId, undoId })` → `{ files: [{ path,
/// change }], more, pdf }`: what an undo would put back (settles first when
/// the round has not).
#[tauri::command]
pub async fn pdf_markup_undo_preview(project_id: String, undo_id: String) -> Result<markup_rounds::Changes, PdfMarkupUndoFailure> {
    round_call(project_id, undo_id, markup_rounds::preview).await
}

/// `pdf_markup_undo({ projectId, undoId })` → `{ files, more, pdf }`, or
/// `{ code: "undo_conflict", files, more }` with nothing changed.
#[tauri::command]
pub async fn pdf_markup_undo(project_id: String, undo_id: String) -> Result<markup_rounds::Changes, PdfMarkupUndoFailure> {
    round_call(project_id, undo_id, markup_rounds::undo).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::mobile_control::markup::{Color, MAX_PROMPT_BYTES};
    use crate::services::mobile_control::{inbox, markup_pdf, outbox};
    use std::fs;

    /// A minimal PNG head: signature + a 1200×1553 `IHDR` (+ a fake CRC).
    fn png() -> Vec<u8> {
        let mut bytes = b"\x89PNG\r\n\x1a\n\0\0\0\x0dIHDR".to_vec();
        bytes.extend_from_slice(&1200u32.to_be_bytes());
        bytes.extend_from_slice(&1553u32.to_be_bytes());
        bytes.extend_from_slice(&[8, 6, 0, 0, 0, 0, 0, 0, 0]);
        bytes
    }

    fn b64(bytes: &[u8]) -> String {
        base64::engine::general_purpose::STANDARD.encode(bytes)
    }

    fn ink() -> Mark {
        Mark::Ink { color: Color::Red, width: 2.0, points: vec![[10.0, 10.0, 0.5], [20.0, 20.0, 0.6]] }
    }

    fn page(n: u32) -> PdfMarkupPage {
        PdfMarkupPage { n, size: [600.0, 800.0], marks: vec![ink()], layer_png: b64(&png()), composed: false, anchors: vec![] }
    }

    /// A local project with a three-page PDF at `docs/draft.pdf`.
    fn project() -> (tempfile::TempDir, PathBuf, Vec<u8>) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        fs::create_dir_all(root.join("docs")).unwrap();
        let pdf = markup_pdf::tests::classic_pdf(&[0, 0, 0], false);
        fs::write(root.join("docs/draft.pdf"), &pdf).unwrap();
        (dir, root, pdf)
    }

    fn inbox_names(root: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(root.join(inbox::INBOX_DIR))
            .map(|entries| entries.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect())
            .unwrap_or_default();
        names.sort();
        names
    }

    fn path_of(root: &Path, rel: &str) -> String {
        root.join(rel).to_string_lossy().into_owned()
    }

    #[test]
    fn the_payload_is_camel_case_and_closed() {
        let body = r#"{"n":2,"size":[612,792],"layerPng":"aGk=","marks":[{"kind":"box","color":"yellow","rect":[1,2,30,4]}]}"#;
        let parsed: PdfMarkupPage = serde_json::from_str(body).unwrap();
        assert_eq!((parsed.n, parsed.layer_png.as_str()), (2, "aGk="));
        for bad in [
            r#"{"n":2,"size":[612,792],"layer_png":"aGk=","marks":[]}"#,
            r#"{"n":2,"size":[612,792],"layerPng":"aGk=","marks":[],"extra":1}"#,
            r#"{"n":2,"size":[612,792],"layerPng":"aGk=","marks":[{"kind":"ink","color":"red","width":2,"points":[[1,2,0.5]],"sent":true}]}"#,
        ] {
            assert!(serde_json::from_str::<PdfMarkupPage>(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn remote_and_unknown_projects_are_refused() {
        assert_eq!(local_root(true, Some("/home/u/p".into())), Err("remote_project"));
        assert_eq!(local_root(false, None), Err("project_not_found"));
        assert_eq!(local_root(false, Some(String::new())), Err("project_not_found"));
        assert_eq!(local_root(false, Some("/home/u/p".into())), Ok(PathBuf::from("/home/u/p")));
    }

    #[test]
    fn a_submit_bakes_into_the_inbox_and_leaves_the_source_alone() {
        let (_dir, root, pdf) = project();
        let before = fs::metadata(root.join("docs/draft.pdf")).unwrap().modified().unwrap();
        let mut p3 = page(3);
        p3.marks.push(Mark::Text { color: Color::Blue, at: [5.0, 5.0], size: 12.0, text: "use the 2024 numbers".into() });
        let done = submit_in(&root, &path_of(&root, "docs/draft.pdf"), vec![p3, page(1)]).unwrap();
        let marked = done.marked.clone().expect("a marked copy");
        assert!(marked.starts_with(concat!(".", crate::app_slug!(), "/inbox/")) && marked.ends_with("-draft-marked.pdf"), "{marked}");
        assert!(fs::read(root.join(&marked)).unwrap().starts_with(&pdf));
        let names = inbox_names(&root);
        assert_eq!(names.len(), 3, "two layers and the marked copy: {names:?}");
        assert!(names.iter().any(|n| n.ends_with("-draft-p1-layer.png")) && names.iter().any(|n| n.ends_with("-draft-p3-layer.png")));
        assert_eq!(fs::read(root.join("docs/draft.pdf")).unwrap(), pdf);
        assert_eq!(fs::metadata(root.join("docs/draft.pdf")).unwrap().modified().unwrap(), before);
        assert!(done.prompt.starts_with("I marked these changes by hand on `docs/draft.pdf`."));
        assert!(done.prompt.contains("- p3: \"use the 2024 numbers\""));
        assert!(done.prompt.ends_with(&format!("{}\n{}", markup::DEFAULT_INSTRUCTION, markup::ask_line(None, markup::Origin::Viewer))), "desktop: default instruction and its viewer asking line, no send-back line");
        assert!(done.prompt.contains(markup::VIEWER_ASK_ONLY) && !done.prompt.contains("if you have it"), "the desktop viewer is never the chat");
        assert!(!done.prompt.contains(&root.to_string_lossy().to_string()), "no absolute path in the prompt");
    }

    #[test]
    fn the_desktop_instruction_replaces_the_default_and_is_bounded() {
        let (_dir, root, _pdf) = project();
        let path = path_of(&root, "docs/draft.pdf");
        let done = submit_in_with(&root, &path, vec![page(1)], Some("Fix only the typos.".into()), Some(4), None).unwrap();
        assert!(done.prompt.ends_with(&format!("Fix only the typos.\n{}", markup::ASK_LINES[4])));
        assert!(!done.prompt.contains(markup::DEFAULT_INSTRUCTION));
        let blank = submit_in_with(&root, &path, vec![page(1)], Some("  \n ".into()), None, None).unwrap();
        assert!(blank.prompt.ends_with(&format!("{}\n{}", markup::DEFAULT_INSTRUCTION, markup::ask_line(None, markup::Origin::Viewer))));
        let before = inbox_names(&root).len();
        let long = "x".repeat(markup::MAX_INSTRUCTION + 1);
        assert_eq!(submit_in_with(&root, &path, vec![page(1)], Some(long), None, None), Err("invalid_markup".into()));
        assert_eq!(submit_in_with(&root, &path, vec![page(1)], None, Some(5), None), Err("invalid_markup".into()));
        assert_eq!(inbox_names(&root).len(), before, "a refused instruction or dial writes nothing");
    }

    #[test]
    fn the_same_marks_give_the_sidecar_prompt() {
        let (_dir, root, _pdf) = project();
        let mut p2 = page(2);
        p2.marks.push(Mark::Text { color: Color::Black, at: [5.0, 5.0], size: 12.0, text: "tighten\nthis".into() });
        let marks = p2.marks.clone();
        let desktop = submit_in(&root, &path_of(&root, "docs/draft.pdf"), vec![p2]).unwrap();
        let layer = inbox_names(&root).into_iter().find(|n| n.ends_with("-p2-layer.png")).unwrap();
        let phone = markup::MarkupRequest {
            source: markup::MarkupSource::Files("tok".into()),
            pages: vec![markup::MarkupPage {
                n: 2,
                size: [600.0, 800.0],
                marks,
                layer: format!("{}/{layer}", inbox::INBOX_DIR),
                composed: false,
                anchors: vec![],
            }],
            picture: None,
            instruction: None,
            ask: None,
            round: None,
            mode: markup::Mode::List,
            // The phone's markup view without a chat to send to, like the desktop's.
            origin: markup::Origin::Viewer,
        };
        markup::validate(&phone).unwrap();
        let sidecar = markup::submit(&root, &markup::ResolvedSource::Files("docs/draft.pdf".into()), &phone, false).unwrap();
        let (a, b) = (desktop.marked.unwrap(), sidecar.marked.unwrap());
        assert_ne!(a, b, "each submit bakes its own copy");
        assert_eq!(desktop.prompt.replace(&a, "M"), sidecar.prompt.replace(&b, "M"));
    }

    #[test]
    fn an_outbox_path_reads_as_an_outbox_source() {
        let (_dir, root, pdf) = project();
        fs::create_dir_all(root.join(outbox::OUTBOX_DIR)).unwrap();
        fs::write(root.join(outbox::OUTBOX_DIR).join("20261001-090000-paper.pdf"), &pdf).unwrap();
        let done = submit_in(&root, &path_of(&root, concat!(".", crate::app_slug!(), "/outbox/20261001-090000-paper.pdf")), vec![page(1)]).unwrap();
        assert!(done.prompt.contains(concat!("`.", crate::app_slug!(), "/outbox/20261001-090000-paper.pdf`")));
        assert!(done.marked.unwrap().ends_with("-paper-marked.pdf"), "named after the send-stamp-free stem");
    }

    #[test]
    fn paths_outside_hidden_or_linked_are_refused_before_any_write() {
        let (_dir, root, pdf) = project();
        let elsewhere = tempfile::tempdir().unwrap();
        fs::write(elsewhere.path().join("x.pdf"), &pdf).unwrap();
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::write(root.join(".git/x.pdf"), &pdf).unwrap();
        fs::create_dir_all(root.join(inbox::INBOX_DIR)).unwrap();
        fs::write(root.join(concat!(".", crate::app_slug!(), "/inbox/x.pdf")), &pdf).unwrap();
        let outside = elsewhere.path().join("x.pdf").to_string_lossy().into_owned();
        let cases: Vec<(String, &str)> = vec![
            (outside, "outside_project"),
            (path_of(&root, "docs/../../x.pdf"), "outside_project"),
            ("docs/draft.pdf".into(), "outside_project"),
            (root.to_string_lossy().into_owned(), "file_not_found"),
            (path_of(&root, ".git/x.pdf"), "hidden_path"),
            (path_of(&root, concat!(".", crate::app_slug!(), "/inbox/x.pdf")), "hidden_path"),
            (path_of(&root, ".env.pdf"), "hidden_path"),
            (path_of(&root, "docs/missing.pdf"), "file_not_found"),
        ];
        for (path, code) in &cases {
            assert_eq!(submit_in(&root, path, vec![page(1)]), Err(code.to_string()), "{path}");
        }
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(elsewhere.path(), root.join("linked")).unwrap();
            std::os::unix::fs::symlink(elsewhere.path().join("x.pdf"), root.join("docs/leaf.pdf")).unwrap();
            for rel in ["linked/x.pdf", "docs/leaf.pdf"] {
                assert_eq!(submit_in(&root, &path_of(&root, rel), vec![page(1)]), Err("file_not_found".into()), "{rel}");
            }
        }
        assert_eq!(inbox_names(&root), vec!["x.pdf".to_string()], "nothing written by a refused submit");
    }

    #[test]
    fn a_non_pdf_source_is_refused_before_any_write() {
        let (_dir, root, _pdf) = project();
        fs::write(root.join("docs/notes.txt"), "plain").unwrap();
        fs::write(root.join("docs/plot.png"), png()).unwrap();
        for rel in ["docs/notes.txt", "docs/plot.png"] {
            assert_eq!(submit_in(&root, &path_of(&root, rel), vec![page(1)]), Err("unsupported_source".into()), "{rel}");
        }
        assert!(inbox_names(&root).is_empty());
    }

    #[test]
    fn layers_must_be_pngs() {
        let (_dir, root, _pdf) = project();
        let path = path_of(&root, "docs/draft.pdf");
        let mut gif = page(1);
        gif.layer_png = b64(b"GIF89a not a png at all, padded out past the head");
        let mut not_b64 = page(1);
        not_b64.layer_png = "%%%".into();
        let mut huge = page(1);
        let mut bytes = png();
        bytes[16..20].copy_from_slice(&100_000u32.to_be_bytes());
        huge.layer_png = b64(&bytes);
        let mut oversized = page(1);
        oversized.layer_png = "A".repeat(markup::MAX_LAYER_BYTES / 3 * 4 + 8);
        for bad in [gif, not_b64, huge, oversized] {
            assert_eq!(submit_in(&root, &path, vec![bad]), Err("invalid_layer".into()));
        }
        let mut off_page = page(1);
        off_page.marks = vec![Mark::Ink { color: Color::Red, width: 2.0, points: vec![[700.0, 10.0, 0.5]] }];
        assert_eq!(submit_in(&root, &path, vec![off_page]), Err("invalid_markup".into()));
        assert_eq!(submit_in(&root, &path, vec![]), Err("invalid_markup".into()));
        assert!(inbox_names(&root).is_empty());
    }

    #[test]
    fn three_hundred_noted_pages_stay_under_the_prompt_cap() {
        let pages: Vec<markup::MarkupPage> = (1..=300)
            .map(|n| markup::MarkupPage {
                n,
                size: [600.0, 800.0],
                marks: vec![Mark::Text { color: Color::Blue, at: [5.0, 5.0], size: 12.0, text: format!("note on page {n}: {}", "x".repeat(120)) }],
                layer: format!(concat!(".", crate::app_slug!(), "/inbox/20261002-120000-a-rather-long-draft-name-p{}-layer.png"), n),
                composed: false,
                anchors: vec![],
            })
            .collect();
        let text = markup::prompt(&markup::Prompt {
            source: "docs/paper/draft.pdf",
            picture: false,
            marked: Some(concat!(".", crate::app_slug!(), "/inbox/20261002-120000-draft-marked.pdf")),
            failure: None,
            pages: &pages,
            sources: &Default::default(),
            instruction: None,
            ask: None,
            origin: markup::Origin::Chat,
            round: None,
            send_back: true,
        });
        assert!(text.len() <= MAX_PROMPT_BYTES, "{} bytes", text.len());
        assert!(text.contains(concat!("Page 1: @.", crate::app_slug!(), "/inbox/")));
        assert!(text.contains(concat!("more layers, beside these in `.", crate::app_slug!(), "/inbox/`, named `…-p<page>-layer.png`")));
        assert!(text.contains("- p1: \"note on page 1:"));
        assert!(text.contains("more notes — read them in the marked copy."));
        assert!(text.ends_with(concat!("send it to me with `", crate::app_slug!(), "-send <file>`.")));
    }

    #[test]
    fn an_apply_submit_answers_its_mode_and_undo_in_camel_case() {
        let (_dir, root, _pdf) = project();
        let state = tempfile::tempdir().unwrap();
        let path = path_of(&root, "docs/draft.pdf");
        let apply = |state_dir| markup::UndoRequest {
            mode: markup::Mode::Apply,
            target: Ok(markup::UndoTarget { state_dir, owner: desktop_owner("p") }),
        };
        // A folder in no git work tree: list, and why.
        let plain = submit_in_with_undo(&root, &path, vec![page(1)], None, None, None, apply(state.path())).unwrap();
        assert_eq!((plain.mode, plain.undo.as_deref(), plain.no_undo), (markup::Mode::List, None, Some("not_git")));
        let wire = serde_json::to_value(&plain).unwrap();
        assert_eq!((wire["mode"].as_str(), wire["noUndo"].as_str()), (Some("list"), Some("not_git")));
        assert!(wire.get("undo").is_some_and(serde_json::Value::is_null));
        // In a repo: apply, with a snapshot the same owner can settle.
        let ok = std::process::Command::new("git").args(["init", "-q"]).current_dir(&root).env_remove("GIT_DIR").env_remove("GIT_INDEX_FILE").status().unwrap();
        assert!(ok.success());
        let done = submit_in_with_undo(&root, &path, vec![page(1)], None, None, None, apply(state.path())).unwrap();
        assert_eq!((done.mode, done.no_undo), (markup::Mode::Apply, None));
        let id = done.undo.unwrap();
        assert!(done.prompt.contains(markup::DEFAULT_APPLY_INSTRUCTION));
        assert_eq!(markup_rounds::settle(state.path(), &id, &desktop_owner("p")), Ok(()));
        assert_eq!(markup_rounds::settle(state.path(), &id, &desktop_owner("q")), Err(markup_rounds::RoundError::NotFound));
    }

    #[test]
    fn an_undo_conflict_carries_its_files() {
        let conflict = PdfMarkupUndoFailure::from(markup_rounds::RoundError::Conflict { files: vec!["a.tex".into()], more: 2 });
        assert_eq!(serde_json::to_value(&conflict).unwrap(), serde_json::json!({ "code": "undo_conflict", "files": ["a.tex"], "more": 2 }));
        let gone = PdfMarkupUndoFailure::from(markup_rounds::RoundError::Gone);
        assert_eq!((gone.code, gone.files.len(), gone.more), ("undo_gone", 0, 0));
    }
}
