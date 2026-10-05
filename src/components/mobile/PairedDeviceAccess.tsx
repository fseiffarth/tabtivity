import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useT, type TranslationKey } from "../../lib/i18n";
import { MOBILE_ACCESS_KEY, MOBILE_DEVICES_KEY } from "../../lib/brand";
import { useProjectsStore } from "../../stores/projects";
import { useBoxesStore } from "../../stores/boxes";
import { ContextMenuPortal } from "../common/ContextMenuPortal";
import { ErrorNote } from "../common/ErrorNote";
import { UntestedTag } from "../common/UntestedTag";
import type { PairedPhone } from "./usePairedPhones";
import type { ProjectEntry } from "../../types";

/** The phone sections a device can be kept out of — the sidecar's
 *  `auth::HIDEABLE_SECTIONS`, in its order. */
export const HIDEABLE_SECTIONS = ["todo", "calendar", "mail"] as const;
type Section = (typeof HIDEABLE_SECTIONS)[number];
const SECTION_LABEL: Record<Section, TranslationKey> = {
  todo: "mobile.device.todo",
  calendar: "mobile.device.calendar",
  mail: "mobile.device.mail",
};

/** A project or box as far as phone access goes. */
interface Scope {
  kind: "project" | "box";
  id: string;
  name: string;
  enabled: boolean;
  devices: unknown;
}

/** The stored per-phone list as ids, or `null` for "every phone". A malformed
 *  value reaches no phone (as the sidecar reads it), so it is an empty list. */
function listOf(devices: unknown): string[] | null {
  if (devices === undefined || devices === null) return null;
  return Array.isArray(devices) && devices.every((d) => typeof d === "string") ? devices : [];
}

/** Whether a project may have Mobile access at all: local, outside a container
 *  or VM. Settings' access list and the header menu's phone dialog share it. */
export function isMobileEligible(project: ProjectEntry): boolean {
  return !project.remote && !project.sandbox?.enabled && !project.vm?.enabled;
}

/** Whether `scope` is open to the phone `deviceId`, as the sidecar decides it. */
export function scopeReaches(scope: { enabled: boolean; devices: unknown }, deviceId: string): boolean {
  if (!scope.enabled) return false;
  const list = listOf(scope.devices);
  return list === null || list.includes(deviceId);
}

/**
 * What a scope's access becomes once `deviceId` is taken off it: a scope open
 * to every phone keeps every *other* paired phone (phones paired later are no
 * longer included — it is a list now); a list loses the id. Nothing left is
 * access off, since a list never names no phone.
 */
export function withoutDevice(
  scope: { devices: unknown },
  deviceId: string,
  pairedIds: string[],
): { enabled: boolean; devices: string[] | null } {
  const list = listOf(scope.devices) ?? pairedIds;
  const rest = list.filter((id) => id !== deviceId && pairedIds.includes(id));
  return rest.length > 0 ? { enabled: true, devices: rest } : { enabled: false, devices: null };
}

/** What a scope's access becomes once `deviceId` is added: off turns on for
 *  that phone alone; a list gains it. (One open to every phone has it.) */
export function withDevice(
  scope: { enabled: boolean; devices: unknown },
  deviceId: string,
  pairedIds: string[],
): { enabled: boolean; devices: string[] | null } {
  const list = scope.enabled ? listOf(scope.devices) : [];
  if (list === null) return { enabled: true, devices: null };
  return { enabled: true, devices: [...list.filter((id) => pairedIds.includes(id) && id !== deviceId), deviceId] };
}

/**
 * One paired phone's own access, under its row in Settings → Mobile: which
 * sections it may open (To-do, Calendar, Mail — the sidecar refuses a hidden
 * one's routes and drops its alerts and reminders), and which projects and
 * boxes reach it, each with Disconnect, plus Add for one that does not.
 *
 * The project list is the per-phone access lists (`MobileAccessPicker`) seen
 * from the phone's side: Disconnect and Add write the same project/box record.
 * Sections are written to the sidecar's device file over `mobile_admin`, so
 * they need the host running — as the device list itself does.
 */
export function PairedDeviceAccess({
  device,
  pairedIds,
  eligibleProjectIds,
  onChanged,
}: {
  device: PairedPhone;
  /** Every paired phone's id: the "every phone" a Disconnect narrows from. */
  pairedIds: string[];
  /** The projects that may have Mobile access at all (local, unsandboxed). */
  eligibleProjectIds: Set<string>;
  onChanged: () => void;
}) {
  const t = useT();
  const projects = useProjectsStore((state) => state.projects);
  const boxes = useBoxesStore((state) => state.boxes);
  const setProjectMobileAccess = useProjectsStore((state) => state.setProjectMobileAccess);
  const setBoxMobileAccess = useBoxesStore((state) => state.setBoxMobileAccess);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState<{ x: number; y: number } | null>(null);

  const hidden = new Set(device.hidden_sections ?? []);
  const scopes: Scope[] = [
    ...projects
      .filter((project) => eligibleProjectIds.has(project.id))
      .map((project): Scope => ({
        kind: "project",
        id: project.id,
        name: project.name,
        enabled: project[MOBILE_ACCESS_KEY] ?? false,
        devices: project[MOBILE_DEVICES_KEY],
      })),
    ...boxes.map((box): Scope => ({
      kind: "box",
      id: box.id,
      name: box.name,
      enabled: box[MOBILE_ACCESS_KEY] ?? false,
      devices: box[MOBILE_DEVICES_KEY],
    })),
  ];
  const connected = scopes.filter((scope) => scopeReaches(scope, device.id));
  const addable = scopes.filter((scope) => !scopeReaches(scope, device.id));

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };
  const write = (scope: Scope, next: { enabled: boolean; devices: string[] | null }) =>
    scope.kind === "project"
      ? setProjectMobileAccess(scope.id, next.enabled, next.devices)
      : setBoxMobileAccess(scope.id, next.enabled, next.devices);

  const toggleSection = (section: Section) =>
    void run(async () => {
      const next = HIDEABLE_SECTIONS.filter((s) => (s === section ? !hidden.has(s) : hidden.has(s)));
      const answer = await invoke<{ status: string; message?: string }>("mobile_admin", {
        request: { type: "set_hidden_sections", device_id: device.id, sections: next },
      });
      if (answer.status === "error") throw new Error(answer.message);
      onChanged();
    });

  return (
    <div className="mobile-device-access">
      <div className="mobile-device-access-label">
        {t("mobile.device.sections")} <UntestedTag id="mobile.deviceSections" />
      </div>
      <div className="settings-list project-ending-list mobile-device-sections">
        {HIDEABLE_SECTIONS.map((section) => {
          const on = !hidden.has(section);
          return (
            <button
              type="button"
              key={section}
              className={`project-ending-toggle${on ? "" : " is-hidden"}`}
              aria-pressed={on}
              disabled={busy}
              title={t(on ? "mobile.device.sectionOn" : "mobile.device.sectionOff", {
                section: t(SECTION_LABEL[section]),
                device: device.name,
              })}
              onClick={() => toggleSection(section)}
            >
              {t(SECTION_LABEL[section])}
            </button>
          );
        })}
      </div>

      <div className="mobile-device-access-label">
        {t("mobile.device.projects")} <UntestedTag id="mobile.deviceProjects" />
      </div>
      {connected.length === 0 && <p className="settings-help">{t("mobile.device.noProjects")}</p>}
      {connected.map((scope) => (
        <div key={`${scope.kind}:${scope.id}`} className="settings-row mobile-device-project">
          <span className="settings-list-label">
            {scope.name}
            {scope.kind === "box" && <span className="tab-menu-hint"> {t("mobile.device.box")}</span>}
          </span>
          <button
            type="button"
            className="settings-btn sm"
            disabled={busy}
            title={t(listOf(scope.devices) === null ? "mobile.device.disconnectAllTitle" : "mobile.device.disconnectTitle", {
              name: scope.name,
              device: device.name,
            })}
            onClick={() => void run(() => write(scope, withoutDevice(scope, device.id, pairedIds)))}
          >
            {t("mobile.device.disconnect")}
          </button>
        </div>
      ))}
      <button
        type="button"
        className="settings-btn sm mobile-device-add"
        aria-haspopup="menu"
        disabled={busy || addable.length === 0}
        title={addable.length === 0 ? t("mobile.device.allAdded") : undefined}
        onClick={(event) => {
          const r = event.currentTarget.getBoundingClientRect();
          setAdding({ x: r.left, y: r.bottom + 2 });
        }}
      >
        {t("mobile.device.add")} ▾
      </button>
      {error && <ErrorNote className="settings-help" role="alert" error={error} />}

      {adding && (
        <ContextMenuPortal x={adding.x} y={adding.y} onClose={() => setAdding(null)} keepBelow className="context-menu mobile-access-picker">
          <div className="menu-scroll-region">
            <div className="context-menu-group">
              <div className="context-menu-group-label">{t("mobile.device.addTitle", { device: device.name })}</div>
              {addable.map((scope) => (
                <button
                  type="button"
                  key={`${scope.kind}:${scope.id}`}
                  disabled={busy}
                  onClick={() => {
                    setAdding(null);
                    void run(() => write(scope, withDevice(scope, device.id, pairedIds)));
                  }}
                >
                  {scope.name}
                  {scope.kind === "box" && <span className="tab-menu-hint">{t("mobile.device.box")}</span>}
                  {!scope.enabled && <span className="tab-menu-hint">{t("mobile.device.turnsOn")}</span>}
                </button>
              ))}
            </div>
          </div>
        </ContextMenuPortal>
      )}
    </div>
  );
}
