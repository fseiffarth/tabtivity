import { describe, expect, it } from "vitest";

import {
  carefulIsExplicit,
  clearCarefulPatch,
  isCarefulHost,
  primaryTargetOf,
  setCarefulPatch,
  targetOfSpec,
} from "../../lib/remote/carefulHost";
import { targetKey } from "../../lib/remote/machineSync";
import type { ProjectEntry, Settings } from "../../types";

const login = { user: "alice", host: "login.example.org", port: 22 };

describe("careful-host resolution", () => {
  it("treats an unanswered remote machine as careful, and a local one never", () => {
    // The failure direction, and the reason there is no HPC detection left: a
    // wrong careful costs a thinner table, a wrong full reading costs a policy
    // violation on someone else's cluster. Only "no target" — the local machine,
    // where Tabtivity is not a guest — reads false.
    expect(isCarefulHost({}, login)).toBe(true);
    expect(isCarefulHost({}, null)).toBe(false);
    expect(isCarefulHost({}, { host: "" })).toBe(false);
  });

  it("lets an explicit OFF outrank the careful default", () => {
    // The reason careful_hosts is a map to boolean rather than a set of hosts:
    // in a set, "off" and "never asked" are the same value, so a machine the user
    // switched to a full reading would revert to careful at every read.
    const settings: Settings = { careful_hosts: { [targetKey(login)]: false } };
    expect(isCarefulHost(settings, login)).toBe(false);
  });

  it("keeps an explicit ON, which is also what the default would say", () => {
    const settings: Settings = { careful_hosts: { [targetKey(login)]: true } };
    expect(isCarefulHost(settings, login)).toBe(true);
  });

  it("treats one machine reached under different spellings as the same host", () => {
    // The whole point of keying by target rather than by host id: the same login
    // node is a primary remote, a worker and a global machine, written down three
    // times, and must not be careful in one place and not in another.
    const settings: Settings = { careful_hosts: { [targetKey(login)]: true } };
    expect(isCarefulHost(settings, { user: "alice", host: "LOGIN.example.org", port: 22 })).toBe(true);
    expect(isCarefulHost(settings, { user: "alice", host: "login.example.org" })).toBe(true);
    expect(isCarefulHost(settings, { user: " alice ", host: " login.example.org " })).toBe(true);
  });

  it("does not carry an answer across a different login or port", () => {
    // A different login on the same box is a different connection, so the "this
    // one is mine" answer must not follow it — it falls back to careful.
    const settings: Settings = { careful_hosts: { [targetKey(login)]: false } };
    expect(isCarefulHost(settings, { user: "someone-else", host: "login.example.org" })).toBe(true);
    expect(isCarefulHost(settings, { user: "alice", host: "login.example.org", port: 2222 })).toBe(
      true,
    );
  });

  it("distinguishes an explicit answer from the default", () => {
    expect(carefulIsExplicit({}, login)).toBe(false);
    const settings: Settings = { careful_hosts: { [targetKey(login)]: false } };
    expect(carefulIsExplicit(settings, login)).toBe(true);
  });

  it("merges rather than replaces when recording an answer", () => {
    // Settings are saved WHOLE, so a patch that replaced the map would drop every
    // other host's answer on the floor.
    const other = targetKey({ host: "other.example.org" });
    const settings: Settings = { careful_hosts: { [other]: true } };
    const patch = setCarefulPatch(settings, login, true);
    expect(patch.careful_hosts).toEqual({ [other]: true, [targetKey(login)]: true });
  });

  it("returns a host to the careful default when its answer is cleared", () => {
    const settings: Settings = { careful_hosts: { [targetKey(login)]: false } };
    const patch = clearCarefulPatch(settings, login);
    expect(patch.careful_hosts).toEqual({});
    expect(isCarefulHost(patch as Settings, login)).toBe(true);
  });

  it("reads no target from a local project and the primary from a remote one", () => {
    expect(primaryTargetOf({ id: "p" } as ProjectEntry)).toBeNull();
    const remote = {
      id: "p",
      remote: { user: "alice", host: "login.example.org", port: 22, remote_path: "/home/x" },
    } as ProjectEntry;
    expect(primaryTargetOf(remote)).toEqual(login);
  });

  it("agrees byte-for-byte with the Rust target_key", () => {
    // Both sides index settings.careful_hosts by this exact string. A divergence
    // would not fail loudly — it would look up a host nobody wrote and answer
    // "not careful", i.e. fail OPEN in the case the flag exists to protect. These
    // two literals are duplicated verbatim in `ssh_common::tests
    // ::target_key_matches_frontend`; changing one must break the other.
    expect(targetKey({ user: "alice", host: "login.example.org", port: 2222 })).toBe(
      "alice@login.example.org:2222",
    );
    expect(targetKey({ host: "h" })).toBe("@h:22");
  });

  it("reads one target out of any RemoteSpec-shaped record", () => {
    // A primary remote, a compute host and a global machine all spell user/host/
    // port the same way, which is what lets one key span all three tables.
    expect(targetOfSpec({ user: "alice", host: "login.example.org", port: 22 })).toEqual(login);
    expect(targetOfSpec({ user: "", host: "h", port: null })).toEqual({
      user: undefined,
      host: "h",
      port: undefined,
    });
    expect(targetOfSpec(null)).toBeNull();
  });
});
