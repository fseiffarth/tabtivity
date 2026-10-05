# Tabtivity Mobile × Project Boxes — Parity Plan (TODO 31av / 31aw)

Status: **proposed, 2026-09-20. Nothing here is built.** The shipped half is
31aa (2026-09-05, code-complete, phone QA still open); this plan covers the
two desktop affordances a box has and the phone does not, and says plainly
which desktop box features are deliberately *not* coming to the phone.

## Where 31aa left it

A box reaches the phone as a scope of its own, behind its own switch:

- `tabtivity_mobile_access` on the box record in `boxes.json`, flipped from
  Mobile settings → **Box access** (`components/mobile/MobileSettings.tsx`,
  `commands/boxes.rs::set_box_mobile_access`, which also resolves the folder).
- The sidecar lists it as `kind: "box"` under `box:<id>`, status always
  `"active"`, with `roots` = the box folder first, then every **local**
  member's directory (`services/mobile_control/discovery.rs::Catalog::load`).
  A remote / VM / container member contributes no root; a member's own Mobile
  switch is never consulted.
- Tabs are the `sessions/box_<id>/` ones whose cwd sits below one of those
  roots, joined to live `tabtivity-box_<id>--…` tmux rows (`resolve_scope`).
- The desktop bridge resolves `box:<id>` through `mobileScope`
  (`components/mobile/MobileBridgeHost.tsx`), so every per-scope handler —
  catalog, activity, create, activate (→ `openBox`), rename / close / colour /
  reorder, schedules, prompts, agent status + transcript, `tab_seen`, inbox,
  desktop images — serves a box unchanged.
- The PWA's only box-awareness is the Home row printing `▣ box` where a
  project row prints its status (`mobile-web/src/screens/Home.tsx`).

## The gap

A box exists to hold several repos, and its tabs run in several roots. The
desktop keeps that legible; the phone does not.

1. **A tab never says which root it is in.** `PublicTab`
   (`discovery.rs`) carries label, kind, agent label / status / model,
   schedules, prompts, colour — nothing about the root. Two `claude` tabs in a
   four-member box are indistinguishable unless their labels happen to differ.
2. **A new tab can only land in the box folder.** `create` uses `scope.cwd`,
   which for a box is always `box.folder` (`MobileBridgeHost.tsx`). The
   desktop's `+` menu offers explicit **Files / Shell / ⟨agent⟩ — ⟨member⟩**
   rows (`components/tabs/NewTabMenu.tsx`, `TabBar.tsx`, both fed by
   `boxMembersOfScope`); the phone has no equivalent, so the more useful half
   of a box — start an agent *in that repo* — is unreachable from it.

## Phase 0 — QA what already shipped (blocking)

Run 31aa's manual phone QA before either phase below. The catalog path has
never executed on a phone; building member UI on top of it risks debugging two
layers at once, and every phase here needs the same rebuild + restart cycle
anyway (sidecar + bridge + embedded PWA).

## Phase 1 — a box tab says which member it runs in (31av)

**Wire.** `PublicTab` gains `member: Option<String>` (skipped when absent):
the display name of the member project whose root the tab's cwd sits below,
absent for a tab in the box folder itself and for every project scope.
`PublicProject` gains `members: Option<usize>` — how many local members
contributed a root — so the Home row can read `▣ box · 3`.

**Derivation.** `resolve_scope` already canonicalizes `roots` and tests each
tab with `canonical_below_any`. The only new input is a *name per root*:
`ScopeSource.roots` becomes a `Vec<(PathBuf, Option<String>)>` (the home's
name is `None`), canonicalized into a parallel label vec on `ResolvedProject`.
Matching walks the member roots in order and takes the first one the tab sits
below — deepest-first is unnecessary, because a member root nested inside
another member's tree is already a membership the desktop does not produce.
`ResolvedProject.roots` keeps its current shape so every existing
`canonical_below_any` call is untouched.

**PWA.** The tab row prints the member as a chip beside the tab name, reusing
the treatment the model tag got in 99db99c (`mobile-web/src/screens/Project.tsx`)
— the working sibling, not a new one. Home adds the member count to the
`▣ box` line.

**Privacy decision, to be taken deliberately.** Today a member project's
*name* never crosses to the phone unless that project has its own Mobile
switch on. This publishes it on the strength of the box's switch alone. That
is defensible — the box switch already discloses that member's tabs, their
labels and their agent transcripts — but it widens what the switch means, so
it belongs in the todo entry and in `docs/context/project_boxes.md`, not
silently in a diff. Nothing else changes: no path, no project id, no member
id leaves the desktop in this phase.

**Tests.** Extend the `discovery.rs` box case: a tab in a member root reports
that member's name, a tab in the box folder reports none, a project scope
reports none, and the raw member id still never appears in the body. A PWA
render test beside `MobileTabModel.test.tsx` for the chip.

## Phase 2 — open a tab in a member's root (31aw)

**Wire.** `PublicProject` (box rows only) gains
`members: [{ id, name }]`, where `id` is opaque —
`key_id(host_key, "member", &[raw_scope_id, raw_member_project_id])`, which
means adding `"member"` to `valid_opaque_control_domain`'s allow list (and to
the domain test). `CreateTabRequest` / the bridge's `CreateRequest` gain an
optional `member_id`.

This supersedes Phase 1's `members: Option<usize>` — the count becomes
`members.len()`. Doing Phase 1 first still pays for itself: it is the small,
reversible half, and it settles the name-disclosure question that Phase 2
would otherwise have to settle under more moving parts.

**Resolution.** The sidecar's create route already rewrites `project_id` to
`project.raw_id` before forwarding (`host.rs`); `member_id` resolves the same
way, opaque → the member's canonical root, checked against the scope's own
`roots` so a member id from another box cannot cross scopes. The bridge then
takes `cwd` from the resolved member root instead of `scope.cwd`, with
everything else in `create` unchanged. An unknown or cross-scope `member_id`
is `invalid_request`; a `member_id` on a project scope is `invalid_request`.

**PWA.** The create row (`Project.tsx`, `detail.agents.map(…)`) gains a member
selector for box scopes only — the default stays the box folder, so the
existing single-tap flow is unchanged. Shell and agent only: the phone has no
files browser, so the desktop's "Files — ⟨member⟩" row has no counterpart.

**Tests.** `host.rs`: a create naming a member lands in that member's root; a
member id from another box is refused; a member id on a project scope is
refused. `MobileBoxAccess.test.tsx`: the bridge builds the spec with the
member's cwd and the box's scope key.

## Non-goals (decided, not forgotten)

- **Editing a box from the phone** — membership, rename, Dissolve. Destructive,
  rarely wanted away from the desk, and `BoxEditorDialog`'s container-VM trust
  notice does not survive a translation into a phone sheet. The phone reads a
  box and opens work in it; it does not restructure it.
- **Listing a box's members as projects.** The box switch is consent for the
  box's tabs, not for its members' own scopes. A member still needs its own
  switch to appear as a project row, and that stays true.
- **A per-member status column.** Phone screen real estate; the member chip on
  each tab carries the same information where it is needed.
- **Box-folder file browsing.** The phone has no files surface at all; that is
  a separate feature, not box parity.

## Gates

`npm run build`, `npm test`, `cargo test --manifest-path src-tauri/Cargo.toml`,
`npm run lint`, `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets
-- -D warnings`; then `npm run backend:stale` (the sidecar is backend) and a
rebuilt PWA + desktop restart before any phone QA.
