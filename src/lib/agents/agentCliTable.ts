// Generated from src-tauri/src/commands/agents.rs (`AGENTS`) — do not edit.
// Regenerate: UPDATE_AGENT_CLI_TABLE=1 cargo test --manifest-path src-tauri/Cargo.toml -q --lib -- the_generated_agent_cli_table_ts_is_current
//
// The built-in agent CLIs in menu order: registry id, the binary a tab
// runs (its `cmd`), display name, and the args that resume a restarted
// tab (`null`: not resumable; `SESSION_ID_ARG` stands for the tab's
// session id). Read through `lib/agents/agentClis.ts`.

export const SESSION_ID_ARG = "{sessionId}";

export interface AgentCliRow {
  readonly id: string;
  readonly bin: string;
  readonly label: string;
  readonly resume: readonly string[] | null;
}

export const AGENT_CLI_ROWS: readonly AgentCliRow[] = [
  { id: "claude", bin: "claude", label: "Claude", resume: ["--resume", "{sessionId}"] },
  { id: "codex", bin: "codex", label: "Codex", resume: [] },
  { id: "antigravity", bin: "agy", label: "Google Antigravity", resume: ["--continue"] },
  { id: "gemini", bin: "gemini", label: "Google Gemini", resume: ["--resume", "latest"] },
  { id: "vibe", bin: "vibe", label: "Mistral", resume: ["--continue"] },
  { id: "kiro", bin: "kiro-cli", label: "Kiro", resume: null },
  { id: "cline", bin: "cline", label: "Cline", resume: null },
  { id: "aider", bin: "aider", label: "Aider", resume: null },
  { id: "opencode", bin: "opencode", label: "OpenCode", resume: ["--continue"] },
  { id: "cursor-agent", bin: "cursor-agent", label: "Cursor", resume: ["--continue"] },
  { id: "copilot", bin: "copilot", label: "Copilot", resume: ["--continue"] },
  { id: "droid", bin: "droid", label: "Droid", resume: ["--resume"] },
  { id: "grok", bin: "grok", label: "Grok", resume: ["--continue"] },
  { id: "qwen", bin: "qwen", label: "Qwen", resume: ["--continue"] },
  { id: "openclaw", bin: "openclaw", label: "OpenClaw", resume: null },
  { id: "auggie", bin: "auggie", label: "Auggie", resume: null },
  { id: "kilo", bin: "kilo", label: "Kilo Code", resume: null },
  { id: "continue", bin: "cn", label: "Continue.dev", resume: null },
  { id: "junie", bin: "junie", label: "JetBrains Junie", resume: null },
  { id: "codebuddy", bin: "codebuddy", label: "CodeBuddy", resume: null },
  { id: "goose", bin: "goose", label: "Goose", resume: null },
  { id: "pi", bin: "pi", label: "Pi", resume: null },
  { id: "plandex", bin: "plandex", label: "Plandex", resume: null },
  { id: "swe-agent", bin: "sweagent", label: "SWE-agent", resume: null },
  { id: "mini-swe-agent", bin: "mini", label: "mini-SWE-agent", resume: null },
  { id: "crush", bin: "crush", label: "Crush", resume: null },
  { id: "amp", bin: "amp", label: "Amp", resume: null },
  { id: "kimi", bin: "kimi", label: "Kimi Code", resume: null },
  { id: "qoder", bin: "qoder", label: "Qoder", resume: null },
  { id: "muse", bin: "muse", label: "Meta Muse Code", resume: null },
];
