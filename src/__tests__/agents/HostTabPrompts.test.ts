import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve(null)) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})), emit: vi.fn(() => Promise.resolve()) }));

import { useAgentModelsStore } from "../../stores/agents/agentModels";
import { useProjectsStore } from "../../stores/projects";
import type { ProjectEntry } from "../../types";
import type { TabEntry } from "../../stores/tabs";

/** A tab card's prompt lines and model tag are read off the tab's transcript;
 * a tab on a remote project's host keeps it there, so the read names the host
 * (`services::remote_transcript`), as the Reader's and the Focus chat's do. */
describe("the transcript tail of a tab on a remote host", () => {
  const project = { id: "p1", name: "P", path: "/state/p1", remote: { remote_path: "/srv/p1" } } as unknown as ProjectEntry;
  const tab = (key: string, location?: TabEntry["location"]): TabEntry => ({
    key, kind: "agent", cmd: "claude", label: "Claude", sessionId: "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a", location,
  } as TabEntry);
  const argsOf = (command: string) => vi.mocked(invoke).mock.calls.find(([name]) => name === command)?.[1] as Record<string, unknown> | undefined;

  beforeEach(() => {
    vi.mocked(invoke).mockClear();
    useProjectsStore.setState({ projects: [project] });
  });

  it("names the host for a tab that runs there", async () => {
    await useAgentModelsStore.getState().refresh("p1", tab("on-host", "remote"), true);
    expect(argsOf("agent_tab_recent_prompts")?.remoteHost).toBe("primary");
    expect(argsOf("agent_tab_model")?.remoteHost).toBe("primary");
    expect(argsOf("agent_tab_last_prompt")?.remoteHost).toBe("primary");
  });

  it("names none for a tab that runs in the mirror here", async () => {
    await useAgentModelsStore.getState().refresh("p1", tab("here", "local"), true);
    expect(argsOf("agent_tab_recent_prompts")?.remoteHost).toBeNull();
  });
});
