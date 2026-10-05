import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { buildSendNowSchedule, schedulesToPruneForSend } from "../../lib/agents/prompt/send";
import { useAgentSchedulesStore } from "./agentSchedules";
import type { ScheduledAgentPrompt } from "../../lib/agents/agentSchedule";

/**
 * A prompt collected for a project without a tab binding. It lives in the
 * state dir's `agent_prompts.json`, keyed by scope, and becomes a schedule only
 * when aimed at an agent tab (`queuePromptForTab`, or the schedule dialog with
 * the text prefilled).
 */
export interface ProjectAgentPrompt {
  id: string;
  message: string;
  created_at: string;
  updated_at: string;
  /** Lowercase tokens the library is searched by (`lib/agents/prompt/tags`). */
  tags?: string[];
  /** The agent tab (`scheduleTargetId`) the prompt chart aims this draft at.
   *  Advisory until the draft is sent or scheduled; absent when unaimed. */
  target?: string;
  /** The paired phone that wrote or last edited it (#2348). A send names it
   *  on the rule, so revoking the phone cancels it; desktop edits keep it. */
  phone_device?: string;
}

/**
 * A collected prompt after it has been aimed at a tab. It leaves the active list
 * at send time and lands here, recording WHERE it went: the tab's label and,
 * when the tab has one, the agent session id — the question the history exists
 * to answer, and the one thing that still identifies the conversation once the
 * tab is closed.
 */
export interface SentAgentPrompt {
  schedule_origin?: ScheduledAgentPrompt["origin"];
  id: string;
  message: string;
  created_at: string;
  sent_at: string;
  tab_label: string;
  /** The LIVE session the prompt reached — the backend resolves the tab's
   *  launch id to the hook's record at write time, so rows sent after a
   *  `/clear` carry the new conversation's id. */
  session_id?: string;
  /** The tab it went to: its launch id, the same across `/clear`. What ties
   *  one tab's sessions to one strand. Absent on older rows. */
  tab_id?: string;
  preface?: string[];
  /** The agent the tab runs (`claude`, `codex`, …) — what the tab *is*, which
   *  still means something once a tab called "Agent 3" is closed. */
  agent?: string;
  /** How the delivery ended. Absent while the prompt is only queued. */
  result?: "delivered" | "missed" | "failed";
  /** The occurrence it was due at, as a local wall-clock key. */
  scheduled_for?: string;
  /** The tags the prompt carried when it was collected. */
  tags?: string[];
  /** Prompt blame: the full hash HEAD pointed at when the prompt was
   *  delivered, and the branch when there was one. Local repos only. */
  commit?: string;
  branch?: string;
  /** The files that changed between the delivery and the agent going idle,
   *  recorded once by `agent_prompt_blame`; `files_at` is when. Absent until
   *  the scheduler has seen the tab idle again. */
  files?: string[];
  files_at?: string;
  /** The model that answered, as the transcript names it; recorded with the
   *  blame. Absent until then, and for an agent whose transcript is not read. */
  model?: string;
}

export interface PromptLink {
  id: string;
  from: string;
  to: string;
  kind: "related" | "after";
  target?: string;
  /** Commands (`/clear`, …) an `after` edge types between its two prompts:
   *  the queued target's preface. */
  preface?: string[];
}

/** Send-time facts a history entry records. */
export interface SentPromptFacts {
  scheduleOrigin?: ScheduledAgentPrompt["origin"];
  tabLabel: string;
  /** The tab's `sessionId` — its launch id. The backend files the row under
   *  the live session the hook recorded for it and keeps this as `tab_id`. */
  sessionId?: string;
  /** The tab's schedule target id, the `tab_id` of a tab without a
   *  `sessionId` (`prompt/adopt.historyTabId`) — without it that tab's rows
   *  could only be told apart by a label other tabs share. */
  tabId?: string;
  preface?: string[];
  agent?: string;
  result?: SentAgentPrompt["result"];
  scheduledFor?: string;
  /** When it went, for a prompt recorded after the fact (ISO). Absent, the
   *  backend stamps now. */
  sentAt?: string;
}

function sentPayload(sent: SentPromptFacts) {
  return {
    ...(sent.scheduleOrigin ? { schedule_origin: sent.scheduleOrigin } : {}),
    tab_label: sent.tabLabel,
    session_id: sent.sessionId ?? null,
    // With a session id the backend keeps the launch id as the tab id.
    ...(!sent.sessionId && sent.tabId ? { tab_id: sent.tabId } : {}),
    preface: sent.preface ?? [],
    agent: sent.agent ?? null,
    result: sent.result ?? null,
    scheduled_for: sent.scheduledFor ?? null,
    // Only when set: a backend predating the field refuses the key outright.
    ...(sent.sentAt ? { sent_at: sent.sentAt } : {}),
  };
}

interface AgentPromptsStore {
  byProject: Record<string, ProjectAgentPrompt[]>;
  historyByProject: Record<string, SentAgentPrompt[]>;
  linksByProject: Record<string, PromptLink[]>;
  loading: Record<string, boolean>;
  load: (projectId: string) => Promise<ProjectAgentPrompt[]>;
  loadHistory: (projectId: string) => Promise<SentAgentPrompt[]>;
  loadLinks: (projectId: string) => Promise<PromptLink[]>;
  /** `tags` undefined leaves an existing prompt's tags alone (the phone edits
   *  text only); an array replaces them, empty included. `target` follows the
   *  same rule: undefined keeps it, `""` clears it. `phoneDevice` is the
   *  paired phone writing it (it takes the prompt over); undefined keeps the
   *  stored one. */
  upsert: (
    projectId: string,
    prompt: { id: string; message: string; tags?: string[]; target?: string; phoneDevice?: string },
  ) => Promise<ProjectAgentPrompt[]>;
  remove: (projectId: string, promptId: string) => Promise<ProjectAgentPrompt[]>;
  reorder: (projectId: string, ids: string[]) => Promise<ProjectAgentPrompt[]>;
  archive: (
    projectId: string,
    promptId: string,
    sent: SentPromptFacts,
  ) => Promise<ProjectAgentPrompt[]>;
  record: (
    projectId: string,
    entry: { id: string; message: string; sent: SentPromptFacts },
  ) => Promise<SentAgentPrompt[]>;
  clearHistory: (projectId: string, entryId?: string) => Promise<SentAgentPrompt[]>;
  link: (projectId: string, link: PromptLink) => Promise<PromptLink[]>;
  unlink: (projectId: string, linkId: string) => Promise<PromptLink[]>;
  /** Record the files a delivered prompt touched (see `agent_prompt_blame`). */
  blame: (projectId: string, entryId: string, since?: string) => Promise<SentAgentPrompt[]>;
  refreshLoaded: () => Promise<void>;
}

export const useAgentPromptsStore = create<AgentPromptsStore>((set, get) => ({
  byProject: {},
  historyByProject: {},
  linksByProject: {},
  loading: {},

  load: async (projectId) => {
    set((state) => ({ loading: { ...state.loading, [projectId]: true } }));
    try {
      const prompts = await invoke<ProjectAgentPrompt[]>("agent_prompts_list", { projectId });
      set((state) => ({ byProject: { ...state.byProject, [projectId]: prompts } }));
      return prompts;
    } finally {
      set((state) => ({ loading: { ...state.loading, [projectId]: false } }));
    }
  },

  loadHistory: async (projectId) => {
    const history = await invoke<SentAgentPrompt[]>("agent_prompt_history_list", { projectId });
    set((state) => ({ historyByProject: { ...state.historyByProject, [projectId]: history } }));
    return history;
  },

  loadLinks: async (projectId) => {
    const links = await invoke<PromptLink[]>("agent_prompt_links_list", { projectId });
    set((state) => ({ linksByProject: { ...state.linksByProject, [projectId]: links } }));
    return links;
  },

  upsert: async (projectId, prompt) => {
    const prompts = await invoke<ProjectAgentPrompt[]>("agent_prompt_upsert", {
      projectId,
      prompt: {
        id: prompt.id,
        message: prompt.message,
        tags: prompt.tags ?? null,
        target: prompt.target ?? null,
        phone_device: prompt.phoneDevice ?? null,
      },
    });
    set((state) => ({ byProject: { ...state.byProject, [projectId]: prompts } }));
    return prompts;
  },

  remove: async (projectId, promptId) => {
    const prompts = await invoke<ProjectAgentPrompt[]>("agent_prompt_delete", { projectId, promptId });
    set((state) => ({ byProject: { ...state.byProject, [projectId]: prompts } }));
    return prompts;
  },

  /**
   * Persist a dragged order. The list is written optimistically before the
   * command answers: the drop already moved the row on screen, and painting it
   * back to where it was for the length of a round trip is what makes a
   * reorder feel like it did not take.
   */
  reorder: async (projectId, ids) => {
    const before = get().byProject[projectId] ?? [];
    const staged = [
      ...ids.map((id) => before.find((prompt) => prompt.id === id)).filter((p): p is ProjectAgentPrompt => !!p),
      ...before.filter((prompt) => !ids.includes(prompt.id)),
    ];
    set((state) => ({ byProject: { ...state.byProject, [projectId]: staged } }));
    try {
      const prompts = await invoke<ProjectAgentPrompt[]>("agent_prompt_reorder", { projectId, ids });
      set((state) => ({ byProject: { ...state.byProject, [projectId]: prompts } }));
      return prompts;
    } catch (cause) {
      set((state) => ({ byProject: { ...state.byProject, [projectId]: before } }));
      throw cause;
    }
  },

  archive: async (projectId, promptId, sent) => {
    const prompts = await invoke<ProjectAgentPrompt[]>("agent_prompt_archive", {
      projectId,
      promptId,
      sent: sentPayload(sent),
    });
    set((state) => ({ byProject: { ...state.byProject, [projectId]: prompts } }));
    await get().loadHistory(projectId).catch(() => []);
    return prompts;
  },

  record: async (projectId, entry) => {
    const history = await invoke<SentAgentPrompt[]>("agent_prompt_record", {
      projectId,
      entry: { id: entry.id, message: entry.message, created_at: null, sent: sentPayload(entry.sent) },
    });
    set((state) => ({ historyByProject: { ...state.historyByProject, [projectId]: history } }));
    return history;
  },

  clearHistory: async (projectId, entryId) => {
    const history = await invoke<SentAgentPrompt[]>("agent_prompt_history_clear", {
      projectId,
      entryId: entryId ?? null,
    });
    set((state) => ({ historyByProject: { ...state.historyByProject, [projectId]: history } }));
    return history;
  },

  link: async (projectId, link) => {
    // An edge with no commands is sent without the key, the shape a backend
    // predating edge commands still accepts.
    const { preface, ...plain } = link;
    const payload = preface?.length ? link : plain;
    const links = await invoke<PromptLink[]>("agent_prompt_link_upsert", { projectId, link: payload });
    set((state) => ({ linksByProject: { ...state.linksByProject, [projectId]: links } }));
    return links;
  },

  unlink: async (projectId, linkId) => {
    const links = await invoke<PromptLink[]>("agent_prompt_link_delete", { projectId, linkId });
    set((state) => ({ linksByProject: { ...state.linksByProject, [projectId]: links } }));
    return links;
  },

  blame: async (projectId, entryId, since) => {
    const history = await invoke<SentAgentPrompt[]>("agent_prompt_blame", {
      projectId,
      entryId,
      since: since ?? null,
    });
    set((state) => ({ historyByProject: { ...state.historyByProject, [projectId]: history } }));
    return history;
  },

  refreshLoaded: async () => {
    await Promise.all(Object.keys(get().byProject).map((projectId) => get().load(projectId).catch(() => [])));
    await Promise.all(
      Object.keys(get().historyByProject).map((projectId) => get().loadHistory(projectId).catch(() => [])),
    );
    await Promise.all(
      Object.keys(get().linksByProject).map((projectId) => get().loadLinks(projectId).catch(() => [])),
    );
  },
}));

/**
 * Aim a message at one agent tab now: a one-time schedule at the current
 * minute (see `lib/agents/prompt/send`). Finished one-time schedules are pruned
 * first when the tab is at its cap; the count is returned so the caller can say
 * so. The scheduler host hears the change event and delivers at the next idle
 * point.
 */
export async function queuePromptForTab(
  projectId: string,
  scheduleTargetId: string,
  message: string,
  /** `phoneDevice`: the paired phone the prompt came from, which the rule
   * names so a revoke or a narrowed access cancels it (#2348). */
  options: { preface?: string[]; now?: Date; id?: string; phoneDevice?: string } = {},
): Promise<{ pruned: number; id: string }> {
  const now = options.now ?? new Date();
  const schedules = useAgentSchedulesStore.getState();
  const existing = await schedules.load(projectId, scheduleTargetId);
  // The backend replaces a rule by id. A prompt carried by a recurring rule
  // shares that rule's id, so queueing it under the id would turn the daily
  // rule into this one delivery — which is then retired. Checked against the
  // list just read, never the cache, which may not hold this tab yet.
  const clash = options.id !== undefined
    && existing.some((schedule) => schedule.id === options.id && schedule.rule.type !== "once");
  const id = options.id !== undefined && !clash ? options.id : crypto.randomUUID();
  const prune = schedulesToPruneForSend(existing);
  for (const pruned of prune) await schedules.remove(projectId, scheduleTargetId, pruned);
  const rule = buildSendNowSchedule(message, now, id, options.preface);
  await schedules.upsert(
    projectId,
    scheduleTargetId,
    options.phoneDevice ? { ...rule, phone_device: options.phoneDevice } : rule,
  );
  return { pruned: prune.length, id };
}

/**
 * Send a COLLECTED prompt at one tab: queue it, then retire it to the history.
 *
 * One helper rather than two call sites doing it in sequence, because the two
 * halves must not come apart — a prompt delivered but left in the active list is
 * one the user sends twice. The queue is what can fail; the archive is
 * best-effort and never undoes it, since the send has already happened.
 */
export async function sendCollectedPrompt(
  projectId: string,
  target: { scheduleTargetId: string; label: string; sessionId?: string; agent?: string },
  prompt: { id: string; message: string; phone_device?: string },
  preface?: string[],
  /** `phoneDevice`: the phone sending it; else the phone that wrote the
   *  prompt (`prompt.phone_device`, #2348) is the one the rule names. */
  options: { phoneDevice?: string } = {},
): Promise<{ pruned: number }> {
  // The queued schedule carries the PROMPT's id, which is the id its history
  // entry is written under. When the scheduler delivers it, the record it
  // writes lands on that same row and turns "queued" into "delivered" —
  // without the shared id the same prompt would be listed twice.
  const result = await queuePromptForTab(projectId, target.scheduleTargetId, prompt.message, {
    preface,
    id: prompt.id,
    phoneDevice: options.phoneDevice ?? prompt.phone_device,
  });
  await useAgentPromptsStore
    .getState()
    .archive(projectId, prompt.id, {
      tabLabel: target.label,
      sessionId: target.sessionId,
      tabId: target.scheduleTargetId,
      preface,
      agent: target.agent,
    })
    .catch(() => []);
  return result;
}

/**
 * Write one scheduled delivery onto the project's history — the record that
 * outlives the rule.
 *
 * It throws rather than swallowing: the caller retires the rule once this
 * succeeds, and a rule deleted after a failed write would take the only
 * account of the delivery with it. A caller that cannot act on the failure
 * ignores it; the scheduler retries on its next tick.
 */
export async function recordScheduledDelivery(
  projectId: string,
  entry: { id: string; message: string; preface?: string[] },
  sent: SentPromptFacts,
): Promise<void> {
  await useAgentPromptsStore.getState().record(projectId, {
    id: entry.id,
    message: entry.message,
    sent: { ...sent, preface: sent.preface ?? entry.preface },
  });
}
