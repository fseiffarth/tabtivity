import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn((..._a: unknown[]) => Promise.resolve(undefined as unknown)),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));

import {
  createProjectDoc,
  projectAgentMemory,
  projectAgentMemoryRead,
  projectDocsStatus,
} from "../../lib/projects/projectDocs";

describe("project docs commands", () => {
  beforeEach(() => invokeMock.mockClear());

  it("sends a project id and a name, never a path", async () => {
    invokeMock.mockResolvedValueOnce(null);
    expect(await projectDocsStatus("p1")).toBeNull();
    expect(invokeMock).toHaveBeenLastCalledWith("project_docs_status", { projectId: "p1" });

    invokeMock.mockResolvedValueOnce(true);
    expect(await createProjectDoc("p1", "TODO.md")).toBe(true);
    expect(invokeMock).toHaveBeenLastCalledWith("create_project_doc", { projectId: "p1", name: "TODO.md" });
  });

  it("lists agent memory and reads one entry by cli, home and name", async () => {
    const entry = { cli: "claude", home: "scope", name: "MEMORY.md", bytes: 3, modifiedSecs: null } as const;
    invokeMock.mockResolvedValueOnce([entry]);
    expect(await projectAgentMemory("p1")).toEqual([entry]);
    expect(invokeMock).toHaveBeenLastCalledWith("project_agent_memory", { projectId: "p1" });

    invokeMock.mockResolvedValueOnce("# index");
    expect(await projectAgentMemoryRead("p1", entry)).toBe("# index");
    expect(invokeMock).toHaveBeenLastCalledWith("project_agent_memory_read", {
      projectId: "p1",
      cli: "claude",
      home: "scope",
      name: "MEMORY.md",
    });
  });
});
