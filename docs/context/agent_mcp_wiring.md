# Agent MCP wiring — how every agent CLI reaches Tabtivity's lanes

Every local project agent tab is granted the MCP lanes (`root_mcp::grant_lanes`:
schedule, git, help, markup, print, cockpit, tabs; root in the root console). Each grant puts
an env pair in the spawn: `TABTIVITY_<LANE>_MCP_URL` and `_TOKEN`. How the CLI
learns that the server exists is decided per CLI, in two ways.

## 1. Named at launch: the registry row

`AgentSpec::mcp` (`agent_registry::McpWiring`) says how one launch of the CLI
takes a server. `root_mcp::wire_named_cli` is the one function every lane calls.

| Form | CLI | How | Token placeholder |
|---|---|---|---|
| `ClaudeFlag` | Claude | `--mcp-config <json>`, last in argv | `${VAR}` |
| `CodexOverrides` | Codex | `-c mcp_servers.<name>.…`, first in argv | `bearer_token_env_var` |
| `CopilotFlag` | Copilot | `--additional-mcp-config <json>` per server, first in argv | `${VAR}` |
| `OpenCodeInline` | OpenCode | `mcp.<name>` merged into `OPENCODE_CONFIG_CONTENT` | `{env:VAR}` |
| `None` | everyone else | env pair only → `tabtivity-mcp` | — |

Tool-tagged local Vibe models keep their own path (`VIBE_MCP_SERVERS`, the
`is_local_model` branch of each `apply_*_to_spawn_with`).

Rules each form keeps:

- **Per launch, never the CLI's config file.** A flag or env var dies with the
  tab; a file in the scope's home would reach the scope's other tabs, whose
  tokens and lanes differ.
- **The token is named, never inlined.** The argv and env end up in a tmux
  launcher script on disk (`tmux_local`); only the secret carriers hold the value.
- **Verified on the real binary before a row gets a form.** A wrong flag can
  stop the CLI from starting at all, while an extra env pair is inert.
  Verify by starting the CLI in a private tmux against a loopback stub that
  logs the `Authorization` header: the header must arrive with the token
  filled in. Recorded: Copilot 1.0.110 and OpenCode 2.3.0 (2026-11-14).
  `opencode mcp list` does not show inline servers. Only the TUI is proof.
- **`WIRED_CLIS` is the registry rows with a form.** A test holds the two
  together. The UI's "MCP" chip and the help agent read that list.

OpenCode's inline config has three writers: the lanes, `launch_prep`'s
local-models config and `agent_api_keys`' routes. Each one merges into what is
already there. The lanes also merge the user's own ambient
`OPENCODE_CONFIG_CONTENT`, since the spawn's value replaces it. The
local-models config runs after the lanes and carries their servers over
(`root_mcp::merge_opencode_mcp`).

### CLIs checked and left on `None`

- **Antigravity (`agy`) 1.5.8**: its `mcp_config.json` sends `${VAR}`,
  `$VAR`, `{env:VAR}` and `${env:VAR}` through as literal text, so the token
  would have to be written out in full. `--settings` would put it in argv.
- **Gemini 0.68 / Qwen 0.27**: a settings path through an env var
  (`GEMINI_CLI_SYSTEM_DEFAULTS_PATH`) looks possible, but it was not run.
  Wire them only after a verified start.
- The rest (Droid, Cursor, Auggie, CodeBuddy, Kimi, Kiro, Goose, Crush, …):
  not installed when the rows were written.

## 2. Everything else: the `tabtivity-mcp` command

`scripts/tabtivity-mcp.sh` and its PowerShell twin are installed by `agent_bin` beside
`tabtivity-send` (on every tab's PATH, read-only in the fence). It reads the
env pairs and calls the lane over plain JSON-RPC: one stateless `tools/list`
or `tools/call` per run, with no `initialize` handshake.

```
tabtivity-mcp                          # the servers this tab holds
tabtivity-mcp tools print              # their tools and argument schemas
tabtivity-mcp call print print_request '{"path":"out.pdf"}'
```

- The token reaches curl on fd 3 (`-H @/dev/fd/3`), never in argv, and only to
  a `http://127.0.0.1:<port>/mcp…` URL.
- Exit 1 for an `isError`, JSON-RPC error or `"status":"refused"` result; 2 for usage;
  3 for no server, no curl or a non-local URL.
- Agents learn it from `agent_hint::HOOK_HINT`, the session-start line the
  CLIs past Claude/Codex already get for `tabtivity-send`. A CLI without a
  hint route (Antigravity, Kiro, Cline, Aider, …) is not told, but the
  command still works when the user names it.
- Each call is an ordinary shell command, so the CLI's own permission mode
  decides whether it asks first.

## 3. After a reattach (a crash left the session running)

A local agent session outlives a crash; the next launch reattaches it and its
agent keeps the URLs and tokens it started with, which the new process does not
know. `launch_prep::prepare` therefore reads the session's MCP stamp before it
grants (`root_mcp_mark`, `docs/context/tmux_sessions.md`): a **Create** grants as
above and stamps the session; a **Live** reattach (this run's grant still held,
or another listener confirms it) mints nothing and re-keys the held lanes to the
new PTY id; a **Stale** one mints nothing and flags the tab (`mcpStale` on the
spawn answer, `appMcpStale` in the hover card's features, `servers_of_tab`
empty). Minting for a reattach would be wrong twice: nobody receives the
tokens, and `TokenStore::register` revokes the tab's earlier token per lane.
The listener's port is stable across runs (`<state_dir>/root_mcp/port`), so a
stale agent's calls reach this program's refusal, not another listener.

Which CLIs retry an MCP server after it refused connections is **unverified**
(Phase 2's first step, `docs/mcp_reattach_plan.md`).
