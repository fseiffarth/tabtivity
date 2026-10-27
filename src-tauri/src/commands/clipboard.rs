//! System-clipboard bridge (images in, terminal text out):
//!
//! - **In:** the file tree turns an image already on the OS clipboard into a PNG
//!   file inside the project ([`clipboard_has_image`] / [`save_clipboard_image`]).
//!   The path side reuses `fs`'s relative-path confinement so a paste can only
//!   ever land inside the project root. Files and folders a file manager copied
//!   are listed by [`clipboard_file_paths`]; the tree copies them in through
//!   `fs::import_external_file`, the OS-drop route.
//! - **Out:** [`copy_text_to_clipboard`] puts terminal text on the clipboard:
//!   OSC 52 requests and the user's own copies out of a pane.


use crate::commands::fs::{canonical_or_new, enforce_confinement};

/// Whether the system clipboard currently holds an image. Used to decide if the
/// file tree's context menu should offer "Paste screenshot". Any failure
/// (no clipboard, no image, unsupported platform) reports `false` rather than
/// erroring so the menu simply omits the option.
///
/// Runs on a blocking worker rather than the main thread: on X11 the `arboard`
/// probe stalls while negotiating the clipboard selection (notably when there is
/// *no* image, where it waits out a transfer timeout). A synchronous Tauri
/// command executes on the main thread and would freeze the webview for that
/// whole stall — which made the file-tree context menu take a long time to
/// appear, since it fires this probe as it opens. Keeping the work off-thread
/// lets the menu paint immediately and the "Paste screenshot" item appear once
/// the probe resolves.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn clipboard_has_image() -> bool {
    app_core::rt::spawn_blocking(|| match arboard::Clipboard::new() {
        Ok(mut cb) => cb.get_image().is_ok(),
        Err(_) => false,
    })
    .await
    .unwrap_or(false)
}

/// One file or folder a file manager put on the system clipboard.
#[derive(serde::Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardFile {
    pub path: String,
    pub name: String,
    pub is_dir: bool,
}

/// Most entries [`clipboard_file_paths`] reports; a bigger copy is cut here.
const MAX_CLIPBOARD_FILES: usize = 1000;

/// The files and folders on the system clipboard (a file manager's Copy or
/// Cut: `text/uri-list` on Linux, `CF_HDROP` on Windows, file URLs on macOS),
/// so the file tree's context menu can offer to paste them. A cut is pasted
/// as a copy: the source stays where it is. Like [`clipboard_has_image`] it
/// never errors and runs off the main thread; nothing on the clipboard, or no
/// clipboard, is an empty list.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn clipboard_file_paths() -> Vec<ClipboardFile> {
    app_core::rt::spawn_blocking(|| match arboard::Clipboard::new() {
        Ok(mut cb) => cb.get().file_list().map(|paths| existing_files(&paths)).unwrap_or_default(),
        Err(_) => Vec::new(),
    })
    .await
    .unwrap_or_default()
}

/// The absolute paths that still exist, deduplicated, in clipboard order. A
/// stale entry (deleted since the copy) is dropped rather than offered.
fn existing_files(paths: &[std::path::PathBuf]) -> Vec<ClipboardFile> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for path in paths {
        if out.len() >= MAX_CLIPBOARD_FILES {
            break;
        }
        if !path.is_absolute() || !seen.insert(path.clone()) {
            continue;
        }
        let Ok(meta) = std::fs::metadata(path) else { continue };
        let Some(name) = path.file_name() else { continue };
        out.push(ClipboardFile {
            path: path.to_string_lossy().into_owned(),
            name: name.to_string_lossy().into_owned(),
            is_dir: meta.is_dir(),
        });
    }
    out
}

/// Read the clipboard image and write it as a PNG at `project_dir`/`rel_path`.
/// The destination is confined to the project root and must not already exist.
#[cfg_attr(feature = "desktop", tauri::command)]
pub fn save_clipboard_image(project_dir: String, rel_path: String) -> Result<(), String> {
    let mut cb = arboard::Clipboard::new().map_err(|e| e.to_string())?;
    let img = cb
        .get_image()
        .map_err(|_| "no image on the clipboard".to_string())?;

    let root = std::fs::canonicalize(&project_dir).map_err(|e| e.to_string())?;
    let dest = root.join(&rel_path);
    let dest_c = canonical_or_new(&dest)?;
    enforce_confinement(&root, &dest_c)?;
    if dest_c.exists() {
        return Err(format!("'{}' already exists", dest.display()));
    }
    if let Some(parent) = dest_c.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    let png = encode_png(img.width, img.height, &img.bytes)?;
    // `create_new` + `O_NOFOLLOW`: a file or link that appeared since the
    // check is refused, never overwritten or followed.
    crate::commands::projects::write_no_follow(&dest_c, &png, true).map_err(|e| e.to_string())
}

/// Longest text [`copy_text_to_clipboard`] takes. A terminal's OSC 52 request
/// is capped far below this already (`OSC52_MAX_CHARS`); a longer user copy
/// falls back to the webview. This bounds what the command itself will hold
/// and serve.
const MAX_CLIPBOARD_TEXT: usize = 1 << 20;

fn check_clipboard_text(text: &str) -> Result<(), String> {
    if text.len() > MAX_CLIPBOARD_TEXT {
        return Err("text is too long for the clipboard".to_string());
    }
    Ok(())
}

/// Put text on the system clipboard.
///
/// For a terminal program's OSC 52 copy request (tmux copy-mode, an agent
/// CLI's own copy command) and every copy the user makes in a terminal pane.
/// The webview's `navigator.clipboard` writes only while WebKit still counts a
/// click or key press as being handled: an OSC 52 request arrives with PTY
/// output, so there it was always refused, and even mouse-up copies were
/// dropped now and then — silently. The pane falls back to the webview only
/// when this command fails.
///
/// On Linux the clipboard has no OS-owned store: a thread owns the selection
/// (`.wait()`) until another app takes it over. It reports back
/// once it has a clipboard connection, so a missing clipboard is an error here,
/// but a failure after that (the set itself) is silent. Off the main thread
/// throughout: arboard can stall negotiating with X11 (see [`clipboard_has_image`]).
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn copy_text_to_clipboard(text: String) -> Result<(), String> {
    check_clipboard_text(&text)?;

    #[cfg(target_os = "linux")]
    {
        use arboard::SetExtLinux;
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || match arboard::Clipboard::new() {
            Ok(mut cb) => {
                let _ = tx.send(Ok(()));
                let _ = cb.set().wait().text(text);
            }
            Err(e) => {
                let _ = tx.send(Err(e.to_string()));
            }
        });
        app_core::rt::blocking("clipboard", move || {
            rx.recv()
                .unwrap_or_else(|_| Err("the clipboard thread ended early".to_string()))
        })
        .await?
    }

    #[cfg(not(target_os = "linux"))]
    {
        app_core::rt::blocking("clipboard", move || {
            let mut cb = arboard::Clipboard::new().map_err(|e| e.to_string())?;
            cb.set_text(text).map_err(|e| e.to_string())
        })
        .await?
    }
}

/// Encode raw RGBA8 pixels as a PNG byte buffer.
pub(crate) fn encode_png(width: usize, height: usize, rgba: &[u8]) -> Result<Vec<u8>, String> {
    let expected = width.checked_mul(height).and_then(|p| p.checked_mul(4));
    if expected != Some(rgba.len()) {
        return Err("clipboard image has an unexpected size".to_string());
    }
    let mut out = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut out, width as u32, height as u32);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().map_err(|e| e.to_string())?;
        writer.write_image_data(rgba).map_err(|e| e.to_string())?;
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encode_png_round_trips_dimensions() {
        // 2x1 RGBA image → decodes back to the same dimensions.
        let rgba = vec![255u8, 0, 0, 255, 0, 255, 0, 255];
        let png_bytes = encode_png(2, 1, &rgba).unwrap();
        let decoder = png::Decoder::new(std::io::Cursor::new(png_bytes.as_slice()));
        let reader = decoder.read_info().unwrap();
        let info = reader.info();
        assert_eq!((info.width, info.height), (2, 1));
    }

    #[test]
    fn existing_files_keeps_live_absolute_paths_once() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("notes.txt");
        std::fs::write(&file, "x").unwrap();
        let sub = dir.path().join("data");
        std::fs::create_dir(&sub).unwrap();
        let gone = dir.path().join("gone.txt");
        let relative = std::path::PathBuf::from("notes.txt");

        let got = existing_files(&[file.clone(), gone, relative, sub.clone(), file.clone()]);
        assert_eq!(
            got,
            vec![
                ClipboardFile {
                    path: file.to_string_lossy().into_owned(),
                    name: "notes.txt".into(),
                    is_dir: false,
                },
                ClipboardFile {
                    path: sub.to_string_lossy().into_owned(),
                    name: "data".into(),
                    is_dir: true,
                },
            ]
        );
    }

    #[test]
    fn clipboard_text_is_capped() {
        assert!(check_clipboard_text("hello").is_ok());
        assert!(check_clipboard_text(&"x".repeat(MAX_CLIPBOARD_TEXT)).is_ok());
        assert!(check_clipboard_text(&"x".repeat(MAX_CLIPBOARD_TEXT + 1)).is_err());
    }

    #[test]
    fn encode_png_rejects_size_mismatch() {
        // 3 bytes can't be a 2x1 RGBA image (needs 8).
        assert!(encode_png(2, 1, &[0, 0, 0]).is_err());
    }
}
