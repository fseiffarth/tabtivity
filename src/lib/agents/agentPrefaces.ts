/**
 * The prefix commands and model pick a side-panel agent composer submits AHEAD
 * of a prompt.
 *
 * Two rules shape this file:
 *
 * 1. **They are separate submissions, never extra lines of the message.** A
 *    CLI's `/clear` or `/model` owns its whole line, so gluing the prompt onto
 *    one would make the command swallow it. `scheduledAgentInput` submits each
 *    entry on its own, in order, then the message.
 * 2. **Tabtivity chooses nothing.** The model pick is typed as the agent's OWN
 *    `/model <name>`; no flag is injected at launch and no permission/plan mode
 *    is offered here. That is the line AGENTS.md draws around agent authority —
 *    the composer types what the user picked into the agent's own CLI, which is
 *    exactly what they could have typed by hand.
 *
 * The defaults below are a starting point, not a catalogue: slash commands and
 * model names change faster than this app ships, so both lists are overridable
 * per agent from Settings → Agents (`settings.agent_preface_commands`,
 * `settings.agent_models`). An agent with no default gets an empty list rather
 * than a guessed one — an invented command typed into an agent is worse than no
 * chip at all.
 */

/** Mirrors `services::agent_tasks::MAX_PREFACE_COMMANDS`. */
export const MAX_PREFACE_COMMANDS = 6;
/** Mirrors `services::agent_tasks::MAX_PREFACE_BYTES`. */
export const MAX_PREFACE_COMMAND_BYTES = 256;

/**
 * Per-agent prefix chips, keyed by the agent's command. Only commands the CLI
 * documents are listed; anything uncertain is left to the Settings editor.
 */
export const DEFAULT_PREFACE_COMMANDS: Record<string, string[]> = {
  claude: ["/clear", "/compact", "/context", "/cost"],
  codex: ["/new", "/compact", "/status"],
  gemini: ["/clear", "/compact", "/stats"],
  aider: ["/clear", "/reset", "/tokens"],
  opencode: ["/new", "/compact"],
};

/**
 * Per-agent model names for the `/model <name>` pick. Claude Code's aliases are
 * stable enough to ship; every other CLI names models on its own schedule, so
 * its list starts empty and is filled in from Settings.
 */
export const DEFAULT_AGENT_MODELS: Record<string, string[]> = {
  claude: ["opus", "sonnet", "haiku", "fable"],
};

/**
 * The key both lists are stored under: the bare command, lowercased. A custom
 * agent may carry a path (`~/bin/my-agent`) or a `.cmd`/`.exe` suffix on
 * Windows; those are the same agent as far as a chip list is concerned.
 */
export function agentComposerKey(cmd: string): string {
  const base = cmd.trim().split(/[\\/]/).pop() ?? "";
  return base.replace(/\.(exe|cmd|bat|ps1)$/i, "").toLowerCase();
}

/**
 * One preface entry, sanitized, or `""` when it is not a usable command. The
 * rules mirror `services::agent_tasks::validate_preface_command` so the backend
 * never rejects what this UI accepted: control characters removed, trimmed, a
 * single line, a leading `/`, within the byte cap.
 */
export function sanitizePrefaceCommand(raw: string): string {
  const clean = raw
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, "")
    .trim();
  if (!clean || clean.includes("\n")) return "";
  if (!clean.startsWith("/")) return "";
  if (new TextEncoder().encode(clean).byteLength > MAX_PREFACE_COMMAND_BYTES) return "";
  return clean;
}

function resolveList(
  cmd: string,
  overrides: Record<string, string[]> | undefined,
  defaults: Record<string, string[]>,
): string[] {
  const key = agentComposerKey(cmd);
  // An explicit empty list is a decision ("no chips for this agent"), so the
  // override is consulted by presence, not by truthiness.
  const configured = overrides && Object.prototype.hasOwnProperty.call(overrides, key)
    ? overrides[key]
    : defaults[key];
  if (!configured) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of configured) {
    const clean = entry.trim();
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    result.push(clean);
  }
  return result;
}

/** The prefix chips offered for one agent tab. */
export function prefaceCommandsFor(
  cmd: string,
  overrides?: Record<string, string[]>,
): string[] {
  return resolveList(cmd, overrides, DEFAULT_PREFACE_COMMANDS)
    .map(sanitizePrefaceCommand)
    .filter(Boolean)
    .slice(0, MAX_PREFACE_COMMANDS);
}

/** The model names offered for one agent tab. */
export function agentModelsFor(
  cmd: string,
  overrides?: Record<string, string[]>,
): string[] {
  return resolveList(cmd, overrides, DEFAULT_AGENT_MODELS);
}

/** The agent's own model command for a picked name. */
export function modelCommand(model: string): string {
  return `/model ${model.trim()}`;
}

/**
 * The inverse of {@link buildPreface}: a stored preface split back into the
 * chips that were switched on and the model that was picked, so a saved
 * schedule opens for editing showing what it will actually type. Only the LAST
 * `/model` counts, matching the order `buildPreface` writes.
 */
export function splitPreface(preface: string[] | undefined): {
  commands: string[];
  model: string;
} {
  const commands: string[] = [];
  let model = "";
  for (const entry of preface ?? []) {
    const clean = sanitizePrefaceCommand(entry);
    if (!clean) continue;
    const picked = /^\/model\s+(.+)$/.exec(clean);
    if (picked) model = picked[1].trim();
    else commands.push(clean);
  }
  return { commands, model };
}

/**
 * The ordered preface for one send: the chips the user switched on, in the
 * order they are offered, then the model pick.
 *
 * The model goes LAST on purpose. A chip like `/new` (Codex) or `/clear` starts
 * the turn over, and on some CLIs that also drops back to the session's default
 * model — so a model chosen before it would be silently undone. Last, it is the
 * state the prompt actually runs under.
 */
export function buildPreface(
  offered: string[],
  selected: Iterable<string>,
  model?: string,
): string[] {
  const on = new Set(selected);
  const result = offered
    .filter((command) => on.has(command))
    .map(sanitizePrefaceCommand)
    .filter(Boolean);
  const picked = model?.trim();
  if (picked) {
    const command = sanitizePrefaceCommand(modelCommand(picked));
    if (command) result.push(command);
  }
  return result.slice(0, MAX_PREFACE_COMMANDS);
}
