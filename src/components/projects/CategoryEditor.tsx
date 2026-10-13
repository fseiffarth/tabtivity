import { useModalFocus } from "../../hooks/useModalFocus";
import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type { ProjectEntry } from "../../types";
import { useProjectsStore } from "../../stores/projects";
import {
  categoryColor,
  cleanCategories,
  normalizeCategory,
  projectCategories,
} from "../../lib/theme/categoryColor";
import { useT } from "../../lib/i18n";

/**
 * Modal to manage a project's category tags. Categories color/group a project in
 * both the 3D project cloud and the pill bar (see `categoryColor`). Existing
 * categories across all projects are offered as toggle chips so tagging is a
 * click, and a free-text field adds new ones. Reused by the pill and the
 * blob-node right-click menus.
 */
export function CategoryEditor({
  project,
  onClose,
}: {
  project: ProjectEntry;
  onClose: () => void;
}) {
  const t = useT();
  const modalRef = useModalFocus(onClose);
  const projects = useProjectsStore((s) => s.projects);
  const setProjectCategories = useProjectsStore((s) => s.setProjectCategories);

  const [selected, setSelected] = useState<string[]>(() => projectCategories(project));
  const [input, setInput] = useState("");
  const [saving, setSaving] = useState(false);

  // Every category in use across all projects, plus any the user just added,
  // so previously-used tags are one click to reapply.
  const known = useMemo(() => {
    const all = projects.flatMap((p) => projectCategories(p));
    return cleanCategories([...all, ...selected]);
  }, [projects, selected]);

  const selectedKeys = useMemo(
    () => new Set(selected.map((c) => c.toLowerCase())),
    [selected],
  );

  const toggle = (cat: string) => {
    const key = cat.toLowerCase();
    setSelected((prev) =>
      prev.some((c) => c.toLowerCase() === key)
        ? prev.filter((c) => c.toLowerCase() !== key)
        : [...prev, cat],
    );
  };

  const addNew = () => {
    const c = normalizeCategory(input);
    if (!c) return;
    if (!selected.some((s) => s.toLowerCase() === c.toLowerCase())) {
      setSelected((prev) => [...prev, c]);
    }
    setInput("");
  };

  const save = async () => {
    setSaving(true);
    try {
      await setProjectCategories(project.id, cleanCategories(selected));
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
        className="project-dialog dialog-framed category-editor"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="settings-title-row">
          <h2>{project.name} — {t("categoryEditor.titleSuffix")}</h2>
          <button type="button" className="dialog-close-btn" onClick={onClose}>×</button>
        </div>
        <div className="dialog-scroll">
        <div className="project-dialog-path">{t("categoryEditor.desc")}</div>

        {known.length > 0 && (
          <div className="category-chip-row">
            {known.map((cat) => {
              const on = selectedKeys.has(cat.toLowerCase());
              return (
                <button
                  type="button"
                  key={cat.toLowerCase()}
                  className={`category-chip${on ? " on" : ""}`}
                  style={{ "--cat-color": categoryColor(cat) } as React.CSSProperties}
                  onClick={() => toggle(cat)}
                  title={t(on ? "categoryEditor.removeCategory" : "categoryEditor.addCategory")}
                >
                  <span className="category-chip-dot" />
                  {cat}
                  {on && <span className="category-chip-x" aria-hidden>×</span>}
                </button>
              );
            })}
          </div>
        )}

        <label>
          {t("categoryEditor.addLabel")}
          <div className="category-add-row">
            <input
              type="text"
              value={input}
              autoFocus
              placeholder={t("categoryEditor.placeholder")}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addNew();
                }
              }}
            />
            <button type="button" onClick={addNew} disabled={!input.trim()}>{t("common.add")}</button>
          </div>
        </label>

        <div className="project-dialog-actions">
          <button type="button" onClick={onClose} disabled={saving}>{t("common.cancel")}</button>
          <button type="button" onClick={() => void save()} disabled={saving}>
            {saving ? t("categoryEditor.saving") : t("categoryEditor.save")}
          </button>
        </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
