# Steering coverage fixes

## Scope and working rules

Implement the five gaps confirmed in the steering audit. Work on develop and preserve all existing staged, unstaged and untracked work: this checkout already contains substantial steering and Reader changes. Re-read current source before editing. Do not commit, push, start, stop or restart the app. Frontend changes only are expected. Follow AGENTS.md, translations, shared dialogs, existing state ownership and untested-feature registration rules. Do not add phone key rebinding: default-only phone steering is an explicit v1 decision.

## 1. Root popout scope

`src/lib/window/focusPopout.ts:focusNextPopout` reads the workspace scope even while Root is shown. Resolve the scope through the existing steering scope helper (or pass its resolved scope explicitly). Use that same scope in the popout availability selector in `SteeringLegend.tsx`. Preserve per-scope cycling, and advance the last-raised position only after a successful focus.

Acceptance: J in Root cycles Root popouts, J in a project cycles that project's popouts, and each legend reflects its shown scope. Add meaningful regression coverage of the actual scope selection, not just the pure label helper.

## 2. Failed popout focus preserves steering

`useKeyboard.ts` exits before awaiting `focusNextPopout` and ignores its result. Keep steering when there is no popout, the native window is gone, or invoke fails. Exit after successful focus only. Guard async completion against a later steering exit/re-entry, scope change or navigation so an old response cannot end a new steering visit. Keep the blur grace behavior intact.

Acceptance: no popout / false / rejected invoke preserve steering; successful focus ends the initiating visit. Cover delayed responses and the relevant scope change race.

## 3. Slider keyboard control

`steeringRegion.ts:isTextEntry` excludes range inputs, so activation clicks them and arrows keep navigating. Give range controls an explicit keyboard handoff on activation, or equivalent adjustment behavior consistent with surrounding conventions. Keep search-field discovery restricted to actual text/search controls; simply treating sliders as searchable fields is insufficient. Native arrows must adjust the value after activation. Verify the PDF markup asking dial and Todo task completion slider. Also inspect phone generic-region sliders for the same issue and fix if the same missing handoff exists there.

Acceptance: steer to a slider, activate it, adjust via keyboard, and leave/re-enter steering normally. Existing checkbox, select, text field and search behavior remains correct. Add a focused interaction regression.

## 4. Reachable calendar rename

`CalendarSidebar.tsx` exposes rename only as a double-click on a span with default cursor. Provide an accessible reachable rename action, or make the existing name a proper keyboard control and annotate its activation for steering. Reuse the current inline editor and its save/cancel semantics. Avoid adding a second rename implementation. All new display strings use i18n.

Acceptance: steering reaches rename and opens the existing editor; Enter saves and Escape cancels. Verify the marker/control is included by region target discovery and activation actually starts editing.

## 5. Integrated cockpit steering

Cockpit currently falls back to the generic overlay region. Its local roster shortcuts (`CockpitRoster.tsx`) are focus-dependent and are intercepted by the global steering capture handler when steering is active. Implement real integration in the existing steering engine rather than adding a competing document listener.

- Entering steering while cockpit is open, or opening cockpit with U, lands on the shown cockpit surface and never operates on the hidden workspace.
- Provide a coherent route among Decisions, roster and detail, with visible cursor/selection and an accurate translated legend. Use existing movement bindings and reuse the existing cockpit actions (select, show detail, jump, continue, filter) without duplicate business logic. Keep existing non-steering roster shortcuts working.
- Integrate cockpit action scopes/rebinding and conflict checks deliberately. Keep typing in filters/composers safe through the established handoff mechanism. The selected agent's detail composer/questions must act on that agent, not the workspace active tab.
- Support wide, mid and narrow layouts: only mounted/visible columns are reachable; Needs-you popovers take precedence; narrow detail has a keyboard route back to roster. Dialogs/menus above cockpit still take the region cursor and return it when closed.
- Cover the other cockpit views via reachable generic controls or the dedicated cockpit region, so entering or changing views leaves no stale cursor/hidden targets. Preserve Root, Mail, Calendar and To-do's existing dedicated behavior.
- Use existing stores/local state and shared AttachedAgentPane/Reader ownership; do not spawn, hydrate, poll or attach extra agents for steering. Respect pane visibility and one visible view per PTY.
- Register new not-live-verified behavior in `src/lib/untested.ts` with an UntestedTag at the feature entry point. Update only relevant filemap rows and concise context/help text for implemented key behavior.

Acceptance tests should exercise entry from an already-open cockpit and U, roster selection versus jump/show, column movement, filter handoff, chosen-agent detail actions, overlay priority/return, layout changes and narrow back navigation. Favor representative behavioral tests over implementation mirrors. If an interaction requires a design choice, choose a consistent existing pattern and document the final keys here.

## Verification and delivery

Run focused steering/cockpit regression tests during implementation. Run `git diff --check`, then `scripts/gates.sh` in a persistent background session (one run at a time; reuse existing running/cached gates where appropriate). Inspect every result; report unavailable tools or unrelated pre-existing failures explicitly. If any backend code is changed, run `npm run backend:stale` and report it without restarting anything. Do not mark features live-tested: provide exact manual click/key steps for the user, including J in Root, failed J, both sliders, calendar rename and cockpit navigation at each width.

Hand back changed files, final cockpit keys, tests/gate results, outstanding risks and the manual verification steps. The parent agent reviews the diff and the implementation before completion.

## Implemented keys and manual verification

- Cockpit: U opens Now; the dedicated region starts in the roster. E/D and
  up/down select rows; J/K remain available; Enter jumps, Space/right shows
  detail, C continues, / hands off to the filter. Tab/Shift+Tab cycles the
  mounted frame/Decisions/roster/detail areas. Other areas use ordinary region
  controls. Enter activates the actual selected agent's question or composer.
- Open a project popout and a Root popout. Enter steering in each scope and
  press J: each raises only its own popouts. With no popout J keeps steering.
- Enter steering in Settings, reach the PDF markup asking slider, press Enter,
  then arrows. Repeat with a task completion slider; re-enter via the chord.
- In Calendar steer to a calendar name, press Enter, type a name and save with
  Enter; repeat and cancel with Escape.
- Open cockpit already visible, enter steering, and also test entry through U.
  Try all roster actions and the filter's Escape return. Walk into Decisions
  and detail via Tab, answer a question and type in the shown agent's composer.
  Repeat wide (>=1180 px), mid (820–1179 px) and narrow (<820 px); inspect the
  Needs-you popover and verify Escape returns narrow detail to its roster.
  Change views/width with steering active and check the cursor stays visible.

These are manual verification steps, not claims of live verification.

## Implementation verification

Implemented all five gaps with focused interaction regressions. `npm run build`
passed (desktop/mobile typechecks and desktop/mobile/web bundles); repository
brand, whitespace and full frontend lint gates passed. The changed-file test
run exercised 859 files: 8,742 tests passed and two invariant tests failed.
Both failures were fixed (missing translations and a Reader summary cursor
using a bare keyword); rerunning those suites with steering coverage passed
all 32 tests. The final dedicated steering suite passes 6/6, and the focused
cockpit/calendar/phone checks also pass. The entire 859-file run was not
repeated after those small invariant fixes.

`scripts/gates.sh` stopped at Cargo clippy because its downloaded dependency
could not be written to the read-only Cargo cache under the agent sandbox.
The later Rust gates therefore did not run. This implementation changes no
backend source. Nothing was started, stopped or restarted, and nothing was
committed or pushed. Live verification remains for the user.

Parent review: confirmed that phone sliders already receive native arrows
through the typing-target policy. Added a regression covering arrow passthrough
and Escape returning to steering. Desktop focused regressions passed 36/36.
