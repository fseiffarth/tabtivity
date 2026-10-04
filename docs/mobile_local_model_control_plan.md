# Local models from the phone — plan

From the phone, see the Ollama models installed on the desktop: name, size,
whether each is in memory (GPU / partly GPU / CPU) and how long it stays there.
Then **load** one into memory or **unload** it. **Downloading, updating and
deleting stay desktop-only.** The backend refuses them; hiding the buttons is
not what stops them.

Status: implemented (2026-10-04, P1–P5 on branch `mobile-local-models`);
QA item 31by, not yet verified on a phone.

## 0. Decisions

Decided by the user (2026-10-04):

1. **The desktop switch defaults to on.** `local_models` in the Mobile host
   settings; unset = on (like `mail_read`), only `false` is stored.
2. **No window, no feature.** With no desktop window open (headless owner),
   the phone shows "Open the app on the desktop". The sidecar never talks to
   Ollama itself.
3. **The phone may start Ollama**, but never with a prompt: the systemd step
   runs `systemctl --no-ask-password start ollama`. If that fails, the
   existing non-prompting fallback (an owned `ollama serve`, torn down at
   quit through `OWNED_SERVER`) runs as it does for the desktop.
4. **No GPU/CPU choice on the phone.** Loads use `LoadDevice::Auto` (no
   `num_gpu`), so Ollama decides placement.
5. **Unload asks no confirmation** (it can be undone).

Taken by the plan:

- **The work goes through the desktop window, over the existing desktop
  bridge.** A phone request goes sidecar → `desktop-control.sock` →
  `MobileBridgeHost` → Tauri Ollama commands. That way `ollama-load-progress`
  fires and every desktop surface (🧠 menu, Models overlay, Settings panel,
  "+" menu) shows a load the phone started. The phone's local-model ＋ start
  already loads this way (`MobileBridgeHost.tsx:840`,
  `loadOllamaModel(local.model, "gpu")`). Headless, `launch_options` already
  answers `local: null` (`host.rs:1383`).
- **Load and Start answer at once.** The answer comes back as soon as the
  request checks out; the work runs in the background on the desktop. A load
  can take minutes, and Start can take 16 s or more (`systemctl start` blocks
  until the unit job ends, then an 8 s wait, then possibly the `ollama serve`
  fallback with another 8 s). The bridge deadline is 8 s / 10 s
  (`protocol.rs:1231-1257`). The phone follows progress by polling the list.
- Keep-alive is the desktop's: `-1`, so a model stays loaded until someone
  unloads it.
- The sidecar reads the switch on every request; the bridge checks it again.

## 1. Goal / non-goals

Goal:
- The Home screen gets a **Local models** row. It opens a sheet that lists
  every installed model with: size, parameter size and quantization; state
  (idle / loading / loaded / last load failed); where a loaded model sits
  (GPU %, CPU); and its keep-alive ("stays loaded" or "unloads in N min").
- Each row has **Load** or **Unload**. While Ollama is stopped, the sheet shows
  **Start Ollama**.
- The state refreshes on its own while the sheet is open, faster while
  something is loading or starting.

Non-goals (the backend refuses each one; there are no routes, protocol
variants or bridge paths for them):
- pull / download / resume / pause a download, update a model, check the
  registry for updates, search the registry;
- delete a model or a partial blob, copy / create / push a model;
- install or upgrade Ollama, change the models directory, apply the iGPU fix;
- set model roles (`ollama_roles`) or the default model, or choose CPU/GPU;
- anything with no desktop window.

## 2. Current state (verified 2026-10-04, develop @ beeab6e2)

Desktop backend, `src-tauri/src/commands/ollama.rs`:
- `OllamaModelInfo` (`:9-35`): name, disk `size`, `parameter_size`,
  `quantization`, `family`, `running`, `size_vram`, `capabilities`, `digest`.
  It does **not** carry `/api/ps`'s loaded `size` or `expires_at`.
- `ollama_http` (`:253-300`): raw HTTP/1.0 to `ollama_addr()`, 4 s connect
  timeout, 600 s read timeout. `connect_ollama` (`:223-234`) maps every
  connect failure to the sentinel `"not_running"`. `ollama_addr()` (`:60`)
  itself fails with a **long prose error** (not `not_running`) for a
  non-loopback host without `ollama_allow_remote_host`, `https://`, or a
  malformed address. Model names only ever go into JSON bodies, never into a
  URL or a command line.
- `list_ollama_models_detailed` (`:840-886`): `/api/tags` combined with
  `/api/ps`, plus one cached `/api/show` per model for capabilities.
- `stop_ollama_model` (`:890-894`): `keep_alive: 0`. Fast; blocks until Ollama
  answers. No name validation (the name only goes into a JSON body).
- `load_ollama_model(app, model, device?)` (`:1298-1324`): `keep_alive: -1`.
  Emits `ollama-load-progress` `loading` → `success`/`error`, keyed by the
  name it was given, and **blocks until the model is resident**. It does not
  check that the model is installed. `LoadDevice` (`:1261`) defaults to
  `Auto`.
- `ensure_ollama_running` (`:2760-2863`): refuses a non-loopback address. On
  Linux at the default address it runs **`systemctl start ollama`**
  (`:2787-2793`, inside `#[cfg(target_os = "linux")]`), which can pop a
  polkit password dialog. A failed spawn or non-zero exit (no systemd, no
  unit, denied) falls through to an owned `ollama serve`, recorded in
  `OWNED_SERVER` before the wait and torn down by `shutdown_owned_server` at
  exit. On Windows/macOS only the `ollama serve` path exists.
- `ollama_status` (`:2322-2337`): stopped / idle / loaded.
- `validate_model_name` (`:4246`): allows `[A-Za-z0-9._:/@-]`.
- Live check on this machine: Ollama 0.34.4. `/api/ps` reports
  `expires_at: "2319-01-14…"` for a `keep_alive: -1` model, and its `size` is
  the loaded size. `/api/tags` entries have `capabilities, details, digest,
  model, modified_at, name, size`.
- Registered in `src-tauri/src/lib.rs` `generate_handler!`
  (`ensure_ollama_running` `:2049`, `list_ollama_models_detailed` `:2093`,
  `load_ollama_model` `:2095`).
- These commands are `async fn` doing blocking socket I/O on the async
  runtime. New code uses `spawn_blocking`; this plan does not refactor the
  old commands.
- CI runs `cargo clippy --all-targets -D warnings` on Linux **and macOS**
  (`.github/workflows/ci-cd.yml:171`, `:294`): a Linux-only helper or an
  argument only a Linux `cfg` block reads must not be dead or unused
  elsewhere.

Desktop frontend:
- `src/stores/agents/ollamaActivity.ts`: `loads: Record<string, "loading" |
  "error">` (`:66`), fed by `ollama-load-progress` (`:212-223`), keyed by the
  event's model name; `markLoad` (`:135`). On `success` it re-reads
  `fetchModels()`. `initLocalModelEvents` is ref-counted and held by
  `LocalModelMenu` (`:83`), which `HeaderBar` always mounts, so `loads` is
  live whenever a window is open.
- `src/components/layout/LocalModelMenu.tsx:203-234`, **sole-resident
  auto-apply**: when exactly one model is resident (and the launch autoload
  did not put it there), it becomes the default and every role, `tabs`
  included. A phone load or unload can trigger this, just as a desktop one
  does (§10).
- `src/components/tabs/localModelGroup.ts`: `sameModel` (`:30`) is
  **module-private**; the same function is exported from
  `src/components/layout/intro/introData.ts:117`. `probeLocalModelPlacement`
  (`:34-55`). The "+" load (`:104-105`) is `ensure_ollama_running` then
  `loadOllamaModel(model, "gpu")`.

Mobile:
- Sidecar = this binary with `--mobile-host`, AppHandle-free
  (`services/mobile_control/`). Router at `host.rs:4867-4992`; a miss under
  `/api/` is a plain 404 (`serve_asset`), a POST to a GET-only path is 405.
  Routes that need the window call `admin::desktop_call(&socket,
  &DesktopRequest::…)`, e.g. `mail_overview` (`host.rs:1987`) with
  `mail_response` (`host.rs:1961-1982`: `desktop_unavailable` → 503,
  `*_not_found` → 404, `*_disabled` → 403, else 400). Only the error **code**
  crosses (`api_error`), never the desktop's message. Writes use
  `mutation_guard` (`host.rs:3318`: `authenticate` + `exact_origin` →
  403 `invalid_origin`).
- `protocol.rs`: `DesktopRequest` (`:836`, tagged `type`,
  `deny_unknown_fields`), action enums in the `TodoAction` style
  (`:719-720`), `request_id()` (`:1178`), `response_timeout` /
  `desktop_timeout` (`:1231-1257`), `is_mutation` (`:1266`, two arms, no
  wildcard). `DesktopResponse` (`:1561`) is deliberately **not**
  `deny_unknown_fields`. Serde gap (documented at `:2471`): an internally
  tagged enum ignores extra fields on its **unit** variants.
- `commands/mobile_control.rs:1383`, `handle_desktop_stream`: deserializes
  `DesktopRequest` in Rust, emits it to the window, waits `desktop_timeout`.
- `src/components/mobile/MobileBridgeHost.tsx` (has uncommitted edits from
  another session; line numbers drift): request/response unions (`:242`,
  `:283`), the dispatch switch (`:2400-2448`, `default` typed `never`), and
  `mutationDomain` (`:2466-2475`). Mutations run one at a time **per
  domain** (`enqueueMutation`). `mailReadAllowed` (`:1865`) is the gate
  pattern. `localChoices` is at `:980-1010`.
- `src/__tests__/mobile/MobileMutationList.test.ts` **reads `protocol.rs`**
  and requires every Rust `is_mutation` variant to have a matching
  `mutationDomain` answer. A Rust variant without its TS case fails
  `npm test`; a TS case with no Rust variant passes. This fixes the phase
  order (§12).
- Host-wide switches: `AppMobileHostSettings`
  (`src-tauri/src/schema/settings.rs:34-80`) has **no `#[serde(flatten)]
  extra`**, so an unknown key is dropped on the next Rust-side write; a new
  switch must be a real field. The sidecar reads switches straight from JSON
  (`files::files_open`, `mobile_control/files.rs:42-53`). The desktop UI is
  `src/components/mobile/MobileSettings.tsx`: `setMailGate` (`:264-278`,
  whose ternary stores only `false` for `mail_read`), three **explicit field
  lists** that rebuild the host object (`:303-309`, `:384-390`, `:435-441`),
  toggles under **Project access** (`:659-676`). TS type
  `src/types/index.ts:161-168`.
- Phone: `mobile-web/src/screens/Home.tsx` does **not** read
  `/api/v1/status` (only `App.tsx:339` does, for pills and theme). The "This
  phone" section (`:324-345`) uses `option-list` rows that open sheets
  (`NotificationsSheet`: `sheet-backdrop`, `option-sheet`, `sheet-grip`,
  `sheet-close`, `sheet-note`). `<SendToDesktop />` sits just above it
  (`:321`). Strings come from the shared `src/lib/i18n.ts` (`useT`); untested
  marks are `isUntested("<id>") && <span className="untested">…</span>`
  against `src/lib/untested.ts` (`scripts/untested.mjs` scans `src` and
  `mobile-web/src`). Sizes: `terminal/fileLabels.sizeLabel`. `ApiError`
  carries `status` and `code` (`api.ts:278`).
- Prior phone/local-model work: QA 31bl (`todo/group-h-crossplatform.md:3298`,
  untested id `mobile.newTab.local`).

## 3. API design (phone ↔ sidecar)

Both routes are global, not scoped to a project. **No project id, path or
command crosses.** Model names already cross (`launch_options.local.model`).
The status route is not changed: Home's own GET decides whether to show the
row (§6).

### `GET /api/v1/local-models`

Order of checks:
1. `authenticate`;
2. switch: `local_models::local_models_open(state_dir)` false → **403
   `local_models_disabled`**, with no desktop call;
3. `desktop_call(DesktopRequest::LocalModels)`; desktop down → **503
   `desktop_unavailable`** (no headless fallback, decision 2).

200 body (the sidecar sanitizes it, §4.3):

```json
{
  "server": "running" | "starting" | "stopped" | "unreachable" | "not_installed",
  "can_start": true,
  "start_failed": false,
  "models": [
    {
      "name": "qwen3.5:9b",
      "size": 6594474711,
      "parameter_size": "9B",
      "quantization": "Q4_K_M",
      "state": "idle" | "loading" | "loaded" | "failed",
      "loaded_size": 7100000000,
      "vram": 7100000000,
      "pinned": true,
      "expires_in": null,
      "for_tabs": true,
      "remote": false
    }
  ]
}
```

Fields:
- `server`:
  - `running`: the list read worked;
  - `starting`: a Start from the phone is in flight;
  - `stopped`: `not_running` at a loopback address with Ollama installed;
  - `not_installed`: `not_running` at a loopback address, `ollama_is_installed`
    false;
  - `unreachable`: everything else — a remote address that does not answer, a
    bad `ollama_host`, or a local server that answers with an error. It
    cannot be fixed from the phone.
- `can_start`: `server == "stopped"` (which already implies installed and
  loopback).
- `start_failed`: the last phone Start failed and the server is still not
  running. Cleared by the next Start or once the server runs.
- `state`: `loaded` when the model is in `/api/ps`; that wins over the
  desktop's `loads` map, which can be stale. Otherwise `loading` / `failed`
  (`"error"`) from `useOllamaActivityStore.loads` (looked up with
  `sameModel`), otherwise `idle`.
- `loaded_size` / `vram`: bytes, present only when `loaded`. The phone shows
  "On the GPU" when `vram >= loaded_size`, "N % on the GPU" when
  `0 < vram < loaded_size`, and "On the CPU" when `vram == 0`.
- `pinned` / `expires_in`: from `/api/ps` `expires_at`. More than a year away
  is `pinned` (the `keep_alive: -1` loads); otherwise whole seconds remaining.
  Both are absent unless `loaded`.
- `for_tabs`: this model is the desktop's `ollama_roles.tabs` (or
  `ollama_model`), i.e. the model the phone's ＋ "Local model" group drives.
- `remote`: an Ollama cloud model (its `/api/tags` entry carries
  `remote_host`/`remote_model`). It is listed, but Load/Unload is not offered
  and is refused (`model_not_local`). Unverified: no cloud model is installed
  here, see §10.

### `POST /api/v1/local-models`

Body: `{ "action": "load" | "unload" | "start", "model"?: string }`.

Order of checks:
1. `mutation_guard` (401 / 403 `invalid_origin`, same as other writes);
2. switch → **403 `local_models_disabled`**;
3. `local_models::parse_action(body)`:
   - an action other than `load`/`unload`/`start` (`pull`, `download`,
     `delete`, `remove`, `copy`, `create`, `push`, `update`, anything else) →
     **400 `unsupported_action`**, with **no desktop call**;
   - `load`/`unload` without a valid model reference, `start` with a `model`,
     or any other key → **400 `invalid_request`**;
   - a model reference must be 1–200 bytes in `[A-Za-z0-9._:/@-]`, with no
     leading `/`, no `..`, and no control characters. This matches
     `validate_model_name`, plus a length limit.
4. `desktop_call(DesktopRequest::LocalModelMutate { action })`.

The answer is the fresh list, in the GET shape (like `ScheduleMutate` →
`Schedules`), with status **202** for `load`/`start` and **200** for `unload`.
Desktop refusals (the code only, never the message; `local_models::refusal`):
- `model_not_installed` → 404;
- `model_not_local` → 400;
- `model_loading` (unload while a load is in flight) → 409;
- `ollama_not_running` (load/unload while not `running`) → 409;
- `start_unavailable` (Start when `can_start` is false) → 409;
- `local_models_disabled` → 403;
- `desktop_unavailable` (no window, a wedged one, a dropped connection, a
  deadline missed, or an answer of another kind) → 503;
- `unreachable` (Ollama on the desktop failed the window's call, e.g. an
  unload that errored) → 502;
- `unknown_request` (a window older than this feature) → 400;
- `applied_response_too_large` / `response_too_large` (the bridge's own) →
  400, as on every list-answering route, so `reloadIfApplied` works;
- any other code (the bridge's `desktop_error` for a thrown handler, or one
  this feature does not define) → **502 `desktop_error`**: codes are
  allow-listed here, not forwarded verbatim as the sibling routes do.

The sidecar's own refusals: 401 `authentication_required`, 403
`invalid_origin`, 403 `local_models_disabled`, 400 `unsupported_action` /
`invalid_request` (also for a body that is not JSON), 413 for a body over
1 KiB. The GET answers the same desktop codes (in practice
`local_models_disabled`, `desktop_unavailable`, `unknown_request`,
`desktop_error`).

Every error body is `{ "error": "<code>" }`; a success body is the list.

A failed Start is not an HTTP error: it shows up as `start_failed` on a later
list.

Idempotence:
- `load` of a model already loading → 202, nothing new (deduped in Rust,
  §4.1). Of a model already loaded → 202, re-sent with `keep_alive: -1`,
  which turns "unloads in 5 min" into "stays loaded".
- `unload` of an idle model → 200, a no-op.
- `start` while running or starting → 202, a no-op.

Any other path under `/api/v1/local-models/…` (e.g. `/pull`) matches no route:
GET → 404 (`/api/` misses never fall back to the shell), POST → 405. A test
pins this (§9).

## 4. Backend changes

### 4.1 `src-tauri/src/commands/ollama.rs` (Phase 1)

- `OllamaModelInfo` gains `loaded_size: u64`, `expires_at: Option<String>`,
  `pinned: bool`, `expires_in_secs: Option<u64>` and `remote: bool`. All are
  additive; existing TS readers ignore them.
- Pure helpers, unit-tested:
  - `ps_entries(ps_body) -> HashMap<String, PsEntry { vram, size, expires_at }>`,
    replacing the inline map in `list_ollama_models_detailed`;
  - `keep_alive_of(expires_at: Option<&str>, now: DateTime<Utc>) ->
    (pinned, Option<u64>)` (chrono `parse_from_rfc3339`; more than 365 days =
    pinned; past or unparseable = `(false, None)`);
  - `installed_match(tags_body, wanted) -> Result<String /*listed name*/,
    &'static str>`: exact match or `wanted` + `:latest`, never a prefix
    match. Err is `model_not_installed`, or `model_not_local` for a `remote`
    entry;
  - `is_remote_entry(&Value)`.
- Refactor `load_ollama_model`'s body into `fn run_load(app: &AppHandle,
  model: &str, device: LoadDevice) -> Result<(), String>`, which emits the same
  two events. The command keeps its exact behaviour.
- **New** `#[tauri::command] load_installed_ollama_model(app, model) ->
  Result<String, String>`:
  1. `validate_model_name`;
  2. `spawn_blocking`: `/api/tags` (`not_running` → `ollama_not_running`) →
     `installed_match` → `listed`;
  3. if `listed` is already in a process-wide `PHONE_LOADS:
     Mutex<HashSet<String>>`, return `Ok(listed)` without starting another;
     otherwise insert it and start `run_load(&app, &listed,
     LoadDevice::Auto)` on a detached blocking thread, removing the entry when
     it ends (a drop guard, so a panic cannot leave it stuck);
  4. return `Ok(listed)` — the **listed** name, so the bridge marks the same
     key the progress events use (`llama3` vs `llama3:latest`).

  The answer never waits for the load. The installed check is the real
  **no-download guarantee**: whatever Ollama does with an unknown name in
  future, this command never sends one. The dedupe set bounds how many
  blocking threads a phone can hold open (each can sit in a 600 s read).
  Process exit does not wait for the thread (the Tauri runtime is never
  dropped), and an owned server torn down at exit makes its read fail.
- **New** `ensure_ollama_running_unattended() -> Result<(), String>`
  (`spawn_blocking` inside): the same core as `ensure_ollama_running`,
  refactored to `fn ensure_running(ask_password: bool)`. With `false`, the
  systemd step runs `systemctl --no-ask-password start ollama`, so a
  phone-started server never pops a polkit dialog. On failure it falls
  through to the owned `ollama serve`, as today. The args come from a pure
  `systemctl_start_args(ask_password) -> &'static [&'static str]`.
  **cfg:** the helper and its test are `#[cfg(target_os = "linux")]`, like the
  block that calls it; off Linux the core must still read `ask_password`
  (`let _ = ask_password;` under `#[cfg(not(target_os = "linux"))]`) so macOS
  clippy stays clean.
- **New** `ollama_server_kind() -> Result<&'static str, String>`: `"local"`
  or `"remote"` from `ollama_addr()` + `addr_is_loopback`; a bad
  `ollama_host` → Err. A thin shell over a pure, tested `server_kind(addr)`.
  The bridge uses it to classify a failed list without re-implementing
  `resolve_ollama_addr` in TS.
- Register the three commands in `src-tauri/src/lib.rs` `generate_handler!`.
- No `AppHandle` enters any helper; only the command shells take one.

### 4.2 `src-tauri/src/schema/settings.rs` (Phase 1)

- `AppMobileHostSettings` gains `local_models: Option<bool>`
  (`#[serde(default, skip_serializing_if = "Option::is_none")]`). Doc comment:
  "May a paired phone list the desktop's Ollama models and load/unload them
  (never download or delete)? Unset is **on**; `false` closes the routes.
  Read by the sidecar per request
  (`mobile_control::local_models::local_models_open`) and repeated by the
  desktop bridge."
- Round-trip test: `{"local_models": false}` survives read → write; absent
  stays absent.

### 4.3 Sidecar `src-tauri/src/services/mobile_control/` (Phase 3)

- **New `local_models.rs`** (AppHandle-free, pure; declared in `mod.rs`):
  - `local_models_open(state_dir) -> bool`: reads `settings.json`
    `[brand::MOBILE_HOST_KEY].local_models`; key missing → `true`, `false` →
    `false`; missing or unparseable file → `false` (fail closed, as
    `files_open` does).
  - `valid_model_ref(&str) -> bool`.
  - `parse_action(&Value) -> Result<LocalModelAction, &'static str>`, with
    the refusal codes from §3. It enforces "`start` carries no `model`"
    itself: serde would accept `{"type":"start","model":"x"}` on the unit
    variant (§2).
  - `sanitize(LocalModelList) -> Value`: caps `models` at 64; drops rows whose
    name fails `valid_model_ref`; clamps `parameter_size`/`quantization` to 32
    characters; forces `state` into its four values and `server` into its
    five; drops `loaded_size` / `vram` / `pinned` / `expires_in` unless
    `loaded`.
- **`protocol.rs`**:
  - `DesktopRequest::LocalModels { request_id }` and
    `DesktopRequest::LocalModelMutate { request_id, action: LocalModelAction }`;
  - `#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
    enum LocalModelAction { Load { model }, Unload { model }, Start }`, so a
    `pull` variant **cannot be deserialized** on the desktop side either;
  - `DesktopResponse::LocalModels { server, can_start, start_failed, models:
    Vec<MobileLocalModel> }`, with `#[serde(default)]`s and no
    `deny_unknown_fields`, as the other responses;
  - arms in `request_id()`;
  - timeouts: the defaults (8 s / 10 s) — nothing here waits on a load or a
    start;
  - `is_mutation`: `LocalModelMutate` → true, `LocalModels` → false (the TS
    side is already in place from Phase 2, so `MobileMutationList.test.ts`
    stays green).
- **`host.rs`**:
  - handlers `local_models_list` and `local_models_mutate` (§3), with
    `local_models_response`, a mapper in the style of `mail_response` plus the
    409 codes;
  - route `.route("/api/v1/local-models",
    get(local_models_list).post(local_models_mutate))`.

  Overlap with `docs/mobile_device_scoped_access_plan.md` (another session's
  plan, not built): these routes take no project/tab id and never use
  `catalog()`, so that plan's filtering does not apply. That plan changes
  `mutation_guard` to return the device id; the POST handler uses
  `mutation_guard`, so whichever lands second gets a compile error at that one
  call site, not a silent bypass. Otherwise only the router lines touch.
  Local-model control stays host-wide, not per phone.

## 5. Desktop frontend changes (Phase 2)

- **New `src/lib/mobileLocalModels.ts`**. It holds the bridge logic, so
  `MobileBridgeHost.tsx` only gains dispatch lines:
  - `localModelsAllowed()`: `settings[MOBILE_HOST_KEY]?.local_models !==
    false` (the `mailReadAllowed` pattern). **Both** handlers check it first
    and answer `{status:"error", code:"local_models_disabled"}`.
  - `localModelsAnswer()`: `invoke("list_ollama_models_detailed")`. On any
    error: `ollama_server_kind` → Err or `remote` → `unreachable`; `local` and
    the error is `"not_running"` → `ollama_is_installed` ? `stopped` :
    `not_installed`; `local` with any other error → `unreachable`. A pending
    phone Start overrides with `starting`. It folds in
    `useOllamaActivityStore.getState().loads` and `ollama_roles.tabs ??
    ollama_model` for `for_tabs`, both matched with the exported `sameModel`
    from `components/layout/intro/introData.ts` (the `localModelGroup.ts` copy
    is private). Caps at 64 rows. Raw error text is never put in the answer.
  - `localModelMutate(action)`:
    - `load` / `unload`: refused with `ollama_not_running` unless the fresh
      list read worked; the name is resolved against that list (`sameModel`)
      → `model_not_installed` / `model_not_local`;
    - `load` → `invoke<string>("load_installed_ollama_model", { model })`, then
      `markLoad(listed, "loading")` with the **returned** name;
    - `unload` → `model_loading` if `loads[listed] === "loading"`; else
      `invoke("stop_ollama_model", { model: listed })` and `fetchModels()`, so
      the desktop's own list drops it at once;
    - `start` → `start_unavailable` unless the answer says `can_start`; if a
      start is already pending, a no-op; else keep a module-level pending
      promise for `invoke("ensure_ollama_running_unattended")` (**not
      awaited**), which on settle records `startFailed`, clears the pending
      flag and calls `fetchModels()`;
    - always answers with `localModelsAnswer()`.

    It never imports or invokes `pull_ollama_model`, `delete_ollama_model`,
    `delete_ollama_pull`, `pause_ollama_pull`, `clear_pending_ollama_pull`,
    `delete_partial_blob` or `load_ollama_model`. A test asserts the full
    invoke log.

  Races: `local_model_mutate` gets its own `mutationDomain`
  (`"local_models"`), so phone loads, unloads and starts run one at a time in
  arrival order. A desktop click can still interleave; Ollama serializes the
  actual loads, and `/api/ps` wins on the next poll.
- **`MobileBridgeHost.tsx`**: union members `{ type: "local_models"; request_id
  }` and `{ type: "local_model_mutate"; request_id; action: { type: "load" |
  "unload"; model: string } | { type: "start" } }`, plus the response
  `{ status: "local_models"; … }`; two `case`s in the dispatch switch;
  `mutationDomain`: `local_model_mutate` → `"local_models"`. (Rust has no such
  variants until Phase 3; the mirror test only walks Rust's list, so this is
  green.)
- **`MobileSettings.tsx`**:
  - `setMailGate`'s union gains `"local_models"`, and its ternary stores it
    like `mail_read` (`gate === "mail_read" || gate === "local_models" ? (on ?
    undefined : false) : on || undefined`);
  - add `local_models: stored?.local_models` to the three explicit lists;
  - new `ToggleRow` under **Project access**, after **No shells on the
    phone**: label `mobile.localModelsGate` + `<UntestedTag
    id="mobile.localModelsGate" />`, `checked={stored?.local_models !==
    false}`, help `mobile.localModelsGateHelp`.
- **`src/types/index.ts`** (host settings type, `:161-168`): `local_models?:
  boolean`.

## 6. Phone UI changes (Phase 4)

- **`mobile-web/src/api.ts`**:
  - types `LocalModelRow`, `LocalModelList`;
  - `getLocalModels(signal?)`;
  - `localModelAction(action, model?)` (POST; the error code is carried by
    `ApiError`).
- **New `mobile-web/src/localModels.ts`** (pure, tested):
  - `sortModels` (loaded first, then loading, then by name);
  - `placementKey(row)` (gpu / part / cpu with pct);
  - `keepAliveKey(row)`;
  - `pollDelay(list, inFlight)`: 2.5 s while any row is `loading`, `server`
    is `starting`, or a request is in flight; else 10 s;
  - `summary(list)` for the Home caption.
- **New `mobile-web/src/screens/LocalModelsSheet.tsx`**, copying
  `NotificationsSheet`'s structure and classes (`sheet-backdrop`,
  `option-sheet`, `sheet-grip`, `sheet-close`, `option-list`, `sheet-note`):
  - header: title `mobile.localModels.title` + untested pill
    (`mobile.localModels`);
  - status line by `server`:
    - `stopped` → text + **Start Ollama** button if `can_start` (pill
      `mobile.localModels.start`); `start_failed` adds `startFailed`;
    - `starting` → `starting`;
    - `unreachable` / `not_installed` → text only;
    - error states: `desktop_unavailable` → `needsWindow`;
      `local_models_disabled` → `disabled`; others → `failed`.
  - one row per model: `<strong>name</strong>`; `<small>` with
    `parameter_size · quantization · sizeLabel(size)`; a second `<small>` with
    the state (`loading` with an indeterminate marker, `failed`, or
    placement + keep-alive); a "for new local-model tabs" note when
    `for_tabs`; and a trailing button **Load** / **Unload**, disabled while
    that row's request is in flight or the row is `loading`. `remote` rows
    show `cloud` and no button. No buttons while `server` is not `running`.
  - footer `sheet-note`: `mobile.localModels.noDownloads`.
  - Polling: fetch on open; `setTimeout(pollDelay)` chain; stop when hidden
    (`document.visibilityState`) or closed; an `AbortController` per fetch.
    After a POST, take the list from the answer (no extra GET).
  - No confirmation for Unload (decision 5). Errors show inline on the row
    (`model_loading` → `busyLoading`, `model_not_installed` → `goneModel`).
- **`Home.tsx`**: a new section between `<SendToDesktop />` and "This phone".
  Heading `mobile.localModels.heading`, one `option-list` row
  (`mobile.localModels.row` + pill). Home does one `GET` on mount and decides
  from it: 403 `local_models_disabled`, 404 (a sidecar older than this
  feature) or `server == "not_installed"` → the section is not rendered;
  503 → caption `needsWindow`; 200 → caption `summary`. Tapping opens the
  sheet.
- **`style.css`**: only what the sibling classes lack (the row's trailing
  action button, the loading marker). An indeterminate loading marker must
  animate `opacity`/`transform`, never a blurred `box-shadow`.
- Rebuild: `npm run mobile:bundle`.

Optional, not in scope unless the user asks: in `NewTabSheet`'s
`LocalModelGroup`, the "isn't on the GPU yet" note could link to the sheet.

## 7. i18n keys (`src/lib/i18n.ts`, English; other languages fall back)

Desktop (Phase 2):
- `mobile.localModelsGate`: "Local models from the phone"
- `mobile.localModelsGateHelp`: "A paired phone may see the Ollama models
  installed here and load or unload them. It can't download, update or delete
  models, and it starts Ollama only without asking for a password. Loading a
  single model makes it the model for every role, as it does here."

Phone (Phase 4):
- `mobile.localModels.heading`: "Local models"
- `mobile.localModels.row`: "Ollama models on the desktop"
- `mobile.localModels.summary`: "{loaded} loaded · {installed} installed"
- `mobile.localModels.title`: "Local models"
- `mobile.localModels.close`: "Close"
- `mobile.localModels.serverStopped`: "Ollama isn't running on the desktop."
- `mobile.localModels.start`: "Start Ollama"
- `mobile.localModels.starting`: "Starting Ollama…"
- `mobile.localModels.startFailed`: "Ollama didn't start. Start it on the
  desktop."
- `mobile.localModels.unreachable`: "Ollama on the desktop isn't answering.
  Check it there."
- `mobile.localModels.notInstalled`: "Ollama isn't installed on the desktop."
- `mobile.localModels.needsWindow`: "Open {app} on the desktop to see and load
  models."
- `mobile.localModels.disabled`: "Turned off in the desktop's Mobile
  settings."
- `mobile.localModels.failed`: "Couldn't reach the desktop."
- `mobile.localModels.empty`: "No models are installed. Download one on the
  desktop."
- `mobile.localModels.load`: "Load"
- `mobile.localModels.unload`: "Unload"
- `mobile.localModels.loading`: "Loading into memory…"
- `mobile.localModels.loadFailed`: "The last load failed — see the desktop."
- `mobile.localModels.onGpu`: "On the GPU"
- `mobile.localModels.partGpu`: "{pct}% on the GPU"
- `mobile.localModels.onCpu`: "On the CPU"
- `mobile.localModels.pinned`: "Stays loaded until unloaded"
- `mobile.localModels.expires`: "Unloads in {minutes} min"
- `mobile.localModels.forTabs`: "Used for new local-model tabs"
- `mobile.localModels.cloud`: "Runs in the cloud — nothing to load"
- `mobile.localModels.busyLoading`: "Wait until it has finished loading."
- `mobile.localModels.goneModel`: "That model is no longer installed."
- `mobile.localModels.noDownloads`: "Downloading, updating and deleting
  models is only possible on the desktop."

The untested pill text reuses `mobile.newTab.untested`.

## 8. Untested register (`src/lib/untested.ts`)

Each row lands in the same phase as its call site
(`UntestedRegistry.test.ts` fails on a row without one, and vice versa):

- Phase 2: `"mobile.localModelsGate"`: `{ area: "mobile", what:
  "MobileSettings · Local models from the phone (host-wide switch, unset = on;
  the sidecar reads it per request) (#31by)" }`
- Phase 4: `"mobile.localModels"`: `{ area: "mobile", what: "Home · Local
  models sheet: list installed Ollama models with state/placement/keep-alive;
  Load (Auto, kept loaded) / Unload; refreshes while loading (#31by)" }`
- Phase 4: `"mobile.localModels.start"`: `{ area: "mobile", what: "Local
  models sheet · Start Ollama from the phone (systemctl --no-ask-password,
  else an owned ollama serve) (#31by)" }`

## 9. Tests

Rust (`cargo test`):
- `ollama.rs` (Phase 1):
  - `ps_entries` parses name/size/vram/expires (the live body shape above);
  - `keep_alive_of`: 2319 → pinned; +240 s → `Some(240)`; past, missing or
    garbage → `(false, None)`;
  - `installed_match`: exact, `:latest` normalization, no prefix match
    (`qwen3` ≠ `qwen3.5:9b`), remote entry → `model_not_local`, unknown →
    `model_not_installed`;
  - `server_kind`: loopback / `localhost` / `[::1]` → local, other → remote;
  - Linux only: `systemctl_start_args(false)` contains `--no-ask-password`,
    `(true)` does not;
  - the `PHONE_LOADS` guard releases its entry on drop.
- `schema/settings.rs` (Phase 1): `local_models` round trip.
- `local_models.rs` (Phase 3):
  - switch: missing file → false; key absent → true; `false` → false; `true`
    → true;
  - `valid_model_ref` table (`hf.co/u/m:q4`, `..`, leading `/`, newline,
    201 bytes);
  - `parse_action`: `pull` / `download` / `delete` / `copy` / `create` /
    `push` / `update` / `""` → `unsupported_action`; load without a model,
    start with a model, an extra key → `invalid_request`;
  - `sanitize`: caps, drops, clamps, unknown `server`/`state` forced.
- `protocol.rs` (Phase 3):
  - round trip of both requests and the response;
  - `{"type":"local_model_mutate","request_id":"r","action":{"type":"pull","model":"x"}}`
    **fails to deserialize**; an unknown field on `load`/`unload` is rejected
    (not on `start`, the unit variant — `parse_action` covers that);
  - `is_mutation`;
  - `desktop_timeout < response_timeout` for the new variants.
- `host.rs` (Phase 3; tokio, with a fake desktop socket as in the
  markup-questions test at `host.rs:8105`):
  - unauthenticated → 401;
  - switch off → 403 `local_models_disabled` and the fake desktop **sees no
    request** (GET and POST);
  - no desktop → 503 `desktop_unavailable`;
  - list is sanitized; a desktop error message does not reach the body;
  - POST with a foreign origin → 403;
  - POST `{"action":"pull","model":"llama3"}` → 400 `unsupported_action`, and
    the desktop log stays empty;
  - GET `/api/v1/local-models/pull` → 404, POST → 405;
  - POST load → the desktop sees `LocalModelMutate{Load{model}}`, and the
    answer is 202;
  - desktop `model_not_installed` → 404, `model_loading` → 409.

Vitest (`npm test`):
- **New `src/__tests__/mobile/MobileLocalModels.test.tsx`** (Phase 2; the
  bridge, `ask()` harness as in `MobileLocalAgents.test.tsx`):
  - the answer maps `running` / `loads` / `size_vram` / `for_tabs`
    (`llama3` setting matches `llama3:latest`);
  - list errors → stopped / not_installed / unreachable (remote, bad host,
    local non-`not_running` error); no raw error text in the answer;
  - gate off → `local_models_disabled` for **both** request kinds, with no
    Ollama invoke;
  - load of an unknown name → `model_not_installed`, and
    `load_installed_ollama_model` is never invoked; a load marks the
    **returned** listed name;
  - unload during loading → `model_loading`;
  - start → answers `starting` before `ensure_ollama_running_unattended`
    resolves; a second start while pending invokes nothing; a rejected start
    → the next answer has `start_failed`;
  - **across every path, the invoke log never contains a pull/delete/pause
    command or `load_ollama_model`**.
- `MobileMutationList.test.ts`: unchanged. It stays green in Phase 2 (it only
  walks Rust's list) and checks the new variant once Phase 3 adds it.
- `MobileProjectAccess.test.tsx` (or a sibling, Phase 2): the toggle writes
  `local_models: false` and clears it on re-enable; `apply()` keeps it.
- **New `src/__tests__/mobile/MobileLocalModelsSheet.test.tsx`** (Phase 4,
  phone):
  - rows, captions and button labels;
  - Load posts and shows loading;
  - fake timers: 2.5 s polling while loading or starting, 10 s idle, stops
    when closed;
  - `desktop_unavailable` text;
  - **no download/delete control is rendered**;
  - Home renders no section on 403 `local_models_disabled`, on 404 and on
    `not_installed`; shows `needsWindow` on 503.
- `mobile-web/src/localModels.ts` unit cases (Phase 4: sort, placement,
  keep-alive rounding, poll delay).

Gates (AGENTS.md), every phase: `npm run build`, `npm test`, `cargo test`,
`npm run lint`, `cargo clippy … -D warnings`, `scripts/brand-check.sh`,
`git diff --check`. After Rust edits, run `npm run backend:stale` and report
it. The phone part needs `npm run mobile:bundle`. Never start or stop the app.

## 10. Risks / interactions

- **Sole-resident auto-apply** (`LocalModelMenu.tsx:203-234`): a phone load
  that leaves exactly one model resident sets every role to it, `tabs`
  included. That changes which model the phone's ＋ "Local model" group
  drives. Unloading down to a single model does the same. This is existing
  desktop behaviour, now reachable remotely. The QA step checks it; the help
  text mentions it.
- **Unload during an agent turn**: Ollama is expected to finish the request in
  flight, then unload (unverified). The agent's next turn reloads the model
  with Ollama's default 5-minute keep-alive (not pinned), so the sheet will
  then show "Unloads in 5 min".
- **Eviction**: loading a big model may evict others (VRAM or
  `OLLAMA_MAX_LOADED_MODELS`). Ollama decides; the list shows the result.
- **Loads longer than 600 s**: `ollama_http` times out, the desktop store
  says `failed`, but Ollama may keep loading. The list corrects itself, since
  `/api/ps` wins (§3).
- **Window reload during a load or start**: `loads` and the pending-start
  flag are lost, so the row reads `idle` (or the server `stopped`) until the
  model lands or the server answers. Accepted.
- **Embedding-only models**: a warm-up through `/api/generate` fails for
  them, so the row ends `failed` — the same as a desktop click today. Not
  special-cased.
- **`size_vram: 0`** is ambiguous (no GPU, iGPU dropped, too big;
  `project_ollama_igpu_drop` memory). The phone says only "On the CPU", never
  why. The desktop's GPU diagnosis stays desktop-only.
- **Starting Ollama from the phone**: `--no-ask-password` makes the systemd
  start fail where the desktop's would have prompted. The fallback is then an
  owned `ollama serve` as the user (system models dir as today), torn down at
  quit — so a phone-started server does not outlive a clean quit. No systemd
  or no unit: `systemctl` fails to spawn or exits non-zero, same fallback.
  Windows/macOS: owned `ollama serve` only.
- **Cloud models**: the `remote_host`/`remote_model` detection comes from
  Ollama's documented tags shape. It has not been seen on this machine.
- **Two Rust halves**: the desktop's `commands::ollama` and the sidecar's
  routes. A sidecar older than this answers 404 for `/api/v1/local-models`;
  Home then hides the section. A desktop window older than this answers
  `unknown_request` (400); the Home row and the sheet say to update the
  desktop app (`mobile.localModels.needsUpdate`).
- **Merge interaction** with `docs/mobile_device_scoped_access_plan.md`: the
  router lines and the `mutation_guard` call site (§4.3). No catalog use here.
- **Energy Saver** suppresses only the launch-time autoload. A phone load is
  an explicit action, like a desktop click, and is not suppressed.

## 11. Open questions

None. The five earlier questions are decided (§0).

## 12. Phases (one implementing agent each)

Order matters: `MobileMutationList.test.ts` reads `protocol.rs`, so the TS
bridge (Phase 2) must land before the Rust protocol variants (Phase 3), or
`npm test` goes red in between. Every phase runs all gates (§9).

- **P1 — desktop backend** (§4.1, §4.2, Rust tests): `OllamaModelInfo`
  fields + helpers, `run_load` refactor, `load_installed_ollama_model` with
  `PHONE_LOADS`, `ensure_running(ask_password)` +
  `ensure_ollama_running_unattended` (Linux-only `cfg` on the args helper),
  `ollama_server_kind`, registration, settings field. Done when: the
  `ollama.rs`/`settings.rs` tests in §9 pass, `load_ollama_model` /
  `ensure_ollama_running` behave as before, `backend:stale` is reported.
- **P2 — desktop bridge + switch** (§5, desktop half of §7, P2 row of §8):
  `lib/mobileLocalModels.ts`, `MobileBridgeHost` unions + cases +
  `mutationDomain`, `MobileSettings` toggle + `setMailGate` + the three field
  lists, `types/index.ts`, desktop i18n keys, the `mobile.localModelsGate`
  register row, vitest (bridge, toggle). Done when: the bridge tests in §9
  pass, including the invoke-log assertion.
- **P3 — sidecar** (§4.3, Rust tests): `local_models.rs`, protocol variants
  (+ `request_id`, `is_mutation`), host routes, host tests. Done when: the
  `local_models.rs`/`protocol.rs`/`host.rs` tests in §9 pass and
  `MobileMutationList.test.ts` is green with the new Rust variant;
  `backend:stale` is reported.
- **P4 — phone UI** (§6, phone half of §7, P4 rows of §8): `api.ts`,
  `localModels.ts`, `LocalModelsSheet.tsx`, the Home section, CSS, phone
  i18n keys, register rows, vitest, `npm run mobile:bundle`. Done when: the
  sheet/Home tests in §9 pass.
- **P5 — docs + QA**:
  - `DOCUMENTATION.md`: in **Tabtivity Mobile** (`:395`), a paragraph on the
    sheet, the switch and the refusal; in **Ollama Model Management**
    (`:609`), table rows for `load_ollama_model` (missing today),
    `load_installed_ollama_model` and `ensure_ollama_running_unattended`.
  - `docs/help/mobile.md`: a new "## Local models from the phone" section
    after "Project files on the phone" (`:136`), which the help MCP serves.
  - `docs/help/local-models.md`: one line under "4. Load a model onto the
    GPU" (`:70`).
  - File maps, one line each: the `ollama.rs` row; the `mobile_control/` row
    (add `local_models.rs`; note it has no headless fallback); the frontend
    row for `mobile/MobileSettings.tsx + MobileBridgeHost.tsx`, plus new rows
    for `lib/mobileLocalModels.ts` and
    `mobile-web/src/screens/LocalModelsSheet.tsx`.
  - QA item **31by** in `todo/group-h-crossplatform.md` after 31bx (`:3749`),
    shaped like 31bl (`:3298`). Status `[~]`, code-complete + tests, ⚠️ not on
    a phone. Note: needs the backend restarted and the sidecar reinstalled
    (both Rust halves), and the PWA rebuilt. Then:

    ```
    - [ ] 🖐️ Manual phone QA — Home → Local models lists every installed
      model with size; Load one → "Loading…" then "On the GPU · Stays loaded",
      and the desktop's 🧠 menu shows the load while it runs; Unload → idle on
      both; with Ollama stopped, Start Ollama starts it without a password
      dialog on the desktop, and quitting the app stops it again; Settings →
      Mobile → Local models from the phone off → the row disappears and the
      route answers 403; with the window closed the sheet says to open the
      app; nothing on the phone offers download or delete; loading a single
      model with none resident re-points the desktop's roles (expected).
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS
    ```

## Review notes (2026-10-04)

Checked against develop @ beeab6e2 (plus the uncommitted tree). Changes:

- **Decisions recorded** (§0, §11): the user's five answers replace the open
  questions.
- **Phases reordered**: the bridge is now P2 and the sidecar P3.
  `MobileMutationList.test.ts` reads `protocol.rs` and fails when a Rust
  `is_mutation` variant has no TS `mutationDomain` case, so the old order
  left `npm test` red after P2. Every phase now runs all gates and has a
  "done when".
- **Start answers at once** (`server: "starting"`, `start_failed`). A
  blocking Start can take 16 s or more (systemctl job + two 8 s waits), which
  overran the planned 12 s / 15 s deadline. The special timeouts are gone.
- **Load key bug fixed**: the bridge marked `loads[<phone name>]` while the
  progress events use the listed name (`llama3` vs `llama3:latest`), so a row
  could stay "loading" for ever. The command now returns the listed name.
- **Rust-side dedupe** (`PHONE_LOADS`): repeated phone loads no longer each
  hold a blocking thread for up to 600 s.
- **The gate covers the list too**: the bridge used to check the switch only
  on mutate.
- **Error classification**: `ollama_addr()` fails with prose, not
  `not_running`, for a bad or remote host. Every non-`not_running` failure
  now maps to `unreachable` (text made generic), and no raw error text
  crosses.
- **`/api/v1/status` change dropped**: Home never reads status (`App.tsx`
  does). Home's own GET decides, and an older sidecar's 404 hides the row.
  This also removes one overlap with the device-scoped plan.
- **POST uses `mutation_guard`**, so the device-scoped plan's signature change
  reaches this route at compile time.
- **cfg / clippy**: CI runs clippy on macOS, so the Linux-only args helper,
  its test, and the `ask_password` read are `cfg`-gated.
- **Smaller fixes**: `start` carrying `model` is caught in `parse_action`
  (serde ignores extra fields on unit variants); `sameModel` comes from
  `introData.ts` (the `localModelGroup.ts` one is private); `setMailGate`'s
  ternary needs `local_models`; races are handled by a `local_models`
  mutation domain; the off-route test is now 404/405; line numbers
  corrected; embedding-only loads added to the risks.
