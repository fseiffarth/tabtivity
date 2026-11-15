/**
 * The Machines view's machine list model (`lib/cockpit/machines`): project hosts
 * and global machines merge into one row per machine, keyed by host name, with
 * the lamp the declutter plan names.
 */
import { describe, expect, it } from "vitest";
import {
  buildMachineRows,
  isIdleMachine,
  machineGroupOf,
  machineLamp,
  machineMatches,
  sortByStateThenName,
  type GlobalMachineInput,
  type MachineGroup,
  type MachineProjectHost,
} from "../../lib/cockpit/machines";

const host = (projectId: string, hostName: string, extra: Partial<MachineProjectHost> = {}): MachineProjectHost => ({
  projectId,
  projectName: projectId.toUpperCase(),
  hostId: "primary",
  host: hostName,
  label: hostName,
  ssh: "off",
  sessions: 0,
  ...extra,
});
const global = (id: string, hostName: string, ssh: GlobalMachineInput["ssh"], label?: string): GlobalMachineInput => ({ id, host: hostName, label, ssh });

describe("machineLamp", () => {
  it("is the global machine's status when there is one", () => {
    expect(machineLamp("error", ["connected"])).toBe("error");
    expect(machineLamp("off", [])).toBe("off");
  });

  it("is connected when any project session is, else the worst of them", () => {
    expect(machineLamp(undefined, ["off", "connected", "error"])).toBe("connected");
    expect(machineLamp(undefined, ["off", "error", "connecting"])).toBe("error");
    expect(machineLamp(undefined, ["off", "connecting"])).toBe("connecting");
    expect(machineLamp(undefined, ["off"])).toBe("off");
    expect(machineLamp(undefined, [])).toBe("off");
  });
});

describe("buildMachineRows", () => {
  it("merges project hosts and a global machine of the same name, case-insensitively", () => {
    const rows = buildMachineRows(
      [host("a", "GPU.example", { ssh: "connected", sessions: 2 }), host("b", "gpu.example", { hostId: "h1", sessions: 1 })],
      [global("g1", "gpu.example", "off", "GPU box")],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: "gpu.example", name: "GPU box", globalId: "g1", lamp: "off", sessions: 3 });
    expect(rows[0].projects.map((p) => p.projectId)).toEqual(["a", "b"]);
    expect(rows[0].disconnected.map((p) => p.projectId)).toEqual(["b"]);
  });

  it("keeps a project-only machine and a global-only machine as their own rows, ordered by name", () => {
    const rows = buildMachineRows([host("a", "zeta.example", { ssh: "connected" })], [global("g1", "alpha.example", "connected")]);
    expect(rows.map((r) => [r.name, r.lamp, r.projects.length])).toEqual([
      ["alpha.example", "connected", 0],
      ["zeta.example", "connected", 1],
    ]);
    expect(rows[0].disconnected).toEqual([]);
  });

  it("shows one chip per project even when it reaches a machine twice, with the better state", () => {
    const rows = buildMachineRows(
      [host("a", "m.example", { ssh: "error" }), host("a", "m.example", { hostId: "h1", ssh: "connected", sessions: 1 })],
      [],
    );
    expect(rows[0].projects).toHaveLength(1);
    expect(rows[0].projects[0].ssh).toBe("connected");
    expect(rows[0].lamp).toBe("connected");
    expect(rows[0].sessions).toBe(1);
  });

  it("carries the run host label of a project's primary", () => {
    const rows = buildMachineRows([host("a", "m.example", { runHost: "Big box" })], []);
    expect(rows[0].projects[0].runHost).toBe("Big box");
  });
});

describe("the Machines view's order", () => {
  const row = (name: string, group: MachineGroup, projects: { name: string }[] = []) => ({ name, group, projects });

  it("groups each state the way the view lists it", () => {
    expect(machineGroupOf("connected")).toBe("connected");
    expect(machineGroupOf("stale")).toBe("failed");
    expect(machineGroupOf("error")).toBe("failed");
    expect(machineGroupOf("reachable")).toBe("up");
    expect(machineGroupOf("unknown")).toBe("off");
    expect(machineGroupOf("unreachable")).toBe("off");
  });

  it("sorts by state, then by name", () => {
    const sorted = sortByStateThenName([row("b", "off"), row("z", "connected"), row("a", "off"), row("m", "failed"), row("c", "up")]);
    expect(sorted.map((r) => r.name)).toEqual(["z", "m", "c", "a", "b"]);
  });

  it("folds only off machines no project uses", () => {
    expect(isIdleMachine(row("a", "off"))).toBe(true);
    expect(isIdleMachine(row("a", "off", [{ name: "P" }]))).toBe(false);
    expect(isIdleMachine(row("a", "up"))).toBe(false);
  });

  it("filters by name, address or project", () => {
    const r = { name: "GPU box", target: "ada@gpu1.example.org", projects: [{ name: "SimpleGNN" }] };
    expect(machineMatches(r, "gpu1")).toBe(true);
    expect(machineMatches(r, "simple")).toBe(true);
    expect(machineMatches(r, "  ")).toBe(true);
    expect(machineMatches(r, "other")).toBe(false);
  });
});
