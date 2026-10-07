/**
 * Run and debug a Python file from the native code viewer (#py).
 *
 * Both buttons do the same structural thing: open a **terminal tab** in the
 * project and type a command into it. That is deliberate, and it is what makes
 * the feature work everywhere Tabtivity already works, for free — a shell tab on a
 * remote (SSH) project runs on the host, and one on a containerised project runs
 * inside the container, because the tab is the thing that carries locality and
 * sandboxing. A bespoke "run" IPC path would have to re-derive both and would get
 * them wrong.
 *
 * The one thing a fresh tab cannot inherit is *which* machine, because it has no
 * predecessor to inherit from — a new shell tab defaults to the host. So the tab
 * is given an explicit locality, resolved by {@link pythonRunPlan}: the run-host
 * preference when the project has one, else the side the file itself lives on.
 *
 * It also means the process is a *visible, interactive terminal*: a script that
 * prompts for input works, Ctrl+C works, and the shell survives the program's
 * exit so the output (and the traceback) stays on screen and ↑ re-runs it. This
 * is the same one-click-open-a-tab-and-run policy as `installCommand.ts`.
 *
 * Debugging is pdb, driven from the gutter's breakpoints: they are handed to it
 * as `-c "b file:N"` commands, followed by `-c continue` so the session runs
 * straight to the first one instead of halting on line 1. With no breakpoints set
 * we omit the `continue` and let pdb stop at the top of the file, which is the
 * only sensible reading of "debug this with no breakpoints".
 */

import { invoke } from "@tauri-apps/api/core";
import { basename, dirname, relativePathWithin } from "../paths";
import { IS_WINDOWS } from "../platform";
import { useTabsStore, isRemoteLocation, type TabEntry, type TabLocation } from "../../stores/tabs";
import { guardLoginNodeRun } from "../remote/hpc/hpcGuard";
import { translate, useI18nStore } from "../i18n";
import { envName } from "../brand";

/** How a run/debug tab is inserted into the layout. Given the built (keyless)
 *  tab, place it and return the created entry — or null when it streamed the tab
 *  elsewhere (a detached popout owns its own tabs), so the caller does nothing.
 *  The default (no placer) opens in the owning project's focused subwindow; a
 *  placer is supplied only to stream into a popout. See {@link placeForFocused}. */
export type PyTabPlacer = (tab: Omit<TabEntry, "key">) => TabEntry | null;

export type PyPlatform = "windows" | "unix";

/** The env vars that mark a terminal tab as a viewer-launched run/debug of a
 *  specific file. They are real env vars (the process can see them), and they are
 *  also how a re-run finds the tab it should replace — a tab has no free-form
 *  metadata, and matching on the label would collide across two `main.py`s in
 *  different directories. */
export const PY_TARGET_ENV = envName("PY_TARGET");
export const PY_MODE_ENV = envName("PY_MODE");

export type PyRunMode = "run" | "debug";

/** Quote one shell argument. `cmd.exe` (Windows' default shell, via COMSPEC) has
 *  no single-quote syntax, so the two platforms genuinely differ. */
export function shellQuote(arg: string, platform: PyPlatform): string {
  if (platform === "windows") return `"${arg.replace(/"/g, '""')}"`;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** The last-resort interpreter when the backend can't be reached at all. */
export function systemInterpreter(platform: PyPlatform): string {
  return platform === "windows" ? "python" : "python3";
}

/** `<interp> <file> [args]` — the Run button's command line.
 *
 * `args` is appended **verbatim** (only trimmed), not shell-quoted: it is a raw
 * argument string the user typed to be parsed by the host shell, so `main.py`
 * plus `--epochs 5 "out dir"` runs with two real arguments. The tab is a real
 * terminal (see the module header), so this is the natural place to type them. */
export function buildRunCommand(
  interp: string,
  file: string,
  platform: PyPlatform,
  args?: string,
): string {
  const base = `${shellQuote(interp, platform)} ${shellQuote(file, platform)}`;
  const extra = args?.trim();
  return extra ? `${base} ${extra}` : base;
}

/**
 * The Debug button's command line: pdb, pre-loaded with the gutter's breakpoints.
 *
 * `python -m pdb -c "b f.py:12" -c continue f.py` sets the breakpoints before the
 * script starts and then runs to the first one. Without breakpoints the trailing
 * `continue` is omitted — otherwise pdb would run the program to completion and
 * "debug" would be indistinguishable from "run".
 */
export function buildDebugCommand(
  interp: string,
  file: string,
  breakpoints: number[],
  platform: PyPlatform,
  args?: string,
): string {
  const parts = [shellQuote(interp, platform), "-m", "pdb"];
  const sorted = [...new Set(breakpoints)].sort((a, b) => a - b);
  for (const line of sorted) {
    parts.push("-c", shellQuote(`b ${file}:${line}`, platform));
  }
  if (sorted.length > 0) parts.push("-c", shellQuote("continue", platform));
  parts.push(shellQuote(file, platform));
  // Script arguments follow the file, exactly as `python -m pdb script.py args…`
  // expects them. Appended verbatim (see buildRunCommand) — pdb hands them to the
  // debugged program's `sys.argv`.
  const extra = args?.trim();
  if (extra) parts.push(extra);
  return parts.join(" ");
}

/** One interpreter the project could run — what `python_interpreters` offers the
 *  picker. `kind` is `venv|poetry|conda|pyenv|active|system`. */
export interface PyInterpreter {
  kind: string;
  path: string;
  label: string;
}

/** Every interpreter this project could use (the picker's list). Probes the HOST
 *  for a remote project — that is the machine the run tab will run on. */
export function listInterpreters(projectDir: string): Promise<PyInterpreter[]> {
  return invoke<PyInterpreter[]>("python_interpreters", { projectDir });
}

/** Pin the project's interpreter (or clear it back to auto-detect with `null`). */
export function setProjectPython(
  projectId: string,
  interpreter: string | null,
): Promise<string | null> {
  return invoke<string | null>("set_project_python", { projectId, interpreter });
}

/**
 * The interpreter to run with, right now.
 *
 * The backend owns the precedence (`commands::python`) — the project's pinned
 * choice if it has one, else the best auto-detected environment (in-tree venv →
 * poetry → active `VIRTUAL_ENV`/`CONDA_PREFIX` → pyenv → system). Deliberately not
 * re-implemented here: two rankings that can disagree is a bug waiting to happen,
 * and only the backend can see conda/poetry at all.
 */
export async function resolveInterpreter(
  projectId: string | null,
  projectDir: string,
  platform: PyPlatform,
): Promise<string> {
  try {
    return await invoke<string>("python_interpreter_for", { projectId, projectDir });
  } catch {
    // A disconnected/unreadable project is not a reason to refuse to run: fall
    // back to the system interpreter and let the terminal report the truth.
    return systemInterpreter(platform);
  }
}

/** The host's quoting family, from the one OS detector (`lib/platform`). */
export function currentPlatform(): PyPlatform {
  return IS_WINDOWS ? "windows" : "unix";
}

/**
 * Which side of a remote project an absolute path lives on — and therefore where
 * a Run of it lands when the project has no run-host preference.
 *
 * The **path itself** is the ground truth, not the file view's Remote/Local
 * switch: a code-editor tab has no switch of its own (and can outlive the folder
 * it was opened from), while a host path and a mirror path never coincide. The
 * test is deliberately one-sided — only a path *under the host root* is treated as
 * remote — because the failure it exists to prevent is sending a path we cannot
 * prove is the host's to a shell on the host, where it either fails or, worse,
 * names a different file that happens to exist there.
 *
 * `null`/blank `remotePath` (a local project) has no machine axis at all.
 */
export function fileSideLocation(
  file: string,
  remotePath?: string | null,
): TabLocation | undefined {
  const root = remotePath?.trim();
  if (!root) return undefined;
  return relativePathWithin(root, file) !== null ? "remote" : "local";
}

/** Where a Python Run/Debug of one file lands, and what it has to say to get there. */
export interface PyRunPlan {
  /** The tab's locality. Undefined on a local project (the axis is inert). */
  location?: TabLocation;
  /** The tab's cwd, on the machine the run lands on. */
  cwd: string;
  /** The path to put on the command line: the clicked absolute path when the run
   *  stays on the file's own side, else the project-relative path (see below). */
  runPath: string;
  /** The directory to resolve the interpreter against — the backend's remoteness
   *  oracle is the *directory*, so this decides whether it probes the host or the
   *  local machine (`commands::python`). */
  probeDir: string;
}

/**
 * Resolve a Python Run/Debug to a machine, a cwd and a path — the twin of
 * `shellScriptRunPlan`, and for the same reason: the ▶ on a `.py` row and the ▶ on
 * a `.sh` row sit in the same file view and must not disagree about where they
 * run.
 *
 * **The side the file is on decides, and the run-host preference cannot overrule
 * it.** A file on the local mirror runs locally — full stop. The preference picks
 * *which machine* among the remote ones (primary or a worker) for a file that
 * lives on the host, and that is the only question it answers; it is not offered
 * at all on the Local side, because there is only one local machine.
 *
 * That asymmetry is the whole point. The preference is **persisted per project**
 * (`project.json`'s `run_host`), so it is normally set — and letting a choice made
 * weeks ago while browsing the host silently redirect a Run of a *local* file to
 * that host is the bug this function exists to prevent. Switching the file view to
 * Local is a statement about this click; the stored preference is not.
 *
 * The one crossing that remains is deliberate and explicit: picking ⌂ Local from
 * the picker while browsing the host. The clicked absolute path then names a file
 * on the *other* machine, so it is re-expressed project-relative and resolved
 * against the run side's own root (the two sides mirror the same tree, so it is
 * the same file). A path under neither root — a file opened outside the project —
 * is passed through untouched and the shell reports the truth.
 */
export function pythonRunPlan(opts: {
  /** The project's canonical directory (`resolveProjectDirectory`) — the value the
   *  backend matches against `projects.json` to decide remoteness. */
  projectDir: string;
  /** The project's host root (`remote.remote_path`); absent for a local project. */
  remotePath?: string | null;
  /** The local root the project's files mirror to: the mirror root on a remote
   *  project, the project directory on a local one. */
  localRoot?: string | null;
  /** Absolute path of the file to run, on whichever side it was browsed. */
  file: string;
  /** The project's run-host preference (`useRunHostPrefStore`), if any. */
  runHostPref?: TabLocation;
}): PyRunPlan {
  const { file } = opts;
  const remotePath = opts.remotePath?.trim() || null;
  const projectCwd = runCwd(opts.projectDir, file);
  if (!remotePath) {
    return { location: undefined, cwd: projectCwd, runPath: file, probeDir: projectCwd };
  }
  const localRoot = opts.localRoot?.trim() || projectCwd;
  const fileSide = fileSideLocation(file, remotePath) ?? "local";
  // A local-mirror file runs in a LOCAL shell, whatever machine the preference
  // names — see the dominance rule above. Only a host-side file asks the
  // preference, and only to choose between the remote machines (or ⌂ Local).
  const location: TabLocation =
    fileSide === "local" ? "local" : (opts.runHostPref ?? "remote");
  const runsRemote = isRemoteLocation(location);
  // The cwd must match the run side so a relative `runPath` resolves. A local run
  // on a remote project is re-cwd'd into the mirror by `localTabCwd` anyway; a
  // remote one lands in the target host's own project root.
  const cwd = runsRemote ? remotePath : localRoot;
  // The interpreter is probed on the machine that will run the file — a host venv
  // is not on the local mirror, and vice versa. The backend resolves remoteness
  // from the directory, so the local side deliberately passes the mirror root
  // (which matches no `projects.json` entry) rather than the project directory.
  const probeDir = runsRemote ? opts.projectDir : localRoot;
  if (runsRemote === (fileSide === "remote")) {
    return { location, cwd, runPath: file, probeDir };
  }
  const rel = relativePathWithin(runsRemote ? localRoot : remotePath, file);
  return { location, cwd, runPath: rel && rel.trim() ? rel : file, probeDir };
}

/** The label a run/debug tab carries: the file's name, and debug named in
 *  words, not a 🐞 emoji. No typed ▶ — a popout's WebKitGTK drew it as the
 *  colour emoji despite the U+FE0E pin, in the tab and in its hover card. That
 *  the run is going is the strip's drawn status mark (`TabStatusMark`). */
export function pyTabLabel(mode: PyRunMode, file: string): string {
  return mode === "debug"
    ? translate(useI18nStore.getState().lang, "pythonRun.debugTabLabel", { file: basename(file) })
    : basename(file);
}

/**
 * Open a terminal tab running `command` for `file`, replacing the previous
 * run/debug tab for that same file and mode.
 *
 * Replacing rather than reusing is the deliberate choice: re-typing the command
 * into a *live* tab would send it to whatever is already running there (a pdb
 * prompt, or a script blocked on input) instead of to a shell. Closing the old
 * tab kills that PTY, so every run starts from a known-clean process.
 */
export function openPythonTab(opts: {
  mode: PyRunMode;
  /** The file's own (browsed) absolute path — the tab's IDENTITY, not what it
   *  runs: a cross-side run puts `plan.runPath` on the command line instead. */
  file: string;
  /** Where the run lands (`pythonRunPlan`) — the machine, the cwd on it. */
  plan: PyRunPlan;
  /** The scope owning the tab: the project's id, or "root". Only used by the
   *  default placement (when no `place` is supplied). */
  scope: string;
  command: string;
  /** Where to insert the tab. Supplied only to stream the run into a detached
   *  popout; when absent (the normal case) the tab lands in the owning project's
   *  focused subwindow via `addTabToScope`. See {@link placeForFocused}. */
  place?: PyTabPlacer;
}): void {
  const { mode, file, plan, scope, command, place } = opts;
  const store = useTabsStore.getState();

  // The owning scope's list, not the active one's: a run from the root console
  // replaces the console's previous run tab, not a same-named one in a project.
  const prior = (store.tabsByScope?.[scope] ?? store.tabs).find(
    (t) =>
      t.kind === "shell" &&
      t.env?.[PY_TARGET_ENV] === file &&
      t.env?.[PY_MODE_ENV] === mode,
  );
  if (prior) store.removeTab(prior.key);

  // Which machine to run on is `pythonRunPlan`'s answer and nothing else's — the
  // project's run-host preference (set from the file viewer's `RunHostPicker`)
  // when there is one, else the side the file lives on. It must be set EXPLICITLY
  // even for "local", because a shell tab's per-kind default is *remote* (see
  // `defaultLocationForKind`): leaving it off is what used to send a run of a
  // local-mirror file to the host. A pref naming a since-removed worker is
  // harmless — CenterPanel/`wrap_pty_options` fall the tab back to the primary.
  const tab: Omit<TabEntry, "key"> = {
    label: pyTabLabel(mode, file),
    cmd: "", // the host's default shell
    cwd: plan.cwd,
    kind: "shell",
    env: { [PY_TARGET_ENV]: file, [PY_MODE_ENV]: mode },
    initialInput: command,
    runFile: file,
    ...(plan.location ? { location: plan.location } : {}),
  };
  // A placer OWNS insertion. It returns the created entry for a main-window store
  // write (which we then activate), or null when it streamed the tab elsewhere (a
  // detached popout, which owns its own tabs) — in which case there's nothing in
  // this store to activate. Only with NO placer do we use the default scope group.
  if (place) {
    const entry = place(tab);
    if (entry) useTabsStore.getState().setActive(entry.key);
    return;
  }
  const entry = useTabsStore.getState().addTabToScope(scope, tab);
  useTabsStore.getState().setActive(entry.key);
}

/** The login-node gate for a Python run/debug, on the machine the plan resolved.
 *  Returns whether to go ahead; `false` means the user backed out or took an
 *  interactive job instead. */
async function guardRunHost(plan: PyRunPlan, projectId: string | null): Promise<boolean> {
  return guardLoginNodeRun({ projectId, location: plan.location, kind: "login-node-run" });
}

/** Run `file` in a fresh terminal tab. */
export async function runPythonFile(opts: {
  file: string;
  /** Where this run lands — build it with {@link pythonRunPlan}. */
  plan: PyRunPlan;
  scope: string;
  /** The project whose pinned interpreter applies; null in the root scope. */
  projectId: string | null;
  /** Raw argument string appended after the file (see buildRunCommand). */
  args?: string;
  /** Where to insert the run tab (see openPythonTab); defaults to the scope group. */
  place?: PyTabPlacer;
}): Promise<void> {
  // If the machine the plan names is a tagged cluster login node, ask before
  // computing there (`lib/remote/hpc/hpcGuard.ts`). Untagged hosts and local runs never see this.
  if (!(await guardRunHost(opts.plan, opts.projectId))) return;
  const platform = currentPlatform();
  const interp = await resolveInterpreter(opts.projectId, opts.plan.probeDir, platform);
  openPythonTab({
    mode: "run",
    file: opts.file,
    plan: opts.plan,
    scope: opts.scope,
    command: buildRunCommand(interp, opts.plan.runPath, platform, opts.args),
    place: opts.place,
  });
}

/** Debug `file` under pdb, breaking on `breakpoints` (1-based lines). */
export async function debugPythonFile(opts: {
  file: string;
  plan: PyRunPlan;
  scope: string;
  projectId: string | null;
  breakpoints: number[];
  /** Raw argument string appended after the file (see buildDebugCommand). */
  args?: string;
  /** Where to insert the debug tab (see openPythonTab); defaults to the scope group. */
  place?: PyTabPlacer;
}): Promise<void> {
  if (!(await guardRunHost(opts.plan, opts.projectId))) return;
  const platform = currentPlatform();
  const interp = await resolveInterpreter(opts.projectId, opts.plan.probeDir, platform);
  openPythonTab({
    mode: "debug",
    file: opts.file,
    plan: opts.plan,
    scope: opts.scope,
    // pdb's `b <file>:<line>` takes the same path the run does — relative to the
    // tab's cwd on a cross-side run, which is the project root there.
    command: buildDebugCommand(interp, opts.plan.runPath, opts.breakpoints, platform, opts.args),
    place: opts.place,
  });
}

/** The project root to run from: the project's directory when the viewer has one,
 *  else the file's own directory (a file opened in the root scope). */
export function runCwd(projectDir: string | null | undefined, file: string): string {
  return projectDir && projectDir.trim() ? projectDir : dirname(file) || "/";
}

/**
 * The placer for the "Run opens in the focused subwindow" policy — where every
 * viewer (the side-panel tree, the Files (Project) tab, and a code editor tab)
 * sends its run/debug terminal.
 *
 * Inside a detached popout (`fileDrop` non-null) the main tab store isn't ours, so
 * the tab must stream into THAT window via its controller (returns null so no
 * main-store activate happens). Otherwise it returns `undefined`, which tells
 * {@link openPythonTab} to use its default placement: `addTabToScope(scope, …)` —
 * the focused subwindow of the project that owns the file. That is deliberately
 * NOT "beside the tab you clicked from": a Run always lands where the user is
 * looking, not in whichever subwindow happens to host the trigger.
 */
export function placeForFocused(
  fileDrop: { openTab: (tab: Omit<TabEntry, "key">) => void } | null,
): PyTabPlacer | undefined {
  if (!fileDrop) return undefined;
  return (tab) => {
    fileDrop.openTab(tab);
    return null;
  };
}
