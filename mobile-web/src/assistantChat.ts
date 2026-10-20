import { ApiError, TAB_CREATE_TIMEOUT, api, closeTab, getLaunchOptions, type AssistantLaunchOptions, type ProjectDetail, type TabRow } from "./api";

/**
 * Tabby on the phone is **one chat**, as in the desktop's side panel: Home's
 * FAB opens it (`TabbyOpen`), the Focus chat's head switches its CLI or
 * relaunches it. These are the two doors, both over the existing routes — the
 * scope's detail, `launch-options`' `assistant` block, a tab create carrying
 * the opaque launch id, `activate` for a chat with no process, and the close.
 */

/** How long a restored chat may take to come up, in one-second reads. */
const CHAT_START_TRIES = 25;

/** No launch can start a chat: none installed, or none signed in / reachable. */
export class NoAssistantLaunch extends Error {
  constructor(readonly options: AssistantLaunchOptions | undefined) {
    super("no_assistant_launch");
  }
}

function detail(id: string): Promise<ProjectDetail> {
  return api<ProjectDetail>(`/api/v1/projects/${encodeURIComponent(id)}`);
}

/** The launches the desktop offers for the scope; `undefined` when it lists none. */
export async function assistantLaunches(id: string, signal?: AbortSignal): Promise<AssistantLaunchOptions | undefined> {
  return (await getLaunchOptions(id, signal)).assistant;
}

/** Make a chat on `launch` and close every other chat of the scope. A close
 * that fails (no desktop window) leaves that chat behind, unseen. */
async function startFresh(id: string, launch: string): Promise<TabRow> {
  const body = await api<{ tab: TabRow }>(
    `/api/v1/projects/${encodeURIComponent(id)}/tabs`,
    { method: "POST", body: JSON.stringify({ project_id: id, kind: "agent", assistant: launch, idempotency_key: crypto.randomUUID() }) },
    TAB_CREATE_TIMEOUT,
  );
  const listed = await detail(id).catch(() => null);
  for (const row of listed?.tabs ?? []) {
    if (row.id !== body.tab.id) await closeTab(row.id).catch(() => undefined);
  }
  return body.tab;
}

/** Ask the desktop (or the owner, with no window) to start a chat that has no
 * process, then wait for its session to be live. */
async function start(id: string, tab: TabRow, alive: () => boolean): Promise<TabRow> {
  await api(`/api/v1/projects/${encodeURIComponent(id)}/activate?tab=${encodeURIComponent(tab.id)}`, { method: "POST" });
  for (let attempt = 0; attempt < CHAT_START_TRIES && alive(); attempt += 1) {
    await new Promise((resolve) => window.setTimeout(resolve, 1000));
    if (!alive()) break;
    const row = (await detail(id)).tabs.find((candidate) => candidate.id === tab.id);
    if (row?.available) return row;
  }
  throw new ApiError(410, "session_gone");
}

/** The chat the FAB opens: the last one, started again when it has no
 * process; with none, a new one on the desktop's default launch (or the first
 * that is ready). */
export async function openAssistantChat(id: string, alive: () => boolean = () => true): Promise<TabRow> {
  const chats = (await detail(id)).tabs;
  const last = chats[chats.length - 1];
  if (last) return last.available ? last : start(id, last, alive);
  const options = await assistantLaunches(id);
  const ready = options?.launches.filter((row) => row.ready) ?? [];
  const pick = ready.find((row) => row.default) ?? ready[0];
  if (!pick) throw new NoAssistantLaunch(options);
  return startFresh(id, pick.id);
}

/** A fresh chat on `launch` in place of the scope's chats: the head's CLI
 * pick, and Relaunch (the current chat's own launch). */
export function replaceAssistantChat(id: string, launch: string): Promise<TabRow> {
  return startFresh(id, launch);
}
