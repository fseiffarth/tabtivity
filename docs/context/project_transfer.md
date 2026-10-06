# Full project export / import

Moving one Tabtivity project to another computer. Backend:
`src-tauri/src/commands/project_transfer.rs`. UI:
`src/components/projects/ProjectExportDialog.tsx` (pill menu → "Export
project…") and `src/components/projects/ProjectImportBundleDialog.tsx`
(＋ menu → "Import Project File").

## Why it exists

A project is not a folder. Copying the folder to a second machine and importing
it there gives you the files and **nothing else** — every question Tabtivity ever
asked about that project has to be answered again, because the answers live in
four other places, all keyed by project id:

| What | Where it lives |
|------|----------------|
| git label, remote spec, compute hosts, container spec, interpreter, run host, categories, panel prefs | `projects.json` entry |
| description, created-at, default apps, everything else descriptive | `<dir>/project.json` |
| tab layout, active tab, agent session ids | `<state_dir>/sessions/<key>/terminals.json` |
| time tracking | `<state_dir>/time_summary.json` |
| box membership | `<state_dir>/boxes.json` |

Export packs all five; import puts them back and re-points every path.

## The bundle

A `.tabtivityproj` file is a zip (the `zip` crate was already in the tree for
`commands::fs`'s dropped-archive extraction):

```
tabtivity-export.json   the manifest — everything that is not a file
dir/…                a local project's folder
state/…              a remote project's local state dir (project.json only)
mirror/…             a remote project's local mirror tree
```

The extension is distinct from `.zip` on purpose: a bundle that lands inside a
project tree must not be double-clicked into `extract_archive`.

`format` in the manifest is checked on import and a **newer** bundle is refused
rather than read partially. Dropping a section an older build does not know
about is exactly how a "full" export quietly stops being full.

## The trust split — the one design decision here

The manifest is written by Tabtivity. But a bundle is a *file*: it can be mailed,
dropped in a shared folder, fetched from anywhere. So "written by Tabtivity" is a
claim, and import treats the whole file as untrusted:

- the tab layout goes through the same sanitizer a cloned repository's does
  (`terminal_service::adopt_untrusted_session` → `sanitize_tab_layout`): a tab
  naming a command this installation does not know keeps its label, kind and
  cwd but loses its `cmd`, `resumeArgs`, `env`, `location` and `sessionId`;
- `open_apps` — a list of host commands launched on every activation — is
  dropped outright, upholding the invariant that it is never adopted from
  anywhere outside the state dir;
- the same session fields are stripped from the imported `project.json`, so a
  later `adopt_folder_tab_layout` cannot smuggle back what import refused;
- `project.json` is **rewritten from the manifest**, not adopted from the
  unpacked tree — it is read back for the container spec and the interpreter,
  and the tree half of a bundle is attacker-controlled like any project folder;
- zip entries are confined with `enclosed_name`, and symlink entries are created
  only **after** every directory and file, so a link in the archive can never
  become the path a later file is written through.

What import *does* adopt is the registry entry's settings. That is the feature,
and it is a different risk class: none of those fields is executed by importing.
The user still has to switch to the project and press something.

## What deliberately does not travel

- **Phone access** (`MOBILE_ACCESS_KEY`, its per-phone list
  `MOBILE_DEVICES_KEY`, and the access key's old-brand spelling). Mobile
  access is consent given on one machine to the phones paired with it, and a
  per-phone list names device ids that mean nothing elsewhere. Export strips
  them from the manifest's entry and import drops them from the entry and the
  rewritten `project.json` (`project_transfer::mobile_keys`) — before this,
  import adopted the entry's extras wholesale, so a bundle exported with
  Mobile on opened the project to every phone here without being asked.
- **Passwords and access tokens.** They live in the OS keychain keyed by host
  (`services::remote_credentials`), never in a file Tabtivity writes. The remote
  spec travels; the secret is re-entered on the far side. The export dialog says
  so before the file is written.
- **Host-bound sync state** (`sync.json`, `git_peer.json`). Both describe a
  relationship between *this* machine's mirror and a host. Carrying them to a
  different mirror produces the false-green failure
  `commands::projects::clear_host_bound_state` documents: `push_decision` sees
  `ever_synced = true` against a file that is not there, refuses to push, and
  the file tree paints it green. A remote import therefore starts with no sync
  history at all. The remote state dir is packed by **allowlist**
  (`REMOTE_STATE_FILES`), not skip list, so a file dropped beside them later
  does not start travelling because nobody remembered to exclude it.
- **`host_bound/` markers**, which pin a tab to a machine that is not the
  destination. They live under the session dir and are not packed.
- **A project VM's overlay disk.** So a VM project is refused up front
  (`export_blocker`) rather than exported into something that cannot boot.

## Sizes, and why the dialog has toggles

"Export the project" has no single right answer. A tree with a 3 GB
`node_modules` and a 900 MB `.git` is mostly things the far side can rebuild or
re-clone. So `preview_project_export` walks the tree once and classifies every
file as plain / git / rebuildable (`Class`, sticky on the way down — a
`node_modules` inside a `.git` is still history), and each switch in the dialog
shows what it costs. The estimate updates live; nothing is written until the
save dialog returns a path.

`REBUILDABLE_DIRS` is a near-twin of `commands::search`'s and `commands::fs`'s
skip lists and deliberately not shared with them: those two also skip `.git` and
`.tabtivity` unconditionally, and both of those must be exportable.

## Identity on the far side

The exported project **id is reused** when it is free. That is what makes a
moved project the same project: its agent session directories, its time history
and any box that still lists it all key off the id. When the id is already
registered here (importing a copy beside the original) a fresh one is minted and
the dialog says so.

Paths are re-pointed with `storage::rewrite_path_prefix` — the same function the
folder rename uses — over the registry entry, the `project.json` and the session
layout, so a tab's cwd follows the folder instead of naming a directory that
exists only on the other machine. An absolute path *outside* the project folder
(a pinned conda interpreter, a data mount) cannot be re-pointed and does not
survive the move; relative ones do.

Box membership travels as **names**, not ids — an id means nothing elsewhere.
Import joins boxes that already exist here and reports the names that matched
nothing. It never creates a box: a box is a meta-project with its own folder and
agent docs, and a file should not be able to add entries to the strip.

Time is merged, not added: a day is raised to the imported figure and a day this
machine already recorded more on keeps its own number, so re-importing the same
bundle twice cannot double a total.

## Known gaps

- Export is refused for VM projects (above). Carrying a qcow2 overlay is a
  separate feature if it is ever wanted.
- A remote project's tree on its host is never part of the bundle — only the
  local mirror is. That is the same rule archive follows.
- Progress is emitted per 64 files (`project-export` event); there is no cancel.
