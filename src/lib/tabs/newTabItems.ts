import { TabEntry, TabKind } from "../../stores/tabs";
import { FILES_TAB_CMD } from "../../stores/tabs/tabKinds";
import { AGENT_CLI_ROWS, RESUMABLE_AGENTS } from "../agents/agentClis";
import type { CustomAgent } from "../../types";
import type { TranslationKey } from "../i18n";
import { AGENT_TAB_ACTIONS } from "../shortcuts/shortcuts";
import type { CloudLaunch } from "../agents/cloudSessions";
import type { SignInLaunch } from "../agents/signInLaunch";
import { envName } from "../brand";

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
  // The tab's pick between the CLI's own login and the stored API key
  // (`TabEntry.apiKey`): the "+" menu's plain rows set `false`, its API
  // section `true`; unset leaves it to the Manage CLIs switch.
  apiKey?: boolean;
}

// Only Claude and Gemini accept a caller-supplied session UUID at launch
// (both via `--session-id <uuid>`), so only those get `sessionIdArgs`. Codex
// (`codex resume <id>`) and Mistral/vibe (`--resume [id]`) mint their own ids
// and only accept one when resuming, so there's no deterministic id to capture
// up front — passing `--session-id` would just error and break the tab.
const AGENT_ITEM_EXTRAS: Record<string, Partial<StaticMenuItem>> = {
  claude: { sessionRename: (n) => `/rename ${n}`, sessionIdArgs: (id) => ["--session-id", id] },
  gemini: { sessionIdArgs: (id) => ["--session-id", id] },
};

/** The built-in agents, in menu order: the backend registry's rows
 *  (`lib/agents/agentClis`) — its label, and its binary as the tab's `cmd` —
 *  plus the launch extras above. */
export const AGENT_ITEMS: StaticMenuItem[] = AGENT_CLI_ROWS.map((row) => ({
  label: row.label,
  cmd: row.bin,
  kind: "agent",
  ...AGENT_ITEM_EXTRAS[row.bin],
}));

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
    ...(item.apiKey !== undefined ? { apiKey: item.apiKey } : {}),
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

/** A plain "+" row's item: on the CLI's own login whatever the Manage CLIs
 *  switch says — the API section is where a stored key is picked. */
export function onOwnLogin(item: StaticMenuItem): StaticMenuItem {
  return { ...item, apiKey: false };
}
