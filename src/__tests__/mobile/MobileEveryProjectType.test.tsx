/**
 * The desktop bridge for a remote, a container and a VM project
 * (`docs/mobile_every_project_type_plan.md`, step 4): the Mobile switch is the
 * only gate on the project itself; inside it, only the tabs with a local tmux
 * session are the phone's. Every per-tab handler answers `tab_not_found` for the
 * others, and `create` follows the sidecar's verdict (`not_attachable`).
 */
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(), emit: vi.fn() }));

import { MobileBridgeHost } from "../../components/mobile/MobileBridgeHost";
import { useActivityStore } from "../../stores/activity";
import { useClosedAgentTabsStore } from "../../stores/agents/closedAgentTabs";
import { useProjectsStore } from "../../stores/projects";
import { useSettingsStore } from "../../stores/settings";
import { useTabsStore, type TabEntry } from "../../stores/tabs";
import type { ProjectEntry, Settings } from "../../types";
import { BRAND, MOBILE_ACCESS_KEY, MOBILE_HOST_KEY, NAMES } from "../../lib/brand";

const project = (id: string, over: Partial<ProjectEntry>): ProjectEntry => ({
  id,
  name: id,
  status: "active",
  position: 1,
  local_file: `/state/projects/${id}/project.json`,
  directory: `/state/projects/${id}`,
  [MOBILE_ACCESS_KEY]: true,
  ...over,
});
const remoteSpec = { host: "h.invalid", user: "u", remote_path: "/srv" } as ProjectEntry["remote"];
const rem = project("rem", { remote: remoteSpec, mirror: "/mirrors/rem" });
const ctr = project("ctr", { sandbox: { enabled: true } });
const ctrAgents = project("cta", { sandbox: { enabled: true, scope: "agents" } });
const vm = project("vm", { remote: remoteSpec, vm: { enabled: true } as ProjectEntry["vm"] });
const off = project("off", { remote: remoteSpec, [MOBILE_ACCESS_KEY]: false });

const tmux = (name: string) => `${BRAND.slug}-${name}-123456789`;
const tabOf = (key: string, kind: TabEntry["kind"], over: Partial<TabEntry> = {}): TabEntry => ({
  key, label: key, kind, cmd: kind === "shell" ? "bash" : "claude", cwd: "/x", tmuxSession: tmux(key),
  scheduleTargetId: `target-${key}`, ...over,
} as TabEntry);

async function ask(request: Record<string, unknown>) {
  const listener = vi.mocked(listen).mock.calls.find(([name]) => name === NAMES.mobileDesktopEvent);
  const deliver = listener![1] as (event: { payload: unknown }) => void;
  const invokeMock = vi.mocked(invoke);
  invokeMock.mockClear();
  deliver({ payload: request });
  await vi.waitFor(() => expect(invokeMock.mock.calls.some(([c]) => c === "mobile_desktop_respond")).toBe(true));
  const call = invokeMock.mock.calls.find(([c]) => c === "mobile_desktop_respond");
  return (call?.[1] as { response: Record<string, unknown> }).response;
}

const create = (projectId: string, request: Record<string, unknown>) => ask({
  type: "create",
  request_id: "c1",
  request: { project_id: projectId, kind: "agent", agent_id: "agent-claude", idempotency_key: "0123456789abcdef", ...request },
});

describe("Mobile bridge — remote, container and VM projects", () => {
  const made = vi.fn();
  beforeEach(async () => {
    try { localStorage.clear(); } catch { /* none */ }
    vi.mocked(invoke).mockImplementation((command: string, args?: unknown) => {
      if (command === "list_agents") return Promise.resolve([{ id: "claude", bin: "claude", installed: true }]);
      if (command === "agent_schedules_list") return Promise.resolve([]);
      if (command === "mobile_opaque_id") {
        const { domain, value } = args as { domain: string; value: string };
        return Promise.resolve(`${domain}-${value}`);
      }
      return Promise.resolve(undefined);
    });
    vi.mocked(listen).mockResolvedValue(() => {});
    made.mockReset();
    useProjectsStore.setState({
      projects: [rem, ctr, ctrAgents, vm, off],
      activeId: null,
      loaded: true,
      activateProject: vi.fn(() => Promise.resolve()),
    } as never);
    useSettingsStore.setState({ settings: {} as Settings, loaded: true });
    useClosedAgentTabsStore.setState({ byScope: {} });
    const tabsByScope = {
      rem: [
        tabOf("rem-local", "agent"),
        tabOf("rem-pinned", "agent", { location: "local" }),
        tabOf("rem-host", "agent", { location: "remote" }),
        tabOf("rem-worker", "agent", { location: "host:w1" }),
        tabOf("rem-shell", "shell"),
        tabOf("rem-shell-local", "shell", { location: "local" }),
      ],
      ctr: [tabOf("ctr-agent", "agent"), tabOf("ctr-shell", "shell"), tabOf("ctr-model", "local_agent")],
      cta: [tabOf("cta-agent", "agent"), tabOf("cta-shell", "shell")],
      vm: [tabOf("vm-agent", "agent"), tabOf("vm-model", "local_agent")],
    };
    useTabsStore.setState({
      scope: "root",
      tabsByScope,
      hydrateThenCreateInScope: (options: { spec: Omit<TabEntry, "key"> }) => {
        made(options);
        return Promise.resolve({ ...options.spec, key: "new", tmuxSession: tmux("new") } as TabEntry);
      },
    } as never);
    useActivityStore.setState({
      busyByTab: Object.fromEntries(
        Object.entries(tabsByScope).flatMap(([scope, tabs]) => tabs.map((t) => [`${scope}:${t.key}`, true])),
      ),
    });
    render(<MobileBridgeHost />);
    await vi.waitFor(() => expect(vi.mocked(listen).mock.calls.length).toBeGreaterThan(0));
  });

  afterEach(() => {
    cleanup();
    vi.mocked(invoke).mockReset();
    vi.mocked(listen).mockReset();
    useActivityStore.setState({ busyByTab: {}, attentionByTab: {}, attentionByScope: {} });
  });

  it("opens every project type on its own switch alone", async () => {
    for (const id of ["rem", "ctr", "cta", "vm"]) {
      expect((await ask({ type: "catalog", request_id: `k-${id}`, project_id: id })).status).toBe("catalog");
    }
    expect(await ask({ type: "tab_seen", request_id: "k-off", project_id: "off", tmux_session: tmux("x") }))
      .toMatchObject({ status: "error", code: "project_ineligible" });
  });

  it("reports only the tabs the phone can attach to", async () => {
    const sessions = async (id: string) =>
      ((await ask({ type: "catalog", request_id: `s-${id}`, project_id: id })).statuses as { tmux_session: string }[])
        .map((row) => row.tmux_session).sort();
    expect(await sessions("rem")).toEqual(["rem-local", "rem-pinned"].map(tmux).sort());
    expect(await sessions("ctr")).toEqual([tmux("ctr-model")]);
    expect(await sessions("cta")).toEqual([]);
    expect(await sessions("vm")).toEqual([tmux("vm-model")]);
    const all = (await ask({ type: "activity", request_id: "all" })).statuses as { tmux_session: string }[];
    expect(all.map((row) => row.tmux_session).sort()).toEqual(
      ["rem-local", "rem-pinned", "ctr-model", "vm-model"].map(tmux).sort(),
    );
  });

  it("answers tab_not_found to every per-tab handler for a tab it cannot reach", async () => {
    const gone = [
      { project_id: "rem", tmux_session: tmux("rem-host") },
      { project_id: "rem", tmux_session: tmux("rem-worker") },
      { project_id: "rem", tmux_session: tmux("rem-shell") },
      { project_id: "ctr", tmux_session: tmux("ctr-agent") },
      { project_id: "cta", tmux_session: tmux("cta-agent") },
      { project_id: "vm", tmux_session: tmux("vm-agent") },
    ];
    const handlers: Record<string, unknown>[] = [
      { type: "activate" },
      { type: "rename_tab", label: "x" },
      { type: "close_tab" },
      { type: "color_tab", color: null },
      { type: "reorder_tab", anchor_tmux_session: tmux("rem-local"), place: "before" },
      { type: "schedules" },
      { type: "schedule_mutate", action: { type: "delete", schedule_id: "s" } },
      { type: "agent_status", refresh: false },
      { type: "tab_prompt", message: "hi" },
      { type: "hold_prompt", message: "hi" },
      { type: "undo_clear" },
      { type: "tab_worktrees" },
      { type: "move_worktree", worktree: "w1" },
    ];
    for (const target of gone) {
      for (const handler of handlers) {
        const request = { ...target, ...handler, request_id: `g-${handler.type}-${target.tmux_session}` };
        const response = await ask(request);
        // A reorder names two tabs; the unreachable one is enough.
        expect(response, `${handler.type} ${target.tmux_session}`).toMatchObject({ status: "error", code: "tab_not_found" });
      }
    }
  });

  it("lets an unreachable tab's seen and input marks fall through silently", async () => {
    useActivityStore.setState({ attentionByTab: { "rem:rem-host": "done", "rem:rem-local": "done" } });
    for (const name of ["rem-host", "rem-local"]) {
      expect(await ask({ type: "tab_seen", request_id: `seen-${name}`, project_id: "rem", tmux_session: tmux(name) }))
        .toMatchObject({ status: "seen" });
    }
    const attention = useActivityStore.getState().attentionByTab;
    expect(attention["rem:rem-host"]).toBe("done");
    expect(attention["rem:rem-local"]).toBeUndefined();
    expect(await ask({ type: "tab_input", request_id: "inp", project_id: "rem", tmux_session: tmux("rem-host") }))
      .toMatchObject({ status: "seen" });
  });

  it("serves a reachable tab of the same project", async () => {
    expect(await ask({ type: "schedules", request_id: "ok1", project_id: "rem", tmux_session: tmux("rem-local") }))
      .toMatchObject({ status: "schedules" });
    expect(await ask({ type: "rename_tab", request_id: "ok2", project_id: "rem", tmux_session: tmux("rem-pinned"), label: "Renamed" }))
      .toMatchObject({ status: "renamed" });
    expect(await ask({ type: "schedules", request_id: "ok3", project_id: "vm", tmux_session: tmux("vm-model") }))
      .toMatchObject({ status: "schedules" });
  });

  it("starts a remote project's agent in the mirror, local, never on the host", async () => {
    expect(await create("rem", {})).toMatchObject({ status: "created", tmux_session: tmux("new") });
    const options = made.mock.lastCall?.[0] as { scope: string; cwd: string; spec: TabEntry };
    expect(options.scope).toBe("rem");
    expect(options.cwd).toBe("/mirrors/rem");
    expect(options.spec).toMatchObject({ kind: "agent", cwd: "/mirrors/rem", location: "local" });
  });

  it("falls back to <directory>/mirror for a remote project with no mirror recorded", async () => {
    useProjectsStore.setState({ projects: [{ ...rem, mirror: undefined }, ctr, ctrAgents, vm, off] } as never);
    expect(await create("rem", {})).toMatchObject({ status: "created" });
    expect((made.mock.lastCall?.[0] as { cwd: string }).cwd).toBe("/state/projects/rem/mirror");
  });

  it("refuses what has no local session to attach to as not_attachable", async () => {
    // A remote project's shell, whatever the Shells setting says.
    useSettingsStore.setState({ settings: { [MOBILE_HOST_KEY]: { shell_tabs: true } } as never, loaded: true });
    expect(await create("rem", { kind: "shell", agent_id: undefined })).toMatchObject({ status: "error", code: "not_attachable" });
    // A container project: agent and shell, scope all or agents.
    for (const id of ["ctr", "cta"]) {
      expect(await create(id, {})).toMatchObject({ status: "error", code: "not_attachable" });
      expect(await create(id, { kind: "shell", agent_id: undefined })).toMatchObject({ status: "error", code: "not_attachable" });
    }
    // A VM project, which has no folder on the host to begin with.
    expect(await create("vm", {})).toMatchObject({ status: "error", code: "not_attachable" });
    expect(made).not.toHaveBeenCalled();
  });

  it("copies a desktop image only into a folder the scope has", async () => {
    const attach = (projectId: string) =>
      ask({ type: "attach_desktop_image", request_id: `img-${projectId}`, project_id: projectId, image_id: "clipboard" });
    const attached = () => vi.mocked(invoke).mock.calls.filter(([c]) => c === "mobile_attach_desktop_image");
    // A VM project has no folder on this machine unless a mirror is set: nothing is written.
    expect(await attach("vm")).toMatchObject({ status: "error", code: "project_ineligible" });
    expect(attached()).toHaveLength(0);
    // The same project with a mirror, and a remote project's mirror, are written into.
    useProjectsStore.setState({ projects: [rem, ctr, ctrAgents, { ...vm, mirror: "/mirrors/vm" }, off] } as never);
    await attach("vm");
    expect(attached()[0]?.[1]).toMatchObject({ projectDir: "/mirrors/vm" });
    // (`ask` clears the mock calls each time.)
    await attach("rem");
    expect(attached()[0]?.[1]).toMatchObject({ projectDir: "/mirrors/rem" });
  });

  it("reopens a closed local agent of a remote project, and leaves a host-side one closed", async () => {
    const closed = (id: string, over: Partial<TabEntry>) => ({
      id, tab: tabOf(id, "agent", { sessionId: `sid-${id}`, ...over }), closedAt: 1, sessionEnded: true,
    });
    useClosedAgentTabsStore.setState({
      byScope: { rem: [closed("c-host", { location: "remote" }), closed("c-local", {})] },
    });
    const rows = await ask({ type: "catalog", request_id: "cr", project_id: "rem" });
    expect((rows.closed as { id: string }[]).map((row) => row.id)).toEqual(["c-local"]);
    expect(await ask({ type: "reopen_tab", request_id: "r1", project_id: "rem", closed_id: "c-host" }))
      .toMatchObject({ status: "error", code: "not_attachable" });
    expect(useClosedAgentTabsStore.getState().byScope.rem?.map((entry) => entry.id)).toContain("c-host");
    // Container and VM projects start nothing at all, so reopen nothing either.
    expect(await ask({ type: "reopen_tab", request_id: "r2", project_id: "ctr" }))
      .toMatchObject({ status: "error", code: "not_attachable" });
  });
});
