//! A small in-memory clipboard for PDF *pages*, so pages can move between two
//! Tabtivity windows.
//!
//! A detached subwindow (#42) is a separate WebView with its own JS heap, so a drag
//! payload cannot simply be a JavaScript object — the bytes have to cross the
//! process boundary. Tauri events *could* carry them, but an event payload is JSON,
//! and a few MB of page bytes would become a multi-million-element number array on
//! the way out and back. So the events carry only identity and coordinates, and the
//! bytes ride here: the source window extracts the dragged pages into a small PDF and
//! `pdf_clip_set`s it, and whichever window the drop lands in `pdf_clip_get`s it.
//!
//! The same slot backs copy/paste of pages between windows, which is the same
//! problem without the pointer.
//!
//! This is a *transfer* buffer, not the OS clipboard: it holds only what Tabtivity put
//! there, it is not readable by other apps, and it dies with the process. Entries are
//! kept only until `MAX_ENTRIES` newer ones push them out, which bounds the memory a
//! long session can accumulate.

use std::collections::VecDeque;
use std::sync::Mutex;

/// The ceiling on one transfer, so a drag cannot become an unbounded allocation.
///
/// It used to mirror `fs::MAX_BINARY_VIEW_BYTES` and deliberately no longer does:
/// that limit rose once file bytes stopped crossing the IPC bridge as JSON, and this
/// slot's bytes still do (`pdf_clip_set` takes a `Vec<u8>` argument, i.e. one decimal
/// literal per byte in each direction). What is dragged is a handful of *pages* — a
/// few MB even out of a large document — so the old number stays until the transfer
/// itself is moved onto a raw body.
const MAX_CLIP_BYTES: usize = 64 * 1024 * 1024;

/// How many transfers to keep. More than one so a drop can still find its bytes if
/// another drag started meanwhile, but small enough to bound memory.
const MAX_ENTRIES: usize = 4;

/// The page-transfer buffer. Registered as Tauri managed state in `lib.rs`.
#[derive(Default)]
pub struct PdfClipboard {
    inner: Mutex<PdfClipState>,
}

#[derive(Default)]
struct PdfClipState {
    next_token: u64,
    entries: VecDeque<(String, Vec<u8>)>,
}

impl PdfClipboard {
    fn set(&self, bytes: Vec<u8>) -> Result<String, String> {
        if bytes.is_empty() {
            return Err("no pages to transfer".to_string());
        }
        if bytes.len() > MAX_CLIP_BYTES {
            return Err(format!(
                "those pages are too large to transfer ({} MiB; the limit is {} MiB)",
                bytes.len() / (1024 * 1024),
                MAX_CLIP_BYTES / (1024 * 1024)
            ));
        }
        let mut st = self.inner.lock().map_err(|_| "clipboard poisoned")?;
        st.next_token += 1;
        let token = format!("clip{}", st.next_token);
        st.entries.push_back((token.clone(), bytes));
        while st.entries.len() > MAX_ENTRIES {
            st.entries.pop_front();
        }
        Ok(token)
    }

    fn get(&self, token: &str) -> Result<Vec<u8>, String> {
        let st = self.inner.lock().map_err(|_| "clipboard poisoned")?;
        st.entries
            .iter()
            .find(|(t, _)| t == token)
            .map(|(_, b)| b.clone())
            .ok_or_else(|| "those pages are no longer available".to_string())
    }
}

/// Park a one-off PDF (the dragged/copied pages) and return the token naming it.
#[tauri::command]
pub fn pdf_clip_set(
    clipboard: tauri::State<'_, PdfClipboard>,
    bytes: Vec<u8>,
) -> Result<String, String> {
    clipboard.set(bytes)
}

/// Fetch a parked PDF by token. The entry is left in place, so the same transfer can
/// be dropped or pasted more than once (a copy is not consumed by its first use).
#[tauri::command]
pub fn pdf_clip_get(
    clipboard: tauri::State<'_, PdfClipboard>,
    token: String,
) -> Result<Vec<u8>, String> {
    clipboard.get(&token)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_bytes_under_the_token_it_returns() {
        let cb = PdfClipboard::default();
        let token = cb.set(vec![1, 2, 3]).unwrap();
        assert_eq!(cb.get(&token).unwrap(), vec![1, 2, 3]);
    }

    #[test]
    fn a_transfer_can_be_fetched_more_than_once() {
        // A copied page may be pasted repeatedly, so a get must not consume the entry.
        let cb = PdfClipboard::default();
        let token = cb.set(vec![7]).unwrap();
        assert_eq!(cb.get(&token).unwrap(), vec![7]);
        assert_eq!(cb.get(&token).unwrap(), vec![7]);
    }

    #[test]
    fn each_transfer_gets_its_own_token() {
        let cb = PdfClipboard::default();
        let a = cb.set(vec![1]).unwrap();
        let b = cb.set(vec![2]).unwrap();
        assert_ne!(a, b);
        assert_eq!(cb.get(&a).unwrap(), vec![1]);
        assert_eq!(cb.get(&b).unwrap(), vec![2]);
    }

    #[test]
    fn an_unknown_token_errors_rather_than_returning_nothing() {
        let cb = PdfClipboard::default();
        assert!(cb.get("clip404").is_err());
    }

    #[test]
    fn old_transfers_are_evicted_so_memory_stays_bounded() {
        let cb = PdfClipboard::default();
        let first = cb.set(vec![0]).unwrap();
        for i in 1..=MAX_ENTRIES {
            cb.set(vec![i as u8]).unwrap();
        }
        // The oldest has been pushed out; the most recent are still there.
        assert!(cb.get(&first).is_err());
    }

    #[test]
    fn rejects_an_empty_transfer() {
        assert!(PdfClipboard::default().set(vec![]).is_err());
    }

    #[test]
    fn rejects_a_transfer_over_the_size_ceiling() {
        let cb = PdfClipboard::default();
        let err = cb.set(vec![0u8; MAX_CLIP_BYTES + 1]).unwrap_err();
        assert!(err.contains("too large"), "unexpected error: {err}");
    }
}
