/**
 * Auto-connect: a remote project that opted in comes up by itself — silently.
 *
 * The default stays what it always was: a remote project surfaces disconnected and
 * the user brings it up from the pill's connection lamp. The opt-in
 * (`remote.auto_connect`, offered only once a saved password or key auth makes the
 * connect promptless) changes that for one project: it is connected on launch and
 * on activation, and it *never* prompts — a stale opt-in degrades to staying
 * disconnected rather than ambushing the user with a modal.
 *
 * The load-bearing case is the VPN, because whether the tunnel is needed is a
 * property of the *network*, not of the project: the same host is reachable
 * directly at the office and only through the tunnel from home. So auto-connect
 * probes instead of assuming — and escalates to the tunnel only when the host is
 * genuinely unreachable, never when it merely rejected a credential.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";

import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

import { retryAutoConnectAfterVpn, useProjectsStore } from "../../stores/projects";
import { useConnectDialogStore } from "../../stores/remote/connectDialog";
import { useRemoteStatusStore } from "../../stores/remote/remoteStatus";
import { useSettingsStore } from "../../stores/settings";
import { useTabsStore } from "../../stores/tabs";
import { useVpnStatusStore } from "../../stores/remote/vpn/vpnStatus";
import { forgetConnection } from "../../lib/remote/remoteConnect";
import type { ProjectEntry, RemoteSpec, Settings, SshProbe } from "../../types";

const invokeMock = vi.mocked(invoke);

const REACHABLE: SshProbe = { ok: true, unreachable: false, error: "" };
const UNREACHABLE: SshProbe = {
  ok: false,
  unreachable: true,
  error: "ssh: connect to host host.example port 22: Connection timed out",
};
const REJECTED: SshProbe = {
  ok: false,
  unreachable: false,
  error: "alice@host.example: Permission denied (publickey,password).",
};

const project = (id: string, remote?: Partial<RemoteSpec>): ProjectEntry =>
  ({
    id,
    name: id,
    directory: `/local/${id}`,
    position: 0,
    status: "active",
    ...(remote
      ? { remote: { user: "alice", host: "host.example", remote_path: "/srv/work", ...remote } }
      : {}),
  }) as unknown as ProjectEntry;

/**
 * Drive the mocked backend. `probe` is what `ssh_probe` answers (an array is
 * consumed one call at a time, so a connect can be unreachable and then reachable
 * once the tunnel is up); every other command resolves unless overridden.
 */
const backend = (opts: {
  probe?: SshProbe | SshProbe[];
  sshSaved?: boolean;
  vpnSaved?: boolean;
  vpnFails?: boolean;
  /** Non-headless: how many readiness polls fail before the root-terminal login's
   *  ControlMaster answers (`Infinity` = the user never authenticates). */
  loginReadyAfter?: number;
  /** Non-headless: `openvpn_status` answers true from this poll onwards. */
  vpnUpAfter?: number;
}) => {
  const probes = Array.isArray(opts.probe) ? [...opts.probe] : opts.probe ? [opts.probe] : [];
  let sshConnects = 0;
  let vpnStatusChecks = 0;
  invokeMock.mockImplementation((cmd: string) => {
    switch (cmd) {
      case "ssh_probe":
        return Promise.resolve(probes.length > 1 ? probes.shift()! : (probes[0] ?? REACHABLE));
      case "remote_has_saved_password":
        return Promise.resolve(opts.sshSaved ?? true);
      // The eligibility gate reads the tri-state now, so that "not saved" and
      // "keyring unreadable" can be told apart in what the user is told. An
      // unmocked resolve here would answer `undefined`, which reads as neither.
      case "remote_saved_password_state":
        return Promise.resolve({ saved: opts.sshSaved ?? true, keyring: "unlocked" });
      case "vpn_has_saved_password":
        return Promise.resolve(opts.vpnSaved ?? false);
      case "openvpn_connect":
        return opts.vpnFails ? Promise.reject("tunnel failed") : Promise.resolve();
      case "remote_login_command":
        return Promise.resolve("ssh -tt alice@host.example");
      case "openvpn_login_command":
        return Promise.resolve("pkexec openvpn --config /cfg.ovpn");
      case "openvpn_status":
        return Promise.resolve(++vpnStatusChecks > (opts.vpnUpAfter ?? Infinity));
      case "ssh_connect":
        return sshConnects++ >= (opts.loginReadyAfter ?? 0)
          ? Promise.resolve()
          : Promise.reject("not authenticated yet");
      default:
        return Promise.resolve();
    }
  });
};

/** Resolve the microtasks the fire-and-forget connect chain runs on. */
const settle = () => new Promise((r) => setTimeout(r, 0));

const sshLamp = () => useRemoteStatusStore.getState().byProject.remote1?.ssh;
const vpnLamp = () => useRemoteStatusStore.getState().byProject.remote1?.vpn;

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation(() => Promise.resolve());
  useConnectDialogStore.setState({ projectId: null });
  useRemoteStatusStore.setState({ byProject: {} });
  useProjectsStore.setState({ projects: [], activeId: null });
  // Settings must be **loaded** for auto-connect to run at all: the HPC gate
  // (`lib/remote/hpc/hpcHost`'s `mayAutoTouch`) fails closed on an unloaded store, because
  // "we haven't read the tag yet" must not authorise a connect. The app has them
  // by the time any project is activated — `load()` now waits for them — so the
  // tests give them too. The tag map is empty, so no host here is HPC-tagged.
  useSettingsStore.setState({ settings: {} as Settings, loaded: true });
});

describe("auto-connect opt-in", () => {
  it("connects a flagged project silently, without touching the VPN", async () => {
    backend({ probe: REACHABLE, sshSaved: true });
    useProjectsStore.setState({ projects: [project("remote1", { auto_connect: true })] });

    await useProjectsStore.getState().setActive("remote1");
    await settle();

    expect(invokeMock).toHaveBeenCalledWith("remote_connect", {
      projectId: "remote1",
      password: null,
    });
    expect(sshLamp()).toBe("connected");
    // Reachable directly: the tunnel is unnecessary on this network and must stay down.
    expect(invokeMock).not.toHaveBeenCalledWith("openvpn_connect", expect.anything());
    // Nothing to ask for — the modal must stay shut.
    expect(useConnectDialogStore.getState().projectId).toBeNull();
  });

  it("leaves an unflagged remote project disconnected, and never prompts", async () => {
    backend({ probe: REACHABLE, sshSaved: true });
    useProjectsStore.setState({ projects: [project("remote1")] });

    await useProjectsStore.getState().setActive("remote1");
    await settle();

    expect(invokeMock).not.toHaveBeenCalledWith("remote_connect", expect.anything());
    expect(sshLamp()).toBeUndefined();
    expect(useConnectDialogStore.getState().projectId).toBeNull();
  });

  it("connects the initially-active flagged project on launch", async () => {
    backend({ probe: REACHABLE, sshSaved: true });
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "get_projects")
        return Promise.resolve([{ ...project("remote1", { auto_connect: true }), status: "current" }]);
      if (cmd === "ssh_probe") return Promise.resolve(REACHABLE);
      if (cmd === "remote_has_saved_password") return Promise.resolve(true);
      return Promise.resolve();
    });

    await useProjectsStore.getState().load();
    await settle();

    expect(invokeMock).toHaveBeenCalledWith("remote_connect", {
      projectId: "remote1",
      password: null,
    });
    expect(sshLamp()).toBe("connected");
  });

  it("brings the VPN up when the host is unreachable, then connects", async () => {
    // The other network: the host answers only through the tunnel.
    backend({
      probe: [UNREACHABLE, REACHABLE],
      sshSaved: true,
      vpnSaved: true,
    });
    useProjectsStore.setState({
      projects: [
        project("remote1", { auto_connect: true, openvpn: { config: "/cfg.ovpn" } }),
      ],
    });

    await useProjectsStore.getState().setActive("remote1");
    await settle();

    expect(invokeMock).toHaveBeenCalledWith("openvpn_connect", {
      config: "/cfg.ovpn",
      username: null,
      password: null,
      keyPassphrase: null,
      // `null`, never `false`: the backend reads `false` as "the user unticked Save
      // passphrase" and clears the keychain — an auto-connect would then delete the
      // passphrase it just used, and prompt on the next launch.
      remember: null,
    });
    expect(vpnLamp()).toBe("connected");
    expect(sshLamp()).toBe("connected");
  });

  it("does not bring the VPN up when the host merely rejected the credential", async () => {
    // No tunnel fixes a wrong password, and it is not wanted on this network.
    backend({ probe: REJECTED, sshSaved: true, vpnSaved: true });
    useProjectsStore.setState({
      projects: [
        project("remote1", { auto_connect: true, openvpn: { config: "/cfg.ovpn" } }),
      ],
    });

    await useProjectsStore.getState().setActive("remote1");
    await settle();

    expect(invokeMock).not.toHaveBeenCalledWith("openvpn_connect", expect.anything());
    expect(invokeMock).not.toHaveBeenCalledWith("remote_connect", expect.anything());
    expect(sshLamp()).toBe("error");
    // A failed auto-connect stays quiet: red lamp, no modal.
    expect(useConnectDialogStore.getState().projectId).toBeNull();
  });

  it("stays disconnected when the saved password has since been forgotten", async () => {
    // Stale opt-in: the toggle is on but the keychain entry is gone and the host is
    // not key-auth. Connecting would prompt, so we must not connect at all.
    backend({ probe: REACHABLE, sshSaved: false });
    useProjectsStore.setState({ projects: [project("remote1", { auto_connect: true })] });

    await useProjectsStore.getState().setActive("remote1");
    await settle();

    expect(invokeMock).not.toHaveBeenCalledWith("ssh_probe", expect.anything());
    expect(invokeMock).not.toHaveBeenCalledWith("remote_connect", expect.anything());
    expect(useConnectDialogStore.getState().projectId).toBeNull();
  });

  it("auto-connects a key-auth host with nothing in the keychain", async () => {
    backend({ probe: REACHABLE, sshSaved: false });
    useProjectsStore.setState({
      projects: [project("remote1", { auto_connect: true, key_auth: true })],
    });

    await useProjectsStore.getState().setActive("remote1");
    await settle();

    expect(sshLamp()).toBe("connected");
  });

  it("abandons the connect — and the lamp — when the user switches away mid-probe", async () => {
    let resolveProbe: ((p: SshProbe) => void) | undefined;
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "ssh_probe") return new Promise((res) => (resolveProbe = res as never));
      if (cmd === "remote_has_saved_password") return Promise.resolve(true);
      return Promise.resolve();
    });
    useProjectsStore.setState({
      projects: [project("remote1", { auto_connect: true }), project("local1")],
    });

    await useProjectsStore.getState().setActive("remote1");
    await settle();
    expect(sshLamp()).toBe("connecting"); // probe in flight — the lamp is ours

    // Switch away while the probe is still in flight, then let it come back.
    await useProjectsStore.getState().setActive("local1");
    resolveProbe?.(REACHABLE);
    await settle();

    expect(invokeMock).not.toHaveBeenCalledWith("remote_connect", expect.anything());
    // A lamp stuck on "connecting" would lie in the header *and* wedge the project
    // shut — the next auto-connect only fires from "off".
    expect(sshLamp()).toBe("off");
  });

  it("does not re-attack a host that already failed this session", async () => {
    backend({ probe: REJECTED, sshSaved: true });
    useProjectsStore.setState({
      projects: [project("remote1", { auto_connect: true }), project("local1")],
    });

    await useProjectsStore.getState().setActive("remote1");
    await settle();
    expect(sshLamp()).toBe("error");

    const probesAfterFirst = invokeMock.mock.calls.filter(([cmd]) => cmd === "ssh_probe").length;
    await useProjectsStore.getState().setActive("local1");
    await useProjectsStore.getState().setActive("remote1");
    await settle();

    // Switching back and forth must not re-probe an unreachable host every time.
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "ssh_probe")).toHaveLength(
      probesAfterFirst,
    );
  });
});

/**
 * The same opt-in, in the mode where Tabtivity handles no passwords at all
 * (`connections_headless` off).
 *
 * The headless gate — a saved SSH password, or a `key_auth` host — can never pass
 * there: nothing is ever written to the keychain in that mode, so auto-connect used
 * to reject *every* project and do nothing at all, silently. The substitution is the
 * one the header's "Connect on launch" already makes for a tunnel: the connect
 * command opens in the **root terminal** for the user to authenticate, and the pooled
 * connection then rides the ControlMaster that login leaves behind. The promise the
 * toggle keeps is unchanged — no modal is ever raised — but it is kept differently.
 */
describe("auto-connect with connections_headless off", () => {
  const rootTabs = () => useTabsStore.getState().tabsByScope.root ?? [];
  const rootInputs = () => rootTabs().map((t) => t.initialInput);

  beforeEach(() => {
    useSettingsStore.setState({
      settings: { connections_headless: false } as unknown as Settings,
      loaded: true,
    });
    useTabsStore.setState({ tabsByScope: {}, layoutByScope: {} });
    // The machine-wide VPN store is the thing a phantom would strand — start clean so
    // an assertion of "no entry" means this test, not a leftover from another.
    useVpnStatusStore.setState({ byConfig: {}, holders: {} });
    // The root-terminal dedupe is module-level and session-lived by design (a project
    // re-activated five times gets one login tab, not five), so each test has to hand
    // its keys back or only the first would open one.
    forgetConnection("ssh:alice@host.example:");
    forgetConnection("vpn:/cfg.ovpn");
    vi.useFakeTimers();
  });

  afterEach(async () => {
    // Drain any readiness poll still in flight: its `autoConnecting` claim is only
    // released when it resolves, and that claim is module-level too.
    await vi.advanceTimersByTimeAsync(3000 * 41);
    vi.useRealTimers();
    useSettingsStore.setState({ settings: null, loaded: false });
  });

  it("opens the SSH login in the root terminal, then connects once it is authenticated", async () => {
    // A password host: nothing saved, no key auth — exactly the project the headless
    // gate used to reject outright.
    backend({ probe: REJECTED, sshSaved: false, loginReadyAfter: 1 });
    useProjectsStore.setState({ projects: [project("remote1", { auto_connect: true })] });

    await useProjectsStore.getState().setActive("remote1");
    await vi.advanceTimersByTimeAsync(0);
    // The login is waiting for the user; the lamp says so rather than going red.
    expect(rootInputs()).toContain("ssh -tt alice@host.example");
    expect(sshLamp()).toBe("connecting");
    expect(useConnectDialogStore.getState().projectId).toBeNull();

    // First readiness poll fails (not authenticated yet), the second rides the master.
    await vi.advanceTimersByTimeAsync(7000);

    expect(invokeMock).toHaveBeenCalledWith("remote_connect", {
      projectId: "remote1",
      hostId: null,
      password: null,
      // The pool rode the login's master, so the connect says nothing about how the
      // host authenticates — the backend must not record `key_auth` off the back of
      // it (`record_key_auth`), or this password host would claim a promptless
      // connect it can't deliver the next time headless mode is on.
      viaLogin: true,
    });
    expect(sshLamp()).toBe("connected");
  });

  it("connects a key-auth host with no terminal at all", async () => {
    backend({ probe: REACHABLE, sshSaved: false });
    useProjectsStore.setState({ projects: [project("remote1", { auto_connect: true })] });

    await useProjectsStore.getState().setActive("remote1");
    await vi.advanceTimersByTimeAsync(0);

    // The probe authenticated: there is nothing for the user to type, so no login tab.
    expect(rootTabs()).toHaveLength(0);
    expect(sshLamp()).toBe("connected");
  });

  it("surfaces the VPN login in the root terminal when the host is unreachable", async () => {
    backend({ probe: UNREACHABLE, sshSaved: false });
    useProjectsStore.setState({
      projects: [project("remote1", { auto_connect: true, openvpn: { config: "/cfg.ovpn" } })],
    });

    await useProjectsStore.getState().setActive("remote1");
    await vi.advanceTimersByTimeAsync(0);
    expect(rootInputs()).toContain("pkexec openvpn --config /cfg.ovpn");
    // Tabtivity never handles the passphrase here, so the headless connect must not fire.
    expect(invokeMock).not.toHaveBeenCalledWith("openvpn_connect", expect.anything());
    // Red, not "connecting" — the host is unreachable until the tunnel is up, and red
    // is what `retryAutoConnectAfterVpn` clears once the tunnel actually comes up.
    expect(sshLamp()).toBe("error");
  });

  // The regression that stranded the header on a phantom yellow tunnel: an unattended
  // project poll that marked the *machine-wide* VPN "connecting" and then never
  // resolved it. The header's Disconnect is disabled while "connecting" and the
  // Connect dialog reads "connecting" as a live tunnel, so a phantom is un-stoppable
  // AND un-reconnectable. Non-headless auto-connect must therefore NEVER put a config
  // into the machine-wide store — the lamp belongs to `VpnIndicator`'s reconcile,
  // which is driven by the backend's real tunnel set and cannot strand.
  it("never marks the machine-wide tunnel connecting from auto-connect (no phantom)", async () => {
    backend({ probe: UNREACHABLE, sshSaved: false });
    useProjectsStore.setState({
      projects: [project("remote1", { auto_connect: true, openvpn: { config: "/cfg.ovpn" } })],
    });

    await useProjectsStore.getState().setActive("remote1");
    // Run out the whole poll window that the old code would have spun on.
    await vi.advanceTimersByTimeAsync(3000 * 45);

    // The machine-wide store is untouched — no "connecting", no entry at all — so the
    // header's Disconnect stays enabled and the dialog never thinks a tunnel is up.
    // This is the load-bearing assertion: the phantom lived here.
    expect(useVpnStatusStore.getState().byConfig).toEqual({});
    // The project's own VPN lamp is likewise never stuck yellow (it defaults to "off"
    // as a side effect of setting the SSH lamp; it must never be "connecting").
    expect(vpnLamp()).not.toBe("connecting");
    // Tabtivity handles no passphrase here, so no silent connect fires.
    expect(invokeMock).not.toHaveBeenCalledWith("openvpn_connect", expect.anything());
  });

  it("completes once the machine-wide reconcile reports the tunnel up", async () => {
    // First activation: unreachable, so the VPN login is surfaced and SSH goes red.
    backend({ probe: UNREACHABLE, sshSaved: false });
    useProjectsStore.setState({
      projects: [project("remote1", { auto_connect: true, openvpn: { config: "/cfg.ovpn" } })],
    });
    await useProjectsStore.getState().setActive("remote1");
    await vi.advanceTimersByTimeAsync(0);
    expect(sshLamp()).toBe("error");

    // The user authenticates the tunnel; `VpnIndicator.refresh` reconciles it up and
    // the store's subscriber fires `retryAutoConnectAfterVpn`. The host now answers
    // and takes key auth, so the pool connects with no login tab.
    backend({ probe: REACHABLE, sshSaved: false });
    retryAutoConnectAfterVpn();
    await vi.advanceTimersByTimeAsync(0);

    expect(sshLamp()).toBe("connected");
    expect(invokeMock).toHaveBeenCalledWith(
      "remote_connect",
      expect.objectContaining({ projectId: "remote1" }),
    );
  });

  it("leaves the tunnel alone when the host merely rejected the credential", async () => {
    // Reachable but unauthenticated is the *normal* state of a password host here —
    // it must not be read as "the network needs the VPN".
    backend({ probe: REJECTED, sshSaved: false, loginReadyAfter: Infinity });
    useProjectsStore.setState({
      projects: [project("remote1", { auto_connect: true, openvpn: { config: "/cfg.ovpn" } })],
    });

    await useProjectsStore.getState().setActive("remote1");
    await vi.advanceTimersByTimeAsync(0);

    expect(invokeMock).not.toHaveBeenCalledWith("openvpn_login_command", expect.anything());
    expect(rootInputs()).toContain("ssh -tt alice@host.example");
  });

  it("gives up on a login that is never authenticated, without prompting", async () => {
    backend({ probe: REJECTED, sshSaved: false, loginReadyAfter: Infinity });
    useProjectsStore.setState({ projects: [project("remote1", { auto_connect: true })] });

    await useProjectsStore.getState().setActive("remote1");
    await vi.advanceTimersByTimeAsync(0);
    // ~2 min of polling (40 × 3s), then the lamp goes red and the polling stops.
    await vi.advanceTimersByTimeAsync(3000 * 41);

    expect(sshLamp()).toBe("error");
    expect(invokeMock).not.toHaveBeenCalledWith("remote_connect", expect.anything());
    expect(useConnectDialogStore.getState().projectId).toBeNull();
  });

  it("still leaves an unflagged project disconnected", async () => {
    backend({ probe: REJECTED, sshSaved: false });
    useProjectsStore.setState({ projects: [project("remote1")] });

    await useProjectsStore.getState().setActive("remote1");
    await vi.advanceTimersByTimeAsync(5000);

    expect(rootTabs()).toHaveLength(0);
    expect(sshLamp()).toBeUndefined();
  });

  it("treats a closed login tab as 'not now' — disconnected, and re-offered next time", async () => {
    backend({ probe: REJECTED, sshSaved: false, loginReadyAfter: Infinity });
    useProjectsStore.setState({
      projects: [project("remote1", { auto_connect: true }), project("local1")],
    });

    await useProjectsStore.getState().setActive("remote1");
    await vi.advanceTimersByTimeAsync(0);
    const login = rootTabs()[0];
    expect(login.initialInput).toBe("ssh -tt alice@host.example");

    // The user closes the login instead of authenticating.
    useTabsStore.getState().removeTab(login.key);
    await vi.advanceTimersByTimeAsync(4000);

    // Not an error: nothing failed, the user declined. The distinction is load-bearing
    // — the re-attempt guard only fires from "off", so a red lamp here would wedge the
    // project shut until the pill's lamp was clicked.
    expect(sshLamp()).toBe("off");

    // And the dedupe expired with the tab, so switching back offers the login again
    // rather than silently waiting on a master that is never coming.
    await useProjectsStore.getState().setActive("local1");
    await useProjectsStore.getState().setActive("remote1");
    await vi.advanceTimersByTimeAsync(0);
    expect(rootInputs()).toContain("ssh -tt alice@host.example");
  });
});
