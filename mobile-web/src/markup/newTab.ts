import { useEffect, useState } from "react";

import { ApiError, api, TAB_CREATE_TIMEOUT, type AgentRow, type AgentStatus, type ProjectDetail, type TabRow } from "../api";
import type { AgentSignal } from "./submitState";

/**
 * Mark up where no agent tab is open to send to — the project screen's files
 * and gallery, a shell tab: Submit first opens a new tab of the desktop's
 * default agent (`default_agent_cmd`) and hands it the prompt as a held prompt
 * (typed once the new CLI is ready). The markup view stays open, as after a
 * Submit into an agent tab's chat, and follows the new tab's turn
 * (`useOpenedTabAgent`); its Open tab button shows the tab.
 */

/** The agent such a Submit starts: the one the desktop flags as its default,
 * else the first it offers (an older desktop flags none). */
export function markupAgent(agents: readonly AgentRow[]): AgentRow | undefined {
  return agents.find((agent) => agent.default) ?? agents[0];
}

/** Opens the new agent tab in the project folder. `idempotencyKey` is kept by
 * the caller across a retry, so a Submit that timed out after the desktop
 * created the tab gets that tab back rather than a second one. */
export async function openMarkupTab(projectId: string, idempotencyKey: string): Promise<TabRow> {
  const path = `/api/v1/projects/${encodeURIComponent(projectId)}`;
  const agent = markupAgent((await api<ProjectDetail>(path)).agents);
  if (!agent) throw new ApiError(409, "no_agent");
  const body = await api<{ tab: TabRow }>(`${path}/tabs`, {
    method: "POST",
    body: JSON.stringify({ project_id: projectId, kind: "agent", agent_id: agent.id, idempotency_key: idempotencyKey }),
  }, TAB_CREATE_TIMEOUT);
  return body.tab;
}

/** How often the opened tab's row is read for the round's pill. */
export const OPENED_TAB_POLL = 3_000;

function signalOf(status: AgentStatus | undefined): AgentSignal {
  return status === "working" ? "working" : status === "question" ? "question" : "idle";
}

/** What the tab a new-tab Submit opened is doing, and the model it runs by its
 * first word — the round's pill, as an agent tab's chat feeds it: its row in
 * the project's catalog, read every few seconds while the page is visible.
 * Idle until there is a tab to follow, and kept as it was while a read fails. */
export function useOpenedTabAgent(projectId: string, tabId: string | undefined): { agent: AgentSignal; model?: string } {
  const [signal, setSignal] = useState<AgentSignal>("idle");
  const [model, setModel] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (!tabId) return;
    let stopped = false;
    let inflight: AbortController | undefined;
    const path = `/api/v1/projects/${encodeURIComponent(projectId)}`;
    const poll = () => {
      if (stopped || document.visibilityState === "hidden") return;
      inflight?.abort();
      const controller = new AbortController();
      inflight = controller;
      void api<ProjectDetail>(path, { signal: controller.signal }).then(
        (detail) => {
          if (stopped || controller.signal.aborted) return;
          const row = detail.tabs.find((tab) => tab.id === tabId);
          setSignal(signalOf(row?.agent_status));
          setModel(row?.agent_model?.trim().split(/\s+/)[0] || undefined);
        },
        () => {},
      );
    };
    poll();
    const timer = window.setInterval(poll, OPENED_TAB_POLL);
    document.addEventListener("visibilitychange", poll);
    return () => {
      stopped = true;
      inflight?.abort();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", poll);
    };
  }, [projectId, tabId]);
  return tabId ? { agent: signal, model } : { agent: "idle" };
}
