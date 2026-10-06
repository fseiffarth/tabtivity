# Copilot autocomplete (#45a)

Wired end to end behind the `copilot_completion` experimental flag, never run
live and never signed in (2026-09-18). Ollama stays the default and serves every
file Copilot does not: no consent, remote project, prose, flag or provider off.
That fallback is deliberate — it only ever moves work *onto* the machine.

Text files (Markdown, LaTeX, plain text including unclassified files) take a
second per-project opt-in, `copilot_text`, on top of code consent; dropping the
code consent drops it too. Notes and papers are what a code consent should not
quietly cover. Credential-shaped files (`.env*`, `*.env`, `.npmrc`, `.netrc`,
SSH keys, `*.pem`/`*.key`/…) never reach Copilot under any consent —
`policy::authorize_document` checks both the opened and the resolved name, and
`copilotSecretFile` mirrors it so those stay on Ollama. The editor's short
language ids are mapped to VS Code's (`ts`→`typescript`, `tex`→`latex`,
`plain`→`plaintext`) for `didOpen`.

The shared candidate contract keeps provider identity, document version, ranges,
opaque ids and the untouched language-server item. Only replacements preserving
the existing text on both sides of the caret become ghost insertions. Partial
acceptance counts UTF-16 units from the start of the original `insertText`, even
when editor line endings differ. Ollama streaming and cache behavior are behind
`OllamaCompletionProvider`; the editor still owns visibility and caret guards.

Consent is stored in Tabtivity's `settings.json`, never project metadata. The new
`completion_project_policies` map binds each project id to a canonical directory;
`local_only` overrides `copilot`. The backend policy rejects disabled providers,
remote projects, changed roots and symlinks resolving outside the approved tree.
Commands must obtain project directory/remoteness from `services::remote` and
apply this policy before every document synchronization (`commands/copilot.rs`
`session()`); a refusal there also stops that project's server, as does turning
consent off or local-only on. Consent is written only by
`copilot_set_project_policy`, which resolves and canonicalizes the directory
itself — the webview never supplies a path.

## Shape

One fenced server per consented project (`session.rs` `sessions()`), started on
the first completion or sign-in, stopped on revocation and at `RunEvent::Exit`,
restarted at most 3 times per 5 minutes. The fence (`process.rs`) mounts the
project and the install read-only, system libraries, and nothing of the home
folder; all server state is tmpfs. The webview sees candidate text, opaque
`<request>:<index>` ids, a device code and coarse `copilot_*` error codes. The
server's original items (with their acceptance command) stay in the backend,
keyed by id, scoped to the window-prefixed editor that was offered them, and die
with the document ticket. Server-to-client requests are all answered and grant
nothing (null configuration, `showDocument` refused). The editor closes its
document when hidden, on file/provider change and on unmount; the next request
re-opens it with current content.

**Consequence of RAM-only credentials:** sign-in is per project server and is
lost when that server stops (quit, revocation, crash). Persisting it needs a
verified token-injection interface, which 1.547.0 has not been shown to have.

## Standalone protocol evidence

On 2026-09-18, npm reported `@github/copilot-language-server` 1.547.0. Installed
without lifecycle scripts under `/tmp/tabtivity-copilot-probe`, outside the app's
dependencies. The npm package offers native Linux/macOS/Windows builds on x64
and arm64; upstream also documents Node >=20.8. Only Linux x64 was exercised.

Run without starting Tabtivity:

```
python3 scripts/copilot-probe.py /absolute/path/to/copilot-language-server
```

The probe uses synthetic content, isolated XDG/Copilot state, no inherited auth
environment, and discards server logs. Actual 1.547.0 output confirmed:

- Initialization reports server 1.547.0 and incremental sync (`change: 2`).
- didOpen/didChange/didFocus followed by inlineCompletion returns auth error 1000.
- An immediately cancelled inlineCompletion returns -32800.
- didClose, empty didFocus and shutdown/exit complete.

The same two results were reproduced through `session.rs` with the real server
**inside the fence** (ignored test, see the third-party checklist), so the
fence's mounts are sufficient for startup. `signIn`, the finishing
`workspace/executeCommand`, `signOut`, `checkStatus` and the `didChangeStatus`
fields are written from upstream's README and exercised only against a fake.

This does **not** prove signed-in suggestions, exclusions, workspace read limits,
credential persistence or cross-platform compatibility.

## Credential finding requiring resolution

Inspection of the distributed `dist/main.js` in 1.547.0 shows the server builds
its auth repository with `plaintextOnly()` at `<XDG_CONFIG_HOME>/github-copilot/auth.db`.
Its keytar/AES reader is migration support, not proof of encrypted new writes.
The probe creates a directory at `auth.db`, forcing the server's in-memory
fallback. It never calls signIn and does not access another editor's credentials.

Before exposing setup, implement and verify a deliberate credential policy:
session-only sign-in by default, optional OS-keychain persistence only if a
supported, verified interface allows it. Do not adopt another editor's tokens,
write token JSON, pass tokens to the webview, or log protocol payloads. The
in-memory fallback is verified for unauthenticated initialization only; its use
for production sign-in remains unproven. Workspace access also needs a process
boundary, account/project isolation, and signed-in exclusion tests.

## Remaining

Live verification with a real account (the Group M #45a checklist), which is
also the first test of the in-memory credential fallback under sign-in, of
exclusions and of what the server reads from the project. Non-Linux platforms
(`process::supported`). Quota/billing text is shown verbatim from
`didChangeStatus` in the settings card only. Candidate cycling re-requests and
indexes into the returned list rather than caching it. An unsaved new file is
refused (`authorize_document` needs a real file inside the project).

## Gate results (2026-09-18, after wiring)

`npm run build` passes; `npm test` 511 files / 5,454 tests; `cargo test` 2,406
lib tests + integration suites; clippy `-D warnings` clean; eslint 0 errors and
the same 31 pre-existing warnings, none in these files; `git diff --check` clean.

## Foundation checks (2026-09-18, before wiring)

`npm run build` passes (bundle-size warnings). Full `npm test` passes 510 files /
5,448 tests; the final editor-version/scope edits also pass the focused 33-test
autocomplete/provider/experimental run. `cargo test -q --manifest-path
src-tauri/Cargo.toml` passes outside the sandbox, including 2,391 library tests
and all integration suites. The sandboxed run failed unrelated socket/process
tests, so it is not the authoritative gate result. Clippy with `--all-targets --
-D warnings` passes. `npm run lint` exits 0 but reports 31 warnings outside the
Copilot changes; the repository's zero-warning target is not established.
`git diff --check` passes. `npm run backend:stale` reports no Tabtivity running.
No live app checks were performed. These results verify the foundation only,
not the unfinished end-to-end provider.
