# Pi and Cline as local-model drivers — plan

Status: implemented 2026-10-06 (steps 0a, 0b, 1, 2, 4; step 3 deferred to todo), uncommitted, never live

## Why

The 🧠 Local Model group of the + menu drives the active Ollama model through
`LOCAL_DRIVERS` (`src-tauri/src/commands/ollama.rs`): OpenCode, Claude Code,
Codex, Droid, OpenClaw (+ Mistral/vibe on its own path). Ollama 0.34.4 lists
`pi` and `cline` among `ollama launch` integrations, and both CLIs are already
in the agent registry (`commands/agents.rs`, ids `pi`, `cline`) with install
and update-check rows. Pi in particular is a minimal-harness agent (short
system prompt, four tools) — the kind the `heavy_harness` doc says copes best
with local models.

Hermes is out of scope: it is not in the agent registry yet.

## Review findings (2026-10-06, from Ollama's `cmd/launch/{pi,cline}.go` at v0.34.4)

- **Cline writes into its login file.** `ollama launch cline` merges an
  `ollama` provider and `lastUsedProvider: "ollama"` into
  `~/.cline/data/settings/providers.json` (+ `globalState.json`). That path is
  Cline's `auth_paths` (`commands/agents.rs:162`), so `services::agent_auth`'s
  keeper adopts the local-model home's copy (Cline has no account guard,
  `agent_auth.rs:173`) and pushes it into every scope's Cline home: the user's
  own Cline tabs switch to Ollama everywhere. Step 0b must land first.
- **Pi's package was renamed.** `@mariozechner/pi-coding-agent` is deprecated
  on npm ("use @earendil-works/pi-coding-agent", 0.73.1 vs 1.0.4).
  `ollama launch pi` detects the legacy package and *migrates* it — global
  `npm install -g @earendil-works/…` + `npm uninstall -g @mariozechner/…` —
  before every launch, from inside the fenced tab. Tabtivity's registry still
  installs the legacy name (`agents.rs:341-342`, `:2197`;
  `agent_latest.rs:59`). Step 0a.
- Pi gets `reasoning: true` in `models.json` only for a `thinking` model, so
  `non_thinking_args: None` is right for Pi. Cline sets no reasoning field.

## Fixed decisions

1. **Launch-only.** Both rows get `launch_sub: Some(..)`, `fallback: None`.
   No hand-rolled config for either CLI: neither binary is installed on the dev
   machine, so a direct invocation (Pi's `models.json` provider, Cline's
   provider config) cannot be verified, and `ollama launch` already writes that
   wiring — into the tab's agent home, since a local agent tab's `$HOME` is its
   scope's `agent-homes/<key>` (same as Claude/Codex/Droid today).
2. **Harness flags.** Pi `heavy_harness: false` (leads the group with OpenCode,
   ahead of Mistral); Cline `heavy_harness: true` (after OpenClaw). Both
   `needs_tools: true`, `non_thinking_args: None`, `wants_local_catalog: false`.
3. **Order** in `LOCAL_DRIVERS`: opencode, pi, claude, codex, droid, openclaw,
   cline. (The frontend splits light/heavy, so within each half this order is
   the menu order.)
4. **UntestedTag** on both menu rows: register ids `localDriver.pi`,
   `localDriver.cline` in `src/lib/untested.ts`. `scripts/untested.mjs`
   (which `UntestedRegistry.test.ts` runs) finds call sites only by the
   literal `untested: "<id>"` / `isUntested("<id>")`, and `sweep` deletes by
   the same pattern — so an id→id map fails the test as orphan rows. Spell
   them in `localModelGroup.ts` instead:
   `const DRIVER_UNTESTED: Record<string, { untested?: UntestedId }> = { pi: {
   untested: "localDriver.pi" }, cline: { untested: "localDriver.cline" } };`
   and `...DRIVER_UNTESTED[d.id]` in `driverRow` (sweep leaves `{ }`, still
   valid). `localDrivers.ts` gets no map. The phone's local group is already
   gated as a whole (`isUntested("mobile.newTab.local")`,
   `mobile-web/src/screens/NewTabSheet.tsx:182`): only its row text
   (`untested.ts:539`) gains Pi / Cline.
5. **No transcript/Reader support** for these tabs in this change: like
   Claude/Codex/Droid local tabs, they keep their `ollama` line and render as a
   plain terminal. (`transcript_cmd_of` special-cases only OpenCode.)
6. **Codex extra-args fix.** `ollama launch --help` on 0.34.4 shows
   `ollama launch [INTEGRATION] [-- [EXTRA_ARGS...]]` and the example
   `ollama launch codex -- --sandbox workspace-write`, contradicting the code's
   "`ollama launch` forwards nothing". Detect forwarding from the help text
   (repo rule: read features from `--help`, not the version), never from the
   version. When it forwards, a non-thinking model keeps Codex on
   `ollama launch codex --model <m> -- -c model_reasoning_effort="none"`
   instead of falling back to the direct `codex --oss` line + own catalog.
   When it doesn't, today's behaviour is unchanged. Untested live (codex is not
   reachable from the dev fence either) → stays behind the same tag as the
   existing local Codex path? No existing pill — add `localDriver.codexForward`?
   **Reviewed: split out, not in this change.** It is independent of Pi/Cline,
   widens `local_launch_line_ok` (the restore/phone allowlist), cannot be
   verified here, and fixes nothing broken — the direct `codex --oss` path
   already works and writes its own catalog. 0.34.4's `codex.go` does append
   `extra` after its own `--profile`/`-m`, so the idea holds; file it as a
   todo in `todo/group-s-agents.md`. In this change only reword the
   "`ollama launch` forwards nothing" comments (`ollama.rs:3878`, `:4334`,
   `:5160`, `:5171`) to "older Ollama forwarded nothing; we don't rely on it".

## Steps

### Step 0a — Pi's npm package (`commands/agents.rs`, `services/agent_latest.rs`)

- Install/update/latest-version rows move to `@earendil-works/pi-coding-agent`
  (`agents.rs:341-342`, the table at `:2197`, `agent_latest.rs:59`; grep
  `rg -n "mariozechner" src-tauri src docs`). Bin stays `pi`. A user who
  installed the legacy name still meets Ollama's migration on the first Pi
  local tab — note it in the help text; Manage CLIs' update should migrate.

### Step 0b — keep a local-model home's Cline config out of the login store (`services/agent_auth.rs`)

- **Decided (user, 2026-10-06): every local-model home is receive-only, for
  all CLIs.** A `.local` home (`agent_home::local_model_home_in`) is never
  adopted into the store — whatever an `ollama launch` writes there is wiring
  for Ollama, not a login. The store is still placed into it, except over a
  file the home already holds that differs from what was last placed there
  (that would strip the `ollama` provider from Cline's `providers.json` under
  a running tab). Trade-off accepted: a sign-in done inside a local-model tab
  stays in that home. Tests: a changed `providers.json` in a `.local` home is
  neither adopted nor overwritten; a `.local` home without the file still
  receives the store's login; a normal home still adopts.

### Step 1 — backend rows (`src-tauri/src/commands/ollama.rs`)

- Add the two `LocalDriver` rows per decisions 1–3, with a short comment each
  (why launch-only; why Pi is light).
- Update the module comment above `LOCAL_DRIVERS` (`:3843`, "wires Claude
  Code, Codex, OpenCode and Droid") and `list_local_drivers`' doc (`:4206`)
  to name Pi and Cline.
- Tests: extend `launch_only_drivers_have_no_fallback` (`:5025`) to
  `["claude", "droid", "openclaw", "pi", "cline"]` (OpenClaw is not covered
  today); add `pi`, `cline` to `an_agent_that_sends_no_reasoning_is_left_alone`
  (`:5066`); add
  `local_launch_line_ok("pi", m, "ollama", ["launch","pi","--model",m])` and
  the cline equivalent to the existing assertions near line 5122; a test that
  pi is light and cline heavy.
- Nothing to add to `HOST_BOUND_LOCAL_AGENT_CMDS` (`services/sandbox.rs:520`)
  or `AGENT_CMDS` (`services/terminal_service.rs:308`): a launch-only tab's
  `cmd` is `ollama`, already in both (checked).
- `services/mobile_control/discovery.rs::agent_label_of` resolves the driver's
  bin through `agent_label_for_bin` — `pi`/`cline` are registry bins, so the
  phone names the tab "Pi"/"Cline". Verify with a test if one exists for
  OpenClaw/Droid; otherwise none.

### Step 2 — frontend (`src/`)

- `src/lib/agents/localDrivers.ts`: doc comment's driver list (line 5).
- `src/components/tabs/localModelGroup.ts`: `DRIVER_UNTESTED` + spread in
  `driverRow` (decision 4); the "Light-harness drivers (OpenCode) lead"
  comment (`:152`) names Pi.
- `src/lib/untested.ts`: two rows; `area` must match `^[a-z]+$` (registry
  test) — use `agents`, not `local models`. Update `mobile.newTab.local`'s
  `what` (`:539`).
- i18n strings that enumerate the drivers — English `src/lib/i18n.ts`
  `intro.models.step5Body`, `localModel.noToolsTitle`, and every dictionary in
  `src/lib/i18nDicts/` that carries those keys — add Pi (light, listed with
  OpenCode) and Cline.
- Comments that list the drivers: `lib/agents/localTabSpec.ts:58-59`,
  `components/models/ModelsHubSections.tsx:34`,
  `components/tabs/useAddTabMenuData.ts:30`, `components/tabs/TabBar.tsx:742`,
  `components/layout/intro/LocalModelsPage.tsx:136`.
- Test: in `src/__tests__/system/LocalModelGpuGate.test.ts` (the existing
  `localModelMenuGroup` test), Pi in the light half (before Mistral) and Cline
  in the heavy half, both with their `untested` id.

### Step 3 — Codex extra-args forwarding (deferred — see decision 6; kept as the todo's sketch)

- Replace `ollama_has_launch()` with one probe returning
  `{ has_launch, forwards_args }` from the same `ollama launch --help` run
  (`forwards_args` = help contains `EXTRA_ARGS`). Pure parser + test on the
  0.34.4 text above and on a pre-forwarding text.
- `prepare_local_launch`: when `extra` is non-empty and `forwards_args`, return
  `ollama launch <sub> --model <m> -- <extra…>`.
- `local_launch_line_ok`: accept exactly that form (persisted lines from either
  path keep restoring). Test both directions, plus a rejected arbitrary tail.
- Fix the now-wrong comments ("forwards nothing", `non_thinking_args` doc,
  the test comment near line 5171).

### Step 4 — docs

- `docs/third_party_update_checklist.md:686-690` Ollama section: sub-commands
  gain `pi`, `cline`; note what they write (Pi `models.json`/`settings.json`
  + legacy-package migration; Cline `providers.json`/`globalState.json`);
  "forwards no extra flags" → true only before ~0.34.
- `docs/help/local-models.md:93` (user help, served by the help MCP): name Pi
  (with OpenCode) and Cline. Other sessions edit this file — edit the range only.
- `DOCUMENTATION.md` has no driver list (checked) — no change.
- `docs/filemap_backend.md` `ollama.rs` row needs no change.
- `todo/group-s-agents.md:59-174` (the `ollama launch` roster item, "PARTIAL"):
  add Pi/Cline there with a 🖐️ manual box "Pi / Cline local tabs start and
  answer" + the four platform pairs, and the deferred Codex-forwarding todo.

## Verification

Gates: `npm run build`, `npm test`, `cargo test`, `npm run lint`,
`cargo clippy --all-targets -D warnings`, `scripts/brand-check.sh`; then
`npm run backend:stale` (backend edits).

Live (user): install Pi (`Manage CLIs`), load a tool-capable model on the GPU,
+ → Local Model → Pi: the tab runs `ollama launch pi --model <m>`, Pi answers
and edits a file. Same for Cline — then a plain Cline tab in another project
still uses its own provider (step 0b). Close + reopen the app: both tabs restore.
On the phone: ＋ → local agents lists Pi and Cline.
