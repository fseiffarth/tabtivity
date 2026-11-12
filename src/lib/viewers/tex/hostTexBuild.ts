/**
 * The TeX Compile of a file on a remote host: any file of a host-pinned project
 * (VM, remote-only; `docs/remote_only_projects_plan.md` D6) and a remote
 * project's file read from its Remote side. There is no local tree for
 * `compile_tex` to build in, so `TexView` calls `compile_tex_host`, which runs
 * latexmk on the host over SSH in the background and answers like a local
 * build (log, errors, the PDF's host path). No tab opens. A project's
 * `latexmkrc` therefore runs on the host as the login, where the project's
 * agents already run; nothing of the project runs here.
 */

/** The engines a host build can be asked for: the engine menu offers these on a
 *  host build, since this machine's `tex_capability` says nothing about what
 *  the host has installed. */
export const HOST_TEX_ENGINES: readonly string[] = ["pdflatex", "lualatex", "xelatex"];
