## Group W — Agent Skills (MVP)
*New feature, scaled to MVP size. Browse/preview/one-click-install `SKILL.md`
bundles from a git source into a project's `.claude/skills/` **or** into the
machine's personal `~/.claude/skills/` (#156). Claude-only; no
manifest/versioning, no drag-and-drop, no cross-agent generalization —
those were explored and intentionally deferred. Full reasoning + deferred
scope: [`docs/done/skills_plan.md`](../docs/done/skills_plan.md).*

*Files: new `src/components/skills/SkillsLibraryTab.tsx` +
`SkillsLibraryView.tsx` + `SkillsOverlay.tsx`, new `src/stores/skills.ts`,
`src/components/layout/{AppShell,LocalModelMenu}.tsx`,
`src/components/tabs/{NewTabMenu,TabBar}.tsx`, new `src/lib/agents/skills.ts`;
backend new `src-tauri/src/services/skills.rs` +
`src-tauri/src/commands/skills.rs` + `src-tauri/src/schema/skills.rs`,
`src-tauri/src/services/sandbox.rs` (`CLAUDE_UNMOUNTED`),
`src-tauri/src/lib.rs` (`generate_handler!`).*

153. **Backend: skill source fetch + catalog.** New `services/skills.rs`:
    a small flat `skills_sources.json` (`{id, label, url}[]`, seeded with
    `anthropics/skills`) under the existing `state_dir()`; `refresh_source`
    shallow-clones/pulls into `skills_cache/<id>/` reusing
    `commands/git.rs`'s `validate_clone_url` + `git_clone_blocking`;
    `list_catalog` recursively walks the clone for `**/SKILL.md` and parses
    the YAML frontmatter (`name` + `description`). No manifest of installed
    skills, no per-skill version/commit tracking.
    - **Shipped** (`src-tauri/src/services/skills.rs:113,216`, registered
      `lib.rs:1079-1087`).
    - [x] 🤖 Automated test — `services/skills.rs:359,368,377,419`
      (`parse_skill_md_*`, `list_catalog_walks_nested_skill_folders`).
    - [ ] 🖐️ Manual test
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

154. **Skills Library tab.** ✅ Implemented · 🧪 Awaiting live QA.
    New `SkillsLibraryTab.tsx` / `SkillsLibraryView.tsx`
    following `ProjectFilesTab.tsx`'s thin-host pattern, registered in
    `TabPane.tsx:127` / `NewTabMenu.tsx:351-369` / `stores/tabs.ts:269,3975`
    (**not** in `newTabItems.ts`'s `SHELL_ITEMS` — it got its own menu group),
    scoped to a project. Sources bar
    (add URL / refresh), catalog list with client-side name/description
    filter and an installed-status badge (computed by checking whether
    `<project>/.claude/skills/<name>/` exists — no tracked state), preview
    panel rendering `SKILL.md` through the existing sanitized markdown
    viewer with bundled-file/script listing. Install is reachable **only**
    from the preview panel.
    - [ ] 🤖 Automated test — installed-status badge reflects disk state,
      not a cached flag. **Genuinely absent**: there is no skills test file
      under `src/__tests__/`, unlike #153/#155 which do have Rust coverage.
    - [ ] 🖐️ Manual test
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

155. **Install / uninstall commands.** `install_skill(project_id, source_id,
    skill_path)` copies the folder verbatim into
    `<project>/.claude/skills/<name>/` (confirm-overwrite dialog if already
    present — no drift detection, plain overwrite); `uninstall_skill`
    deletes it; `list_installed` reads `.claude/skills/*` directly off disk.
    No `Project.enabled_skills` field, no manifest — the project tree is the
    only source of truth. Containerized projects need no extra code
    (identical-path mount already carries it); a project with no local
    mirror (pure-remote) gets the tab hidden/disabled rather than a silent
    wrong-filesystem write.
    - **Shipped** — the trio now takes a `SkillTarget` rather than a bare
      `project_dir` (#156), so "which `.claude/skills/`" is one resolved
      decision (`services/skills.rs`'s `target_skills_dir`) instead of a path
      each caller supplies.
    - **Still open — the pure-remote case.** A remote project with no local
      mirror is not reported as unsupported; the tab is no longer hidden
      anywhere at all (#156 gave the root scope something to do), so this gap
      widened rather than closed. What the project scope writes for such a
      project is still the mirror path, and the personal scope writes to *this*
      machine while its agents run on the host — stated in the scope note, not
      yet refused.
    - [x] 🤖 Automated test — `services/skills.rs`
      (`install_then_list_then_uninstall_roundtrip`,
      `target_skills_dir_resolves_both_scopes`,
      `target_skills_dir_refuses_an_empty_project_dir`). The unsupported-remote
      assertion is not covered, matching the gap above.
    - [ ] 🖐️ Manual test
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

156. **Personal install scope + the 🧠 menu's door.** ✅ Implemented ·
    🧪 Awaiting live QA. Two thirds of this feature were never project-scoped —
    the source list and every cached clone live in `state_dir()` — but the only
    way to reach any of it was a project tab, and the only place a skill could
    land was one project, N verbatim copies for a skill wanted everywhere (with
    no versioning to reconcile them, by design). So the install target became a
    choice of the two scopes Claude Code actually reads: `SkillTarget::Project
    { dir }` or `SkillTarget::Personal` → `~/.claude/skills/`.
    - **Backend.** `schema/skills.rs`'s `SkillTarget` (internally tagged), the
      install/uninstall/list trio addressed by it, `services/skills.rs`'s
      `target_skills_dir` resolving `Personal` against `paths::home_dir_string()`
      — the variant carries **no path**, so the widest-reaching destination in
      the feature is the one no caller can aim — and refusing an empty project
      dir rather than resolving it relative to the working directory.
    - **Security, and the half that was latent already.** `~/.claude/skills`
      was **not** in `sandbox.rs`'s `CLAUDE_UNMOUNTED`, whose unlisted entries
      are bind-mounted **rw** into every project container: a contained agent
      could have written instructions and a `scripts/` folder that every
      *uncontained* session of every other project then loads — the `agents/`
      hole one directory over. Now excluded, which is right whether or not the
      personal scope exists.
    - **Frontend.** `SkillsLibraryView` takes `projectDir: string | null` and
      owns the scope itself (a selector beside the install button, defaulting to
      the narrower scope available); it reads the personal list **as well** while
      a project is the target, or the catalog's "Installed" badge would report a
      skill the project can already use as absent. New `SkillsOverlay` +
      `stores/skills`, opened from `LocalModelMenu`'s new row beside "Manage
      agents…" — a skill is installed per machine exactly like an agent CLI. The
      tab stays: it is the one surface that knows which project is meant, unlike
      mail's retired one.
    - [x] 🤖 Automated test — `src/__tests__/agents/SkillsTarget.test.ts` (the personal
      target names no path and is frozen; every call passes the target verbatim
      with no leftover `projectDir`), plus the two Rust resolver tests above and
      `sandbox.rs`'s `unmounted_entry_matching_is_exact_with_a_star_prefix`.
    - [ ] 🖐️ Manual test — install personally from the 🧠 menu, confirm it shows
      as inherited in a project tab, and confirm a container no longer sees
      `~/.claude/skills`.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS
