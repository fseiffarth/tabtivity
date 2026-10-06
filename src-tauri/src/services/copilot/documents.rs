//! Incremental synchronization and result identity, independent of IPC/processes.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;

pub const MAX_DOCUMENT_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub struct Position { pub line: u32, pub character: u32 }

pub fn position(text: &str) -> Position {
    let line = text.bytes().filter(|b| *b == b'\n').count() as u32;
    let tail = text.rsplit('\n').next().unwrap_or("");
    Position { line, character: tail.encode_utf16().count() as u32 }
}

/// A single minimal replacement expressed in UTF-16. Preserve CRLF and avoid
/// splitting either UTF-8 characters or a CRLF pair at a splice boundary.
pub fn incremental_change(before: &str, after: &str) -> Value {
    let mut start = before.chars().zip(after.chars()).take_while(|(a,b)| a == b)
        .map(|(a,_)| a.len_utf8()).sum::<usize>();
    if start > 0 && before.as_bytes()[start - 1] == b'\r' && before.as_bytes().get(start) == Some(&b'\n') { start -= 1; }
    let mut suffix = before[start..].chars().rev().zip(after[start..].chars().rev())
        .take_while(|(a,b)| a == b).map(|(a,_)| a.len_utf8()).sum::<usize>();
    let end = before.len() - suffix;
    if suffix > 0 && end > start && before.as_bytes()[end - 1] == b'\r' && before.as_bytes().get(end) == Some(&b'\n') { suffix -= 1; }
    json!({"range":{"start":position(&before[..start]), "end":position(&before[..before.len()-suffix])},
        "text":&after[start..after.len()-suffix]})
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DocumentTicket {
    pub uri: String,
    pub editor: String,
    pub client_version: u64,
    pub server_version: u64,
}

/// Notifications to write, in order, before the ticket may be used.
pub type Synchronized = (DocumentTicket, Vec<(&'static str, Value)>);

/// Prose and unclassified text, served only with the project's text consent.
pub fn is_text_language(language: &str) -> bool {
    matches!(language, "plain" | "text" | "plaintext" | "markdown" | "tex" | "latex")
}

/// The editor speaks its highlighter's short ids; the server expects VS Code's
/// language identifiers. Anything already in that form passes through.
fn lsp_language_id(language: &str) -> &str {
    match language {
        "js" => "javascript",
        "jsx" => "javascriptreact",
        "ts" => "typescript",
        "tsx" => "typescriptreact",
        "shell" => "shellscript",
        "markup" => "html",
        "tex" => "latex",
        "plain" | "text" => "plaintext",
        other => other,
    }
}

struct Document { ticket: DocumentTicket, text: String, language: String }

#[derive(Default)]
pub struct Documents { entries: HashMap<String, Document>, revision: u64 }

impl Documents {
    /// Produce notifications under the same session lock used to write them.
    /// `allow_text` is the project's text-file consent; without it Copilot
    /// sees code only.
    pub fn synchronize(&mut self, uri: &str, editor: &str, client_version: u64, text: &str, language: &str,
        allow_text: bool) -> Result<Synchronized, String> {
        if text.len() > MAX_DOCUMENT_BYTES || editor.is_empty() || editor.len() > 128 {
            return Err("copilot_document_limit".into());
        }
        if language.is_empty() || (is_text_language(language) && !allow_text) {
            return Err("copilot_code_only".into());
        }
        let old = self.entries.get(uri);
        if let Some(old) = old {
            if old.ticket.editor == editor && (client_version < old.ticket.client_version ||
                (client_version == old.ticket.client_version && text != old.text)) {
                return Err("copilot_stale_document".into());
            }
        } else if self.entries.len() >= 32 { return Err("copilot_document_limit".into()); }
        self.revision += 1;
        let ticket = DocumentTicket { uri: uri.to_owned(), editor: editor.to_owned(), client_version, server_version: self.revision };
        let mut notifications = Vec::new();
        if old.is_some_and(|old| old.language != language) {
            notifications.push(("textDocument/didClose", json!({"textDocument":{"uri":uri}})));
        }
        if let Some(old) = old.filter(|old| old.language == language) {
            notifications.push(("textDocument/didChange", json!({"textDocument":{"uri":uri,"version":ticket.server_version},
                "contentChanges":[incremental_change(&old.text, text)]})));
        } else {
            notifications.push(("textDocument/didOpen", json!({"textDocument":{"uri":uri,"languageId":lsp_language_id(language),
                "version":ticket.server_version,"text":text}})));
        }
        notifications.push(("textDocument/didFocus", json!({"textDocument":{"uri":uri}})));
        self.entries.insert(uri.to_owned(), Document { ticket: ticket.clone(), text: text.to_owned(), language: language.to_owned() });
        Ok((ticket, notifications))
    }

    pub fn current(&self, ticket: &DocumentTicket) -> bool {
        self.entries.get(&ticket.uri).is_some_and(|doc| doc.ticket == *ticket)
    }

    pub fn close_editor(&mut self, editor: &str) -> Vec<Value> {
        let uris: Vec<_> = self.entries.iter().filter(|(_,doc)| doc.ticket.editor == editor).map(|(uri,_)| uri.clone()).collect();
        uris.into_iter().map(|uri| { self.entries.remove(&uri); json!({"textDocument":{"uri":uri}}) }).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn incremental_ranges_preserve_unicode_and_crlf() {
        assert_eq!(incremental_change("a😀\r\nx", "a😀\r\nβx"), json!({
            "range":{"start":{"line":1,"character":0},"end":{"line":1,"character":0}},"text":"β"}));
        assert_eq!(incremental_change("a😀\r\nx", "a😀\nx"), json!({
            "range":{"start":{"line":0,"character":3},"end":{"line":1,"character":0}},"text":"\n"}));
    }
    #[test]
    fn versions_and_editor_ownership_invalidate_late_responses() {
        let mut docs = Documents::default();
        let (first, messages) = docs.synchronize("file:///one", "editor-a", 3, "one", "rust", false).unwrap();
        assert_eq!(messages[0].0, "textDocument/didOpen");
        assert!(docs.synchronize("file:///one", "editor-a", 2, "old", "rust", false).is_err());
        assert!(docs.synchronize("file:///one", "editor-a", 3, "different", "rust", false).is_err());
        let (second, messages) = docs.synchronize("file:///one", "editor-b", 1, "two", "rust", false).unwrap();
        assert_eq!(messages[0].0, "textDocument/didChange");
        assert!(!docs.current(&first));
        assert!(docs.current(&second));
        assert!(docs.close_editor("editor-a").is_empty());
        assert_eq!(docs.close_editor("editor-b").len(), 1);
        assert!(!docs.current(&second));
    }
    #[test]
    fn text_files_need_the_text_consent() {
        let mut docs = Documents::default();
        for language in ["markdown", "tex", "plain"] {
            assert_eq!(docs.synchronize("file:///notes", "e", 1, "x", language, false).err().as_deref(), Some("copilot_code_only"));
        }
        assert!(docs.synchronize("file:///notes", "e", 1, "x", "", true).is_err());
        let (_, messages) = docs.synchronize("file:///notes", "e", 1, "x", "tex", true).unwrap();
        assert_eq!(messages[0].1["textDocument"]["languageId"], "latex");
        let (_, messages) = docs.synchronize("file:///a.ts", "e", 1, "x", "ts", false).unwrap();
        assert_eq!(messages[0].1["textDocument"]["languageId"], "typescript");
    }
}
