import { createElement } from "react";
import type { CustomAgent } from "../../types";
import type { TranslationKey } from "../../lib/i18n";
import { AGENT_TAB_ACTIONS, type AgentTabAction } from "../../lib/shortcuts/shortcuts";
import { cloudLaunchesFor, type CloudLaunch } from "../../lib/agents/cloudSessions";
import { CloudIcon, HomeIcon } from "../common/icons/Icon";
import type { TabLocation } from "../../stores/tabs";
import { localityHostLabel, workerRunnable, type LocalityHost } from "../../stores/tabs/tabLocation";
import type { AddMenuEntry } from "./AddTabMenuList";
import {
  AGENT_ITEMS,
  TAB_ACCENT,
  agentShortcutSlots,
  customAgentToItem,
  onOwnLogin,
  sortByAgentOrder,
  type StaticMenuItem,
} from "../../lib/tabs/newTabItems";

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

/** One machine an agent row's ▾ list offers on a remote project. */
export interface AgentMachine {
  location: TabLocation;
  label: string;
  /** A worker holding no code (not shared-fs, sync off) cannot run a tab. */
  disabled?: boolean;
}

/** The machines a remote project's new agent tab can start on — the tab
 *  locality menu's list, in its order and wording: the local mirror, the
 *  primary, then each worker (one without the code offered disabled). A
 *  `pinned` project (`isHostPinned`) has no local mirror, so no Local row. */
export function agentMachines(opts: {
  primaryHost?: string;
  computeHosts?: LocalityHost[];
  pinned?: boolean;
  t: (key: TranslationKey, vars?: Record<string, string>) => string;
}): AgentMachine[] {
  const names = { primaryHost: opts.primaryHost, computeHosts: opts.computeHosts };
  return [
    ...(opts.pinned ? [] : [{ location: "local", label: localityHostLabel("local", names) } satisfies AgentMachine]),
    { location: "remote", label: localityHostLabel("remote", names) },
    ...(opts.computeHosts ?? []).map((h): AgentMachine => {
      const label = localityHostLabel(`host:${h.id}`, names);
      return workerRunnable(h, opts.pinned)
        ? { location: `host:${h.id}`, label }
        : { location: `host:${h.id}`, label: `${label} (${opts.t("tabLocality.syncOff")})`, disabled: true };
    }),
  ];
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
  /** Start the agent; `location` set when it was picked from the row's ▾
   *  machine list, else the kind's default. */
  pick: (item: StaticMenuItem, location?: TabLocation) => void;
  /** A remote project's machines (`agentMachines`): every agent row then gets
   *  a ▾ list to start it on one of them directly. Unset, or a single machine
   *  (a VM's primary alone), → no list: there is nothing to choose. */
  machines?: AgentMachine[];
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
  // The ▾ fly-out under an agent row: the same agent, started on a machine.
  const machinesFor = (label: string, item: () => StaticMenuItem) =>
    opts.machines && opts.machines.length > 1
      ? {
          machineTitle: opts.t("newTabMenu.chooseMachine", { agent: label }),
          machineEntries: opts.machines.map((m): AddMenuEntry => ({
            key: `${label}@${m.location}`,
            label: m.label,
            dot: createElement(m.location === "local" ? HomeIcon : CloudIcon),
            color: "var(--accent)",
            disabled: m.disabled,
            untested: "newTabMenu.chooseMachine",
            onPick: () => opts.pick(item(), m.location),
          })),
        }
      : {};
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
    onPick: () => opts.pick(onOwnLogin(item)),
    ...machinesFor(item.label, () => onOwnLogin(item)),
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
      onPick: () => opts.pick(onOwnLogin(customAgentToItem(ca))),
      ...(missing ? {} : machinesFor(ca.label, () => onOwnLogin(customAgentToItem(ca)))),
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
