# Mobile access — who may reach a scope

Which paired phone may list, open and get pushes for a project, a box or the
root console. Plan and review: `docs/mobile_device_scoped_access_plan.md`.
Root's own gate: `root_console.md` "On the phone". Pairing itself (device
keys, sessions, Lock down) lives in `services/mobile_control/auth.rs`.

## The layers, outermost first

1. **The host** — `tabtivity_mobile_host.enabled` in `settings.json`, plus a
   running sidecar. Nothing below matters while it is off.
2. **Trust tiers** — only a *local* project that is neither a container nor a
   VM is ever a phone scope (`discovery::mobile_local`, and its desktop twin
   `MobileBridgeHost` `mobileProject`). No switch can widen this.
3. **The scope's switch** — `tabtivity_mobile_access` (`MOBILE_ACCESS_KEY`) on
   the project entry in `projects.json` or the box in `boxes.json`. Absent or
   false = off. A box's switch is the one consent for the box's `box:<id>`
   scope: its tabs (box folder or a local member's folder) are listed by the
   box's switch, never a member's; a member's switch stays about the member's
   own tabs. Root has no record, so its switch is the host setting
   `root_access` behind the review gate (`root_console.md`).
4. **The per-phone list** — `tabtivity_mobile_devices` (`MOBILE_DEVICES_KEY`)
   beside the switch: device ids (`auth::Device.id`, 27 chars of base64url).
   - switch on, list **absent** → every paired phone, phones paired later too
     (the behaviour before lists existed; every older record keeps it);
   - list **present** → only those ids;
   - list empty, all ids revoked, or **malformed** (not an array of strings) →
     no phone. Fail closed *per scope*: `ProjectRecord`/`BoxRecord` and
     `schema::boxes::ProjectBox` read it leniently, so one bad value never
     fails the catalog, `read_boxes`, or another scope.
   - switch off → the list is ignored, and `set_*_mobile_access(false)`
     removes both keys.

Root has no per-phone list (out of scope).

## Where it is enforced

The sidecar alone. Every phone route resolves its opaque project/tab id
through `host.rs`'s `catalog(state, &Phone)` / `catalog_fresh`, which apply
`Catalog::for_device`; a `Phone` is minted only by the three auth helpers, so a
new route cannot skip it without the compiler noticing. A filtered-out scope
answers exactly like an unknown id (`project_not_found` / `tab_not_found`),
so a phone cannot tell "not shared with you" from "does not exist".
`pty_bridge`'s periodic re-check filters for the session's own device:
narrowing a list detaches an open terminal within about five seconds with
`access_revoked`. Push (`push.rs`) sends an agent notice only to the scope's
phones, and a notice no eligible phone wants spends neither budget nor
cooldown. `agent_tab_ref` (the push lookup, not a phone request) is the one
unfiltered catalog read.

The desktop never decides access by which phone asked: it only ever sees raw
ids the sidecar mapped, and `mobileScope` repeats the switch and trust tiers
only. The one exception is bookkeeping, not access: a request that makes a
rule in `agent_tasks.json` (`ScheduleMutate`, `PromptMutate` send,
`HoldPrompt`, `MarkupAnswer`) carries the asking phone's `device_id`, and the
rule records it as `phone_device` (see *What a phone leaves behind*).

## Writing the list

- `set_project_mobile_access` / `set_box_mobile_access` take
  `devices: Option<Vec<String>>`. `None` = every phone (key removed). A list is
  validated (≤ 64 ids, exact id shape), de-duplicated and **cut to the phones
  paired right now** (`auth::read_paired_devices`); a list empty after that is
  refused. The project command answers `{ enabled, devices }` — what was
  stored, which is what the store must patch from.
- **Every UI path passes the current list unless the user picked All phones.**
  `null` widens to every phone, so a re-enable, refresh or retry that sends
  no list silently undoes a narrowing. In the desktop UI only the picker's
  *All phones* and a Settings switch turned on from off send `null`.
- The UI never writes an empty list: unticking the last phone is refused —
  turning access off is how a scope reaches no phone.
- Revoking a phone does not rewrite any list (the sidecar must not write
  `projects.json`); its id simply stops matching. A **re-paired phone gets a
  new id** and is not on any old list. **Lock down / Forget all** clears every
  device, so every scope with a list reaches no phone until re-picked; the UI
  shows such a scope as "No phones" in the warning tone.
- Narrowing (or switching access off) cancels the prompts that phone held and
  the schedules it made in the scopes it lost — see below.
- Project export and import drop both keys (`project_transfer.md`): a bundle
  never opens a project to the importing machine's phones, nor carries foreign
  device ids.

## What a phone leaves behind (#2348)

Every rule a phone makes — a schedule, a sent collected prompt, a held
prompt, a markup answer — names it (`ScheduledAgentPrompt::phone_device`, the
paired device id; window path via the request's `device_id`, headless path
directly). `services::mobile_control::phone_origin` cancels a rule whose
phone is unpaired or whose scope no longer reaches it (`discovery::ScopeAccess`,
the catalog's own rule):

- eagerly — the sidecar's admin plane after Revoke / Forget all, the window's
  `mobile_admin` (which also reloads the schedule lists) and its
  `set_project_mobile_access` / `set_box_mobile_access`, and the sidecar's
  scheduler at start;
- at fire time — `agent_tasks` claim, which both owners take before typing:
  such a rule is removed instead of claimed (`ClaimOutcome::Cancelled`). This
  covers a change made while the other owner was down, root access turned
  off, or a hand edit.

**A phone's edit takes a rule over** (follow-up, 2026-10-05): a schedule
update, a held-prompt edit (`EditHeldPrompt` carries `device_id` too) and a
collected prompt the phone creates or edits stamp that phone — on a desktop
or agent rule as well — so the rewritten words go with the phone. A collected
prompt keeps the phone that wrote it (`ProjectAgentPrompt::phone_device`,
never sent to the browser), and the rule a send makes of it names the sending
phone, else that one, whichever surface sends it. An edit naming no phone (the
desktop, an agent, an older sidecar) keeps the stored stamp
(`agent_tasks::apply_upsert`, `agent_prompts::apply_upsert`).

A rule with no `phone_device` (desktop, agent, or written before the field)
is left alone. An access that cannot be read (`devices.json`,
`projects.json`, or for a box or root rule `boxes.json` / `settings.json`)
holds the rule back, neither typed nor removed. Cancelled rules simply leave the schedule lists and the
held-prompt chip; each pass logs one line. A sent collected prompt's history
row keeps saying *queued*.

## Known gaps

- **Downgrade.** An older build ignores the list, so after a downgrade every
  project with the switch on reaches every phone again. Accepted, as for any
  new opt-in field. Rules carrying `phone_device` make `agent_tasks.json`
  unreadable to a build older than #2348 (`deny_unknown_fields`), as `origin`
  did before it — it refuses the file rather than rewriting it, so nothing is
  lost, but its schedules stop until the phone rules are gone. The sidecar can run ahead of the window (its copy is
  replaced at a launch or by Update host; a failed update keeps the newer
  one): a window older than #2348 drops a request carrying `device_id`
  unparsed (`DesktopRequest` denies unknown fields), so `admin::desktop_call`
  asks once more without it when the window accepted and then dropped the
  connection — the older window makes the rule unstamped, as before, instead
  of the sidecar taking the headless path with the window open.
- **A phone's edit of someone else's rule.** Decided 2026-10-05: the phone
  takes it over (see above), so it no longer survives that phone's revoke.
  Left: a schedule the desktop composes in the schedule dialog from a
  phone-written collected prompt is the desktop's (the user wrote and saved
  it there); an older window behind a newer sidecar drops the `device_id`
  of an edit, as of every phone request.
- **To-do board names.** The board's project picker and card tags list every
  registry project to every phone, switch or not (`MobileBridgeHost`
  `todoBoard` → `publicProjects`, headless `project_names`). Not a secret
  boundary today; filtering per phone is a follow-up TODO.
- **Sign-in callback.** `sign_in_callback` checks only that the phone sees
  *some* agent tab, then relays the localhost address to whichever CLI is
  listening — not bound to that tab. Pre-existing.
