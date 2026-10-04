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

The desktop does not know which phone asked and must not need to: it only
ever sees raw ids the sidecar mapped, and `mobileScope` repeats the switch and
trust tiers only.

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
- Narrowing does not cancel prompts a phone already held or schedules it made
  (same as switching access off).
- Project export and import drop both keys (`project_transfer.md`): a bundle
  never opens a project to the importing machine's phones, nor carries foreign
  device ids.

## Known gaps

- **Downgrade.** An older build ignores the list, so after a downgrade every
  project with the switch on reaches every phone again. Accepted, as for any
  new opt-in field.
- **To-do board names.** The board's project picker and card tags list every
  registry project to every phone, switch or not (`MobileBridgeHost`
  `todoBoard` → `publicProjects`, headless `project_names`). Not a secret
  boundary today; filtering per phone is a follow-up TODO.
- **Sign-in callback.** `sign_in_callback` checks only that the phone sees
  *some* agent tab, then relays the localhost address to whichever CLI is
  listening — not bound to that tab. Pre-existing.
