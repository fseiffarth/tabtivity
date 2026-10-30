# Mobile access — who may reach a scope

Which paired phone may list, open and get pushes for a project, a box or the
root console. Plan and review: `docs/done/mobile_device_scoped_access_plan.md`.
Root's own gate: `root_console.md` "On the phone". Pairing itself (device
keys, sessions, Lock down) lives in `services/mobile_control/auth.rs`.

## The layers, outermost first

1. **The host** — `tabtivity_mobile_host.enabled` in `settings.json`, plus a
   running sidecar. Nothing below matters while it is off. The phone app it
   serves is always the bundle compiled into that binary (`MOBILE_ASSETS`),
   dev builds included: the dev-only overlay from `target/mobile-pwa/` let any
   agent plant the app every paired phone runs, and is gone (threat recheck
   2026-10-08, gap 20; `dev_builds.md`).
2. **Which folder a project type gives the phone** — no project type is
   barred (the old trust tiers are gone, 2026-10-21): the switch below is the
   whole consent, for a local, remote, container and VM project and for every
   box member alike. The type decides only *what the phone reaches*
   (`discovery::mobile_root`, `project_host`; desktop twin
   `lib/projectTabHost.ts`, used by `MobileBridgeHost`):
   - local and container: the entry's `directory` (a container mounts the host
     folder at the same path);
   - remote: the local mirror (`mirror` key, else
     `remote_sync::default_mirror_dir_in`), never `directory`, which holds only
     `project.json`/`sync.json`; a tab saved with `cwd = directory` is read as
     running in the mirror;
   - VM: the opted-in `mirror` only; without one the project is listed with no
     folder (`folder: false`).

   **Locality rule.** The phone attaches through a tmux session on this
   machine, so on a remote, VM or container project only tabs that run here are
   listed (`runs_on_this_machine`, the window's `effectiveTabLocation` table;
   the fixture `tabLocality.fixture.json` pins both). `create` is `all` (local),
   `agents` (remote with a mirror; the agent runs `local_only` in the mirror and
   is saved `location: "local"`) or `none` (container, VM, mirror-less remote):
   a refused create/reopen answers `not_attachable`, in the sidecar and the
   bridge. The scheduler's headless relaunch follows the same placement
   (`launch_place`, via `headless::restart_options`): a remote project's local
   agent restarts in the mirror, a container project's agent as it always did
   (`launch_prep` puts it in the container); a remote-host or VM agent is not
   restarted without a window (there is no pool to reach it; it failed before
   too). Tabs in a container or in a VM reach the phone in a later version.
   The desktop's phone button and Settings → Mobile rows say this per type
   (`mobile.hostReach.*`, pill `mobile-every-project-type`).

   **Remote-host tabs** (`docs/mobile_remote_host_tabs_plan.md`). A remote
   (not VM) project's tab that runs on its host — `location` `"remote"`,
   `"host:<id>"` (a worker its record still names) or a location-less shell —
   is listed too (`discovery::host_of_tab`, one rule with the refresher's
   targets): a resumable agent, or a shell behind `shell_tabs`, carrying its
   scope's tmux name, only while `remote.persist_sessions` is not `false`;
   never on Windows. It is read off the session file with no mirror and no
   cwd check, and `PublicTab.on_host` is the only new fact the phone gets. The
   phone reaches it **only through the desktop's ControlMaster** for that
   host, by its literal socket path (`ssh_exec::host_mux_args`:
   `ControlMaster=no`, `ProxyCommand=false`, `BatchMode=yes`, `-e none`): it
   never dials and never prompts, so a host tab is available only while the
   desktop holds that master (or `ControlPersist` after). Liveness comes from
   `host_live`'s background refresher, never from a request; with no window
   it trusts the socket file alone (probing would keep the master alive), and
   the terminal upgrade re-checks with `ssh -O check` (`409 host_offline`; an
   open terminal whose host goes away closes with `host_offline`). What would
   act on this machine answers `409 tab_on_host`: inbox upload, desktop
   images, Mark up Submit, sign-in and its callback, activate-with-tab, and —
   with no window only — schedule writes, held prompts, a stored prompt's
   send-now and undo-clear. Transcript, readings, worktrees and git skip a
   host tab (nothing local describes it). A close with no window drops the
   record only (the host session runs on, as after a desktop close), and the
   closed tab is not offered under "Recently closed" there (`reopen_tab`
   could not start it).
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
ids the sidecar mapped, and `mobileScope` repeats the switch and the folder
rule only. The one exception is bookkeeping, not access: a request that makes a
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
- A project made **on a phone** (`POST /api/v1/projects` →
  `projects::create_project_for_phone`) is written with the switch on and a
  list of just that phone, status `active`. The phone sends a name and nothing
  else: the folder is always `<projects root>/<sanitize_name(name)>`, local,
  scaffolded, git `local` — no import, path, remote, container or VM, and a
  folder that exists is refused (`project_exists`). It is the one place the
  sidecar adds a `projects.json` entry (under the file's lock, as
  `headless::activate` patches one); an open window is poked to re-read the
  registry (`projects` slice).

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

## Resolving diverged files (the Diverged list)

The desktop's orange view at phone width (`diverged.rs`, `lib/mobileDiverged.ts`,
`DivergedSheet.tsx`): a remote project's diverged files and new local files, a
compare on tap, and the take-a-side, upload and delete actions. **It runs in the
window, unlike the 📁 library's remote side:** that one rides the desktop's
ControlMaster read-only, but a status pass and a transfer need the window's
pooled SFTP session, the manifest and `sync_op`, so they call the same commands
the orange view calls. With no window the list is `desktop_unavailable`. Reading
sits behind `project_files`, since it shows no more than the library would;
acting, and the preview that prices it, also need
`tabtivity_mobile_host.project_sync` (default off). The window's connection lamp
is forgotten when the desktop switches project, so `connected` is the lamp **or**
a status pass that stat'd a file on the host.

Paths cross as display text plus a token sealed under this list's own binding: a
browser token never names a transfer. Hidden names (`files::hidden`) are only
counted. A failure crosses as a count, because the backend's sentences can name
full paths. Three rules keep a stale phone from losing data:
- **The window re-reads status before every act** and skips, and reports, any
  file that no longer stands as the row offered it (`stillStands`). A deletion
  also meets `sync_apply_delete`'s own live premise.
- **A new file is pushed unforced**, so one that appeared on the host in the
  meantime is a failure, not an overwrite.
- **A resolve is never retried.** Past its 120 s deadline the window may still be
  working, so the phone says the outcome is unknown and reads the list again.

The three-way merge stays on the desktop (the phone compares, read-only), and so
does the scan for files only the host holds: it is a recursive host walk behind
the HPC guard, which a phone must not start or prompt for.

## Writing into a project (Upload here)

The one route by which a phone puts a file into a visible project folder
(`uploads.rs`, `docs/done/phone_upload_plan.md`); everything else a phone sends goes
to the hidden, git-ignored drop box (`.tabtivity/inbox/`) or the state dir's
global inbox. It sits behind its own host switch
(`tabtivity_mobile_host.project_uploads`, default off, only with
`project_files` on) on top of every layer above, and the folder the user
stands in is the consent, so it is **add-only**: a new name through an
exclusive create, never an overwrite, rename or delete — except the undo of a
file this feature wrote that is still byte-for-byte as logged (the log in the
sidecar's control dir names it; the disk decides). Folders are named by the
browser's sealed tokens and walked held, no link followed, and none is
created. **No path segment may start with `.`**: the listing shows `.github`,
`.cargo`, `.vscode` (only `.git`, `.tabtivity`, `.env*` are hidden), and a
new file there can change what tools run (`.github/workflows/*.yml`,
`.cargo/config.toml`, `.envrc`) — the user picking the folder is not enough
consent for that. A paired phone can already type into shells, so this widens
nothing for a hostile phone; the risk it answers is a private document one
`git add -A` from a public remote, hence untracked landing, the desktop's
*Added to projects* notice with Undo, and nothing auto-committed. Non-dot
names that tools pick up (`conftest.py`, a root `Makefile` in a project
without one) are not refused — within that threat note.

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
- **Phone Undo is bound to neither time nor phone.** Any phone that reaches
  the project may undo any logged, unchanged upload of it given the file's
  listing token, until the log line is dropped (7 days, at the next upload's
  rewrite) — also one the desktop pressed **Keep** on (Keep only hides the
  row in that desktop's storage). Flagged in `docs/done/phone_upload_handoff.md`,
  undecided.
- **Sign-in callback.** `sign_in_callback` checks only that the phone sees
  *some* agent tab, then relays the localhost address to whichever CLI is
  listening — not bound to that tab. Pre-existing.
