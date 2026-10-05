## Group U — Interface Cost & Responsiveness

*Created 2026-08-26. Files: `src/lib/agents/fastMode.ts`, `src/stores/power.ts`,
`src/styles/themes.css`, plus the surfaces each item names.*

*The group exists because none of the others fit and the subject is real: what
Tabtivity **spends** to show what it shows. Every feature here is somebody else's
feature seen from the other side — a folder size is a recursive walk, a git dot
is a `git status`, a hover card is a poll — and the question "is this worth its
cost, on this machine, right now?" belongs to the user rather than to whichever
group shipped the aid. Energy Saver (`stores/power`) was the first answer and
is a different one: it widens timers off a live **battery** reading, this group
is about a standing **preference**.*

*The rule for anything added here: nothing may make Tabtivity say something
untrue. Withdrawing a figure is fair; leaving a stale or unresolvable one on
screen is not.*

---

210. **Fast mode.** ✅ Done 2026-08-26, code-complete and **live-unverified**.
    One global toggle (Settings → Fast mode, default off) that withdraws the
    display aids whose cost is a directory walk, a standing poll, or a read of
    every file in view. The list lives in `src/lib/agents/fastMode.ts` — one home, so
    the help text and the code cannot drift — and everything on it has to share
    three properties: it costs work nobody asked for, its absence is *legible*
    (no spinner, no "…" that never resolves), and nothing is lost but the aid.

    What it turns off:
    - **Folder sizes in the file tree** — one `dir_size_breakdown` per visible
      folder, and on a remote project each is a `du` over SSH. The group totals
      go with them: with no walk, every sum is a permanent lower bound, so the
      header would read `≥ 1.2 MB` for the rest of the session.
    - **The git-dirty dots on the project pills** — a `git status` per local
      project every 12 s, forever, for projects the user is not in.
    - **The project hover card** — `project_cpu_percent` every 1.5 s for as long
      as the pointer rests, plus a scaffold probe per open. Falls back to the
      plain tooltip the Trash pill already uses.
    - **The tab hover card** — its own ticking clock and store subscriptions per
      hover; the tab keeps its label as a `title`.
    - **The header CPU/RAM/GPU readout** — a poll every 2.5 s for a figure that
      is, by construction, a readout of Tabtivity's own overhead.
    - **The Python ▶ gate** — deciding whether a `.py` has a `__main__` guard
      means reading it, an SFTP round trip per file on a remote listing. Files
      already in the persisted cache keep their ▶: it stops the *scanning*, not
      the answers already paid for.
    - **The tree's 15 s remote re-stat** — the focus listener and every explicit
      re-list survive, so the sync markers still catch up on a gesture.
    - **UI animations and transitions** — `data-fast-mode` on the document root.
      Deliberately stronger than the blur rule beside it: that one *pauses* what
      is running (right for a window nobody is looking at), this cancels it and
      collapses transitions, because the user is looking and has asked for the
      frames back.

    It composes with Energy Saver rather than replacing it, and it is reactive
    throughout — turning it off restores every surface in place, with no
    relaunch and no remount, which is what makes it safe to try.
    - [x] 🤖 Automated test — `src/__tests__/agents/FastMode.test.tsx` (8: the gate is
      never inferred — unset, `false` and an unloaded store all read off; the
      root attribute; and a withdrawn surface renders nothing **and** asks the
      backend nothing, then comes back when the toggle flips) plus the schema
      round trip in `schema::settings`.
    - [ ] 🖐️ Manual test — turn it on with a project open: folder sizes and the
      group totals go, the pills lose their git dots, hovering a pill or a tab
      shows a plain tooltip instead of a card, the header loses its CPU/RAM row,
      and nothing animates. Turn it off: all of it comes back without a restart.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS
    - [ ] **Open:** the withdrawals are all frontend. The costs a *backend*
      loop pays regardless — the byte-sync pass, the lockstep poll, the usage
      watcher — are untouched, and are gated today only by the HPC tag. Whether
      fast mode should reach them is a real question and deliberately not
      answered here: those loops keep two trees in step, so skipping one is not
      withdrawing an aid but declining to do the work, which is the line this
      group's rule draws.
    - [ ] **Open:** no measurement. "Faster" is asserted from what each item
      costs rather than from a before/after reading, and the dev-only perf
      monitor (`src/dev/`, Ctrl+Alt+P) is the obvious instrument for turning
      that into a number.

---

214. **The side panel repopulates from a snapshot.** ✅ Done 2026-08-30,
    code-complete and **live-unverified**. A closed panel does not hide its
    tree, it unmounts it (`SidePanel` passes `mountTree={open}`, so a closed
    panel holds no fs-watch and runs no probes; the `panelsHidden` toggle
    unmounts the whole panel). Everything the view had paid for died with it,
    so every reveal rebuilt from nothing — a `list_dir`, then a
    `git_file_statuses` behind it, then one recursive walk per visible folder,
    then the repo's own `git status` — and the panel visibly filled itself in
    for as long as that took. On a remote project each of those is an SFTP or
    SSH round trip, so the wait was the *point* at which the panel was least
    usable.

    `src/lib/projects/fileViewSnapshots.ts` keeps the last state of each (project, root
    dir, folder) — entries, per-file git statuses, folder sizes and their
    ignored split — plus the git bar's counts per repo, in module scope, where
    they outlive the components. A reveal seeds every one of those from the
    snapshot in its `useState` initializers, so the **first committed frame is
    already populated**, and the upgrade goes out one frame later (the listing
    commands are synchronous main-thread calls; issuing one inside that commit
    would stall exactly the frame the seed exists to make instant). The upgrade
    is the same quiet, diffing refresh the fs-watcher uses, so nothing repaints
    where nothing changed, and the folder sizes are re-walked from scratch —
    the dedupe set is empty on a mount — so no figure on screen stays a stale
    one. Navigating into a previously-visited folder seeds the same way.

    This group's rule holds: nothing on screen is untrue for longer than a
    round trip, and the two states where the answer is genuinely unknown — a
    listing that FAILS (the snapshot is dropped, so the error shows rather than
    resurrected rows) and a remote pool that cannot be asked (the git bar
    clears) — are not seeded at all.
    - [x] 🤖 Automated test — `src/__tests__/shell/SidePanelReveal.test.tsx` (9: a
      cold first frame is empty, a revealed one is not; the stale seed upgrades
      to what the folder now holds; the git counts survive a close; plus the
      LRU bounds and read-as-use on both snapshot maps).
    - [ ] 🖐️ Manual test — open a project with a sizeable tree, close the panel
      and reveal it again: the tree, its git colours and the folder sizes are
      there on the first frame, with no empty-then-fill. Change a file from a
      terminal while the panel is closed and reveal it: the change is on screen
      a moment later. Worth repeating on a remote project, where the round
      trips this skips are the expensive ones.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS
    - [ ] **Open:** in memory only, deliberately — a listing must not survive a
      relaunch, after which the filesystem has had unbounded time to move on.
      Whether the *folder sizes* are worth persisting (they are the expensive
      half, and a walk's answer ages more slowly than a listing's) is a
      separate question and not answered here.

---

217. **Theme modernization pass.** ✅ Done 2026-08-30, code-complete and
    **live-unverified**. Five changes to `src/styles/themes.css` and its
    consumers, from a comparison against current desktop-app design practice:
    - **Derived accent/pill tokens** — `--accent-hover`/`--accent-active` and
      the pill washes now derive from each theme's own `--accent` via
      `color-mix` toward `--text-primary` (right direction in dark *and* light
      themes); the achromatic pair keeps its explicit overrides. A minimal
      theme is now surfaces + borders + text tiers + one accent.
    - **`soft_dark` theme** — the neutral dark-gray theme (no navy tint, no
      colored borders, restrained blue accent), the one theme that opts back
      into rounded corners via its own radius tokens. Its own xterm palette in
      `TerminalView.terminalTheme`.
    - **`system` pseudo-theme** — follows the OS light/dark preference
      (`fancy_light`/`fancy_dark`), resolved in `stores/settings.resolveTheme`
      with a `matchMedia` listener for live OS flips; never reaches
      `data-theme` or the terminal palette unresolved. The pre-paint
      localStorage cache stores the *resolved* theme.
    - **Contrast fixes** — `--text-muted` lifted to ≥4.5:1 on resting surfaces
      in `fancy_dark` (#8091a9), `fancy_light` (#5f6e84) and `light_lavender`
      (#746d8f).
    - **Token hygiene** — type-scale tokens (`--text-xs`…`--text-lg`, 10px
      floor; every ≤9px and half-pixel font-size migrated), spacing tokens
      (`--space-1..4`), `--ease-out`, status washes (`--success/warning/
      danger-soft`); ~140 dead `var(--x, #hex)` fallbacks stripped (one live
      phantom found: `var(--border, …)` — no such token); git/status chrome in
      `viewers.css`/`file-tree.css` moved onto `--success/--warning/--danger`,
      with filled status chips taking `--bg-main` text (the `.btn-primary`
      rule) instead of fixed white.
    - [x] 🤖 Automated test — the existing corpus: `TerminalThemeRenderer`,
      `TerminalAttachOnly` (mocks extended with `resolveTheme`),
      `GitStatusColors`; `npm run build` + full vitest green.
    - [ ] 🖐️ Manual test — walk all seven themes in Settings → Theme: chrome,
      pills, menus, dialogs, terminal palette each time. Check `soft_dark`'s
      rounded corners and neutral header, `system` following an OS light/dark
      flip live, muted text legibility in the three tinted themes, and the
      compare-view take/chip colors in a diff on a light theme.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

218. **Accent color + corner style overrides.** ✅ Done 2026-08-30,
    code-complete and **live-unverified**. The payoff of #217's derived
    tokens: two appearance overrides in Settings, above the theme row.
    - **Accent color** — preset swatches + a native color input + "Theme
      default". Applied as inline root CSS vars
      (`stores/settings.applyAccent`): `--accent` plus the five derived
      hover/active/pill formulas restated inline, so the override outranks the
      achromatic pair's explicit literals and behaves exactly like a theme's
      own accent everywhere (focus rings, scrollbar thumb, pills, buttons).
      The color input live-previews and persists debounced (400 ms) — a GTK
      color chooser fires input events per drag tick, and each commit is a
      settings.json write plus a broadcast.
    - **Corners** — Theme default / Square / Rounded (`applyCorners`, the
      three radius tokens; "rounded" = soft_dark's 4/8/12 ladder).
    - Persistence: `Settings.ui_accent` / `ui_corners`
      (`schema/settings.rs` round-trips them — **backend restart needed** for
      persistence; the frontend applies live regardless). Cross-window:
      `APPEARANCE_CHANGED_EVENT` (DetachedApp listener) + the popout's own
      settings load. Pre-paint: `index.html` re-applies validated
      `tabtivity-accent`/`tabtivity-corners` localStorage caches before first paint.
    - [x] 🤖 Automated test — `src/__tests__/theme/Appearance.test.ts` (normalize/
      apply/clear/invalid-input for both overrides; "system" resolution).
    - [ ] 🖐️ Manual test — pick a swatch: pills, focus rings, scrollbar and
      buttons recolor at once, in every theme including Plain Dark/Light;
      drag the custom color wheel (no save-storm jank); "Theme default"
      restores each theme's own accent. Flip Corners to Rounded on fancy_dark
      and Square on Soft Dark; check a popout follows live and a relaunch
      paints the override before first frame (after a backend restart).
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

219. **Accent-colored chrome seam + a third chrome surface.** ✅ Done
    2026-08-31, code-complete and **live-unverified**. Two changes to how the
    window's chrome layers read apart, on the same idea: the boundaries between
    them should be a decision, not a leftover.
    - **The top bar's bottom edge is the accent** (`shell.css`'s `.app-header`
      box-shadow, was `--border-color`). The two theme overrides that replace
      that shadow had to follow: the achromatic pair's explicit
      `--text-primary` line is now redundant (their accent *is* the ink) and
      was dropped, and the glass pair (`fancy_dark`/`light_lavender`), which
      replaces the box-shadow wholesale with a drop shadow, restates the seam
      beside it — otherwise those two silently lose it.
    - **`--bg-subheader`** — one shared secondary-chrome surface for the
      subwindow tab bars (`.tab-bar`) and the file panel's own two header rows
      (`.side-panel-header` + `.side-panel-toolbar`), so they read apart from
      both the app header above and the content below. Derived per theme
      (`accent 14% over --bg-elevated`), with `--glass-subheader` for the glass
      pair and a near-neutral literal for `dark`/`light`, whose accent is the
      ink and for which the shared derivation would be the mid-grey band their
      "resting surfaces are pure" rule exists to forbid. The tab bar's old
      inline `::before` accent wash (0.12) folded into the token.
    - **Correction 2026-08-31**: the achromatic pair's step was #101010/#f0f0f0
      — technically off the pure tone, invisible in practice, which is the same
      as not doing it (reported on Plain Dark). Raised to #1e1e1e / #ebebeb:
      still neutral, so nothing there acquires a hue, but the header actually
      reads apart from the pane. A distinction nobody can see is not one.
    - [ ] 🖐️ Manual test — in every theme: the header's bottom edge is the
      accent (and still visible on fancy_dark/light_lavender, which draw a
      drop shadow there); a subwindow's tab bar and the file panel's header
      block are each distinguishable from the top bar AND from the pane/panel
      under them — **Plain Dark and Plain Light included**.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

220. **Theme Customizer — every color variable, in its own window.** ✅ Done
    2026-08-31, code-complete and **live-unverified**. Settings → *Theme
    colors* → "Customize…" opens a window of its own (opened instead of the
    Settings dialog, ‹ Back returns) listing the whole palette grouped by what
    it paints — surfaces, text, borders, accent, controls, status, pills,
    window buttons, the activity ramp, everything else — one row per CSS
    variable: swatch, the token name, an editable hex, and a per-token reset.
    **The corner style and the accent picker both moved in here** from the main
    Settings panel — #218's two knobs shape and color the same chrome, and the
    accent is a theme color like the rest — beside a "Reset all". Settings keeps
    one row: *Theme colors* → "Customize…". The accent's row keeps its swatch
    strip rather than becoming a plain hex field (the presets are the control
    most of the time) and its "Theme default" doubles as that row's reset.
    - Persistence: `Settings.ui_theme_vars` (a `{token: "#rrggbb"}` map),
      riding the backend's `extra` catch-all — **no Rust field, so no backend
      restart**. Cross-theme like the accent and applied *after* it, so a
      hand-picked `--accent-hover` beats the one derived from the accent.
    - Safety: `lib/theme/themeTokens` is an allow-list and
      `stores/settings.normalizeThemeVars` the gate — these values are written
      as inline custom properties, so an unvalidated pair from a hand-edited
      settings.json would be an arbitrary-CSS write. `--accent` is rejected
      from the map on purpose: it keeps its own setting (`ui_accent`), which
      the accent row here writes, so one color never has two writers.
    - The "current value" of a token cannot be read (`getComputedStyle` hands
      back the token stream — a `color-mix`, a `var()` chain, a gradient), so
      each swatch is resolved by *painting* it on a hidden probe and reading
      the computed `color` back; a sentinel catches the values that are not
      colors at all (the fancy themes' gradient `--bg-header`), which fall back
      to a twin token.
    - Cross-window via `APPEARANCE_CHANGED_EVENT` (payload grew `themeVars`);
      pre-paint via a validated `tabtivity-theme-vars` localStorage cache in
      `index.html`.
    - **Per-token examples** (2026-08-31): every row carries a line under the
      variable name saying what *visibly* changes when it does ("Menus,
      dropdowns and dialog surfaces"), keyed off the name via
      `themeTokenExampleKey` so a catalog entry cannot arrive without one — the
      name says where a value sits in the design system, which is not the
      question anyone at this panel is asking. 50 strings × 5 languages.
    - **`--bg-side-panel`** (2026-08-31): recoloring the side panel through
      `--bg-panel` repainted every other panel-toned surface with it (settings
      sections, the file browser, popovers — ~100 rules). The panel now reads
      its own token, which follows `--bg-panel` until something sets it, so the
      customizer can give the panel a tone of its own. Not a rename: the
      general token still means what it meant, and its example line says so.
    - **Group order** (2026-08-31): Accent leads, above Surfaces — the color
      most people open this window for, and the fastest thing in it to try.
    - **Two derived surfaces got sections of their own** (2026-08-31), on one
      idea: a surface whose look is *derived* cannot be recolored without
      moving everything it derives from, so each gets tokens that follow the
      shared ones until set.
      - **Side panel** — `--bg-side-panel` (follows `--bg-panel`),
        `--bg-side-panel-header` (follows `--bg-subheader`) and
        `--side-panel-border` (follows `--border-color`). The header pair
        applies only *inside* `.side-panel`: the same header markup renders in
        the Files (Project) tab and the docked file column, which stay on the
        shared token, so retoning the panel's header leaves the subwindow tab
        bars alone.
      - **Alerts strip** — `--alerts-bg`, `--alerts-header-bg`,
        `--alerts-border` (the three accent-over-ground mixes, moved out of
        `file-tree.css` into `themes.css`) plus the urgency ramp
        `--alerts-overdue`/`--alerts-now`/`--alerts-soon`, which followed
        `--danger`/`--warning`/`--accent` inline and now follow them as
        tokens.
    - **Saved themes + "Colors in this theme"** (2026-08-31): the customizer
      can now *store and load* a look. A save line at the top of the window
      takes a name and puts the whole appearance away —
      `Settings.ui_theme_presets`, an array of `{id, name, theme, accent,
      corners, vars}` riding the same `extra` catch-all, **no Rust field and no
      backend restart**. The base theme travels with the palette because a set
      of overrides built on Fancy Dark reads as somebody else's look on Plain
      Light; Load writes theme + accent + vars + corners in **one**
      `updateSettings` patch (so the accent's derived family and the
      hand-picked tokens land in the order they expect, and the popouts get one
      broadcast) and drops any color edit still sitting on the 400 ms debounce,
      since that edit belongs to the look being replaced. Saving under an
      existing name replaces that entry rather than growing a second one
      claiming to be it; ⭮ overwrites a row with the current look; × asks once
      before deleting, because a hand-built palette has no undo. Presets are
      validated on **read** (`stores/settings.normalizeThemePresets`, capped at
      40 × 60 chars) for `normalizeThemeVars`' reason turned up one notch: a
      preset sits inert in a hand-editable settings.json until somebody presses
      Load, which would otherwise be an arbitrary-CSS-variable write with a
      friendly button in front of it.
      Beside it, every color row (and the accent's) grew a ▤ button opening
      **"Colors in this theme"**: the painted palette deduplicated
      (`paletteFromColors`) — every distinct color the document shows right
      now, your own overrides included — so a new value can be matched to one
      already on screen instead of guessed next to it. It expands the row
      rather than floating over it: the card scrolls, and a popover would be
      one scroll from being clipped. A palette pick reaches the accent
      6-digit — `ui_accent` has no alpha channel and a translucent accent would
      fade every control derived from it.
    - [x] 🤖 Automated test — `src/__tests__/theme/ThemeVars.test.ts` (the allow-list
      gate, hex validation incl. the 8-digit alpha form, clearing an override
      really clears it, the pre-paint cache holds only validated values, every
      catalog token exists in the stylesheet **and has an example string**, the
      computed-color → hex reader, **preset normalization** — vars gate, known
      theme/accent/corner values only, id/name/duplicate drops, the caps — and
      **`paletteFromColors`** deduplicating in catalog order).
    - [ ] 🖐️ Manual test — change `--bg-panel` and `--text-secondary`: the app
      repaints live while dragging, a popout follows, and the values survive a
      relaunch (painted before the first frame). Reset one token and then all.
      Set `--accent-hover` by hand, then change the accent — the hand-picked
      value must win. Switch themes: the overrides ride along. Check the
      corner control and the accent swatches still work from their new home,
      and that Settings itself no longer carries either. Check `--bg-side-panel`
      moves the side panel and nothing else, and that `--bg-panel` still moves
      the rest.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS
    - [ ] 🖐️ Manual test (saved themes) — build a look (theme + accent + a
      couple of tokens + corners), name it, Save. Change everything, then Load
      it back: theme, accent, colors and corners all return, in the popouts
      too, and survive a relaunch. Save under the same name again — one row,
      not two. ⭮ on a row picks up the current look; × asks before deleting.
      Open ▤ on a row: the strip shows the colors currently on screen (an
      override you just made included) and picking one sets that token; on the
      accent row it sets the accent.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS
    - **Top frame** (2026-08-31): a section of its own for Tabtivity's title bar,
      the group the customizer was missing most. The bar is a composite — a
      fill (`--bg-header`, a gradient in the fancy themes, `--glass-header` in
      the glass pair), a 32%-accent wash laid over it, and the 1px seam under
      it — assembled from tokens that paint half the window besides, so before
      this the only way to retone the top bar was to move the accent
      everywhere. `--top-frame-bg` / `--top-frame-wash` / `--top-frame-seam`
      each follow what they used to read, exactly as `--bg-side-panel` and the
      `--alerts-*` family do. Two consequences worth naming: the wash's
      translucency moved out of `opacity` and **into the token**, so one
      8-digit hex sets hue and strength together and the three themes that want
      no wash (Plain Dark, Plain Light, soft_dark) now set it to `transparent`
      instead of `content: none` — which means a wash can be given *back* to
      them from this window. And the glass pair's fill moved from
      `.app-header`'s own `background` to the theme's `--top-frame-bg`: a value
      declared on the element sits *below* the root inline style where an
      override lands, so on the default theme the knob would have done nothing.
      The dialog title band and the popover menus keep reproducing the default
      wash from the accent and deliberately do not follow this group.
    - [ ] 🖐️ Manual test (top frame) — on Fancy Dark (the default), set
      `--top-frame-bg`: the top bar's fill changes and no other surface moves.
      Set `--top-frame-wash` to an 8-digit hex (e.g. `#ff008040`): the bar takes
      that tint at that strength; `#00000000` clears it. Set
      `--top-frame-seam`: only the line under the bar moves — buttons, links
      and the scrollbar keep the accent. Switch to Plain Dark: the bar is
      unwashed until you set a wash, and then it takes one. Switch to
      Light Lavender: the fill knob still works over the frosted glass and the
      drop shadow under the seam survives. Reset each, and the bar returns to
      its theme's own look.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS
    - **Subwindows, and the ink on both headers** (2026-08-31): the same
      treatment for a subwindow's own header. `--subwindow-header-bg` /
      `--subwindow-header-border` (the tab bar and the line under it; the bar
      shared `--bg-subheader` with every file-panel header row in the app, so
      moving it moved those too), `--subwindow-tab-active` (the current tab's
      underline — a tab *kind*'s own `--tab-accent` still wins over it) and
      `--subwindow-focus-frame` (the focused subwindow's outline, its Shift-nav
      number badge, and the split preview a drag paints, which is the same
      outline one moment later). The glass pair's `--glass-subheader` fill moved
      off `.tab-bar` onto the theme, for the cascade reason the top frame's did.
    - **Header text is a subtree remap, not a token rules opt into.** The clock,
      the project pills, the box chip, the right-hand cluster, the tab labels,
      the grips, the chevrons and the locality/mode chips are painted by ~40
      rules across four stylesheets, each reading a shared text tier — so
      "the text on the top bar" cannot be a token each of them is rewritten to
      read. `.app-header` and `.tab-bar` instead **redeclare `--text-primary`,
      `--text-secondary` and `--text-muted` for their own subtree**, pointing
      at `--top-frame-text*` / `--subwindow-header-text*`; every rule inside
      picks the frame's value up without knowing the token exists. Not a cycle:
      the source tokens are substituted at `:root`, so what inherits into the
      scope is a resolved color, never a reference back.
      The cost is that everything nested follows, **including the popovers that
      render inside the header** (the app launcher and the indicator menus are
      not portaled) — they sit on `--bg-elevated` over the app's content and are
      not part of the frame, so they hand the theme's ink back through a
      `--text-{primary,secondary,muted}-base` snapshot taken at `:root`. Every
      header popover is built on `.tab-new-menu`, so one selector pair covers
      the set. Both halves fail silently, so `ThemeVars.test.ts` now pins them:
      the snapshot must exist, each remapping scope must carry its undo, and the
      list of tiers-pointed-at-another-token is asserted whole, so a third scope
      cannot start remapping text without joining the contract.
    - [ ] 🖐️ Manual test (subwindows) — split a project into two
      subwindows. Set `--subwindow-header-bg`: **both** tab bars change and the
      file panel's header rows do not (they keep `--bg-subheader`). Set
      `--subwindow-header-text` and `--subwindow-header-text-muted`: the active
      tab's label and the inactive ones move, and the + menu that drops out of
      the bar keeps the theme's own text color. Set `--subwindow-tab-active`:
      only the underline under the current tab moves — a Claude tab still shows
      its own kind color. Set `--subwindow-focus-frame`: the outline round the
      focused subwindow follows, so does its Shift+↑/↓ number, and so does the
      split preview while dragging a tab across.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS
    - [ ] 🖐️ Manual test (top-bar ink) — set `--top-frame-text` to
      something obvious: the clock, the project pill labels and the box chip all
      take it in one go. Open the app-launcher (▦) and an indicator menu from
      the same bar: **their** text is still the theme's, not the bar's. Set
      `--top-frame-text-muted`: the drag grip and the version dim to it. Reset,
      and every one of them returns to the theme's tiers.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

---

221. **The project root no longer re-lists itself forever.** ✅ Done
    2026-08-31, code-complete and **live-unverified** (the backend half needs a
    restart). Reported as the side panel "flickering between two paths" and
    `.idea` "appearing then disappearing continuously" in a local project. A
    file-backed trace of the live window showed the root folder in a closed
    loop: `refresh()` → `git_file_statuses` → `git status` opportunistically
    rewrote `.git/index` → `.git`'s mtime bumped → the tree's non-recursive
    root watch reported the `.git` entry as changed → 250 ms later `refresh()`
    again, about once a second for as long as the root was on screen. The
    visible part was a piled-up status probe failing now and then: a failure
    was applied as an EMPTY map, which promoted every gitignored folder out of
    the collapsed gitignored section into the regular list for a frame.

    Backend: `hardened_git_command` sets `GIT_OPTIONAL_LOCKS=0`, git's own
    switch for "read-only commands must not write the repo" — output of every
    status/log/rev-list is unchanged, mutating commands keep their mandatory
    locks, and the loop cannot close. Frontend (`FileTree`): a failed status
    probe keeps the last good letters, and a listing/status result for a folder
    the tree has since left is discarded (`loadTargetRef`, seeded from the
    saved folder so the seeded reveal's refresh passes) — with the seeded
    `load` of #214 painting the new folder at once, a slow result for the old
    one used to flash in over it. Tests: `FileTreeRefreshRaces.test.tsx` (all
    three fail against the previous `FileTree`).

    - [ ] 🖐️ Manual test — after a restart, open a local git project's side
      panel at the project root and leave it for a minute: `.git`'s mtime
      (`stat .git`) must stop advancing every second, no row may appear or
      disappear on its own, and the gitignored section must keep its members.
      Then `touch` a file in the root and commit it from a terminal tab: the
      tree still re-lists on the touch and its git letters still update after
      the commit (mutating git commands still take their locks and still fire
      the watch).
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS
    - [ ] 🖐️ Manual test (stale result) — click ↻ at the root and immediately
      enter a subfolder: the subfolder's rows and crumb stay; the root's rows
      never flash back in.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

222. **The top bar's status readouts collapse into one lamp; every global
    button moved right of the project strip.** ✅ Done 2026-08-31,
    code-complete and **live-unverified** (the settings field is a backend
    change, so the toggle needs a restart; the header itself hot-reloads).
    Reported as the main top frame being too crowded. It was: ~22 slots in a
    40 px row, of which exactly one — the project pill strip — is elastic, so
    every fixed control was taken out of the app's primary navigation all day.
    Six of them (connection, battery, Mobile, OpenVPN, Machines, CPU/RAM/GPU)
    were roughly a third of the bar's width saying "still fine" six times over.

    Frontend: new `stores/headerStatus.ts` (each widget self-reports a tone +
    one tooltip line, so the cluster re-derives nothing) and
    `header/StatusCluster.tsx`, which folds the six behind a summary lamp and a
    `‹`/`›` toggle persisted as `header_status_expanded` (default collapsed).
    Folding is `display: none`, never unmounting — a folded widget keeps
    polling so its tone still colours the summary lamp. Collapsed hides
    **every** member, failing ones too (2026-09-24: escalating members back
    into the bar was dropped at the user's request); the lamp takes the worst
    tone, and the set that tones up is deliberately narrow (offline · battery
    ≤ 15 % on its own power · Mobile error · VPN mid-connect · a machine in the
    error bucket) so the lamp doesn't flicker during ordinary work. The fold is
    skipped entirely when fewer than two members exist. `HeaderBar` now holds the
    project strip alone in the centre; ✉ 🗓 ☑ (kept as their own buttons — each
    carries a live badge a launcher menu would hide), then 🧠 ▦ ⚙, then the
    cluster, sit right of it in three gap-separated groups.
    Backend: `Settings.header_status_expanded`.

    - [ ] 🖐️ Manual test — with Machines/VPN/Mobile enabled, look at the bar:
      the right side is ✉ 🗓 ☑ · 🧠 ▦ ⚙ · one lamp + `‹` · window controls, and
      the project pills have visibly more room. Hovering the lamp lists every
      folded member's state. Click `‹`: all six come back inline and each one's
      own hover menu still opens flush with the bar's bottom edge. Click `›`
      and relaunch — it is still collapsed.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS
    - [ ] 🖐️ Manual test (failing members stay folded) — while collapsed, pull
      the network cable (or disconnect WiFi): NO icon pops into the bar, only
      the summary lamp turns red and its tooltip names the connection.
      Reconnect: the lamp goes green. Same with a VPN connect (lamp amber while
      connecting) and a global machine that fails to connect (lamp red).
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS
    - [ ] 🖐️ Manual test (no pointless fold) — on a desktop with no battery, no
      VPN, no machines and the resource rows switched off, the toggle must not
      render at all rather than hiding a single lamp behind a chevron.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

---

223. **The renderer memory watchdog is per window and cannot loop.** ✅ Done
    2026-09-01, code-complete; the loop guard is **live-verified** (it
    hot-reloaded into the running window and ended the loop at 08:03Z), the
    per-window attribution is **live-unverified** (two new backend commands,
    needs a restart). Reported as "Tabtivity restarts suddenly" every 30–60 s
    while a Codex tab was failing to resume. crash.log showed the restarts
    were the watchdog's own `location.reload()`: it read the **largest**
    renderer under the app but always reloaded the **main** window, and the
    large one was a popout's (`Tabtivity win-1`, 4.7 GB of JS heap against main's
    1.4 GB) — so the reload freed nothing and fired again at every poll. The
    Codex `already has an active writer` error was the restore churn's
    symptom, not the cause.

    Frontend (`lib/window/rendererWatchdog.ts`): mounted in `AppShell` *and*
    `DetachedApp`, each window acts on its own renderer and reloads only
    itself (a popout re-seeds from main, as it does after a crash-reload).
    Which renderer is "ours" is **probed**, since no engine we ship on says
    (WebKitGTK 2.52 no longer exports `webkit_web_view_get_web_process_identifier`
    — the extern compiles and fails to *link*): sample every renderer's RSS,
    allocate + touch 192 MiB, sample again; the pid that grew is ours. Once per
    window, cached across the window's own reloads, claimed with the backend so
    other windows can name it; ambiguous → retried three times, then the old
    largest-renderer fallback. And a **10-min reload cooldown** per window
    (`sessionStorage`): still over the ceiling right after a watchdog reload
    means the memory is not that window's heap, so it holds and logs once. The
    debug footer (DEV only) now shows `RSS main 0.9 GB · win-1 4.6 GB` beside
    the `TTY chars/s` meter.
    Backend: `commands::debug::{webview_renderer_rss, webview_renderer_claim}`;
    `webview_rss_kib` kept as the fallback for a frontend ahead of its backend.

    - [ ] 🖐️ Manual test (attribution) — after a restart, open the side panel
      in the dev build with one popout open: the footer reads `RSS main …` and
      `win-1 …` (not `pid …`) within a few seconds, and the two numbers match
      `ps -o rss -p <WebKitWebProcess pids>` to within a few MB.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS
    - [ ] 🖐️ Manual test (right window reloads) — temporarily set
      `RENDERER_CEILING_MB` to 512 in `rendererWatchdog.ts` (hot-reloads) with a
      popout open: within a minute the **popout** blinks and comes back with its
      tabs, the main window does not; crash.log names the popout's label. Set
      the ceiling back.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS
    - [x] 🔍 What the popout held: **two PDF viewers** — `talk/main.pdf`
      (57 pages, 135 images, 97 of them over a megapixel, recompiled at 09:46
      that morning) and the poster. Measured headlessly with the installed
      pdf.js (`pdfjs-dist` 6.3, `node --expose-gc`): decoding every page of
      that deck once costs **~660 MB** (RSS 239 → 898 MB), and six
      load/decode/destroy cycles plateau rather than climb, so pdf.js itself
      frees on `destroy()`. The holder was the **page rail**: `PdfThumb`
      rendered each page and never called `page.cleanup()`, so every
      thumbnailed page's decoded bitmaps stayed alive for the document's whole
      life — re-paid in full at every recompile, since a reload is a fresh
      document and the rail repaints each page. Fixed: the thumbnail hands
      the page back the moment its pixels are on the canvas (pdf.js closes the
      bitmaps in `PDFObjects.clear()`). The 44 GB main-window leak of
      2026-07-31 is still unattributed.
    - [ ] 🖐️ Manual test (rail no longer holds the deck) — after a restart,
      open `talk/main.pdf` in a popout with the rail open, scroll the rail to
      the end so every thumbnail paints, then watch the footer's `win-1` RSS
      settle: it should stay in the hundreds of MB, not climb past 1.5 GB,
      and recompiling the talk a few times should not ratchet it upwards.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS
    - [x] 🔍 **2026-09-02, the popout again at 4.1–7.2 GB across six ceiling
      reports while the talk was being recompiled — and this time a watchdog
      reload did NOT free it** ("4744 MB still ≥ ceiling 271 s after a reload").
      Reproduced NOTHING headlessly: the real `PdfView` + TeX workspace,
      compiled through the actual `compile` closure in an offscreen WebKitGTK
      2.52 WebView (scratch Vite bundle with Tauri stubbed), stays flat over 20
      recompiles of an 82 MB / 42-page PDF — same file, alternating content,
      StrictMode, rail + contents open, a beamer deck with drawn links, a
      16-page 12-megapixel JPEG deck, and at `GDK_SCALE=2`. pdf.js alone
      (load/render/fingerprint/text/links/destroy, destroy mid-render) plateaus
      too, as does an 80 MB `ipc://` fetch. The one thing that DOES produce the
      observed shape is Tauri's **postMessage IPC fallback**: a window whose
      custom-protocol fetch once rejected delivers every raw-bytes response as
      a `runCallback(id, [37,80,…])` script, and evaluating one 82 MB PDF that
      way takes the renderer to 2.8–6 GB and leaves ≥ 1.9 GB behind — per
      reload. Not proven to be the trigger (nothing in the logs says the
      fallback armed); now detectable: `readFileBytes` writes an `ipc-fallback`
      line to crash.log the first time a raw read arrives as a number array in
      a real window. Also new: the ceiling and hold reports carry the memory
      KIND (`webview_renderer_memory`: RssAnon/File/Shmem + the largest
      mappings from smaps), because "a reload does not free it" means it is not
      the page's garbage and the total alone cannot say what it is. Small
      certain wins landed alongside: an unchanged page's fingerprint compare
      now hands its parse back (`page.cleanup()` — `getOperatorList` had
      decoded every image on the page into the fresh document for nothing),
      the link layer's ink probe cleans up after its render, and a mid-compile
      `getPage` rejection no longer surfaces as an unhandled rejection per page.
    - [ ] 🖐️ Manual test (what is the 4 GB) — after a backend restart, work as
      before with the talk in a popout until the footer's `win-1` reading
      climbs; then read the newest `renderer-watchdog` entry in
      `~/.local/share/tabtivity/crash.log`: it now ends in `[anon … MB, file … MB,
      shmem … MB; largest mappings: …]`. Anon ≈ total means JS heap / decoded
      images; a large `memfd:` or shmem share means compositor or IPC buffers;
      an `ipc-fallback` entry above it means the fallback theory is confirmed.
      Also open the popout's devtools console once and look for "IPC custom
      protocol failed".
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

    **2026-09-07 — the second step (⚠️ untested live, backend not compiled
    here: no toolchain in the agent fence).** The kind clause answered: the
    MAIN window, with only agent tabs in the foreground project (no PDFs, no
    popout), climbed 4.9 → 6.7 GB in the ten held minutes (~150 MB/min), all
    anonymous (`[anon]` 4.3 GB + `[heap]` 2.2 GB, file 190 MB, shmem 10 MB), and
    the reload at 6.7 GB left 4.8 GB behind — memory of the WebKitWebProcess
    itself, which no page action reaches. So a held window now asks the
    backend to replace its renderer *process*: `webview_renderer_restart`
    (`terminate_web_process` + reload on the next main-loop turn; the crash
    reporter sees `TerminatedByApi` and stays out of it), once per 10 min per
    window on both sides (`sessionStorage` + a backend map, so a window
    watching the wrong pid cannot loop even if the storage dies with the
    process). Windows/macOS have no such API and hold as before.

    Then the user's read, which fits the numbers better than a leak: "maybe
    too many active projects? — the 4 GB is too strict". Every tab in every
    active scope stays mounted (`CenterPanel`'s flat pane layer), each
    terminal with xterm's four full-size canvas layers, and at 2× DPI thirty
    of them are several GB of honest working set — which a reload rebuilds
    (hence "frees nothing") and a process replacement would rebuild too. So
    the ceiling now scales: `max(4 GB, 25 % of RAM)` (`machine_load_snapshot`
    read once per window), and a window whose fresh process comes back over
    the ceiling has proved its size is the working set — its ceiling is raised
    to 1.5× that (`sessionStorage`, per window) with a crash.log line naming
    the mounted tab/terminal/scope counts, instead of blinking a healthy
    window every cooldown. A runaway past the headroom still trips.
    Still open: whether the ~150 MB/min climb inside the held ten minutes was
    tabs being opened or something growing per frame (canvas/compositor); a
    hidden pane dropping its canvas renderer until shown would cut the
    working set by (mounted − visible)/mounted either way.
    - [x] 🤖 Automated test — vitest `RendererWatchdog` (`shouldReplaceRenderer`:
      once per cooldown).
    - [ ] 🖐️ Manual test (the process is replaced) — after a backend restart,
      set `RENDERER_CEILING_MB` to 512 in `rendererWatchdog.ts` (hot-reloads):
      the window reloads, and 30 s later, still over 512 MB, blinks once more
      and comes back with the footer's `main` reading near 200 MB; crash.log
      holds `renderer-watchdog … replacing the renderer process` followed by
      `=== WEBVIEW 'main' RENDERER REPLACED …` and NO `TERMINATED … reason=`
      reload from the crash reporter. Tabs and PTYs are back. Restore the
      ceiling.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS
    - [ ] 🖐️ Manual test (the ceiling fits the machine) — after a backend
      restart, on the 64 GB box the first `renderer-watchdog` line of a session
      (if any) says `≥ 16384 MB ceiling`, not 4096; with the old backend it
      still says 4096 (no RAM reading → the floor).
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS
    - [ ] 🖐️ Manual test (what leaks) — with only agent tabs open, note the
      footer's `main` RSS, leave the agents idle 10 min, note it again; then
      let one agent stream output for 10 min and note it again. Idle-flat but
      streaming-climbs points at the paint path (canvas/compositor), climbing
      either way at the page. Also worth one try on this GNOME/Wayland host:
      `WEBKIT_DISABLE_DMABUF_RENDERER=0 ./start-tabtivity-tauri-hotreload.sh` —
      the 2026-08 verdict that kept DMABUF off was taken on Cinnamon/X11 with
      an older Mesa, and the DMABUF-off path is what runs here.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

---

822. **A native fault must kill the process, not spin its thread.** ✅ Fixed
    2026-09-05, code-complete and **live-unverified** (needs a backend restart).
    Reported as "Tabtivity (dev) crashed after tex compilation (not reacting)":
    the frozen build had compiled an A0 `poster_catchy.tex` (lualatex, one
    page, 2.9 MB PDF), then the window stopped responding while `crash.log`
    grew by ~6 MB/s — 538 MB of the single line `=== CRASH: SIGSEGV ===`, over
    26 million repeats, and the process still alive (state_gc's startup cap
    later trimmed it to its 4 MB tail). The signal handler in `lib.rs` relied on
    `SA_RESETHAND`: the kernel resets the disposition on entry, so returning
    re-executes the fault and the default action terminates. But on Linux the
    kernel never dispatched to it — WebKit's WTF signal layer
    (`Signals.cpp`, present in the linked libjavascriptcoregtk 2.52.6)
    installs its own SIGSEGV/SIGBUS handler later, saves ours as `oldAction`,
    and when its wasm/JIT handlers do not claim a fault it **calls
    `oldAction.sa_sigaction()` directly as a function** and returns with its
    own handler still installed. Ours logged a line and returned, the
    instruction re-faulted, and the faulting thread looped forever: a hung
    window instead of a dead process, and nothing anywhere said which. Fix:
    the handler restores `SIG_DFL` itself and re-raises (also correct for a
    `raise`d SIGABRT/SIGFPE, where returning would resume the raiser), runs on
    the alternate stack (`SA_ONSTACK`) so a stack overflow is logged rather
    than double-faulting, and the line now carries `si_code` and the faulting
    address (`=== CRASH: SIGSEGV code=0x1 addr=0x… ===`) — `addr=0x0` reads
    as a null dereference, a guard-page address as an overflow.
    - [ ] **The fault itself is not found.** Nothing in the compile path faults
      in Rust (the include scanner is depth- and visited-bounded; the compile
      is a child process), so the SIGSEGV was most likely in the UI process's
      GTK/WebKit side after the compile — the poster is an A0 page pdf.js
      rasterises large. Not the renderer watchdog: its `renderer-watchdog`
      entry would sit in crash.log before the loop and none did, no kernel OOM
      kill was logged, and 70 GB were free. **The next occurrence names
      itself** (same day, second pass): the handler now writes, after the
      header, a context line (`at <UTC> pc=0x… tid=… thread=… exe=… v…`) and a
      glibc backtrace as `module(+offset)` lines, ending in `=== CRASH END ===`
      — `SIG_DFL` restored before any of it and `alarm(5)` around the unwinder,
      so a fault or hang *inside* the handler still ends the process with the
      partial entry on disk. `scripts/crash-symbolize.sh` resolves the newest
      entry to `function at file:line` against the executable the entry names
      (the frozen binary keeps its symbol table; offsets are only valid for
      that exact file, so run it before the next `package:dev`). Verified
      outside Tabtivity with a standalone repro that installs a WTF-style
      chaining handler over it: plain, chained, and chained-from-a-worker-
      thread faults each die with exit 139 and exactly one entry whose trace
      names the faulting function. The thread name says which side it was:
      the process name is the GTK/WebKit UI thread, `tokio-runtime-w` a
      backend worker. When a trace stops at a WebKit frame, install
      `libwebkit2gtk-4.1-0-dbgsym` (or point `DEBUGINFOD_URLS` at Ubuntu's
      server) so addr2line can go further.
    - [ ] 🖐️ Manual test — after a backend restart, `kill -SEGV <tabtivity pid>`
      from a shell: the process must die at once (exit by signal 11), and
      `~/.local/share/tabtivity/crash.log` must gain exactly ONE
      `=== CRASH: SIGSEGV code=… addr=0x0 ===` line, not a stream.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

---

821. **The project name is a per-theme colour, not one apricot everywhere.**
    ✅ Done 2026-08-31, code-complete and **live-unverified**. Reported as the
    pill label reading "reddish everywhere". `--helix-orange` was a Helix
    signature apricot (`#f47868`) declared **only** in the `:root`/`fancy_dark`
    block, so every theme that did not think to override it inherited a tint
    picked for navy chrome — most visibly `soft_dark`, the one theme built to
    have no tint at all, whose project strip came out salmon, and `fancy_light`,
    where the inherited hue had been *darkened* for contrast rather than
    replaced (`#d6492f`) so the strip read as a row of warnings.
    Two themes had already opted out with a hardcoded `.project-pill-label`
    rule of their own — `fancy_dark` forcing `#fff` in `onboarding.css` and
    `light_lavender` forcing `#5d3eb8` in `apps.css` — which is the other half
    of the bug: where an override won, the token painted nothing, so the Theme
    Customizer's knob for this label was wired to nothing in those themes while
    its value went on tinting the ones with no override.
    Both overrides are folded back into the token, and every theme block now
    declares its own value out of its own palette: `fancy_dark` white,
    `soft_dark` `#e8eaf0`, `fancy_light` `#1f2937`, `light_lavender` `#5d3eb8`,
    and the achromatic pair's greys unchanged (they were already their own
    `--text-secondary`). One definition per theme, in the file where a theme's
    colours live. The token keeps its historical name so saved presets and
    `ui_theme_vars` overrides — both keyed by CSS variable name — survive; its
    Theme Customizer description no longer says "apricot".
    Frontend: `styles/themes.css`, `styles/apps.css`, `styles/onboarding.css`,
    `lib/i18n.ts` + the four dictionaries.

    - [ ] 🖐️ Manual test — walk all six themes in Settings → Theme and look at
      the project pills: no theme shows a reddish or salmon project name any
      more. `soft_dark` reads neutral light gray like the rest of its chrome,
      `fancy_light` reads the same near-black as its body text, `light_lavender`
      stays dark lavender and `fancy_dark` stays white — the last two exactly as
      before, since their hardcoded rules already painted those pixels.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS
    - [ ] 🖐️ Manual test (the knob now works) — Settings → *Theme colors* →
      Customize, find `--helix-orange` under "Other": its swatch shows the
      **current theme's** project-name colour rather than a fixed apricot, and
      editing the hex moves the project pill labels in every theme, including
      `fancy_dark` and `light_lavender`, where it previously did nothing. Reset
      the row and each theme returns to its own value.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

250. **Custom mouse cursors: three packs, drawn from the live theme.** ✅ Done
    2026-09-01, code-complete and **live-unverified**. `Settings.ui_cursor`,
    beside the accent and corner knobs in the Theme Customizer: **Aurora**
    (accent body, contrast outline, soft halo), **Pixel** (the same shapes on a
    16-pixel grid, upscaled with smoothing off) and **Ink** (monochrome, text
    colour on the window's own ground); unset is the system cursors.
    - **The art is drawn at runtime, not shipped.** `lib/theme/cursorPacks.ts`
      rasterises twelve shapes (arrow, hand, I-beam, open hand, fist, move, the
      two resize axes and their `col`/`row` twins, crosshair, deny) onto a
      canvas and emits `data:image/png` URLs, so the pointer takes the live
      `--accent`/`--text-primary`/`--bg-main` and recolors with the theme, a
      custom accent and every Theme Customizer edit. PNG rather than SVG because
      WebKit has never supported an SVG image as a CSS cursor — the Linux window
      would have fallen back to the keyword and shown nothing.
    - **How it reaches the app**: `stores/settings.applyCursor` writes the
      twelve `--cur-*` vars onto the root element and stamps `data-cursor`;
      every rule in the corpus was rewritten to
      `cursor: var(--cur-pointer, pointer)` (443 declarations across 16 files,
      plus a handful of inline styles), so with no pack active the declaration
      is exactly the keyword it always was. `styles/cursors.css` holds the root
      arrow, the text surfaces (fields, xterm, pdf.js's text layer) and the
      settings preview chrome.
    - **A failed render applies nothing**: no canvas backend means no vars *and*
      no attribute, so the keyword fallbacks stand and the system cursors are
      what is left — never a page with no pointer.
    - Persistence rides the backend's `extra` catch-all like `ui_theme_vars`
      (**no Rust change, no backend restart**). Cross-window via
      `APPEARANCE_CHANGED_EVENT`; a saved Theme Customizer preset carries the
      pack. Deliberately *not* pre-painted from `index.html` — twelve canvas
      renders is not what a pre-paint script is for, and a frame of the system
      arrow at launch costs nothing.
    - [x] 🤖 Automated test — `src/__tests__/theme/CursorPacks.test.ts` (normalize,
      every shape emitted with its hotspot and keyword fallback, both clear
      paths, the no-canvas no-op, and a corpus scan that fails on a bare
      `cursor: pointer;` anywhere in the stylesheet).
    - [ ] 🖐️ Manual test — Settings → *Theme colors* → Customize → Mouse
      cursor: pick Aurora and check the preview strip matches the pointer on
      screen; hover a button (hand), a text field and a terminal (I-beam), a
      tab bar grip (open hand, then fist while dragging) and a pane divider
      (double arrow). Switch the theme and change the accent — the pointer
      recolors with them. Check a popout window follows live, then set it back
      to System and confirm the desktop's own cursors return everywhere.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

- [ ] Native viewer follow-up: measure wrapped-editor layout before redesigning it;
  evaluate document virtualization, media streaming, and broader document caching
  separately from the focused visibility/autosave/image-loading fixes.
- [ ] Manually verify native viewer efficiency: edit a remote file continuously,
  switch files with autosave pending, and confirm its final bytes; edit multiple
  TeX children and compile from another child; recompile a PDF while scrolled and
  zoomed, then check restored position, thumbnails, and search results.

836. **A rejected PDF load leaves no Worker behind; the memory report counts
    threads.** `pdfjs.getDocument()` spawns a Worker per document and only
    `loadingTask.destroy()` ends it; every caller let a rejection propagate, so
    each failed load left an unreferenced ~18 MB JS VM. A LaTeX build rewriting
    the PDF while the viewer retried a truncated read is how the main window
    reached 303 `WebCore: Worker` threads at 4.7 GB (a crashed renderer: 575 at
    8.7 GB). `lib/viewers/pdfLoad.ts` is now the one way a PDF opens — it
    destroys the task on rejection and is the single place `workerSrc` is set
    (viewer, deck, present window, TeX hover preview). The renderer memory
    report now prints `/proc/<pid>/status`'s `Threads:` (Linux only), which is
    what tells a leaked Worker from a canvas. Files: `lib/viewers/pdfLoad.ts`,
    `components/embed/{pdf,deck}/…`, `lib/viewers/tex/texPreview.ts`,
    `lib/window/rendererWatchdog.ts`, `sysstat.rs`, `commands/debug.rs`. Implemented
    2026-09-08 (`7c06db6`, `a3b5b58`), **not live-tested; thread count needs a
    backend restart.**
    - [x] 🤖 Automated test — `PdfLoad` (destroy on rejection),
      `RendererWatchdog` (threads line only when present)
    - [ ] 🖐️ Manual test — open a TeX document's PDF and compile ten times while
      it is visible; the renderer memory report's thread count stays flat
      (compare `grep Threads /proc/<renderer pid>/status` before and after).
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

859. **A screen reader killed the renderer: Tabtivity opts out of WebKit's AT-SPI
    bridge.** Clicking the Downloads section's `→` (file a download into the
    project) blanked the window twice on 2026-09-17 and copied nothing. The
    copy path was never the problem: the apport core shows `WebKitWebProcess`
    aborting in WebKit 2.48's `org.a11y.atspi.Text` handler — it remaps the
    requested offset through a table whose bounds check is a `CRASH()`, not a
    clamp, so an offset that went stale between an assistive client's cache and
    its query takes the whole renderer down. Tabtivity is the worst case for it
    (terminals, lamps and trees rewrite text continuously), GNOME's Orca was
    running — it binds Super+Alt+S, and it crash-loops against the same bridge —
    and the same path's `g_utf8_substring: assertion 'end_pos >= start_pos'`
    criticals had been in `tabtivity-dev.log` for days. `services::webkit_a11y`
    now exports `WEBKIT_A11Y_BUS_ADDRESS` empty at the top of `run()`, before
    the first webview exists; `TABTIVITY_ENABLE_A11Y=1` hands the bridge back, and
    an address the environment already carries always wins. The variable is
    process-wide, so `terminal::build_command` and `commands::apps::
    launch_command` strip it again when Tabtivity was the one that set it — no
    *other* WebKitGTK app launched from a tab loses its own accessibility.
    Files: `services/webkit_a11y.rs`, `lib.rs`, `terminal/mod.rs`,
    `commands/apps.rs`. Implemented 2026-09-17, **not live-verified; needs a
    backend rebuild and a relaunch.**
    - [x] 🤖 Automated test — `webkit_a11y` (install precedence: inherited
      address wins, opt-in wins, an off-looking opt-in is not an opt-in)
    - [ ] 🖐️ Manual test — turn the screen reader on (Super+Alt+S, or
      `systemctl --user start orca`), then work the UI that crashed before:
      open the side panel's Downloads section and click `→` on a file. The file
      lands in the project and the window stays up. Confirm the bridge is
      really off — `tr '\0' '\n' < /proc/<tabtivity pid>/environ | grep A11Y`
      prints `WEBKIT_A11Y_BUS_ADDRESS=` — and that a GUI app launched from a
      terminal tab does *not* inherit it.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS
