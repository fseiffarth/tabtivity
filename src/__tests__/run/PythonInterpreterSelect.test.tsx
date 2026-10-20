/**
 * The right-click-Run interpreter picker (`PythonInterpreterSelect`): lists the
 * probed interpreters, pins the picked one on the project (the same pin the
 * Python interpreter window edits), and clears it back to auto-detect.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act, fireEvent, screen } from "@testing-library/react";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

import { PythonInterpreterSelect } from "../../components/projects/PythonInterpreterSelect";
import type { ProjectEntry } from "../../types";

const VENV = { kind: "venv", path: "/p/.venv/bin/python", label: ".venv" };
const SYS = { kind: "system", path: "/usr/bin/python3", label: "System" };

function project(pinned?: string): ProjectEntry {
  return { id: "p1", name: "P", directory: "/p", python_interpreter: pinned } as ProjectEntry;
}

async function renderSelect(p: ProjectEntry) {
  await act(async () => {
    render(
      <PythonInterpreterSelect project={p} labelClassName="l" selectClassName="s" />,
    );
  });
  return screen.getByRole("combobox") as HTMLSelectElement;
}

describe("Run popover · interpreter picker", () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockImplementation((cmd: string, args?: { interpreter?: string | null }) => {
      if (cmd === "python_interpreters") return Promise.resolve([VENV, SYS]);
      if (cmd === "set_project_python") return Promise.resolve(args?.interpreter ?? null);
      return Promise.resolve(null);
    });
  });

  it("offers auto-detect (naming its pick) plus every probed interpreter", async () => {
    const select = await renderSelect(project());
    const labels = Array.from(select.options).map((o) => o.textContent);
    expect(labels[0]).toContain(VENV.path);
    expect(labels).toContain(`.venv — ${VENV.path}`);
    expect(labels).toContain(`System — ${SYS.path}`);
    expect(select.value).toBe("");
  });

  it("pins the picked interpreter on the project", async () => {
    const select = await renderSelect(project());
    await act(async () => {
      fireEvent.change(select, { target: { value: SYS.path } });
    });
    expect(invoke).toHaveBeenCalledWith("set_project_python", {
      projectId: "p1",
      interpreter: SYS.path,
    });
  });

  it("clears a pin back to auto-detect, and keeps an unlisted pin selectable", async () => {
    const select = await renderSelect(project("/opt/envs/ml/bin/python"));
    expect(select.value).toBe("/opt/envs/ml/bin/python");
    await act(async () => {
      fireEvent.change(select, { target: { value: "" } });
    });
    expect(invoke).toHaveBeenCalledWith("set_project_python", {
      projectId: "p1",
      interpreter: null,
    });
  });
});
