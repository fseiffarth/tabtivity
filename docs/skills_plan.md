# Agent Skills — MVP Plan

Status: **implemented** (2026-07-28; personal scope added 2026-07-30), on
`develop`, untested live. Backend:
`schema::skills`/`services::skills`/`commands::skills`. Frontend: `lib/skills.ts`,
`components/skills/{SkillsLibraryTab,SkillsLibraryView,SkillsOverlay}.tsx`,
`stores/skills.ts`, wired as the `skillslibrary` tab kind
(`SKILLSLIBRARY_TAB_CMD`, singleton per scope via `ensureTab`) **and** as an
overlay off the header's 🧠 menu. Scaled down from a broader four-part
investigation (discovery/library UX, integration mechanics, backend storage,
cross-agent generalization) after weighing effort vs. value: the underlying
action — getting a skill folder into `.claude/skills/` — is already nearly
free without any Tabtivity code (a user can `git clone`/drag a folder in via the
existing file browser), so this MVP only builds the part that's genuinely
missing: **a good place to browse, preview, and one-click-copy skills into a
project.** Everything speculative or Claude-only-adjacent is deferred (see
bottom).

## Reality check — what "skills" actually are

No hosted skills registry exists anywhere. Every real source is a git repo:
Anthropic's own [anthropics/skills](https://github.com/anthropics/skills)
(itself structured as a Claude Code plugin marketplace, but its skill
folders are plain `<name>/SKILL.md` + optional reference files/`scripts/` on
disk either way), plus a handful of community collections. "Download" means
clone/pull a repo the user points at and copy a skill folder out of it —
never a package-manager API.

Only Claude Code has a native skill-discovery convention (walk
`.claude/skills/`, lazy-load by relevance). **MVP is Claude-only** — no
attempt to generalize to Codex/Gemini/other hosted agents (see deferred
section).

## MVP scope

### 1. Backend: fetch + catalog (no manifest, no versioning)

New `services/skills.rs`:

- `add_source(url)` / `list_sources()` — a small flat JSON list under
  `~/.local/share/tabtivity/skills_sources.json` (just `{id, label, url}[]`,
  seeded by default with `anthropics/skills`). No per-skill version/commit
  tracking, no install-state manifest — see below for why.
- `refresh_source(id)` — shallow `git clone --depth 1` (first time) /
  `git pull` (subsequent) into `~/.local/share/tabtivity/skills_cache/<id>/`,
  reusing the existing hardened clone plumbing
  (`commands/git.rs`'s `validate_clone_url` + `git_clone_blocking`) rather
  than adding an HTTP client.
- `list_catalog(source_id)` — recursively walk the cached clone for
  `**/SKILL.md` (works unchanged whether the repo is a "marketplace" or a
  flat collection — the marketplace manifest doesn't need parsing, since
  the skill folders exist as plain files on disk either way), parse the YAML
  frontmatter (`name` + `description` only), return the list. Nothing
  persisted — re-derived from disk on each open/refresh.

### 2. Frontend: Skills Library tab (browse → preview → install)

New `SkillsLibraryTab.tsx` / `SkillsLibraryView.tsx`, following
`ProjectFilesTab.tsx`'s thin-host pattern, added to `newTabItems.ts`'s
`SHELL_ITEMS`, scoped to a project:

- **Sources bar** — add a git URL, refresh (pull) a source. No search API,
  just a client-side filter over the parsed catalog.
- **Catalog list** — name + description + source, install-status badge
  (installed for this project / not) computed by checking whether
  `<project>/.claude/skills/<name>/` already exists — no separate tracked
  state.
- **Preview panel** — opens on click, renders `SKILL.md`'s body through the
  existing sanitized markdown viewer, lists bundled files, flags bundled
  scripts explicitly. **The only place the install action lives** — never a
  one-click action off the list row. This is the one piece of the original
  security posture worth keeping even at MVP size: showing the content
  before copying it into agent-trusted territory costs nothing extra to
  build (it's just where the button lives).

### 2b. Two install scopes (added 2026-07-30)

The catalog was machine state from the first commit — one `skills_sources.json`,
one clone cache, shared by every project — and only the *install* was ever
scoped. Two things followed from having built only the scoped half:

- **The library was unreachable without a project.** Adding a source is a
  machine-wide act, and the only surface that could do it was a project tab
  (hidden at the root scope, since there was nowhere to install).
- **A skill wanted everywhere meant N verbatim copies**, with no versioning to
  reconcile them afterwards — deliberately, see the deferred list, which makes
  the copies worse rather than better.

So the install target is now the choice Claude Code itself makes: a project's
`.claude/skills/`, or the machine's personal `~/.claude/skills/`.
`schema::skills::SkillTarget` is that choice and the **only** thing scoped about
the feature. Its two variants are asymmetric on purpose — `Project` names a
directory because only the caller knows which project is meant, `Personal`
carries nothing and is resolved against `paths::home_dir_string()` inside
`services::skills`. The widest-reaching destination in the feature is therefore
the one no caller can aim, which is what keeps this a scope choice rather than an
install-anywhere primitive.

Neither scope replaces the other, and the note beside the selector says which is
which: a project install travels with the repo (into a container through the
identical-path mount, onto a remote host through lockstep), a personal one
reaches every project on **this machine** and no other — a remote project's
agents run on the host, where that folder does not exist.

The two hosts follow from the split. The project **tab** offers both scopes and
is the one surface that knows which project is meant; the 🧠 menu's **overlay**
renders the same `SkillsLibraryView` with no project, beside "Manage agents…",
because a skill is installed per machine exactly like an agent CLI. Unlike
mail's, the tab is *not* retired by the overlay — the scope here is real.

One security consequence had to be paid before this shipped, and it was latent
already: `~/.claude/skills` was not in `services::sandbox`'s `CLAUDE_UNMOUNTED`,
whose unlisted entries are bind-mounted **rw** into every project container. A
`SKILL.md` is standing instructions and a skill may bundle `scripts/`, so a
contained agent could have written both for every *uncontained* session of every
other project — the `plugins/`/`agents/` hole one directory over. It is excluded
now, which is correct independently of this feature.

### 3. Install / uninstall (copy, not tracked)

- `install_skill(target, source_id, skill_path)` — copies the skill
  folder verbatim into the target's `.claude/skills/<name>/`. Re-installing
  (e.g. after a source refresh) just overwrites — no commit-pin, no
  drift/update detection. A user who hand-edits an installed skill and then
  re-installs loses their edits; acceptable at this scope, worth a plain
  confirm-overwrite dialog rather than silent overwrite.
- `uninstall_skill(target, name)` — deletes the folder.
- `list_installed(target)` — reads that target's `.claude/skills/*` directly
  off disk, so a hand-authored or agent-authored skill shows up too. The view
  reads the **personal** list as well while a project is the target: a
  personally-installed skill is already available in the project, and a badge
  computed from the project's folder alone would report it as absent.
- **No manifest, no `Project.enabled_skills` field, no `enabled_in` map.**
  The tree itself is the only source of truth for "is this skill here" —
  matches how the rest of `.claude/` scaffolding already works (`CLAUDE.md`,
  `AGENTS.md` etc. have no separate Tabtivity-tracked "is this present" flag
  either).

### 4. Propagation — free, no extra code

Because install only writes an ordinary file into the project tree, a
containerized project sees it immediately (identical-path bind mount, no
new mount rule) and a git-tracked `.claude/skills/` syncs to a remote/
multi-host project through the existing transports with zero skills-specific
code. A personal install propagates to every project on the machine for free
and to no other machine at all — the same sentence read from the other side.

**Explicitly out of scope, and now wider than it was**: a project whose files
live *only* remotely (no local mirror). The plan's answer was to hide the Skills
tab for such a project; the tab is no longer hidden anywhere, because the
personal scope gave it something to do without a project. So today the scope
note *states* the limit (a personal install is this machine's, and a remote
project's agents run on the host) where it should eventually refuse. Still a
small, well-understood gap — but it is open, not closed.

## Deferred (explored, intentionally not built now)

The following were designed in the earlier, broader investigation and are
worth revisiting only if the MVP proves people actually use it:

- **Manifest/versioning** — per-skill commit pinning, content-hash-gated
  review timestamps, update-available detection.
- **Cross-agent delivery** — injecting skill content into `AGENTS.md`/
  `GEMINI.md` for Codex/Gemini/other hosted agents that have no native
  skill convention. Speculative value (untested whether those CLIs benefit
  from always-in-context injected instructions the way Claude benefits from
  lazy-loaded real skills) and real cost (token budget, no bundled-script
  execution) — don't build until there's a concrete ask.
- **Drag-and-drop** onto a tab/project pill as an install accelerator.
- **Project-pill checklist** for toggling multiple skills at once — at MVP
  size, the Skills tab's own install/uninstall buttons are the whole UI.
- **Advisory auto-suggest** based on project file types.
- **Remote-project install** (writing to a project with no local mirror).

If any of these get picked back up, the fuller reasoning (including the
copy-vs-symlink security argument, the per-agent delivery-mode split, and
the multi-host fan-out analysis) is preserved in this file's git history.
