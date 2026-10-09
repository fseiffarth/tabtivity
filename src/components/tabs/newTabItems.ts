import {
  FILES_TAB_CMD,
  RESUMABLE_AGENTS,
  TabEntry,
  TabKind,
} from "../../stores/tabs";
import type { CustomAgent } from "../../types";
import type { AddMenuEntry } from "./AddTabMenuList";
import type { TranslationKey } from "../../lib/i18n";
import { AGENT_TAB_ACTIONS, type AgentTabAction } from "../../lib/shortcuts/shortcuts";
import { cloudLaunchesFor, type CloudLaunch } from "../../lib/agents/cloudSessions";
import type { SignInLaunch } from "../../lib/agents/signInLaunch";
import { envName } from "../../lib/brand";
import { createElement } from "react";
import { CloudIcon } from "../common/icons/Icon";

/**
 * A static entry in the "new tab" add menu. Shared by the main-window `TabBar`
 * and the detached popout's own add menu so both draw from one source of truth.
 */
export interface StaticMenuItem {
  label: string;
  cmd: string;
  kind: TabKind;
  // Launch args, prepended before any session/resume args. Only custom agents
  // set this today; the built-in AGENT_ITEMS take no leading args.
  args?: string[];
  env?: Record<string, string>;
  // For a custom agent whose spec supplied a "continue last session" flag: the
  // args that make the tab restart-resumable (cwd-continue tier). Threaded onto
  // the tab as `resumeArgs`; see buildStaticTabSpec / isResumableAgentTab.
  resumeArgs?: string[];
  // Optional template for a command typed into the agent on launch to name its
  // own session after the project. Only set for agents with a known
  // session-rename command; others are skipped to avoid typing junk into them.
  sessionRename?: (projectName: string) => string;
  // For a generic (non-brand) item — "Shell", "Files" — the key to resolve the
  // displayed/persisted label through. Agent items keep their brand name as a
  // literal `label` and never set this (Claude/Codex/… are proper nouns).
  labelKey?: TranslationKey;
  // When set, Tabtivity mints a UUID at launch and passes it to the agent so it
  // owns a deterministic session id (e.g. Claude's `--session-id <uuid>`). The
  // returned strings are appended to the spawn args. Lets us surface the
  // session id on hover and later resume the session.
  sessionIdArgs?: (uuid: string) => string[];
}

// Only Claude and Gemini accept a caller-supplied session UUID at launch
// (both via `--session-id <uuid>`), so only those get `sessionIdArgs`. Codex
// (`codex resume <id>`) and Mistral/vibe (`--resume [id]`) mint their own ids
// and only accept one when resuming, so there's no deterministic id to capture
// up front — passing `--session-id` would just error and break the tab.
export const AGENT_ITEMS: StaticMenuItem[] = [
  { label: "Claude",   cmd: "claude",       kind: "agent", sessionRename: (n) => `/rename ${n}`, sessionIdArgs: (id) => ["--session-id", id] },
  { label: "Codex",    cmd: "codex",        kind: "agent" },
  { label: "Google Antigravity", cmd: "agy", kind: "agent" },
  { label: "Google Gemini", cmd: "gemini", kind: "agent", sessionIdArgs: (id) => ["--session-id", id] },
  { label: "Mistral",  cmd: "vibe",         kind: "agent" },
  // Kiro installs as `kiro-cli` — it is the renamed Amazon Q Developer CLI
  // and kept that executable name.
  { label: "Kiro",     cmd: "kiro-cli",     kind: "agent" },
  { label: "Cline",    cmd: "cline",        kind: "agent" },
  { label: "Aider",    cmd: "aider",        kind: "agent" },
  { label: "OpenCode", cmd: "opencode",     kind: "agent" },
  { label: "Cursor",   cmd: "cursor-agent", kind: "agent" },
  { label: "Copilot",  cmd: "copilot",      kind: "agent" },
  { label: "Droid",    cmd: "droid",        kind: "agent" },
  { label: "Grok",     cmd: "grok",         kind: "agent" },
  { label: "Qwen",     cmd: "qwen",         kind: "agent" },
  { label: "OpenClaw", cmd: "openclaw",     kind: "agent" },
  { label: "Auggie",   cmd: "auggie",       kind: "agent" },
  { label: "Kilo Code", cmd: "kilo",        kind: "agent" },
  { label: "Continue.dev", cmd: "cn",       kind: "agent" },
  { label: "JetBrains Junie", cmd: "junie", kind: "agent" },
  { label: "CodeBuddy", cmd: "codebuddy",   kind: "agent" },
  { label: "Goose",    cmd: "goose",        kind: "agent" },
  { label: "Pi",       cmd: "pi",           kind: "agent" },
  { label: "Plandex",  cmd: "plandex",      kind: "agent" },
  { label: "SWE-agent", cmd: "sweagent",    kind: "agent" },
  { label: "mini-SWE-agent", cmd: "mini",   kind: "agent" },
  { label: "Crush",    cmd: "crush",        kind: "agent" },
  { label: "Amp",      cmd: "amp",          kind: "agent" },
  { label: "Kimi Code", cmd: "kimi",        kind: "agent" },
  { label: "Qoder",    cmd: "qoder",        kind: "agent" },
  { label: "Meta Muse Code", cmd: "muse",   kind: "agent" },
];

export const SHELL_ITEMS: StaticMenuItem[] = [
  // Empty cmd → backend `default_shell()` picks the OS-appropriate shell
  // (cmd.exe on Windows, zsh on macOS, bash on Linux). Hardcoding "bash" here
  // fails to spawn on Windows where bash isn't on PATH.
  { label: "Shell", labelKey: "newTabMenu.groupShell", cmd: "",              kind: "shell" },
  { label: "Files", labelKey: "newTabMenu.groupFiles", cmd: FILES_TAB_CMD,   kind: "files" },
];

/** Resolve a {@link StaticMenuItem}'s display/persisted label: translated for a
 *  generic item (`labelKey` set), the literal brand name for an agent. */
export function itemLabel(item: StaticMenuItem, t: (key: TranslationKey) => string): string {
  return item.labelKey ? t(item.labelKey) : item.label;
}

/** The pure-frontend file panes kept to one tab per cwd (see TabBar.handleAdd).
 *  "projectfiles" is no longer offered as a standalone new-tab entry (it merely
 *  duplicated the side panel), but the kind still exists — a folder's "Open in
 *  a new tab" action creates one, and persisted ones restore — so it stays in
 *  the dedup predicate. */
export function isFileTabKind(kind: TabKind): boolean {
  return kind === "files" || kind === "projectfiles";
}

// Re-exported so both menus reference the same dot-accent palette.
export const TAB_ACCENT: Record<TabKind, string> = {
  agent: "var(--accent)",
  local_agent: "var(--warning)",
  shell: "var(--success)",
  files: "var(--text-muted)",
  projectfiles: "var(--text-muted)",
  embed: "var(--info)",
  projects3d: "var(--accent-secondary)",
  network: "var(--info)",
  monitor: "var(--success)",
  diskusage: "var(--warning)",
  calendar: "var(--accent)",
  browser: "var(--accent-secondary)",
  printing: "var(--text-muted)",
  skillslibrary: "var(--accent-secondary)",
  promptchart: "var(--accent)",
};

/**
 * Build the full tab payload (minus the store-minted `key`) for a static
 * agent/shell menu item. Mirrors the main-window `TabBar.handleAdd`: for
 * resumable agents it mints a session UUID + `TABTIVITY_TAB_UID`, threads
 * `sessionIdArgs` into the launch args, and derives the session-rename input.
 * Pure aside from `crypto.randomUUID`, so both the main and detached add menus
 * produce identical specs.
 */
export function buildStaticTabSpec(
  item: StaticMenuItem,
  projectCwd: string,
  projectName: string,
  t: (key: TranslationKey) => string,
): Omit<TabEntry, "key"> {
  const initialInput =
    item.sessionRename && projectName ? item.sessionRename(projectName) : undefined;
  // "Resumable" now spans a built-in in the static table AND a custom agent that
  // brought its own resume flag — both mint a session UUID so they satisfy the
  // tab-persistence gate (isResumableAgentTab requires a sessionId).
  const resumable = item.cmd in RESUMABLE_AGENTS || !!item.resumeArgs?.length;
  const sessionId =
    resumable || item.sessionIdArgs ? crypto.randomUUID() : undefined;
  const args = [
    ...(item.args ?? []),
    ...(sessionId && item.sessionIdArgs ? item.sessionIdArgs(sessionId) : []),
  ];
  const env = {
    ...(item.env ?? {}),
    ...(resumable && sessionId ? { [envName("TAB_UID")]: sessionId } : {}),
  };
  return {
    label: itemLabel(item, t),
    cmd: item.cmd,
    args,
    env,
    cwd: projectCwd,
    kind: item.kind,
    initialInput,
    sessionId,
    ...(item.resumeArgs?.length ? { resumeArgs: item.resumeArgs } : {}),
  };
}

/**
 * The tab payload for a built-in agent's *cloud* session (see
 * `lib/agents/cloudSessions`). Unlike {@link buildStaticTabSpec} it mints no
 * session id, no `TABTIVITY_TAB_UID` and no session-rename input: the session is
 * the vendor's, and a tab without an id is one restore drops rather than
 * relaunching into a second cloud session. `cloud` still has it saved and
 * tmux-wrapped while it runs, so a phone can attach (`isSavedWhileLive`).
 */
export function buildCloudTabSpec(
  item: StaticMenuItem,
  launch: CloudLaunch,
  task: string,
  projectCwd: string,
  t: (key: TranslationKey, vars?: Record<string, string>) => string,
): Omit<TabEntry, "key"> {
  return {
    label: t("newTabMenu.cloudTabLabel", { agent: itemLabel(item, t) }),
    cmd: item.cmd,
    args: launch.args(task),
    env: { ...(item.env ?? {}) },
    cwd: projectCwd,
    kind: item.kind,
    cloud: true,
  };
}

/**
 * The tab payload for a built-in agent's *sign-in* tab (see
 * `lib/agents/signInLaunch`): the CLI's own login command, or a plain launch
 * for a CLI that signs in when it starts. Like {@link buildCloudTabSpec} it
 * mints no session id, so restore drops it rather than signing in again.
 * `signIn` still has it saved and tmux-wrapped while it runs, so the phone
 * that asked for it can attach (`isSavedWhileLive`).
 */
export function buildSignInTabSpec(
  item: StaticMenuItem,
  launch: SignInLaunch,
  projectCwd: string,
  t: (key: TranslationKey, vars?: Record<string, string>) => string,
): Omit<TabEntry, "key"> {
  return {
    label: launch.exits
      ? t("newTabMenu.signInTabLabel", { agent: itemLabel(item, t) })
      : itemLabel(item, t),
    cmd: item.cmd,
    args: [...launch.args],
    env: { ...(item.env ?? {}), ...(launch.env ?? {}) },
    cwd: projectCwd,
    kind: item.kind,
    signIn: true,
  };
}

/** Stable empty custom-agent array, so a settings selector's `?? …` fallback
 *  keeps a constant reference (a fresh `[]` each render would loop the probe
 *  effect that depends on it). */
export const EMPTY_CUSTOM_AGENTS: CustomAgent[] = [];

/** The useful first-launch shortlist. Once the user touches a 🧠 "+ tab" chip,
 *  their persisted list (including an intentional empty one) takes over. */
export const DEFAULT_COMPACT_AGENT_IDS = ["claude", "codex", "gemini"];

/** Keep only the selected built-in agents in the menu's idle compact view, but
 * always retain the management row. Searching still receives the full list. */
export function compactAgentMenuEntries(
  entries: AddMenuEntry[],
  compactBins: ReadonlySet<string>,
): AddMenuEntry[] {
  return entries.filter(
    (entry) =>
      compactBins.has(entry.key) ||
      entry.key === "__add_custom_agent__" ||
      entry.key === CLOUD_SESSION_KEY,
  );
}

/** The Agents group's "Cloud session" row — kept in the compact menu too. */
export const CLOUD_SESSION_KEY = "__cloud_session__";

/** The installed built-in commands from the backend's agent registry. Agent
 * ids are not necessarily executable names (Google Antigravity is
 * `antigravity` / `agy`), while menu items launch by executable name. */
export interface BuiltInAgentStatus {
  bin: string;
  installed: boolean;
}

export function installedAgentBins(agents: readonly BuiltInAgentStatus[]): Set<string> {
  return new Set(agents.filter((agent) => agent.installed).map((agent) => agent.bin));
}

/** Apply Manage Agents' persisted registry ids to the executable-name set used
 * by tab launchers. Most ids equal their command, but this must also cover
 * entries such as `antigravity`/`agy` and `swe-agent`/`sweagent`. */
export function enabledInstalledAgentBins(
  agents: readonly (BuiltInAgentStatus & { id: string })[],
  disabledIds: readonly string[] | undefined,
): Set<string> {
  if (!disabledIds?.length) return installedAgentBins(agents);
  const disabled = new Set(disabledIds);
  for (const agent of agents) {
    if (disabled.has(agent.id)) disabled.add(agent.bin);
  }
  return new Set([...installedAgentBins(agents)].filter((bin) => !disabled.has(bin)));
}

/** The root console's agents are opt-in: a root agent gets the root MCP tools
 * (calendar, board, project list) no project agent has, so only the built-ins
 * the user switched on with the 🧠 menu's "Root" chip are offered there. Unset
 * means none. Ids and executable names both match, as for the compact list. */
export function rootAllowedAgentBins(
  enabled: ReadonlySet<string>,
  agents: readonly (BuiltInAgentStatus & { id: string })[],
  rootIds: readonly string[] | undefined,
): Set<string> {
  const allowed = new Set(rootIds ?? []);
  for (const agent of agents) {
    if (allowed.has(agent.id)) allowed.add(agent.bin);
  }
  return new Set([...enabled].filter((bin) => allowed.has(bin)));
}

/** Adapt a persisted {@link CustomAgent} into a menu item so it launches through
 *  the same `buildStaticTabSpec` path as the built-in agents. */
export function customAgentToItem(ca: CustomAgent): StaticMenuItem {
  return {
    label: ca.label,
    cmd: ca.cmd,
    kind: "agent",
    args: ca.args,
    env: ca.env,
    resumeArgs: ca.resumeArgs,
  };
}

/** One agent the Ctrl+1–9 chords open: its Agents-group row key and item. */
export interface AgentShortcutSlot {
  key: string;
  item: StaticMenuItem;
}

/**
 * `rows` in the user's agent order (`Settings.agent_order`, Agents-group row
 * keys): the keys it names first, in its order, then every other row as given.
 * No saved order leaves `rows` as they are.
 */
export function sortByAgentOrder<T>(
  rows: readonly T[],
  keyOf: (row: T) => string,
  order: readonly string[] | undefined,
): T[] {
  if (!order?.length) return [...rows];
  const rank = new Map(order.map((key, i) => [key, i]));
  return rows
    .map((row, i) => ({ row, rank: rank.get(keyOf(row)) ?? order.length + i }))
    .sort((a, b) => a.rank - b.rank)
    .map(({ row }) => row);
}

/**
 * Every Agents-group row key (`keys`, in menu order) in the order the chords
 * number them: the saved order when there is one, else the default agent first.
 * What Manage CLIs lists its installed agents by and rewrites when one moves.
 */
export function effectiveAgentOrder(
  keys: readonly string[],
  order: readonly string[] | undefined,
  defaultKey: string,
): string[] {
  if (order?.length) return sortByAgentOrder(keys, (key) => key, order);
  return keys.includes(defaultKey)
    ? [defaultKey, ...keys.filter((key) => key !== defaultKey)]
    : [...keys];
}

/**
 * `order` with `key` swapped with its next (`delta` 1) or previous (-1)
 * neighbour among `peers` — the rows the mover can see. Rows between the two
 * that the mover does not list (custom agents, in Manage CLIs) stay put.
 */
export function moveInAgentOrder(
  order: readonly string[],
  key: string,
  delta: 1 | -1,
  peers: readonly string[],
): string[] {
  const visible = order.filter((k) => peers.includes(k));
  const other = visible[visible.indexOf(key) + delta];
  const next = [...order];
  const from = next.indexOf(key);
  const to = other === undefined ? -1 : next.indexOf(other);
  if (from < 0 || to < 0) return next;
  [next[from], next[to]] = [next[to], next[from]];
  return next;
}

/**
 * The agents behind the Ctrl+1–9 chords, index 0 = Ctrl+1. With a saved
 * `agentOrder` the pickable rows simply follow it. Without one, slot 1 is the
 * default agent (`defaultAgentBin`), empty when it is not in the menu, and
 * slots 2–9 are the Agents group's other pickable rows in menu order. Shared by
 * the rows' chord hints (`agentMenuEntries`), the chord itself (`TabBar`) and
 * Manage CLIs' list, so the number shown is the agent opened.
 */
export function agentShortcutSlots(opts: {
  installedBuiltins: Set<string> | null;
  installedCmds: Set<string> | null;
  customAgents: CustomAgent[];
  defaultAgentBin: string;
  agentOrder?: readonly string[];
}): (AgentShortcutSlot | null)[] {
  const rows: AgentShortcutSlot[] = [
    ...AGENT_ITEMS.filter((item) => opts.installedBuiltins?.has(item.cmd)).map((item) => ({
      key: item.cmd,
      item,
    })),
    ...opts.customAgents
      .filter((ca) => opts.installedCmds == null || opts.installedCmds.has(ca.cmd))
      .map((ca) => ({ key: `custom:${ca.id}`, item: customAgentToItem(ca) })),
  ];
  if (opts.agentOrder?.length) {
    return sortByAgentOrder(rows, (row) => row.key, opts.agentOrder).slice(0, AGENT_TAB_ACTIONS.length);
  }
  const def = rows.find((row) => row.item.cmd === opts.defaultAgentBin) ?? null;
  return [def, ...rows.filter((row) => row !== def)].slice(0, AGENT_TAB_ACTIONS.length);
}

/**
 * Build the "Agents" group's rows for the add-tab menu, shared by the main-window
 * `TabBar` and the popout's `NewTabMenu` so both list agents identically:
 *   1. built-in agents whose binary is installed (`installedBuiltins`),
 *   2. every custom agent — greyed with a "(not found)" suffix when its command
 *      is known-missing (`installedCmds` resolved and lacking it), since the user
 *      added it deliberately and silently dropping it would be baffling,
 *   3. the "＋ Add agent…" row that opens the manage-agents dialog.
 *
 * `installedBuiltins`/`installedCmds` are `null` until their probes resolve, so
 * built-ins render nothing (no flash of all agents) while custom agents — which
 * the user typed themselves — render enabled until a probe proves one missing.
 */
export function agentMenuEntries(opts: {
  installedBuiltins: Set<string> | null;
  installedCmds: Set<string> | null;
  customAgents: CustomAgent[];
  pick: (item: StaticMenuItem) => void;
  /** Start one of an installed built-in's cloud launches. Unset → no
   *  "Cloud session" row (a scope where no cloud session makes sense). */
  pickCloud?: (item: StaticMenuItem, launch: CloudLaunch) => void;
  onAddCustom: () => void;
  /** Where the Ctrl+1–9 chords work (the main window's panes), the default
   *  agent's binary: each numbered row then shows its chord. */
  defaultAgentBin?: string;
  /** `Settings.agent_order`: the rows (and their numbers) follow it. */
  agentOrder?: readonly string[];
  t: (key: TranslationKey, vars?: Record<string, string>) => string;
}): AddMenuEntry[] {
  const chordByKey = new Map<string, AgentTabAction>();
  if (opts.defaultAgentBin !== undefined) {
    agentShortcutSlots({ ...opts, defaultAgentBin: opts.defaultAgentBin }).forEach((slot, i) => {
      if (slot) chordByKey.set(slot.key, AGENT_TAB_ACTIONS[i]);
    });
  }
  const builtins = sortByAgentOrder(
    AGENT_ITEMS.filter((item) => opts.installedBuiltins?.has(item.cmd)),
    (item) => item.cmd,
    opts.agentOrder,
  ).map((item) => ({
    key: item.cmd,
    label: item.label,
    color: TAB_ACCENT[item.kind],
    shortcut: chordByKey.get(item.cmd),
    onPick: () => opts.pick(item),
  }));
  // One row whose fly-out holds every installed built-in's cloud launches,
  // rather than a cloud twin per agent: most agents have none, and the plain
  // local launch stays the one-click row it always was.
  const cloudEntries: AddMenuEntry[] = opts.pickCloud
    ? AGENT_ITEMS.filter((item) => opts.installedBuiltins?.has(item.cmd)).flatMap((item) =>
        cloudLaunchesFor(item.cmd).map((launch) => ({
          key: `cloud:${item.cmd}:${launch.action}`,
          label: opts.t(
            launch.action === "new" ? "newTabMenu.cloudNew" : "newTabMenu.cloudOpen",
            { agent: item.label },
          ),
          dot: createElement(CloudIcon),
          color: TAB_ACCENT[item.kind],
          onPick: () => opts.pickCloud?.(item, launch),
        })),
      )
    : [];
  const cloudLabel = opts.t("newTabMenu.cloudSession");
  const cloud: AddMenuEntry[] = cloudEntries.length
    ? [{
        key: CLOUD_SESSION_KEY,
        label: cloudLabel,
        dot: createElement(CloudIcon),
        color: TAB_ACCENT.agent,
        moreTitle: cloudLabel,
        moreEntries: cloudEntries,
        onPick: () => {},
      }]
    : [];
  const custom = sortByAgentOrder(opts.customAgents, (ca) => `custom:${ca.id}`, opts.agentOrder).map((ca) => {
    const missing = opts.installedCmds != null && !opts.installedCmds.has(ca.cmd);
    return {
      key: `custom:${ca.id}`,
      label: missing ? `${ca.label} (${opts.t("globalApps.notFoundPlaceholder")})` : ca.label,
      color: TAB_ACCENT.agent,
      disabled: missing,
      shortcut: chordByKey.get(`custom:${ca.id}`),
      onPick: () => opts.pick(customAgentToItem(ca)),
    };
  });
  return [
    ...builtins,
    ...cloud,
    ...custom,
    {
      key: "__add_custom_agent__",
      label: opts.t("newTabMenu.addAgent"),
      dot: "＋",
      color: "var(--text-muted)",
      onPick: opts.onAddCustom,
    },
  ];
}
