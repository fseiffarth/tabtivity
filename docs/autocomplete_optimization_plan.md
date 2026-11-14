# Autocomplete optimization — plan

Status: plan, reviewed before implementation (2026-11-14). Line numbers are as
of `a70bc3e32`.

Inline ghost-text completion in the native editor has two providers behind one
contract: a local Ollama model (todo #45, shipped) and GitHub Copilot's language
server (#45a, behind the `copilot_completion` flag, never signed in live). Three
read-only investigations on 2026-11-14 covered the editor pipeline, the
local-model backend and the Copilot provider. This plan merges them.

Short names used below: **CE** `src/components/embed/fileViewer/CodeEditor.tsx`,
**OL** `src-tauri/src/commands/ollama.rs`, **TC**
`src-core/src/services/text_completion.rs`, **completion/**
`src/lib/viewers/completion/`, **copilot/** `src-tauri/src/services/copilot/`.
"FIM" is fill-in-the-middle: the model is given the text before and after the
caret in the format it was trained on (`/api/generate` with `suffix`), instead
of a chat instruction.

## What is wrong today

Ranked by effect on the user.

1. **The fast path never runs.** FIM needs a model whose Ollama capabilities
   include `insert`. None of the 8 installed models has it, nothing in the UI
   recommends or pulls one, and with no `autocomplete` role set the editor
   prefers the default model (`editorPrefs.tsx:95`) and otherwise uses whichever
   model is resident (`completion/autocomplete.ts:105-111`), including a 30 B
   agent model. Every completion is a chat prompt.
2. **Even with a FIM model, normal use switches FIM off.** The gate is
   `!prose && insert && context.is_empty() && !suffix.is_empty()` (OL:3424). The
   editor attaches local imports and every other open text tab to every request
   (CE:1822-1835), so the context is rarely empty. A caret at the end of the
   file (empty suffix) also falls to chat.
3. **The chat prompt defeats the model's prompt cache.** Its layout is
   `Language / TASK / references / BEFORE / AFTER` (OL:3201). TASK changes at the
   first character of each line and at every `;` or `:`, so everything after it
   is re-read. The window start also slides one line at a time
   (`completion/autocomplete.ts:4-8`). On this machine prompt reading runs at
   230–415 tokens/s for a 30 B model: about 4.5–8 s for the 1.85 K-token prompt
   without references and 20–37 s with the full 24 KB of references. (Arithmetic
   from measured rates; no request was timed, because no model was loaded.)
4. **References are expensive before the model is even asked.** Up to 16 files
   are read one after another over IPC on every request, uncached, and before
   the completion cache is consulted, because the cache key contains the
   reference text (`completion/completionContext.ts:66-82`,
   `ollamaCompletionProvider.ts:51-52`). The cap counts candidate paths, so four
   TypeScript imports use it up.
5. **Two confirmed bugs on the chat path.** `clean_completion` strips a leading
   newline (OL:3210), which glues a next-line completion onto the caret line and
   can put generated code inside the comment that asked for it;
   `trim_context_overlap` does the same after an echoed comment (OL:3277).
   `complete_text` posts through its own HTTP client and skips `owner_gate` for
   unlocked projects (OL:3412; every other Ollama call goes through
   `ollama_client.rs:300-301`), so source text can reach another process
   listening on the loopback port.
6. **Nothing can be measured.** The stats count the first typed character that
   matches a ghost as an accept, lump Tab, word, line and type-through together,
   count a ghost shown for milliseconds as a dismiss (CE:1059-1065), and record
   no latency, no shown count and no path (FIM or chat).
7. **Editor irritations.** A ghost replaces the highlighted text with a plain
   copy of the whole document on an opaque background (CE:2636-2647), so syntax
   colour disappears whenever one shows. Every stream token re-renders the
   whole editor. The idle timer fires after deletions, undo and accept, and has
   no IME guard (CE:1875-1881). Plain Right accepts a word (CE:2213-2219).
8. **Copilot cannot be diagnosed or kept signed in.** Server logs and stderr are
   discarded (`copilot/rpc.rs:139-142`, `process.rs:97`). Failed launches use up
   the restart budget, which then hides "not installed" for five minutes
   (`session.rs:567-570`). The card shows "signed in" for an account without
   Copilot access (`CopilotCompletionCard.tsx:108`), although `copilot_account`
   already hands it the server's verdict. The pin is 1.547.0 against
   1.570.0 upstream. Sign-in lives in the server's memory, so it is lost on every
   quit and settings change.

## Fixed decisions

Reviewers may not undo these.

1. **A model with `insert` always uses FIM for code.** An empty suffix is sent
   as `"\n"`, because the published templates take the FIM branch only when
   `.Suffix` is non-empty (checked on the registry for `qwen2.5-coder` 1.5b, 3b
   and 7b). Prose (TeX, Markdown, plain text) stays on the chat path.
2. **References never push a FIM model to chat.** On the FIM path references are
   sent only for model families with a known trained layout, through
   `raw: true` (first row: `qwen2.5-coder`, the `<|file_sep|>` repo layout).
   For any other FIM model they are dropped and the status says so.
3. **Automatic requests carry few references; explicit requests may carry
   more.** Automatic: manual attachments plus the current file's imports, 4 KB
   in total. Explicit (Ctrl+Space): those plus open tabs, up to
   `min(24 KB, 25 % of the model's context length × 3 bytes)`. The backend's
   24 KB cap stays as a guard.
4. **The reference set is frozen per editor** until the file, its import list or
   the manual attachments change, or the user asks explicitly. Order is manual
   attachments, imports in source order, open tabs by path.
5. **`num_ctx` and `keep_alive` stay unset** on completion requests. Ollama's
   scheduler neither unpins nor reloads a model for a request that omits them.
6. **Chat-only models stay allowed**, for automatic requests too. The status
   names the model that answered and the Models hub says when the role holds a
   model without `insert`. Nothing is pulled without a click.
7. **No automatic request directly after an accept, a deletion, undo or redo.**
   Typing or Ctrl+Space asks again.
8. **Stats use new keys.** Old `autocomplete.accept|dismiss.*` history is kept
   and no longer written.
9. **Copilot stays one server per project, Linux only, insert-only.** No next
   edit suggestions against Copilot.
10. **The provider contract is not refactored now.** That waits for a third
    provider.
11. **Metrics travel on a second event**, not a changed return type, so a new
    frontend and an old backend (or the reverse) keep working.

## Decided by the user (2026-11-14)

| Question | Answer | Steps |
|---|---|---|
| May agents pull `qwen2.5-coder:1.5b` (986 MB) and load models briefly to measure? | Yes | B8 |
| May agents download and run the Copilot language server in the fence, without an account? | Yes | B10 |
| "Stay signed in" for Copilot through the OS keychain, opt-in, default off? | Yes | B11, B12, A9 |
| Plain Right stops accepting a word; Ctrl+Right accepts it? | Yes | A7 |

## IPC contract between the two halves

Fixed here so the frontend and backend steps can be built in parallel.

- `complete_text` gains two optional arguments: `trigger: "auto" | "manual"`
  (missing means manual) and `fileName`, the edited file's project-relative
  path for B3's reference layout (missing means the literal `file`). Its return
  value stays the final text.
- New event `text-completion-stats-<requestId>`, emitted to the caller once,
  before `complete_text` returns successfully:

  ```ts
  type CompletionStats = {
    endpoint: "generate" | "chat";
    model: string;
    stop: "done" | "line" | "budget";   // model finished, sentence stop, time budget
    firstTokenMs: number | null;        // request sent to first token
    totalMs: number;
    referenceBytes: number;             // bytes of references actually sent
    referencesDropped: boolean;         // FIM model with no known layout
    promptEvalCount?: number;           // Ollama's final record, when it arrived
    promptEvalMs?: number;
    evalCount?: number;
    evalMs?: number;
    loadMs?: number;
  };
  ```

  The last five are absent when the socket was dropped before Ollama's final
  record (sentence stop, time budget). After a FIM refusal the event describes
  the chat retry; a failed request emits none. `referencesDropped` describes
  the path, not the payload: it is true for every FIM request to a model
  without a known layout, also one that carried no references, so the frontend
  can stop sending them without the value flipping back.
- New command `copilot_diagnostics({ projectId })` returning
  `{ lines: string[] }`: the newest log lines of that project's server, redacted,
  from memory only. It never starts a server.
- One new Copilot error code: `copilot_sign_in_failed`. `copilot_cancelled` and
  `copilot_stale_document` exist already and the editor is already silent for
  them (CE:1853); B9 only routes two more server codes to them.
- `copilot_account` already returns
  `{ running, status: { kind, message }, account: { status, user }, messages }`
  (`commands/copilot.rs:245`, `session.rs:412`): the outer `status` is the last
  `didChangeStatus`, and `account.status` is `OK`, `MaybeOK`, `NotSignedIn` or
  `NotAuthorized`. It gains one field, `remembered: boolean`: a token for this
  app account is in the keychain.
- New setting `copilot_stay_signed_in?: boolean` in `settings.json`, default
  off, written through the ordinary settings path. The backend adds the Rust
  field, the frontend the TypeScript one.
- New setting `autocomplete_delay_ms?: { ollama?: number; copilot?: number }` in
  `settings.json`: the automatic trigger's idle delay per provider, written
  through the ordinary settings path. Missing means the default (600 local, 200
  Copilot). The backend adds the Rust field so it survives a round trip and
  gives it no behaviour; a change to it must not stop Copilot servers.
- New usage-key prefixes, the same strings on both sides:
  `autocomplete.shown.`, `autocomplete.tab.`, `autocomplete.word.`,
  `autocomplete.line.`, `autocomplete.typed.`, `autocomplete.rejected.`,
  `autocomplete.request.`. The frontend adds them to `METRIC`
  (`lib/usageMetrics.ts`), the backend to its mirror
  (`schema/usage_stats.rs::metric`); a parity test between the two passes only
  on the merged tree.

## Steps — backend (Rust)

Each step is one commit with its tests, built in this order: B1, B2, B7, B8
(first run), B3, B4, B5, B6 (second run of B8), B9, B10, B11, B12. B8 reads
B7's counters and has to exist before the two steps it measures.

**B1. Owner gate and policy block.** In `complete_text`, settings load,
`completion_locked`, address resolution, `completion_refusal` and
`owner_gate(&addr)` run in one `app_core::rt::blocking` call before the client
is built, uncached: `locality_at` asks the gate before its own cache on purpose
(`ollama_client.rs:687-691`), and a cached lock verdict would let a project
that was just locked reach a remote host. `owner_gate` accepts addresses on
another machine and, outside Linux, all of them; a unit test cannot make it
refuse, so the block takes the gate as a parameter. Test beside
`the_owner_gate_judges_loopback_listeners_only` (OL:4134): with a refusing gate
and a bound local listener, the block returns `ollama_listener_refused` and the
listener accepts no connection.

**B2. Keep the leading newline.** On the chat path one leading `\n` or `\r\n`
of the raw answer is kept when the prefix does not end in a newline and the
sentence stop is off (`sentence` at OL:3422: Block, Scope or an intent
comment). Under the sentence stop it is stripped as today, because
`completion_stop` (OL:2968) stops at a leading line break and would return
nothing. `clean_completion` has no prefix, so `completion_preview` sets the
line break aside, runs the unchanged wrapper handling on the rest and puts it
back; `trim_context_overlap` keeps one line break where it calls `trim_start`
after an echoed prefix tail (OL:3277). Tests with prefix `// add two numbers`:
raw `"\nfn add…"` keeps the newline, raw `"// add two numbers\nfn add…"`
yields `"\nfn add…"`, raw `"\nHere is the code:\nfn add…"` loses only its
preamble; and a Sentence request without an intent comment still returns `foo`
for raw `"\nfoo"`.

**B3. FIM gate.** `fim = !prose && insert`. Empty suffix becomes `"\n"`. One
pure function chooses endpoint, body and `referencesDropped`; the tests and B8
call it. A small family table keyed on the model name (lower case, between the
last `/` and the `:`; first row: starts with `qwen2.5-coder`) builds a
`raw: true` prompt when references are present: `<|repo_name|>project\n`, then
`<|file_sep|>{name}\n{content}\n` per reference, then
`<|file_sep|>{fileName}\n<|fim_prefix|>{prefix}<|fim_suffix|>{suffix}<|fim_middle|>`.
Raw mode bypasses the model's template, so that body has no `suffix` field and
lists the family's tokens as `stop` strings (`<|endoftext|>`, `<|fim_pad|>`,
`<|file_sep|>`, `<|repo_name|>`, the three FIM tokens, and `"\n"` under the
sentence stop). A reference whose name or content contains one of those tokens
is left out. Without references a known family sends today's `suffix` body.
Other FIM models get no references and report `referencesDropped`. The chat
fallback after a FIM refusal matches `ollama HTTP 400` exactly, not any text
containing "400". Tests: body shape per case (suffix, empty suffix, references
with a known family, with an unknown family, a reference holding a token).
Update the doc comment at OL:3370.

**B4. Chat prompt order.** `completion_prompt` becomes
`Language / references / AFTER / BEFORE / TASK`, so the text that changes while
typing is last. `COMPLETION_SYSTEM` (OL:2907) and the TASK texts name the
sections, never their order, and stay. Two tests assert the old order and are
rewritten (`ollama/tests.rs:1066` and `:1084`); the one at `:1158` (references
before BEFORE) still holds. Add one: TASK is the last section.

**B5. Sampling.** Both paths send `repeat_penalty: 1.0` and
`presence_penalty: 0`; the first candidate sends `top_k: 1`; alternates keep
temperature 0.5 with the model's `top_k`. Test on `completion_body`.

**B6. Time budget.** For `trigger: "auto"`, once the text holds a complete line
(a line break after non-blank text) and the time since the first token passes
the budget (Block 3 s, Scope 6 s; Sentence 1.5 s, reachable only for an intent
comment, where the sentence stop is off), the callback stops the stream and the
text is cut after its last line break. The decision is a pure function of
elapsed time, text and mode, tested in `ollama/tests.rs`; TC's
`semantic_stop_closes_the_socket_without_waiting_for_done` already covers the
dropped socket.

**B7. Stats event.** `text_completion::stream` returns the text together with
Ollama's final record when one arrived (`prompt_eval_count`, `eval_count`, and
`prompt_eval_duration`, `eval_duration`, `load_duration` in nanoseconds). Its
only caller outside TC's tests is `complete_text` (OL:3435), which measures
first-token and total time itself and emits `text-completion-stats-<id>` with
`emit_to_caller`. Test in TC: a finished stream returns its final record, a
semantic stop none.

**B8. Live bench (ignored test).** `TABTIVITY_COMPLETION_BENCH_MODEL=<model>
cargo test -p tabtivity --lib completion_bench -- --ignored --nocapture` replays
a 20-character typing trace through B3's function (`completion_body` before B3
exists) against the local Ollama and prints endpoint, `prompt_eval_count` and
first-token time per request, for 0 and 2 reference files. The variable name
comes from `crate::app_env!` (as at `session.rs:856`), and the test installs
the rustls provider as TC's tests do. It loads nothing itself: it fails with a
clear message when the model is not resident. Run it before B3/B4 and after,
and put both tables in the handoff.

The runs, by hand around the test: note what `/api/ps` lists first; pull
`qwen2.5-coder:1.5b` through the running Ollama (`POST /api/pull`); bench it,
and bench the chat path on the smallest installed chat model (`gemma4:e4b`);
afterwards unload only the models the run itself loaded (`keep_alive: 0`).
B3's `qwen2.5-coder` row stays only if the with-references table shows sensible
completions through the raw layout; otherwise the table ships empty, every FIM
model drops references, and the handoff says so.

**B9. Copilot fixes.**
- Count a start against the restart budget only after `launch` returned a
  process (`session.rs:567-570`). `launch` reads the real install directory, so
  the test passes the launch as a closure: four failing launches return the
  launch error four times, never `copilot_restart_limit`.
- Map `-32802` to `copilot_cancelled`, `-32801` to `copilot_stale_document`,
  1001/1004/1005/1006 to `copilot_sign_in_failed` (`session.rs:62-70`).
- Authorize the document before starting the server
  (`commands/copilot.rs:166-181`): root from `authorize`, then
  `policy::authorize_document` and `inside_locked`, then the launch. The consent
  re-check after the launch stays.
- Keep the last 200 `window/logMessage`, `$/logTrace` and stderr lines per
  project in `Sessions`, not in the session, so they survive a server that died
  or never finished starting; lines cut at 500 characters, `gh[a-z]_…` tokens
  and `Bearer …` redacted. Serve them through `copilot_diagnostics`: registered
  in `lib.rs` beside its siblings (`:2736`), a `Core` row in
  `services::command_class`, `commandClasses.ts` regenerated.
- Forward `http_proxy`, `https_proxy`, `no_proxy` (both cases),
  `NODE_EXTRA_CA_CERTS` and `SSL_CERT_FILE` as the environment of the bwrap
  process (`Command::env` after the `env_clear` at `process.rs:96`), never as
  `--setenv` arguments: an argument list is readable by every local account,
  and a proxy address can hold a password. `--clearenv` (`process.rs:43`) goes
  so the server inherits them; `env_clear` keeps the host environment out, and
  the fence test asserts the exact forwarded set.
- The text consent also applies by file extension (`md`, `markdown`, `mdx`,
  `tex`, `txt`, `rst`), checked on the path `authorize_document` returned; the
  renderer's `language` (`documents.rs:77`) can add to that, never lift it.
- Stop every Copilot server when the AI switch turns off: `invalidate_copilot`
  (`commands/settings.rs:99-105`) already compares the settings around each
  write and compiles in the daemon build; it calls `stop_all_now()` when
  `ai_switch::off_now` becomes true.
- The Rust mirror of the new usage-key prefixes (see the contract).
- The `autocomplete_delay_ms` settings field (see the contract), with a
  round-trip test: an old file without it loads, a file with it keeps it.

**B10. Copilot pin bump.** Move `SERVER_VERSION` (`process.rs:9`) to 1.565.6, or
to 1.567.5 if npm shows it is at least a week old. Install to a scratch prefix
under the repo's ignored `.claude/` directory, never `/tmp`. Run
`scripts/copilot-probe.py` and the ignored fenced test
(`session.rs:850-872`), extended by an anonymous `signIn` that stops at the
returned user code: that proves DNS, TLS, the CA bundle and the fence's `/etc`
binds without an account. Then try installing only
`@github/copilot-language-server-linux-x64`; if the probe passes against it,
`install_command` (`process.rs:29-33`) installs that package alone. Update
`docs/third_party_update_checklist.md` section 2.1 and
`docs/context/copilot_completion.md`. If the harness refuses to run the
downloaded binary, stop this step, leave the pin, and say so in the handoff:
B11 and B12 then stay unbuilt, because `auth/getGitHubToken` exists only from
1.565.

**B11. Stay signed in.** New `copilot/credentials.rs`: one keychain entry per
app account (never per project), through the same keyring helper and
locked-keyring handling as `services/agent/copilot_auth.rs`. With
`copilot_stay_signed_in` on: after a finished device sign-in the session calls
`auth/getGitHubToken` and stores the token with the user's login; on every
server start, after `didChangeConfiguration`, it calls
`signInWithGithubToken { githubToken, user }`. A refused token deletes the entry
and leaves the server signed out. Turning the setting on while signed in fetches
the token then; turning it off, or signing out, deletes the entry
(`commands/settings.rs` compares the setting around each write, as
`invalidate_copilot` does). The token never reaches the webview, a log line or
the diagnostics ring. Tests against the fake server: store after sign-in,
restore on start, delete on refusal, on sign-out and on switching off, nothing
stored with the setting off. Both request shapes come from reading the server
bundle, not from a live account; say so in `docs/context/copilot_completion.md`.

**B12. Idle shutdown.** A project's server stops after 10 minutes without a
completion request, but only while a remembered token exists, so the restart
signs in by itself. Without one, servers live until quit as today. Whatever
drives the timer ends with `stop_all` at exit: nothing outlives a clean quit.
Test with an injected clock.

## Steps — frontend (TypeScript)

**A1. Measurement.** New usage keys
`autocomplete.<event>.<mode>.<provider>/<model>` with events `shown` (visible
750 ms or accepted), `tab`, `word`, `line`, `typed` (the user typed at least
three characters of the ghost), `rejected` (dismissed after 750 ms with nothing
taken), and `autocomplete.request.<ok|empty|error|cache>.<provider>/<model>`
(`<provider>/none` when no model was chosen). The store takes any key: no
allowlist, no length limit (`stores/usage.ts:51`). `StatsRecap`
(`components/stats/StatsRecap.tsx:494-503`, `:627-635`) matches only the two
old prefixes, so it gets a second reader and still shows old history. The new
prefixes go into `METRIC` (`lib/usageMetrics.ts`); the backend adds the Rust
mirror. A typed first character no longer counts as
an accept; the two assertions on the old keys (`Autocomplete.test.tsx:159`,
`:176-177`) are rewritten. A bounded in-memory ring (200 requests) in
`completion/completionTimings.ts` records keystroke, request, context ready,
first event, done and the `CompletionStats` payload, and shows in the dev perf
monitor (`src/dev/perfMonitor.ts`).

**A2. References.** Implement fixed decisions 3 and 4 in
`completion/completionContext.ts` and CE:1822-1835: the frozen set, the two
budgets, deterministic order (the TeX key list stays directly after the manual
attachments), a cap that counts files that exist. When the model list reports
no `context_length`, the explicit budget is the automatic one. The set's version
id is a hash of its names and contents, and the completion cache key takes the
id instead of the reference text, so an explicit rebuild that reads the same
bytes still hits the cache (`Autocomplete.test.tsx:135` relies on that). Model
lookup, reference gathering and `prepare_text_completion` start together. The
request sends `fileName`. Once a stats event said `referencesDropped` for an
editor and model, that editor sends that model no references (see the
contract). The test at `Autocomplete.test.tsx:180` asks explicitly and stays
valid; add one for the frozen set: a second automatic request reads no file.

**A3. Window.** `completionWindow` advances its start in 1024-character steps at
a line boundary (prefix floats between about 3 K and 4 K characters), and the
suffix grows to 2048 characters. A single line longer than the window keeps
today's fallback: at most 4096 characters, no split surrogate pair. Test: two
carets 40 characters apart in a long file share a window start. The two window
tests (`Autocomplete.test.tsx:517-538`) assert the 1024 suffix and an exact
slice and are updated.

**A4. Trigger hygiene.** `edit()` records the kind of the last change (insert,
delete, accept). Undo, redo and reload do not pass through `edit()`; they are
recognised where the draft changes without it (CE:1774-1783). The idle timer
skips after delete, undo, redo and accept, and during IME composition, for
which CE gets `compositionstart` and `compositionend` handlers (it has none).
`useTabAiPrefs` memoises its `ac` object (`editorPrefs.tsx:167`), so a parent
re-render no longer restarts the debounce. Sends `trigger` to `complete_text`.
The local debounce stays at 600 ms until A1 has produced numbers. Copilot's
automatic delay drops from 1200 ms to 200 ms (CE:131; the user's decision,
2026-11-14). Copilot's default trigger stays "on request".

**A5. Model clarity.** The autocomplete status names the model that answered.
When the `autocomplete` role names a model (the role itself, not the default
model that `editorPrefs.tsx:95` folds into it) and no role model for the
language is loaded, automatic mode shows "not loaded — Load" in the chip instead
of silently using another resident model; with no role set, today's fallback
stays and is named. The Models hub (`components/models/ModelsHubSections.tsx`,
`useModelsHub.ts`) marks models with `insert`, says when the role holds one
without it, and offers `qwen2.5-coder:1.5b` as a one-click pull into the role:
`pull_ollama_model` as in `updateModel` (`useModelsHub.ts:366-371`), then the
role setter (`:413-418`) once the pull has finished. New surfaces get an
`UntestedTag` row.

**A6. Ghost rendering.** First commit: one publish per animation frame (the
final text cancels a pending frame; the stream tests at
`Autocomplete.test.tsx:202-245` wait a frame), scroll sync in a layout effect
(CE:1885), memoised gutter (CE:2477). Second commit, on its own so it can be
reverted: the ghost keeps syntax colour when a highlight layer exists, wrap is
off, the ghost has no line break and the line tail is empty or only closers.
The `<pre>` keeps its three parts (CE:2636-2647), because the ghost layer
scrolls through `scrollTop` and needs the document's full height; a modifier
class makes its background and text transparent and paints the ghost span plus
the line tail on `--bg-panel`, covering the original closers. Every other case
keeps the opaque projection: a wrapped ghost can reflow the caret line while
the layers beneath do not, and without a highlight layer the textarea's own
glyphs show through. No animated shadow or new opacity loop.

**A7. Keys.** Plain Right dismisses the ghost and moves; Ctrl+Right accepts a
word; Alt+Right still accepts the line. Hint text and tests follow.

**A8. Copilot in the editor and card.** The card reads `account.account.status`,
which it already receives: signed in only for `OK` or `MaybeOK`, with its own
line for `NotAuthorized` and one for `copilot_sign_in_failed`. After a Copilot
request that returned nothing, the editor asks `copilot_account` once and shows
the message of an outer `status` of kind `Inactive` in the editor status; the
backend sends no event for it and needs none. The Alt+[ hint hides when one
candidate came back. The card gains a "Details" disclosure fed by
`copilot_diagnostics`, with an `UntestedTag` row.

**A9. Stay signed in.** The Copilot card gains a "Stay signed in (OS keychain)"
switch bound to `copilot_stay_signed_in`, off by default, with one line saying
what is stored and that sign-out removes it. While `account.remembered` is true
the card says so, and the "this sign-in lasts until quit" text
(`settings.copilotSessionOnly`) shows only when it is false. `UntestedTag` row.
The switch is built against the contract; it does nothing until B11 has landed.

**A10. Delay in the menu** (the user's decision, 2026-11-14). The editor's AI
controls (`EditorAiControls`, `editorPrefs.tsx`) gain a "Delay" choice beside
the trigger, shown while the trigger is Auto: 100, 200, 400, 600 or 1200 ms. It
reads and writes `autocomplete_delay_ms` for the provider that serves the tab,
so the value holds for every tab of that provider. The two constants at
CE:128-131 become the defaults (600 local, 200 Copilot); a stored value outside
the five choices falls back to the default. `UntestedTag` row. Tests: the timer
uses the stored delay; a bad value uses the default.

## Not in this run

- **What the fenced Copilot server reads by itself** in the mounted project
  (`.env`, keys, `.git/config`): `strace` on a canary project.
- **Copilot pre-warm on editor mount.** It starts a network-capable process
  before any request; decide after the first live run.
- **First live sign-in** by the user, and with it #45a's checklist.
- **Third provider.** One generic HTTP FIM provider with presets (Mistral,
  DeepSeek, Inception, custom endpoint) and the contract changes it needs
  (consent class per provider, provider-owned feedback, capabilities the editor
  reads, error taxonomy). A llama.cpp `/infill` provider is dropped.
- **Next edit suggestions**, local models only, after a diff preview exists.
- **Debounce tuning, pinned file header in the window, import discovery for
  Rust/Go/C/Java, ranking references by relevance, automatic requests in
  Sentence mode only, a next-line ghost in Sentence mode (B2 strips the newline
  there), a "keep the autocomplete model warm" toggle.** All wait for numbers
  from A1 and B8.
- **Tab-accept caret restore through the pending-selection refs**
  (CE:1899-1901): suspected only, check live first.

## Verification

- Gates: `scripts/gates-job.sh start` in each worktree, then on the merged tree.
- Backend: B8's two tables. Expected: with a FIM model the endpoint
  is `generate` with and without references; on the chat path the second of two
  requests one character apart reads tens of tokens, not the whole prompt.
- Never run live by an agent. Click-through for the user after the dev build:
  1. Models hub: pull the recommended model, see it in the autocomplete role.
  2. Type in a TypeScript file with two other tabs open: the status names
     `qwen2.5-coder:1.5b`; the perf monitor's completion rows show `generate`.
  3. A ghost at a line end keeps syntax colour; a multi-line ghost (Shift+Tab to
     Block) still lines up when scrolled.
  4. Backspace then pause: no ghost. Tab-accept then pause: no ghost.
  5. A comment ending in an instruction, on a chat model: the code lands on the
     next line.
  6. Settings → Experimental → Copilot card: "Details" lists server log lines.
  7. Copilot card: switch "Stay signed in" on, sign in, quit and reopen: the
     card shows the account without a new sign-in. Sign out: it asks again
     after the next restart.

## Organisation

Two implementers in parallel, each in its own worktree branched from `develop`'s
tip, because the two halves share no source file once the contract above is
fixed. Then one reviewer over the whole range.

| Agent | Steps | Main files |
|---|---|---|
| Backend implementer | B1–B12 | OL, `ollama/tests.rs`, TC, `copilot/*`, `commands/copilot.rs`, `commands/settings.rs`, `schema/settings.rs`, `schema/usage_stats.rs`, `src-tauri/src/lib.rs`, `services/command_class.rs`, `commandClasses.ts`, `docs/context/copilot_completion.md`, `docs/third_party_update_checklist.md` |
| Frontend implementer | A1–A10 | CE, `completion/*`, `editorPrefs.tsx`, `CopilotCompletionCard.tsx`, `components/models/*`, `StatsRecap.tsx`, `lib/usageMetrics.ts`, the settings type, `src/dev/*`, `src/lib/i18n/en.ts`, `src/lib/untested.ts`, `src/styles/viewers.css`, `src/__tests__/editor/*` |
| Implementation reviewer | whole range | confirmed bugs only, each with a regression test |

No file has two owners: i18n and `untested.ts` belong to the frontend
implementer, every Rust file, `command_class` and the generated
`commandClasses.ts` to the backend implementer, the file maps to the merge.
Other sessions hold uncommitted edits to `lib.rs`, `commands/settings.rs`,
`command_class.rs`, `commandClasses.ts`, `en.ts` and `untested.ts` that the
worktrees do not see; the merge regenerates `commandClasses.ts` rather than
resolving it by hand. An implementer that runs low on context stops at a green
commit and a fresh one continues in the same worktree. Each writes its own
handoff in the main checkout, `docs/autocomplete_optimization_handoff_backend.md`
and `…_frontend.md`: commits, choices, gate result, test counts, anything
flagged for the user. The merge joins them into
`docs/autocomplete_optimization_handoff.md`.
