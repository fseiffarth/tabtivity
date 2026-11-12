# Agent print MCP

A local project-agent tab can ask Tabtivity to print a PDF of its project.
Nothing prints until the user approves: the approval lives in the window's
own print preview, the "native printer menu" (decision 2026-11-10).

Tools on `/mcp/print` (`Caller::Printer`, server `<slug>-print`,
`services::print_mcp`):

- `print_request { file, copies?, pages?, grayscale?, duplex?, pagesPerSheet?, booklet?, note? }`
  → `pending` + id, at once.
- `print_status { id? }` — this tab's requests (one, or the latest ten).
- `print_cancel { id }` — withdraw a pending one.

Every refusal is a normal result with a fixed `category` (`invalid`,
`file_not_found`, `not_pdf`, `too_large`, `budget`, `pending_limit`, `off`,
`not_found`, `printing`). Budget: ten requests per tab per hour, two pending per tab,
eight pending in the process.

## Decisions (2026-11-10)

- **Approval surfaces, linked.** The shell popup (`PrintRequestsHost`,
  bottom-left, reusing the reminder popup's classes) and the Print Manager
  tab's "Agent print requests" card both list pending requests; **Review**
  opens the shared print preview (`printDocument`'s `approval` argument) on
  the request's PDF, titled with the asking tab, the agent's note under the
  title, Print reading **Approve & print**, and **Reject** beside it.
- **Approve opens the system print dialog** (`print_pdf_native`), so the user
  still picks the printer there. Two clicks, never zero. There is no apply
  level.
- **PDF only.** One render path (pdf.js preview + `layoutPrintPdf` vector
  job), the smallest surface.
- **Every CLI on a local project** gets the token; only Claude, Codex and
  tool-tagged local Vibe can use it today, because only they get an MCP
  server written into their launch (`root_mcp::wire_named_cli_args`). Wiring
  the other CLIs is a follow-up for all lanes (`todo/agents.md`).

## Invariants

- **The approved bytes are the requested bytes.** The file is read once, at
  the call, from the `projects.json` folder (never the in-folder
  `project.json`): `markup_mcp::resolve_file` (lexical, hidden names refused),
  then `mobile_control::files::open_served` (one checked name at a time, no
  link on the way), sniffed `application/pdf`, ≤ 24 MB, `%PDF-` head. The
  snapshot stays in memory; the preview and the printer get it via
  `print_mcp_pdf`. Rewriting the file after asking changes nothing.
- **The agent's layout reaches the preview** (`presetFor`): copies, a page
  range, grayscale, pages per sheet, two-sided, and booklet (which implies
  short-edge two-sided). The user can change any of them before approving.
- **The agent's options are never saved** as the user's printer preferences
  (`apply()` skips `savePrintOptions` in approval mode).
- **Approve claims first** (`print_mcp_decide` `claim`, gap 107): Pending →
  `printing` compare-and-set under the store lock, before anything is laid
  out or sent; a withdrawn, expired, closed or other-window-claimed request
  answers "no longer waiting" and nothing prints. While `printing`,
  `print_cancel` is refused (`printing`) and neither expiry nor the tab-exit
  sweep ends it; Reject is off. The window settles it `printed` (also after a
  `window.print()` it could open) or `release`s it back to pending when
  nothing was sent (layout or native print failed, dialog cancelled). A claim
  unsettled after 30 min (`PRINTING_TTL`, the window died) becomes
  `unconfirmed` — never withdrawn/expired — and a late `printed` still lands.
- **Window only.** `Runtime::serves_print` (root lane *and* web lane = the
  window) gates the grant; the Mobile host and a server daemon grant nothing,
  so the route authenticates nobody there. The three window commands are
  class `client`.
- The token is a lane secret like the others: `SpawnTokenGuard`, the PTY exit
  path (revoke + `sweep`), `tmux_local::SECRET_ENV` (slot 8641),
  `sandbox::is_secret_exec_env`, `launch_prep` control env, the push
  preflight's scrub list.
- Not on the local-models-only lane allowlist (`local_lane::MCP_ALLOWED`):
  a cut tab gets no print tools.

## State

In memory, like markup asks: a request ends printed, unconfirmed, rejected,
withdrawn, expired (24 h) or closed (its session gone); its bytes go the
moment it ends, the record (for `print_status`) 24 h after its request (or its
claim). A `printing` request counts against the pending caps. Changes ring `print-mcp-changed`
through a hook `commands::print_mcp` installs.

## User-run live QA

Agents never restart the app; after loading a build with this backend:

1. Settings → Manage CLIs: "Let project agents ask to print PDFs" is on.
   Open a fresh Claude tab in a local project with a PDF.
2. Ask the agent to print it, two copies, pages 1-2. A bottom-left popup
   appears; the Print Manager tab lists it.
3. Review: the preview shows the PDF, titled with the tab, copies 2 and pages
   1-2 preset. Approve & print opens the system dialog; print or cancel.
   After a print, `print_status` reports `printed` and the popup is gone.
4. Ask again, then Reject: `rejected`. Ask again and let the agent
   `print_cancel`: the popup disappears.
5. Ask for a `.txt`: `not_pdf`. Close the tab with a pending request: it
   disappears (closed).
