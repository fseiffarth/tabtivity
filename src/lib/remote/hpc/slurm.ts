/**
 * SLURM run/watch glue for HPC projects (`docs/quirky-knitting-umbrella` plan).
 *
 * A SLURM cluster forbids real computation on the login node — everything heavy
 * goes through the scheduler.
 * This module lets a `.slurm` file be submitted, watched, and cancelled from the
 * code viewer without the user memorizing `sbatch`/`squeue`/`scancel`.
 *
 * Two halves, both modeled on `lib/terminal/pythonRun.ts`:
 *
 *  1. **Pure text helpers** — `isSlurmScript`, `parseSbatchDirectives`,
 *     `spliceDirective`. Like the YAML/table viewers, the directive form *renders
 *     rows but edits text*: `spliceDirective` edits the file's `#SBATCH` lines by
 *     splicing, never re-serializing, so every other byte of the script is left
 *     alone and each edit is an ordinary dirty/undoable/saveable change.
 *  2. **Tab glue** — the **log window** and the **interactive job shell** are just
 *     terminal tabs, exactly as a Python run is. A tab carries locality and tmux
 *     persistence for free, so a `tail -F` of the job log reattaches on relaunch
 *     and an `srun --pty` lands on a compute node (the compliant interactive path).
 */

import { invoke } from "@tauri-apps/api/core";
import { useTabsStore, type TabEntry, type TabLocation } from "../../../stores/tabs";
import { useHpcJobsStore, type HpcJob } from "../../../stores/remote/hpc/hpcJobs";
import { shellQuote } from "../../terminal/pythonRun";
import { useProjectsStore } from "../../../stores/projects";
import { useSettingsStore } from "../../../stores/settings";
import { isHpcHost, targetOfSpec } from "./hpcHost";
import { basename } from "../../paths";
import { translate, useI18nStore } from "../../i18n";

// ── Backend types (mirror `commands::slurm`) ─────────────────────────────────

export interface SlurmInfo {
  available: boolean;
  version?: string;
}

export interface SlurmSubmit {
  job_id: string;
  out_file: string;
  err_file: string;
  work_dir: string;
}

export interface SlurmJob {
  id: string;
  name: string;
  state: string;
  time: string;
  nodes: string;
  reason: string;
}

// ── Invoke wrappers ──────────────────────────────────────────────────────────

/** Is SLURM available on the project's host? Lets the UI hide itself off-HPC. */
export function slurmAvailable(projectDir: string, hostId?: string): Promise<SlurmInfo> {
  return invoke<SlurmInfo>("slurm_available", { projectDir, hostId });
}

/** The current user's jobs on the host (for the Jobs view). */
export function slurmQueue(projectDir: string, hostId?: string): Promise<SlurmJob[]> {
  return invoke<SlurmJob[]>("slurm_queue", { projectDir, hostId });
}

/** Cancel a job by id. */
export function slurmCancel(projectDir: string, jobId: string, hostId?: string): Promise<void> {
  return invoke("slurm_cancel", { projectDir, jobId, hostId });
}

/** Resolve a job's stdout path (for Watch on a job we didn't submit this session).
 *  `logDir` is the project's recorded HPC log folder (`hpc.logs_dir`): when the
 *  pipeline routes `--output` into the home anchor, the backend's
 *  `<WorkDir>/slurm-<id>.out` fallback names a file that never existed, so the
 *  recorded folder is passed as the better guess. Whatever `scontrol` states
 *  still wins over both. */
export function slurmJobOut(
  projectDir: string,
  jobId: string,
  hostId?: string,
  logDir?: string,
): Promise<string> {
  return invoke<string>("slurm_job_out", { projectDir, jobId, hostId, logDir });
}

// ── #SBATCH directive parsing / splicing (render rows, edit text) ─────────────

/** One `#SBATCH` field surfaced in the directive form. `key` is always the LONG
 *  form (`job-name`), even when the file wrote the short flag (`-J`). */
export interface SbatchField {
  key: string;
  value: string;
}

/** The keys the directive form surfaces as labeled fields, in display order. */
export const COMMON_SBATCH_KEYS = [
  "job-name",
  "account",
  "partition",
  "time",
  "nodes",
  "ntasks",
  "cpus-per-task",
  "mem",
  "gres",
  "output",
] as const;

/** Short `sbatch` flags → their long equivalents, so `-t`/`--time` fold into one
 *  field in the form. Only the flags the form surfaces need an entry. */
const SHORT_TO_LONG: Record<string, string> = {
  J: "job-name",
  A: "account",
  p: "partition",
  t: "time",
  N: "nodes",
  n: "ntasks",
  c: "cpus-per-task",
  o: "output",
  e: "error",
};

/** A `#SBATCH` directive line, matched leniently: optional leading space, `#SBATCH`
 *  (case-insensitive), the flag, then `=value` or ` value`. `#SBATCH` with no flag
 *  (a comment) doesn't match. */
const SBATCH_RE = /^\s*#\s*SBATCH\s+(--?[A-Za-z][\w-]*)(?:[=\s]+(.*))?$/;

/** True when `text` looks like a SLURM batch script: it carries at least one
 *  `#SBATCH` directive line (the only reliable marker — a `.slurm` extension is
 *  neither required nor sufficient, and a plain shell script has none). */
export function isSlurmScript(text: string): boolean {
  return text.split("\n").some((l) => SBATCH_RE.test(l));
}

/** Normalize a matched flag token (`--time`, `-t`) to its long key (`time`). */
function normalizeKey(flag: string): string {
  if (flag.startsWith("--")) return flag.slice(2);
  const short = flag.slice(1);
  return SHORT_TO_LONG[short] ?? short;
}

/** Every `#SBATCH` directive present in the script, long-key-normalized. A flag
 *  with no value (a boolean like `--exclusive`) yields an empty string value. */
export function parseSbatchDirectives(text: string): SbatchField[] {
  const out: SbatchField[] = [];
  for (const line of text.split("\n")) {
    const m = SBATCH_RE.exec(line);
    if (!m) continue;
    out.push({ key: normalizeKey(m[1]), value: (m[2] ?? "").trim() });
  }
  return out;
}

/** The current value of `key` among parsed directives, or `""` when absent. */
export function directiveValue(fields: SbatchField[], key: string): string {
  return fields.find((f) => f.key === key)?.value ?? "";
}

/**
 * Edit the script's `#SBATCH` lines so that `key` reads `value` — by SPLICING the
 * text, never re-serializing (the view-on-text bargain: every untouched byte, and
 * the whole rest of the script, is preserved). Three cases:
 *  - **present** → its value is replaced in place (matching the flag form the file
 *    used, long or short);
 *  - **absent + non-empty** → a new `#SBATCH --key=value` line is inserted after
 *    the last existing directive (or after the shebang, else at the top);
 *  - **empty value** → the directive line is removed (a way to clear a field).
 */
export function spliceDirective(text: string, key: string, value: string): string {
  const lines = text.split("\n");
  const v = value.trim();

  // Find an existing directive for this key (matched on the normalized long key).
  let lastDirective = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = SBATCH_RE.exec(lines[i]);
    if (!m) continue;
    lastDirective = i;
    if (normalizeKey(m[1]) !== key) continue;
    // Matched: rewrite (or delete) this line.
    if (v === "") {
      lines.splice(i, 1);
      return lines.join("\n");
    }
    const flag = m[1]; // keep the flag spelling the file already used
    const sep = flag.startsWith("--") ? "=" : " ";
    // Preserve any leading indentation the author had.
    const indent = lines[i].match(/^\s*/)?.[0] ?? "";
    lines[i] = `${indent}#SBATCH ${flag}${sep}${v}`;
    return lines.join("\n");
  }

  if (v === "") return text; // nothing to clear

  // Absent: insert a new directive. Prefer just after the last existing #SBATCH so
  // directives stay grouped; else after a shebang; else at the very top.
  const newLine = `#SBATCH --${key}=${v}`;
  if (lastDirective >= 0) {
    lines.splice(lastDirective + 1, 0, newLine);
  } else if (lines[0]?.startsWith("#!")) {
    lines.splice(1, 0, newLine);
  } else {
    lines.splice(0, 0, newLine);
  }
  return lines.join("\n");
}

// ── Tab glue (the log window + the interactive shell) ────────────────────────

/** Where a run tab is inserted (see `pythonRun.PyTabPlacer`): a placer OWNS
 *  insertion, returning the created entry for a main-store activate, or null when
 *  it streamed the tab into a detached popout. */
export type SlurmTabPlacer = (tab: Omit<TabEntry, "key">) => TabEntry | null;

/** The tab `location` for `hostId`: `undefined` for a local project (everything is
 *  local), `"remote"` for the primary of a remote project, `host:<id>` for a
 *  worker — the same axis a tab's locality badge sets, carried verbatim. */
export function locationForHost(hostId: string, isRemote: boolean): TabLocation | undefined {
  if (!isRemote) return undefined;
  return hostId === "primary" ? "remote" : `host:${hostId}`;
}

/** Open a shell tab running `initialInput`, placed like a Python run tab. */
function openHostShellTab(opts: {
  scope: string;
  label: string;
  cwd: string;
  location: TabLocation | undefined;
  initialInput: string;
  /** Never tmux-wrap this tab — see `TabEntry.ephemeral`. */
  ephemeral?: boolean;
  place?: SlurmTabPlacer;
}): void {
  const tab: Omit<TabEntry, "key"> = {
    label: opts.label,
    cmd: "", // the host's default shell
    cwd: opts.cwd,
    kind: "shell",
    initialInput: opts.initialInput,
    ...(opts.location ? { location: opts.location } : {}),
    ...(opts.ephemeral ? { ephemeral: true } : {}),
  };
  if (opts.place) {
    const entry = opts.place(tab);
    if (entry) useTabsStore.getState().setActive(entry.key);
    return;
  }
  const entry = useTabsStore.getState().addTabToScope(opts.scope, tab);
  useTabsStore.getState().setActive(entry.key);
}

/** The command that tails a job's log: `tail -n +1 -F <out>` follows by name and
 *  retries, so it waits out the queue (the file doesn't exist until the job runs)
 *  and streams from the top once it appears. */
export function buildTailCommand(outFile: string): string {
  return `tail -n +1 -F ${shellQuote(outFile, "unix")}`;
}

/** Open a log tab tailing `outFile` on `hostId`. Used by Submit and by the Jobs
 *  view's Watch. */
export function openLogTab(opts: {
  scope: string;
  projectDir: string;
  outFile: string;
  jobLabel: string;
  hostId: string;
  isRemote: boolean;
  place?: SlurmTabPlacer;
}): void {
  openHostShellTab({
    scope: opts.scope,
    label: translate(useI18nStore.getState().lang, "slurm.logTabLabel", { job: opts.jobLabel }),
    cwd: opts.projectDir,
    location: locationForHost(opts.hostId, opts.isRemote),
    initialInput: buildTailCommand(opts.outFile),
    // A `tail -F` is re-openable from the Jobs view at any time, so persisting it
    // buys nothing — and on a cluster login node it costs the one thing the HPC
    // tag exists to prevent: a tmux daemon still running there after Tabtivity quits,
    // which nothing in the UI would then be pointing at. The job itself is
    // untouched; it is SLURM's, not this tab's.
    ephemeral: logTabIsEphemeral(opts.scope, opts.hostId),
    place: opts.place,
  });
}

/** Whether a log tab on this host must not outlive itself: true iff the host is
 *  tagged HPC. Resolved here rather than at the call sites because both of them
 *  (Submit and the Jobs view's Watch) already hand us the scope and host id. */
function logTabIsEphemeral(scope: string, hostId: string): boolean {
  const settings = useSettingsStore.getState().settings;
  const project = useProjectsStore.getState().projects.find((p) => p.id === scope);
  if (!project) return false;
  const spec =
    hostId === "primary"
      ? project.remote
      : (project.compute_hosts ?? []).find((h) => h.id === hostId);
  return isHpcHost(settings, targetOfSpec(spec));
}

/**
 * Submit `file` (its absolute host/local path) with `sbatch`, open a log tab
 * tailing the job's output, and record the job in the session store so the Jobs
 * view shows it immediately. Returns the recorded job.
 */
export async function submitSlurmJob(opts: {
  /** Absolute path of the `.slurm` file (the viewer's path). */
  file: string;
  /** The backend project-dir key (the project's stored `directory`). */
  projectDir: string;
  /** cwd for the log tab (the project root). */
  cwd: string;
  /** Owning project id, for the Jobs store. */
  projectId: string;
  /** The tab scope (project id, or "root"). */
  scope: string;
  /** Host to submit on; defaults to the primary. */
  host?: string;
  /** Whether the project is remote (decides the tab's locality). */
  isRemote: boolean;
  place?: SlurmTabPlacer;
}): Promise<HpcJob> {
  const host = opts.host ?? "primary";
  const res = await invoke<SlurmSubmit>("slurm_submit", {
    projectDir: opts.projectDir,
    scriptRel: opts.file,
    hostId: host,
  });
  const name = basename(opts.file);
  const job: HpcJob = {
    jobId: res.job_id,
    name,
    outFile: res.out_file,
    host,
    submittedAt: Date.now(),
  };
  useHpcJobsStore.getState().add(opts.projectId, job);
  openLogTab({
    scope: opts.scope,
    projectDir: opts.cwd,
    outFile: res.out_file,
    jobLabel: `${res.job_id} ${name}`,
    hostId: host,
    isRemote: opts.isRemote,
    place: opts.place,
  });
  return job;
}

/** Resources for an interactive `srun --pty` session. All optional; only the set
 *  ones are passed. */
export interface InteractiveResources {
  time?: string;
  cpus?: string;
  mem?: string;
  gpus?: string;
  partition?: string;
  /** SLURM account (`--account`). Mandatory on group-allocated clusters, where
   *  an interactive `srun` with no account is rejected. */
  account?: string;
}

/** Build the `srun --pty … bash -l` command that lands an interactive shell on a
 *  compute node (the compliant interactive path — never the login node). */
export function buildInteractiveCommand(res: InteractiveResources): string {
  const parts = ["srun", "--pty"];
  if (res.account?.trim()) parts.push(`--account=${res.account.trim()}`);
  if (res.partition?.trim()) parts.push(`--partition=${res.partition.trim()}`);
  if (res.time?.trim()) parts.push(`--time=${res.time.trim()}`);
  if (res.cpus?.trim()) parts.push(`--cpus-per-task=${res.cpus.trim()}`);
  if (res.mem?.trim()) parts.push(`--mem=${res.mem.trim()}`);
  if (res.gpus?.trim()) parts.push(`--gpus=${res.gpus.trim()}`);
  parts.push("bash", "-l");
  return parts.join(" ");
}

/** Open an interactive compute-node shell (`srun --pty …`) as a terminal tab. */
export function openInteractiveJob(opts: {
  scope: string;
  cwd: string;
  res: InteractiveResources;
  hostId: string;
  isRemote: boolean;
  place?: SlurmTabPlacer;
}): void {
  openHostShellTab({
    scope: opts.scope,
    label: translate(useI18nStore.getState().lang, "slurm.srunTabLabel"),
    cwd: opts.cwd,
    location: locationForHost(opts.hostId, opts.isRemote),
    initialInput: buildInteractiveCommand(opts.res),
    place: opts.place,
  });
}
