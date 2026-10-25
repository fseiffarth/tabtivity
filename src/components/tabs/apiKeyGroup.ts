import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AGENT_CLI_ROWS } from "../../lib/agents/agentClis";
import type { TranslationKey } from "../../lib/i18n";
import type { AddMenuEntry, AddMenuGroup } from "./AddTabMenuList";
import { AGENT_ITEMS, TAB_ACCENT, type StaticMenuItem } from "./newTabItems";

/** The `agent_logins` fields the API section reads (`agent_auth::LoginStatus`). */
interface KeyLoginRow {
  id: string;
  api_key_saved?: boolean;
  api_budget_reached?: boolean;
}

/** A CLI a stored provider API key can run, by its binary (a tab's `cmd`). */
export interface KeyableAgent {
  bin: string;
  /** Its provider's monthly budget is spent or unset: the backend refuses it. */
  budgetReached: boolean;
}

/**
 * The CLIs the "+" menu's API section offers (`agent_api_keys::keyable_clis`):
 * a key saved for one of their providers, whether or not Manage CLIs switched
 * them onto it. Asked only while `active` (the menu is open), so a key saved
 * or a budget spent since the last open shows up on the next one.
 */
export function useKeyableAgents(active: boolean): KeyableAgent[] {
  const [agents, setAgents] = useState<KeyableAgent[]>([]);
  useEffect(() => {
    if (!active) return;
    let live = true;
    invoke<KeyLoginRow[]>("agent_logins")
      .then((rows) => {
        if (!live) return;
        const binOf = new Map(AGENT_CLI_ROWS.map((row) => [row.id, row.bin]));
        const next = (rows ?? []).flatMap((row) => {
          const bin = binOf.get(row.id);
          return row.api_key_saved && bin ? [{ bin, budgetReached: !!row.api_budget_reached }] : [];
        });
        // The same answer keeps the old array: no re-render of the menu.
        setAgents((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
      })
      .catch(() => {
        if (live) setAgents((prev) => (prev.length ? [] : prev));
      });
    return () => {
      live = false;
    };
  }, [active]);
  return agents;
}

/**
 * The "+" menu's API section: one "<agent> (API)" row per installed agent a
 * stored key can run, opening a tab that runs on the key (`TabEntry.apiKey`)
 * while the Agents group's plain rows stay on the CLI's own login. No group at
 * all when no key is saved. In a remote project the key reaches only a tab
 * that runs on this computer, which the row says as a caution.
 */
export function apiKeyMenuGroups(opts: {
  keyable: readonly KeyableAgent[];
  installedBuiltins: Set<string> | null;
  remoteScope: boolean;
  pick: (item: StaticMenuItem) => void;
  t: (key: TranslationKey, vars?: Record<string, string>) => string;
}): AddMenuGroup[] {
  const entries = AGENT_ITEMS.flatMap((item): AddMenuEntry[] => {
    const keyed = opts.keyable.find((agent) => agent.bin === item.cmd);
    if (!keyed || !opts.installedBuiltins?.has(item.cmd)) return [];
    const label = opts.t("newTabMenu.apiKeyEntry", { label: item.label });
    return [{
      key: `api:${item.cmd}`,
      label: keyed.budgetReached ? opts.t("newTabMenu.apiKeyEntryBudgetReached", { label }) : label,
      color: TAB_ACCENT[item.kind],
      disabled: keyed.budgetReached,
      untested: "newTabMenu.apiKey",
      caution: opts.remoteScope ? opts.t("newTabMenu.apiKeyRemoteCaution") : undefined,
      onPick: () => opts.pick({ ...item, label, apiKey: true }),
    }];
  });
  return entries.length ? [{ label: opts.t("newTabMenu.groupApiKey"), entries }] : [];
}
