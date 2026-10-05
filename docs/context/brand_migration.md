# Brand migration — why it is shaped this way

`services::brand_migration` moves what an older build wrote under the app's old
name to the current name. It was built while the two names were still the
same — inert, so that the rename itself was one commit that changed names and
no behaviour — and has been live since the flip (release A): the app is now
Tabtivity, and the old name is the one in `brand::LEGACY`.

Status of each kind of thing: `docs/rename_phase2_handoff.md`; what the flip
changed and what it left: `docs/rename_phase3_handoff.md`.

## The no-op guarantee

For a pair whose name did not change (`pair.renamed()` is false — every build
before the flip, and the tests' `UNCHANGED` pair since):

- `run_at_launch` returns before it builds anything, and `run_startup` before
  it looks at the disk. **No record is written — not even an all-done one.** A
  step marked done before there was anything to move would be skipped on the
  launch that follows the rename.
- Every dual read is written `if let Some(old) = pair.legacy(Name::X)`, and
  `legacy` returns `None` when the old spelling is the current one. So there is
  no second lookup to make, not a second lookup that happens to match.
- `brand::legacy_hit` has nothing to count and the log refuses to write.
- Generated scripts get an empty preamble, `key.json` gets no `labels` entry,
  no alias is installed: files are byte-for-byte what they were.

Tests hold this for the engine (`with_the_name_unchanged_a_launch_touches_nothing`,
against a seeded install: same tree before and after, nothing written) and
per module (`the_unchanged_pair_…`).

## Names as values

`brand.rs` declares every persisted name once, in `names!`, which now also
generates `Name` (an enum of them) and `Forms::name`. A `Pair` is the current
and the old brand; production passes `brand::PAIR`, tests an invented brand
over the real old one (`testing::RENAMED`). Steps and dual reads never read the
constants, which is the only way to test "the names differ" while they do not.
`a_name_built_at_runtime_is_its_constant` keeps the two spellings from drifting.

`brand.rs` is also compiled into `build.rs`, so it cannot name `services`: the
hit sink is a function pointer installed by `hits::install()`, first thing in
`main` and `run`.

## Steps

One step per kind of thing, each idempotent, each recorded in
`<state>/migrations.json` (`started` / `done` / `pending` / `lazy`).

- **Launch steps** (`STARTUP_STEPS`, in order): retire the old phone host →
  move the state dir → move `~/.local/share/<name>` where it is another folder
  → re-point stored absolute paths → rewrite names inside the app's own JSON
  state → copy the webview data → bring the agent homes over.
- **Lazy steps** (`LAZY_STEPS`) need something a launch does not have. They
  are only *listed* at launch; the module that owns the thing runs them:
  a project when it is opened or swept, a remote project when it connects, a
  keyring entry when it is read, the Docker image when a container starts, the
  Ollama drop-ins when the user next runs the command that writes them.

Rules every step follows:

- **Rename where a rename is atomic, copy-verify-switch where it is not.** The
  state dir and a project's folder are renamed (same parent, so nothing is ever
  half-moved; a failed rename changes nothing). The webview data, IndexedDB
  and git refs are copied, read back, and only then is the old copy removed.
- **A failed step leaves the app working.** Every folder lookup tries the
  current name and then the old one (`resolve_named_dir`), so a state dir that
  could not move (a locked executable on Windows, both names present) is simply
  used where it is and the step stays pending.
- **`started` travels with the thing.** The state-dir step writes `started`
  into the old folder before the rename, so a crash between the rename and the
  link is told apart from a fresh install — which must never get a link, or
  anything else, under the old name.
- **A rewrite of a live file goes through its lock.** A Mobile host kept
  running after quit can write the state files while a launch migrates them,
  so every rewrite of a state file — the name rewrite and the state-path
  rewrite alike (`persisted::rewrite_json_locked`) — takes the file's
  `storage::FileLock`, re-reads under it, and moves the counter the other
  writers check (`workspaceVersion`, `rev`); a file with nothing to change is
  left alone and gets no lock file. The archive's restore manifests (user's
  tree, no other writer) are rewritten without one.
- **Pending until it is really done.** A failed state-dir rename keeps
  `state-paths` pending too (decided from the record, not from whether the
  current name exists), and a move whose old-path link could not be made
  stays pending and links at the next launch. A retried move first stops a
  phone host running from the old folder (`World::stop_host_in`): the launch
  that could not move it started the current host in there. An agent-home
  config file that could not be re-pointed keeps `agent-homes` pending (the
  markers are renamed regardless); one met at spawn re-opens the step
  (`reopen_step`). A link or other non-file where a config file belongs is
  skipped, not a failure.
- **Nothing outside the file system without `World`.** The service manager and
  the phone host's admin socket are reached through a trait the tests replace.

## The state dir's link

After the move a symlink (a junction on Windows) at the old path leads to the
new one. It is the net for absolute paths nothing rewrote. Known holders that
are rewritten: the registry files, each project's saved session and sync
state, the archive's restore manifests, and the CLIs' config files in every
agent home. **Known holder that is not:** a VM overlay names its base image by
absolute path inside the state dir, so removing the link in a later release
needs `qemu-img rebase -u` on every overlay first.

A sandboxed instance (state dir named by the environment) gets no machine-wide
step: it must not stop the real phone host or move the real folders.

## Agent homes: why the config files are rewritten

Every hook registration is "add my command unless it is present", keyed on the
exact command, and the command holds the state dir and the script's name. Left
alone, the next spawn would add a second hook beside the old one and both would
fire. Rewriting the old command in place (and the MCP allow rules, the hint
block, Copilot's own file) is what lets the registration find its entry again.
Codex keeps a trust record per hook command, so it asks once more.

## What stays under the old name on purpose

- **The `~/<name>` tree** of an existing install (projects, boxes, archive):
  used where it is. Moving the user's projects is its own, user-started step.
- **A mail store's label set.** The HKDF labels are key inputs. `key.json`
  names the set (no entry = the old one), an old store opens under its own set
  with nothing rewritten, and a new store uses the current set. Re-encrypting
  an old store is **not attempted**: it would re-seal every table, re-derive
  every keyed digest and rename every blob, and it is not provably safe yet.
- **A VM's guest names.** cloud-init reruns first boot when the instance id
  moves, and the id is recomputed at every boot from names in the user-data.
  `VmNames::of_existing` picks them from the guest user stored in the project
  record. The baked base image is found under its old name and never renamed.
- **Pinned for good** (`LEGACY_*` used deliberately): the hash contexts of
  remembered-network ids and subagent handles, the UID domain of calendar
  events without a UID. They are identifiers other systems or stored data
  already know; none is ever shown.
- **Exports** written by older builds stay importable (manifest name,
  extension).

## Old-name conveniences only on an upgraded install

`migrations.json` records `upgraded` when a launch step met something under the
old name. Only then are the send alias and the old-variable preamble of the
generated scripts installed. A fresh install never gets a file that spells the
old name, which the fresh-install test checks by searching the whole tree.

## The fallback log

`<state>/legacy-hits.json`, `{id: {count, first, last}}`. Counts are kept in
memory and written at most every 30 s per process (at once for a new id, and at
exit), because some dual reads sit on a poll. A fenced agent cannot write the
state dir, so the old send command leaves a note in the project's outbox and
the next listing counts it. Settings → Updates shows the summary once the name
has changed.

## Things that deliberately do not follow the name

- **Pinned ids** (`brand::PINNED_*`, `PINNED_ICS_UID_DOMAIN`): hash contexts
  and the ICS UID domain. Their values are stored or handed out and cannot be
  recomputed, so they are literals outside the brand table.
- **The mail store's labels**: a store keeps the label set it was written
  under, for good. There is no re-key.
- **A project's own `-screenshots` / `-emails` folder**: the user's files. A
  project that has one under the old name keeps saving into it
  (`generated_dir_name`); nothing is renamed and no hit is counted.

## The copy run

`scripts/brand-copy-run.sh` runs the launch steps over a copy of a real
install without the app (`brand_migration::copy_run`, an ignored test). It
builds a home of its own rather than setting the state-dir override, because
an overridden state dir is a sandboxed instance and skips the move.
