---
id: assistant
title: Tabby, the chat assistant
keywords: [tabby, assistant, chat, chatbot, web search, search the web, searxng, ollama search, experimental, phone, mobile, question, no files]
related: [agent-clis, local-models, mobile, claude-code, codex, troubleshooting]
---

Tabby is a chat assistant that can search and read the web and cannot see
anything on your computer: no files, no projects, no mail or calendar, no MCP
servers. Use it for questions that need no project ("what does this error
mean", "find me the paper on X"). It is experimental and off by default.

## Turn it on

1. **Settings → System → Experimental**: switch **Tabby** on.
2. A chat-bubble button appears in the top bar after the to-do button, and
   **Settings → Agents** gets a **Tabby** page.
3. Click the button to open the chat window. With no chats it shows **New chat**.

Switching it off again removes the button and the phone row and stops Tabby's
web access.

## Choose a CLI and model

New chat offers the CLIs you have installed and, for local models, one entry per
Ollama model:

| Choice | Runs on | Web search |
|---|---|---|
| **Claude** | your Claude Code login | built in |
| **Codex** | your Codex login | built in |
| **OpenCode** with a local model | Ollama on this machine | needs search set up (below) |
| **Claude Code** with a local model | Ollama on this machine | needs search set up (below) |

A CLI you are not signed in to shows a **Sign in** card that opens the login in
a terminal tab; press **Check again** afterwards. **Settings → Agents → Tabby**
sets the default CLI and model. The chat shows in the Reader, like any agent
tab; each chat keeps its own conversation across restarts.

Codex needs a model list that Codex writes once it has run anywhere in
Tabtivity. If the first Codex chat says to start Codex once, open a Codex tab in
any project, then try again.

## Web search for local models

Claude and Codex search the web themselves. A local model cannot, so Tabby gives
it a search tool backed by one of two services you choose in **Settings →
Agents → Tabby** (the new-chat view shows the same form as a **Set up web
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
(on by default) puts a **Tabby** row on the phone's Home screen. Open it for the
chat list; **＋** starts a chat (the same CLIs and local models as on the
desktop, dimmed when not ready). A chat shows as **Not running** after the
desktop restarted: tap it to start it. The phone's chat has no files, outbox,
upload or Commit buttons. Tabby works from the phone with the desktop window
closed as long as Tabtivity is running. Turning the phone switch off removes
the row. There is no phone chat on Windows (it needs tmux).

## Troubleshooting

- **No button in the top bar**: the Experimental switch is off.
- **A model says it cannot search**: local models need a search service set up.
- **`not_public` on a page you can open in your browser**: the address is on
  your own network or computer, which Tabby refuses by design. Behind a
  proxy-only network Tabby's page fetch does not work, but Claude's and Codex's
  built-in search still does.
- **A local model is not listed**: Ollama is not running or has no model
  pulled (see the local-models topic).
