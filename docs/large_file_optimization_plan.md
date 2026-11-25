# Large file simplification and optimization plan

Start with the Ollama cleanup mismatch. It has an observable correctness issue and a small test fixture. Measure headless phone polling and mail ingestion before changing either path. The last two changes address unnecessary React renders and duplicated tab-store updates. Each of the five changes can be implemented and reviewed independently.

## 1. Unify Ollama partial-download cleanup

Deleting an orphaned layer recognizes the main `-partial` file and numeric chunk files such as `-partial-15`. Deleting a paused model also matches malformed siblings such as `-partial-x` and `-partial-`. The orphan-cleanup tests already specify which names are valid. [Orphan cleanup](../src-tauri/src/commands/ollama.rs#L797) · [Paused-model cleanup](../src-tauri/src/commands/ollama.rs#L946) · [Filename tests](../src-tauri/src/commands/ollama/tests.rs#L416)

1. Extract one filename parser that returns the exact blob stem for a main partial or a numeric chunk. Use it in both deletion paths. Retain the paused-model path’s set of requested digests so each directory is scanned once.
2. Keep the existing caller-specific checks. Orphan cleanup validates the selected file’s parent directory. Paused-model cleanup limits deletion to digests from the model’s registry manifest.
3. Exercise both selection paths in a temporary directory with a main partial, numeric chunks, malformed suffixes, and a second digest sharing the first digest’s prefix.

**Acceptance.** Both paths select the same files for the same stem. Malformed siblings and files belonging to the other digest survive. The fixture runs without Ollama or elevation.

## 2. Share headless phone polling reads

With the desktop closed, the phone activity endpoint walks the catalog and reads agent state from disk. The project list calls the same path for its status counts. Project detail caches readings for ten seconds, but a cache miss computes them while holding the shared readings mutex. [Activity handler](../src-tauri/src/services/mobile_control/host.rs#L1260) · [Catalog walk](../src-tauri/src/services/mobile_control/headless.rs#L581) · [Reading cache](../src-tauri/src/services/mobile_control/headless.rs#L635)

1. Build a fixture with several projects and agent tabs. Request the project list, activity list, and one project detail in succession. Record transcript-read counts and request latency separately. Repeat inside the existing cache lifetime and again after expiry.
2. Reuse per-project readings across all three headless paths. On a miss, release the cache lock before dispatching filesystem work to a blocking worker. Reacquire it only to publish the result. Fetch status counts only for listed projects that need them.
3. Scope reuse to the current resolved tabs and sessions. Cover a phone with access to fewer projects, a changed tab set, an expired entry, and a completed turn marked seen. Overlap two requests and check that an older read finishing late cannot overwrite newer state. [Phone-scope test](../src-tauri/src/services/mobile_control/host/tests.rs#L7507)

**Acceptance.** A warm list → activity → detail sequence adds zero transcript walks for unchanged projects. Cold reads run outside the async request thread and shared mutex. Compare status, prompt visibility, and ordering with the existing responses.

## 3. Consolidate mail header ingestion and evaluate batching

Sync and search backfill already share header conversion. Both then retain the local message ID, upsert the header, and record its reply key. Each operation acquires the SQLite connection lock separately. Sync uses insertion results to identify arrivals for filing. Search uses them to update indexed and unread counts. [Header conversion](../src-tauri/src/commands/mail.rs#L1223) · [Sync](../src-tauri/src/commands/mail.rs#L2448) · [Search backfill](../src-tauri/src/commands/mail.rs#L2725)

1. Measure first sync, an unchanged 200-header resync, and search backfill using temporary plain and encrypted stores. During each run, measure the wait for a concurrent header-list read. This captures the cost a larger transaction could impose on someone opening the inbox.
2. Give the store one ingestion operation that returns the retained local ID and whether the row was inserted. Reuse existing SQL, encryption, and mark handling under a borrowed connection. Keep the pre-insertion UID watermark, arrival-only filing, and classifier budget in sync. Keep inserted/unseen counts and partial-result handling in search. [Store methods](../src-tauri/src/services/mail/mail_store.rs#L1077)
3. Compare per-header and bounded-batch transactions on the same fixtures. Exercise a failure partway through ingestion followed by a retry. Check the resulting counters as well as the rows. Cover a moved message, a manual mark, initial backlog, a genuine new arrival, and repeated backfill. [Existing watermark and backfill tests](../src-tauri/src/services/mail/mail_store/tests.rs#L282)

**Acceptance.** Both callers use the same ingestion code. IDs, threading, marks, and counts survive interruption and retry in both store modes. Adopt larger batches only if repeated runs show a throughput gain and the concurrent-read measurements justify the tradeoff.

## 4. Narrow file-tree and phone terminal renders

**Desktop document rows.** The file tree allocates a fresh document-state object for each visible document row and a fresh create callback for each ghost row. Pass state and nesting as primitive props. Give ghost rows a stable callback that acts on the current project and directory. Extend the render-count fixture with an expanded docs group containing both row types. Hovering should leave unrelated rows alone, changing document state should update the badge, and create after navigation should target the current folder. [Row rendering](../src/components/files/FileTree.tsx#L3359) · [Render-count test](../src/__tests__/files/FileTreeRowMemo.test.tsx)

**Phone subagent working row.** The elapsed-time interval updates state in the top-level terminal screen every second while a timed subagent is working. Move ownership of the clock into the working row or its elapsed-time label. Pass the start time down and preserve token text, translation, and the Stop action. Advance a fake clock and verify that the label advances, the surrounding transcript skips the tick render, and the interval is cleared when the row disappears. [Elapsed-time state](../mobile-web/src/screens/Terminal.tsx#L2725) · [Mobile subagent tests](../src/__tests__/mobile/MobileTerminalSubagents.test.tsx)

## 5. Share the final step of detaching a tab or pane

The two actions decide differently whether a move is valid and what the destination contains. Once those decisions are made, both replace the source subtree, append a destination, and open the new window. [Detach a tab](../src/stores/tabs.ts#L3047) · [Detach a pane](../src/stores/tabs.ts#L3088)

1. Keep source lookup, lone-tab or lone-pane refusal, active-tab selection, and destination subtree construction in their respective actions.
2. Extract the common final step into a private helper. Allocate the destination ID and label, replace the source subtree and append the destination in one Zustand update, then open the window and return its label.
3. Run both detach suites. Check bounds, active selection, tab payloads, and the surviving source layout. A refused move must leave state intact and open no window. [Tab-detach tests](../src/__tests__/windows/DetachedShiftNewWindow.test.ts) · [Pane-detach tests](../src/__tests__/windows/DetachedPaneDock.test.ts)

## Verification

Run the focused tests for each implementation change and record before/after measurements against the same fixtures. After the last edit, run `git diff --check`, start the repository gates with `scripts/gates-job.sh start`, and collect the result with `scripts/gates-job.sh wait <printed-directory>`. Run `npm run backend:stale` after backend edits and report whether the running binary contains them. Keep the user’s live Tabtivity session running throughout.
