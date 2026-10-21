import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(), emit: vi.fn() }));

import { MobileBridgeHost } from "../../components/mobile/MobileBridgeHost";
import { BRAND, MOBILE_ACCESS_KEY, NAMES } from "../../lib/brand";
import type { AgentUsageReport } from "../../lib/agents/agentUsage";
import { useProjectsStore } from "../../stores/projects";
import { useSettingsStore } from "../../stores/settings";
import { useTabsStore } from "../../stores/tabs";
import type { Settings } from "../../types";
import type { AgentStatusReport } from "../../../mobile-web/src/api";
import { parseUsageReport } from "../../../shared/usageReport";

const projectId = "paper";
const tmux = `${BRAND.slug}-paper--agent-1`;
const panel = "Current session: 71% used · resets Oct 22, 6:20pm (Europe/Berlin)\nCurrent week (all models): 38% used";
let usage: AgentUsageReport;

async function status(refresh = false) {
  const callback = vi.mocked(listen).mock.calls.find(([name]) => name === NAMES.mobileDesktopEvent)![1];
  await act(async () => {
    callback({ payload: { type: "agent_status", request_id: "status-1", project_id: projectId, tmux_session: tmux, refresh } } as never);
  });
  await waitFor(() => expect(vi.mocked(invoke).mock.calls.some(([cmd]) => cmd === "mobile_desktop_respond")).toBe(true));
  const call = vi.mocked(invoke).mock.calls.find(([cmd]) => cmd === "mobile_desktop_respond")!;
  const response = (call[1] as { response: { status: string; report: AgentStatusReport } }).response;
  expect(response.status).toBe("agent_status");
  return response.report;
}

beforeEach(async () => {
  usage = { agent: "claude", label: "Claude Code", supported: true, cached: true, raw: panel };
  vi.mocked(invoke).mockImplementation((command: string) => {
    if (command === "agent_usage") return Promise.resolve(usage);
    if (command === "usage_summary") return Promise.resolve({ days: {} });
    if (["list_agents", "agent_schedules_list", "agent_tab_recent_prompts", "agent_prompt_history_list"].includes(command)) return Promise.resolve([]);
    return Promise.resolve(undefined);
  });
  vi.mocked(listen).mockResolvedValue(() => {});
  useProjectsStore.setState({ projects: [{ id: projectId, name: "Paper", status: "active", position: 1, directory: "/projects/paper", local_file: "/projects/paper/project.json", [MOBILE_ACCESS_KEY]: true }], activeId: projectId, loaded: true });
  useSettingsStore.setState({ settings: {} as Settings, loaded: true });
  useTabsStore.setState({ scope: projectId, tabsByScope: { [projectId]: [{ key: "agent-1", label: "Claude", kind: "agent", cmd: "claude", cwd: "/projects/paper", tmuxSession: tmux }] } });
  await act(async () => { render(<MobileBridgeHost />); });
  await waitFor(() => expect(vi.mocked(listen).mock.calls.some(([name]) => name === NAMES.mobileDesktopEvent)).toBe(true));
});

afterEach(() => {
  cleanup();
  vi.mocked(invoke).mockReset();
  vi.mocked(listen).mockReset();
});

describe("Mobile status usage privacy", () => {
  it.each([
    "/home/user/work/session.json",
    "/Users/user/Library/session.json",
    "~/work/session.json",
    "C:\\Users\\user\\session.json",
    "C:/Users/user/session.json",
    "\\\\server\\share\\session.json",
    "/projects/paper/session.json",
    "/srv/work/session.json",
  ])("preserves the quota meters when another row names %s", async (path) => {
    usage.raw = `${panel}\nTop session: ${path}`;
    const report = await status();
    expect(report.usage).toMatchObject({ supported: true, cached: true, raw: `${panel}\n…` });
    expect(report.usage.error).toBeUndefined();
    expect(JSON.stringify(report)).not.toContain(path);
    expect(parseUsageReport(report.usage.raw!).meters.map((meter) => meter.percent)).toEqual([71, 38]);
  });

  it("passes a path-free panel through unchanged and forwards Refresh", async () => {
    expect((await status(true)).usage.raw).toBe(panel);
    expect(invoke).toHaveBeenCalledWith("agent_usage", { agent: "claude", refresh: true });
  });

  it("still withholds output consisting entirely of local details", async () => {
    usage.raw = "\nSession: /home/user/work/session.json\n";
    expect((await status()).usage).toMatchObject({ raw: undefined, error: "cli_output_withheld" });
  });

  it("keeps unknown path-free output readable", async () => {
    usage.raw = "An unfamiliar usage readout.\nSee /usage for details.";
    expect((await status()).usage.raw).toBe(usage.raw);
  });

  it("never forwards CLI stderr even when it contains no path", async () => {
    usage.raw = undefined;
    usage.error = "Private diagnostic from the CLI";
    usage.code = "cli_error";
    const report = await status();
    expect(report.usage.error).toBe("cli_error");
    expect(JSON.stringify(report)).not.toContain(usage.error);
  });
});
