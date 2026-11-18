import { useCallback, useEffect, useMemo, useRef, type RefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import { notifyAgentRegistryChanged } from "../lib/agents/agentRegistry";
import { useT } from "../lib/i18n";
import { installRun, patchInstallRun, startInstallRun, useInstallRunsStore } from "../stores/installRuns";

/** One line of an agent installer's output (`agent-install-progress`). */
interface InstallProgress {
  id: string;
  line: string;
}

/** The `installRuns` key of an agent CLI (the backend lock's key is its id). */
export const agentRunKey = (id: string) => `agent:${id}`;
const AGENT_PREFIX = "agent:";

export interface AgentInstaller {
  /** The agent id whose installer is running (one at a time), else null. */
  installing: string | null;
  /** The agent ids whose run another window or client holds; this one waits. */
  elsewhere: ReadonlySet<string>;
  /** Per-agent live installer log, keyed by agent id. */
  logs: Record<string, string>;
  /** Per-agent failure (the installer's tail, or a re-detect miss). */
  errors: Record<string, string>;
  /** Give it to the running agent's `<pre>` log: it stays pinned to the latest line. */
  logRef: RefObject<HTMLPreElement>;
  /** Run the CLI's official installer headless (`install_agent`), or join the
   *  run already going for it. The backend answers Ok only once the binary is
   *  detected, so `true` is a confirmed install; the registry-changed event is
   *  broadcast for every open list, whoever started the run. */
  install: (id: string) => Promise<boolean>;
  /** Run its installer again / its update verb (`update_agent`). The caller
   *  re-reads lists and broadcasts — once, for a whole "Update all" queue. */
  update: (id: string) => Promise<boolean>;
  /** Re-detect one CLI on PATH (`agent_is_installed`). A miss leaves the
   *  "still not detected" note on that agent; `null` = the probe failed. */
  recheck: (id: string) => Promise<boolean | null>;
  /** Set (or with `null` clear) one agent's error line. */
  setError: (id: string, error: string | null) => void;
}

const detect = (id: string) => () => invoke<boolean>("agent_is_installed", { id });

/**
 * The headless agent-CLI installer Settings → Manage CLIs and the intro's
 * Agent CLIs page share: `install_agent` / `update_agent` with the
 * `agent-install-progress` stream as a live log, one install at a time (a
 * second click while one runs starts nothing), and the `agent_is_installed`
 * re-detect. The runs live in `stores/installRuns`, so a view opened again
 * mid-install shows the run it left. Where an install needs a password (a
 * root-owned npm directory) the backend says so and the caller offers its
 * terminal-tab fallback.
 */
export function useAgentInstaller(): AgentInstaller {
  const t = useT();
  const runs = useInstallRunsStore((s) => s.runs);
  const logRef = useRef<HTMLPreElement>(null);

  const { installing, elsewhere, logs, errors } = useMemo(() => {
    let installing: string | null = null;
    const elsewhere = new Set<string>();
    const logs: Record<string, string> = {};
    const errors: Record<string, string> = {};
    for (const [key, run] of Object.entries(runs)) {
      if (!key.startsWith(AGENT_PREFIX)) continue;
      const id = key.slice(AGENT_PREFIX.length);
      if (run.running && installing === null) installing = id;
      if (run.elsewhere) elsewhere.add(id);
      if (run.log) logs[id] = run.log;
      if (run.error) errors[id] = run.error;
    }
    return { installing, elsewhere, logs, errors };
  }, [runs]);

  // Keep the live install log pinned to its latest line.
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logs, installing]);

  const setError = useCallback((id: string, error: string | null) => {
    patchInstallRun(agentRunKey(id), { error });
  }, []);

  const run = useCallback((id: string, command: "install_agent" | "update_agent"): Promise<boolean> => {
    // One agent installer at a time: a run for another CLI blocks this one;
    // the same CLI's run is joined (`startInstallRun`).
    const busy = Object.entries(useInstallRunsStore.getState().runs).some(
      ([key, r]) => r.running && key.startsWith(AGENT_PREFIX) && key !== agentRunKey(id),
    );
    if (busy) return Promise.resolve(false);
    return startInstallRun<InstallProgress>(agentRunKey(id), {
      event: "agent-install-progress",
      line: (p) => (p.id === id ? p.line : null),
      command,
      args: { id },
      detect: detect(id),
      onSuccess: command === "install_agent" ? notifyAgentRegistryChanged : undefined,
      keepLog: command === "install_agent",
    });
  }, []);

  const install = useCallback((id: string) => run(id, "install_agent"), [run]);
  const update = useCallback((id: string) => run(id, "update_agent"), [run]);

  const recheck = useCallback(
    async (id: string): Promise<boolean | null> => {
      if (installRun(agentRunKey(id)).running) return null;
      setError(id, null);
      try {
        const ok = await detect(id)();
        notifyAgentRegistryChanged();
        if (!ok) setError(id, t("agents.stillNotDetected"));
        return ok;
      } catch (err) {
        setError(id, String(err));
        return null;
      }
    },
    [setError, t],
  );

  return { installing, elsewhere, logs, errors, logRef, install, update, recheck, setError };
}
