import type { DetectedSpecSource, ProjectEntry } from "../../types";
import { resolveProjectDirectory } from "../../types";
import { translate, useI18nStore, type TranslationKey } from "../../lib/i18n";
import { BRAND } from "../../lib/brand";

export const TERMINAL_OPTIONS = ["claude", "codex", "gemini", "vibe"];

/** O#143's confirm-dialog copy — shared by the pill's toggle and the new/import
 *  dialog's container row, so a repo-supplied Dockerfile is never adopted with
 *  two different explanations of what that costs. */
export function describeDetectedSpecSource(source: DetectedSpecSource): string {
  return translate(
    useI18nStore.getState().lang,
    source.kind === "dockerfile" ? "scaffold.adoptDockerfile" : "scaffold.adoptDevcontainer",
    { value: source.value },
  );
}

export interface ScaffoldPreviewItem {
  path: string;
  exists: boolean;
  kind: string;
}

export interface ScaffoldRepairReport {
  createdFiles: string[];
  /** Agent docs that were still an untouched legacy stub and got rewritten to
   *  the current template (AGENTS.md canonical, CLAUDE/GEMINI pointing at it).
   *  Optional because the backend restarts on the user's schedule: a window
   *  still running a pre-`updatedFiles` binary must summarize, not crash. */
  updatedFiles?: string[];
  gitignoreLinesAdded: string[];
  gitInitialized: boolean;
}

export interface ProjectScaffoldRepair {
  projectId: string;
  name: string;
  targetDir: string;
  report: ScaffoldRepairReport;
}

export function scaffoldRepairIsEmpty(report: ScaffoldRepairReport) {
  return (
    report.createdFiles.length === 0 &&
    (report.updatedFiles?.length ?? 0) === 0 &&
    report.gitignoreLinesAdded.length === 0 &&
    !report.gitInitialized
  );
}

/** Human-readable one-line summary of what a repair report changed. */
export function summarizeScaffoldRepair(report: ScaffoldRepairReport): string {
  const lang = useI18nStore.getState().lang;
  const parts: string[] = [];
  if (report.createdFiles.length > 0) {
    parts.push(translate(lang, "scaffold.repairAdded", { files: report.createdFiles.join(", ") }));
  }
  if (report.updatedFiles && report.updatedFiles.length > 0) {
    parts.push(translate(lang, "scaffold.repairUpdated", { files: report.updatedFiles.join(", ") }));
  }
  if (report.gitignoreLinesAdded.length > 0) {
    // `.gitignore` and the lines added to it are literal file content, so the
    // whole fragment stays as it is — there is nothing here to translate.
    parts.push(`.gitignore +${report.gitignoreLinesAdded.join(", ")}`);
  }
  if (report.gitInitialized) {
    parts.push("git init");
  }
  return parts.length > 0 ? parts.join("; ") : translate(lang, "scaffold.repairUpToDate");
}

/** Same summary, prefixed with the project name — for a toast/log covering
 *  multiple projects at once. */
export function describeScaffoldRepair(repair: ProjectScaffoldRepair): string {
  return `${repair.name}: ${summarizeScaffoldRepair(repair.report)}`;
}

/** The fill-mode dropdown's options. Only the key is stored here; the caller
 *  resolves it with its own `t`, so the dropdown re-renders on a language flip. */
export const SCAFFOLD_FILL_OPTIONS: { value: string; labelKey: TranslationKey }[] = [
  { value: "none", labelKey: "scaffold.fill.none" },
  { value: "manual", labelKey: "scaffold.fill.manual" },
  { value: "validation", labelKey: "scaffold.fill.validation" },
  { value: "agent_choice", labelKey: "scaffold.fill.agentChoice" },
  { value: "claude", labelKey: "scaffold.fill.claude" },
  { value: "codex", labelKey: "scaffold.fill.codex" },
  { value: "gemini", labelKey: "scaffold.fill.gemini" },
  { value: "vibe", labelKey: "scaffold.fill.vibe" },
];

export const AGENT_SCAFFOLD_FILL_MODES = new Set([
  "agent_choice",
  "claude",
  "codex",
  "gemini",
  "vibe",
]);

export function sanitizeName(name: string) {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export function projectDirectory(project: ProjectEntry) {
  return resolveProjectDirectory(project);
}

export function agentForScaffoldFillMode(fillMode: string, defaultAgentCmd: string) {
  return fillMode === "agent_choice" ? defaultAgentCmd : fillMode;
}

export function collectScaffoldAgentFills(
  preview: ScaffoldPreviewItem[],
  fillModes: Record<string, string>,
  defaultAgentCmd: string,
) {
  const filesByAgent = new Map<string, string[]>();
  for (const item of preview) {
    if (item.exists) continue;
    if (item.kind !== "file") continue;
    const fillMode = fillModes[item.path] ?? "none";
    if (!AGENT_SCAFFOLD_FILL_MODES.has(fillMode)) continue;
    const agent = agentForScaffoldFillMode(fillMode, defaultAgentCmd);
    const cmd = TERMINAL_OPTIONS.includes(agent) ? agent : "claude";
    filesByAgent.set(cmd, [...(filesByAgent.get(cmd) ?? []), item.path]);
  }
  return filesByAgent;
}

export function buildScaffoldFillPrompt(files: string[]) {
  const fileList = files.map((file) => `- ${file}`).join("\n");
  return [
    `Fill the ${BRAND.display} project scaffold files listed below.`,
    "",
    "Instructions:",
    "- Inspect the project first so the files reflect the actual codebase and purpose.",
    "- Replace placeholder scaffold content with useful, project-specific guidance.",
    "- Preserve unrelated existing content and do not rewrite files outside this list.",
    "- All agent guidance belongs in the canonical AGENTS.md. Agents load it every",
    "  session, so keep it short: build/test commands, constraints, and conventions",
    "  an agent would otherwise get wrong. Overviews and architecture go in README.md",
    "  or DOCUMENTATION.md, linked from PROJECT.md.",
    "- The CLAUDE.md and GEMINI.md files are pointers to it: keep their `@AGENTS.md`",
    "  import and their links to the other agent files, and never copy guidance into them.",
    "- PROJECT.md is the navigation map: keep its relative links to the other scaffold",
    "  files working, and extend it with links to the project's own key files/folders.",
    "- REMARKS.md keeps its format note and uses `- [ ] [path:line](./path:line) — text`",
    "  bullets; the line suffix is optional.",
    "",
    "Files to fill:",
    fileList,
  ].join("\n");
}

export function buildDescriptionFillPrompt(projectName: string) {
  return [
    `Write a concise ${BRAND.display} project description for "${projectName}".`,
    "",
    "Instructions:",
    "- Inspect the project first so the description reflects the actual codebase and purpose.",
    "- Update project.json by setting the top-level description field.",
    "- Keep it to one or two practical sentences suitable for a project switcher hover popup.",
    "- Preserve unrelated existing content and formatting where practical.",
  ].join("\n");
}

export interface ParsedSshAddress {
  user: string | null;
  host: string;
  port: number | null;
}

/**
 * Parse an SSH address of the form `[user@]host[:port]` (e.g. `me@box:2222`,
 * `box`, `me@box`). Returns null if no host can be extracted or the port is
 * not a valid number. The empty string yields null (= local, unchanged flow).
 */
export function parseSshAddress(raw: string): ParsedSshAddress | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let user: string | null = null;
  let rest = trimmed;
  const at = rest.indexOf("@");
  if (at >= 0) {
    user = rest.slice(0, at) || null;
    rest = rest.slice(at + 1);
  }
  let port: number | null = null;
  const colon = rest.lastIndexOf(":");
  if (colon >= 0) {
    const portStr = rest.slice(colon + 1);
    const parsed = Number(portStr);
    if (!portStr || !Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
      return null;
    }
    port = parsed;
    rest = rest.slice(0, colon);
  }
  const host = rest.trim();
  if (!host) return null;
  return { user, host, port };
}

/**
 * Frontend twin of the backend's clone-URL whitelist (`validate_clone_url` in
 * `commands/git.rs`): https/http, `ssh://`, `git://`, or the scp-like
 * `[user@]host:path`. It gates the Import button so a typo is caught before a
 * `git clone` is spawned — the backend re-validates regardless, since that is
 * where a hostile URL (`ext::<command>` runs the command) would actually bite.
 */
export function isCloneUrl(raw: string): boolean {
  const url = raw.trim();
  if (!url) return false;

  const schemeEnd = url.toLowerCase().indexOf("://");
  if (schemeEnd >= 0) {
    return ["https", "http", "ssh", "git"].includes(url.slice(0, schemeEnd).toLowerCase());
  }

  const colon = url.indexOf(":");
  if (colon < 0) return false;
  const host = url.slice(0, colon);
  const path = url.slice(colon + 1);
  return (
    host !== "" &&
    !host.includes("/") &&
    !host.startsWith("-") &&
    path !== "" &&
    !path.startsWith(":")
  );
}

/**
 * The repository's own name from a clone URL — last path segment, minus a
 * trailing `.git`. Used to pre-fill the project name so the common case needs no
 * typing. Returns "" when nothing name-like can be read out.
 */
export function repoNameFromCloneUrl(raw: string): string {
  const url = raw.trim().replace(/[/]+$/, "");
  if (!url) return "";
  const last = url.split(/[/:]/).pop() ?? "";
  return last.replace(/\.git$/i, "");
}

/**
 * The hosting provider a clone URL's host names itself as ("github"/"gitlab"),
 * or "" when it doesn't — a self-hosted instance usually doesn't, and the fork
 * import then needs the user to say which it is (forking goes through the
 * provider's own CLI, so guessing wrong picks the wrong binary and API).
 * Frontend twin of `provider_from_host` in `commands/git_fork.rs`.
 */
export function providerFromCloneUrl(raw: string): "github" | "gitlab" | "" {
  const url = raw.trim();
  if (!url) return "";
  const schemeEnd = url.toLowerCase().indexOf("://");
  const afterScheme = schemeEnd >= 0 ? url.slice(schemeEnd + 3) : url;
  // Authority = everything before the first `/` (URL form) or `:` (scp-like),
  // minus any userinfo and port.
  const authority = afterScheme.split(/[/:]/)[0] ?? "";
  const host = (authority.split("@").pop() ?? "").toLowerCase();
  if (!host) return "";
  if (host.includes("github")) return "github";
  if (host.includes("gitlab")) return "gitlab";
  return "";
}

/** Join a remote directory path with a child segment using POSIX separators. */
export function joinRemotePath(base: string, child: string): string {
  if (!base || base === "/") return `/${child}`;
  return `${base.replace(/\/+$/, "")}/${child}`;
}
