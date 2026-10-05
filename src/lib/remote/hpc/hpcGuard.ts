/**
 * The HPC tag's **confirmable** half, from the caller's side.
 *
 * Most of what the tag gates is simply switched off (sync loops, lockstep
 * polling, auto-connect, the census). Two things can't be, because the user
 * sometimes genuinely wants them: a disk-usage scan of the cluster tree, and
 * running something that computes on the login node. What the tag buys there is
 * that neither happens *silently* — the backend refuses with a sentinel naming what was
 * refused and which machine it was protecting, and the caller opts into a dialog
 * by wrapping itself in [`withHpcConfirm`].
 *
 * Exactly the shape `lib/remote/hostKey.ts` already established for an unknown host key,
 * and for the same reason: everything needed to explain and retry rides in the
 * error, so no call site has to know in advance that its target might be a
 * cluster, and the 99% of users with no cluster never see any of it.
 *
 * Confirmation is **per run**, never remembered. A tag that could be worn down by
 * clicking through once is not a gate; and the thing being confirmed (a metadata
 * storm, a job on a login node) is a specific act, not a policy.
 */

import { useHpcGuardStore, type HpcGuardKind } from "../../../stores/remote/hpc/hpcGuardPrompt";
import { envName } from "../../brand";

/** Must match `services::hpc_mode::HPC_GUARD`. */
export const HPC_GUARD = envName("HPC_GUARD");

export interface HpcGuardRefusal {
  /** What was refused — the dialog switches its wording on this. */
  kind: HpcGuardKind;
  /** The `user@host:port` being protected, for the dialog to name. */
  target: string;
}

/**
 * The refusal an error carries, or `null` for any other failure. Tolerates the
 * error being a string, an `Error`, or a raw Tauri rejection value.
 */
export function hpcGuardRefusal(e: unknown): HpcGuardRefusal | null {
  const text = e instanceof Error ? e.message : String(e);
  const at = text.indexOf(HPC_GUARD);
  if (at < 0) return null;
  const [kind, target] = text
    .slice(at + HPC_GUARD.length)
    .trim()
    .split(/\s+/);
  if (!kind) return null;
  return { kind: kind as HpcGuardKind, target: target ?? "" };
}

/**
 * Run `attempt(confirmed)`; if it refused only because the target is tagged HPC,
 * explain what it would cost and retry once — with `confirmed: true` — if the
 * user says go ahead. Any other failure, and a declined confirmation, propagates
 * unchanged, so existing error handling is untouched.
 *
 * `attempt` is invoked at most twice and must be safe to repeat: the refused
 * first call did nothing by construction (the gate is the command's first act).
 */
export async function withHpcConfirm<T>(attempt: (confirmed: boolean) => Promise<T>): Promise<T> {
  try {
    return await attempt(false);
  } catch (e) {
    const refusal = hpcGuardRefusal(e);
    if (!refusal) throw e;
    const ok = await useHpcGuardStore.getState().request(refusal.kind, refusal.target);
    // Declining is an answer, not an error to paper over: the original refusal
    // propagates so the caller's own "it didn't happen" path runs.
    if (!ok) throw e;
    return attempt(true);
  }
}

/**
 * Ask before doing something on a tagged host that only the **frontend** knows
 * about — a Python or script run landing on a login node, where there is no
 * backend command to refuse (the run is a terminal tab like any other). Returns
 * whether to go ahead; `false` means the user backed out.
 */
export async function confirmOnHpcHost(kind: HpcGuardKind, target: string): Promise<boolean> {
  return useHpcGuardStore.getState().request(kind, target);
}

/**
 * The gate in front of anything that would **run on a login node**: a Python run
 * or debug, or a shell script, whose resolved host is tagged HPC.
 *
 * Returns `true` to go ahead, `false` if the user backed out. A local run, an
 * untagged host, or a scope with no project resolves `true` without asking, so
 * the ordinary path costs one map lookup and no dialog.
 *
 * Why ask rather than refuse: the login node is the right place for plenty of
 * work (editing, moving data, submitting jobs), and Tabtivity cannot tell from a
 * command line which kind this is. What it can do is make sure nobody computes
 * there *by accident*, which is the whole of what the site's rule is about.
 *
 * Deliberately NOT applied to opening a plain shell tab. On a cluster you open
 * shells constantly — to submit, to check a queue, to move a file — and a prompt
 * on each would be the warning everybody learns to click through, which is worse
 * than none. The gate sits on the two actions that *are* compute.
 */
export async function guardLoginNodeRun(opts: {
  /** The project owning the run; `null`/`"root"` scopes are never on a cluster. */
  projectId: string | null;
  /** The tab `location` the run would carry — `undefined`/`"local"` is this
   *  machine, `"remote"` the project's primary, `host:<id>` a worker. */
  location: string | undefined;
  kind: Extract<HpcGuardKind, "login-node-run">;
}): Promise<boolean> {
  // The two cheap facts first, BEFORE anything is imported or any store is read:
  // a run with no host (the overwhelming majority — every local project) can be
  // answered without loading a line of this machinery.
  if (!opts.projectId || opts.projectId === "root") return true;
  if (!opts.location || opts.location === "local") return true;

  // Imported here rather than at module scope: this module is pulled in by the
  // dialog's own store, and the project/settings stores drag half the app behind
  // them — a cycle that only shows up as an undefined store at first render.
  const { useProjectsStore } = await import("../../../stores/projects");
  const { useSettingsStore } = await import("../../../stores/settings");
  const { isHpcHost } = await import("./hpcHost");
  const { hostsForProject } = await import("../remoteHosts");
  const { PRIMARY_HOST } = await import("../../../stores/remote/remoteStatus");

  const project = useProjectsStore.getState().projects.find((p) => p.id === opts.projectId);
  const hostId = opts.location === "remote" ? PRIMARY_HOST : opts.location.replace(/^host:/, "");
  const host = hostsForProject(project).find((h) => h.id === hostId);
  const settings = useSettingsStore.getState().settings;
  if (!host?.target || !isHpcHost(settings, host.target)) return true;

  const label = `${host.target.user ? `${host.target.user}@` : ""}${host.target.host}`;
  return confirmOnHpcHost(opts.kind, label);
}
