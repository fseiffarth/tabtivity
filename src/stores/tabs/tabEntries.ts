// Tab-entry shapes: a new tab's spec, a duplicate's, a restored saved tab,
// and the identity marks. Pure (no store access). Moved out of `stores/tabs.ts`.

import { restoredAgentCwd } from "../../lib/agents/agentWorktrees";
import { isTabColor } from "../../lib/theme/tabColors";
import { normalizeStackName } from "../../lib/tabStacks";
import { isTabMark } from "../../lib/tabMarks";
import { ROOT_SCOPE } from "../../lib/terminal/ptyId";
import { RESUMABLE_AGENTS } from "../../lib/agents/agentClis";
import { newTmuxSessionName } from "../../lib/terminal/tmuxSession";
import { envName } from "../../lib/brand";
import { ASSISTANT_SCOPE, readAssistantLaunch } from "../../lib/assistant";
import type { SavedTabEntry, TabEntry, TabKind } from "./types";
import { nextKey } from "./ids";
import { FILES_TAB_CMD, cmdToKind, isRelaunchableLocalTab, isResumableAgentTab } from "./tabKinds";

/** A shell tab, or a remote agent tab (Claude/Codex/…), gets a stable persisted
 *  tmux session name at creation (TODO #85), so a persistent remote run reattaches
 *  after a relaunch instead of forking a second session. For an agent tab this
 *  composes with `--resume`: `tmux new-session -A` reattaches the live agent when the
 *  host session survives, else creates a fresh one that runs the resume. The name is
 *  inert until `shouldPersistTab` decides to pass it, so minting it on a local agent
 *  costs nothing. A local-model tab (`local_agent`) gets one too, with the `agent`
 *  token: in a Mobile-access scope it is tmux-wrapped like any agent
 *  (`shouldPersistLocalTab`), which is how the phone reaches it. Tabs that already carry a name (or an explicit attach), and pane
 *  kinds with no PTY, are left untouched. */
export function withTmuxSession(
  tab: Omit<TabEntry, "key">,
  scope: string,
): Omit<TabEntry, "key"> {
  let next = tab;
  if ((next.kind === "agent" || next.kind === "local_agent") && !next.scheduleTargetId && scope !== ASSISTANT_SCOPE) {
    next = { ...next, scheduleTargetId: crypto.randomUUID() };
  }
  if (
    (next.kind === "shell" || next.kind === "agent" || next.kind === "local_agent") &&
    !next.tmuxSession &&
    !next.tmuxAttach &&
    // A login terminal is a plain PTY running ssh/openvpn — the backend refuses
    // one wrapped in tmux, and a login has nothing to outlive a crash for.
    !next.login
  ) {
    return { ...next, tmuxSession: newTmuxSessionName(scope, next.kind === "shell" ? "shell" : "agent") };
  }
  return next;
}

/** A persisted `todoId` as a usable card id, or `undefined`. The layout file is
 *  on disk, so it is capped and must look like the backend's ids. */
export function normalizeTodoId(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9_.@-]{1,128}$/.test(value) ? value : undefined;
}

/**
 * The launch spec for a COPY of `tab` — what "Duplicate" means, kept pure and
 * separate from the store action so it is testable and so the rule lives in one
 * place.
 *
 * The whole job is telling apart what *describes* a tab (its command, args, cwd,
 * locality, browsed folder, viewer position — all copied verbatim, or the copy
 * would open something else) from what *identifies* it. Every identity is
 * re-minted or dropped, because two tabs sharing one are not two tabs:
 *
 * - `sessionId` is an agent's conversation. It is minted fresh AND substituted
 *   wherever the old one was baked in at creation — `--session-id <uuid>` in
 *   `args`, `TABTIVITY_TAB_UID` in `env` (see `buildStaticTabSpec`) — since two
 *   agents launched onto one session id is a collision, not a duplicate.
 * - `tmuxSession` is dropped so `withTmuxSession` mints a new one; keeping it
 *   would make the copy REATTACH to the original's session instead of running.
 * - `tmuxAttach` is dropped for the same reason at the other end: a duplicate of
 *   a tab adopted from the Sessions view is a fresh shell on that host, not a
 *   second window onto the one session.
 * - `hostBoundUid` is dropped because the grant is a file the backend writes
 *   against a specific uid; the caller re-registers one and passes it back in
 *   (a store action cannot await). Without it the copy simply runs inside the
 *   project's container, which is the safe direction (`lib/remote/hostBound.ts`).
 * - `mark` and `todoId` are dropped: the card is the original's, and a copied
 *   Urgent would double what the project pill says needs attention.
 */
export function duplicateSpec(tab: TabEntry): Omit<TabEntry, "key"> {
  const {
    key: _key,
    sessionId,
    tmuxSession: _tmux,
    tmuxAttach: _attach,
    hostBoundUid: _hostBound,
    scheduleTargetId: _scheduleTarget,
    mark: _mark,
    todoId: _todo,
    ...rest
  } = tab;
  if (!sessionId) return rest;
  const nextId = crypto.randomUUID();
  const swap = (v: string) => (v === sessionId ? nextId : v);
  return {
    ...rest,
    sessionId: nextId,
    ...(rest.args ? { args: rest.args.map(swap) } : {}),
    ...(rest.env
      ? {
          env: Object.fromEntries(
            Object.entries(rest.env).map(([k, v]) => [k, swap(v)]),
          ),
        }
      : {}),
  };
}

/** A run tab saved before `pyTabLabel` dropped its typed ▶ still carries
 *  "▶︎ file.py", which WebKitGTK draws as the colour emoji in the tab and its
 *  hover card. Restore it as the plain file name. */
export function withoutLegacyRunGlyph(label: string): string {
  return label.replace(/^▶[︎️]?\s+/u, "");
}

/** The live entry a saved tab restores as — THE one place a `SavedTabEntry`
 * becomes a `TabEntry`: `loadFromLayout` maps every saved tab through it,
 * and `adoptSyncOutcome` a tab another client of this backend created
 * (headless owner plan, H3). Mints a fresh key (keys double as PTY ids and
 * are only unique within the session that wrote them) and keeps the shared
 * `id`; a resumable agent gets its resume args from the static table, never
 * from the file. */
export function restoreSavedTab(
  t: SavedTabEntry,
  ctx: { defaultCwd: string; scope: string; agentRoots: readonly string[] },
): TabEntry {
  const kind =
    t.kind ??
    cmdToKind(t.cmd || (t.type === "files" ? FILES_TAB_CMD : ""));
  // Agent tabs start in the current project dir so stale saved cwds don't
  // put the agent in the wrong directory after a project move/rename — with
  // two exceptions, both places the scope *derives* rather than remembers: a
  // cwd under THIS root's `.tabtivity/worktrees/` is a linked worktree the agent
  // was deliberately started in, and a box scope's member root (or a
  // worktree under one) is where its per-member Claude tab was started.
  // Resetting those put the agent in the wrong directory and, on the CLI of
  // the day, made `--resume` come back as a fresh conversation
  // (`restoredAgentCwd`).
  const isAgent = kind === "agent" || kind === "local_agent";
  const freshKey = nextKey(kind);
  // Resumable agent tabs (Claude with a sessionId) respawn with their
  // resume flag so the prior conversation comes back; everyone else starts
  // fresh with no args.
  const tabShape = {
    kind,
    cmd: t.cmd,
    sessionId: t.sessionId,
    // A Tabby chat takes no schedule (the backend refuses one for the scope).
    scheduleTargetId: isAgent && ctx.scope !== ASSISTANT_SCOPE ? (t.scheduleTargetId ?? crypto.randomUUID()) : undefined,
    resumeArgs: t.resumeArgs,
  };
  // A built-in looks its cmd up in the static table; only a custom agent
  // falls back to the resume flag carried on the tab.
  //
  // The table is preferred **whenever it has an entry**, rather than letting a
  // persisted `resumeArgs` win: the layout this is read from lives inside the
  // project tree, i.e. inside a container's writable mount and inside any
  // cloned repo, so a persisted arg vector is attacker-controlled. It used to
  // be handed to `pty_spawn` verbatim, which turned "write a file in my
  // project" into "choose the argv of a host-bound agent CLI". For a built-in
  // the table produces the same args anyway, so preferring it costs nothing.
  // A custom agent's flag is re-derived from `settings.json` by the backend
  // sanitizer (`terminal_service::sanitize_tab_layout`) before it reaches here.
  // A relaunchable local-model tab runs its launch line again: the backend
  // re-validated it against the driver table on load (`localLaunch`).
  const localLaunch =
    kind === "local_agent" && isRelaunchableLocalTab({ kind, localLaunch: t.localLaunch })
      ? t.localLaunch
      : undefined;
  const base =
    isResumableAgentTab(tabShape) && t.sessionId
      ? t.cmd in RESUMABLE_AGENTS
        ? RESUMABLE_AGENTS[t.cmd](t.sessionId)
        : (t.resumeArgs ?? [])
      : localLaunch
        ? [...localLaunch.args]
        : [];
  // No permission-mode flag is folded in here, and a layout written before
  // that toggle was removed carries an `agentMode` this ignores. An agent
  // restores on the plain resume command and picks its mode up where it
  // keeps it: Claude's own hook record, re-applied by the backend's
  // `--resume` rewrite (`services::agent_session`), and for every other
  // agent whatever its CLI does on resume.
  const args = base;
  // Every resumable agent tab's TABTIVITY_TAB_UID is its `sessionId`
  // (`buildStaticTabSpec` sets both from one uuid). The backend binds the
  // agent's turn reports by it, and for Codex and Vibe — whose `sessionId`
  // is Tabtivity's stable *binding* key rather than a CLI argument — resolves
  // the conversation to resume from it. Rebuild it from the durable
  // sessionId rather than read it from `env`: a layout written before the
  // key was persisted, a stale one whose env disagrees, and one adopted from
  // a folder or an import bundle (which carries no `env` at all, gap 17)
  // would otherwise lose the binding. It is not a user-configurable
  // environment override.
  const env = { ...(t.env ?? {}) };
  if (isResumableAgentTab(tabShape) && t.sessionId) {
    env[envName("TAB_UID")] = t.sessionId;
  }
  return {
    key: freshKey,
    // The shared-set identity survives the re-mint: it is how the next
    // sync tells this tab from a new one.
    id: t.id,
    label: withoutLegacyRunGlyph(t.label),
    cmd: t.cmd,
    args,
    env,
    // A Tabby chat keeps its saved cwd: the chat's own folder, which the
    // backend rewrites at the spawn anyway and which is no project directory.
    cwd:
      isAgent && ctx.defaultCwd && ctx.scope !== ASSISTANT_SCOPE
        ? restoredAgentCwd(t.cwd, ctx.defaultCwd, ctx.agentRoots)
        : t.cwd || ctx.defaultCwd,
    kind,
    sessionId: t.sessionId,
    // The binding into agent_tasks.json. Kept from the layout when it has one,
    // minted here otherwise (a layout written before schedules existed) — it
    // used to be computed on `tabShape` only and never reach the entry, so a
    // restored agent tab had no target: no ◷ on the desktop, `tab_not_found`
    // on the phone, and the startup orphan sweep deleting every schedule.
    scheduleTargetId: tabShape.scheduleTargetId,
    // A restart-resumable custom agent keeps its resume flag (already folded
    // into `base`/`args` above) so a *second* restart resumes it again.
    resumeArgs: t.resumeArgs,
    // Restored file embed tabs (kind === "embed") carry their durable path
    // and how to open it so the pane rebuilds exactly.
    embedPath: t.embedPath,
    embedExec: t.embedExec,
    viewer: t.viewer,
    viewerState: t.viewerState,
    // SSH-sync Phase 0: restore the persisted per-tab locality.
    location: t.location,
    // A "projectfiles" tab reopens on the folder it was browsed into.
    folder: t.folder,
    // A "browser" tab reopens holding the address it was last on — on its
    // resume card, NOT navigated (see BROWSER_TAB_CMD / isRestorableKind).
    url: t.url,
    // Persistent sessions (TODO #85): keep the stable session name so the
    // reattach targets the SAME host session after a relaunch. Mint one for a
    // shell tab — or a resumable agent tab (only restorable tabs reach here) —
    // persisted before this feature existed (it then reattaches on every
    // subsequent restart).
    tmuxSession:
      t.tmuxSession ??
      ((kind === "shell" || kind === "agent" || kind === "local_agent") && !t.tmuxAttach
        ? newTmuxSessionName(ctx.scope, kind === "shell" ? "shell" : "agent")
        : undefined),
    // A Sessions-view attach tab reattaches to its tmux session on restart.
    tmuxAttach: t.tmuxAttach,
    // Carry the host-bound marker id so a restored local-model tab keeps its
    // exemption. Never minted here: a uid without a registered marker file
    // grants nothing, and minting one on restore would be inventing an
    // authority the user never asked for.
    hostBoundUid: t.hostBoundUid,
    mobileRequestHash: t.mobileRequestHash,
    localLaunch,
    // The login-or-key pick: only a boolean is taken from disk.
    ...(typeof t.apiKey !== "boolean"
      ? {}
      : {
          apiKey: t.apiKey,
        }),
    // The launch of a Tabby chat; in any other scope the block is ignored (a
    // project's layout file is attacker-controlled).
    ...(ctx.scope === ASSISTANT_SCOPE ? { assistant: readAssistantLaunch(t.assistant) } : {}),
    // A Host session never auto-resumes after a restart: it comes back
    // paused and waits for an explicit Resume (only in the root scope,
    // the one place the marker means anything).
    ...(t.hostSession && (ctx.scope) === ROOT_SCOPE
      ? { hostSession: true, hostSessionPaused: true }
      : {}),
    // Restore the no-tmux marker BEFORE anything reads it: the minted name
    // above is harmless on such a tab precisely because `shouldPersistTab`
    // refuses to use it.
    ephemeral: t.ephemeral,
    // A tab that was continuing itself across rate-limit windows keeps doing
    // so after a relaunch. Only the switch comes back: `AgentContinueHost`
    // re-reads the CLI's usage panel and arms a fresh window.
    autoContinue: t.autoContinue,
    // The user's tab colour. Validated against the palette on the way in
    // rather than trusted: this layout is a file on disk, and an id that is
    // not in `TAB_COLORS` would reach `--tab-accent` as raw CSS.
    color: isTabColor(t.color) ? t.color : undefined,
    // Its tab group, likewise from the file: plain text, capped.
    stack: normalizeStackName(t.stack),
    mark: isTabMark(t.mark) ? t.mark : undefined,
      todoId: normalizeTodoId(t.todoId),
    };
}

/** What makes two tabs the same tab: its key, the file a viewer shows, the
 * tmux session a terminal owns, the agent conversation it resumes. A
 * duplicate (`duplicateSpec`) mints a fresh session and conversation, so no
 * two tabs of a scope share any of these on purpose. */
export function tabIdentity(t: {
  key?: string;
  kind?: TabKind;
  cmd?: string;
  embedPath?: string;
  tmuxSession?: string;
  sessionId?: string;
}): string[] {
  const marks: string[] = t.key ? [`key:${t.key}`] : [];
  if ((t.kind ?? cmdToKind(t.cmd || "")) === "embed" && t.embedPath) marks.push(`file:${t.embedPath}`);
  if (t.tmuxSession) marks.push(`tmux:${t.tmuxSession}`);
  if (t.sessionId) marks.push(`session:${t.sessionId}`);
  return marks;
}
