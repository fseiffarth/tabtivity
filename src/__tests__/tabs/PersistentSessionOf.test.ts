/**
 * Which tmux session a tab owns (`lib/remote/closeRemoteTab`), as the Sessions view
 * reads it to mark owned rows. Two classifiers that must keep mirroring the
 * spawn-side rules (`shouldPersistTab` / `shouldPersistLocalTab`): a remote
 * session for a shell/agent tab on a host of a persist-enabled remote project,
 * with a removed worker falling back to the primary and an attach tab owning
 * exactly the name it attached to; a local session for a shell tab running on
 * this machine — a local project, a remote project's mirror tab, the root, or
 * a box — unless `persist_local_sessions` is off.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
  emit: vi.fn(() => Promise.resolve()),
}));

import { localPersistentSessionOf, persistentSessionOf } from "../../lib/remote/closeRemoteTab";
import { useProjectsStore } from "../../stores/projects";
import { useSettingsStore } from "../../stores/settings";
import type { TabEntry } from "../../stores/tabs";
import type { ProjectEntry } from "../../types";
import { BRAND } from "../../lib/brand";

const base = { name: "p", status: "active" as const, position: 0, local_file: "/p" };
const local: ProjectEntry = { ...base, id: "local" };
const remote: ProjectEntry = {
  ...base,
  id: "remote",
  remote: { host: "login.example.org", remote_path: "/h" },
  compute_hosts: [{ id: "w-1", host: "gpu.example.org", remote_path: "/h" }],
};
const noPersist: ProjectEntry = {
  ...base,
  id: "nopersist",
  remote: { host: "login.example.org", remote_path: "/h", persist_sessions: false },
};
const vm: ProjectEntry = {
  ...base,
  id: "vm",
  remote: { host: "127.0.0.1", port: 2222, remote_path: "/h", vm: true },
  vm: { enabled: true } as ProjectEntry["vm"],
};

const tab = (extra: Partial<TabEntry> = {}): TabEntry => ({
  key: "t1",
  label: "shell",
  cmd: "bash",
  cwd: "/h",
  kind: "shell",
  tmuxSession: `${BRAND.slug}-abc`,
  ...extra,
});

beforeEach(() => {
  useProjectsStore.setState({ projects: [local, remote, noPersist, vm] });
  useSettingsStore.setState({ settings: {}, loaded: true });
});

describe("persistentSessionOf", () => {
  it("owns nothing on the root, a local project, or a tab running locally", () => {
    expect(persistentSessionOf("root", tab())).toBeNull();
    expect(persistentSessionOf("local", tab())).toBeNull();
    expect(persistentSessionOf("remote", tab({ location: "local" }))).toBeNull();
    expect(persistentSessionOf("remote", tab({ kind: "local_agent" }))).toBeNull();
  });

  it("owns its minted session on the primary by default, or on a named worker", () => {
    expect(persistentSessionOf("remote", tab())).toEqual({ session: `${BRAND.slug}-abc`, hostId: "primary" });
    expect(persistentSessionOf("remote", tab({ location: "host:w-1" }))).toEqual({
      session: `${BRAND.slug}-abc`,
      hostId: "w-1",
    });
    expect(persistentSessionOf("remote", tab({ kind: "agent", location: "remote" }))).toEqual({
      session: `${BRAND.slug}-abc`,
      hostId: "primary",
    });
  });

  it("falls back to the primary for a tab naming a removed worker", () => {
    expect(persistentSessionOf("remote", tab({ location: "host:gone" }))).toEqual({
      session: `${BRAND.slug}-abc`,
      hostId: "primary",
    });
  });

  it("lets an attach tab own exactly the (possibly foreign) name it attached to", () => {
    // Even an ephemeral tab with no minted session — the attach is the ownership.
    expect(
      persistentSessionOf("remote", tab({ tmuxAttach: "train", tmuxSession: undefined, ephemeral: true })),
    ).toEqual({ session: "train", hostId: "primary" });
  });

  it("owns nothing for a files pane, an ephemeral tab, a persistence-off project, or no session", () => {
    expect(persistentSessionOf("remote", tab({ kind: "files" }))).toBeNull();
    expect(persistentSessionOf("remote", tab({ ephemeral: true }))).toBeNull();
    expect(persistentSessionOf("nopersist", tab())).toBeNull();
    expect(persistentSessionOf("remote", tab({ tmuxSession: undefined }))).toBeNull();
  });

  it("pins a VM project's tab to the VM host even when its stored location says local", () => {
    expect(persistentSessionOf("vm", tab({ location: "local" }))).toEqual({
      session: `${BRAND.slug}-abc`,
      hostId: "primary",
    });
  });
});

describe("localPersistentSessionOf", () => {
  it("owns a shell's local session on the root, a box, a local project and a mirror tab", () => {
    expect(localPersistentSessionOf("root", tab())).toBe(`${BRAND.slug}-abc`);
    expect(localPersistentSessionOf("box:b1", tab())).toBe(`${BRAND.slug}-abc`);
    expect(localPersistentSessionOf("local", tab())).toBe(`${BRAND.slug}-abc`);
    expect(localPersistentSessionOf("remote", tab({ location: "local" }))).toBe(`${BRAND.slug}-abc`);
  });

  it("owns nothing for a tab that runs on a host", () => {
    expect(localPersistentSessionOf("remote", tab())).toBeNull();
    expect(localPersistentSessionOf("remote", tab({ location: "host:w-1" }))).toBeNull();
    // The VM tier overrides a stored `local` — the tab is on the VM.
    expect(localPersistentSessionOf("vm", tab({ location: "local" }))).toBeNull();
  });

  it("owns nothing for a non-shell tab, a tab with no session, or with the setting off", () => {
    expect(localPersistentSessionOf("local", tab({ kind: "agent" }))).toBeNull();
    expect(localPersistentSessionOf("local", tab({ tmuxSession: undefined }))).toBeNull();
    useSettingsStore.setState({ settings: { persist_local_sessions: false }, loaded: true });
    expect(localPersistentSessionOf("local", tab())).toBeNull();
    expect(localPersistentSessionOf("root", tab())).toBeNull();
  });
});
