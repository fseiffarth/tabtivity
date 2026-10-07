import { relativePathWithin } from "../paths";
import { shellQuote as quoteFor } from "./pythonRun";
import { isRemoteLocation, type TabLocation } from "../../stores/tabs";
import type { ProjectEntry } from "../../types";

export type ScriptShell = "bash" | "zsh" | "fish" | "ksh" | "powershell" | "cmd";

export interface ShellScriptRunPlan {
  cwd: string;
  scriptRel: string;
  initialInput: string;
  location?: TabLocation;
}

/** POSIX single-quoting; the Windows interpreters quote through
 *  `pythonRun.shellQuote(…, "windows")` in {@link shellRunCommand}. */
export function shellQuote(value: string): string {
  return quoteFor(value, "unix");
}

/** Which interpreter runs a script of this extension, keyed by lowercased ending.
 *  The cross-platform shells run everywhere; `.ps1`/`.bat`/`.cmd` are Windows-only
 *  here (`pwsh` on Linux is too rarely installed to advertise the action). Returns
 *  null for an ending we don't know how to run, so no Run button is offered. */
export function shellRunnerFor(
  extension: string | null,
  platform: "windows" | string,
): ScriptShell | null {
  const ext = (extension ?? "").toLowerCase();
  const win = platform === "windows";
  switch (ext) {
    case ".sh":
    case ".bash":
      return "bash";
    case ".zsh":
      return "zsh";
    case ".fish":
      return "fish";
    case ".ksh":
      return "ksh";
    case ".ps1":
      return win ? "powershell" : null;
    case ".bat":
    case ".cmd":
      return win ? "cmd" : null;
    default:
      return null;
  }
}

/** The command line that runs `scriptRel` under `interp`. PowerShell and cmd take
 *  a flag before the path; the POSIX shells take it as a bare argument. The two
 *  Windows interpreters only ever run on Windows (`shellRunnerFor`), whose shells
 *  know no `'…'`, so they get `"…"` quoting; the POSIX shells keep `'…'`.
 *
 *  `args` (set from the ▶ button's right-click popover) is appended **verbatim**,
 *  only trimmed — the Python Run's `buildRunCommand` rule: it is a raw string for
 *  the tab's own shell to parse, so quotes and `$VARS` work as typed. */
export function shellRunCommand(interp: ScriptShell, scriptRel: string, args?: string): string {
  const windows = interp === "powershell" || interp === "cmd";
  const quoted = quoteFor(scriptRel, windows ? "windows" : "unix");
  const base =
    interp === "powershell"
      ? `powershell -File ${quoted}`
      : interp === "cmd"
        ? `cmd /c ${quoted}`
        : `${interp} ${quoted}`;
  const extra = args?.trim();
  return extra ? `${base} ${extra}` : base;
}

export function scriptRelFromRoot(root: string, absPath: string): string | null {
  const rel = relativePathWithin(root, absPath);
  return rel && rel.trim() ? rel : null;
}

/** Build the foreground terminal-tab run for a shell script from the tree side the
 *  user is browsing. Mount-free remote listings return host paths, while the
 *  tree's `projectDir` is the local state dir; using that dir to relativize a
 *  host path produced `bash ''`. Use the host `remote_path` for remote-source
 *  rows to compute the script's project-relative path.
 *
 *  WHERE the script runs follows the same dominance rule as the Python Run beside
 *  it (`pythonRunPlan`, which carries the full reasoning): **the browsed side
 *  decides, and the run-host preference cannot overrule it.** A script browsed on
 *  the Local mirror runs in a local shell, full stop; the preference (the machine
 *  chosen in the `RunHostPicker`, persisted per project and therefore usually set
 *  from some earlier session) only picks *which* remote machine a host-side script
 *  runs on. `scriptRel` is project-relative either way, so it resolves against the
 *  chosen host's own project root (the backend re-cds into the target host's
 *  `remote_path`) or the local mirror, whichever the run location names — the two
 *  sides mirror the same tree. */
export function shellScriptRunPlan(opts: {
  project: ProjectEntry | null | undefined;
  treeRoot: string;
  syncSource?: "remote" | "local";
  scriptPath: string;
  interp: ScriptShell;
  /** The project's run-host preference (`useRunHostPrefStore`), if any. */
  runHostPref?: TabLocation;
  /** Arguments appended to the command line (see `shellRunCommand`). */
  args?: string;
}): ShellScriptRunPlan | null {
  const remote = opts.project?.remote;
  const isRemoteProject = !!remote;
  // Which side the clicked script is on. The PATH decides, exactly as it does for
  // a Python run (`pythonRun`'s `fileSideLocation`) — a host path and a mirror path
  // never coincide, so this is a fact rather than a prop that has to be threaded
  // correctly through five components to be true. `syncSource` is only the
  // tie-breaker for a path under neither root.
  const underHost =
    !!remote && relativePathWithin(remote.remote_path, opts.scriptPath) !== null;
  const underLocal = relativePathWithin(opts.treeRoot, opts.scriptPath) !== null;
  const browsedRemote =
    isRemoteProject && (underHost || (!underLocal && opts.syncSource !== "local"));
  // The script's project-relative path, computed from the side it was browsed on
  // (that is the side `scriptPath` belongs to).
  const browsedRoot = browsedRemote ? remote.remote_path : opts.treeRoot;
  const scriptRel = scriptRelFromRoot(browsedRoot, opts.scriptPath);
  if (!scriptRel) return null;
  // The run location: the browsed side decides; the preference only chooses among
  // the remote machines for a host-side script.
  const location: TabLocation | undefined = !isRemoteProject
    ? undefined
    : browsedRemote
      ? (opts.runHostPref ?? "remote")
      : "local";
  // The tab cwd must match the run side so `scriptRel` resolves: the host project
  // root for a remote run (the backend re-cds into the *target* host's remote_path
  // anyway), the local mirror for a local run.
  const runsRemote = location ? isRemoteLocation(location) : false;
  const cwd = runsRemote && remote ? remote.remote_path : opts.treeRoot;
  return {
    cwd,
    scriptRel,
    initialInput: shellRunCommand(opts.interp, scriptRel, opts.args),
    location,
  };
}
