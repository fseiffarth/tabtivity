# Prompt Universe — a global, cross-project prompt viewer on a 3D sphere

Status: **plan only.** Nothing here is implemented.

## Why

The prompt chart (`src/components/agents/PromptChart.tsx`, #262) answers "what
have I asked this project's agents, and what is queued next" — but only for **one
scope at a time**. It is a tab, so it belongs to a project, and a project switch
leaves it behind. The Agents view (`AgentSchedulesView.tsx`) is per-scope for the
same reason.

With agents running in several projects at once, the question with no surface is
the *global* one: which agents are working right now, which are waiting on a
decision, what is scheduled tonight, and what finished while the user was looking
somewhere else — across every project, in one window.

This plan adds that window: a **global overlay** (the Mail / Calendar / To-do /
Skills family — a header button, mounted once in `AppShell`, surviving a project
switch) whose primary view is a **3D sphere of projects** that drills into one
project's jobs.

Tabtivity already has that sphere. `src/components/common/ProjectBlobPane.tsx` is a
working, shipped 3D project cloud that drills from the project cloud into a focused
project's **files**. This feature reuses that engine and swaps the second level
from files to **jobs**. Nothing about the sphere is invented here.

## Decisions taken up front (user, 2026-09-08)

- **Surface**: an overlay, not a tab. A tab belongs to a scope; this view's whole
  point is that it belongs to none. Same argument that retired the mail tab.
- **Navigation**: drill-down. Level 1 is a sphere of projects, each node ringed by
  its running / waiting / finished counts. Clicking a project flies it to the
  centre and its jobs orbit it. Clicking a job jumps to its tab, or opens its card.
- **What a "job" is**: (a) the prompt-chart cards — draft, scheduled, queued, sent,
  chained — and (b) live agent tabs with their running state. Deliberately **not**
  SLURM/HPC jobs and **not** warm-up or auto-continue runs; both were offered and
  declined, and adding either later is additive rather than a redesign.

## Two constraints that shape everything

**No new Tauri command is needed.** Both stores are *already* globally keyed by
project id — `useAgentPromptsStore.byProject / .historyByProject / .linksByProject`
and `useAgentSchedulesStore.byTarget` (keyed `scheduleCacheKey(projectId, targetId)`).
Live tabs are `useTabsStore.tabsByScope` (every loaded scope) and their state is
`useActivityStore`. The backend's `agent_prompts.json` is one file whose `projects`,
`history` and `links` are all `BTreeMap<project_id, …>`, but every command takes a
`project_id`, so the aggregation is a frontend fan-out over commands that already
exist — and the feature **hot-reloads into the running window**. Do not add a
batched `*_list_all` command in v1; if the fan-out ever measures badly, that is a
later, separate change with its own justification.

**No new dependency, no WebGL.** `package.json` has no three/d3/charting library
and the Tauri CSP forbids CDNs. `ProjectBlobPane` already renders 3D as plain DOM:
its rAF loop rotates each point, does its own perspective divide, and writes a 2D
`transform` — deliberately *not* CSS `perspective`/`preserve-3d`, which WebKitGTK
flattens to a disc (WebView2 honours it, so Windows looked correct and Linux did
not). DMABUF is disabled, so everything is software-rasterized. Follow that path
exactly, and never animate a blurred `box-shadow`.

## Step 1 — Extract the sphere engine (the only risky step)

`ProjectBlobPane.tsx` is 1065 lines of working, user-facing code. Split it in two,
in this order, verifying between the halves.

### 1a. `src/lib/blobSphere.ts` (new) — the pure maths, moved verbatim

`Vec3`, `fibonacciSphere`, the camera constants (`PERSPECTIVE = 1100`, `MIN_DOLLY`,
`MAX_DOLLY`, `NEAR_PLANE = 60`, `NEAR_FADE = 240`, `ROT_SENSITIVITY`, `AUTO_SPIN`),
and one new pure function lifting the per-node body of the rAF loop:

```ts
projectNode(p: Vec3, cam: { rotX; rotY; dolly; radius }):
  { x; y; scale; opacity; z; hidden: boolean }
```

Move it unchanged and have `ProjectBlobPane` import it. Tests in
`src/__tests__/BlobSphere.test.ts`: lattice point count and unit radius; a node
past the near plane is `hidden`; the near fade is monotonic over the runway; depth
shading is brighter at the front; dolly clamps at both ends. This step alone is
provably behaviour-preserving and is worth landing on its own.

### 1b. `src/components/common/SphereScene.tsx` (new) — the reusable React piece

Owns the viewport, the rAF loop, orbit drag, wheel dolly, the bloom, the converge
animation and hover-card pinning. Generic over its nodes:

```ts
interface SphereNode { id: string; pos: Vec3; content: ReactNode; className?: string }
interface Props {
  nodes: SphereNode[]; active: boolean;
  onNodeClick?(id): void; onNodeDoubleClick?(id): void; onNodeContextMenu?(id, e): void;
  onNodeHover?(id: string | null, x: number, y: number): void;
  hoverCard?: ReactNode; convergeTo?: string | null; onConverged?(): void;
  overlay?: ReactNode;   // breadcrumb / hints / mode toggle, drawn above the scene
}
```

Carry the three WebKitGTK lessons across as comments, because they are the reason
the code looks the way it does:

- **Lazy pointer capture** past a 4px threshold. Capturing eagerly on press makes
  WebKitGTK route the `pointerup` to the viewport, so the node never receives its
  click and both single- and double-click die.
- **The manual perspective divide** (above).
- **`lastTs = 0` on re-show**, plus the `viewportRef.current?.offsetParent` guard,
  so a hidden spell is not banked as elapsed animation time.

Keep the Energy-Saver freeze by reading `quiesceActive()` from `src/stores/power.ts`
*inside* the loop — that module exports it non-reactively for exactly this.

`ProjectBlobPane` then becomes: node model + positions + hover card + context menu
+ pie mode, rendering `<SphereScene>`. Its CSS at `src/styles/subwindows.css:211-215`
and `:397-470` stays where it is and keeps its `.blob-*` names — `SphereScene` takes
its class names as props, so the existing tab renders byte-identically.

**If 1b disturbs the blob tab, stop at 1a.** The overlay can own a small scene
component built on the shared maths, and the duplication is then one rAF loop
rather than a whole coordinate system. Attempt 1b first, though: two divergent
sphere implementations is exactly the drift `ProjectFilesView` exists to prevent.

## Step 2 — The aggregation, pure and tested

`src/lib/promptUniverse.ts` (new). Everything is an argument, and **`now` is a
parameter, never `Date.now()`** — the rule `lib/alerts.ts` and `lib/todoBoard.ts`
already follow, because every interesting case here is a boundary case.

```ts
export interface UniverseInput {
  projects: ProjectEntry[]; boxes: ProjectBox[];
  tabsByScope: Record<string, TabEntry[]>;
  busyByTab; attentionByTab; lastDoneByTab;           // stores/activity, pty-id keyed
  promptsByProject; historyByProject; linksByProject; // stores/agents/agentPrompts
  schedulesByTarget;                                  // stores/agents/agentSchedules
  now: Date;
}

export type JobKind = "tab" | "card";
export type JobState = "working" | "needs-decision" | "finished" | "idle"
                     | "draft" | "scheduled" | "queued" | "sent" | "chained";

export interface UniverseJob {
  id: string; kind: JobKind; state: JobState; label: string;
  scope: string; tabKey?: string;          // → lib/shortcuts/tabJump's jumpToTab(scope, key)
  agent?: string; model?: string; at: Date | null; card?: PromptChartCard;
}

export interface UniverseScope {
  scope: string; name: string; loaded: boolean;   // is it in tabsByScope at all
  counts: { working; decision; finished; scheduled; queued; sent; draft };
  jobs: UniverseJob[]; color: string;
}

export function buildUniverse(input: UniverseInput): UniverseScope[];
export function universeJobMatches(job: UniverseJob, filter: UniverseFilter): boolean;
```

The card half **delegates to `buildPromptChart`** (`src/lib/agents/prompt/chart.ts`),
once per scope, with the strands that module already builds — a second derivation
of what "queued" means would be a second answer to one question. Reuse
`isPromptTargetTab` (exported by `PromptChartTab.tsx`) as the agent-tab predicate,
and the activity precedence every other surface reads: **decision > working > done
> idle**. Colours come from `src/lib/theme/categoryColor.ts` (`primaryCategoryColor`,
`projectCategories`) — the same colours the blob tab and the pills already give a
project.

Tests in `src/__tests__/PromptUniverse.test.ts`: counts per state; decision
outranks working; an unloaded scope reports `loaded: false` with cards but no tab
jobs; a scope with neither is omitted; a box appears as its own scope; a card whose
target tab has closed still appears (the chart's closed-strand case); `now` drives
scheduled-vs-sent placement; the filter composes.

## Step 3 — The overlay

**`src/stores/promptUniverse.ts`** (new) — `stores/skills.ts`'s shape: `open`,
`focusScope: string | null`, `open()/close()/focus()`. Nothing else; the data lives
in the stores that already own it, and a store-held copy would be a second answer
that can disagree with disk.

**`src/components/agents/UniverseOverlay.tsx`** (new) — structurally a copy of
`TodoOverlay.tsx`: gate → `overlayOpen` → Escape listener on `window` while live →
`null` when not live → `.modal-backdrop` with a backdrop-only `onMouseDown` close →
`.project-dialog dialog-framed universe-overlay` carrying a `.settings-title-row`
(`<h2>` + `<UntestedTag />`) and a `.dialog-close-btn`. Mounted in `AppShell.tsx`
**after** `SkillsOverlayHost`: all of these are `.modal-backdrop` at one z-index, so
DOM order is the tie-break and the most recently added should win. Not mounted in
`DetachedApp` — a popout has no header to open it from and its Zustand heap is
separate, so a second one would hold its own stale state.

**`src/components/agents/UniversePane.tsx`** (new) — the body, in three modes:

- **Sphere, level 1** — one node per scope from `buildUniverse`. Radius grows with
  total job count, colour is the project's category colour, and the node carries a
  ring in the same three status colours the pill strip uses (`--status-*`:
  `working` / `needs-decision` / `finished`). An inactive or unloaded project renders
  dimmed with an explicit "not restored" mark: the UI must never imply a project has
  no jobs when it merely has not been restored. Click converges into level 2;
  double-click activates that project (`setActive`) and closes the overlay.
- **Sphere, level 2** — the focused scope pinned at the centre, its jobs orbiting.
  Live-tab nodes ride an inner shell and card nodes an outer one ordered by `at`, so
  "what is running" and "what is planned" read as two bands rather than one cloud.
  Clicking a `tab` job calls `jumpToTab(scope, key)` and closes the overlay; clicking
  a `card` job expands it in place, reusing `PromptCard.tsx`. A breadcrumb returns to
  level 1, and Escape steps up one level before it closes the overlay.
- **Chart** — a header toggle (the blob pane's `sphere`/`pie` toggle shape) rendering
  the **existing** `<PromptChart scope={focusScope} active tabs={…} stateOf={…}>`
  unchanged. This is the whole reason the overlay is worth building on top of what
  exists rather than beside it: the detail view is the chart that already works,
  hosted a third way (tab, side panel, and now here).

The overlay header also carries `ScopeSetStatusBars` from
`src/components/projects/PillStatusBars.tsx` over every scope — it already merges
bars across scopes in one urgency order and routes each click through `jumpToTab`,
so "something over there wants you" is answered without new code.

**`src/components/header/UniverseIndicator.tsx`** (new) — `TodoIndicator.tsx`'s
twin, added to `HeaderBar.tsx`'s global-apps group beside ✉ 🗓 ☑. The badge is the
**derived** count of agents needing a decision across all scopes — derived, never
acknowledged, the rule `CalendarIndicator` and `TodoIndicator` share — read from
`useActivityStore.attentionByScope`, which is already live and costs nothing.

## Step 4 — Loading, and never polling while shut

The overlay is the only thing that loads. On open, for each project in
`useProjectsStore.projects`, fan out `load` / `loadHistory` / `loadLinks`; for each
agent tab of each loaded scope, `useAgentSchedulesStore.load(scope, targetId)`. All
`Promise.allSettled`, each with a per-project `.catch(() => [])`, so one bad project
cannot blank the sphere. Subscribe to the backend events `"agent-prompts-changed"`
and `"agent-schedules-changed"` (the chart already listens to the first) and re-run
the fan-out on either — **only while the overlay is open**. The rAF loop is gated on
the same flag, so a shut overlay costs exactly zero.

**Unloaded scopes.** `tabsByScope` holds only loaded scopes;
`restoreActiveProjectScopes()` loads every *active* project at launch, so an inactive
project genuinely has no running agents. It may still hold persisted prompts and
history, which is why `UniverseScope.loaded` exists and why an unloaded node is drawn
dimmed rather than empty. **Do not** call `restoreProjectScope` for unloaded projects
from here: it would read session files for every project on every open, which is work
the user did not ask for, and "not restored" is an honest thing to show. Offer it as
a per-node action instead ("restore this project's tabs").

## Step 5 — Gate, strings, style

**Gate.** Register `prompt_universe` in `EXPERIMENTAL_FLAGS`
(`src/lib/experimental.ts:49`), add `prompt_universe?: boolean` to `Settings`
(`src/types/index.ts`, beside `md_graph`/`project_remarks` at :505-507) and
`pub prompt_universe: Option<bool>` to the Rust `Settings`
(`src-tauri/src/schema/settings.rs`, beside :381-384). Read it **only** through
`useExperimental("prompt_universe")` — never `settings.x ?? false`, the spelling
that misses the debug default.

Because unset falls back to `settings.debug`, the feature is live in the hot-reload
window immediately. The Rust line matters only once an explicit value is written, so
it can land in the same commit and take effect at the next deliberate restart. It is
the **one backend line** in this change: run `npm run backend:stale` after it and
report the result; never restart the app. No `EXPERIMENTAL_TAB_KINDS` entry — this
owns an overlay, not a tab (the `mail_client` precedent).

**Strings.** A `promptUniverse.*` group in `src/lib/i18n.ts`, after the
`promptChart.*` block (~:1001). `src/__tests__/i18n.test.ts` is a key-**parity**
test: a key added to `en` without matching entries in all four of
`src/lib/i18nDicts/{de,es,fr,it}.ts` **fails the suite**. Write all five languages in
the same commit.

**CSS.** Add `.universe-overlay` to the shared size rule at
`src/styles/mail-todo.css:390-397` (`width: min(1680px, calc(100vw - 24px))`), so the
global overlays keep one box and the window does not jump between them. The pane's
own `.universe-*` rules go in `src/styles/projects-tabs.css` beside the existing
`.agent-prompt-chart*` block (~:3006). Node rings reuse `--status-*`, the tab ring's
own colours, so the sphere and the tab bar cannot disagree about a state.

**`UntestedTag`** on the overlay heading and the header button, and it stays until
the user says this feature is tested.

## Performance under a software rasterizer

The blob tab already carries 20–60 nodes on this rasterizer. Level 2 can be much
denser (20 projects × 40 cards), so:

- Level 1 is capped by project count, which reality bounds.
- Level 2 caps at ~120 nodes, the overflow folding into a "+N more" node that opens
  Chart mode — the surface actually built for hundreds of cards.
- Sent cards outside the current filter window are excluded **before** layout, not
  hidden after it: the rule `selectAlerts` follows about muting before the cap.
- Nodes past the near plane already get `pointer-events: none` and `opacity: 0` from
  the shared projection. That is the culling; nothing further is needed.

## Verification

**Automated** (all gates are at zero and must stay there):

- `npm test` — new: `src/__tests__/BlobSphere.test.ts`,
  `src/__tests__/PromptUniverse.test.ts`, `src/__tests__/UniverseOverlay.test.tsx`
  (opens on the flag; closes on Escape; level 1 → level 2 → breadcrumb; a tab node
  calls `jumpToTab` with the right scope and key; an unloaded scope is marked).
  Existing `AgentSchedulesView.test.tsx` and any blob-pane test must pass unchanged —
  that is the guard on Step 1.
- `npm run build` — the only type-check, and it covers `mobile-web/` too.
- `npm run lint` and
  `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`.
- `npm run backend:stale` after the one-line `settings.rs` edit; report what it says.

**Manual QA — the user runs this; agents never launch or restart Tabtivity.** In a
debug-mode window (the flag is on there by default, no toggle needed), with agents
running in at least two projects:

1. The header button appears; its badge lights when an agent asks something.
2. The overlay opens over whatever is on screen, survives a project switch, and closes
   on Escape and on a backdrop click — but not on a drag that merely ends outside it.
3. Level 1 spins, orbits by drag and zooms by wheel; a project's ring matches its
   pill's status bars.
4. Clicking a project converges it and its jobs bloom out; the breadcrumb and Escape
   step back up one level.
5. Clicking a working tab node lands in that tab, in that project.
6. The Chart toggle shows the existing prompt chart for the focused project, behaving
   exactly as the tab does.
7. An inactive project reads as "not restored", never as "no jobs".
8. With the overlay shut, the app is as idle as before — no spin, no polling.

Frame rate at the user's real project count, and WebKitGTK's pointer-capture
behaviour inside the overlay's stacking context, **cannot be verified without the
user**: both only show in the running window.
