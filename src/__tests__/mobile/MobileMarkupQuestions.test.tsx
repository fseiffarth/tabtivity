/**
 * The phone's half of the markup questions MCP, as the window's bridge serves
 * it (`docs/markup_questions_mcp_plan.md` P3): the tab's open ask goes to the
 * phone with the file's leaf name and never its path, an answer is taken by
 * the desktop (which builds the prompt) and delivered as a phone hold is —
 * and when that delivery fails, the ask is reopened with the answer's receipt
 * exactly as the desktop card does, so the phone's card stays usable.
 */
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(), emit: vi.fn() }));

import { MobileBridgeHost, mutationDomain } from "../../components/mobile/MobileBridgeHost";
import { useProjectsStore } from "../../stores/projects";
import { useSettingsStore } from "../../stores/settings";
import { useTabsStore, type TabEntry } from "../../stores/tabs";
import type { ProjectEntry, Settings } from "../../types";
import { BRAND, MOBILE_ACCESS_KEY, NAMES } from "../../lib/brand";

const project: ProjectEntry = {
  id: "p-mobile",
  name: "Alpha",
  status: "active",
  position: 1,
  local_file: "/projects/alpha/project.json",
  [MOBILE_ACCESS_KEY]: true,
};
const TMUX = `${BRAND.slug}-p-mobile--agent-123456789`;
const ASK = "ask-0123456789abcdef";
const PROMPT = "My answers to your markup questions on `docs/draft.pdf`:\n1. Figure or paragraph? → Figure";

type Handler = (args: Record<string, unknown>) => unknown;
let handlers: Record<string, Handler> = {};

/** Hand the bridge one desktop request and give back what it answered. */
async function ask(request: Record<string, unknown>) {
  const listener = vi.mocked(listen).mock.calls.find(([name]) => name === NAMES.mobileDesktopEvent);
  const deliver = listener![1] as (event: { payload: unknown }) => void;
  const invokeMock = vi.mocked(invoke);
  invokeMock.mockClear();
  deliver({ payload: request });
  await vi.waitFor(() => expect(invokeMock.mock.calls.some(([command]) => command === "mobile_desktop_respond")).toBe(true));
  const call = invokeMock.mock.calls.find(([command]) => command === "mobile_desktop_respond");
  return (call?.[1] as { response: Record<string, unknown> }).response;
}

const called = (command: string) => vi.mocked(invoke).mock.calls.filter(([name]) => name === command).map(([, args]) => args as Record<string, unknown>);

describe("Mobile bridge — the agent's markup questions", () => {
  beforeEach(async () => {
    let rules: Array<Record<string, unknown>> = [];
    handlers = {
      list_agents: () => [],
      agent_schedules_list: () => rules,
      agent_schedule_upsert: (args) => {
        const schedule = (args as { schedule: Record<string, unknown> }).schedule;
        rules = [...rules.filter((rule) => rule.id !== schedule.id), schedule];
        return rules;
      },
      markup_mcp_list: () => [{
        id: ASK,
        file: "docs/paper/draft.pdf",
        fileName: "draft.pdf",
        createdAt: "2026-10-03T10:00:00Z",
        questions: [
          { question: "Figure or paragraph?", header: "Arrow", options: [{ label: "Figure (Recommended)" }, { label: "Paragraph", description: "Above it" }], multiSelect: false, page: 3, quote: "Figure 2" },
          { question: "Which spelling?", options: [{ label: "colour" }, { label: "color" }], multiSelect: true },
        ],
      }],
      markup_mcp_answer: () => ({ prompt: PROMPT, receipt: "rcpt-1" }),
      markup_mcp_reopen: () => null,
      markup_mcp_dismiss: () => null,
    };
    vi.mocked(invoke).mockImplementation((command: string, args?: unknown) => {
      const handler = handlers[command];
      if (!handler) return Promise.resolve(undefined);
      try {
        return Promise.resolve(handler((args ?? {}) as Record<string, unknown>));
      } catch (error) {
        return Promise.reject(error);
      }
    });
    vi.mocked(listen).mockResolvedValue(() => {});
    useProjectsStore.setState({ projects: [project], activeId: project.id, loaded: true });
    useSettingsStore.setState({ settings: {} as Settings, loaded: true });
    useTabsStore.setState({
      scope: project.id,
      tabsByScope: {
        [project.id]: [
          { key: "agent-1", label: "Claude", kind: "agent", cmd: "claude", cwd: "/projects/alpha", tmuxSession: TMUX, scheduleTargetId: "target-1" },
        ] satisfies TabEntry[],
      },
      layoutByScope: {},
      detachedGroupsByScope: {},
    });
    render(<MobileBridgeHost />);
    await vi.waitFor(() => expect(vi.mocked(listen).mock.calls.length).toBeGreaterThan(0));
  });

  afterEach(() => {
    cleanup();
    vi.mocked(invoke).mockReset();
    vi.mocked(listen).mockReset();
  });

  it("lists the tab's open ask with its leaf name, never its path", async () => {
    const answer = await ask({ type: "markup_questions", request_id: "q1", project_id: project.id, tmux_session: TMUX, path: ".tabtivity/outbox/20261003-101500-draft.pdf" });
    expect(answer).toEqual({
      status: "markup_questions",
      asks: [{
        id: ASK,
        file_name: "draft.pdf",
        questions: [
          { question: "Figure or paragraph?", header: "Arrow", options: [{ label: "Figure (Recommended)" }, { label: "Paragraph", description: "Above it" }], multi_select: false, page: 3, quote: "Figure 2" },
          { question: "Which spelling?", options: [{ label: "colour" }, { label: "color" }], multi_select: true },
        ],
      }],
    });
    expect(JSON.stringify(answer)).not.toContain("docs/paper");
    expect(called("markup_mcp_list")[0]).toEqual({ projectId: project.id, scheduleTargetId: "target-1", path: ".tabtivity/outbox/20261003-101500-draft.pdf" });

    // No path: every open ask of the tab (the Focus banner).
    await ask({ type: "markup_questions", request_id: "q2", project_id: project.id, tmux_session: TMUX });
    expect(called("markup_mcp_list")[0]).toEqual({ projectId: project.id, scheduleTargetId: "target-1", path: undefined });

    expect(await ask({ type: "markup_questions", request_id: "q3", project_id: project.id, tmux_session: `${BRAND.slug}-nope` }))
      .toMatchObject({ status: "error", code: "tab_not_found" });
    expect(await ask({ type: "markup_questions", request_id: "q4", project_id: "p-other", tmux_session: TMUX }))
      .toMatchObject({ status: "error", code: "project_ineligible" });
    expect(called("markup_mcp_list")).toHaveLength(0);
  });

  it("answers through the desktop and delivers the prompt as a phone hold", async () => {
    const answers = [{ options: [0] }, { options: [0, 1], other: "both, British first" }];
    expect(await ask({ type: "markup_answer", request_id: "a1", project_id: project.id, tmux_session: TMUX, ask_id: ASK, answers }))
      .toEqual({ status: "seen" });
    expect(called("markup_mcp_answer")[0]).toEqual({ projectId: project.id, scheduleTargetId: "target-1", askId: ASK, answers });
    const queued = called("agent_schedule_upsert");
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ projectId: project.id, scheduleTargetId: "target-1", schedule: { message: PROMPT, rule: { type: "once" } } });
    expect(called("markup_mcp_reopen")).toHaveLength(0);
  });

  it("passes the ask's refusal on and queues nothing", async () => {
    handlers.markup_mcp_answer = () => { throw "superseded"; };
    expect(await ask({ type: "markup_answer", request_id: "a2", project_id: project.id, tmux_session: TMUX, ask_id: ASK, answers: [{ options: [1] }] }))
      .toMatchObject({ status: "error", code: "superseded" });
    expect(called("agent_schedule_upsert")).toHaveLength(0);
  });

  it("reopens the ask with the receipt when the prompt could not be queued", async () => {
    handlers.agent_schedule_upsert = () => { throw "at most 50 schedules"; };
    expect(await ask({ type: "markup_answer", request_id: "a3", project_id: project.id, tmux_session: TMUX, ask_id: ASK, answers: [{ options: [1] }] }))
      .toMatchObject({ status: "error", code: "delivery_failed" });
    expect(called("markup_mcp_reopen")[0]).toEqual({ projectId: project.id, scheduleTargetId: "target-1", askId: ASK, receipt: "rcpt-1" });

    // Closed meanwhile: the reopen is refused and the phone is told so.
    handlers.markup_mcp_reopen = () => { throw "answered"; };
    expect(await ask({ type: "markup_answer", request_id: "a4", project_id: project.id, tmux_session: TMUX, ask_id: ASK, answers: [{ options: [1] }] }))
      .toMatchObject({ status: "error", code: "not_delivered" });
  });

  it("dismisses the ask — Answer in chat instead — typing nothing", async () => {
    expect(await ask({ type: "markup_dismiss", request_id: "d1", project_id: project.id, tmux_session: TMUX, ask_id: ASK }))
      .toEqual({ status: "seen" });
    expect(called("markup_mcp_dismiss")[0]).toEqual({ projectId: project.id, scheduleTargetId: "target-1", askId: ASK });
    expect(called("agent_schedule_upsert")).toHaveLength(0);
  });

  it("queues answers and dismissals with the phone's holds; listing is a read", () => {
    expect(mutationDomain("markup_answer")).toBe("schedules");
    expect(mutationDomain("markup_dismiss")).toBe("schedules");
    expect(mutationDomain("markup_questions")).toBeNull();
  });
});
