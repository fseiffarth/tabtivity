---
id: ask-tabtivity
title: Ask Tabtivity — the built-in help for agents
keywords: [help, ask, question, mcp, tabtivity-help, documentation, how to, agent tools, search help]
---

Tabtivity ships this help as a small read-only MCP server named `tabtivity-help`.
Agent tabs can call it, so you can ask your agent how to do something in
Tabtivity and it looks the answer up here instead of guessing.

## How to use it

Just ask in an agent tab, in plain words:

- "How do I install a local model in Tabtivity?"
- "Using the tabtivity-help tools: how do I sync a remote project?"
- "Why doesn't Gemini show up in my + menu?"
- "What does Tabtivity navigation do?"
- "How do I run a project inside a Docker container?"

Naming "tabtivity-help" or "Tabtivity's help" in the question makes it more likely
the agent reaches for the tools. The agent searches the topics, reads the best
match and answers from it.

## Which tabs have it

- **Claude** and **Codex** tabs on this machine — in a project or in the root
  console, sandboxed or not. Tabtivity adds the server to their command line.
- **Local Model** tabs whose model has the **MCP** chip on in the Models &
  agents menu (the model must support tool calling).
- Other agent CLIs receive the server's address and token in their
  environment (`TABTIVITY_HELP_MCP_URL`, `TABTIVITY_HELP_MCP_TOKEN`) but are not
  configured to use it automatically.
- Not in tabs that run on a remote host, inside a VM project, or inside a
  project container: the server listens only on this machine's loopback. A
  remote project's agent tabs that work in the local mirror (the default) do
  get it.

The server is wired in when a tab starts; a tab opened before an update gets
it after reopening. Claude asks you to approve the tool the first time it
calls it; Tabtivity grants no permission on your behalf.

## The tools

| Tool | What it does |
|---|---|
| `tabtivity_help_search` | Find topics and sections matching a question (up to 10 hits) |
| `tabtivity_help_read` | Read one topic, or one section of it |
| `tabtivity_help_topics` | List every topic with its sections |
| `tabtivity_help_status` | Tabtivity version, OS family, topic count, which CLIs get the server |

All are read-only and bounded. The help knows nothing about your projects,
files or settings, and cannot change anything.

## Turn it on or off

It is on by default. The switch is on the **Ask Tabtivity** page of the How to
start introduction (Settings → General → Hints & onboarding → How to start).
Turning it off stops it for newly opened tabs; the setting is `help_mcp` in
`settings.json`.

## Topics

getting-started, projects, remote-projects, tabs-and-panels, keyboard,
agent-clis, claude-code, codex, gemini-cli, local-models, sync, mobile,
mail-calendar, containers-boxes, ask-tabtivity, troubleshooting.
