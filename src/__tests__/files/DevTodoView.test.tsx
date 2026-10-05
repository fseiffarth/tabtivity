/**
 * The dev build's Todo view: groups fold open into rendered markdown whose task
 * boxes write back compare-and-swap, re-finding the task when an agent edited
 * the file in between.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));

import {
  DevTodoView,
  resetDevTodoAvailability,
  useDevTodoAvailable,
} from "../../components/files/DevTodoView";

const GROUPS = [
  { name: "group-a.md", title: "Group A", open: 2, done: 0 },
  { name: "done.md", title: "Done", open: 0, done: 1 },
];

let disk: string;

function backend() {
  mockInvoke.mockImplementation(async (cmd: string, args?: Record<string, string>) => {
    if (cmd === "dev_todo_groups") return GROUPS;
    if (cmd === "dev_todo_read") return disk;
    if (cmd === "dev_todo_write") {
      if (args!.expected !== disk) return { kind: "changed", current: disk };
      disk = args!.next;
      return { kind: "written" };
    }
    throw new Error(`unexpected ${cmd}`);
  });
}

async function openGroupA() {
  render(<DevTodoView active />);
  fireEvent.click(await screen.findByRole("button", { name: /Group A/ }));
  await waitFor(() => expect(document.querySelectorAll("input[data-md-task]")).toHaveLength(2));
}

function boxes() {
  return Array.from(document.querySelectorAll<HTMLInputElement>("input[data-md-task]"));
}

beforeEach(() => {
  mockInvoke.mockReset();
  resetDevTodoAvailability();
  disk = "## Group A\n- [ ] first\n- [ ] second\n";
  backend();
});

describe("DevTodoView", () => {
  it("lists every group with its open count", async () => {
    render(<DevTodoView active />);
    expect((await screen.findByRole("button", { name: /Group A/ })).textContent).toContain("2");
    expect(screen.getByRole("button", { name: /Done/ }).textContent).toContain("0");
  });

  it("reads nothing while hidden", () => {
    render(<DevTodoView active={false} />);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("a box click writes the toggled file and updates the count", async () => {
    await openGroupA();
    await act(async () => { fireEvent.click(boxes()[1]); });
    await waitFor(() => expect(disk).toBe("## Group A\n- [ ] first\n- [x] second\n"));
    await waitFor(() => expect(boxes()[1].checked).toBe(true));
    expect(screen.getByRole("button", { name: /Group A/ }).textContent).toContain("1");
  });

  it("re-applies the click to the same task after an agent edit", async () => {
    await openGroupA();
    disk = "## Group A\n- [ ] new on top\n- [ ] first\n- [ ] second\n";
    await act(async () => { fireEvent.click(boxes()[1]); });
    await waitFor(() =>
      expect(disk).toBe("## Group A\n- [ ] new on top\n- [ ] first\n- [x] second\n"),
    );
  });

  it("drops the click and reloads when the task is gone", async () => {
    await openGroupA();
    disk = "## Group A\n- [ ] first\n";
    await act(async () => { fireEvent.click(boxes()[1]); });
    await waitFor(() => expect(boxes()).toHaveLength(1));
    expect(disk).toBe("## Group A\n- [ ] first\n");
    expect(screen.getByText(/could not be found again/)).toBeTruthy();
  });
});

describe("useDevTodoAvailable", () => {
  function Probe() {
    return <span>{useDevTodoAvailable() ? "yes" : "no"}</span>;
  }

  it("is on when the backend lists groups", async () => {
    render(<Probe />);
    expect(await screen.findByText("yes")).toBeTruthy();
  });

  it("is off in a release build and against a backend without the command", async () => {
    mockInvoke.mockResolvedValueOnce(null);
    const { unmount } = render(<Probe />);
    await act(async () => {});
    expect(screen.getByText("no")).toBeTruthy();
    unmount();
    resetDevTodoAvailability();
    mockInvoke.mockRejectedValueOnce(new Error("unknown command"));
    render(<Probe />);
    await act(async () => {});
    expect(screen.getByText("no")).toBeTruthy();
  });
});
