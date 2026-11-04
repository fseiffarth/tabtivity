import { useModalFocus } from "../../hooks/useModalFocus";
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import type { ProjectBox, ProjectEntry } from "../../types";
import { useProjectsStore } from "../../stores/projects";
import { diffBoxMembers, useBoxesStore, type BoxDraftDiff } from "../../stores/boxes";
import { useBoxSliceStore } from "../../stores/boxSlice";
import { useTabsStore } from "../../stores/tabs";
import { BOX_SCOPE_PREFIX } from "../../lib/terminal/ptyId";
import { useSettingsStore } from "../../stores/settings";
import { useBoxNameCheck } from "./useQuickCreateBox";
import { BoxColorSwatches } from "./BoxColorPicker";
import { useBoxEditorStore } from "../../stores/boxEditor";
import { usePillSelectionStore } from "../../stores/drag/pillSelection";
import { UntestedTag } from "../common/UntestedTag";
import { ErrorNote } from "../common/ErrorNote";
import { useT } from "../../lib/i18n";
import { useDialogs, type ConfirmSpec } from "../common/PromptDialogs";
import { BoxSwatch, CloseIcon } from "../common/icons/Icon";
import { ToggleRow } from "../layout/settingsUi";
import { MobileAccessPicker, PhoneReachButton } from "../mobile/MobileAccessPicker";
import { usePairedPhones } from "../mobile/usePairedPhones";
import { MOBILE_ACCESS_KEY, MOBILE_DEVICES_KEY } from "../../lib/brand";
import { IS_HOST_WINDOWS } from "../../lib/platform";
import { boxColor, isBoxColor } from "../../lib/theme/boxColor";
import { projectHostKind } from "../../lib/projectTabHost";

/**
 * The box sheet — one box, edited wholesale: its name (checked as you type),
 * colour, member projects (closed ones too, each row saying what kind of project
 * it is and which other boxes hold it), the folder, its phone access and, set
 * apart in the footer, **Dissolve box…**. A box is born through the name prompt
 * (`useQuickCreateBox`), never here: no target dropdown, no create mode, so a
 * half-made draft can never be swapped away by a click on another box.
 *
 * Save is ONE diffed `saveBox` against the snapshot taken when the sheet opened
 * (name, colour, members added and removed), not the whole member list: a project
 * another window, the phone or an import added meanwhile survives. The phone row
 * is the Settings → Mobile switch and acts at once, as that one does.
 *
 * Dissolving is the ONLY way a box disappears (no silent one-member dissolve), an
 * explicit, confirmed action; the confirm states what is kept — the box folder
 * (named by its path) and its agent docs; the member projects are untouched. A
 * box you are inside is left first, or the scope would stay `box:<id>` of a box
 * that is gone.
 *
 * Mounted once in `AppShell` (`BoxEditorHost`, the RemoteMachines host pattern),
 * driven by `stores/boxEditor`. Portaled dialog: the chrome sets an explicit
 * color (`.project-dialog` does), since `body` has none and a portal would
 * otherwise inherit black.
 */

/** The one dissolve question, asked by the sheet's Dissolve and by the box
 *  pill's alike — both say what survives (folder, agent docs, members). A box
 *  that has a folder names its path. */
export function dissolveBoxSpec(t: ReturnType<typeof useT>, name: string, folder?: string): ConfirmSpec {
  return {
    title: t("boxEditor.dissolve"),
    body: folder
      ? t("boxEditor.dissolveConfirmFolder", { name, folder })
      : t("boxEditor.dissolveConfirm", { name }),
    confirmLabel: t("boxEditor.dissolve"),
    danger: true,
  };
}

/** What the sheet opened with: the diff is taken against this, never against
 *  the live box (which may have moved since). */
interface Loaded {
  name: string;
  color: string;
  members: string[];
}

function loadedOf(box: ProjectBox): Loaded {
  return {
    name: box.name,
    color: isBoxColor(box.color) ? box.color.toLowerCase() : "",
    members: [...box.member_ids],
  };
}

type Kind = "closed" | "container" | "vm" | "remote";

/** The badges of a project's row, in reading order. */
function kindsOf(p: ProjectEntry): Kind[] {
  const kinds: Kind[] = [];
  if (p.status === "inactive") kinds.push("closed");
  const host = projectHostKind(p);
  if (host !== "local") kinds.push(host);
  return kinds;
}

const KIND_KEY = {
  closed: "boxMembers.closed",
  container: "boxEditor.badgeContainer",
  vm: "boxEditor.badgeVm",
  remote: "boxEditor.badgeRemote",
} as const satisfies Record<Kind, string>;

export function BoxEditorDialog({ onClose }: { onClose: () => void }) {
  const boxId = useBoxEditorStore((s) => s.boxId);
  const box = useBoxesStore((s) => (boxId ? s.boxes.find((b) => b.id === boxId) ?? null : null));
  // The box went away under the sheet (dissolved from its pill, or in another
  // window): there is nothing left to edit.
  const gone = !box;
  useEffect(() => {
    if (gone) onClose();
  }, [gone, onClose]);
  if (!box) return null;
  return <BoxSheet key={box.id} box={box} onClose={onClose} />;
}

function BoxSheet({ box, onClose }: { box: ProjectBox; onClose: () => void }) {
  const t = useT();
  const { confirmAction, dialogs } = useDialogs();
  const { check, messageOf } = useBoxNameCheck();
  const projects = useProjectsStore((s) => s.projects);
  const boxes = useBoxesStore((s) => s.boxes);
  const saveBox = useBoxesStore((s) => s.saveBox);
  const deleteBox = useBoxesStore((s) => s.deleteBox);

  const [loaded] = useState<Loaded>(() => loadedOf(box));
  const [name, setName] = useState(loaded.name);
  const [color, setColor] = useState(loaded.color);
  const [checked, setChecked] = useState<string[]>(loaded.members);
  const [filter, setFilter] = useState("");
  const [saving, setSaving] = useState(false);
  // The per-phone picker's anchor while it is open (Escape closes it first).
  const [picker, setPicker] = useState<{ x: number; y: number } | null>(null);
  const modalRef = useModalFocus(() => (picker ? setPicker(null) : onClose()));

  // Only a name that differs from the one the sheet opened with is checked, so a
  // legacy empty or duplicate name never blocks a colour or member save.
  const trimmed = name.trim();
  const renamed = trimmed !== loaded.name;
  const nameProblem = renamed ? check(name, box.id) : null;
  const recoloured = color !== loaded.color;

  // Members first (as they were when the sheet opened), then the rest, each by
  // position. Ticking a row does not move it under the pointer.
  const order = useMemo(() => {
    const was = new Set(loaded.members);
    const all = [...projects].sort((a, b) => a.position - b.position);
    return [...all.filter((p) => was.has(p.id)), ...all.filter((p) => !was.has(p.id))];
  }, [projects, loaded]);

  const rows = useMemo(() => {
    const needle = filter.trim().toLocaleLowerCase();
    return order
      .filter((p) => !needle || p.name.toLocaleLowerCase().includes(needle))
      .map((p) => ({
        project: p,
        kinds: kindsOf(p),
        also: boxes.filter((b) => b.id !== box.id && b.member_ids.includes(p.id)),
      }));
  }, [order, filter, boxes, box.id]);

  const memberProjects = useMemo(
    () => checked.map((id) => projects.find((p) => p.id === id)).filter((p): p is ProjectEntry => !!p),
    [checked, projects],
  );
  const namesOf = (kind: Kind) =>
    memberProjects
      .filter((p) => kindsOf(p).includes(kind))
      .map((p) => p.name)
      .join(", ");
  const trust = (["container", "vm", "remote"] as const)
    .map((kind) => ({ kind, list: namesOf(kind) }))
    .filter((line) => line.list);

  const toggle = (id: string) =>
    setChecked((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const save = async () => {
    if (saving || nameProblem) return;
    setSaving(true);
    try {
      const diff: BoxDraftDiff = diffBoxMembers(loaded.members, checked);
      if (renamed) diff.name = trimmed;
      if (recoloured) diff.color = color;
      await saveBox(box.id, diff);
      usePillSelectionStore.getState().clear();
      onClose();
    } catch (error) {
      // A name another window took meanwhile, a refused write: say which, rather
      // than leaving the sheet looking unresponsive.
      useProjectsStore.setState({ switchToast: messageOf(error) });
      setSaving(false);
    }
  };

  const dissolve = async () => {
    // Explicit dissolve replaces the old silent one — say what is kept.
    if (!(await confirmAction(dissolveBoxSpec(t, box.name, box.folder)))) return;
    setSaving(true);
    try {
      // Inside the box (its slice, or its own scope): leave first.
      const inside =
        useBoxSliceStore.getState().sliceBoxId === box.id ||
        useTabsStore.getState().scope === `${BOX_SCOPE_PREFIX}${box.id}`;
      if (inside) await useBoxSliceStore.getState().leaveBox();
      await deleteBox(box.id);
      onClose();
    } catch (error) {
      useProjectsStore.setState({ switchToast: messageOf(error) });
      setSaving(false);
    }
  };

  const openFolder = () => {
    if (!box.folder) return;
    invoke("open_in_file_manager", { path: box.folder }).catch((error) =>
      useProjectsStore.setState({ switchToast: messageOf(error) }),
    );
  };

  return createPortal(
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        ref={modalRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={t("boxEditor.sheetTitle", { name: box.name })}
        className="project-dialog dialog-framed box-editor"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="settings-title-row">
          <h2>
            {t("boxEditor.sheetTitle", { name: box.name })} <UntestedTag id="boxEditor.sheet" />
          </h2>
          <button aria-label={t("common.close")} type="button" className="dialog-close-btn" onClick={onClose}><CloseIcon /></button>
        </div>
        <div className="dialog-scroll">
          <label>
            {t("boxEditor.nameLabel")}
            <input
              type="text"
              value={name}
              autoFocus
              aria-invalid={nameProblem ? true : undefined}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void save();
              }}
            />
            {nameProblem && <span className="project-dialog-error box-editor-name-error" role="alert">{nameProblem}</span>}
          </label>

          <div className="box-editor-field">
            <span className="box-editor-field-label">{t("boxEditor.colourLabel")}</span>
            <BoxColorSwatches boxId={box.id} color={color} onPick={(c) => setColor(c ?? "")} />
          </div>

          <div className="box-editor-field">
            <div className="box-editor-members-head">
              <span className="box-editor-field-label">{t("boxEditor.membersLabel")}</span>
              <span className="box-editor-count">
                {t("boxEditor.membersCount", { count: memberProjects.length, total: projects.length })}
              </span>
            </div>
            <input
              type="text"
              className="box-editor-filter"
              placeholder={t("boxEditor.filterPlaceholder")}
              aria-label={t("boxEditor.filterPlaceholder")}
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
            <div className="box-editor-members">
              {rows.length === 0 ? (
                <div className="box-editor-empty">{t("boxEditor.noProjects")}</div>
              ) : (
                rows.map(({ project: p, kinds, also }) => (
                  <label key={p.id} className="box-editor-member-row" data-member-id={p.id}>
                    <input
                      type="checkbox"
                      checked={checked.includes(p.id)}
                      onChange={() => toggle(p.id)}
                    />
                    <span className="box-editor-member-name">{p.name}</span>
                    {kinds.map((kind) => (
                      <span key={kind} className={`box-editor-badge is-${kind}`}>{t(KIND_KEY[kind])}</span>
                    ))}
                    {also.length > 0 && (
                      <span
                        className="box-editor-also"
                        title={t("boxEditor.alsoIn", { list: also.map((b) => b.name).join(", ") })}
                      >
                        {also.map((b) => (
                          <BoxSwatch key={b.id} className="box-editor-also-swatch" color={boxColor(b)} />
                        ))}
                      </span>
                    )}
                  </label>
                ))
              )}
            </div>
          </div>

          {trust.length > 0 && (
            <div className="box-editor-trust-note">
              {trust.map(({ kind, list }) => (
                <div key={kind}>{t(`boxEditor.trust.${kind}`, { list })}</div>
              ))}
            </div>
          )}

          <div className="box-editor-field">
            <span className="box-editor-field-label">{t("boxEditor.folderLabel")}</span>
            <div className="box-editor-folder">
              {box.folder ? (
                <>
                  <code className="box-editor-folder-path" title={box.folder}>{box.folder}</code>
                  <button type="button" className="box-editor-open" onClick={openFolder} title={t("projectFilesView.openInFileManagerTitle")}>
                    {t("boxEditor.folderOpen")}
                  </button>
                </>
              ) : (
                <span className="box-editor-folder-none">{t("boxEditor.folderNone")}</span>
              )}
            </div>
            <span className="box-editor-help">{t("boxEditor.folderNote")}</span>
          </div>

          <BoxPhoneRow box={box} picker={picker} setPicker={setPicker} />

          <div className="project-dialog-actions">
            <button
              type="button"
              className="danger box-editor-dissolve"
              onClick={() => void dissolve()}
              disabled={saving}
              title={t("boxEditor.dissolveTitle")}
            >
              {t("boxPill.dissolveBox")}
            </button>
            <button type="button" onClick={onClose} disabled={saving}>
              {t("common.cancel")}
            </button>
            <button type="button" onClick={() => void save()} disabled={saving || !!nameProblem}>
              {t("common.save")}
            </button>
          </div>
        </div>
        {dialogs}
      </div>
    </div>,
    document.body,
  );
}

/**
 * The phone row: the Settings → Mobile box switch and its "All phones ▾" picker,
 * reused. It acts at once (the same write Settings makes), and always with the
 * box's CURRENT per-phone list — passing `null` would widen a box that reaches
 * two phones to every phone. A box's tabs reach the phone through the tmux
 * session they run in, so with no tmux (Windows) or persistent local sessions
 * switched off the row is replaced by a line saying why.
 */
function BoxPhoneRow({
  box,
  picker,
  setPicker,
}: {
  box: ProjectBox;
  picker: { x: number; y: number } | null;
  setPicker: (at: { x: number; y: number } | null) => void;
}) {
  const t = useT();
  const persistLocal = useSettingsStore((s) => s.settings?.persist_local_sessions);
  if (IS_HOST_WINDOWS) return <BoxPhoneNote text={t("boxEditor.phoneNoTmux")} />;
  if (persistLocal === false) return <BoxPhoneNote text={t("boxEditor.phoneNoPersist")} />;
  return <BoxPhoneSwitch box={box} picker={picker} setPicker={setPicker} />;
}

function BoxPhoneNote({ text }: { text: string }) {
  const t = useT();
  return (
    <div className="box-editor-field">
      <span className="box-editor-field-label">{t("boxEditor.phoneLabel")}</span>
      <span className="box-editor-help">{text}</span>
    </div>
  );
}

function BoxPhoneSwitch({
  box,
  picker,
  setPicker,
}: {
  box: ProjectBox;
  picker: { x: number; y: number } | null;
  setPicker: (at: { x: number; y: number } | null) => void;
}) {
  const t = useT();
  const setBoxMobileAccess = useBoxesStore((s) => s.setBoxMobileAccess);
  const { phones } = usePairedPhones();
  const [error, setError] = useState<string | null>(null);
  const on = box[MOBILE_ACCESS_KEY] ?? false;
  const devices = box[MOBILE_DEVICES_KEY];
  return (
    <div className="box-editor-field box-editor-phone">
      <span className="box-editor-field-label">{t("boxEditor.phoneLabel")}</span>
      <ToggleRow
        label={<>{t("boxEditor.phoneSwitch")} <UntestedTag id="boxEditor.phoneRow" /></>}
        checked={on}
        onChange={(event) => {
          setError(null);
          // The box as it is NOW: its per-phone list is kept, never widened.
          const live = useBoxesStore.getState().boxes.find((b) => b.id === box.id);
          void setBoxMobileAccess(box.id, event.target.checked, live?.[MOBILE_DEVICES_KEY] ?? null).catch((reason) =>
            setError(String(reason)),
          );
        }}
        aside={
          on ? (
            <PhoneReachButton
              name={box.name}
              list={devices}
              phones={phones}
              onOpen={(r) => setPicker({ x: r.left, y: r.bottom + 2 })}
            />
          ) : null
        }
      />
      {error && <ErrorNote error={error} className="project-dialog-error" />}
      {picker && (
        <MobileAccessPicker
          x={picker.x}
          y={picker.y}
          kind="box"
          enabled={on}
          devices={devices}
          onApply={(enabled, list) => setBoxMobileAccess(box.id, enabled, list)}
          onClose={() => setPicker(null)}
        />
      )}
    </div>
  );
}

/** The one mount of the box sheet per window (AppShell), driven by its store. */
export function BoxEditorHost() {
  const open = useBoxEditorStore((s) => s.open);
  const close = useBoxEditorStore((s) => s.close);
  if (!open) return null;
  return <BoxEditorDialog onClose={close} />;
}
