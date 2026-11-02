/**
 * The TeX Compile of a host-pinned project (a VM or remote-only project,
 * `isHostPinned`; `docs/remote_only_projects_plan.md` D6/F5). Such a project
 * has no local tree for `compile_tex` to build in, so Compile opens a visible
 * shell tab on the project's host running latexmk on the document — the same
 * one-click open-a-tab-and-run pattern as a Python run or a SLURM log tab. A
 * project's `latexmkrc` therefore runs on the host as the login, where the
 * project's agents already run; nothing of the project runs here.
 *
 * The PDF it writes is read back over SFTP like any host file: the viewer that
 * pressed Compile watches its mtime and opens the PDF tab once a build lands,
 * and an open PDF tab reloads on its own mtime poll.
 */
import { basename, relativePathWithin } from "../../paths";
import { useTabsStore, type TabEntry } from "../../../stores/tabs";
import { guardLoginNodeRun } from "../../remote/hpc/hpcGuard";
import { shellQuote, type PyTabPlacer } from "../../terminal/pythonRun";
import { translateNow } from "../../i18n";
import { envName } from "../../brand";

/** Marks a host build tab with the document it builds, so the next Compile of
 *  that document replaces it instead of opening a second one. */
export const TEX_BUILD_ENV = envName("TEX_BUILD");

/** The engines a host build can be asked for: the engine menu offers these on a
 *  host-pinned project, since this machine's `tex_capability` says nothing
 *  about what the host has installed. */
export const HOST_TEX_ENGINES: readonly string[] = ["pdflatex", "lualatex", "xelatex"];

/** latexmk's pdf-mode flag for `engine` — the backend's `latexmk_flag`, so a
 *  host build picks the engine a local one would. Anything else (Auto, an
 *  unknown name) is pdflatex, latexmk's own default. */
export function latexmkEngineFlag(engine: string | null | undefined): string {
  if (engine === "lualatex") return "-pdflua";
  if (engine === "xelatex") return "-pdfxe";
  return "-pdf";
}

/**
 * The argv a host build runs for `texPath` (a host path under `remoteRoot`):
 * `-cd` builds in the file's own folder although a host tab starts at the
 * project root, and the file goes in as `./<rel>` so a name that starts with
 * `-` never reads as a flag. A path outside the root stays absolute (it starts
 * with `/`, which is safe for the same reason).
 */
export function hostTexBuildArgv(texPath: string, remoteRoot: string, engine: string | null | undefined): string[] {
  const rel = relativePathWithin(remoteRoot, texPath);
  return [
    "latexmk",
    "-cd",
    latexmkEngineFlag(engine),
    "-interaction=nonstopmode",
    "-synctex=1",
    rel ? `./${rel}` : texPath,
  ];
}

/** The command line typed into the host shell: every argument single-quoted
 *  (POSIX — a host is never `cmd.exe`), so no file name can splice in syntax. */
export function hostTexBuildCommand(argv: readonly string[]): string {
  return argv.map((a) => shellQuote(a, "unix")).join(" ");
}

/**
 * Open the host build tab for `texPath` in `scope` and make it the active tab.
 *
 * Typed into the host's login shell (`cmd: ""` + `initialInput`) rather than
 * spawned as the tab's own program: a restored shell tab respawns its `cmd`
 * with no arguments, which would run a bare `latexmk` over every `.tex` in the
 * project root on the next launch; a shell comes back as a shell. The output
 * stays readable after the build, and the shell is there for a rerun.
 *
 * The previous build tab of the same document is closed first (as a Python
 * run's is): a second latexmk in the same folder would race the first, and
 * closing the tab ends the old build. Never tmux-wrapped (`ephemeral`): Compile
 * re-runs it at any time, and a replaced tab would otherwise leave its session
 * behind on the host. Asks first on an HPC-tagged host, like every run there.
 * Resolves `false` when the user backed out at that question.
 */
export async function openHostTexBuild(opts: {
  scope: string;
  /** The project's directory (its state dir) — a host tab's nominal cwd; the
   *  spawn runs it at the project root on the host. */
  projectDir: string;
  texPath: string;
  remoteRoot: string;
  engine: string | null | undefined;
  /** Supplied only inside a detached popout (`placeForFocused`). */
  place?: PyTabPlacer;
}): Promise<boolean> {
  const ok = await guardLoginNodeRun({ projectId: opts.scope, location: "remote", kind: "login-node-run" });
  if (!ok) return false;
  const store = useTabsStore.getState();
  const prior = (store.tabsByScope?.[opts.scope] ?? store.tabs).find(
    (t) => t.kind === "shell" && t.env?.[TEX_BUILD_ENV] === opts.texPath,
  );
  if (prior) store.removeTab(prior.key);
  const tab: Omit<TabEntry, "key"> = {
    label: translateNow("tex.compileOnHostTab", { name: basename(opts.texPath) }),
    cmd: "", // the host's login shell
    args: [],
    env: { [TEX_BUILD_ENV]: opts.texPath },
    cwd: opts.projectDir,
    kind: "shell",
    location: "remote",
    initialInput: hostTexBuildCommand(hostTexBuildArgv(opts.texPath, opts.remoteRoot, opts.engine)),
    ephemeral: true,
  };
  if (opts.place) {
    const entry = opts.place(tab);
    if (entry) useTabsStore.getState().setActive(entry.key);
    return true;
  }
  const entry = useTabsStore.getState().addTabToScope(opts.scope, tab);
  useTabsStore.getState().setActive(entry.key);
  return true;
}
