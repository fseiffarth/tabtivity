import { useModalFocus } from "../../hooks/useModalFocus";
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type { ProjectEntry } from "../../types";
import { useProjectsStore } from "../../stores/projects";
import { useBoxesStore } from "../../stores/boxes";
import { useBoxEditorStore } from "../../stores/boxEditor";
import { usePillSelectionStore } from "../../stores/drag/pillSelection";
import { UntestedTag } from "../common/UntestedTag";
import { Dropdown } from "../common/Dropdown";
import { useT } from "../../lib/i18n";
import { useDialogs, type ConfirmSpec } from "../common/PromptDialogs";

/**
 * The Box editor — the one surface where a box is managed wholesale: rename it,
 * set its full member list (a searchable checkbox list over every project), and
 * **dissolve** it. Dissolving is the ONLY way a box disappears now (the old
 * silent one-member dissolve is gone), so it is an explicit, confirmed action —
 * and the confirm states what is kept: the box folder and its agent docs are
 * never deleted, and the member projects are untouched.
 *
 * Mounted once in `AppShell` (`BoxEditorHost`, the RemoteMachines host
 * pattern), driven by `stores/boxEditor`; opened from the box chip's menu, a
 * pill's Boxes group, the multi-select "Box these…" action, and the switcher's
 * "+" menu. A box selector at the top switches between existing boxes and
 * create mode without closing the dialog.
 *
 * Portaled dialog: the chrome sets an explicit color (`.project-dialog` does),
 * since `body` has none and a portal would otherwise inherit black.
 */
/** The one dissolve question, asked by the editor's Dissolve and by the box
 *  pill's Delete alike — both say what survives (folder, agent docs, members). */
export function dissolveBoxSpec(t: ReturnType<typeof useT>, name: string): ConfirmSpec {
  return {
    title: t("boxEditor.dissolve"),
    body: t("boxEditor.dissolveConfirm", { name }),
    confirmLabel: t("boxEditor.dissolve"),
    danger: true,
  };
}

export function BoxEditorDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const modalRef = useModalFocus(onClose);
  const { confirmAction, dialogs } = useDialogs();
  const projects = useProjectsStore((s) => s.projects);
  const boxes = useBoxesStore((s) => s.boxes);
  const renameBox = useBoxesStore((s) => s.renameBox);
  const deleteBox = useBoxesStore((s) => s.deleteBox);
  const setBoxMembers = useBoxesStore((s) => s.setBoxMembers);
  const boxProjects = useBoxesStore((s) => s.boxProjects);
  const boxId = useBoxEditorStore((s) => s.boxId);
  const initialMemberIds = useBoxEditorStore((s) => s.initialMemberIds);

  // The target being edited: an existing box id, or "" for create mode. The
  // draft (name + checked members) reloads whenever the target moves.
  const [target, setTarget] = useState<string>(boxId ?? "");
  const box = boxes.find((b) => b.id === target) ?? null;
  const [name, setName] = useState<string>(box?.name ?? t("boxEditor.defaultName"));
  const [checked, setChecked] = useState<string[]>(box?.member_ids ?? initialMemberIds);
  const [filter, setFilter] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const next = boxes.find((b) => b.id === target) ?? null;
    setName(next?.name ?? t("boxEditor.defaultName"));
    setChecked(next?.member_ids ?? initialMemberIds);
    // Reload the draft only when the TARGET moves — not on every boxes-store
    // refresh, which would clobber half-made edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);

  const visibleProjects = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const list = projects.filter((p) => p.status !== "inactive");
    return q ? list.filter((p) => p.name.toLowerCase().includes(q)) : list;
  }, [projects, filter]);

  // v1 trust statement: box tabs run local + uncontained — a member's
  // container/VM boundary does not extend to the shared box scope.
  const guardedMembers = useMemo(
    () =>
      checked
        .map((id) => projects.find((p) => p.id === id))
        .filter((p): p is ProjectEntry => !!p && (!!p.sandbox?.enabled || !!p.vm?.enabled)),
    [checked, projects],
  );

  const toggle = (id: string) =>
    setChecked((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const save = async () => {
    setSaving(true);
    try {
      const trimmed = name.trim() || t("boxEditor.defaultName");
      if (box) {
        if (trimmed !== box.name) await renameBox(box.id, trimmed);
        await setBoxMembers(box.id, checked);
      } else {
        await boxProjects(checked, { name: trimmed });
      }
      usePillSelectionStore.getState().clear();
      onClose();
    } catch {
      setSaving(false);
    }
  };

  const dissolve = async () => {
    if (!box) return;
    // Explicit dissolve replaces the old silent one — say what is kept.
    if (!(await confirmAction(dissolveBoxSpec(t, box.name)))) return;
    setSaving(true);
    try {
      await deleteBox(box.id);
      onClose();
    } catch {
      setSaving(false);
    }
  };

  return createPortal(
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        ref={modalRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        className="project-dialog dialog-framed box-editor"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="settings-title-row">
          <h2>
            {t("boxEditor.title")} <UntestedTag id="boxEditor.title" />
          </h2>
          <button type="button" className="dialog-close-btn" onClick={onClose}>×</button>
        </div>
        <div className="dialog-scroll">
          <label>
            {t("boxEditor.boxLabel")}
            <Dropdown
              className="dropdown-block box-editor-target"
              value={target}
              onChange={setTarget}
              options={[
                { value: "", label: t("boxEditor.newBoxOption") },
                ...boxes.map((b) => ({ value: b.id, label: b.name })),
              ]}
            />
          </label>

          <label>
            {t("boxEditor.nameLabel")}
            <input
              type="text"
              value={name}
              autoFocus
              onChange={(e) => setName(e.target.value)}
            />
          </label>

          <label>
            {t("boxEditor.membersLabel")}
            <input
              type="text"
              className="box-editor-filter"
              placeholder={t("boxEditor.filterPlaceholder")}
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          </label>
          <div className="box-editor-members">
            {visibleProjects.length === 0 ? (
              <div className="box-editor-empty">{t("boxEditor.noProjects")}</div>
            ) : (
              visibleProjects.map((p) => (
                <label key={p.id} className="box-editor-member-row">
                  <input
                    type="checkbox"
                    checked={checked.includes(p.id)}
                    onChange={() => toggle(p.id)}
                  />
                  <span className="box-editor-member-name">{p.name}</span>
                </label>
              ))
            )}
          </div>

          {guardedMembers.length > 0 && (
            <div className="box-editor-trust-note">
              {t("boxEditor.trustNotice", {
                list: guardedMembers.map((p) => p.name).join(", "),
              })}
            </div>
          )}

          <div className="project-dialog-actions">
            {box && (
              <button
                type="button"
                className="danger box-editor-dissolve"
                onClick={() => void dissolve()}
                disabled={saving}
                title={t("boxEditor.dissolveTitle")}
              >
                {t("boxEditor.dissolve")}
              </button>
            )}
            <button type="button" onClick={onClose} disabled={saving}>
              {t("common.cancel")}
            </button>
            <button type="button" onClick={() => void save()} disabled={saving}>
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

/** The one mount of the box editor per window (AppShell), driven by its store. */
export function BoxEditorHost() {
  const open = useBoxEditorStore((s) => s.open);
  const close = useBoxEditorStore((s) => s.close);
  if (!open) return null;
  return <BoxEditorDialog onClose={close} />;
}
