import { useCallback, useEffect, useState } from "react";
import { useT } from "../../lib/i18n";
import { MOBILE_ACCESS_KEY, MOBILE_DEVICES_KEY } from "../../lib/brand";
import { useProjectsStore } from "../../stores/projects";
import { useBoxesStore } from "../../stores/boxes";
import { useBigFoldersStore } from "../../stores/bigFolders";
import { pairedIdsNow, usePhoneShareStore, type PairedDevice, type PhoneShareAsk } from "../../stores/phoneShare";
import { DialogShell } from "../common/PromptDialogs";
import { UntestedTag } from "../common/UntestedTag";
import { scopeReaches, withDevice } from "./PairedDeviceAccess";

/**
 * A project just added on the desktop: which paired phones reach it. Every
 * phone starts ticked; all ticked opens it to every phone (phones paired later
 * too), as Settings → Mobile's switch turned on does; fewer writes that list.
 */
function NewProjectAsk({
  projectId,
  phones,
  onDone,
}: {
  projectId: string;
  /** The phones paired when the project was added (never empty). */
  phones: PairedDevice[];
  onDone: () => void;
}) {
  const t = useT();
  const project = useProjectsStore((s) => s.projects.find((p) => p.id === projectId));
  const setProjectMobileAccess = useProjectsStore((s) => s.setProjectMobileAccess);
  const [ticked, setTicked] = useState<Set<string>>(() => new Set(phones.map((phone) => phone.id)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Removed before the user answered: nothing to ask.
  useEffect(() => {
    if (!project) onDone();
  }, [project, onDone]);
  if (!project) return null;

  const toggle = (id: string) =>
    setTicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const share = async () => {
    setBusy(true);
    setError(null);
    try {
      // The backend cuts a list to the phones still paired.
      const list = phones.filter((phone) => ticked.has(phone.id)).map((phone) => phone.id);
      await setProjectMobileAccess(project.id, true, list.length === phones.length ? null : list);
      onDone();
    } catch (reason) {
      setError(String(reason));
      setBusy(false);
    }
  };

  return (
    <DialogShell
      frame="project-dialog"
      className="skills-copy"
      scroll
      title={
        <>
          {t("mobile.share.projectTitle", { name: project.name })} <UntestedTag id="mobile.shareNewProject" />
        </>
      }
      onDismiss={onDone}
      closeDisabled={busy}
    >
      <div className="skills-copy-body">
        <div className="project-dialog-path">{t("mobile.share.projectIntro")}</div>
        <ul className="skills-copy-list" aria-label={t("mobile.phones.pickerTitle")}>
          {phones.map((phone) => (
            <li key={phone.id}>
              <label>
                <input type="checkbox" checked={ticked.has(phone.id)} disabled={busy} onChange={() => toggle(phone.id)} />
                <span className="skills-copy-name">{phone.name}</span>
              </label>
            </li>
          ))}
        </ul>
        {error && <div className="skills-copy-note" role="alert">{error}</div>}
        <div className="project-dialog-actions">
          <button type="button" className="settings-btn" disabled={busy} onClick={onDone}>
            {t("mobile.share.notNow")}
          </button>
          <button type="button" className="btn-primary" disabled={busy || ticked.size === 0} onClick={() => void share()}>
            {t("mobile.share.openOnPhone")}
          </button>
        </div>
      </div>
    </DialogShell>
  );
}

/**
 * A phone that just paired: which existing projects and boxes it reaches.
 * Nothing starts ticked; a scope already open to every phone reaches it
 * anyway and is shown ticked and fixed (Settings → Mobile narrows it).
 */
function NewPhoneAsk({ deviceId, deviceName, onDone }: { deviceId: string; deviceName: string; onDone: () => void }) {
  const t = useT();
  const projects = useProjectsStore((s) => s.projects);
  const boxes = useBoxesStore((s) => s.boxes);
  const setProjectMobileAccess = useProjectsStore((s) => s.setProjectMobileAccess);
  const setBoxMobileAccess = useBoxesStore((s) => s.setBoxMobileAccess);
  const [ticked, setTicked] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const scopes = [
    ...projects.map((project) => ({
      kind: "project" as const,
      id: project.id,
      name: project.name,
      enabled: project[MOBILE_ACCESS_KEY] ?? false,
      devices: project[MOBILE_DEVICES_KEY] as unknown,
    })),
    ...boxes.map((box) => ({
      kind: "box" as const,
      id: box.id,
      name: box.name,
      enabled: box[MOBILE_ACCESS_KEY] ?? false,
      devices: box[MOBILE_DEVICES_KEY] as unknown,
    })),
  ];
  const keyOf = (scope: { kind: string; id: string }) => `${scope.kind}:${scope.id}`;

  // Nothing to choose from: no question.
  useEffect(() => {
    if (projects.length === 0 && boxes.length === 0) onDone();
  }, [projects.length, boxes.length, onDone]);
  if (scopes.length === 0) return null;

  const toggle = (key: string) =>
    setTicked((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const share = async () => {
    setBusy(true);
    setError(null);
    // The phones paired now: `withDevice` keeps a list's other phones only
    // while they are still paired, so a guess here would drop them.
    const paired = await pairedIdsNow();
    if (!paired) {
      setError(t("mobile.share.unreadable"));
      setBusy(false);
      return;
    }
    const pairedIds = paired.includes(deviceId) ? paired : [...paired, deviceId];
    const failed: string[] = [];
    let firstError: string | null = null;
    for (const scope of scopes) {
      if (!ticked.has(keyOf(scope)) || scopeReaches(scope, deviceId)) continue;
      const next = withDevice(scope, deviceId, pairedIds);
      try {
        if (scope.kind === "project") await setProjectMobileAccess(scope.id, next.enabled, next.devices);
        else await setBoxMobileAccess(scope.id, next.enabled, next.devices);
      } catch (reason) {
        failed.push(keyOf(scope));
        firstError ??= `${scope.name}: ${String(reason)}`;
      }
    }
    if (failed.length === 0) {
      onDone();
      return;
    }
    // Keep only what failed ticked, so Done retries just those.
    setTicked(new Set(failed));
    setError(firstError);
    setBusy(false);
  };

  return (
    <DialogShell
      frame="project-dialog"
      className="skills-copy"
      scroll
      title={
        <>
          {t("mobile.share.phoneTitle", { device: deviceName })} <UntestedTag id="mobile.shareNewPhone" />
        </>
      }
      onDismiss={onDone}
      closeDisabled={busy}
    >
      <div className="skills-copy-body">
        <div className="project-dialog-path">{t("mobile.share.phoneIntro")}</div>
        <ul className="skills-copy-list" aria-label={t("mobile.device.projects")}>
          {scopes.map((scope) => {
            const reaches = scopeReaches(scope, deviceId);
            return (
              <li key={keyOf(scope)}>
                <label>
                  <input
                    type="checkbox"
                    checked={reaches || ticked.has(keyOf(scope))}
                    disabled={busy || reaches}
                    onChange={() => toggle(keyOf(scope))}
                  />
                  <span className="skills-copy-name">{scope.name}</span>
                </label>
                {reaches ? (
                  <small className="skills-copy-flag">{t("mobile.share.everyPhone")}</small>
                ) : scope.kind === "box" ? (
                  <small className="skills-copy-flag">{t("mobile.device.box")}</small>
                ) : null}
              </li>
            );
          })}
        </ul>
        {error && <div className="skills-copy-note" role="alert">{error}</div>}
        <div className="project-dialog-actions">
          <button type="button" className="settings-btn" disabled={busy} onClick={onDone}>
            {t("mobile.share.skip")}
          </button>
          <button type="button" className="btn-primary" disabled={busy || ticked.size === 0} onClick={() => void share()}>
            {t("mobile.share.done")}
          </button>
        </div>
      </div>
    </DialogShell>
  );
}

function Ask({ ask, onDone }: { ask: PhoneShareAsk; onDone: () => void }) {
  return ask.kind === "project" ? (
    <NewProjectAsk projectId={ask.projectId} phones={ask.phones} onDone={onDone} />
  ) : (
    <NewPhoneAsk deviceId={ask.deviceId} deviceName={ask.deviceName} onDone={onDone} />
  );
}

/** Mounted once (AppShell, main window): shows the queued phone asks one at a
 *  time, after the large-folder prompt a new remote project opens first. */
export function PhoneShareDialogHost() {
  const ask = usePhoneShareStore((s) => s.queue[0]);
  const done = usePhoneShareStore((s) => s.done);
  const bigFoldersOpen = useBigFoldersStore((s) => s.projectId !== null);
  const onDone = useCallback(() => {
    if (ask) done(ask);
  }, [ask, done]);
  if (!ask || bigFoldersOpen) return null;
  const key = ask.kind === "project" ? `project:${ask.projectId}` : `phone:${ask.deviceId}`;
  return <Ask key={key} ask={ask} onDone={onDone} />;
}
