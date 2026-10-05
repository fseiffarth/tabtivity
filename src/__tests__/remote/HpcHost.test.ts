/**
 * The HPC tag's resolution (`lib/remote/hpc/hpcHost`). Keyed by SSH target like the
 * careful flag, but with the OPPOSITE default: an untagged host behaves exactly
 * as it always has, because every gate here changes what Tabtivity does. The one
 * place that inverts is `mayAutoTouch`, which must fail closed while settings
 * are still unloaded — launch is the window where every sweep fires.
 */
import { describe, expect, it } from "vitest";

import { isHpcHost, mayAutoTouch, projectIsOnHpc, setHpcPatch } from "../../lib/remote/hpc/hpcHost";
import { targetKey } from "../../lib/remote/machineSync";
import type { ProjectEntry, Settings } from "../../types";

const login = { user: "alice", host: "login.example.org", port: 22 };
const tagged: Settings = { hpc_hosts: { [targetKey(login)]: true } };

describe("isHpcHost", () => {
  it("is false for every host nobody tagged, including while settings are unloaded", () => {
    expect(isHpcHost(null, login)).toBe(false);
    expect(isHpcHost({}, login)).toBe(false);
    expect(isHpcHost({ hpc_hosts: { [targetKey(login)]: false } }, login)).toBe(false);
    expect(isHpcHost(tagged, null)).toBe(false);
    expect(isHpcHost(tagged, { host: "" })).toBe(false);
  });

  it("tags one machine under every spelling of its target", () => {
    expect(isHpcHost(tagged, login)).toBe(true);
    expect(isHpcHost(tagged, { user: "alice", host: "LOGIN.example.org" })).toBe(true);
    expect(isHpcHost(tagged, { user: " alice ", host: " login.example.org ", port: 22 })).toBe(true);
    // A different login or port is a different connection.
    expect(isHpcHost(tagged, { user: "bob", host: "login.example.org" })).toBe(false);
    expect(isHpcHost(tagged, { user: "alice", host: "login.example.org", port: 2222 })).toBe(false);
  });
});

describe("mayAutoTouch", () => {
  it("fails closed while settings are unloaded — 'don't know yet' reads as 'not yet'", () => {
    // `isHpcHost(null, …)` answering false only skips drawing a badge; the same
    // answer here would authorise an SSH master on a login node before the app
    // has read its own settings.
    expect(mayAutoTouch(null, login)).toBe(false);
    expect(mayAutoTouch(undefined, login)).toBe(false);
  });

  it("allows an untagged host and refuses a tagged one once settings are in", () => {
    expect(mayAutoTouch({}, login)).toBe(true);
    expect(mayAutoTouch(tagged, login)).toBe(false);
    expect(mayAutoTouch({ hpc_hosts: { [targetKey(login)]: false } }, login)).toBe(true);
  });

  it("refuses a target with no host — there is nothing to reach", () => {
    expect(mayAutoTouch({}, null)).toBe(false);
    expect(mayAutoTouch({}, { host: "" })).toBe(false);
  });
});

describe("setHpcPatch", () => {
  it("merges into the existing map rather than replacing it", () => {
    const other = targetKey({ host: "gpu.example.org" });
    const patch = setHpcPatch({ hpc_hosts: { [other]: true } }, login, true);
    expect(patch.hpc_hosts).toEqual({ [other]: true, [targetKey(login)]: true });
  });

  it("untags by writing false, never by deleting, and copes with no map at all", () => {
    const patch = setHpcPatch(tagged, login, false);
    expect(patch.hpc_hosts).toEqual({ [targetKey(login)]: false });
    expect(setHpcPatch(null, login, true).hpc_hosts).toEqual({ [targetKey(login)]: true });
    // The input is not mutated — settings are saved whole from a fresh patch.
    expect(tagged.hpc_hosts?.[targetKey(login)]).toBe(true);
  });
});

describe("projectIsOnHpc", () => {
  const base = { id: "p", name: "p", status: "active" as const, position: 0, local_file: "/p" };

  it("reads the primary remote's target, with a blank user and port normalised", () => {
    const project: ProjectEntry = {
      ...base,
      remote: { user: "alice", host: "login.example.org", port: 22, remote_path: "/h" },
    };
    expect(projectIsOnHpc(tagged, project)).toBe(true);
    const noPort: ProjectEntry = { ...base, remote: { user: "alice", host: "login.example.org", remote_path: "/h" } };
    expect(projectIsOnHpc(tagged, noPort)).toBe(true);
    const anon: ProjectEntry = { ...base, remote: { user: "", host: "login.example.org", remote_path: "/h" } };
    expect(projectIsOnHpc({ hpc_hosts: { [targetKey({ host: "login.example.org" })]: true } }, anon)).toBe(true);
  });

  it("is false for a local project and for a tagged WORKER of an untagged primary", () => {
    expect(projectIsOnHpc(tagged, { ...base })).toBe(false);
    expect(projectIsOnHpc(tagged, null)).toBe(false);
    const project: ProjectEntry = {
      ...base,
      remote: { host: "head.example.org", remote_path: "/h" },
      compute_hosts: [{ id: "w", user: "alice", host: "login.example.org", remote_path: "/h" }],
    };
    // The primary owns files, git and the mirror — it is the host the walks are about.
    expect(projectIsOnHpc(tagged, project)).toBe(false);
  });
});
