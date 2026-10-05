/**
 * Persistent remote sessions (TODO #85) — the frontend half of the tmux wrap.
 *
 * A remote shell/script tab can run inside a **tmux** session on the host, so a
 * long run survives an SSH drop, a laptop sleep, or Tabtivity quitting: the session
 * keeps running and the tab reattaches on reconnect/relaunch. The backend
 * (`services::ssh_exec`) owns the actual wrap; these helpers decide *whether* a
 * tab persists and mirror the session-name derivation so the frontend can address
 * a session it did not just spawn (the Sessions view, the explicit-close kill).
 */

import type { RemoteSpec } from "../../types";
import { NAMES } from "../brand";
import { tmuxSessionRest } from "../brandMigration";

/**
 * A project id can appear verbatim in a tmux session name (it's practice a uuid),
 * but is not schema-guaranteed to be — mirrors the backend's `sandbox::sanitize_key`
 * so an oddly-shaped id can never produce an invalid session name.
 */
function sanitizeForTmuxName(id: string): string {
  const safe = id.replace(/[^A-Za-z0-9_-]/g, "_");
  return safe || "x";
}

/**
 * Mint a fresh, stable tmux session name for a shell tab or a remote agent tab.
 * Minted **once** at tab creation and **persisted** on the tab
 * (`TabEntry.tmuxSession`), because the tab's
 * PTY id (`<scope>:<tab-key>`) is NOT stable — `loadFromLayout` regenerates the key
 * on every restart — so deriving the name from the id would create a *second*
 * session on relaunch instead of reattaching. A uuid is inherently tmux-safe
 * (`[0-9a-f-]`, no `:`/`.`), so it needs no sanitising.
 *
 * `scope` (the owning project id, or `"root"`/a box id) is embedded right after
 * the `tabtivity-` prefix, separated from the uuid by a `--` that can never occur
 * inside either half (uuids and project ids are single-hyphenated) — so the
 * Sessions view (`remote_tmux_list`) can tell one project's sessions apart from
 * another's on a host multiple projects share, instead of listing every session
 * on the host for every project.
 *
 * `kind` (`"agent"` for a Claude/Codex tab, `"shell"` for an interactive shell or
 * a Python/script run) is embedded as a token right after the `--`, i.e. at the
 * *front* of the uuid half — never before the `--`, so it cannot disturb the
 * project-id prefix the Sessions view filters by (`session_visible_for_project`).
 * It is what lets the Sessions view group a machine's sessions by type; a uuid is
 * hex (`[0-9a-f-]`) and can never begin with `agent`/`shell`, so an older name
 * with no token (or a hand-renamed one) reads back as `"other"` and is never
 * misclassified. See {@link sessionKindFromName}.
 */
export function newTmuxSessionName(scope: string, kind: TmuxSessionKind = "shell"): string {
  return `${NAMES.tmuxPrefix}${sanitizeForTmuxName(scope)}--${kind}-${crypto.randomUUID()}`;
}

/**
 * The kind of tab a persistent tmux session backs, for the Sessions view's
 * per-machine grouping. `"other"` is every session whose name carries no
 * recognizable token: a foreign/hand-started one, one hand-renamed through the
 * Sessions view, or one Tabtivity minted before the token existed.
 */
export type TmuxSessionKind = "agent" | "shell" | "other";

/**
 * Classify a tmux session by its name — the inverse of {@link newTmuxSessionName}.
 * Reads the token at the front of the uuid half (`tabtivity-<scope>--<kind>-<uuid>`),
 * which is the only place a kind is recorded; anything the token does not name is
 * `"other"`, so an unrecognized/foreign/legacy session degrades gracefully rather
 * than being forced into one of the two real buckets. Pure — the Sessions view's
 * grouping is a function of the name and nothing the backend has to report.
 */
export function sessionKindFromName(name: string): TmuxSessionKind {
  const sep = name.indexOf("--");
  // Under the current prefix or the one an older build minted.
  if (tmuxSessionRest(name) === null || sep < 0) return "other";
  const rest = name.slice(sep + 2);
  if (rest.startsWith("agent-")) return "agent";
  if (rest.startsWith("shell-")) return "shell";
  return "other";
}

/**
 * Whether persistent sessions are enabled for a remote project. **Default ON** —
 * `undefined`/`true` mean enabled; only an explicit `false` (the pill's toggle)
 * opts out. `undefined`/local projects → off (there is no host to persist on).
 */
export function persistSessionsEnabled(remote: RemoteSpec | undefined | null): boolean {
  return !!remote && remote.persist_sessions !== false;
}

/**
 * Whether THIS tab should be tmux-wrapped: a **shell** tab (interactive shells and
 * Python/script runs, which open a shell tab) or an **agent** tab (Claude, Codex,
 * any SSH-hosted agent CLI) running on a **remote host** (`hostId` non-null) of a
 * persist-enabled remote project. files/embed/monitor panes (no PTY) are excluded,
 * as is a **local** agent (`local_agent`, host-bound Ollama — `hostId` is null,
 * and its local path is not persisted here either).
 *
 * An agent tab now gets a persisted tmux name in addition to its `--resume` restore,
 * and the two **compose** via `tmux new-session -A`: on relaunch, if the host session
 * is still alive it reattaches the still-running agent (the `--resume` target is
 * ignored); if it is gone, `-A` creates a fresh session that runs `--resume` and the
 * conversation resumes as before. The name must be persisted across relaunch (a name
 * derived from the regenerated PTY id would fork a second session instead of
 * reattaching) — exactly the reason shell tabs persist their minted name.
 *
 * `ephemeral` is the per-tab opt-out (`TabEntry.ephemeral`): a tab whose work is
 * re-openable and not worth a daemon on the host. It exists because the project
 * toggle is too blunt for a cluster — switching `persist_sessions` off to stop a
 * `tail -F` outliving the app would also drop the `srun --pty` session that is the
 * whole point of persisting, so the exemption has to be the tab's, not the
 * project's.
 */
export function shouldPersistTab(
  kind: string,
  hostId: string | null,
  remote: RemoteSpec | undefined | null,
  ephemeral?: boolean,
): boolean {
  return (
    (kind === "shell" || kind === "agent") &&
    hostId !== null &&
    !ephemeral &&
    persistSessionsEnabled(remote)
  );
}

/**
 * Whether THIS tab should be tmux-wrapped **locally** (TODO #85): a **shell** tab
 * (interactive shells + Python/script runs) that runs on the **local machine** —
 * a local project's tab, or a remote project's local (mirror) tab. `localEnabled`
 * folds the `persist_local_sessions` setting **and** the platform check (off on
 * Windows, where there is no tmux). Keeps the run alive across a Tabtivity crash
 * and reattaches on restart.
 *
 * The **root** scope is included, and the `scopeKey !== "root"` gate that used to
 * exclude it was left over from when root tabs were not persisted at all: with
 * nothing restoring them, a surviving tmux session had no tab to reattach to and
 * was a daemon nobody could reach. Root tabs restore like a project's now, and
 * they already carry a minted `tmuxSession` name (`withTmuxSession` never
 * excluded root) — so the exclusion had stopped meaning anything except that a
 * long build started in the root terminal was the one shell a Tabtivity crash
 * still killed. **Box** scopes are included for the same reason since they
 * persist + restore first-class (`sessions/box_<id>/`): a box shell's tmux
 * session has a tab to come back to, so it persists like root's/a project's.
 *
 * An agent tab — a local-model one (`local_agent`) included — is wrapped only in
 * a Mobile-access scope, and only when it comes back after a restart
 * (`resumableAgent`: a resumable agent, or a relaunchable local-model tab), so
 * the phone always has a restored tab behind the session it attaches to.
 */
export function shouldPersistLocalTab(
  kind: string,
  scopeKey: string,
  localRunning: boolean,
  localEnabled: boolean,
  mobileAccess = false,
  resumableAgent = false,
): boolean {
  return (
    (kind === "shell" ||
      ((kind === "agent" || kind === "local_agent") && mobileAccess && resumableAgent)) &&
    (scopeKey !== "root" || kind === "shell") &&
    localRunning &&
    localEnabled
  );
}
