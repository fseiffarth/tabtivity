---
id: assistant
title: Tabby, the chat assistant
keywords: [tabby, assistant, chat, chatbot, web search, search the web, searxng, ollama search, experimental, phone, mobile, question, no files]
related: [agent-clis, local-models, mobile, claude-code, codex, troubleshooting]
---

Tabby is a chat assistant that can search and read the web and look things up
in Tabtivity's own help, and cannot see anything on your computer: no files, no
projects, no mail or calendar, no MCP servers of yours. Use it for questions
that need no project ("what does this error mean", "find me the paper on X",
"how do I sync a remote project?"). It is experimental and on by default.

## Turn it on

1. Tabby is on in a new install. If it was switched off, switch **Tabby** on
   again in **Settings → System → Experimental**.
2. A small Tabtivity-mark icon (a ring with a tree and two hexagons) appears
   on the side panel's edge bar, below Files, Git, Apps and Agents (and as a
   button in the panel's own row of views), and **Settings → Agents** gets a
   **Tabby** page.
3. Click the icon to open the side panel on Tabby. Tabby is one chat: it opens
   on your last chat (resumed where you left it), or starts a new one on your
   default CLI straight away. Click the icon again to close the panel; the chat
   keeps running.

Switching it off again removes the icon and the phone button and stops Tabby's
web access.

## Choose a CLI and model

The dropdown at the top of the Tabby view lists the CLIs you have installed;
a second dropdown picks the model (Claude's and Codex's own models, or the
Ollama model for a local one). Picking another CLI starts a fresh chat on it in
place of the current chat; picking another model restarts the same chat on it
and keeps the conversation. **Relaunch** beside it
starts a fresh session of the same CLI (the current conversation ends).

| Choice | Runs on | Web search |
|---|---|---|
| **Claude** | your Claude Code login | built in |
| **Codex** | your Codex login | built in |
| **OpenCode** with a local model | Ollama on this machine | needs search set up (below) |
| **Claude Code** with a local model | Ollama on this machine | needs search set up (below) |

A CLI you are not signed in to shows a **Sign in** card that opens the login in
a terminal tab; press **Check again** afterwards. **Settings → Agents → Tabby**
sets the default CLI and model. The chat shows in the Reader, like any agent
tab, and keeps its conversation across restarts.

Codex needs a model list that Codex writes once it has run anywhere in
Tabtivity. If the first Codex chat says to start Codex once, open a Codex tab in
any project, then try again.

## Web search for local models

Claude and Codex search the web themselves. A local model cannot, so Tabby gives
it a search tool backed by one of two services you choose in **Settings →
Agents → Tabby** (a local-model chat shows the same form as a **Set up web
search** card):

- **SearXNG**: the address of a SearXNG instance (`http` or `https`, no query
  string).
- **Ollama web search**: an Ollama API key. The key is stored in the OS
  keychain, is never shown again and never written to `settings.json`.

Without either, a local chat can still read pages you name but cannot search.

## What it can and cannot see

- It cannot read your files, projects, folders, mail, calendar, to-do list,
  terminals or other agents' conversations. Each chat starts in its own empty
  folder with a home that holds only the CLI logins.
- It cannot use your MCP servers, skills or the settings you gave other agents.
- It can read Tabtivity's help (the `tabtivity-help` tools, see ask-tabtivity):
  the same read-only user docs every agent tab gets, built into Tabtivity and
  holding nothing of yours. It follows the same switch as for other tabs; a
  chat started before the switch changed picks it up when it restarts.
- It can read public web pages through Tabtivity: only addresses that resolve to
  the public internet. `localhost`, addresses on your network, this computer's
  own addresses and redirects into them are refused (`not_public`). It reads
  HTML, text and markdown, not PDFs, and gets no links back.
- Limits: 120 web calls per chat per hour.
- Your questions and the pages it opens leave your computer: search queries go
  to the search service, or to the provider for Claude and Codex. A page can
  trick the model into putting chat text in a web address it fetches, so do not
  paste secrets into a chat.

Your own `!` shell escape or `@file` mention in the chat's terminal is not
limited by what the model can do. On Linux and macOS it runs inside the agent
sandbox with an empty folder, but the sandbox still shows system folders and
the logins of your signed-in agent CLIs. **On Windows there is no sandbox**, so
`!` and `@` reach your files there; Tabby's own tools stay limited to the web.

## From the phone

With the experimental switch on, **Settings → Mobile → Tabby from the phone**
(on by default) puts a round Tabby button (the same icon) just above the
phone's tab bar on Home; Tabby is not listed among the projects. Tap it for the
same one chat as on the desktop: the last chat, started again if the desktop
restarted, or a new one on the default CLI. In the chat, tap the CLI name at the
top to pick another CLI (dimmed when not signed in on the desktop), the model
name under it to switch the chat's model, or the ↻ button to relaunch a fresh
session. The phone's chat has no
files, outbox, upload or Commit buttons. Tabby works from the phone with the
desktop window closed as long as Tabtivity is running. Turning the phone switch
off removes the button. There is no phone chat on Windows (it needs tmux).

## Troubleshooting

- **No Tabby icon on the side panel's edge bar**: the Experimental switch was
  turned off. With no project open the side panel (and its bar) is not shown at all;
  open a project or the root folder first.
- **A model says it cannot search**: local models need a search service set up.
- **`not_public` on a page you can open in your browser**: the address is on
  your own network or computer, which Tabby refuses by design. Behind a
  proxy-only network Tabby's page fetch does not work, but Claude's and Codex's
  built-in search still does.
- **A local model is not listed**: Ollama is not running or has no model
  pulled (see the local-models topic).
