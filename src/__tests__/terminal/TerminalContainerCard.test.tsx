/**
 * A container tab that cannot start because Docker is missing or stopped
 * (`TerminalContainerCard`, `lib/terminal/containerSpawnNotice`): a failed
 * spawn asks `sandbox_preflight`, only `no_docker` / `daemon_down` raise the
 * card, a new attempt drops a late answer, and the button turns the project's
 * container off.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

import { TerminalContainerCard } from "../../components/terminal/TerminalContainerCard";
import {
  clearContainerNotice,
  containerProblemOf,
  reportContainerSpawnError,
  resetContainerNotices,
} from "../../lib/terminal/containerSpawnNotice";
import { useProjectsStore } from "../../stores/projects";

const PTY = "p1:agent-1";

function host() {
  const el = document.createElement("div");
  document.body.appendChild(el);
  return el;
}

async function settle() {
  await act(async () => {
    for (let i = 0; i < 4; i++) await Promise.resolve();
  });
}

describe("container spawn notice", () => {
  beforeEach(() => {
    resetContainerNotices();
    invoke.mockReset();
    document.body.innerHTML = "";
  });

  it("only a missing or stopped engine is a problem", () => {
    expect(containerProblemOf("no_docker")).toBe("no_docker");
    expect(containerProblemOf("daemon_down")).toBe("daemon_down");
    expect(containerProblemOf("ok")).toBeNull();
    expect(containerProblemOf("image_missing")).toBeNull();
  });

  it("shows the card when the preflight finds no Docker, and the button turns the container off", async () => {
    const setProjectSandbox = vi.fn(() => Promise.resolve({ outcome: "applied", spec: null }));
    useProjectsStore.setState({ setProjectSandbox } as never);
    invoke.mockResolvedValue({ status: "no_docker", image: "x", build_command: null });
    render(<TerminalContainerCard host={host()} ptyId={PTY} visible />);
    reportContainerSpawnError(PTY, "p1");
    await settle();
    expect(invoke).toHaveBeenCalledWith("sandbox_preflight", { projectId: "p1" });
    expect(screen.getByText("Docker isn't installed")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Run without container" }));
    await settle();
    expect(setProjectSandbox).toHaveBeenCalledWith("p1", false);
    expect(screen.queryByText("Docker isn't installed")).toBeNull();
  });

  it("raises nothing for another spawn error", async () => {
    invoke.mockResolvedValue({ status: "ok", image: "x", build_command: null });
    render(<TerminalContainerCard host={host()} ptyId={PTY} visible />);
    reportContainerSpawnError(PTY, "p1");
    await settle();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("drops a preflight answer that arrives after a new attempt", async () => {
    let answer: (v: unknown) => void = () => {};
    invoke.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    render(<TerminalContainerCard host={host()} ptyId={PTY} visible />);
    reportContainerSpawnError(PTY, "p1");
    clearContainerNotice(PTY);
    answer({ status: "daemon_down", image: "x", build_command: null });
    await settle();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
