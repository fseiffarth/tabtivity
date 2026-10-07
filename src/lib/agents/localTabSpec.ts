import { invoke } from "@tauri-apps/api/core";
import { useProjectsStore } from "../../stores/projects";
import { boxScopeId, useBoxesStore } from "../../stores/boxes";
import type { TabEntry } from "../../stores/tabs";
import { registerHostBoundTab } from "../remote/hostBound";
import { MOBILE_ACCESS_KEY, envName } from "../brand";

/**
 * The tab a local (Ollama) model opens — ONE builder for the main window's
 * `TabBar`, the popout's `NewTabMenu` and the phone's ＋ (`MobileBridgeHost`),
 * which must agree on what such a tab carries or the phone could start one
 * the desktop would not restore.
 *
 * Both start Ollama when it is down; neither waits for the model to load.
 */

/** Whether `scope`'s tabs are the phone's: a project or box with its Mobile
 * switch on. The root console never is here — its agent tabs are not
 * tmux-wrapped (`shouldPersistLocalTab`), so the phone could not attach. */
function mobileScope(scope: string): boolean {
  const project = useProjectsStore.getState().projects.find((entry) => entry.id === scope);
  if (project) return !!project[MOBILE_ACCESS_KEY];
  return !!useBoxesStore.getState().boxes.find((box) => boxScopeId(box.id) === scope)?.[MOBILE_ACCESS_KEY];
}

/** Mistral (`vibe`) on `model`, in its own per-model `VIBE_HOME`. Resumable by
 * its session id, so it restores anywhere without a launch line. */
export async function vibeLocalTabSpec(
  scope: string,
  model: string,
  cwd: string,
): Promise<Omit<TabEntry, "key">> {
  await invoke("ensure_ollama_running");
  const { vibe_home, alias } = await invoke<{ vibe_home: string; alias: string }>(
    "prepare_local_agent",
    { model },
  );
  const sessionId = crypto.randomUUID();
  return {
    label: model,
    cmd: "vibe",
    args: [],
    // TABTIVITY_LOCAL_MODEL records WHICH model this tab is driving, so the usage
    // recap can break local agent tabs down by model — and ONLY that (#150): the
    // right to run outside the project's container is granted by `hostBoundUid`
    // below, registered as a file in the state dir, so a display-only change here
    // can no longer hand out a container escape. `VIBE_ACTIVE_MODEL` carries the
    // resolved alias, not necessarily the name the user picked.
    env: { VIBE_HOME: vibe_home, VIBE_ACTIVE_MODEL: alias, [envName("LOCAL_MODEL")]: model, [envName("TAB_UID")]: sessionId },
    cwd,
    kind: "local_agent",
    sessionId,
    hostBoundUid: await registerHostBoundTab(scope),
  };
}

/**
 * `model` driven through another coding agent (`LOCAL_DRIVERS`: OpenCode, Pi,
 * Claude Code, Codex, Droid, OpenClaw, Cline). The backend resolves the spawn line — `ollama launch
 * <agent> --model <model>` when available, else a direct fallback — so the tab
 * carries everything in cmd+args (no env to re-hydrate).
 *
 * In a Mobile-access scope the tab also records that line (`localLaunch`), which
 * makes it restorable and so reachable from the phone; elsewhere it stays the
 * session-only tab it always was.
 */
export async function localLaunchTabSpec(
  scope: string,
  driver: string,
  driverLabel: string,
  model: string,
  cwd: string,
): Promise<Omit<TabEntry, "key">> {
  await invoke("ensure_ollama_running");
  const { cmd, args } = await invoke<{ cmd: string; args: string[] }>(
    "prepare_local_launch",
    { agent: driver, model },
  );
  return {
    label: `${model} · ${driverLabel}`,
    cmd,
    args,
    // Nothing else here names the model — cmd/args are the resolved launcher —
    // so record it for the usage recap's per-model breakdown. It is a label,
    // not an authority: see the `hostBoundUid` note above (#150).
    env: { [envName("LOCAL_MODEL")]: model },
    cwd,
    kind: "local_agent",
    hostBoundUid: await registerHostBoundTab(scope),
    ...(mobileScope(scope) ? { localLaunch: { driver, model, args: [...args] } } : {}),
  };
}
