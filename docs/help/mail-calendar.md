---
id: mail-calendar
title: Mail, calendar, to-do board and browser
keywords: [mail, email, imap, smtp, address book, contacts, vcard, ldif, thunderbird import, autocomplete, calendar, caldav, ics, event, reminder, todo, board, browser, web, agent column, docked agent, approvals]
---

These surfaces are machine-wide, not per project. They open as overlays over
the whole window from their header indicator, or from the `+` menu.

## Mail

An IMAP/SMTP client with keyword rules, local-model help with drafts and
summaries, and encryption for what is stored on this machine. It is
experimental: switch it on in **Settings → System → Experimental** (Mail
client). The mail assistant runs only on a local Ollama model that you assign
to the **Mail** role in the Models & agents menu; nothing about your mail
leaves the machine. See `local-models`.

### Address book

**Address Book** in the mail toolbar opens your contacts in a tab of the mail
window. As in Thunderbird, there are two books. **Personal** holds the
contacts you add. **Collected Addresses** fills itself: after a send, each
recipient without a card is added (switch this off at the bottom of the
book's left column). A card holds a name, nickname, several addresses, phone
numbers, organization, postal address, birthday and notes. Mailing lists
group addresses under one name. **Import…** reads vCard (`.vcf`), LDIF
(`.ldif`) or a Thunderbird `abook.sqlite`; **Export…** writes vCard. An
imported card whose address is already in the book is merged into that card
rather than duplicated.

**From Thunderbird** imports every address book of every Thunderbird profile
on this computer, mailing lists included. Thunderbird's files are only read,
never changed. Its Collected Addresses go to Collected; everything else goes
to Personal. **Add from Inbox** adds the sender of every downloaded Inbox mail
to Collected Addresses. It skips automated senders (`noreply@…`, bounces,
the mailer daemon) and your own addresses, and it only uses mail already on
this machine.

While you type in To, Cc or Bcc, matching contacts and lists appear below the
field. Use ↑/↓ to move, Enter or Tab to pick, and Escape to close the list.
A list expands to its members' addresses. A contact's full nickname is
suggested first. The ☆ beside a message's sender adds them to the book, and
the ★ opens the card you already have. The address book stays on this
machine, encrypted with the rest of the local mail store.

## Calendar

Events, reminders, and `.ics` import and export, with CalDAV sync that merges
by resource instead of replacing what is already there. Open it from the
header's calendar indicator or `+` → Calendar. Drag in the grid to create an
event.

## To-do board

A board of cards in columns over the same to-dos the calendar keeps — steps,
tags and due dates included. Open it from the header's board indicator.

## Browser

A reader-mode browser tab: text and images, no scripts, with one deliberate
click out to the real page. It is experimental: switch on **In-app browser** in
Settings → System → Experimental, then use `+` → Browser.

## Agents and the calendar

Agents in the root console with the **MCP** chip on get Tabtivity's root tools
(calendar, board, project list). See `tabs-and-panels`.

## An agent beside the mail, calendar or board

In the mail, calendar or to-do window, the ✦ button in the title bar (hover
shows its chord) or **Ctrl+1** docks your default agent in a column on the
right of that window; **Ctrl+2 … Ctrl+9** dock the root console's other
agents, numbered as its `+` menu numbers them. You type a request beside the
app and watch the result land in it.

- **It is a root-console agent.** The tab lives in the root console and shows
  there as an ordinary tab. It gets the calendar, board and project tools only
  if the agent wears the **MCP** chip in the Models & agents menu (the ⚿ badge
  in the column's header says whether the tools are on). Mail tools come only
  with **Agents get Tabtivity's mail tools** in Settings → Agents → Root
  console and MCPs, and a cloud agent can then only write drafts, never read.
- **Only Root-chip agents.** If your default agent has no **Root** chip,
  Ctrl+1 shows "Allow <agent> in the root console: Models & agents → Root
  chip" in the column instead. Any other number with no agent behind it is
  left to the app.
- **Hiding keeps the conversation.** × (or a double-click on the column's
  left edge) hides the column; ✦ or the same number brings the same agent
  back. Closing the window ends nothing. Another number docks a new tab; the
  previous one keeps running in the root console. Drag the left edge to
  resize.
- **↗** moves the agent to the root console. While the console is open the
  column shows "Shown in the root console"; close the console and it is back.
- **Escape** typed in the agent goes to the agent (Claude's cancel key), not to
  the window. Click in the app first to close the window with Escape.
- **Approvals.** By default an agent's writes wait in the window's
  **✓ Approvals** pill, which lists that window's own proposals (mail drafts
  in the mail window). A new event or card flies into the view when it
  lands — on your ✓, or at once when review is set lower. Edits to existing
  rows don't animate.
