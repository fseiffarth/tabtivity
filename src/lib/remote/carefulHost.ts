/**
 * **Careful hosts** — "this machine is someone else's, so keep Tabtivity's
 * background load off it."
 *
 * The case it exists for is an HPC login node, where three separate things Tabtivity
 * does casually are things the site watches: CPU on the login node itself, a
 * recursive `du` over a `$HOME` that usually sits on a *parallel* filesystem
 * (a metadata storm against a shared Lustre/GPFS server), and repeated account
 * lookups against a shared directory service. None of those are expensive for
 * Tabtivity. All of them are rude at a cadence.
 *
 * Three things about the shape, each of which is the whole reason it works:
 *
 * **It is keyed by SSH target, not by host id.** One physical login node is
 * simultaneously a project's primary `remote`, a `compute_hosts` worker on
 * another project, and a project-free global machine — three tables, three ids,
 * one machine. A flag stored per record would be three values free to drift
 * apart. `targetKey` is the identity `machineSync` already uses as the bridge
 * between exactly those three, so it is the identity used here.
 *
 * **It is not named for HPC**, and — since it is now simply the default for every
 * remote host — it no longer *detects* HPC either. There is no cluster-vs-dev-box
 * classification anywhere in this module: an unanswered remote machine is treated
 * carefully because Tabtivity cannot know whose machine it is, and detection that
 * guessed would only ever guess wrong in the expensive direction. What the flag
 * means is a property of the machine's *politics*, not its hardware, and only the
 * user knows that.
 *
 * **The stored value is an explicit answer, in both directions.** `settings
 * .careful_hosts` records what the user actually said — which is why it is a map
 * to `boolean` rather than a set of careful hosts. A machine of the user's own
 * (a lab box, a workstation they own outright) is switched to normal once, per
 * SSH target, and stays that way; a set could not distinguish "the user said
 * normal" from "nobody has said anything", so the careful default would keep
 * turning itself back on.
 */

import { targetKey, type Target } from "./machineSync";
import type { ProjectEntry, Settings } from "../../types";

export type { Target };

/**
 * Whether `target` should be treated as careful: the user's explicit answer if
 * there is one, otherwise **true** — every remote host is careful until the user
 * says otherwise.
 *
 * Note the failure direction, which is the reverse of what it used to be. An
 * unanswered host now reads `true`, so an unknown machine is under-collected
 * rather than over-collected; the cost of a wrong careful is a thinner monitor
 * pane and a skipped host census, the cost of a wrong *normal* is a policy
 * violation on someone else's cluster. Only a local machine (no target) reads
 * `false` — Tabtivity is never a guest on the machine it runs on.
 */
export function isCarefulHost(
  settings: Settings | null | undefined,
  target: Target | null | undefined,
): boolean {
  if (!target?.host) return false;
  const explicit = settings?.careful_hosts?.[targetKey(target)];
  return typeof explicit === "boolean" ? explicit : true;
}

/** Whether the user has answered for this target at all (vs. it riding the
 *  careful default). The toggle uses this to say "default" rather than claiming
 *  the user chose. */
export function carefulIsExplicit(
  settings: Settings | null | undefined,
  target: Target | null | undefined,
): boolean {
  if (!target?.host) return false;
  return typeof settings?.careful_hosts?.[targetKey(target)] === "boolean";
}

/** The patch that records an explicit answer for `target`, for
 *  `useSettingsStore.updateSettings`. Merges into the existing map rather than
 *  replacing it — settings are saved whole, so a replace would drop every other
 *  host's answer. */
export function setCarefulPatch(
  settings: Settings | null | undefined,
  target: Target,
  careful: boolean,
): Pick<Settings, "careful_hosts"> {
  return {
    careful_hosts: { ...(settings?.careful_hosts ?? {}), [targetKey(target)]: careful },
  };
}

/** Drop the explicit answer for `target`, returning it to the careful default. */
export function clearCarefulPatch(
  settings: Settings | null | undefined,
  target: Target,
): Pick<Settings, "careful_hosts"> {
  const next = { ...(settings?.careful_hosts ?? {}) };
  delete next[targetKey(target)];
  return { careful_hosts: next };
}

/** The SSH target of a project's PRIMARY host, or null for a local project.
 *  The primary is the host that owns files/git/mirror, so it is the one the du
 *  census and the file-tree probes talk to. */
export function primaryTargetOf(project: ProjectEntry | null | undefined): Target | null {
  const r = project?.remote;
  if (!r?.host) return null;
  return { user: r.user || undefined, host: r.host, port: r.port ?? undefined };
}

/** The SSH target of any `RemoteSpec`-shaped record — a primary `remote`, a
 *  `compute_hosts` worker, or a project-free global machine. All three spell
 *  user/host/port the same way, which is the whole reason one key can span them. */
export function targetOfSpec(
  spec: { user?: string | null; host: string; port?: number | null } | null | undefined,
): Target | null {
  if (!spec?.host) return null;
  return { user: spec.user || undefined, host: spec.host, port: spec.port ?? undefined };
}
