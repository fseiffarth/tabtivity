# Competitive landscape

Where Tabtivity sits relative to tools that claim overlapping ground. One section
per contender, newest first; the short list of partial-overlap tools lives at
the bottom.

**House rule for this file:** most contenders are closed source, so what is
written about them comes from marketing sites, launch posts, and press — not
from running them. Every claim about a competitor is marked as such. Never let
a vendor's own feature list harden into a fact about their product; the honest
comparison is *positioning vs. positioning*, plus whatever is independently
verifiable.

---

## PandaOS — `pandaos.ai`

*Assessed 2026-08-30. Sources: vendor site, launch post, company profile. Not
installed, not run. Closed source, beta/waitlist, freemium.*

### What it is

"The local AI workspace for builders" — code, terminals, browser, databases and
AI agents in one environment, where agents "operate your whole dev stack, not
just write code." A German company (PandaOS AI), founded 2026, unfunded per
Tracxn, currently in beta with a separate business edition aimed at operations
teams.

### The shared thesis

This is the closest thing to Tabtivity's first pillar that anyone is shipping, and
the framing is nearly word-for-word ours:

- one local workspace instead of scattered apps and terminals
- projects that keep their state, so switching context is not re-derivation
- agents that act on the environment rather than emitting code into a buffer
- explicitly local-first, not a browser IDE

Both are 2026, German, and in beta. It is worth treating the first-pillar
framing as contested, not owned.

### Where the bets diverge

| | **Tabtivity** | **PandaOS** (per vendor) |
|---|---|---|
| Core abstraction | Project = a *desktop*. Owns real OS windows (X11 / KWin / Win32 parking), default-app mapping, time tracking | Project = a workspace *inside* one app; editor, terminal, browser, DB embedded |
| Second pillar | Project = *any machine*. SSH-native without FUSE, multi-host, SLURM/HPC, containers, VMs — four trust tiers | Connected cloud stack: GitHub, Vercel, Supabase, Gmail, Slack; business edition adds Jira, Notion, HubSpot, Postgres, Outlook |
| Persistent context | Tabs, files, apps, git state, layout, external windows — restored per project | The same, plus a "local knowledge graph that learns your infra and workflows" |
| Agents | 26 built-in CLIs plus user-defined (Claude, Codex, Gemini, Ollama…), resumable sessions, per-tab Plan/Auto | Unspecified LLM with full-environment context; "reusable agent workflows" |
| Off-desk reach | Companion PWA over the user's own tailnet, into the same agent and shell tabs | None mentioned |
| Licensing | MIT OR Apache-2.0, public repo | Proprietary, freemium, waitlist |
| Audience | Researcher / multi-machine / cluster developer | Web "vibe stack" builder; second SKU for business operations |

### What PandaOS markets that Tabtivity genuinely does not have

Two things, and they are real gaps rather than framing differences:

1. **A persistent project knowledge graph.** Tabtivity's memory is *state* — layout,
   tabs, git, open apps, session ids. It is not *knowledge*: nothing accumulates
   a queryable model of a project's infrastructure that an agent can consult.
   The Agent Skills library is the nearest surface, and it is manual and static.
2. **Third-party service connectors.** Tabtivity has mail, CalDAV calendar, and a
   browser — self-hosted-shaped surfaces it renders itself. It has no GitHub,
   Jira, Notion, CI, or deploy-platform connectors at all. The loop PandaOS
   sells ("agent checks Vercel, pulls context from Gmail, deploys the fix") has
   no Tabtivity equivalent.

Whether either is worth adopting is a separate question. Connectors in
particular pull a local-first product toward stored OAuth tokens and cloud
round-trips, which cuts against the sandbox trust tiers and the
no-foreign-app-paths, no-password-by-default posture this codebase is built
around. Wanting the capability does not settle the design.

### What Tabtivity has that PandaOS shows no sign of

Real window management and per-project desktop swapping — PandaOS reads as a
container application, not a desktop layer. Remote execution of any kind.
HPC/SLURM. The container and VM trust tiers. The phone companion. Tiling tab
layout and native file viewers. And auditability: the whole thing is readable.

### Strategic read

PandaOS is not really a competitor to Tabtivity's differentiator. It is competing
with Cursor, Warp, and Coder for developers whose stack is a web app plus a few
SaaS dashboards. Tabtivity's second pillar — the project carries the machine it
runs on, SSH-native, cluster in the same cockpit — is a segment PandaOS is not
in, and one that is otherwise poorly served.

The collision is on the first pillar, and there the asymmetry runs the other
way: PandaOS is further along in *attention* (launch video, business SKU,
waitlist) while Tabtivity is further along in *depth* but unlaunched, with a large
backlog of features that are code-complete and never live-verified.

The defensible conclusion is not "we are ahead" or "we are behind." It is that
first-pillar framing alone will not distinguish Tabtivity, and the remote/HPC
pillar has to carry the positioning.

---

## Partial-overlap tools

None of these attempt the whole model; each covers one slice. Kept short on
purpose — expand an entry only when one of them moves onto Tabtivity's ground.

| Tool | Slice it covers | What it does not attempt |
|---|---|---|
| Raycast / Alfred | App launching | Project ownership of windows or state |
| tmux | Session restoration | Anything outside the terminal |
| i3 / Hyprland | Window orchestration | Project model, files, agents |
| VS Code Workspaces (+ Remote-SSH) | Project grouping, remote editing | Desktop-wide context, non-editor apps, HPC |
| Cursor | AI-native editing | Desktop layer, remote execution, multi-machine |
| Warp | AI-native terminal | Windows, files, project switching |
| Coder | Governed remote dev workspaces | Local desktop context; server-provisioned, not project-carried |

The combination Tabtivity claims — project ownership of apps *and* windows,
desktop-wide context restoration, AI-native workflows, *and* the machine the
project runs on — is still uncontested as a whole.
