# Code Review: Efficiency And Simplification

Scope: full-codebase cleanup review for the current Tauri 2 + React/TypeScript + Rust tree.
This pass focuses on maintainability and small efficiency wins. No item below appears to be an
urgent correctness bug, so priorities are based on duplication, blast radius, and ease of review.

## Recommended First Pass

These changes are small, localized, and likely to reduce future maintenance cost without changing
user-visible behavior.

### 1. Reuse the shared UTC date helper

- Priority: Medium
- File: `src-tauri/src/commands/projects.rs:636`

`projects.rs` defines a private `today_utc()` at lines 643-662 that duplicates
`crate::storage::today_utc()`. Remove the private function and call the shared helper:

```rust
let today = crate::storage::today_utc();
```

This is the cleanest backend cleanup because it removes duplicated date logic entirely.

### 2. Avoid reading icon directories twice

- Priority: Medium
- File: `src-tauri/src/commands/apps.rs:335`

`find_icon_file` calls `fs::read_dir(dir)` once to scan files and again to recurse into
subdirectories. Read the directory once, then make two passes over the collected entries:

```rust
let entries: Vec<_> = fs::read_dir(dir).ok()?.flatten().collect();
for entry in &entries {
    // file-name match
}
for entry in &entries {
    // subdirectory recursion
}
```

This preserves the current "prefer direct file matches before recursion" behavior while halving
directory reads at each level.

### 3. Extract terminal-session save helpers

- Priority: Medium
- File: `src-tauri/src/services/terminal_service.rs:9`

`save_tab_layout` and `save_terminal_session` both:

- load `project.json`
- update `project.tab_layout`
- write `project.json`
- mirror a `TerminalSession` to `.tabtivity/sessions/terminals.json`

Extract a private helper that accepts `active_tab_index`:

```rust
fn write_terminal_session(
    local_file: &str,
    tabs: &[TabEntry],
    active_tab_index: usize,
) -> Result<(), String>
```

Then keep the public functions as compatibility wrappers. `save_tab_layout` should pass `0`;
`save_terminal_session` should pass its real active index.

### 4. Extract terminal-session load helpers

- Priority: Medium
- File: `src-tauri/src/services/terminal_service.rs:69`

`load_tab_layout` and `load_terminal_session` duplicate the same "read
`.tabtivity/sessions/terminals.json`, else fall back to `project.json`" flow. Extract helpers such as:

```rust
fn read_session_file(local_file: &str) -> Option<TerminalSession>
fn read_project_tab_layout(local_file: &str) -> Vec<TabEntry>
```

`load_terminal_session` can return the full session when present and synthesize
`active_tab_index: 0` on fallback. `load_tab_layout` can project out `tab_layout`.

### 5. Share create/import project entry construction

- Priority: Medium
- File: `src-tauri/src/commands/projects.rs:504`
- File: `src-tauri/src/commands/projects.rs:607`

`create_project` and `import_project` duplicate the next-position calculation and construction of
the `extra` map. Extract small helpers:

```rust
fn next_position(list: &ProjectsList) -> u32 {
    list.iter().map(|p| p.position).max().unwrap_or(0) + 10
}

fn project_extra(directory: String, git_type: String) -> HashMap<String, Value> {
    HashMap::from([
        ("directory".to_string(), Value::String(directory)),
        ("git_type".to_string(), Value::String(git_type)),
    ])
}
```

Keep the helper names local to `projects.rs`; this is not worth a new shared abstraction.

### 6. Remove duplicated project-owned window filtering

- Priority: Medium
- File: `src-tauri/src/services/window_service.rs:28`

`project_window_ids` and `project_tracked_ids` use the same filters and differ only in the final
projection. Extract the common iterator:

```rust
fn project_owned_windows<'a>(
    windows: &'a HashMap<String, TrackedWindow>,
    project_id: Option<&str>,
) -> impl Iterator<Item = &'a TrackedWindow> {
    windows
        .values()
        .filter(move |w| w.project_id.as_deref() == project_id)
        .filter(|w| is_project_owned(&w.origin))
}
```

Both public functions then become one projection plus `collect()`.

### 7. Use the existing Ollama HTTP helper for model names

- Priority: Medium
- File: `src-tauri/src/commands/ollama.rs:354`

`list_ollama_models` manually opens a TCP stream and parses the HTTP response even though
`ollama_http()` already exists in the same file and is used by the detailed model listing. Replace
the manual request with:

```rust
pub async fn list_ollama_models() -> Result<Vec<String>, String> {
    let body = ollama_http("GET", "/api/tags", None)?;
    let v: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| format!("ollama json: {e}"))?;
    let models = v["models"]
        .as_array()
        .ok_or("no models field in ollama response")?;
    Ok(models
        .iter()
        .filter_map(|m| Some(m["name"].as_str()?.to_owned()))
        .collect())
}
```

Before applying, confirm `ollama_http()` still maps connection failures to the frontend's expected
`"not_running"` string. If not, preserve that compatibility.

### 8. Extract Ollama wait loop

- Priority: Low
- File: `src-tauri/src/commands/ollama.rs:299`
- File: `src-tauri/src/commands/ollama.rs:323`

`ensure_ollama_running` contains two identical "wait up to 8 seconds, polling every 300 ms" loops.
Extract:

```rust
fn wait_for_ollama(deadline: Instant) -> bool {
    while Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(300));
        if ollama_listening() {
            return true;
        }
    }
    false
}
```

This is a readability cleanup, not a performance issue.

### 9. Avoid repeated lowercase allocation during file sorting

- Priority: Low
- File: `src-tauri/src/commands/projects.rs:326`

The current comparator lowercases names inside each comparison. For larger directories, prefer a
key-based sort:

```rust
result.sort_by_key(|e| (!e.is_dir, e.name.to_lowercase()));
```

This preserves "directories first, then case-insensitive name" ordering and lowers repeated work.

### 10. Memoize installed Ollama names

- Priority: Low
- File: `src/components/layout/ProjectSwitcher.tsx:589`

`installedNames` is recreated on every render:

```tsx
const installedNames = new Set(models.map((m) => m.name));
```

Use `useMemo`:

```tsx
const installedNames = useMemo(() => new Set(models.map((m) => m.name)), [models]);
```

This is a small render cleanup. It matters only while the Ollama panel is open.

### 11. Reduce repeated tab-scope patching

- Priority: Low
- File: `src/stores/tabs.ts:79`

The store repeats this shape six times:

```ts
tabsByScope: { ...s.tabsByScope, [s.scope]: tabs }
```

Add a tiny local helper outside the store initializer:

```ts
function patchScopeTabs(s: TabsStore, tabs: TabEntry[]) {
  return { tabsByScope: { ...s.tabsByScope, [s.scope]: tabs } };
}
```

Then spread it into each `set` result. This is primarily a consistency cleanup.

## Needs Care Before Changing

These are plausible cleanups, but the first draft overstated them or the proposed implementation
could introduce new problems.

### Restore app loops should share behavior, not necessarily return type

- Priority: Low/Medium
- File: `src-tauri/src/commands/apps.rs:412`
- File: `src-tauri/src/services/restore_service.rs:6`

`restore_open_apps` returns `Vec<TrackedWindow>` for the frontend command, while
`restore_project_apps` returns `Vec<String>` registry IDs for runtime session persistence. The loop
body is duplicated, but the public contracts differ.

If this is cleaned up, extract a private helper that returns `Vec<TrackedWindow>` and map to IDs in
`restore_project_apps`. Keep the command payload and response shape unchanged.

### Project path string helpers may not pay for themselves everywhere

- Priority: Low
- File: `src-tauri/src/commands/projects.rs`
- File: `src-tauri/src/commands/downloads.rs`

There are many `.to_string_lossy().to_string()` calls. A helper like this is fine:

```rust
fn path_str(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}
```

However, only apply it where the caller already has a `&Path`. Do not force temporary path joins
through extra references just to use the helper. This should be opportunistic cleanup, not a broad
mechanical rewrite.

### `map_err(|e| e.to_string())` is noisy but explicit

- Priority: Low
- File: `src-tauri/src/commands/projects.rs`

A helper like `fn se<E: Display>(e: E) -> String { e.to_string() }` would reduce repetition, but
`map_err(se)` is also less descriptive. Prefer targeted improvements where errors need context
instead of replacing every occurrence mechanically.

### Batched Zustand subscriptions need measurement

- Priority: Low
- File: `src/components/layout/CenterPanel.tsx:11`

`CenterPanel` uses several `useTabsStore` subscriptions. Replacing them with one `useShallow`
selector is reasonable, but it is not automatically better if it causes the component to subscribe
to broader state than needed.

Consider this only after confirming `zustand/react/shallow` is already available and the selected
fields are all genuinely needed for the same render path.

### Save-on-enter handler extraction may reduce readability

- Priority: Low
- File: `src/components/layout/ProjectSwitcher.tsx:331`
- File: `src/components/layout/ProjectSwitcher.tsx:417`
- File: `src/components/layout/ProjectSwitcher.tsx:490`

The repeated `onBlur`/Enter-save pattern is real, but the handlers capture different values and
types. A generic `makeSaveHandlers` helper could add indirection without much benefit. Leave this
unless more settings fields are added.

### Add comments only where intent is otherwise unclear

- Priority: Low
- File: `src-tauri/src/commands/ollama.rs:107`
- File: `src-tauri/src/services/project_runtime.rs`

`list_ollama_models_detailed` already says `/api/ps` errors are ignored. No extra comment is needed
there unless the wording is made more explicit.

For `project_runtime.rs`, a lock-order comment may be useful if future edits touch those sections,
but avoid comment-only churn unless it clarifies a non-obvious invariant near the lock acquisition.

## Suggested Implementation Order

1. `today_utc` reuse, `find_icon_file`, and terminal-service save/load helpers.
2. Project entry helper extraction and window-service iterator extraction.
3. Ollama `list_ollama_models` refactor, with an explicit check for `"not_running"` compatibility.
4. Low-priority frontend cleanups only if the touched files are already in scope.

## Verification

For code changes from this review, run:

```bash
npm run build
```

```bash
cd src-tauri && cargo test
```

Also run:

```bash
git diff --check
```
