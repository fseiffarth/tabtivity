# Global agent security level — proposed plan

Status: design only; no implementation has been made.

## Intent and levels

Add one five-stage selector in Settings. It is a global **ceiling** on what AI
agents may access. Existing project fence overrides, root/MCP chips, mail
sharing, and per-session grants can narrow access further; selecting a level
does not turn those finer permissions on. Ordinary project UI and human-operated
shell tabs remain available at every level.

| Level | Maximum agent access |
| --- | --- |
| 1 — Project only | No AI agent process may start. |
| 2 — Project + CLIs | Agent CLI tabs may run, without configured MCP servers or Tabtivity agent tools. |
| 3 — + Mail | Level 2 plus Tabtivity's existing root tools (projects, calendar, to-do) and its mail tools, subject to their existing opt-ins and role restrictions. |
| 4 — + Phone | Level 3 plus project files published to a paired phone through `tabtivity-send`. |
| 5 — + MCPs | Level 4 plus other configured MCP servers and Tabtivity MCP integrations. |

“Phone” means agent-to-phone file sharing, not permission for a phone to control
agent tabs. The paired-phone access settings remain separate. “MCPs” at level 5
means other servers; level 3 necessarily uses Tabtivity's built-in MCP transport
for its root and mail tools. The existing mail rules still apply: a cloud root
agent can draft but cannot read mail, local-model reading needs its own opt-in,
and account/message sharing still bounds reads. The level is not the agent
CLI's own permission mode.

## Enforcement and compatibility

- Persist a validated `agent_security_level` in settings and make the backend
  authoritative for every agent spawn, resume, tool call, and phone outbox
  request. Existing installations without the field receive level 5 to
  preserve current access; a fresh installation starts at level 2. Resolve and
  persist this distinction before any agent launch or access decision.
- Level 1 refuses every agent launch path, including local-model tabs, tabs
  requested from the phone, scheduled/background launches, and resumes. A
  downward change revokes tool sessions and terminates running agent tabs
  immediately; they may restart only under the new level. Apply this at the
  backend boundary, including changes made by another window.
- At levels 2–4, launch only agents whose effective configuration Tabtivity can
  verify contains no user-configured MCP servers. The initial supported set is
  Claude, Codex, Gemini, and Tabtivity's local-model agent. Isolate their user and
  project MCP configuration, inspect launch arguments, and inject only the
  Tabtivity tools allowed by the level and finer controls. Refuse other/custom
  agents and environments whose isolation cannot be verified, including remote
  hosts and Windows. Apply the same rule to containers and VMs: allow a launch
  only after its configuration boundary is verified. Level 5 uses the existing
  CLI configuration behavior.
- At level 2, withhold Tabtivity's root, help, and schedule MCP wiring and refuse
  existing tokens. At levels 3–4, expose only the existing root and mail tool
  families permitted by the finer controls; help, schedule, and other MCP
  integrations wait until level 5. Server-side tool listing and calls must
  enforce the ceiling even for a token minted before a setting change.
- Below level 4, refuse the phone's project outbox list and file routes and
  hide the outbox UI. This also hides files manually placed in
  `.tabtivity/outbox/`, since the sidecar cannot distinguish their author.
  Raising the level does not change device pairing or enable phone control.

The “no MCPs” guarantee below level 5 is about configured MCP servers and
Tabtivity-issued MCP access. An agent with ordinary shell and network access can
still contact a server as a normal process; these levels do not block arbitrary
network or subprocess activity. Existing fence and container boundaries remain
separate controls. On a platform where the verified configuration boundary is
unavailable, refusal is required rather than silently weakening the level.

## UI and verification

Put the selector in Settings with all five names and a short description of
what each stage permits. Show that existing detailed controls remain active
within the ceiling. Put all display strings in `src/lib/i18n.ts`, and register
an `UntestedTag` for the new, not-live-verified control.

Test settings migration and JSON round trips; every launch and resume path;
unsupported CLI and host refusal; configuration isolation for the four
supported agents; tool listing and call denial across level changes; existing
mail opt-ins; phone outbox refusal; and immediate termination on a downward
change. Run all repository gates, `git diff --check`, and
`npm run backend:stale`. Do not launch or restart Tabtivity; provide desktop and
phone click-through steps for live verification.
