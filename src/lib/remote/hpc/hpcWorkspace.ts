/**
 * HPC **workspaces** — the step that has to happen *before* any data reaches a
 * cluster (`docs/quirky-knitting-umbrella` plan, Phase C; backend
 * `commands::hpc_ws`).
 *
 * On a cluster `$HOME` is a small, quota'd filesystem meant for code, and the
 * bulk data of a computation belongs on the big parallel filesystem — handed out
 * by the `hpc-workspace` tooling as a **workspace**: a directory with a name, a
 * duration, and an expiry after which it is *deleted* (`ws_allocate <name>
 * <days>` — a typical site allows up to 90 days and three extensions, offers a
 * general-purpose default location plus a faster SSD one, and removes the data
 * some weeks after expiry). Nothing here is site-specific — the host is asked
 * what it offers.
 *
 * The integration is deliberately *one line of consequence*: the wizard makes the
 * allocated workspace path the project's **remote root**, so every transport
 * Tabtivity already has (SFTP upload, byte-sync, git lockstep, the run tabs) lands on
 * the parallel filesystem instead of `$HOME` with no change of its own. The
 * alternative layout — project in `$HOME`, workspace symlinked in as `data/` — is
 * offered too, but its link is for the *host's* tools: Tabtivity's byte-sync never
 * follows a symlink (`remote_sync::walk_host_files`, guard G3), so host-side files
 * under it are not mirrored. `linkedWorkspaceCaveat` is that sentence, in one
 * place, so both surfaces say it identically.
 *
 * Untested against a real cluster.
 */

import { invoke } from "@tauri-apps/api/core";
import type { HpcInfo, ProjectEntry } from "../../../types";
import type { TranslationKey } from "../../i18n";
import { BRAND } from "../../brand";

export type { HpcInfo };

// ── Backend types (mirror `commands::hpc_ws`) ────────────────────────────────

export interface HpcWsFilesystem {
  name: string;
  default: boolean;
}

export interface HpcWsInfo {
  available: boolean;
  filesystems: HpcWsFilesystem[];
}

export interface HpcWorkspace {
  id: string;
  path: string;
  filesystem?: string;
  /** The tooling's own phrasing, e.g. `"89 days 23 hours"`. */
  remaining?: string;
  remaining_days?: number;
  extensions?: number;
  expiration?: string;
}

/**
 * Where a workspace command runs. **Either** a project (its `projectDir`, riding
 * the pooled ControlMaster exactly as SLURM does) **or** a bare host — because
 * the wizard allocates a workspace *before* the project that will live in it
 * exists. `password` is single-use and never persisted by this path.
 */
export interface HpcWsTarget {
  projectDir?: string;
  hostId?: string;
  user?: string;
  host?: string;
  port?: number;
  password?: string;
}

export interface HpcWsAllocateReq {
  id: string;
  days: number;
  filesystem?: string;
  reminderDays?: number;
  mail?: string;
  group?: string;
  groupReadable?: boolean;
}

// ── Invoke wrappers ──────────────────────────────────────────────────────────

/** Does this host hand out workspaces, and on which filesystems? A plain SSH host
 *  answers `available: false` — the UI hides the step rather than erroring. */
export function wsAvailable(target: HpcWsTarget): Promise<HpcWsInfo> {
  return invoke<HpcWsInfo>("hpc_ws_available", { target });
}

/** The caller's existing workspaces on the host (`ws_list` + `ws_find`). */
export function wsList(target: HpcWsTarget): Promise<HpcWorkspace[]> {
  return invoke<HpcWorkspace[]>("hpc_ws_list", { target });
}

/** Allocate a workspace (`ws_allocate <id> <days>`). */
export function wsAllocate(target: HpcWsTarget, req: HpcWsAllocateReq): Promise<HpcWorkspace> {
  return invoke<HpcWorkspace>("hpc_ws_allocate", { target, req });
}

/** Extend a workspace, spending one of its extensions. The filesystem used at
 *  allocation must be repeated, so pass the workspace's own. */
export function wsExtend(
  target: HpcWsTarget,
  id: string,
  days: number,
  filesystem?: string,
): Promise<HpcWorkspace> {
  return invoke<HpcWorkspace>("hpc_ws_extend", { target, id, days, filesystem });
}

/** Symlink a workspace into a project's remote root as `<linkName>`. Returns the
 *  created link's absolute host path. See `linkedWorkspaceCaveat`. */
export function wsLink(
  projectDir: string,
  workspacePath: string,
  linkName: string,
): Promise<string> {
  return invoke<string>("hpc_ws_link", { projectDir, workspacePath, linkName });
}

// ── Clusters without workspace tooling ───────────────────────────────────────

/** A directory the site itself nominates for bulk data — the `hpc-workspace`-less
 *  cluster's answer to "where does this project go". */
export interface ScratchCandidate {
  /** `env` (a variable the site's profile exports) or `path` (a convention). */
  source: string;
  label: string;
  path: string;
  writable: boolean;
  free_kb?: number;
}

/**
 * Ask a cluster with **no** `ws_allocate` where its big filesystem is. Without
 * this the pipeline would put such a project in the browsed folder — `$HOME` —
 * which is the failure the workspace step exists to prevent. Nothing is assumed
 * about the site: it answers with the variables its own profile exports.
 */
export function scratchCandidates(target: HpcWsTarget): Promise<ScratchCandidate[]> {
  return invoke<ScratchCandidate[]>("hpc_scratch_candidates", { target });
}

/** "1.2 TB free" from the probe's KiB, or `""` when `df` said nothing. Binary
 *  units, matching what a cluster's own tools report. */
export function freeSpaceLabel(kb: number | undefined): string {
  if (kb === undefined || !Number.isFinite(kb)) return "";
  const units = ["KB", "MB", "GB", "TB", "PB"];
  let v = kb;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]} free`;
}

// ── The home anchor + the project's record (Phase 1) ─────────────────────────

/** The per-project folder in the user's cluster home: `logs/`, a `workspace`
 *  symlink, and the append-only `workspaces.txt` record. */
export interface HpcAnchor {
  dir: string;
  logs_dir?: string;
  link?: string;
}

/**
 * Create (idempotently) the home anchor and append a record line naming the
 * workspace. This is the folder that **outlives the workspace**: the logs are the
 * provenance of what was run, the symlink makes an unmemorable site path
 * `cd`-able, and the record carries the workspace *name* — the handle
 * `ws_restore` needs once the directory is gone.
 */
export function wsAnchor(
  target: HpcWsTarget,
  opts: {
    anchorRel: string;
    workspacePath?: string;
    workspaceId?: string;
    projectName: string;
    mirrorPath?: string;
    makeLogs?: boolean;
  },
): Promise<HpcAnchor> {
  return invoke<HpcAnchor>("hpc_ws_anchor", { target, ...opts });
}

/** Persist the project's workspace/anchor record (project.json + the projects.json
 *  entry). Pass `null` to clear it. */
export function setProjectHpc(projectId: string, hpc: HpcInfo | null): Promise<void> {
  return invoke("set_project_hpc", { projectId, hpc });
}

/** Copy the anchor's `logs/` into the local mirror's `logs/`. Returns the count. */
export function pullLogs(projectId: string, logsDir: string): Promise<number> {
  return invoke<number>("hpc_ws_pull_logs", { projectId, logsDir });
}

/** Re-point the project's primary remote root (the expiry escape hatch). The
 *  caller must disconnect/reconnect around it — the pool caches the spec. */
export function moveProjectRoot(projectId: string, newRoot: string): Promise<ProjectEntry> {
  return invoke<ProjectEntry>("hpc_ws_move_root", { projectId, newRoot });
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

/** A target for a project's own host (the Jobs view, an existing project). */
export function wsTargetForProject(projectDir: string, hostId?: string): HpcWsTarget {
  return { projectDir, ...(hostId ? { hostId } : {}) };
}

/** A target for a host with no project yet (the wizard, right after login). The
 *  password is the credential that login authenticated with — the pooled
 *  ControlMaster it left up usually means ssh needs none, but a site without
 *  multiplexing would otherwise prompt where no prompt can be answered. */
export function wsTargetForHost(
  conn: { user?: string | null; host: string; port?: number | null },
  password?: string,
): HpcWsTarget {
  return {
    user: conn.user ?? undefined,
    host: conn.host,
    port: conn.port ?? undefined,
    ...(password ? { password } : {}),
  };
}

/** The site's default workspace filesystem, when it named one. */
export function defaultFilesystem(info: HpcWsInfo | null): string | undefined {
  return info?.filesystems.find((f) => f.default)?.name;
}

/** Where a project created *inside* `ws` would live on the host. */
export function projectPathIn(ws: HpcWorkspace | { path: string }, safeName: string): string {
  const root = ws.path.replace(/\/+$/, "");
  if (!safeName) return root;
  return `${root}/${safeName}`;
}

/** A one-line "89 days left · 3 extensions" summary, built only from the fields
 *  the site actually reported (a version that prints neither yields `""`). */
export function remainingLabel(ws: HpcWorkspace): string {
  const parts: string[] = [];
  if (ws.remaining_days !== undefined) {
    parts.push(`${ws.remaining_days} ${ws.remaining_days === 1 ? "day" : "days"} left`);
  } else if (ws.remaining) {
    parts.push(`${ws.remaining} left`);
  }
  if (ws.extensions !== undefined) {
    parts.push(`${ws.extensions} ${ws.extensions === 1 ? "extension" : "extensions"}`);
  }
  return parts.join(" · ");
}

/** How loudly to say it: a workspace is *deleted* at expiry, so the last week is
 *  a warning and the last two days are urgent. `"none"` when the site reported no
 *  remaining time — silence is better than a colour invented from nothing. */
export function expiryTone(ws: HpcWorkspace): "none" | "ok" | "warn" | "urgent" {
  const d = ws.remaining_days;
  if (d === undefined) return "none";
  if (d <= 2) return "urgent";
  if (d <= 7) return "warn";
  return "ok";
}

/** The default home-anchor location for a project: `tabtivity/<safe-name>`, relative
 *  to the cluster `$HOME` (the backend resolves and validates it there, so no
 *  caller has to know the remote home). */
export function defaultAnchorRel(safeName: string): string {
  const clean = safeName.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return `${BRAND.slug}/${clean || "project"}`;
}

/** The `#SBATCH --output` value that routes a job's log into the home anchor —
 *  where it survives the workspace it was produced in. `%j` is SLURM's job id. */
export function logOutputPattern(logsDir: string): string {
  return `${logsDir.replace(/\/+$/, "")}/slurm-%j.out`;
}

/** Find the project's own workspace in a listing, by the path its root sits in
 *  (the recorded id is checked first — a site can move a workspace's path, but
 *  the name is the handle). `undefined` when the project isn't in one. */
export function findProjectWorkspace(
  list: HpcWorkspace[],
  hpc: HpcInfo | undefined,
  remotePath: string | undefined,
): HpcWorkspace | undefined {
  if (hpc?.workspace_id) {
    const byId = list.find((w) => w.id === hpc.workspace_id);
    if (byId) return byId;
  }
  if (!remotePath) return undefined;
  return list.find((w) => {
    const root = w.path.replace(/\/+$/, "");
    return remotePath === root || remotePath.startsWith(`${root}/`);
  });
}

/** Whether an expiry warning is warranted, and how loud. Mirrors `expiryTone`,
 *  but only for the workspace the project actually lives in — the point at which
 *  expiry stops meaning "some data is deleted" and starts meaning "this project's
 *  host tree is deleted". */
export function shouldWarnExpiry(ws: HpcWorkspace | undefined): boolean {
  if (!ws) return false;
  const tone = expiryTone(ws);
  return tone === "warn" || tone === "urgent";
}

/** The caveat that must accompany every "link the workspace into the project"
 *  affordance — in ONE place so both the wizard and the Jobs view say it the
 *  same way. Tabtivity's byte-sync walks the host tree lstat-typed and skips
 *  symlinks by design, so a linked workspace is reachable to the *host's* tools
 *  (job scripts, `cd`), not to the mirror. */
export const linkedWorkspaceCaveat: TranslationKey = "hpcWorkspace.linkCaveat";
