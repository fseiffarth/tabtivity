# Cockpit MCP — small workspace conveniences

Status: implemented, 2026-11-06; never live-tested.
Focused verification: build, five Rust tests, 92 frontend tests, lint, brand
and whitespace checks passed. Full-tree verification uses `scripts/gates.sh`.
As-built details and v1 limits: `docs/context/cockpit_mcp.md`.
User request: a new Tabtivity cockpit MCP with low security relevance,
starting with tab renaming.

## First delivery

Give an agent a `tab_rename` tool that changes the display label of its own
Tabtivity tab. Example: an agent working on keyboard navigation calls
`tab_rename({"label":"Keyboard navigation"})`; the desktop, cockpit roster
and phone eventually show that label, and it survives restoration.

Proposed v1 scope: self only. The agent supplies no project, tab, path or
tmux identifier. Its authenticated spawn binding identifies the target.
The cockpit name describes the workspace convenience tool family; receiving
the tool does not grant control over the cockpit's other tabs.

## Tool contract

Server: `<slug>-cockpit`, built from the brand module. Dedicated route:
`POST /mcp/cockpit`. First and only v1 tool: `tab_rename`.

```json
{"label":"Keyboard navigation","expectedLabel":"Untitled"}
```

- `label` is required. Trim outer whitespace, reject empty or oversized names
  using the existing `MAX_TAB_LABEL` limit. Reject control characters and
  invisible/bidi formatting that can disguise the label; retain ordinary
  international text. Extract a shared validator from the phone's
  `host.rs::clean_tab_label` and strengthen it for these cases.
- `expectedLabel` is optional. If supplied, compare against the stored label
  under the mutation lock and return `conflict` when it differs. This supports
  callers that know the old label without adding a separate read tool.
- Reject unknown keys and non-string values. No clear/reset meaning for an
  empty string. Duplicate labels across tabs remain allowed.
- Return only `{status: "renamed" | "unchanged", label}` on success. The
  returned label is the committed value. An identical label is a no-op.
- Fixed failures: `invalid_label`, `conflict`, `tab_not_found`,
  `unavailable`, `rate_limited`, `storage_error`. Authentication and wrong-route
  failures use the existing listener's admission errors. Never return raw
  paths, tokens or storage errors.

This is a user-style rename: change `label`, preserve the task/automatic-title
fields, and use the existing label precedence so later automatic naming does
not overwrite the chosen display name. No change to tmux/session names,
processes, working directories, tab order, focus or project names.

## Authority and exposure

- Add `Caller::Cockpit` as its own token lane and positive tool-policy entry.
  Its token reaches only `/mcp/cockpit`; other lanes cannot invoke this tool.
- Bind the trusted state directory, scope, persistent workspace tab id and
  live spawn generation on the host. A frontend tab key is re-minted on
  restore and is not a durable identity. Resolve the binding from the actual
  launch/registry, never from a project file or tool arguments.
- Grant only after the launching tab has a persistent workspace identity;
  fail closed during creation/restore if that identity is not ready. Closing,
  revoking or replacing the spawn invalidates its old token. A reopened tab's
  new identity must not be reachable with the old token. Renaming the label
  must leave the grant valid.
- Proposed default: enabled for eligible local project and root agent tabs,
  with one off switch under Manage CLIs → Tools. Root tabs receive exactly
  the same self-only authority; handle existing reserved scopes explicitly
  without weakening registry checks through `storage::is_reserved_scope`.
- Preserve the assistant's pinned web/help tool set. No v1 grant for Tabby,
  mail-reader VMs, remote/worker/container tabs, or unsupported CLIs. Follow
  the help lane's existing CLI support and fence-safe transport; add no tunnel
  and edit no external CLI configuration.
- Use the listener's existing loopback/Host/Origin/bearer/body bounds. Add a
  per-spawn mutation budget (30 calls/minute, counting invalid calls)
  and a bounded metadata-only audit: time, caller, outcome; no label text.
  Renaming is reversible and should not create approval cards.

## Storage and clients

The existing workspace service owns the authoritative tab record.
`services/workspace.rs::rename_tab_in` already patches a label under the
session lock but locates tabs by tmux name. Add a helper targeting the stable
workspace id, with the optional label comparison and version stamping in the
same transaction. Share the mutation core with the current rename helper;
do not implement an MCP-specific session-file writer or whole-document save.
Preserve unknown fields and legacy session shapes. Missing/corrupt state is
an error, never an empty replacement file.

The write must remain visible when a desktop client has an older snapshot.
Use workspace versions and the existing patch/refresh machinery:
`commands/projects.rs` workspace commands, `WorkspacePatchHost`, and
`tabs.ts::{applyWorkspacePatch,adoptSyncOutcome,refreshWorkspaceScope}`.
An event is a refresh hint after commit; failure to deliver it must not turn
a committed rename into a reported storage failure. Cover detached windows,
inactive scopes and the cockpit without switching focus or hydrating scopes.

Serve local desktop-launched and headless Mobile-host-launched tabs from
their respective existing MCP listeners, sharing the service implementation.
The headless path must persist the rename without an open window and use the
existing cross-process refresh bridge. Do not assume an in-process workspace
event reaches the other process. Hosted daemon support follows the same core
with per-user state isolation; verify that branch's actual integration before
claiming server support (`docs/server.md`).

## Later candidates

Only the rename tool ships in the first slice. Each addition gets a separate
contract and authority review before it becomes part of this lane.

| Candidate | Bound | Reason to consider it |
|---|---|---|
| `tab_get_info` | Own tab: label, palette colour, tab kind | Lets an agent inspect its presentation without terminal content or paths. |
| `tab_set_color` | Own tab, existing palette id or reset | Small reversible visual grouping. |
| `cockpit_get_counts` | Current scope, aggregate busy/waiting counts | A compact status summary; assess activity disclosure before adding. |

Cross-tab rename/listing requires a separately granted scope and opaque ids;
it is outside v1. Even read-only workspace enumeration can expose private
project names and activity. Leave terminal reads, prompt/key injection,
open/close/restart, scheduling, commands, files, git, credentials, permissions,
network settings and approval actions with their existing authorities.

## Implementation sequence and acceptance

1. **Workspace mutation core.** Add stable-id rename and shared validation.
   Prove version increments, preserved fields, no-op, stale-label conflict,
   legacy round-trip and read-error preservation with focused Rust tests.
2. **MCP lane.** Add AppHandle-free `services/mcp/cockpit_mcp.rs`, module
   exports, caller/policy/route admission, token lifecycle, bounded RPC and
   results. Wire through `root_mcp::grant_lanes` and the supported CLI launch
   paths. Test that forged target keys, foreign tokens, stale generations and
   wrong routes cannot rename any tab; test quotas and label bounds.
3. **Client convergence.** Connect post-commit refresh to desktop and headless
   listeners. Test two-client stale snapshots, detached/inactive tabs, manual
   rename versus MCP rename, automatic-title precedence, and restore. A
   concurrent close must yield `tab_not_found`, never recreate the tab.
4. **Settings and delivery.** Add localized strings and a registered
   `UntestedTag` (`cockpit.mcp.rename`) on the new control. Update the backend
   and frontend filemap rows for files added/reshaped, help docs, and the
   relevant context doc. If a new Tauri command is needed, classify it and
   regenerate command classes; the MCP method itself is not a Tauri command.
5. **Verification.** Run `scripts/gates.sh` in the background for the touched
   diff, `git diff --check`, and `npm run backend:stale` after backend changes.
   Backend tests must remain portable and compile without desktop features.
   Never start, stop or restart the running app to apply this feature.

Live acceptance, after the user applies the new backend: rename a local agent
tab through MCP; see the same label in its strip, cockpit and phone; switch
scopes, detach/reattach, restore, and confirm the label persists. Repeat with
a phone-created tab while no desktop owns it. Verify disabled/revoked tokens
fail and Tabby still has only its pinned tool set. Record each platform
separately; clear the untested tag only after the user confirms testing.

## Repository anchors inspected

`services/root_mcp.rs` (lane grants and identities),
`services/root_mcp/root_mcp_security.rs` (positive policy),
`commands/root_mcp.rs` (routes and admission),
`services/mcp/help_mcp.rs` and `docs/context/help_mcp.md` (CLI exposure),
`services/workspace.rs` (locked versioned edits),
`services/mobile_control/host.rs` (phone rename validation and fallback),
`src/stores/tabs.ts` (display rename and workspace reconciliation),
and the workspace entries in `docs/filemap_{backend,frontend}.md`.
