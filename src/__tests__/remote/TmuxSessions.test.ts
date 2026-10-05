/**
 * Persistent remote sessions (TODO #85) — the frontend half.
 *
 * Covers the pure decision/derivation helpers (session-name derivation MUST
 * mirror the backend `ssh_exec::tmux_session_name`; the default-ON gate; the
 * shell-only/remote-only persistence rule) and the restore round-trip that proves
 * a Sessions-view **attach** tab reattaches to the same named session after a
 * restart (its `tmuxAttach` survives save→load).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));

import {
  newTmuxSessionName,
  sessionKindFromName,
  persistSessionsEnabled,
  shouldPersistTab,
  shouldPersistLocalTab,
} from "../../lib/terminal/tmuxSession";
import { useTabsStore } from "../../stores/tabs";
import type { RemoteSpec } from "../../types";
import { BRAND, NAMES } from "../../lib/brand";

const remote = (over: Partial<RemoteSpec> = {}): RemoteSpec => ({
  host: "gpu.example",
  remote_path: "/home/me/proj",
  ...over,
});

describe("newTmuxSessionName", () => {
  it("mints a tmux-safe (uuid-based) name — no `:`/`.` that tmux treats specially", () => {
    const name = newTmuxSessionName("p1");
    expect(name.startsWith(NAMES.tmuxPrefix)).toBe(true);
    expect(name).not.toMatch(/[:.\s]/);
    // Distinct per call, so each shell tab owns its own host session.
    expect(newTmuxSessionName("p1")).not.toBe(name);
  });

  it("embeds the owning scope so the Sessions view can filter by project", () => {
    expect(newTmuxSessionName("proj-1")).toMatch(new RegExp(String.raw`^${BRAND.slug}-proj-1--`));
    // A scope with tmux-unsafe characters is sanitized, never dropped or thrown.
    expect(newTmuxSessionName("weird:scope.id")).toMatch(new RegExp(String.raw`^${BRAND.slug}-weird_scope_id--`));
  });

  it("embeds the tab kind AFTER the scope separator so the project prefix is untouched", () => {
    // The kind token sits at the front of the uuid half, so the `tabtivity-<scope>--`
    // prefix the Sessions view filters by is exactly as it was before the token.
    expect(newTmuxSessionName("p1", "agent")).toMatch(new RegExp(String.raw`^${BRAND.slug}-p1--agent-`));
    expect(newTmuxSessionName("p1", "shell")).toMatch(new RegExp(String.raw`^${BRAND.slug}-p1--shell-`));
    // Defaults to shell (the common case; both mint sites narrow the tab kind).
    expect(newTmuxSessionName("p1")).toMatch(new RegExp(String.raw`^${BRAND.slug}-p1--shell-`));
  });
});

describe("sessionKindFromName — the Sessions view's per-machine grouping", () => {
  it("round-trips the kind a minted name carries", () => {
    expect(sessionKindFromName(newTmuxSessionName("p1", "agent"))).toBe("agent");
    expect(sessionKindFromName(newTmuxSessionName("p1", "shell"))).toBe("shell");
  });

  it("classifies as `other` anything with no recognizable token", () => {
    // A legacy name minted before the token existed: a bare uuid after the `--`.
    // Hex can never begin with `agent`/`shell`, so it never misclassifies.
    expect(sessionKindFromName(`${BRAND.slug}-p1--fe80abcd-1234-5678-9abc-def012345678`)).toBe("other");
    // A foreign / hand-started session.
    expect(sessionKindFromName("train")).toBe("other");
    // A name that was hand-renamed through the Sessions view (no `--`).
    expect(sessionKindFromName(`${BRAND.slug}-my-run`)).toBe("other");
    // A scope that itself contains the token word must not leak across the `--`.
    expect(sessionKindFromName(`${BRAND.slug}-agent-repo--shell-abc`)).toBe("shell");
  });
});

describe("persistSessionsEnabled — default ON", () => {
  it("is on for a remote project unless explicitly opted out", () => {
    expect(persistSessionsEnabled(remote())).toBe(true); // undefined ⇒ on
    expect(persistSessionsEnabled(remote({ persist_sessions: true }))).toBe(true);
    expect(persistSessionsEnabled(remote({ persist_sessions: false }))).toBe(false);
    // No remote project ⇒ nothing to persist.
    expect(persistSessionsEnabled(undefined)).toBe(false);
    expect(persistSessionsEnabled(null)).toBe(false);
  });
});

describe("shouldPersistTab — shell/agent + remote host + enabled", () => {
  it("persists a remote shell OR remote agent tab, but never a local agent, a local tab, or an opted-out project", () => {
    expect(shouldPersistTab("shell", "primary", remote())).toBe(true);
    expect(shouldPersistTab("shell", "h1", remote())).toBe(true); // a worker host too
    // A remote agent tab now persists too: its tmux name composes with `--resume`
    // (reattach the live agent, else re-run the resume).
    expect(shouldPersistTab("agent", "primary", remote())).toBe(true);
    expect(shouldPersistTab("agent", "h1", remote())).toBe(true);
    // A local Ollama agent is host-bound and out of scope — excluded.
    expect(shouldPersistTab("local_agent", "primary", remote())).toBe(false);
    // A local-running tab (hostId null) has no host session — shell or agent.
    expect(shouldPersistTab("shell", null, remote())).toBe(false);
    expect(shouldPersistTab("agent", null, remote())).toBe(false);
    // The per-tab ephemeral opt-out still wins for an agent tab.
    expect(shouldPersistTab("agent", "primary", remote(), true)).toBe(false);
    // Opted out (project toggle) — shell or agent.
    expect(shouldPersistTab("shell", "primary", remote({ persist_sessions: false }))).toBe(false);
    expect(shouldPersistTab("agent", "primary", remote({ persist_sessions: false }))).toBe(false);
  });
});

describe("shouldPersistLocalTab — local shell tabs on Unix", () => {
  it("persists a local project shell tab when enabled; excludes agents/disabled", () => {
    expect(shouldPersistLocalTab("shell", "p1", true, true)).toBe(true);
    // A remote project's local (mirror) tab counts too (localRunning=true).
    expect(shouldPersistLocalTab("shell", "p1", true, true)).toBe(true);
    // Agents never persist locally either.
    expect(shouldPersistLocalTab("agent", "p1", true, true)).toBe(false);
    expect(shouldPersistLocalTab("agent", "p1", true, true, true, true)).toBe(true);
    expect(shouldPersistLocalTab("agent", "p1", true, true, true, false)).toBe(false);
    expect(shouldPersistLocalTab("agent", "root", true, true, true, true)).toBe(false);
    // A local-model tab is an agent tab here (#31bl): Mobile access, and a tab
    // that comes back after a restart, as for any agent.
    expect(shouldPersistLocalTab("local_agent", "p1", true, true, true, true)).toBe(true);
    expect(shouldPersistLocalTab("local_agent", "p1", true, true, false, true)).toBe(false);
    expect(shouldPersistLocalTab("local_agent", "p1", true, true, true, false)).toBe(false);
    expect(shouldPersistLocalTab("local_agent", "root", true, true, true, true)).toBe(false);
    // A tab actually running on a remote host is not a local session.
    expect(shouldPersistLocalTab("shell", "p1", false, true)).toBe(false);
    // Disabled (setting off, or Windows folded into localEnabled) → off.
    expect(shouldPersistLocalTab("shell", "p1", true, false)).toBe(false);
  });

  it("persists a ROOT shell tab exactly like a project's", () => {
    // The root terminal's tabs restore like a project's, so a session that
    // survives a crash has a tab to reattach to — which is the whole condition,
    // and the only reason root was ever excluded. A long build started at the
    // root terminal must not be the one shell a crash still kills.
    expect(shouldPersistLocalTab("shell", "root", true, true)).toBe(true);
    // Every other rule still applies to it.
    expect(shouldPersistLocalTab("agent", "root", true, true)).toBe(false);
    expect(shouldPersistLocalTab("shell", "root", true, false)).toBe(false);
  });

  it("includes a BOX scope now that box tabs persist + restore first-class", () => {
    // Box scopes persist under `sessions/box_<id>/` and restore on re-entry
    // (see stores/boxes' restoreBoxScope), so a surviving session HAS a tab to
    // reattach to — the old exclusion's reason is gone. Box tabs are
    // local-only in v1, so this is exactly the root-scope shape.
    expect(shouldPersistLocalTab("shell", "box:b1", true, true)).toBe(true);
    // Every other rule still applies to it.
    expect(shouldPersistLocalTab("agent", "box:b1", true, true)).toBe(false);
    expect(shouldPersistLocalTab("shell", "box:b1", true, false)).toBe(false);
  });
});

describe("attach tab restore", () => {
  beforeEach(() => {
    useTabsStore.setState({
      tabsByScope: {},
      layoutByScope: {},
      focusedGroupByScope: {},
      scope: "p",
    } as never);
  });

  it("preserves tmuxAttach onto the rebuilt shell tab so it reattaches to the same session", () => {
    useTabsStore.getState().loadFromLayout(
      [
        {
          key: "shell-7",
          label: "train",
          cmd: "",
          cwd: "/p",
          kind: "shell",
          location: "remote",
          tmuxAttach: "train",
        },
      ],
      "/p",
      "p",
    );
    const tabs = useTabsStore.getState().tabsByScope["p"];
    expect(tabs).toHaveLength(1);
    expect(tabs[0].tmuxAttach).toBe("train");
    expect(tabs[0].kind).toBe("shell");
  });

  it("keeps the SAME tmuxSession across a restart even though the key is regenerated (reattach, not fork)", () => {
    useTabsStore.getState().loadFromLayout(
      [
        {
          key: "shell-3", // saved key — regenerated on restore
          label: "run",
          cmd: "",
          cwd: "/p",
          kind: "shell",
          location: "remote",
          tmuxSession: `${BRAND.slug}-fixed-uuid`,
        },
      ],
      "/p",
      "p",
    );
    const tab = useTabsStore.getState().tabsByScope["p"][0];
    // The key changed (fresh mint) but the session name is stable → the tab
    // reattaches to the SAME host session rather than spawning a second one.
    expect(tab.key).not.toBe("shell-3");
    expect(tab.tmuxSession).toBe(`${BRAND.slug}-fixed-uuid`);
  });

  it("mints a stable tmuxSession for a shell tab persisted before the feature existed", () => {
    useTabsStore.getState().loadFromLayout(
      [{ key: "shell-1", label: "sh", cmd: "", cwd: "/p", kind: "shell" }],
      "/p",
      "p",
    );
    const tab = useTabsStore.getState().tabsByScope["p"][0];
    expect(tab.tmuxSession).toMatch(new RegExp(String.raw`^${BRAND.slug}-`));
  });

  it("mints a stable tmuxSession for a restorable remote agent tab, in the shell-tab format", () => {
    // A resumable remote agent tab (claude, with a sessionId) persisted before the
    // feature: on restore it mints a persisted name in the SAME tabtivity-<scope>--<uuid>
    // format shell tabs use, so it reattaches on every subsequent relaunch.
    useTabsStore.getState().loadFromLayout(
      [
        {
          key: "agent-1",
          label: "claude",
          cmd: "claude",
          cwd: "/p",
          kind: "agent",
          location: "remote",
          sessionId: "sess-abc",
        },
      ],
      "/p",
      "p",
    );
    const tab = useTabsStore.getState().tabsByScope["p"][0];
    expect(tab.kind).toBe("agent");
    expect(tab.tmuxSession).toMatch(new RegExp(String.raw`^${BRAND.slug}-p--`));
  });

  it("keeps an agent tab's persisted tmuxSession across a restart (reattach, not fork)", () => {
    useTabsStore.getState().loadFromLayout(
      [
        {
          key: "agent-9",
          label: "claude",
          cmd: "claude",
          cwd: "/p",
          kind: "agent",
          location: "remote",
          sessionId: "sess-xyz",
          tmuxSession: `${BRAND.slug}-p--fixed-agent-uuid`,
        },
      ],
      "/p",
      "p",
    );
    const tab = useTabsStore.getState().tabsByScope["p"][0];
    expect(tab.key).not.toBe("agent-9");
    expect(tab.tmuxSession).toBe(`${BRAND.slug}-p--fixed-agent-uuid`);
  });
});
