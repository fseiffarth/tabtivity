/**
 * The "+" menu's ▾ machine list on a remote project's agent rows
 * (`agentMachines` + `agentMenuEntries`' `machines`, rendered by
 * `AddTabMenuList`): the row keeps its default start, the ▾ starts the same
 * agent on the machine picked.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AddTabMenuList } from "../../components/tabs/AddTabMenuList";
import { agentMachines, agentMenuEntries } from "../../components/tabs/agentMenuEntries";
import { AGENT_ITEMS, type StaticMenuItem } from "../../lib/tabs/newTabItems";
import type { TabLocation } from "../../stores/tabs";
import type { CustomAgent } from "../../types";

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

const claudeLabel = AGENT_ITEMS.find((item) => item.cmd === "claude")!.label;

const t = (key: string, vars?: Record<string, string>) =>
  vars ? `${key}(${Object.values(vars).join(",")})` : key;

const hosts = [
  { id: "gpu", label: "GPU box", host: "gpu.example", sync_code: true },
  { id: "cold", host: "cold.example", sync_code: false },
];

describe("agentMachines", () => {
  it("lists the mirror, the primary, then each worker — a worker without the code disabled", () => {
    const machines = agentMachines({ primaryHost: "head.example", computeHosts: hosts, t });
    expect(machines.map((m) => m.location)).toEqual(["local", "remote", "host:gpu", "host:cold"]);
    expect(machines[2]).toMatchObject({ label: "GPU box" });
    expect(machines[2].disabled).toBeUndefined();
    expect(machines[3]).toMatchObject({ disabled: true });
    expect(machines[3].label).toContain("cold.example");
  });

  it("has no Local row on a host-pinned project, and one machine is no list", () => {
    const pinned = agentMachines({ primaryHost: "head.example", computeHosts: hosts, pinned: true, t });
    expect(pinned.map((m) => m.location)).toEqual(["remote", "host:gpu", "host:cold"]);
    // A VM: its primary alone, nothing to choose between.
    const lone = agentMachines({ primaryHost: "vm", pinned: true, t });
    const rows = agentMenuEntries({
      installedBuiltins: new Set(["claude"]),
      installedCmds: null,
      customAgents: [],
      pick: vi.fn(),
      machines: lone,
      onAddCustom: vi.fn(),
      t,
    });
    expect(rows.find((e) => e.key === "claude")?.machineEntries).toBeUndefined();
  });
});

describe("agent rows with machines", () => {
  const custom: CustomAgent[] = [{ id: "mine", label: "Mine", cmd: "mine" } as CustomAgent];

  function entries(pick: (item: StaticMenuItem, location?: TabLocation) => void, withMachines: boolean) {
    return agentMenuEntries({
      installedBuiltins: new Set(["claude"]),
      installedCmds: new Set(["mine"]),
      customAgents: custom,
      pick,
      machines: withMachines ? agentMachines({ primaryHost: "head.example", computeHosts: hosts, t }) : undefined,
      onAddCustom: vi.fn(),
      t,
    });
  }

  it("gives every agent row a machine list, but not the add-agent row", () => {
    const rows = entries(vi.fn(), true);
    expect(rows.find((e) => e.key === "claude")?.machineEntries).toHaveLength(4);
    expect(rows.find((e) => e.key === "custom:mine")?.machineEntries).toHaveLength(4);
    expect(rows.find((e) => e.key === "__add_custom_agent__")?.machineEntries).toBeUndefined();
  });

  it("offers none without machines (a local project)", () => {
    expect(entries(vi.fn(), false).some((e) => e.machineEntries)).toBe(false);
  });

  it("the row starts on the default; the ▾ starts on the machine picked", async () => {
    const pick = vi.fn();
    render(<AddTabMenuList groups={[{ label: "Agents", entries: entries(pick, true) }]} />);
    await userEvent.click(screen.getByRole("button", { name: new RegExp(`${claudeLabel}$`) }));
    expect(pick).toHaveBeenLastCalledWith(expect.objectContaining({ cmd: "claude" }));
    expect(pick.mock.lastCall?.[1]).toBeUndefined();

    await userEvent.click(screen.getByRole("button", { name: `newTabMenu.chooseMachine(${claudeLabel})` }));
    expect(document.querySelector(".tab-new-menu-more")).toBeTruthy();
    expect(screen.getByRole("button", { name: /cold\.example/ })).toHaveProperty("disabled", true);
    await userEvent.click(screen.getByRole("button", { name: /GPU box/ }));
    expect(pick).toHaveBeenLastCalledWith(expect.objectContaining({ cmd: "claude" }), "host:gpu");
  });

  it("hovering a row opens its machines without taking focus; leaving closes them", async () => {
    render(<AddTabMenuList groups={[{ label: "Agents", entries: entries(vi.fn(), true) }]} />);
    const search = screen.getByRole("textbox");
    expect(document.activeElement).toBe(search);
    await userEvent.hover(screen.getByRole("button", { name: new RegExp(`${claudeLabel}$`) }));
    await waitFor(() => expect(screen.getByRole("button", { name: /GPU box/ })).toBeTruthy());
    expect(document.activeElement).toBe(search);

    // Into the list: it stays.
    await userEvent.hover(screen.getByRole("button", { name: /GPU box/ }));
    await new Promise((r) => setTimeout(r, 300));
    expect(document.querySelector(".tab-new-menu-more")).toBeTruthy();

    await userEvent.unhover(screen.getByRole("button", { name: /GPU box/ }));
    await waitFor(() => expect(document.querySelector(".tab-new-menu-more")).toBeNull());
  });

  it("→ at the end of the query opens the highlighted row's machines", async () => {
    render(<AddTabMenuList groups={[{ label: "Agents", entries: entries(vi.fn(), true) }]} />);
    await userEvent.type(screen.getByRole("textbox"), "mine{ArrowRight}");
    expect(document.querySelector(".tab-new-menu-more .tab-new-menu-group-label")?.textContent).toBe(
      "newTabMenu.chooseMachine(Mine)",
    );
  });
});
