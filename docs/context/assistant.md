# Tabby, the chat assistant

Tabby (`crate::brand::ASSISTANT_NAME`, `NAMES.assistant`; a word of its own, not
derived from the slug) is a chat on the desktop and in the phone PWA. The user
picks the CLI that runs the model: Claude Code or Codex on their own login, or
a local Ollama model through OpenCode or Claude Code. Tabby can search and read
the web and read Tabtivity's own user docs (the help lane, below). It cannot see
a file on the computer, a project, the user's MCP servers or anything else
Tabtivity holds. Experimental (`useExperimental("assistant")`, off by
default); the backend reads the same flag (`Settings::assistant_enabled`).
Plan and the step-by-step build record: `docs/assistant_plan.md`,
`docs/assistant_handoff.md` (untracked in the main checkout).

Why it exists: most questions need no project. The root console holds the
calendar, mail and to-do rights; a project agent sees the project. Both give
every web page the model reads a path to more than the question needs.

## Two layers, both required

- **The fence.** A reserved scope `assistant` (below), a home of its own
  (`agent-homes/assistant`, or `assistant.local` for local models) seeded with
  nothing, one empty working folder per chat, no project, box or root
  read-only roots, none of the user's `agent_fence_paths` allowlist. Network on.
  Tabtivity's own session hooks are still registered (turn state needs them).
- **The pinned CLI.** `services::assistant::launch_line` builds the argv from a
  validated `AssistantLaunch { cli, model }`; the renderer's and the phone's
  `cmd`/`args` are ignored. The tool set is cut to the web ones and no MCP
  server loads except the web lane and the help lane.

Neither is enough alone. The fence cannot hide the CLI's own login from the
CLI, so a file or shell tool would let a prompt injection read the login and
send it out in a fetch URL: the pinned tool set is what stops that. The pinned
tool set does not stop the user's own `!` shell escape or `@file` mention, which
run inside the fence with an empty working folder and a home holding only the
logins: the fence is what limits those. A CLI whose file and shell tools cannot
be switched off is not offered.

The fence is not a blank machine. Like every fence, `bwrap_args` starts from
`--ro-bind / /`, so system folders and anything outside `$HOME` (a project kept
under `/mnt/...`, another user's home) stay readable
(`docs/context/agent_authority.md`). That posture is why the CLI layer exists.
The chat's working folder is the only read-write bind besides the home, `/tmp`
and the live-session slice: `agent_fence::assistant_chat_mount` binds exactly
`work/<uid>` (uuid-shaped, a real directory, no link at the chat name or at
`work`), never the whole `work` folder, so a chat does not see its siblings. The
one creator of that folder is `launch_prep::ensure_chat_dir`; the fence refuses
a missing one.

Spawn behaviour, from the security verification: the Codex catalog file is
built from an allowlist of fields and checked again once written; when a Tabby
CLI exits, the pane ends rather than falling to a shell (a login shell inside
the chat would be an unpinned terminal), so a chat whose CLI quit has no
process and no tmux session until it is started again (the Tabby view's Restart,
or the phone opening it; see below); the tmux session name of a chat is derived
by Tabtivity (`assistant::tmux_session_for`), not taken from the request; and
the web token is listed in the tmux `SECRET_ENV` set so it is never put on a
command line.

## Why page fetch lives outside the fence (the web lane)

The fence shares the host's network, so a fetch made from inside it reaches
`localhost` and the LAN: the Mobile sidecar, Ollama, the router. A
server-side search (Claude `WebSearch`, Codex `web_search`) runs at the
provider and is allowed. Every page fetch goes through Tabtivity instead:
`services::web_lane`, served on `POST /mcp/web` as `Caller::Web`, a lane of its
own beside root, help and the rest.

- Tools `web_fetch {url}` and `web_search {query, count?}`, MCP server name
  `web`. Only `Caller::Web` is served them (`ToolPolicy.web`), and a `Web`
  session is served nothing else, is excluded from `set_access`, the readable
  project marks and `tab_active`.
- The fetch is `browser_engine::fetch_for_agent` with `FetchOrigin::Agent`: the
  document rule (every hop, hop 0 included, must resolve to a globally
  routable address, userinfo refused) but `http` allowed, no cookies, no
  Referer, and **no proxy** (`HTTP(S)_PROXY` would resolve names past the
  public-address check; behind a proxy-only network `web_fetch` fails and
  native search still works). An address the host itself owns is refused as
  `not_public`, found by trying to bind a UDP socket to it. `web_safety` also
  refuses the "this network", benchmarking and reserved IPv4 blocks and the
  NAT64, 6to4, Teredo and site-local IPv6 forms.
- Output is text: HTML, XML, plain text and markdown, sanitised, with invisible
  Unicode stripped from page text, titles and snippets (a wider set than the
  mail names use, because emoji legitimately need U+FE0F there). No PDFs and no
  links. Replies are bounded (5 MB page cap, truncated not refused; a search
  reply over 1 MB is `too_large`).
- Fixed error categories (`not_public`, `too_large`, `unsupported_type`,
  `search_not_configured`, `key_unreadable`, `budget`, `off`, `invalid`,
  `fetch_failed`, `search_failed`); the audit records the tool name and the
  category only. Budget: 120 calls per tab per rolling hour, kept in a
  process-wide map keyed by the tab so a respawn does not reset it. The lane has
  its own pool of request slots, so a stuck fetch cannot starve the other lanes.
- The token is minted per tab (`grant_assistant`), only for profiles with
  `AssistantCli::uses_lane()` (Codex has native search and no lane), revoked
  with the tab. Beside the help token (below) it is the only `*_MCP_TOKEN` an
  assistant spawn holds. It lives
  in the spawn env, never on a command line. The lane is served by the window and
  by a desktop's Mobile host (`Runtime.serves_web`), never by a server daemon.
- Search backend: the user's choice. A SearXNG URL (`web_lane::validate_searxng_url`:
  no query string, 512 bytes, no userinfo) or Ollama's web search API with a
  key in the keychain (account `web-search:ollama`, never in `settings.json`,
  never returned to the UI). With neither set a local profile's `web_search`
  answers `search_not_configured` and the chat shows a setup card. Cloud CLIs
  search natively and do not need one.

## The help lane

Every profile also gets the help server (`services::help_mcp`, `Caller::Helper`,
`/mcp/help`) while `help_mcp` is on: `grant_assistant` mints the token beside the
web one, `assistant::help_url_from_env` reads the url back, and `launch_line`
wires it (`LaunchCtx.help`, dropped unless it is a loopback `/mcp/help` url).
Why it is allowed: the corpus is compiled in and public, read-only, and holds
nothing of the user's; a page that steers the model into the help tools can
learn the docs, the version and the OS family (`tabtivity_help_status`), which
the fetch-URL leak below could send out and which are not secret. It is not a
way around the pinned tool set: the help tools read no file and run nothing.

- Claude: a second entry in the one `--mcp-config` (name `help_mcp::SERVER_NAME`,
  as every tab sees it). Cloud Claude still gets no allow rule; local Claude's
  `--allowedTools` names `mcp__<help server>` after `mcp__web` (decision 14's
  reason), and `claude_local_tail_ok` pins the help url as it pins the lane's.
- OpenCode: a second remote `mcp` entry named `help` (plain, like `web`), its
  tools on by `help_<slug>_help_*`, last in `tools`.
- Codex: `-c mcp_servers.<help server>.url` and `.bearer_token_env_var`, its one
  MCP entry (the home's `[mcp_servers]` is still stripped).
- The system prompt tells the model to use its help tools "if you have them",
  so a chat with `help_mcp` off is not told about tools it lacks.

## The profiles, as built

Pinned against Claude Code 2.1.300, Codex 0.162.1, OpenCode 1.19.1 and
Ollama 0.40.3 (A0). All four are offered.

| Profile | What `launch_line` sets | Web |
|---|---|---|
| Claude (cloud) | `--session-id <uid>` (turned into `--resume` for an existing chat) · `--model=` · `--tools WebSearch` · `--strict-mcp-config` (without it the user's MCP servers and the claude.ai connectors load) · `--mcp-config` with the lane and the help server, tokens by env expansion · `--disable-slash-commands` · `--append-system-prompt` | native `WebSearch`, lane `web_fetch` |
| Codex (cloud) | `-c features.shell_tool=false` · `view_image`, `goals`, `apps`, `plugins`, `browser_use`, `computer_use`, `image_generation` off · `-c model_catalog_json=<home>/.codex/assistant_models.json` · `-c web_search="live"` · `-c developer_instructions=…`; the help server as its one MCP entry, no `-s` | native `web_search` |
| OpenCode (local) | `OPENCODE_CONFIG_CONTENT`: `tools` false for bash, edit, write, read, grep, glob, list, patch, webfetch, websearch, task, todowrite, todoread, skill, lsp; `mcp.web` and `mcp.help` remote with `Bearer {env:…}`; the system prompt as the build agent's; merged with the `provider.ollama` block; `--model ollama/<m>`, `--continue` iff the chat folder existed | lane `web_search` + `web_fetch` |
| Claude (local, via Ollama) | `ollama launch claude --model <m> -- --session-id <uid>` (or `--continue` once a transcript exists) `--tools "" --strict-mcp-config --mcp-config <lane + help> --disable-slash-commands --append-system-prompt … --allowedTools mcp__web mcp__<help server>` | lane `web_search` + `web_fetch` |

- **Codex catalog (decisions 13 and 16).** Codex has no switch for `apply_patch`,
  so at every spawn the catalog is built from the home's `models_cache.json`
  with every entry's `apply_patch_tool_type` forced to `null`, written through
  `home_io` and re-read and checked; anything missing or malformed refuses the
  spawn (`Refusal::CodexCatalog`). A home Codex never ran in copies the newest
  usable cache from a sibling Tabtivity agent home (shape-checked, regular
  file, size capped; only from a folder named `agent-homes`); none anywhere
  refuses with "start Codex once in any tab, then try again". The home's own
  cache is never overwritten. The cache's prompt text is never used: every
  entry carries Tabtivity's own `base_instructions` (a catalog entry needs a
  base prompt or a template, probed with 0.162.1; the cache's `model_messages`
  and `base_instructions` are dropped), so a planted cache cannot rewrite what
  the model is told. `-c mcp_servers={}` does not empty the home's MCP servers
  (Codex merges tables; probed), so the spawn removes `[mcp_servers]` from the
  home's `config.toml` (`agent_home::with_codex_trust`).
- **Local Claude pre-allows the lane (decision 14).** `--allowedTools mcp__web`
  (and the help server's tools) is a permission rule for Tabby's own tools, not a mode, because the auto-mode
  check runs on the local model and timed out. Cloud Claude gets no allow rule.
- **AGENTS.md exception (decision 10).** "Tabtivity injects no mode flag" still
  holds; pinning the tool set is new and holds for this scope only. The home
  never gets the `agent_global` layer, which carries the user's MCP servers,
  skills and hooks.
- A fixed system prompt (`assistant::SYSTEM_PROMPT`, `{assistant}`-templated):
  you have no access to the user's computer or files, you can search and read
  the web, cite your pages, look up Tabtivity itself with the help tools if you
  have them. Not user-editable.
- The home is trusted up front: `.claude.json` gets the folder-trust entry and
  `hasCompletedOnboarding`, Codex's `config.toml` a `[projects."<dir>"]
  trust_level`, so a fresh home shows no dialog (Claude live-checked; Codex's
  format follows existing tests and is not live-verified).

## The reserved scope and its funnel

Chats are agent tabs in the scope `assistant` (`storage::ASSISTANT_SCOPE`),
state in `<state_dir>/sessions/assistant/`. It is neither root nor a project,
and its backend identity is the string `assistant`, not `None`: `None` is root
and `is_root_agent`, `roots_for_scope(None)` and the Host-session rule key on it.
A `Some` id that is in no list is otherwise an unknown project, so every such
site was handled (the call-site list is in the plan).

`storage::is_reserved_scope(id)` (root or assistant; trims, reduces through
`project_key`, compares case-insensitively) is the one funnel. It refuses or
drops the id in `projects.json` and `boxes.json` reads and writes,
`validate_project_id`, `discovery::scope_sources`, `sandbox::project_dir_for`,
`agent_shim::plan`, and the prompt, usage and export recorders. A project folder
cannot plant a chat: `restoreSavedTab` keeps the `assistant` block only in this
scope, and a tab without a readable launch is dropped.

`launch_prep::prepare` has an assistant gate right after the control-env strip.
It refuses when the flag is off, for a plain shell or agent in the scope, a
launch outside the scope, a reserved id spelling, a missing or non-uuid
`TAB_UID`, a host session, a remote host, a login or a tmux attach; and it
rewrites cwd, env, cmd and args from the validated launch. The fence decision
must be the assistant fence or the platform one; anything else refuses (it
fails closed like the rest of `agent_fence`).

## Lazy spawn

A restored chat does not start its CLI. `CenterPanel` mounts an assistant-scope
pane (the PTY owner) only for keys in `useOverlayAgentStore.assistantStartedKeys`.
`assistantScope.startAssistantChat(key)` is the one door: `mountAssistantChat`
(a chat just made, or the phone opening one) calls it, and the Tabby view calls
it for the chat it shows. Opening the view starts the newest chat only;
nothing un-starts a chat. Without this, every restored chat would spawn its
CLI at the first open.

## On the desktop: a side-panel view

Tabby is one of the side panel's views (`FilesPanelView` `"assistant"`): an
edge-rail icon after Files/Git/Apps/Agents and a button in the panel's own
switcher, both only with the flag on. It replaced a header button and a
floating overlay. Only the side panel's `ProjectFilesView` offers the view
(`assistant` prop), never a Files (Project) tab or the docked subwindow
viewer: a chat must be drawn by one attach-only view at a time
(`assistantShownKeys` is a set). The view mounts only while the panel is open
on it, so its options poll is visible-only. A jump to a chat (`jumpToTab` on
the assistant scope) goes through `showAssistant`, which selects it and asks
the shell (`app:reveal-side-panel` with `detail.view`) to open the panel on
the view. With no panel target (no project, no root folder) there is no panel
and so no Tabby on the desktop.

**One chat**, on both surfaces (the user's call, 2026-10-20: no chat list).
The view shows the scope's newest chat (or the one a jump named), resumed by
`startAssistantChat`; with none it starts one on the default CLI at once
(`defaultCliOf`), and a blocked default waits behind its card until the
options poll sees it clear. The head's CLI dropdown and Relaunch start a
fresh chat (`assistant_new_chat`) and then remove every other chat of the
scope, so the scope holds the chat both surfaces show. A pick whose CLI is
blocked shows its card and leaves the chat alone.

**The model switches in place.** A chat's slash commands are off, so the
Reader's usual chips that type `/model`, `/effort` or `/status` cannot reach
it. In a Tabby chat the Reader's model chip and the head's model dropdown list
`assistantModelChoices` instead: Claude's aliases, Codex's catalog
(`CliOption.models`, `assistant::codex_offered_models`, read without writing)
or the installed Ollama models. A pick is `switchAssistantModel`: it rewrites
the tab's `assistant` launch (and a local chat's label), ends its tmux session,
waits for the old CLI's exit, and respawns the same tab. The backend resumes
the conversation on the new `--model`. The effort chip and Claude's Status
button only show what they read.

## The phone

`ScopeKind::Assistant` is a phone scope behind `discovery::assistant_open`: the
experimental flag on and `tabtivity_mobile_host.assistant_access` not `false`
(default on: it holds no right the phone should not reach). It mirrors
`Settings::assistant_phone_open` (a test holds them equal) and is read per
catalog load; a closed gate drops the row and an open chat's grant fails its
next recheck (`access_revoked`). The key is read through
`brand::MOBILE_HOST_KEY`, never spelled. A per-phone list narrows it
(`tabtivity_mobile_host.assistant_devices`, `discovery::assistant_devices`;
threat recheck gap 57, D9): absent is every phone, a list only those, an empty or
malformed one none, as for a project or box. Settings → Mobile sets it with the
same picker (`setAssistantReach`); turning the switch off drops the list.

- Only opaque handles cross the API: `mobile_control/assistant.rs` builds launch
  ids from the desktop's own `assistant_options()`; a body carries `assistant:
  "<launch id>"` alone. Raw project ids, paths, commands and tmux targets stay
  inside.
- It works with no window: `headless::create_tab` allows the scope, the Mobile
  host's runtime serves the lane. Window up, the window creates the tab
  (`assistant_new_chat`); down, the owner does.
- Tabby is no Home row: Home filters the `assistant` kind out of its list and
  its FAB opens `TabbyOpen`, which shows the newest chat (activated first when
  it has no process) or creates one on the default ready launch
  (`assistantChat.ts`), then hands over to the Focus chat. The Project screen
  sends a landing on the scope (a restored place, a notification's back) back
  to Home. The Focus chat is the existing one with files, outbox, inbox
  upload, Commit, markup and held prompts hidden; its head is `TabbyHead`: the
  CLI dropdown (catalog rows carry `assistant_launch`, the chat's launch id,
  matched against `launch-options`) and Relaunch, both a create plus a close
  of every other chat. Every folder-shaped route (git, files,
  uploads, worktrees, inbox, outbox, markup, uncommitted, schedules, collected
  prompts, desktop images) answers `404 not_a_project` for the scope.
- A chat restored with the desktop has no process under lazy spawn, so the
  catalog lists it `available:false` and the terminal route answers
  `410 session_gone`. Opening such a chat from the phone (`TabbyOpen`) posts
  `POST /projects/{id}/activate?tab=<tab id>`; the window starts that one chat
  (`startAssistantChat`, which also respawns a chat started earlier whose CLI
  has since quit). With no window the owner starts the stored chat detached
  (`headless::start_chat`) unless it is already running. No tab named starts
  none and answers `503 desktop_unavailable` with no window.
- No tmux on Windows, so no phone chat there.

## Known limits (accepted)

- **The conversation can leak through fetch URLs.** A page can make the model
  put chat text into a URL it fetches; the lane cannot tell that from a real
  fetch. There is nothing else to leak, so it is accepted.
- **Search queries leave the machine** even with a local model: to the SearXNG
  instance, to Ollama's API, or to the provider for cloud CLIs. The search
  client honours `HTTP(S)_PROXY` (the backend is the user's own trusted
  address; only the agent fetch ignores proxies).
- **DNS oracle.** `not_public` versus `fetch_failed` lets a model tell whether
  an internal name resolves to a private address. It learns that a name exists,
  never content; one category for both would hide real failures.
- **Any TCP port on a public host** is allowed: no more than the host already
  exposes, and docs and APIs run on other ports.
- **NAT hairpin.** A host whose only address is private can reach itself
  through its router's public IPv4 if the router loops back; nothing local
  matches, so it is not detected. The lane's resolved-address rule is the line.
- **A proxy-only network** breaks `web_fetch` by decision 15 (native search
  still works). The reader behind a proxy still skips the DNS pin.
- **Every signed-in CLI's login is in the home** (the login keeper places them
  in every home). The pinned tools cannot reach them; the user's own `!` can.
  Narrowing the keeper to the chat's CLI is possible and left out of v1.
- **`--ro-bind / /`** as above: system folders and paths outside `$HOME` are
  readable to the user's `!`.
- **Windows has no fence.** The CLI pinning still holds, but the user's `!`
  and `@` reach the files; the help topic says so. macOS uses the Seatbelt
  profile with the same empty roots (CLI install paths stay readable).
- **Prompt injection through search results** is the provider's side for
  server-side search; the lane's text is marked untrusted.
- No PDFs, no links in v1; Gemini needs a transcript reader first; the
  system prompt is not editable.

## Where things are

Backend: `services/assistant.rs` (profiles, `launch_line`, `new_chat_record`),
`services/web_lane.rs`, `commands/assistant.rs` (options, new chat, search
setup; all `core`, refuse with `assistant_off`), `mobile_control/assistant.rs`.
Frontend: `src/components/assistant/`, `stores/assistantScope.ts`,
`stores/assistantView.ts`, `components/layout/AttachedAgentPane.tsx`,
`lib/assistant.ts`. Phone: `mobile-web/src/scopeKind.ts`,
`assistantChat.ts`, `screens/TabbyOpen.tsx`, `components/TabbyHead.tsx`. User docs: `docs/help/assistant.md`.
