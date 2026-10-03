//! Dictionary spell-check commands (`services::spell`) — deterministic and
//! model-free. Local only: nothing here reaches any network; the dictionaries
//! are files on this machine.

use crate::services::spell;

/// One proofreading issue, the wire shape the editor's overlay resolves (the
/// frontend's `GrammarIssue`). `bad` is the exact offending substring as it
/// appears in the source (so the frontend can locate it); `line` is its 1-based
/// line in the submitted text, used as a resolution hint.
#[derive(serde::Serialize, Clone, PartialEq, Debug)]
pub struct GrammarIssue {
    /// 1-based line number in the submitted text.
    pub line: u32,
    /// The exact offending text as it appears in the source.
    pub bad: String,
    /// Suggested replacement ("" when there is none).
    pub suggestion: String,
    /// Underline category; always "spelling" from this provider.
    pub category: String,
    /// Short explanation; empty — the backend writes no display text.
    pub message: String,
}

/// Check `text` against the Hunspell dictionary for `language` (a code like
/// `en_US`; empty picks the default — an English variant when installed).
/// `doc` is the editor's highlight language (`"tex"`/`"markdown"`/…) and only
/// selects the prose masking. Errors are strings; `no_dictionary` is the token
/// the frontend renders as "install a dictionary".
#[tauri::command]
pub async fn spell_check(
    text: String,
    language: String,
    doc: String,
) -> Result<Vec<GrammarIssue>, String> {
    app_core::rt::spawn_blocking(move || spell::check(&text, &language, &doc))
        .await
        .map_err(|e| format!("spell task failed: {e}"))?
        .map(|issues| {
            issues
                .into_iter()
                .map(|i| GrammarIssue {
                    line: i.line,
                    bad: i.bad,
                    suggestion: i.suggestion,
                    category: "spelling".into(),
                    // No prose message: the backend writes no display text, so
                    // nothing here needs translating. The category + suggestion
                    // carry the tooltip.
                    message: String::new(),
                })
                .collect()
        })
}

/// The installed dictionary language codes (system dirs + the state dir's
/// `dictionaries/` folder), for the settings dropdown.
#[tauri::command]
pub async fn spell_languages() -> Result<Vec<String>, String> {
    app_core::rt::spawn_blocking(|| {
        spell::available_languages_in(&spell::dict_dirs())
    })
    .await
    .map_err(|e| format!("spell task failed: {e}"))
}

/// Add a word to the personal dictionary (append-only
/// `<state_dir>/dictionaries/personal.dic`, folded into every language).
#[tauri::command]
pub async fn spell_add_word(word: String) -> Result<(), String> {
    app_core::rt::spawn_blocking(move || spell::add_personal_word(&word))
        .await
        .map_err(|e| format!("spell task failed: {e}"))?
}

/// What the dictionary picker needs in one round trip: every installed
/// dictionary (with whether it can be removed from here) and the downloadable
/// catalog. Display names are computed in the frontend, in the UI language.
#[derive(serde::Serialize)]
pub struct SpellDictionaries {
    pub installed: Vec<spell::InstalledEntry>,
    pub catalog: Vec<spell::CatalogEntry>,
}

#[tauri::command]
pub async fn spell_dictionaries() -> Result<SpellDictionaries, String> {
    app_core::rt::spawn_blocking(|| SpellDictionaries {
        installed: spell::installed_in(&spell::dict_dirs()),
        catalog: spell::catalog(),
    })
    .await
    .map_err(|e| format!("spell task failed: {e}"))
}

/// Download a catalog language into the state dir's `dictionaries/` folder.
/// The only network call in this module; `code` must name a catalog entry —
/// nothing else is ever fetched.
#[tauri::command]
pub async fn spell_install_language(code: String) -> Result<(), String> {
    spell::install_language(&code).await
}

/// Delete a dictionary pair from the state dir (never a system one).
#[tauri::command]
pub async fn spell_remove_language(code: String) -> Result<(), String> {
    app_core::rt::spawn_blocking(move || spell::remove_language(&code))
        .await
        .map_err(|e| format!("spell task failed: {e}"))?
}
