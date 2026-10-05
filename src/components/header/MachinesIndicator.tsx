import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { ConnLamp } from "../common/ConnLamp";
import { Toggle } from "../common/Toggle";
import { PasswordInput } from "../common/PasswordInput";
import { UntestedTag } from "../common/UntestedTag";
import { useGlobalMachinesStore, type ImportResult } from "../../stores/remote/globalMachines";
import { useGlobalMachineMonitorStore } from "../../stores/remote/globalMachineMonitor";
import { useProjectsStore } from "../../stores/projects";
import { useSettingsStore } from "../../stores/settings";
import { useRemoteMachinesStore } from "../../stores/remote/remoteMachines";
import { machineKey, useRemoteUsageStore, type RemoteUsageReport } from "../../stores/remote/remoteUsage";
import { useHostBusyStore, busyReading, busyLabel } from "../../stores/remote/hostBusy";
import { parseSshAddress } from "../projects/scaffold";
import { TerminalSignInToggle } from "../projects/TerminalSignInToggle";
import { openConnectionInRoot } from "../../lib/remote/remoteConnect";
import { isHpcHost, mayAutoTouch, setHpcPatch, targetOfSpec } from "../../lib/remote/hpc/hpcHost";
import { isCarefulHost } from "../../lib/remote/carefulHost";
import { hpcGuardRefusal } from "../../lib/remote/hpc/hpcGuard";
import { useT, type TranslationKey } from "../../lib/i18n";
import { useHeaderHoverMenuStore } from "../../stores/headerHoverMenu";
import { useHeaderStatusReport } from "../../stores/headerStatus";
import type { ConnState } from "../../stores/remote/remoteStatus";
import type { GlobalMachine, MachineImportEntry, ProjectEntry } from "../../types";
import { ErrorNote } from "../common/ErrorNote";
import { useMachinesOverlayStore } from "../../stores/machinesOverlay";
import { MachinesOverlayFrame } from "./MachinesOverlay";
import { MachinesGlyph } from "./HeaderGlyphs";
import { BRAND } from "../../lib/brand";

const MENU_ID = "machines";

/**
 * **What a row actually knows**, from the two maps that used to be one.
 *
 * `status` means "a session THIS app opened" and nothing else; `reachable` is the
 * last probe's answer, and a probe is not a session (see `stores/remote/globalMachines`).
 * Folding them together is what painted a merely-reachable host green — and, the
 * dangerous direction, what would now leave a machine whose session died sitting
 * on a green lamp forever, because no sweep writes `status` any more. So a row
 * reads both, and says which of the two it is looking at.
 */
type RowState =
  /** A session is open and the last probe (if any) agrees. */
  | "connected"
  /** A session is open but the host did not answer the last probe — the one case
   *  nothing else in the app will catch, and the reason this type exists. */
  | "stale"
  | "connecting"
  /** The last *connect* attempt failed (`errors[id]` says how). */
  | "error"
  /** No session, but the host answered — deliberately NOT green: "you could
   *  connect", not "you are connected". */
  | "reachable"
  | "unreachable"
  /** Never probed — a fresh machine, or one tagged HPC, which no sweep touches. */
  | "unknown";

/** The honest read of one machine. `reachable === undefined` means "nobody has
 *  asked", which is a third answer, not a quiet "no". */
export function rowStateOf(status: ConnState, reachable: boolean | undefined): RowState {
  if (status === "connecting") return "connecting";
  if (status === "connected") return reachable === false ? "stale" : "connected";
  if (status === "error") return "error";
  return reachable === true ? "reachable" : reachable === false ? "unreachable" : "unknown";
}

/** Which of `ConnLamp`'s four colours a row state paints. Three states share the
 *  grey dot — none of them is a session, which is the only thing green may mean —
 *  and the badge beside it (`STATE_BADGE`) is what tells them apart. */
const STATE_LAMP: Record<RowState, ConnState> = {
  connected: "connected",
  stale: "error",
  connecting: "connecting",
  error: "error",
  reachable: "off",
  unreachable: "off",
  unknown: "off",
};

/** The aggregate strip stays a fixed, tiny budget of dots: one per *colour*
 *  present, not one per state, so a seven-state model can't grow the header of a
 *  seventeen-machine fleet into a dashboard. The breakdown lives in the tooltip,
 *  where a count per state costs nothing. Most-relevant colour first, as before. */
const LAMP_BUCKETS: { lamp: ConnState; states: RowState[] }[] = [
  { lamp: "error", states: ["error", "stale"] },
  { lamp: "connecting", states: ["connecting"] },
  { lamp: "connected", states: ["connected"] },
  { lamp: "off", states: ["reachable", "unreachable", "unknown"] },
];

/** The states `ConnLamp`'s own tooltip already spells out — it prints
 *  "<label>: <colour>", which is only the whole truth when the colour and the
 *  state are the same word. The other four put the word in the label instead. */
const LAMP_SAYS_IT = new Set<RowState>(["connected", "connecting", "error"]);

/** One word per state, for the aggregate tooltip's "3 connected — a, b, c". */
const STATE_WORD: Record<RowState, TranslationKey> = {
  connected: "machines.state.connected",
  stale: "machines.state.stale",
  connecting: "machines.state.connecting",
  error: "machines.state.error",
  reachable: "machines.state.reachable",
  unreachable: "machines.state.unreachable",
  unknown: "machines.state.unknown",
};

/** The terse pill on the row. Only for states the lamp cannot say by itself —
 *  a green lamp already means "connected", so that row carries no pill and a
 *  long list stays scannable. */
const STATE_BADGE: Partial<Record<RowState, TranslationKey>> = {
  stale: "machines.badge.stale",
  reachable: "machines.badge.reachable",
  unreachable: "machines.badge.unreachable",
  unknown: "machines.badge.unknown",
};

/** The sentence behind each state, on the row's hover. */
const STATE_TIP: Record<RowState, TranslationKey> = {
  connected: "machines.tip.connected",
  stale: "machines.tip.stale",
  connecting: "machines.tip.connecting",
  error: "machines.tip.error",
  reachable: "machines.tip.reachable",
  unreachable: "machines.tip.unreachable",
  unknown: "machines.tip.unknown",
};

/** How long a probe answer is worth reusing. The sweep runs when this menu
 *  opens, and opening a menu twice in a minute is a glance, not a question —
 *  `ssh_probe` is a full authenticated login per host, so a fleet of seventeen
 *  would otherwise pay seventeen logins for each of them. */
const PROBE_MIN_INTERVAL_MS = 60_000;

/** How often the open menu re-reads a Detailed machine's CPU/GPU utilization.
 *  One `global_machine_usage_check` login per machine per tick, and only while
 *  the menu is on screen — gentler than the system monitor's 3 s remote poll. */
const UTIL_POLL_MS = 10_000;

/** The open-sweep's two brakes, one pair for both surfaces (the dropdown and
 *  the overlay). In flight: a second open while the first sweep is still
 *  running must not stack a second round trip per host (`stores/remote/hostBusy`'s
 *  `inFlight` makes the same promise for the busy probe; the store's `probeAll`
 *  makes none). And a minimum interval, stamped per machine: reopening the list
 *  is a glance, not a new question. `probeAll` is all-or-nothing (it owns which
 *  machines it may touch), so the sweep runs only when at least one eligible
 *  machine's answer has aged out, and stamps every eligible machine when it
 *  returns. */
const probeBrakes = { inFlight: false, lastAt: new Map<string, number>() };

type HandCheck = { ok: boolean; at: number; error?: string };

/** Per-row manual checks — the only reachability a tagged HPC machine ever has,
 *  since every sweep skips it by design — and when the last sweep landed. Kept
 *  apart from `stores/remote/globalMachines` on purpose: its `reachable` is the
 *  sweep's map, and a hand probe must not be filed as one (nor may it touch
 *  `status`, which means "a session we opened"). A row prefers its hand check
 *  only while it is the newer of the two. Shared by the dropdown and the
 *  overlay, so both surfaces and the header's lamps read the same answer. */
const useMachineChecksStore = create<{
  sweepAt: number;
  checked: Record<string, HandCheck>;
  setSweepAt: (at: number) => void;
  setChecked: (update: (prev: Record<string, HandCheck>) => Record<string, HandCheck>) => void;
}>((set) => ({
  sweepAt: 0,
  checked: {},
  setSweepAt: (at) => set({ sweepAt: at }),
  setChecked: (update) => set((s) => ({ checked: update(s.checked) })),
}));

/**
 * Whether a row gets the inline CPU/GPU utilization bars: the machine is one the
 * user switched to **Detailed** in the system monitor (`careful_hosts` answered
 * `false` for its target — the default for every remote machine is careful) and
 * is not HPC-tagged, which outranks that answer. Careful is "read me lightly";
 * a sweep that logs in every few seconds just to draw a bar is not light.
 */
export function showsUtilization(
  settings: Parameters<typeof isCarefulHost>[0],
  m: { user?: string; host: string; port?: number },
): boolean {
  const target = targetOfSpec(m);
  return !isHpcHost(settings, target) && !isCarefulHost(settings, target);
}

/** The two bar readings from a usage report. GPU is the busiest adapter, and
 *  `null` when the host reports no GPU — omitted, never drawn as an idle zero. */
export function utilizationOf(r: RemoteUsageReport): { cpu: number; gpu: number | null } {
  const clamp = (n: number) => Math.min(100, Math.max(0, n));
  const gpu = r.gpus.length ? Math.max(...r.gpus.map((g) => g.utilPct)) : null;
  return { cpu: clamp(r.cpuPct), gpu: gpu === null ? null : clamp(gpu) };
}

/** One labelled mini meter; tone by ratio like the local-model meters. */
function UtilBar({ label, pct, title }: { label: string; pct: number; title: string }) {
  const tone = pct >= 85 ? "high" : pct >= 60 ? "medium" : "low";
  return (
    <span className="machines-util-item" title={title}>
      <span className="machines-util-label">{label}</span>
      <span className="local-model-meter machines-util-meter">
        <span className={`local-model-meter-fill ${tone}`} style={{ width: `${pct}%` }} />
      </span>
      <span className="machines-util-value">{Math.round(pct)}%</span>
    </span>
  );
}

export function targetLabel(m: { user?: string; host: string; port?: number }): string {
  return `${m.user ? `${m.user}@` : ""}${m.host}${m.port ? `:${m.port}` : ""}`;
}

/**
 * Global worker machines, in the header — the VPN indicator's pattern applied
 * to SSH hosts a project doesn't own. Authenticated once via the ordinary
 * login mechanism, with no project/path attached, then handed to a project from
 * a row's "add to a project" picker: a remote project gains a `shared_fs`
 * compute host, a local one is offered "Extend to remote" with that machine as
 * its primary — deliberately a menu, not a drag: a machine's target lives
 * outside this list, and no drag can reach it (see below). Rows DO reorder by
 * dragging their grip, but on POINTER events, which is the difference that
 * makes it work — a native HTML5 drag out of a pop-up menu is unworkable under
 * WebKitGTK (the menu closes or hangs mid-drag, and a drop that misses its
 * target never fires, stranding the row in its dimmed drag state).
 * Detaching a machine from a project never touches this list — see
 * `stores/remote/globalMachines.ts` / `commands::global_machines`.
 *
 * It shares the header's hover-menu interaction with Mobile and VPN. Opening it
 * refreshes the fleet snapshot; an in-flight guard and per-machine minimum
 * interval prevent repeated probes, and a machine tagged HPC remains excluded
 * (`lib/remote/hpc/hpcHost`'s `mayAutoTouch`) — its row alone offers Check (◎) and login.
 *
 * **A row reads two maps, not one** (see `RowState`): `status` is a session THIS
 * app opened, `reachable` is the last probe's answer. Green means the first;
 * "up" means only the second; and a session on a host that has stopped answering
 * is drawn as *stale*, which is the one state nothing else in the app can catch,
 * since no sweep writes `status` any more.
 *
 * **Two surfaces, one list.** A hover shows the dropdown; a click on the button
 * (or the dropdown's ⤢ door) opens the Machines overlay (`MachinesOverlayHost`,
 * framed by `header/MachinesOverlay`), where the same rows are tiles in a grid
 * — the Models & agents overlay's `.models-tile` look. Both are this component
 * (`surface`), so every rule above holds in both; the overlay only drops what
 * belongs to a narrow pop-up: the drag grip (reordering stays the dropdown's)
 * and the ▸ fold (a tile has the room to show its details).
 */
export function MachinesIndicator() {
  return <MachinesSurface surface="menu" />;
}

/** The Machines overlay, at the shell (`layout/AppShell`). Renders nothing
 *  while closed, so none of its probes or polls run then. */
export function MachinesOverlayHost() {
  const open = useMachinesOverlayStore((s) => s.open);
  if (!open) return null;
  return <MachinesSurface surface="overlay" />;
}

function MachinesSurface({ surface }: { surface: "menu" | "overlay" }) {
  const t = useT();
  const isOverlay = surface === "overlay";
  // Off by default (Settings' "Remote features") — most projects are local-only,
  // so this fleet-wide SSH list stays out of the header until asked for.
  const enabled = useSettingsStore((s) => s.settings?.machines_enabled ?? false);
  const headless = useSettingsStore((s) => s.settings?.connections_headless ?? true);
  // The whole settings object (not one flag) because the HPC tag is a map keyed
  // by SSH target: the row reads its own machine's entry, and writing one has to
  // merge into the rest rather than replace them.
  const settings = useSettingsStore((s) => s.settings);
  const updateSettings = useSettingsStore((s) => s.updateSettings);
  const machines = useGlobalMachinesStore((s) => s.machines);
  const status = useGlobalMachinesStore((s) => s.status);
  // The other half of a row's truth: the last probe answer, kept apart from
  // `status` on purpose (see `RowState`). Absent = never probed.
  const reachable = useGlobalMachinesStore((s) => s.reachable);
  const errors = useGlobalMachinesStore((s) => s.errors);
  const load = useGlobalMachinesStore((s) => s.load);
  const probeAll = useGlobalMachinesStore((s) => s.probeAll);
  const connect = useGlobalMachinesStore((s) => s.connect);
  const disconnect = useGlobalMachinesStore((s) => s.disconnect);
  const retryAll = useGlobalMachinesStore((s) => s.retryAll);
  // Busy readings are keyed by SSH target, so this one subscription lights both
  // the aggregate strip and every row.
  const readings = useHostBusyStore((s) => s.readings);
  const disconnectAll = useGlobalMachinesStore((s) => s.disconnectAll);
  const remove = useGlobalMachinesStore((s) => s.remove);
  // Persist-without-authenticating: the terminal sign-in has already logged in,
  // so `add`'s `ssh_connect` would be a second login (and a password prompt this
  // mode exists to avoid).
  const register = useGlobalMachinesStore((s) => s.register);
  const add = useGlobalMachinesStore((s) => s.add);
  const update = useGlobalMachinesStore((s) => s.update);
  // The terminal-login edit path adopts a session the user opened in the root
  // terminal, so it persists the identity with `connect: false` and lights the
  // lamp itself — `setStatus` is what `lib/remote/machineSync`'s subscription propagates.
  const setStatus = useGlobalMachinesStore((s) => s.setStatus);
  const setAutoConnect = useGlobalMachinesStore((s) => s.setAutoConnect);
  const reorder = useGlobalMachinesStore((s) => s.reorder);
  const exportMachines = useGlobalMachinesStore((s) => s.exportMachines);
  const importMachines = useGlobalMachinesStore((s) => s.importMachines);
  const openMonitor = useGlobalMachineMonitorStore((s) => s.open);
  // The projects a machine can be added to: the ACTIVE ones only — exactly the
  // set `ProjectSwitcher` renders as pills (`status !== "inactive"`), which is
  // both what the old drag gesture could reach and what the handoff needs, since
  // `requestExtend` is picked up by the target's mounted `ProjectPill`.
  const projects = useProjectsStore((s) => s.projects).filter((p) => p.status !== "inactive");
  const openUsage = useRemoteUsageStore((s) => s.open);
  const usageReports = useRemoteUsageStore((s) => s.reports);
  const openRemoteMachines = useRemoteMachinesStore((s) => s.open);
  const requestExtend = useRemoteMachinesStore((s) => s.requestExtend);

  /** Hand this machine to a project: a remote project gets it as a (shared-fs)
   *  compute host via the Remote machines window; a local-only one gets it as
   *  its primary host via the extend-to-remote flow. The same two branches the
   *  pill's drop target used to pick between. */
  const attachToProject = (p: ProjectEntry, m: { id: string; host: string; user?: string; port?: number; label?: string }) => {
    const machine = { id: m.id, host: m.host, user: m.user, port: m.port, label: m.label };
    if (p.remote) openRemoteMachines(p.id, machine);
    else requestExtend(p.id, machine);
  };

  // The shared menu store makes the status controls mutually exclusive.
  // The overlay is open for as long as it is mounted (its host renders nothing
  // while closed), so every "while open" effect below simply runs in it.
  const menuOpen = useHeaderHoverMenuStore((s) => s.openId === MENU_ID);
  const open = isOverlay || menuOpen;
  const openMenu = useHeaderHoverMenuStore((s) => s.open);
  const closeMenu = useHeaderHoverMenuStore((s) => s.close);
  /** Put this surface away — before a hand-off to a window of its own (the
   *  usage report, a project's machine picker), as the dropdown always has. */
  const dismiss = () => {
    if (isOverlay) useMachinesOverlayStore.getState().close();
    else closeMenu(MENU_ID);
  };
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const closeTimer = useRef<number | undefined>(undefined);
  // While an import/export panel is up — or a native file dialog is open, which
  // takes the focus and the pointer away from the menu — it must NOT close under
  // the user mid-flow. A ref (read synchronously by the dismiss handlers) rather
  // than state, so the guard is live the instant a dialog opens, before any
  // re-render.
  const keepOpenRef = useRef(false);
  // The open-sweep's two brakes are module-level (`probeBrakes`), shared by the
  // dropdown and the overlay: opening one right after the other is still one
  // login per host.
  // When the last sweep landed and the per-row hand checks live in
  // `useMachineChecksStore`, shared for the same reason — a Check pressed in
  // the overlay has to reach the header's lamps too.
  const sweepAt = useMachineChecksStore((s) => s.sweepAt);
  const setSweepAt = useMachineChecksStore((s) => s.setSweepAt);
  const checked = useMachineChecksStore((s) => s.checked);
  const setChecked = useMachineChecksStore((s) => s.setChecked);
  const [checking, setChecking] = useState<Set<string>>(new Set());
  // Failures of the two calls this component makes itself (the hand Check, the
  // explicit HPC login) — the store's `errors` map is written by the store's own
  // actions, and a row shows both.
  const [localErrors, setLocalErrors] = useState<Record<string, string>>({});
  // Per-row DOM nodes (keyed by machine id) + their last-measured positions,
  // for the FLIP slide animation when the list reorders.
  const rowRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const prevRects = useRef<Map<string, { left: number; top: number }>>(new Map());
  // Which row's "Add to a project" picker is open, if any. This is the ONLY way
  // a global machine reaches a project — the drag-onto-a-pill gesture it
  // replaced could not be made to work (see the component doc), and a picker
  // says which of the two ways the machine would join, which a drop could only
  // imply.
  const [attachId, setAttachId] = useState<string | null>(null);

  // Reorder-by-drag, on POINTER events — not HTML5 DnD, which is what broke the
  // first attempt (a native drag out of a hover-menu hangs under WebKitGTK, and
  // a drop outside a target never fires, stranding the row mid-drag). Same
  // choice `tabs/TabBar` and `embed/YamlTree` already made. The gesture starts
  // on the row's grip only, so the row's buttons stay clickable; the grip takes
  // a pointer capture, so `pointerup`/`pointercancel` are guaranteed to arrive
  // there and end the drag — there is no state a missed event can strand.
  //
  // `to` is the slot the dragged row would land in, as an index into the list
  // WITHOUT it. The other rows part to open that slot — but they part by
  // `transform` only, which changes no layout, so the rects measured at
  // pointerdown stay true for the whole gesture. Re-measuring a moved row
  // against the cursor that moved it is the feedback loop this avoids.
  const [reorderDrag, setReorderDrag] = useState<
    { id: string; dy: number; to: number } | null
  >(null);
  const dragRects = useRef<{ id: string; top: number; height: number }[]>([]);
  const dragStartY = useRef(0);
  const reorderDragRef = useRef(false);

  const reveal = useCallback(() => {
    window.clearTimeout(closeTimer.current);
    openMenu(MENU_ID);
  }, [openMenu]);
  const scheduleClose = useCallback(() => {
    window.clearTimeout(closeTimer.current);
    if (keepOpenRef.current || reorderDragRef.current) return;
    closeTimer.current = window.setTimeout(() => closeMenu(MENU_ID), 250);
  }, [closeMenu]);

  useEffect(() => () => window.clearTimeout(closeTimer.current), []);

  /** Where the dragged row would land, from the pointer's Y: the number of OTHER
   *  rows whose midpoint the cursor has passed — i.e. an index into the list
   *  without the dragged row, which is exactly what `commitMove` splices at. */
  const dropSlot = (id: string, clientY: number) => {
    const rest = dragRects.current.filter((r) => r.id !== id);
    return rest.filter((r) => clientY > r.top + r.height / 2).length;
  };

  const [removeArm, setRemoveArm] = useState<string | null>(null);
  const [disconnectArm, setDisconnectArm] = useState<string | null>(null);
  // Fleet-wide actions (retry all / disconnect all). `disconnectAllArm` gates the
  // destructive one behind a confirm, exactly as the per-row `disconnectArm` does.
  const [retryAllBusy, setRetryAllBusy] = useState(false);
  const [disconnectAllArm, setDisconnectAllArm] = useState(false);
  const [retryId, setRetryId] = useState<string | null>(null);
  // Prefilled from the machine's stored username in `startRetry` — a retry is a
  // re-authenticate of the SAME target, so the login it should default to is the
  // one already on file, not a blank field the user has to remember to refill.
  // Editing it here and reconnecting persists the correction (`submitEdit`'s
  // `update` path), since a login that was wrong is wrong for next time too.
  const [retryUser, setRetryUser] = useState("");
  const [retryPassword, setRetryPassword] = useState("");
  // Only for a `global_machine_update` validation failure (e.g. the edited
  // username collides with another row's target) — an auth failure instead
  // lands in the store's `errors` map and is shown from there, alongside the
  // aggregate lamp state.
  const [retryError, setRetryError] = useState("");
  // Rows render compact by default (lamp + label + actions only) — target
  // address, usage meters and the auto-connect toggle are behind a per-row
  // expand so a long machine list stays scannable.
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const toggleExpanded = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const [adding, setAdding] = useState(false);
  const [address, setAddress] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [label, setLabel] = useState("");
  const [savePassword, setSavePassword] = useState(false);
  // Arm the new machine for the launch / VPN-up sweep straight from the add form,
  // so a machine you connect once can silently reconnect on relaunch without
  // opening its row to flip the per-row toggle. Off by default: arming is opt-in
  // (matches a fresh machine's `auto_connect`), and safe either way — the sweep
  // probes first, so an armed host that can't connect silently just stays dark.
  const [addAuto, setAddAuto] = useState(false);
  // "This is a cluster login node", ticked on the login form. Written to
  // `settings.hpc_hosts` the moment the machine exists (both add paths), so the
  // very first connect already has every background behaviour gated off.
  const [addHpc, setAddHpc] = useState(false);
  const [addError, setAddError] = useState("");
  const [addBusy, setAddBusy] = useState(false);
  // ── "Sign in in a terminal" (see `TerminalSignInToggle`) ─────────────────────
  // Same escape hatch as the connect dialogs', for the same reason: this form has
  // one password field, so a host that asks anything else — a challenge code, a
  // one-time code, an expired-password change — cannot be added from it at all.
  // Default **on** in non-headless mode, where a password field was never supposed
  // to be. Unlike the dialogs, the login goes to the **root terminal** rather than
  // an embedded one: this is a header menu, dismissed by a click anywhere else or
  // by Escape, which is no place to keep a live PTY — and it is exactly what the
  // VPN indicator beside it already does in that mode.
  const [addViaTerminal, setAddViaTerminal] = useState(!headless);
  // A login is open in the root terminal and we are waiting to be able to
  // authenticate the host (see `pollAddLogin` — this cannot observe the master
  // itself, and no longer claims to).
  const [addWaiting, setAddWaiting] = useState(false);
  const addPoll = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Live mirrors of the two fields the poll writes onto the machine (see
  // `finishTerminalAdd`), which outlives the render that scheduled it.
  const labelRef = useRef(label);
  const addAutoRef = useRef(addAuto);
  const addHpcRef = useRef(addHpc);
  useEffect(() => {
    labelRef.current = label;
    addAutoRef.current = addAuto;
    addHpcRef.current = addHpc;
  }, [label, addAuto, addHpc]);

  // Per-row inline edit of an existing machine's connection identity. `editId`
  // is the row being edited; the fields are prefilled from it in `startEdit`.
  // The password field is blank ("keep the saved credential") unless the user
  // wants to change it — see `submitEdit`.
  const [editId, setEditId] = useState<string | null>(null);
  const [editAddress, setEditAddress] = useState("");
  const [editUser, setEditUser] = useState("");
  const [editPassword, setEditPassword] = useState("");
  const [editLabel, setEditLabel] = useState("");
  const [editSave, setEditSave] = useState(false);
  const [editError, setEditError] = useState("");
  const [editBusy, setEditBusy] = useState(false);
  // ── "Sign in in a terminal" on the EDIT form ─────────────────────────────────
  // The add form's escape hatch, applied to an existing machine's re-authenticate:
  // one password field cannot answer a challenge/OTP/expired-password prompt, so a
  // host that starts asking for one can no longer be reconnected from the plain
  // form. Default **on** in non-headless mode, exactly as the add form's is. The
  // login rides the root terminal (this is a header menu, no place for a live PTY),
  // and on success the edited identity is persisted with `connect: false` — the
  // terminal already opened the session, so a second `ssh_connect` would be a
  // pointless (and possibly prompting) re-login.
  const [editViaTerminal, setEditViaTerminal] = useState(!headless);
  // A login is open in the root terminal for the edited target and we are polling
  // to adopt it (mirror of `addWaiting`; see `pollEditLogin`).
  const [editWaiting, setEditWaiting] = useState(false);
  const editPoll = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Live mirror of the label, which the poll writes onto the machine and which
  // outlives the render that scheduled it (the `labelRef` reason on the add path).
  const editLabelRef = useRef(editLabel);
  useEffect(() => {
    editLabelRef.current = editLabel;
  }, [editLabel]);

  // Import / export sub-flows. `ioMode` picks which panel replaces the normal
  // machine list + add-form; both are one-off modal flows within the menu.
  const [ioMode, setIoMode] = useState<"idle" | "export" | "import">("idle");
  // Export: which machines (by id) go into the file — all ticked by default.
  const [exportSel, setExportSel] = useState<Set<string>>(new Set());
  const [ioBusy, setIoBusy] = useState(false);
  const [ioError, setIoError] = useState("");
  // Import: the entries read from the picked file, plus the ONE shared
  // credential the whole batch connects with (a file carries no username/
  // password by design). `importResult` holds the per-host outcome once the run
  // finishes, so the panel switches from form to summary.
  const [importEntries, setImportEntries] = useState<MachineImportEntry[]>([]);
  const [importUser, setImportUser] = useState("");
  const [importPassword, setImportPassword] = useState("");
  const [importSave, setImportSave] = useState(false);
  // Arm every imported machine for the launch / VPN-up sweep. Default ON: an
  // imported fleet is one the user wants available, and arming can't misfire —
  // `autoConnect` probes before it connects, so a row that can't come up
  // silently stays dark rather than prompting. Untick to import them inert.
  const [importAuto, setImportAuto] = useState(true);
  const [importResult, setImportResult] = useState<ImportResult[] | null>(null);

  const closeIo = () => {
    keepOpenRef.current = false;
    setIoMode("idle");
    setIoBusy(false);
    setIoError("");
    setImportEntries([]);
    setImportUser("");
    setImportPassword("");
    setImportSave(false);
    setImportResult(null);
  };

  /** May Tabtivity touch this machine with nobody asking? The same authority the
   *  store's sweeps consult, so the row's stated reason for "not checked" and
   *  the sweep's decision to skip it can never disagree. */
  const autoTouchable = (m: GlobalMachine) => mayAutoTouch(settings, targetOfSpec(m));

  /** The reachability a row should believe: a hand Check wins while it is the
   *  newer of the two, otherwise the sweep's answer — and `undefined` (nobody
   *  asked) stays `undefined` rather than collapsing into "no". */
  const reachOf = (id: string): boolean | undefined => {
    const local = checked[id];
    if (local && local.at >= sweepAt) return local.ok;
    return reachable[id];
  };
  const stateOf = (m: GlobalMachine): RowState =>
    rowStateOf(status[m.id] ?? "off", reachOf(m.id));

  /** **Check** — one probe, because the user asked for one. `background: false`
   *  is what makes it legal on a machine tagged HPC, and that is the whole point:
   *  no sweep will ever touch such a row, so this button is its only reachability.
   *  The answer stays local (see `checked`) — the store's `reachable` is the
   *  sweep's map, and `status` means a session, which a probe is not. */
  const runCheck = async (m: GlobalMachine) => {
    setChecking((prev) => new Set(prev).add(m.id));
    const r = await invoke<{ ok: boolean; error: string }>("ssh_probe", {
      user: m.user,
      host: m.host,
      port: m.port,
      background: false,
    })
      .then((res) => ({ ok: res.ok, error: res.error || undefined }))
      // A guard refusal is not an error to print — it means the call was read as
      // background after all, and the row's honest answer is still "not checked".
      .catch((e) => ({ ok: false, error: hpcGuardRefusal(e) ? undefined : String(e) }));
    setChecked((prev) => ({ ...prev, [m.id]: { ...r, at: Date.now() } }));
    setChecking((prev) => {
      const next = new Set(prev);
      next.delete(m.id);
      return next;
    });
  };

  /** The **explicit** login for a tagged cluster. It exists only because the
   *  store's `connect` is a background-defaulted call: the backend refuses one
   *  against a tagged host, which is right for every sweep and wrong for the one
   *  button that IS the gesture. So this row's connect says so (`background:
   *  false`) and writes the same lamp the store would — `setStatus` is what
   *  `lib/remote/machineSync`'s subscription propagates, so a project holding this host
   *  still follows. Untagged machines keep the store's path untouched. */
  const explicitConnect = async (m: GlobalMachine) => {
    setLocalErrors((prev) => {
      const next = { ...prev };
      delete next[m.id];
      return next;
    });
    // The store owns the connect itself — including the host-key confirm, the
    // `remember: null` rule and the lamp writes `lib/remote/machineSync`'s subscription
    // propagates. It defaults to the *gesture* spelling, which is what makes this
    // path work on a tagged host at all; only the launch sweep says `background`.
    await connect(m.id);
    // A connect that authenticated is also the freshest possible reachability
    // answer, so it stands in for a probe — a row the user just logged into must
    // not still read "not checked".
    if (useGlobalMachinesStore.getState().status[m.id] === "connected") {
      setChecked((prev) => ({ ...prev, [m.id]: { ok: true, at: Date.now() } }));
    }
  };

  useEffect(() => {
    if (!enabled) return;
    void load();
  }, [load, enabled]);

  useEffect(() => {
    if (!open) {
      // A genuinely-closed menu (keepOpenRef already gates a mid-flow close)
      // drops any half-finished import/export so it can't reappear on reopen.
      closeIo();
      return;
    }
    setRemoveArm(null);
    setDisconnectArm(null);
    setDisconnectAllArm(false);
    setEditId(null);
    setAttachId(null);
    // Reachability first, then the busy sweep over whatever we hold a SESSION on
    // — a probe answer is not a session, and asking a host we never logged into
    // what it is running costs a second doomed login. On-open only: the busy
    // reading is never polled (see `stores/remote/hostBusy`).
    //
    // Both brakes are on before any of it. Nothing sweeps while a sweep is in
    // flight, and nothing sweeps at all unless some eligible machine's answer has
    // aged past `PROBE_MIN_INTERVAL_MS` — opening this menu three times in a
    // minute is one login per host, not three. The sweep itself stays a
    // *background* call (no `background: false` anywhere below): the backend
    // refuses it on a tagged host, which is the redundancy that survives a
    // frontend guard someone forgets.
    if (probeBrakes.inFlight) return;
    const eligible = machines.filter(autoTouchable);
    const now = Date.now();
    const due = eligible.filter(
      (m) => now - (probeBrakes.lastAt.get(m.id) ?? 0) >= PROBE_MIN_INTERVAL_MS,
    );
    if (due.length === 0) return;
    probeBrakes.inFlight = true;
    void probeAll()
      .then(() => {
        const at = Date.now();
        for (const m of eligible) probeBrakes.lastAt.set(m.id, at);
        setSweepAt(at);
        const gm = useGlobalMachinesStore.getState();
        const probeBusy = useHostBusyStore.getState().probeGlobal;
        for (const m of gm.machines) {
          if ((gm.status[m.id] ?? "off") === "connected") void probeBusy(m);
        }
      })
      // A rejected sweep must still release the in-flight brake, or the menu
      // would never probe again for the rest of the session.
      .catch(() => {})
      .finally(() => {
        probeBrakes.inFlight = false;
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, probeAll]);

  // Inline utilization bars: while the menu is open, read every connected
  // Detailed machine's CPU/GPU once now and every `UTIL_POLL_MS` after. A
  // *background* read (the backend refuses it on a tagged host), never stacked
  // (`recheck` skips a key already in flight), and it stops with the menu.
  useEffect(() => {
    if (!open) return;
    const sweep = () => {
      const gm = useGlobalMachinesStore.getState();
      const s = useSettingsStore.getState().settings;
      const recheck = useRemoteUsageStore.getState().recheck;
      for (const m of gm.machines) {
        if ((gm.status[m.id] ?? "off") !== "connected") continue;
        if (!showsUtilization(s, m) || !mayAutoTouch(s, targetOfSpec(m))) continue;
        void recheck(
          { kind: "machine", key: machineKey(m.id), label: m.label || m.host, user: m.user, host: m.host, port: m.port },
          { background: true },
        );
      }
    };
    sweep();
    const timer = window.setInterval(sweep, UTIL_POLL_MS);
    return () => window.clearInterval(timer);
  }, [open]);

  const orderKey = machines.map((m) => m.id).join("|");

  /** Commit a reorder: pull `id` out of the list and splice it back in at `to`
   *  (an index into the list WITHOUT it). The FLIP pass below animates the
   *  result, so both the drop and the keyboard nudge read as movement. */
  const commitMove = (id: string, to: number) => {
    const ids = machines.map((m) => m.id);
    const from = ids.indexOf(id);
    if (from < 0 || to < 0 || to > ids.length - 1) return;
    if (to === from) return;
    ids.splice(from, 1);
    ids.splice(to, 0, id);
    void reorder(ids);
  };

  // Keyboard equivalent of the drag, on the focused grip: a reorder must not be
  // pointer-only.
  const nudgeMachine = (id: string, delta: number) =>
    commitMove(id, machines.findIndex((m) => m.id === id) + delta);

  const startReorderDrag = (id: string, e: React.PointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragStartY.current = e.clientY;
    // Measure every row ONCE, up front: the DOM order is frozen for the duration
    // of the drag precisely so these stay true.
    dragRects.current = machines.map((mm) => {
      const rect = rowRefs.current.get(mm.id)?.getBoundingClientRect();
      return { id: mm.id, top: rect?.top ?? 0, height: rect?.height ?? 0 };
    });
    reorderDragRef.current = true;
    setReorderDrag({ id, dy: 0, to: dropSlot(id, e.clientY) });
  };

  const moveReorderDrag = (e: React.PointerEvent<HTMLElement>) => {
    if (!reorderDrag) return;
    const dy = e.clientY - dragStartY.current;
    const to = dropSlot(reorderDrag.id, e.clientY);
    if (dy !== reorderDrag.dy || to !== reorderDrag.to) setReorderDrag({ ...reorderDrag, dy, to });
  };

  const endReorderDrag = (e: React.PointerEvent<HTMLElement>, commit: boolean) => {
    if (!reorderDrag) return;
    const { id } = reorderDrag;
    reorderDragRef.current = false;
    setReorderDrag(null);
    if (commit) commitMove(id, dropSlot(id, e.clientY));
  };

  // FLIP: after the reordered rows paint, translate each card from where it was
  // to where it now is (0ms), then release the transform on the next frame so it
  // slides into place. WebKitGTK animates `transform` cheaply, and comparing
  // offsets tolerates the rows' variable height (an expanded row is taller).
  // Both axes, because the overlay's tiles wrap: a tile can move sideways.
  useLayoutEffect(() => {
    const next = new Map<string, { left: number; top: number }>();
    rowRefs.current.forEach((el, id) => {
      const { left, top } = el.getBoundingClientRect();
      next.set(id, { left, top });
      const prev = prevRects.current.get(id);
      if (prev !== undefined) {
        const dx = prev.left - left;
        const dy = prev.top - top;
        if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
          el.style.transition = "none";
          el.style.transform = `translate(${dx}px, ${dy}px)`;
          // Force a reflow so the pre-slide transform is committed before release.
          void el.offsetHeight;
          requestAnimationFrame(() => {
            el.style.transition = "transform 160ms ease";
            el.style.transform = "";
          });
        }
      }
    });
    prevRects.current = next;
  }, [orderKey]);

  // Escape and an outside click close a keyboard-opened menu immediately.
  // `keepOpenRef` still wins for native dialogs, and a reorder drag cannot
  // unmount rows underneath its pointer capture.
  // The dropdown's only: the overlay has its own Escape and backdrop
  // (`MachinesOverlayFrame`), and a press anywhere in it is not "outside".
  useEffect(() => {
    if (isOverlay || !menuOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      if (keepOpenRef.current || reorderDragRef.current) return;
      const el = anchorRef.current;
      if (el && e.target instanceof Node && el.contains(e.target)) return;
      closeMenu(MENU_ID);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || keepOpenRef.current) return;
      closeMenu(MENU_ID);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [isOverlay, menuOpen, closeMenu]);

  // Group the machines by COLOUR so each lamp is drawn once, with a count —
  // exactly like a project pill's `RemoteConnMenu` aggregates its hosts. No
  // machines at all still shows one grey "off" lamp so the indicator is never
  // blank.
  //
  // The grouping is by lamp bucket rather than by row state (`LAMP_BUCKETS`):
  // seven states would be seven dots in a header that has room for four, and
  // three of them are the same "no session here" grey anyway. The breakdown —
  // "3 up, 2 no answer, 1 not checked" — rides the tooltip, which costs no width.
  //
  // Busy is folded into the EXISTING green lamp — it never adds one. Splitting
  // "connected" into working/idle would grow the strip exactly when the fleet is
  // most active. So the one green lamp pulses when ANY connected machine is
  // working, and its tooltip carries the count and the names. The per-machine
  // answer belongs one level down, on the rows, where each lamp is its own host.
  const lampGroups = (() => {
    const byState = new Map<RowState, GlobalMachine[]>();
    for (const m of machines) {
      const st = stateOf(m);
      const list = byState.get(st);
      if (list) list.push(m);
      else byState.set(st, [m]);
    }
    const grouped = LAMP_BUCKETS.map((bucket) => {
      const parts = bucket.states
        .map((st) => ({ st, machines: byState.get(st) ?? [] }))
        .filter((p) => p.machines.length > 0);
      const all = parts.flatMap((p) => p.machines);
      // Only a machine we hold a session on can be "working": a reading taken
      // before it dropped says nothing about it now.
      const working =
        bucket.lamp === "connected"
          ? all.filter((m) => busyReading({ readings }, m) !== null)
          : [];
      return { lamp: bucket.lamp, parts, machines: all, working };
    }).filter((g) => g.machines.length > 0);
    return grouped.length > 0
      ? grouped
      : [
          {
            lamp: "off" as ConnState,
            parts: [] as { st: RowState; machines: GlobalMachine[] }[],
            machines: [] as GlobalMachine[],
            working: [] as GlobalMachine[],
          },
        ];
  })();

  // A machine in the error bucket is the fleet's only non-nominal reading worth
  // pulling out of a collapsed header. "Connecting" deliberately is not: the whole
  // fleet is amber for the first seconds after launch and after every reconnect,
  // which would make the bar reflow on its own every time Tabtivity starts.
  // The header's instance reports; the overlay's is a second reader of the
  // same fleet and must not clear the key when it unmounts.
  useHeaderStatusReport(
    isOverlay ? null : "machines",
    !enabled
      ? null
      : {
          tone: lampGroups.some((g) => g.lamp === "error")
            ? "alert"
            : lampGroups.some((g) => g.lamp === "connected")
              ? "ok"
              : "off",
          label: `${t("machines.label")}: ${lampGroups
            .map((g) => `${g.machines.length} ${g.lamp}`)
            .join(", ")}`,
        },
  );

  const startRetry = (id: string) => {
    const m = machines.find((mm) => mm.id === id);
    setRetryId(id);
    setRetryUser(m?.user ?? "");
    setRetryPassword("");
    setRetryError("");
  };
  const submitRetry = async (id: string) => {
    const m = machines.find((mm) => mm.id === id);
    const user = retryUser.trim() || undefined;
    setRetryError("");
    try {
      // A username edited here is a correction to the stored login, not a
      // one-shot override — route through `update` (which also reconnects) so
      // it sticks for next time; leave the plain `connect` path alone when it
      // is unchanged, to avoid an extra `global_machine_update` round trip on
      // the common case.
      if (m && user !== (m.user ?? undefined)) {
        await update(id, { user, host: m.host, port: m.port, label: m.label }, {
          password: retryPassword || undefined,
          connect: true,
        });
      } else {
        await connect(id, retryPassword || undefined);
      }
      setRetryId(null);
      setRetryPassword("");
    } catch (e) {
      setRetryError(String(e));
    }
  };

  const connectedCount = machines.filter((m) => (status[m.id] ?? "off") === "connected").length;
  const runRetryAll = async () => {
    setRetryAllBusy(true);
    try {
      await retryAll();
    } finally {
      setRetryAllBusy(false);
    }
  };

  // ── Terminal sign-in: log in in the root terminal, then adopt that session ───
  // Tabtivity sees no password here: the user logs in in the root terminal, and the
  // machine is then `register`ed — the store action that deliberately does *not*
  // re-authenticate, precisely because the caller already did.
  //
  // What the poll below can and cannot tell you. It was written as "the login's
  // ControlMaster is the only signal, so a credential-less `ssh_connect` can only
  // succeed by riding it" — which is false: `ssh_connect` falls back to key/agent
  // auth and to the saved keychain credential, so on a host with either it
  // succeeds on the FIRST poll, the terminal login unfinished and irrelevant. The
  // 3s×40 cadence that premise justified was therefore, on a host that never
  // answers, forty authentication attempts against an unattended machine. There
  // is no frontend command for `ssh -O check` against the shared `cm-%C` socket
  // (the backend has one internally — `services::ssh_exec` — but exposes none),
  // so the master cannot be observed directly from here. Until it can, this is
  // honestly a **readiness** poll — "can Tabtivity authenticate this host yet" —
  // backed off and capped hard (below) so a wrong answer is cheap. Adopting a
  // session Tabtivity could have opened by itself is harmless; the terminal path
  // still exists for the host where it is the only way in.
  const clearAddPoll = () => {
    if (addPoll.current) {
      clearTimeout(addPoll.current);
      addPoll.current = null;
    }
  };

  const finishTerminalAdd = async (target: {
    user: string | null;
    host: string;
    port: number | null;
  }) => {
    const machine = await register({
      user: target.user ?? undefined,
      host: target.host,
      port: target.port ?? undefined,
      // Through refs: the poll re-schedules itself through the closure of the
      // render that started it, so reading these directly would freeze them at the
      // click — and a label typed while the login is still open (which is exactly
      // when there is time to type one) would be dropped.
      label: labelRef.current.trim() || undefined,
    });
    if (!machine) {
      setAddError(t("machines.err.saveFailed"));
      return;
    }
    // Same order as the headless path: tag first, and never arm a silent
    // launch-time connect for a machine the user just called a cluster.
    if (addHpcRef.current) {
      await updateSettings(
        setHpcPatch(
          useSettingsStore.getState().settings,
          { user: machine.user, host: machine.host, port: machine.port },
          true,
        ),
      );
    }
    if (addAutoRef.current && !addHpcRef.current) await setAutoConnect(machine.id, true);
    setAddress("");
    setUsername("");
    setPassword("");
    setLabel("");
    setSavePassword(false);
    setAddAuto(false);
    setAddHpc(false);
    setAdding(false);
  };

  /** Eight attempts, backing off 3s → 30s (~2½ min in all) instead of forty at a
   *  flat 3s. Each one is a real authentication attempt against a host nobody is
   *  watching, and the thing being waited for is a human finishing a login — a
   *  question that gets no truer for being asked twenty times a minute. */
  const POLL_MAX_ATTEMPTS = 8;
  const pollDelayMs = (attempt: number) => Math.min(3000 * 2 ** attempt, 30_000);

  const pollAddLogin = (
    target: { user: string | null; host: string; port: number | null },
    attempt = 0,
  ) => {
    void invoke<void>("ssh_connect", {
      user: target.user,
      host: target.host,
      port: target.port,
      password: null,
      // Part of a gesture — the user has just been sent to a terminal to log in.
      // Without this a tagged cluster (the likeliest host to need a terminal
      // login in the first place, since it is the one that asks for a challenge
      // code) could not be added this way at all.
      background: false,
    })
      .then(async () => {
        clearAddPoll();
        setAddWaiting(false);
        await finishTerminalAdd(target).catch((e) => setAddError(String(e)));
      })
      .catch(() => {
        if (attempt + 1 >= POLL_MAX_ATTEMPTS) {
          clearAddPoll();
          setAddWaiting(false);
          setAddError(t("machines.err.noLoginYet"));
          return;
        }
        addPoll.current = setTimeout(() => pollAddLogin(target, attempt + 1), pollDelayMs(attempt));
      });
  };

  const startTerminalAdd = async () => {
    const parsed = parseSshAddress(address);
    if (!parsed) {
      setAddError(t("machines.err.address"));
      return;
    }
    const target = {
      user: parsed.user ?? (username.trim() || null),
      host: parsed.host,
      port: parsed.port ?? null,
    };
    setAddError("");
    try {
      const command = await invoke<string>("remote_login_command", {
        user: target.user,
        host: target.host,
        port: target.port,
      });
      const tabLabel = `ssh · ${target.user ? `${target.user}@` : ""}${target.host}`;
      openConnectionInRoot({
        label: tabLabel,
        command,
        dedupeKey: `ssh:${target.user ? `${target.user}@` : ""}${target.host}:${target.port ?? ""}`,
      });
      setAddWaiting(true);
      clearAddPoll();
      pollAddLogin(target);
    } catch (e) {
      setAddError(String(e));
    }
  };

  /** Re-arm the poll — for a login finished after the bound ran out. */
  const retryTerminalAdd = () => {
    const parsed = parseSshAddress(address);
    if (!parsed) return;
    setAddError("");
    setAddWaiting(true);
    clearAddPoll();
    pollAddLogin({
      user: parsed.user ?? (username.trim() || null),
      host: parsed.host,
      port: parsed.port ?? null,
    });
  };

  // The menu unmounts on close; a timer firing into it afterwards is nobody's.
  // The root-terminal tab is deliberately left alone — it is the user's login.
  useEffect(() => clearAddPoll, []);

  const submitAdd = async () => {
    const parsed = parseSshAddress(address);
    if (!parsed) {
      setAddError(t("machines.err.address"));
      return;
    }
    setAddBusy(true);
    setAddError("");
    try {
      const machine = await add({
        user: parsed.user ?? (username.trim() || undefined),
        host: parsed.host,
        port: parsed.port ?? undefined,
        label: label.trim() || undefined,
        password: password || undefined,
        remember: savePassword,
      });
      // The tag is written first: everything else keyed off it (the monitor's
      // reading, the census, auto-connect) should already see it by the time this
      // machine is anything but a row.
      if (addHpc) {
        await updateSettings(
          setHpcPatch(useSettingsStore.getState().settings, { user: machine.user, host: machine.host, port: machine.port }, true),
        );
      }
      // Arm the launch/VPN-up sweep in the same step if the user asked — the add
      // already connected it now; this only persists the future intent. Never for
      // a tagged cluster: silent connects are one of the things the tag is for.
      if (addAuto && !addHpc) await setAutoConnect(machine.id, true);
      setAddress("");
      setUsername("");
      setPassword("");
      setLabel("");
      setSavePassword(false);
      setAddAuto(false);
      setAddHpc(false);
      setAdding(false);
    } catch (e) {
      setAddError(String(e));
    } finally {
      setAddBusy(false);
    }
  };

  const startEdit = (m: (typeof machines)[number]) => {
    setEditId(m.id);
    setEditAddress(`${m.host}${m.port ? `:${m.port}` : ""}`);
    setEditUser(m.user ?? "");
    setEditPassword("");
    setEditLabel(m.label ?? "");
    setEditSave(false);
    setEditError("");
    // Same default as the add form's toggle, and drop any stale wait/poll from a
    // previous row's terminal login.
    setEditViaTerminal(!headless);
    setEditWaiting(false);
    clearEditPoll();
  };
  const submitEdit = async (id: string) => {
    const orig = machines.find((m) => m.id === id);
    const parsed = parseSshAddress(editAddress);
    if (!parsed) {
      setEditError(t("machines.err.address"));
      return;
    }
    const user = parsed.user ?? (editUser.trim() || undefined);
    const port = parsed.port ?? undefined;
    // Reconnect only when a connection-relevant field changed, or the user typed
    // a new password / asked to (re)save it — a label-only edit must not force an
    // SSH round trip (which could prompt or be slow).
    const targetChanged =
      user !== (orig?.user ?? undefined) ||
      parsed.host !== orig?.host ||
      port !== (orig?.port ?? undefined);
    const doConnect = targetChanged || !!editPassword || editSave;
    setEditBusy(true);
    setEditError("");
    try {
      await update(
        id,
        { user, host: parsed.host, port, label: editLabel.trim() || undefined },
        { password: editPassword || undefined, remember: editSave, connect: doConnect },
      );
      setEditId(null);
      setEditPassword("");
    } catch (e) {
      setEditError(String(e));
    } finally {
      setEditBusy(false);
    }
  };

  // ── Terminal sign-in on edit: log in in the root terminal, then adopt it ──────
  // The `pollAddLogin` twin, for an existing machine. It shares that path's honest
  // caveat: `ssh_connect` may succeed on the first poll via key/agent/saved
  // credentials without the terminal login mattering, so this is a *readiness*
  // poll — "can Tabtivity authenticate this (possibly re-addressed) target yet" —
  // backed off and capped so a wrong answer is cheap. Adopting a session Tabtivity
  // could have opened itself is harmless; the terminal path is there for the host
  // that only a terminal login can get through.
  const clearEditPoll = () => {
    if (editPoll.current) {
      clearTimeout(editPoll.current);
      editPoll.current = null;
    }
  };

  const finishTerminalEdit = async (
    id: string,
    target: { user: string | null; host: string; port: number | null },
  ) => {
    // Persist the edited identity WITHOUT reconnecting — the terminal login has
    // already opened the session, so `connect: false` avoids a second (possibly
    // prompting) `ssh_connect`. `remember` is left unset: a terminal login is one
    // Tabtivity never sees, so there is no new secret to save and nothing to clear.
    await update(
      id,
      {
        user: target.user ?? undefined,
        host: target.host,
        port: target.port ?? undefined,
        label: editLabelRef.current.trim() || undefined,
      },
      { connect: false },
    );
    // The session exists, so light the lamp — `setStatus` is the write
    // `lib/remote/machineSync`'s subscription propagates onto a project holding this host.
    setStatus(id, "connected");
    setEditId(null);
    setEditPassword("");
    setEditWaiting(false);
  };

  const pollEditLogin = (
    id: string,
    target: { user: string | null; host: string; port: number | null },
    attempt = 0,
  ) => {
    void invoke<void>("ssh_connect", {
      user: target.user,
      host: target.host,
      port: target.port,
      password: null,
      background: false,
    })
      .then(async () => {
        clearEditPoll();
        setEditWaiting(false);
        await finishTerminalEdit(id, target).catch((e) => setEditError(String(e)));
      })
      .catch(() => {
        if (attempt + 1 >= POLL_MAX_ATTEMPTS) {
          clearEditPoll();
          setEditWaiting(false);
          setEditError(t("machines.err.noLoginYetEdit"));
          return;
        }
        editPoll.current = setTimeout(() => pollEditLogin(id, target, attempt + 1), pollDelayMs(attempt));
      });
  };

  const startTerminalEdit = async (id: string) => {
    const parsed = parseSshAddress(editAddress);
    if (!parsed) {
      setEditError(t("machines.err.address"));
      return;
    }
    const target = {
      user: parsed.user ?? (editUser.trim() || null),
      host: parsed.host,
      port: parsed.port ?? null,
    };
    setEditError("");
    try {
      const command = await invoke<string>("remote_login_command", {
        user: target.user,
        host: target.host,
        port: target.port,
      });
      const tabLabel = `ssh · ${target.user ? `${target.user}@` : ""}${target.host}`;
      openConnectionInRoot({
        label: tabLabel,
        command,
        dedupeKey: `ssh:${target.user ? `${target.user}@` : ""}${target.host}:${target.port ?? ""}`,
      });
      setEditWaiting(true);
      clearEditPoll();
      pollEditLogin(id, target);
    } catch (e) {
      setEditError(String(e));
    }
  };

  /** Re-arm the poll — for a login finished after the bound ran out (add's twin). */
  const retryTerminalEdit = (id: string) => {
    const parsed = parseSshAddress(editAddress);
    if (!parsed) return;
    setEditError("");
    setEditWaiting(true);
    clearEditPoll();
    pollEditLogin(id, {
      user: parsed.user ?? (editUser.trim() || null),
      host: parsed.host,
      port: parsed.port ?? null,
    });
  };

  // The menu unmounts on close; a timer firing into it afterwards is nobody's.
  useEffect(() => clearEditPoll, []);

  const startExport = () => {
    setAdding(false);
    setIoError("");
    setExportSel(new Set(machines.map((m) => m.id))); // all ticked by default
    keepOpenRef.current = true;
    setIoMode("export");
  };
  const toggleExportSel = (id: string) => {
    setExportSel((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  // Select-all/none for the export list: one toggle instead of N unticks when
  // the user wants to share a single machine out of a large fleet. "All ticked"
  // is the checked state, so the first click always *clears* — which is the
  // direction that's tedious by hand, since opening the panel ticks everything.
  const allExportSelected = machines.length > 0 && exportSel.size === machines.length;
  const toggleExportSelAll = () => {
    setExportSel(allExportSelected ? new Set() : new Set(machines.map((m) => m.id)));
  };
  const doExport = async () => {
    const ids = machines.map((m) => m.id).filter((id) => exportSel.has(id));
    if (ids.length === 0) return;
    setIoBusy(true);
    setIoError("");
    try {
      // The dialog moves the pointer off the menu; `keepOpenRef` (already set)
      // keeps it from closing while the native picker is up.
      const path = await saveDialog({
        title: t("machines.exportDialogTitle"),
        defaultPath: `${BRAND.slug}-machines.json`,
        filters: [{ name: t("machines.jsonFilter"), extensions: ["json"] }],
      });
      if (!path) {
        setIoBusy(false);
        return; // cancelled — stay on the export panel
      }
      await exportMachines(ids, path);
      closeIo();
    } catch (e) {
      setIoError(String(e));
      setIoBusy(false);
    }
  };

  const startImport = async () => {
    setAdding(false);
    setIoError("");
    keepOpenRef.current = true;
    setIoMode("import");
    setIoBusy(true);
    try {
      const picked = await openDialog({
        title: t("machines.importDialogTitle"),
        multiple: false,
        directory: false,
        filters: [{ name: t("machines.jsonFilter"), extensions: ["json"] }],
      });
      const path = Array.isArray(picked) ? picked[0] : picked;
      if (!path) {
        closeIo(); // nothing picked — leave the menu as it was
        return;
      }
      const entries = await invoke<MachineImportEntry[]>("global_machines_import_read", {
        path,
      });
      setImportEntries(entries);
      setImportResult(null);
    } catch (e) {
      setIoError(String(e));
    } finally {
      setIoBusy(false);
    }
  };
  const doImport = async () => {
    if (importEntries.length === 0) return;
    setIoBusy(true);
    setIoError("");
    try {
      const result = await importMachines(importEntries, {
        user: importUser.trim() || undefined,
        password: importPassword || undefined,
        remember: importSave,
        autoConnect: importAuto,
      });
      setImportResult(result);
    } catch (e) {
      setIoError(String(e));
    } finally {
      setIoBusy(false);
    }
  };

  if (!enabled) return null;

  /** One line per state inside a colour's bucket, so the grey dot can say which
   *  kind of "no session here" its count is made of. */
  const lampLabel = (g: (typeof lampGroups)[number]) => {
    if (g.machines.length === 0) return t("machines.label");
    const lines = g.parts.map((p) =>
      t("machines.lampGroup", {
        count: p.machines.length,
        word: t(STATE_WORD[p.st]),
        names: p.machines.map((m) => m.label || m.host).join(", "),
      }),
    );
    if (g.working.length > 0)
      lines.push(
        t("machines.lampWorking", {
          count: g.working.length,
          names: g.working.map((m) => m.label || m.host).join(", "),
        }),
      );
    return lines.join("\n");
  };

  // The rows as they sit in each surface: straight in the dropdown's column,
  // one tile grid in the overlay (the Models overlay's `.models-home-grid`).
  const tileGrid = (rows: ReactNode) =>
    isOverlay ? <div className="models-home-grid machines-grid">{rows}</div> : rows;

  // The list itself, shared by both surfaces: the dropdown scrolls it under
  // its pinned title, the overlay lays it out as a page of tiles.
  const body = (
    <>
          {ioMode === "export" ? (
            <div className="vpn-indicator-row menu-form machines-io-panel">
              <div className="vpn-indicator-note">
                {t("machines.exportNote")}
                <UntestedTag id="machinesIndicator.1" />
              </div>
              {machines.length === 0 ? (
                <div className="vpn-indicator-empty">{t("machines.nothingToExport")}</div>
              ) : (
                <>
                <label
                  className="vpn-indicator-auto machines-io-pick machines-io-pick-all"
                  title={t(allExportSelected ? "machines.deselectAllTitle" : "machines.selectAllTitle")}
                >
                  <Toggle checked={allExportSelected} onChange={toggleExportSelAll} size="sm" />
                  <span>{t(allExportSelected ? "machines.deselectAll" : "machines.selectAll")}</span>
                </label>
                {machines.map((m) => (
                  <label
                    key={m.id}
                    className="vpn-indicator-auto machines-io-pick"
                    title={targetLabel(m)}
                  >
                    <Toggle
                      checked={exportSel.has(m.id)}
                      onChange={() => toggleExportSel(m.id)}
                      size="sm"
                    />
                    <span>
                      {m.label || m.host}
                      <span className="machines-io-addr">
                        {`${m.host}${m.port ? `:${m.port}` : ""}`}
                      </span>
                    </span>
                  </label>
                ))}
                </>
              )}
              {ioError && <ErrorNote className="vpn-indicator-error" error={ioError} />}
              <div className="vpn-indicator-actions">
                <button
                  type="button"
                  className="vpn-indicator-connect"
                  disabled={ioBusy || exportSel.size === 0}
                  onClick={() => void doExport()}
                >
                  {ioBusy ? t("machines.saving") : t("machines.exportN", { count: exportSel.size })}
                </button>
                <button type="button" className="vpn-indicator-remove" onClick={closeIo}>
                  {t("common.cancel")}
                </button>
              </div>
            </div>
          ) : ioMode === "import" ? (
            <div className="vpn-indicator-row menu-form machines-io-panel">
              {importResult ? (
                <>
                  <div className="vpn-indicator-note">
                    {t(
                      importResult.length === 1 ? "machines.importedOne" : "machines.importedMany",
                      { count: importResult.length },
                    )}{" "}
                    {t("machines.importedOutcome", {
                      ok: importResult.filter((r) => r.ok).length,
                      bad: importResult.filter((r) => !r.ok).length,
                    })}
                  </div>
                  <div className="machines-io-results">
                    {importResult.map((r, i) => (
                      <div key={`${r.host}-${i}`} className="machines-io-result-row">
                        <ConnLamp status={r.ok ? "connected" : "error"} label={r.host} />
                        <span>{r.label || r.host}</span>
                      </div>
                    ))}
                  </div>
                  <div className="vpn-indicator-actions">
                    <button type="button" className="vpn-indicator-connect" onClick={closeIo}>
                      {t("machines.done")}
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <div className="vpn-indicator-note">
                    {ioBusy && importEntries.length === 0
                      ? t("machines.readingFile")
                      : t(
                          importEntries.length === 1
                            ? "machines.importCountOne"
                            : "machines.importCountMany",
                          { count: importEntries.length },
                        )}
                    <UntestedTag id="machinesIndicator.2" />
                  </div>
                  {importEntries.length > 0 && (
                    <div className="machines-io-preview">
                      {importEntries.map((e, i) => (
                        <div key={`${e.host}-${i}`} className="machines-io-addr">
                          {`${e.user ? `${e.user}@` : ""}${e.host}${e.port ? `:${e.port}` : ""}`}
                          {e.label ? ` — ${e.label}` : ""}
                        </div>
                      ))}
                    </div>
                  )}
                  <label>
                    {t("machines.username")}
                    <input
                      placeholder={t("machines.importUserPlaceholder")}
                      value={importUser}
                      onChange={(e) => setImportUser(e.target.value)}
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </label>
                  <label>
                    {t("machines.password")}
                    <PasswordInput
                      placeholder={t("machines.importPasswordPlaceholder")}
                      value={importPassword}
                      autoComplete="off"
                      onChange={(e) => setImportPassword(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void doImport();
                      }}
                    />
                  </label>
                  <label className="vpn-indicator-auto">
                    <Toggle
                      checked={importSave}
                      onChange={(e) => setImportSave(e.target.checked)}
                      size="sm"
                    />
                    <span>
                      {t("machines.savePassword")}
                      <UntestedTag id="machinesIndicator.3" />
                    </span>
                  </label>
                  <label
                    className="vpn-indicator-auto"
                    title={t("machines.importAutoTitle")}
                  >
                    <Toggle
                      checked={importAuto}
                      onChange={(e) => setImportAuto(e.target.checked)}
                      size="sm"
                    />
                    <span>
                      {t("machines.autoConnectLabel")}
                      <UntestedTag id="machinesIndicator.4" />
                    </span>
                  </label>
                  {ioError && <ErrorNote className="vpn-indicator-error" error={ioError} />}
                  <div className="vpn-indicator-actions">
                    <button
                      type="button"
                      className="vpn-indicator-connect"
                      disabled={ioBusy || importEntries.length === 0}
                      onClick={() => void doImport()}
                    >
                      {ioBusy ? t("machines.connecting") : t("machines.connectAndImport")}
                    </button>
                    <button type="button" className="vpn-indicator-remove" onClick={closeIo}>
                      {t("common.cancel")}
                    </button>
                  </div>
                </>
              )}
            </div>
          ) : (
            <>
          {/* The drag this used to describe does not exist: attaching is the
              row's ⇥ picker (see the component doc), and the only drag left is a
              row's grip, which reorders. */}
          <div className="vpn-indicator-note">
            <strong>{t("machines.note.strong")}</strong> {t("machines.note.rest")}
            <UntestedTag id="machinesIndicator.5" />
          </div>

          {machines.length > 0 && disconnectAllArm ? (
            <div className="vpn-indicator-row machines-fleet-actions">
              <div className="vpn-indicator-hint">
                {t("machines.disconnectAllHint.pre")} <strong>{t("machines.tmuxJobs")}</strong>{" "}
                {t("machines.disconnectAllHint.post")}
                <UntestedTag id="machinesIndicator.6" />
              </div>
              <div className="vpn-indicator-actions">
                <button
                  type="button"
                  className="vpn-indicator-remove"
                  onClick={() => {
                    setDisconnectAllArm(false);
                    void disconnectAll();
                  }}
                >
                  {t("machines.disconnectAllConfirm")}
                </button>
                <button
                  type="button"
                  className="vpn-indicator-connect"
                  onClick={() => setDisconnectAllArm(false)}
                >
                  {t("machines.keep")}
                </button>
              </div>
            </div>
          ) : (
            /* One icon bar for every fleet-wide action, in the same glyph
               vocabulary a machine row uses for the same verbs (↻ retry, ⏻
               disconnect) — so "all machines" reads as the row action applied
               to the list, not as a different feature with its own wording.
               The usage report joins it (▥, the system-monitor glyph): it used
               to open itself after every remote connect, putting a modal in
               front of someone who had asked for something else. It is on
               demand now, and this is the only thing that opens it. Its subject
               is THIS list — a section per machine, in this menu's order — plus
               the active project's own hosts that aren't in it
               (`RemoteUsageWarningDialog`); each is read afresh as the dialog
               appears. */
            <div className="vpn-indicator-row vpn-indicator-actions machines-fleet-actions machines-fleet-icons">
              {machines.length > 0 && (
                <button
                  type="button"
                  className="machines-row-action is-accent"
                  disabled={retryAllBusy}
                  aria-label={t("machines.retryAllAria")}
                  title={t("machines.retryAllTitle")}
                  onClick={() => void runRetryAll()}
                >
                  {retryAllBusy ? "⋯" : "↻"}
                </button>
              )}
              {machines.length > 0 && connectedCount > 0 && (
                <button
                  type="button"
                  className="machines-row-action is-danger"
                  aria-label={t("machines.disconnectAllAria")}
                  title={t("machines.disconnectAllTitle")}
                  onClick={() => setDisconnectAllArm(true)}
                >
                  ⏻
                </button>
              )}
              <button
                type="button"
                className="machines-row-action"
                aria-label={t("machines.usageAria")}
                title={t("machines.usageTitle")}
                onClick={() => {
                  dismiss();
                  openUsage();
                }}
              >
                ▥
              </button>
              <UntestedTag id="machinesIndicator.7" />
            </div>
          )}

          {machines.length === 0 && (
            <div className="vpn-indicator-row">
              <div className="vpn-indicator-empty">{t("machines.empty")}</div>
            </div>
          )}
          {/* While a row is dragged, the others PART to open its landing slot: a
              row the dragged one has passed slides back by exactly the dragged
              row's height (removing it from above lifts them; inserting it above
              drops them — the same distance either way, whatever their own
              heights). It is a `transform`, so no layout moves and the rects
              measured at pointerdown stay valid. */}
          {tileGrid(machines.map((m, idx) => {
            const st = status[m.id] ?? "off";
            const hpc = isHpcHost(settings, targetOfSpec(m));
            // The row's actual state, from BOTH maps — see `RowState`. This is
            // the only place a stale green (a session we opened, on a host that
            // no longer answers) can be caught: nothing downgrades `status` any
            // more, because nothing but an explicit action writes it.
            const state = stateOf(m);
            const badge = STATE_BADGE[state];
            // "Not checked" has two different reasons and the row must say which:
            // a tagged cluster is never in any sweep, so its answer will stay
            // unknown until the Check button is pressed.
            const stateTip =
              state === "unknown" && hpc ? t("machines.tip.unknownHpc") : t(STATE_TIP[state]);
            // Only a machine we hold a LIVE session on pulses: a reading taken
            // before it dropped says nothing about it now — and a stale row is by
            // definition one whose session may already be gone.
            const busy = state === "connected" ? busyReading({ readings }, m) : null;
            const usageReport =
              state === "connected" && showsUtilization(settings, m) ? usageReports[machineKey(m.id)] : undefined;
            const util = usageReport ? utilizationOf(usageReport) : null;
            const name = m.label || m.host;
            // `ConnLamp`'s own tooltip is "<label>: <colour>", and most states
            // share their colour with another (red covers error and stale, grey
            // covers all three sessionless ones) — for those the label carries
            // the word the colour cannot.
            const lampText = LAMP_SAYS_IT.has(state) ? name : `${name} — ${t(STATE_WORD[state])}`;
            // Both error channels on one line, freshest first: this component's
            // (the explicit HPC login), then a Check newer than the last sweep,
            // then the store's — a failed connect, a failed probe, and now also
            // `setAutoConnect`'s "auto-connect not saved: …".
            const check = checked[m.id];
            const rowError =
              localErrors[m.id] ??
              (check && check.at >= sweepAt ? check.error : undefined) ??
              errors[m.id];
            const dragH = reorderDrag
              ? (dragRects.current.find((r) => r.id === reorderDrag.id)?.height ?? 0)
              : 0;
            const dragFrom = reorderDrag ? machines.findIndex((mm) => mm.id === reorderDrag.id) : -1;
            const shift =
              !reorderDrag || idx === dragFrom
                ? 0
                : idx > dragFrom && idx <= reorderDrag.to
                  ? -dragH
                  : idx < dragFrom && idx >= reorderDrag.to
                    ? dragH
                    : 0;
            // A row shows its icon actions only while nothing has taken the row
            // over: an armed confirm (remove/disconnect), the retry password
            // field, or the edit form each replace them with worded buttons.
            const rowFormOpen =
              retryId === m.id ||
              removeArm === m.id ||
              disconnectArm === m.id ||
              editId === m.id ||
              attachId === m.id;
            // The icon actions: on the head line's second row in the dropdown,
            // at the tile's foot in the overlay (after its details).
            const rowActions = !rowFormOpen && (
              <div className="machines-row-actions">
                {/* The connect, and — for a tagged cluster — the ONLY way it
                    ever gets connected or probed from here at all. Every
                    sweep skips it by design, so its row has to carry the
                    gestures the fleet actions no longer make on its behalf:
                    this button and the Check beside it. */}
                <button
                  type="button"
                  className="machines-row-action is-accent"
                  aria-label={t(
                    state === "error"
                      ? "machines.retryAria"
                      : hpc
                        ? "machines.hpcLoginAria"
                        : st === "connected"
                          ? "machines.reconnectAria"
                          : "machines.connectAria",
                  )}
                  title={t(
                    state === "error"
                      ? "machines.retryTitle"
                      : hpc
                        ? "machines.hpcLoginTitle"
                        : state === "stale"
                          ? "machines.reconnectStaleTitle"
                          : st === "connected"
                            ? "machines.reconnectTitle"
                            : "machines.connectTitle",
                  )}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (state === "error") startRetry(m.id);
                    // A tagged machine goes through this component's own
                    // connect, which marks itself a gesture (`background:
                    // false`) — the store's is a background-defaulted call
                    // the backend is right to refuse on a login node.
                    else if (hpc) void explicitConnect(m);
                    else void connect(m.id);
                  }}
                  disabled={st === "connecting"}
                >
                  {st === "connected" || state === "error" ? "↻" : "▷"}
                </button>
                {/* Ask this one host whether it answers, because the user
                    asked. It is the only reachability a tagged machine has
                    (no sweep will ever probe one), and on any other machine
                    it re-asks a question the 60s sweep interval is holding. */}
                <button
                  type="button"
                  className="machines-row-action"
                  aria-label={t("machines.checkAria")}
                  title={t(hpc ? "machines.checkTitleHpc" : "machines.checkTitle")}
                  disabled={checking.has(m.id)}
                  onClick={(e) => {
                    e.stopPropagation();
                    void runCheck(m);
                  }}
                >
                  {checking.has(m.id) ? "⋯" : "◎"}
                </button>
                {st === "connected" && (
                  <button
                    type="button"
                    className="machines-row-action is-danger"
                    aria-label={t("machines.disconnectAria")}
                    title={t("machines.disconnectTitle")}
                    onClick={(e) => {
                      e.stopPropagation();
                      setDisconnectArm(m.id);
                    }}
                  >
                    ⏻
                  </button>
                )}
                <button
                  type="button"
                  className="machines-row-action"
                  aria-label={t("machines.attachAria")}
                  title={t("machines.attachTitle")}
                  onClick={(e) => {
                    e.stopPropagation();
                    setAttachId(m.id);
                  }}
                >
                  ⇥
                </button>
                <button
                  type="button"
                  className="machines-row-action"
                  aria-label={t("machines.editAria")}
                  title={t("machines.editTitle")}
                  onClick={(e) => {
                    e.stopPropagation();
                    startEdit(m);
                  }}
                >
                  ✎
                </button>
                <button
                  type="button"
                  className="machines-row-action is-danger"
                  aria-label={t("machines.removeAria")}
                  title={t("machines.removeTitle")}
                  onClick={(e) => {
                    e.stopPropagation();
                    setRemoveArm(m.id);
                  }}
                >
                  ✕
                </button>
              </div>
            );
            return (
              <div
                key={m.id}
                ref={(el) => {
                  if (el) rowRefs.current.set(m.id, el);
                  else rowRefs.current.delete(m.id);
                }}
                className={`vpn-indicator-row machines-indicator-row${isOverlay ? " models-tile machines-tile" : ""}${
                  reorderDrag?.id === m.id ? " reorder-dragging" : reorderDrag ? " reorder-parting" : ""
                }`}
                style={
                  reorderDrag?.id === m.id
                    ? { transform: `translateY(${reorderDrag.dy}px)` }
                    : shift
                      ? { transform: `translateY(${shift}px)` }
                      : undefined
                }
              >
                <div className="vpn-indicator-head">
                  {/* No grip on a tile: reordering is the dropdown's, whose
                      single column is what the drag's slot maths measures. */}
                  {!isOverlay && (
                    <button
                      type="button"
                      className="machines-row-grip"
                      aria-label={t("machines.gripAria")}
                      title={t("machines.gripTitle")}
                      onPointerDown={(e) => startReorderDrag(m.id, e)}
                      onPointerMove={moveReorderDrag}
                      onPointerUp={(e) => endReorderDrag(e, true)}
                      onPointerCancel={(e) => endReorderDrag(e, false)}
                      onKeyDown={(e) => {
                        if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
                        e.preventDefault();
                        nudgeMachine(m.id, e.key === "ArrowUp" ? -1 : 1);
                      }}
                    >
                      ⠿
                    </button>
                  )}
                  {/* The Models overlay tile's icon box. */}
                  {isOverlay && (
                    <span className="models-tile-icon machines-tile-icon" aria-hidden="true">
                      <MachinesGlyph className="machines-tile-glyph" />
                    </span>
                  )}
                  <ConnLamp
                    status={STATE_LAMP[state]}
                    busy={busy !== null}
                    label={busy ? `${lampText} — ${busyLabel(busy)}` : lampText}
                  />
                  <span className="vpn-indicator-config" title={`${targetLabel(m)}\n${stateTip}`}>
                    {name}
                  </span>
                  {/* The HPC tag, on the row itself — the whole point of a tag
                      that switches off background work is being able to see, at a
                      glance over the machine list, which machines it is off for. */}
                  {hpc && (
                    <span className="hpc-badge" title={t("machines.hpcBadgeTitle")}>
                      HPC
                    </span>
                  )}
                  {/* The word the grey dot can't say. Only for the states a lamp
                      colour leaves ambiguous, so a connected row stays clean and
                      a long list stays scannable. Wearing `.hpc-badge`'s pill
                      shape deliberately: this change owns no CSS, and the extra
                      `machines-state-badge is-<state>` classes are the seam a
                      per-state tint can be hung on later. */}
                  {badge && (
                    <span
                      className={`hpc-badge machines-state-badge is-${state}`}
                      title={stateTip}
                    >
                      {t(badge)}
                    </span>
                  )}
                  {!isOverlay && (
                    <button
                      type="button"
                      className="machines-row-expand-btn"
                      aria-label={t(expandedIds.has(m.id) ? "machines.hideDetailsAria" : "machines.showDetailsAria")}
                      aria-expanded={expandedIds.has(m.id)}
                      title={t(expandedIds.has(m.id) ? "machines.hideDetailsTitle" : "machines.showDetailsTitle")}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleExpanded(m.id);
                      }}
                    >
                      {expandedIds.has(m.id) ? "▾" : "▸"}
                    </button>
                  )}
                  {!isOverlay && rowActions}
                </div>
                {/* A tile's second line, the Models overlay's `.models-tile-desc`:
                    where the machine is and what its lamp means, in words — the
                    dropdown keeps both in the name's tooltip. */}
                {isOverlay && (
                  <div className="models-tile-desc machines-tile-desc">
                    <span className="models-tile-intro machines-tile-target">{targetLabel(m)}</span>
                    <span className="models-tile-stat machines-tile-stat">
                      {stateTip}
                      {busy && <span className="machines-tile-busy">{busyLabel(busy)}</span>}
                    </span>
                  </div>
                )}
                {/* Why the row says what it says — shown as soon as anything
                    fails, not only once the user opens Retry. This is what tells
                    apart a stale saved password from an unknown host key from the
                    host simply being off the network, none of which a colour says
                    on its own (see `stores/remote/globalMachines`' `errors`). No longer
                    gated on `error`: the same map now also carries a failed
                    *probe*'s reason (an unreachable row that can explain itself)
                    and `setAutoConnect`'s "auto-connect not saved: …", which used
                    to be nothing but a toggle springing silently back. Also still
                    the only place an auto-connect failure at launch explains
                    itself — `autoConnect` never opens a modal. */}
                {/* CPU and GPU utilization, right on the row — only for a
                    machine read in Detailed mode (see `showsUtilization`). */}
                {util && !rowFormOpen && (
                  <div className="machines-util" aria-label={t("machines.utilAria", { machine: name })}>
                    <UtilBar
                      label={t("machines.utilCpu")}
                      pct={util.cpu}
                      title={t("machines.utilCpuTitle", { pct: String(Math.round(util.cpu)) })}
                    />
                    {util.gpu !== null && (
                      <UtilBar
                        label={t("machines.utilGpu")}
                        pct={util.gpu}
                        title={t("machines.utilGpuTitle", { pct: String(Math.round(util.gpu)) })}
                      />
                    )}
                    <UntestedTag id="machines.utilAria" />
                  </div>
                )}
                {rowError && !rowFormOpen && (
                  <div className="vpn-indicator-error machines-row-error">{rowError}</div>
                )}
                {(isOverlay || expandedIds.has(m.id)) && (
                  <>
                    {!isOverlay && <div className="vpn-indicator-holders">{targetLabel(m)}</div>}
                    <button
                      type="button"
                      className="vpn-indicator-connect machines-monitor-btn"
                      title={t("machines.systemMonitorTitle")}
                      onClick={(e) => {
                        e.stopPropagation();
                        openMonitor({ id: m.id, user: m.user, host: m.host, port: m.port, label: m.label });
                      }}
                    >
                      {t("machines.systemMonitor")}
                    </button>
                    <label className="vpn-indicator-auto" title={t("machines.autoConnectTitle")}>
                      <Toggle
                        // The EFFECTIVE value, not the stored flag. A tagged
                        // machine is never in the launch/VPN-up sweep whatever
                        // `auto_connect` says (`stores/remote/globalMachines`'
                        // `autoConnect` filters it out), so rendering a stored
                        // `true` showed it armed-and-frozen: a promise the app
                        // does not keep, on a control disabled from clearing it.
                        checked={m.auto_connect === true && !hpc}
                        onChange={(e) => void setAutoConnect(m.id, e.target.checked)}
                        size="sm"
                        disabled={hpc}
                      />
                      <span>
                        {t("machines.autoConnectLabel")}
                        {hpc && (
                          <span className="machines-auto-blocked">
                            {" "}
                            {t("machines.autoBlockedHpc")}
                          </span>
                        )}
                        <UntestedTag id="machinesIndicator.8" />
                      </span>
                    </label>
                    {/* Where the tag is set for a machine already in the list. The
                        login form has the same tick, so a cluster can be tagged as
                        it is added; this is for one that is already here — and it
                        is per machine, because that is the only scope at which the
                        question ("is this a shared cluster?") has an answer. */}
                    <label className="vpn-indicator-auto" title={t("machines.hpcToggleTitle")}>
                      <Toggle
                        checked={hpc}
                        onChange={(e) => {
                          const target = targetOfSpec(m);
                          if (!target) return;
                          const tagged = e.target.checked;
                          void (async () => {
                            await updateSettings(setHpcPatch(settings, target, tagged));
                            // Tagging DISARMS the machine on disk, so the stored
                            // state matches what the (now disabled) toggle above
                            // claims. Otherwise a `true` survives out of reach of
                            // every UI, for the sweep to keep filtering out — and
                            // untagging the machine later would silently re-arm a
                            // launch-time connect nobody asked for twice.
                            if (tagged && m.auto_connect) await setAutoConnect(m.id, false);
                          })();
                        }}
                        size="sm"
                      />
                      <span>
                        {t("machines.hpcToggleLabel")}
                        <UntestedTag id="machinesIndicator.9" />
                      </span>
                    </label>
                  </>
                )}
                {isOverlay && rowActions}
                {attachId === m.id ? (
                  <div className="vpn-indicator-row menu-form machines-attach-form">
                    <div className="vpn-indicator-hint">
                      {t("machines.attachQuestionPre")} <strong>{name}</strong>{" "}
                      {t("machines.attachQuestionPost")}
                      <UntestedTag id="machinesIndicator.10" />
                    </div>
                    {projects.length === 0 && (
                      <div className="vpn-indicator-empty">{t("machines.noActiveProject")}</div>
                    )}
                    {projects.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        className="vpn-indicator-connect machines-attach-project"
                        title={t(
                          p.remote ? "machines.attachRemoteTitle" : "machines.attachLocalTitle",
                        )}
                        onClick={() => {
                          setAttachId(null);
                          dismiss();
                          attachToProject(p, m);
                        }}
                      >
                        {p.name}
                        <span className="machines-attach-kind">
                          {t(p.remote ? "machines.attachKindCompute" : "machines.attachKindExtend")}
                        </span>
                      </button>
                    ))}
                    <button type="button" className="vpn-indicator-remove" onClick={() => setAttachId(null)}>
                      {t("common.cancel")}
                    </button>
                  </div>
                ) : retryId === m.id ? (
                  <div className="vpn-indicator-row menu-form machines-retry-form">
                    {errors[m.id] && <div className="vpn-indicator-error">{errors[m.id]}</div>}
                    <input
                      placeholder={t("machines.sshUsernamePlaceholder")}
                      value={retryUser}
                      onChange={(e) => setRetryUser(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void submitRetry(m.id);
                      }}
                      autoComplete="off"
                      spellCheck={false}
                    />
                    <PasswordInput
                      placeholder={t("machines.sshPasswordPlaceholder")}
                      value={retryPassword}
                      autoComplete="off"
                      onChange={(e) => setRetryPassword(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void submitRetry(m.id);
                      }}
                    />
                    {retryError && <ErrorNote className="vpn-indicator-error" error={retryError} />}
                    <div className="vpn-indicator-actions">
                      <button type="button" className="vpn-indicator-connect" onClick={() => void submitRetry(m.id)}>
                        {t("machines.retry")}
                      </button>
                      <button type="button" className="vpn-indicator-remove" onClick={() => setRetryId(null)}>
                        {t("common.cancel")}
                      </button>
                    </div>
                  </div>
                ) : removeArm === m.id ? (
                  <div className="vpn-indicator-actions">
                    <div className="vpn-indicator-hint">
                      {st === "connected" || st === "connecting" ? (
                        <>
                          {t("machines.removeHintLive.pre")}{" "}
                          <strong>{t("machines.tmuxJobs")}</strong>{" "}
                          {t("machines.removeHintLive.post")}
                          <UntestedTag id="machinesIndicator.11" />
                        </>
                      ) : (
                        t("machines.removeHintIdle")
                      )}
                    </div>
                    <button type="button" className="vpn-indicator-remove" onClick={() => void remove(m.id)}>
                      {t("common.remove")}
                    </button>
                    <button type="button" className="vpn-indicator-connect" onClick={() => setRemoveArm(null)}>
                      {t("machines.keep")}
                    </button>
                  </div>
                ) : disconnectArm === m.id ? (
                  <div className="vpn-indicator-actions">
                    <div className="vpn-indicator-hint">
                      {t("machines.disconnectHint.pre")} <strong>{t("machines.tmuxJobs")}</strong>{" "}
                      {t("machines.disconnectHint.post")}
                      <UntestedTag id="machinesIndicator.12" />
                    </div>
                    <button
                      type="button"
                      className="vpn-indicator-remove"
                      onClick={() => {
                        setDisconnectArm(null);
                        void disconnect(m.id);
                      }}
                    >
                      {t("machines.disconnectConfirm")}
                    </button>
                    <button type="button" className="vpn-indicator-connect" onClick={() => setDisconnectArm(null)}>
                      {t("machines.keep")}
                    </button>
                  </div>
                ) : editId === m.id ? (
                  <div className="vpn-indicator-row menu-form machines-edit-form">
                    <label>
                      {t("machines.sshAddress")}
                      <input
                        placeholder={t("machines.addressPlaceholder")}
                        value={editAddress}
                        onChange={(e) => setEditAddress(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") void submitEdit(m.id);
                        }}
                        spellCheck={false}
                        autoFocus
                      />
                    </label>
                    <label>
                      {t("machines.username")}
                      <input
                        placeholder={t("machines.usernamePlaceholder")}
                        value={editUser}
                        onChange={(e) => setEditUser(e.target.value)}
                        autoComplete="off"
                        spellCheck={false}
                      />
                    </label>
                    {!editViaTerminal && (
                      <label>
                        {t("machines.password")}
                        <PasswordInput
                          placeholder={t("machines.editPasswordPlaceholder")}
                          value={editPassword}
                          autoComplete="off"
                          onChange={(e) => setEditPassword(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") void submitEdit(m.id);
                          }}
                        />
                      </label>
                    )}
                    {/* Disabled rather than hidden in the terminal path, the add
                        form's rule: a terminal login is one Tabtivity never sees, so it
                        stores nothing new and clears nothing — a saved password for
                        this host stays as it is, and a vanishing row would read as
                        one that was dropped. */}
                    <label
                      className="vpn-indicator-auto"
                      title={t(
                        editViaTerminal
                          ? "machines.savePasswordTerminalTitle"
                          : "machines.savePasswordTitle",
                      )}
                    >
                      <Toggle
                        checked={editSave}
                        disabled={editViaTerminal}
                        onChange={(e) => setEditSave(e.target.checked)}
                        size="sm"
                      />
                      <span>
                        {t("machines.savePassword")}
                        <UntestedTag id="machinesIndicator.13" />
                      </span>
                    </label>
                    <label>
                      {t("machines.labelOptional")}
                      <input
                        placeholder={t("machines.labelPlaceholder")}
                        value={editLabel}
                        onChange={(e) => setEditLabel(e.target.value)}
                        spellCheck={false}
                      />
                    </label>
                    <TerminalSignInToggle
                      channel="ssh"
                      checked={editViaTerminal}
                      busy={editWaiting}
                      onChange={setEditViaTerminal}
                    />
                    {/* The login is a root-terminal tab, not something in this menu —
                        which closes the moment the pointer leaves it — so say where
                        it went. */}
                    {editViaTerminal && editWaiting && (
                      <div className="settings-help" role="status">
                        {t("machines.terminalLoginHint.pre")}{" "}
                        <strong>{t("machines.rootTerminal")}</strong>{" "}
                        {t("machines.terminalEditHint.post")}
                      </div>
                    )}
                    {editError && <ErrorNote className="vpn-indicator-error" error={editError} />}
                    <div className="vpn-indicator-actions">
                      {editViaTerminal ? (
                        <button
                          type="button"
                          className="vpn-indicator-connect"
                          disabled={editWaiting}
                          title={t("machines.loginInTerminalTitle")}
                          onClick={() => void startTerminalEdit(m.id)}
                        >
                          {editWaiting ? t("machines.waitingForLogin") : t("machines.loginInTerminal")}
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="vpn-indicator-connect"
                          disabled={editBusy}
                          onClick={() => void submitEdit(m.id)}
                        >
                          {editBusy ? t("machines.saving") : t("machines.saveChanges")}
                        </button>
                      )}
                      {/* Only after the poll has given up: a login finished late is
                          still a login, and re-arming beats retyping the form. */}
                      {editViaTerminal && !editWaiting && editError && (
                        <button
                          type="button"
                          className="vpn-indicator-connect"
                          onClick={() => retryTerminalEdit(m.id)}
                        >
                          {t("machines.loggedInEdit")}
                        </button>
                      )}
                      <button
                        type="button"
                        className="vpn-indicator-remove"
                        onClick={() => {
                          clearEditPoll();
                          setEditWaiting(false);
                          setEditId(null);
                        }}
                      >
                        {t("common.cancel")}
                      </button>
                    </div>
                  </div>
                ) : null}
              </div>
            );
          }))}

          <div className="tab-new-menu-group-label">{t("machines.addGroupLabel")}</div>
          {adding ? (
            <div className="vpn-indicator-row menu-form">
              <label>
                {t("machines.sshAddress")}
                <input
                  placeholder={t("machines.addressPlaceholder")}
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void submitAdd();
                  }}
                  spellCheck={false}
                  autoFocus
                />
              </label>
              <label>
                {t("machines.username")}
                <input
                  placeholder={t("machines.usernamePlaceholder")}
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>
              {!addViaTerminal && (
                <label>
                  {t("machines.password")}
                  <PasswordInput
                    placeholder={t("machines.addPasswordPlaceholder")}
                    value={password}
                    autoComplete="off"
                    onChange={(e) => setPassword(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void submitAdd();
                    }}
                  />
                </label>
              )}
              {/* Kept on screen in the terminal path, and *disabled* rather than
                  hidden: a saved password belongs to the host, and a row that
                  vanishes reads as one that was discarded. It has nothing to act on
                  there — the flag only reaches the keychain through `ssh_connect`'s
                  `remember`, which a terminal login never calls — so an existing
                  credential is left exactly as it was found. */}
              <label
                className="vpn-indicator-auto"
                title={t(
                  addViaTerminal
                    ? "machines.savePasswordTerminalTitle"
                    : "machines.savePasswordTitle",
                )}
              >
                <Toggle
                  checked={savePassword}
                  disabled={addViaTerminal}
                  onChange={(e) => setSavePassword(e.target.checked)}
                  size="sm"
                />
                <span>
                  {t("machines.savePassword")}
                  <UntestedTag id="machinesIndicator.14" />
                </span>
              </label>
              <label
                className="vpn-indicator-auto"
                title={t("machines.autoConnectAddTitle")}
              >
                <Toggle
                  checked={addAuto && !addHpc}
                  disabled={addHpc}
                  onChange={(e) => setAddAuto(e.target.checked)}
                  size="sm"
                />
                <span>
                  {t("machines.autoConnectLabel")}
                  {addHpc && (
                    <span className="machines-auto-blocked"> {t("machines.autoBlockedHpcAdd")}</span>
                  )}
                  <UntestedTag id="machinesIndicator.15" />
                </span>
              </label>
              {/* The tag, at the moment it is actually known: logging in is when
                  the user knows what they are logging in to. Everything Tabtivity
                  would otherwise do to this machine on its own is gated behind it
                  (`lib/remote/hpc/hpcHost.ts`), so ticking it here means the very first
                  connect already behaves — nothing scans, nothing polls, and the
                  monitor reads it lightly from its first sample. */}
              <label
                className="vpn-indicator-auto"
                title={t("machines.hpcAddTitle")}
              >
                <Toggle checked={addHpc} onChange={(e) => setAddHpc(e.target.checked)} size="sm" />
                <span>
                  {t("machines.hpcToggleLabel")}
                  <UntestedTag id="machinesIndicator.16" />
                </span>
              </label>
              <label>
                {t("machines.labelOptional")}
                <input
                  placeholder={t("machines.labelPlaceholder")}
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  spellCheck={false}
                />
              </label>
              <TerminalSignInToggle
                channel="ssh"
                checked={addViaTerminal}
                busy={addWaiting}
                onChange={setAddViaTerminal}
              />
              {/* The login is a root-terminal tab, not something in this menu — which
                  closes the moment the pointer leaves it — so say where it went. */}
              {addViaTerminal && addWaiting && (
                <div className="settings-help" role="status">
                  {t("machines.terminalLoginHint.pre")}{" "}
                  <strong>{t("machines.rootTerminal")}</strong>{" "}
                  {t("machines.terminalLoginHint.post")}
                </div>
              )}
              {addError && <ErrorNote className="vpn-indicator-error" error={addError} />}
              <div className="vpn-indicator-actions">
                {addViaTerminal ? (
                  <button
                    type="button"
                    className="vpn-indicator-connect"
                    disabled={addWaiting}
                    title={t("machines.loginInTerminalTitle")}
                    onClick={() => void startTerminalAdd()}
                  >
                    {addWaiting ? t("machines.waitingForLogin") : t("machines.loginInTerminal")}
                  </button>
                ) : (
                  <button type="button" className="vpn-indicator-connect" disabled={addBusy} onClick={() => void submitAdd()}>
                    {addBusy ? t("machines.connecting") : t("machines.connectAndAdd")}
                  </button>
                )}
                {/* Only after the poll has given up: a login finished late is still a
                    login, and re-arming beats retyping the whole form. */}
                {addViaTerminal && !addWaiting && addError && (
                  <button type="button" className="vpn-indicator-connect" onClick={retryTerminalAdd}>
                    {t("machines.loggedInAdd")}
                  </button>
                )}
                <button
                  type="button"
                  className="vpn-indicator-remove"
                  onClick={() => {
                    clearAddPoll();
                    setAddWaiting(false);
                    setAdding(false);
                  }}
                >
                  {t("common.cancel")}
                </button>
              </div>
            </div>
          ) : (
            <div className="vpn-indicator-row vpn-indicator-browse machines-io-buttons">
              <button type="button" className="vpn-indicator-connect" onClick={() => setAdding(true)}>
                {t("machines.addMachine")}
              </button>
              <button
                type="button"
                className="vpn-indicator-connect"
                title={t("machines.importTitle")}
                onClick={() => void startImport()}
              >
                {t("machines.import")}
              </button>
              <button
                type="button"
                className="vpn-indicator-connect"
                disabled={machines.length === 0}
                title={t("machines.exportTitle")}
                onClick={startExport}
              >
                {t("machines.export")}
              </button>
            </div>
          )}
            </>
          )}
    </>
  );

  if (isOverlay) return <MachinesOverlayFrame>{body}</MachinesOverlayFrame>;

  return (
    <div
      ref={anchorRef}
      className="global-apps-menu header-status-menu-anchor no-drag"
      onMouseEnter={reveal}
      onMouseLeave={scheduleClose}
    >
      <button
        type="button"
        className="global-apps-menu-btn machines-indicator-btn"
        aria-label={t("machines.ariaLabel")}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        title={t("machines.triggerTitle")}
        // A click opens the Machines overlay — the Models & agents button's
        // pattern (`layout/LocalModelMenu`): hover is the glance, click is the
        // room. The dropdown goes with the click rather than staying up over
        // the overlay it just raised. Focus alone still reveals the dropdown,
        // the keyboard's way to the glance.
        onClick={() => {
          window.clearTimeout(closeTimer.current);
          closeMenu(MENU_ID);
          useMachinesOverlayStore.getState().openOverlay();
        }}
        onFocus={reveal}
      >
        <span className="header-conn-lamps">
          {lampGroups.map((g) => (
            <span key={g.lamp} className="conn-lamp-count">
              <ConnLamp status={g.lamp} busy={g.working.length > 0} label={lampLabel(g)} />
              {g.machines.length > 1 && (
                <span className="conn-lamp-count-num">{g.machines.length}</span>
              )}
            </span>
          ))}
        </span>
        <MachinesGlyph className="header-status-glyph" />
      </button>
      {menuOpen && (
        <div className="tab-new-menu vpn-indicator-menu machines-indicator-menu" role="menu">
          {/* Pinned title: stays put while the region below it scrolls, so the
              scrollbar starts beneath the header (unified `.menu-scroll-region`
              shape). Keeping it OUT of the scroller also spares the accent rail /
              rounded top from the native scrollbar running over them. */}
          <div className="tab-new-menu-group-label vpn-indicator-title">
            <span>{t("machines.groupLabel")}</span>
            {/* The door to the overlay, for a pointer that came in by hover
                and would otherwise not know a click on the button opens it. */}
            <button
              type="button"
              className="machines-open-overlay"
              aria-label={t("machines.openOverlayAria")}
              title={t("machines.openOverlayTitle")}
              onClick={() => {
                closeMenu(MENU_ID);
                useMachinesOverlayStore.getState().openOverlay();
              }}
            >
              ⤢
            </button>
            <button
              type="button"
              className="vpn-indicator-close"
              aria-label={t("common.close")}
              title={t("common.close")}
              onClick={() => closeMenu(MENU_ID)}
            >
              ×
            </button>
          </div>
          <div className="menu-scroll-region">
            {body}
          </div>
        </div>
      )}
    </div>
  );
}
